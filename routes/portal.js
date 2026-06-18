const express = require("express");
const router  = express.Router();
const Stripe  = require("stripe");
const axios   = require("axios");
const { select } = require("../lib/supabase");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Where the Portal returns the user after they're done managing billing.
const RETURN_URL = "https://app.mybizpal.ai/dashboard/settings";

// Verify the Supabase access token from the Authorization header and return the
// authenticated user's id. The user token is verified by Supabase Auth — the
// caller cannot spoof another user's id. Returns null on any failure.
async function getAuthedUserId(req) {
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;

  try {
    const { data } = await axios.get(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    return data?.id || null;
  } catch (err) {
    console.warn("[Stripe Portal] token verification failed:", err.response?.data?.msg || err.message);
    return null;
  }
}

router.post("/create-portal-session", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[Stripe Portal] Supabase env vars not configured");
    return res.status(500).json({ error: "Server not configured" });
  }

  // Identify the user from their verified Supabase access token (never the body),
  // so a caller can only ever open their own billing portal.
  const userId = await getAuthedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const [profile] = await select(
      "client_profiles",
      { user_id: `eq.${userId}` },
      { columns: "stripe_customer_id" }
    );

    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: "No billing account found" });
    }

    // We never touch card data — the hosted Customer Portal handles everything.
    const session = await stripe.billingPortal.sessions.create({
      customer:   profile.stripe_customer_id,
      return_url: RETURN_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[Stripe Portal] error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
