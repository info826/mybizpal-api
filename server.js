require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const nodemailer = require("nodemailer");
const axios    = require("axios");

const app  = express();
const PORT = process.env.PORT || 4000;

// Behind Render/Cloudflare — trust the proxy so we can read the real client IP
app.set("trust proxy", true);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Webhook MUST be mounted before express.json() — needs raw body for signature verification
app.use("/api", require("./routes/webhook"));

app.use(express.json());
app.use(cors({
  origin: [
    "https://mybizpal.ai",
    "https://www.mybizpal.ai",
    "http://localhost:3000",
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "mybizpal-api", ts: new Date().toISOString() });
});

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || "smtp.gmail.com",
  port:   parseInt(process.env.SMTP_PORT || "465"),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendNotificationEmail(lead) {
  const { firstName, lastName, email, phone, message } = lead;
  await transporter.sendMail({
    from:    `"MyBizPal Leads" <${process.env.SMTP_USER}>`,
    to:      process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
    subject: `New Demo Request - ${firstName} ${lastName}`,
    html: `<div style="font-family:sans-serif;padding:24px;background:#0d0d1a;color:#f5f5f7;border-radius:12px;">
      <h2 style="color:#00D4FF;">New Demo Request</h2>
      <p><strong>Name:</strong> ${firstName} ${lastName}</p>
      <p><strong>Email:</strong> <a href="mailto:${email}" style="color:#00D4FF;">${email}</a></p>
      <p><strong>Phone:</strong> ${phone}</p>
      <p><strong>Message:</strong> ${message || "None"}</p>
      <p><strong>Time:</strong> ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })}</p>
    </div>`,
  });
  await transporter.sendMail({
    from:    `"MyBizPal" <${process.env.SMTP_USER}>`,
    to:      email,
    subject: `Thanks ${firstName} - your demo is confirmed`,
    html: `<div style="font-family:sans-serif;padding:24px;background:#0d0d1a;color:#f5f5f7;border-radius:12px;">
      <h1 style="color:#00D4FF;">MyBizPal</h1>
      <h2>You're all set, ${firstName}!</h2>
      <p>Our AI agent will call you on <strong>${phone}</strong> within 30 seconds.</p>
      <p>Questions? Email <a href="mailto:info@mybizpal.ai" style="color:#00D4FF;">info@mybizpal.ai</a></p>
    </div>`,
  });
}

async function createHubSpotContact(lead) {
  if (!process.env.HUBSPOT_API_KEY) { console.warn("[HubSpot] skipping - no key"); return; }
  await axios.post("https://api.hubapi.com/crm/v3/objects/contacts", {
    properties: {
      firstname: lead.firstName, lastname: lead.lastName,
      email: lead.email, phone: lead.phone,
      hs_lead_status: "NEW", lead_source: "mybizpal.ai",
    },
  }, { headers: { Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`, "Content-Type": "application/json" } });
}

async function triggerN8nWebhook(lead) {
  if (!process.env.N8N_WEBHOOK_URL) { console.warn("[n8n] skipping - no URL"); return; }
  await axios.post(process.env.N8N_WEBHOOK_URL, {
    source: "mybizpal-landing", timestamp: new Date().toISOString(), lead,
  });
}

app.post("/api/demo-request", async (req, res) => {
  const { firstName, lastName, email, phone, message } = req.body;
  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const lead = { firstName, lastName, email, phone, message };
  console.log(`[demo-request] ${firstName} ${lastName} <${email}>`);
  const results = await Promise.allSettled([
    sendNotificationEmail(lead),
    createHubSpotContact(lead),
    triggerN8nWebhook(lead),
  ]);
  results.forEach((r, i) => {
    const label = ["Email","HubSpot","n8n"][i];
    r.status === "rejected"
      ? console.error(`[${label}] Failed:`, r.reason?.message)
      : console.log(`[${label}] OK`);
  });
  res.status(200).json({ success: true });
});

// ── Cookie consent logging (PECR / UK GDPR audit trail) ──────────────────────
// Resolve the real client IP from proxy headers (Cloudflare → Render → Express).
function getClientIp(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["true-client-ip"] ||
    xff ||
    req.ip ||
    req.socket?.remoteAddress ||
    null
  );
}

app.post("/api/consent-log", async (req, res) => {
  const { consent_type, page_url } = req.body;
  if (!consent_type) {
    return res.status(400).json({ error: "Missing consent_type" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[consent-log] Supabase env vars not configured");
    return res.status(500).json({ error: "Logging not configured" });
  }

  const record = {
    consent_type,
    user_agent: req.body.user_agent || req.headers["user-agent"] || null,
    page_url: page_url || null,
    ip_address: getClientIp(req),
  };

  try {
    await axios.post(`${SUPABASE_URL}/rest/v1/consent_logs`, record, {
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=minimal",
      },
    });
    console.log(`[consent-log] ${consent_type} from ${record.ip_address}`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("[consent-log] Supabase insert failed:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to log consent" });
  }
});

app.use("/api", require("./routes/checkout"));

app.listen(PORT, () => console.log(`MyBizPal API running on port ${PORT}`));
