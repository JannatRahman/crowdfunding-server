const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { getStripe } = require('../utils/stripe');

// POST /api/payments/create-session - Create Stripe checkout session
router.post('/create-session', authenticate, async (req, res) => {
  try {
    const { campaignId, amount, message, anonymous } = req.body;

    if (!campaignId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid payment data' });
    }

    const db = getDB();
    const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(campaignId) });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.creatorId === req.user.id) {
      return res.status(400).json({ error: 'Cannot contribute to your own campaign' });
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Contribution to ${campaign.title}`,
            description: message || 'Crowdfunding contribution',
          },
          unit_amount: Math.round(parseFloat(amount) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}/payment/cancel`,
      metadata: {
        userId: req.user.id,
        campaignId,
        amount: parseFloat(amount),
        message: message || '',
        anonymous: anonymous || false,
      },
    });

    const payment = {
      userId: req.user.id,
      campaignId,
      stripeSessionId: session.id,
      amount: parseFloat(amount),
      currency: 'USD',
      status: 'pending',
      metadata: { message, anonymous },
      createdAt: new Date(),
    };

    await db.collection('payments').insertOne(payment);

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create payment session' });
  }
});

// POST /api/payments/webhook - Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const stripe = getStripe();
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const db = getDB();

      await db.collection('payments').updateOne(
        { stripeSessionId: session.id },
        { $set: { status: 'succeeded' } }
      );

      const { userId, campaignId, amount, message, anonymous } = session.metadata;

      const contribution = {
        campaignId,
        userId,
        amount: parseFloat(amount),
        currency: 'USD',
        paymentIntentId: session.payment_intent,
        paymentStatus: 'completed',
        message: message || '',
        anonymous: anonymous === 'true',
        createdAt: new Date(),
      };

      await db.collection('contributions').insertOne(contribution);

      await db.collection('campaigns').updateOne(
        { _id: new ObjectId(campaignId) },
        {
          $inc: { currentAmount: parseFloat(amount), backersCount: 1 },
          $set: { updatedAt: new Date() },
        }
      );

      const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(campaignId) });
      if (campaign && campaign.currentAmount >= campaign.goalAmount) {
        await db.collection('campaigns').updateOne(
          { _id: new ObjectId(campaignId) },
          { $set: { status: 'funded', updatedAt: new Date() } }
        );
      }

      if (campaign) {
        const contributor = await db.collection('user').findOne({ _id: new ObjectId(userId) }, { projection: { name: 1 } });
        await db.collection('notifications').insertOne({
          userId: campaign.creatorId,
          title: 'New contribution!',
          message: `${anonymous === 'true' ? 'Someone' : contributor?.name || 'Someone'} contributed $${amount} to your campaign "${campaign.title}"`,
          type: 'contribution',
          read: false,
          link: `/campaigns/${campaignId}`,
          createdAt: new Date(),
        });
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GET /api/payments/:id - Get payment status
router.get('/:id', authenticate, async (req, res) => {
  try {
    const db = getDB();
    const payment = await db.collection('payments').findOne({ stripeSessionId: req.params.id });

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    res.json({ payment });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

module.exports = router;
