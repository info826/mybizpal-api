const express = require("express");
const router  = express.Router();
const Stripe  = require("stripe");
const axios   = require("axios");
const { insert, patch, select } = require("../lib/supabase");

const stripe        = Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// n8n workflow that sends the welcome email on successful checkout.
const WELCOME_EMAIL_WEBHOOK_URL =
  "https://mybizpal-n8n.onrender.com/webhook/stripe-payment-success";

// Helper: convert a Unix timestamp (seconds) to ISO string, or null.
function tsToIso(unix) {
  return unix ? new Date(unix * 1000).toISOString() : null;
}

// current_period_end is top-level on older API versions and on
// subscription.items.data[].current_period_end on Basil-era (2025-03-31+).
// Read whichever is present so the stored renewal date is version-proof.
function periodEnd(sub) {
  return sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
}

router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("[Stripe Webhook] signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Idempotency (EF-02): record the event id; a duplicate insert throws on the
  // primary-key conflict, meaning we've already processed this event -> skip.
  try {
    await insert("stripe_events", { id: event.id, type: event.type });
  } catch (err) {
    const status = err.response?.status;
    if (status === 409) {
      console.log(`[Stripe] duplicate event ${event.id} (${event.type}) — skipping`);
      return res.json({ received: true, duplicate: true });
    }
    // Any other error recording the event: log and 500 so Stripe retries.
    console.error("[Stripe] failed to record event:", err.response?.data || err.message);
    return res.status(500).send("event-record-failed");
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId  = session.client_reference_id || session.metadata?.userId;
        const { plan, billingCycle } = session.metadata || {};

        if (!userId) {
          console.error(`[Stripe] checkout.session.completed missing userId — session ${session.id}`);
          break; // event already recorded; nothing to provision
        }

        // Fetch the subscription to read trial/period dates and status.
        let sub = null;
        if (session.subscription) {
          sub = await stripe.subscriptions.retrieve(session.subscription);
        }

        const updates = {
          stripe_customer_id:     session.customer || null,
          stripe_subscription_id: session.subscription || null,
          plan_status:            "trialing",
          subscription_status:    sub?.status || "trialing",
          trial_ends_at:          tsToIso(sub?.trial_end),
          current_period_end:     tsToIso(periodEnd(sub)),
          onboarding_completed:   true, // access gate opens only here, post-payment
        };
        if (plan)        updates.plan = plan;
        if (billingCycle) updates.billing_interval = billingCycle;

        await patch("client_profiles", { user_id: `eq.${userId}` }, updates);
        console.log(`[Stripe] provisioned user ${userId} — plan=${plan}, cycle=${billingCycle}, sub=${session.subscription}`);

        // Trigger the welcome email (non-blocking, idempotent). A failure here
        // must never bubble up: Stripe would retry the whole webhook over an
        // email error. welcome_email_sent guards against duplicate sends.
        try {
          const [profile] = await select(
            "client_profiles",
            { user_id: `eq.${userId}` },
            { columns: "email,first_name,business_name,welcome_email_sent" }
          );
          if (profile?.email && profile.welcome_email_sent === false) {
            await axios.post(WELCOME_EMAIL_WEBHOOK_URL, {
              email:         profile.email,
              first_name:    profile.first_name,
              plan_name:     plan,
              business_name: profile.business_name,
              plan_status:   "trialing",
            });
            await patch("client_profiles", { user_id: `eq.${userId}` }, { welcome_email_sent: true });
            console.log(`[Stripe] welcome email triggered for user ${userId}`);
          }
        } catch (err) {
          console.error(`[Stripe] welcome email trigger failed for user ${userId}:`, err.response?.data || err.message);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        const planStatusMap = {
          trialing: "trialing",
          active:   "active",
          past_due: "past_due",
          unpaid:   "past_due",
          canceled: "cancelled",
        };
        await patch(
          "client_profiles",
          { stripe_subscription_id: `eq.${sub.id}` },
          {
            subscription_status: sub.status,
            plan_status:         planStatusMap[sub.status] || sub.status,
            current_period_end:  tsToIso(periodEnd(sub)),
            trial_ends_at:       tsToIso(sub.trial_end),
          }
        );
        console.log(`[Stripe] subscription.updated — sub=${sub.id}, status=${sub.status}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await patch(
          "client_profiles",
          { stripe_subscription_id: `eq.${sub.id}` },
          { subscription_status: "canceled", plan_status: "cancelled" }
        );
        console.log(`[Stripe] subscription.deleted — sub=${sub.id}`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await patch(
            "client_profiles",
            { stripe_subscription_id: `eq.${invoice.subscription}` },
            { plan_status: "past_due", subscription_status: "past_due" }
          );
        }
        console.log(`[Stripe] invoice.payment_failed — customer=${invoice.customer}, sub=${invoice.subscription}, amount=${invoice.amount_due}`);
        break;
      }

      default:
        console.log(`[Stripe] unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error(`[Stripe] handler error for ${event.type}:`, err.response?.data || err.message);
    return res.status(500).send("handler-error");
  }

  res.json({ received: true });
});

module.exports = router;
