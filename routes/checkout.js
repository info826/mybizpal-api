const express = require("express");
const router  = express.Router();
const Stripe  = require("stripe");

const stripe   = Stripe(process.env.STRIPE_SECRET_KEY);
const BASE_URL = process.env.BASE_URL || "https://mybizpal.ai";

router.post("/create-checkout-session", async (req, res) => {
  const { plan, billingCycle, priceId, setupPriceId } = req.body;

  if (!plan || !billingCycle || !priceId || !setupPriceId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      currency: "gbp",
      line_items: [
        { price: setupPriceId, quantity: 1 },
        { price: priceId,      quantity: 1 },
      ],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE_URL}/#pricing`,
      metadata: { plan, billingCycle },
      subscription_data: { metadata: { plan, billingCycle } },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[Stripe] checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
