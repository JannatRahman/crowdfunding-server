const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { validateContribution } = require('../utils/validators');

// POST /api/contributions - Contribute to campaign
router.post('/', authenticate, async (req, res) => {
  try {
    const errors = validateContribution(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const db = getDB();
    const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.body.campaignId) });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'Campaign is not accepting contributions' });
    }

    if (campaign.creatorId === req.user.id) {
      return res.status(400).json({ error: 'Cannot contribute to your own campaign' });
    }

    const contribution = {
      campaignId: req.body.campaignId,
      userId: req.user.id,
      amount: parseFloat(req.body.amount),
      currency: 'USD',
      paymentIntentId: req.body.paymentIntentId || null,
      paymentStatus: req.body.paymentIntentId ? 'completed' : 'pending',
      message: req.body.message || '',
      anonymous: req.body.anonymous || false,
      createdAt: new Date(),
    };

    const result = await db.collection('contributions').insertOne(contribution);

    if (contribution.paymentStatus === 'completed') {
      await db.collection('campaigns').updateOne(
        { _id: new ObjectId(req.body.campaignId) },
        {
          $inc: { currentAmount: contribution.amount, backersCount: 1 },
          $set: { updatedAt: new Date() },
        }
      );

      const updatedCampaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.body.campaignId) });
      if (updatedCampaign.currentAmount >= updatedCampaign.goalAmount) {
        await db.collection('campaigns').updateOne(
          { _id: new ObjectId(req.body.campaignId) },
          { $set: { status: 'funded', updatedAt: new Date() } }
        );
      }

      await db.collection('notifications').insertOne({
        userId: campaign.creatorId,
        title: 'New contribution!',
        message: `${contribution.anonymous ? 'Someone' : req.user.name} contributed $${contribution.amount} to your campaign "${campaign.title}"`,
        type: 'contribution',
        read: false,
        link: `/campaigns/${campaign._id}`,
        createdAt: new Date(),
      });
    }

    res.status(201).json({ contribution: { ...contribution, _id: result.insertedId } });
  } catch (error) {
    console.error('Create contribution error:', error);
    res.status(500).json({ error: 'Failed to create contribution' });
  }
});

// GET /api/contributions/my - My contributions
router.get('/my', authenticate, async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 12 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { userId: req.user.id };
    const total = await db.collection('contributions').countDocuments(filter);

    const contributions = await db.collection('contributions')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const enriched = await Promise.all(
      contributions.map(async (c) => {
        const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(c.campaignId) });
        return { ...c, campaign: campaign ? { title: campaign.title, slug: campaign.slug, image: campaign.images?.[0] } : null };
      })
    );

    res.json({
      contributions: enriched,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    console.error('Get my contributions error:', error);
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});

// GET /api/contributions/campaign/:id - Campaign contributions
router.get('/campaign/:id', async (req, res) => {
  try {
    const db = getDB();
    const contributions = await db.collection('contributions')
      .find({ campaignId: req.params.id, paymentStatus: 'completed' })
      .sort({ createdAt: -1 })
      .toArray();

    const enriched = await Promise.all(
      contributions.map(async (c) => {
        if (c.anonymous) return { ...c, name: 'Anonymous' };
        const user = await db.collection('user').findOne({ _id: new ObjectId(c.userId) }, { projection: { name: 1, image: 1 } });
        return { ...c, name: user?.name || 'Unknown', image: user?.image };
      })
    );

    res.json({ contributions: enriched });
  } catch (error) {
    console.error('Get campaign contributions error:', error);
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});

module.exports = router;
