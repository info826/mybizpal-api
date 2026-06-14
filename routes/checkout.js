const express = require("express");
const router  = express.Router();
const Stripe  = require("stripe");

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.BASE_URL || "https://app.mybizpal.ai";

// Server-side plan -> price map (test mode). Client never sends price IDs.
const PRICE_MAP = {
  starter: {
    monthly: { price: "price_1TiFEzEeQsMUUSovT0BKSfVf", trialDays: 7,  setup: null },
    annual:  { price: "price_1TiFFFEeQsMUUSovS61W2gBM", trialDays: 7,  setup: null },
  },
  pro: {
    monthly: { price: "price_1TiFFjEeQsMUUSovUYjPGt8d", trialDays: 14, setup: "price_1TiFG7EeQsMUUSov54pGNTvp" },
    annual:  { price: "price_1TiFFvEeQsMUUSovTvrvURpl", trialDays: 14, setup: null },
  },
};

router.post("/create-checkout-session", async (req, res) => {
  const { plan, billingCycle, userId, email } = req.body;

  if (!plan || !billingCycle || !userId || !email) {
    return res.status(400).json({ error: "Missing required fields: plan, billingCycle, userId, email" });
  }

  const planConfig = PRICE_MAP[plan]?.[billingCycle];
  if (!planConfig) {
    return res.status(400).json({ error: `Unknown plan/cycle: ${plan}/${billingCycle}` });
  }

  const line_items = [{ price: planConfig.price, quantity: 1 }];
  if (planConfig.setup) {
    line_items.push({ price: planConfig.setup, quantity: 1 });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      currency: "gbp",
      line_items,
      client_reference_id: userId,
      customer_email: email,
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE_URL}/onboarding`,
      metadata: { plan, billingCycle, userId },
      subscription_data: {
        trial_period_days: planConfig.trialDays,
        metadata: { plan, billingCycle, userId },
      },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[Stripe] checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
