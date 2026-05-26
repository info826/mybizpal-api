const express = require("express");
const router  = express.Router();
const Stripe  = require("stripe");

const stripe        = Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

router.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("[Stripe Webhook] signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const { plan, billingCycle } = session.metadata || {};
      console.log(`[Stripe] checkout.session.completed — plan=${plan}, cycle=${billingCycle}, customer=${session.customer}`);
      // TODO: activate account
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const { plan } = sub.metadata || {};
      console.log(`[Stripe] subscription.deleted — plan=${plan}, customer=${sub.customer}`);
      // TODO: deactivate account
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      console.log(`[Stripe] invoice.payment_failed — customer=${invoice.customer}, amount=${invoice.amount_due}`);
      // TODO: notify customer
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object;
      console.log(`[Stripe] subscription.updated — status=${sub.status}, customer=${sub.customer}`);
      break;
    }
    default:
      console.log(`[Stripe] unhandled event: ${event.type}`);
  }

  res.json({ received: true });
});

module.exports = router;
