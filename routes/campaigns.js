const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { authorize } = require('../middleware/roleGuard');
const { validateCampaign } = require('../utils/validators');

// GET /api/campaigns - List campaigns (public, paginated, filterable)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const db = getDB();
    const {
      page = 1,
      limit = 12,
      category,
      status = 'active',
      search,
      sort = 'newest',
      featured,
    } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (category) filter.category = category;
    if (featured === 'true') filter.featured = true;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } },
      ];
    }

    const sortOptions = {};
    switch (sort) {
      case 'newest': sortOptions.createdAt = -1; break;
      case 'oldest': sortOptions.createdAt = 1; break;
      case 'most-funded': sortOptions.currentAmount = -1; break;
      case 'most-backed': sortOptions.backersCount = -1; break;
      case 'ending-soon': sortOptions.endDate = 1; break;
      default: sortOptions.createdAt = -1;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await db.collection('campaigns').countDocuments(filter);
    const campaigns = await db.collection('campaigns')
      .find(filter)
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    res.json({
      campaigns,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    console.error('Get campaigns error:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// GET /api/campaigns/my - Get creator's campaigns
router.get('/my', authenticate, authorize('creator', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 12, status } = req.query;

    const filter = { creatorId: req.user.id };
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await db.collection('campaigns').countDocuments(filter);
    const campaigns = await db.collection('campaigns')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    res.json({
      campaigns,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit),
      },
    });
  } catch (error) {
    console.error('Get my campaigns error:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// GET /api/campaigns/:id - Get campaign detail (public)
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const db = getDB();
    let campaign;

    try {
      campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.params.id) });
    } catch {
      campaign = await db.collection('campaigns').findOne({ slug: req.params.id });
    }

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const creator = await db.collection('user').findOne(
      { _id: new ObjectId(campaign.creatorId) },
      { projection: { name: 1, email: 1, image: 1 } }
    );

    const contributions = await db.collection('contributions')
      .find({ campaignId: campaign._id.toString(), paymentStatus: 'completed' })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    res.json({ campaign, creator, recentContributions: contributions });
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

// POST /api/campaigns - Create campaign
router.post('/', authenticate, authorize('creator', 'admin'), async (req, res) => {
  try {
    const errors = validateCampaign(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const db = getDB();
    const slug = req.body.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '-' + Date.now();

    const campaign = {
      creatorId: req.user.id,
      title: req.body.title.trim(),
      slug,
      description: req.body.description.trim(),
      shortDescription: req.body.shortDescription?.trim() || req.body.description.trim().substring(0, 150),
      category: req.body.category,
      goalAmount: parseFloat(req.body.goalAmount),
      currentAmount: 0,
      currency: 'USD',
      images: req.body.images || [],
      video: req.body.video || '',
      status: req.body.status || 'active',
      startDate: req.body.startDate || new Date(),
      endDate: new Date(req.body.endDate),
      backersCount: 0,
      featured: false,
      tags: req.body.tags || [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('campaigns').insertOne(campaign);

    res.status(201).json({ campaign: { ...campaign, _id: result.insertedId } });
  } catch (error) {
    console.error('Create campaign error:', error);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// PUT /api/campaigns/:id - Update campaign
router.put('/:id', authenticate, authorize('creator', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.params.id) });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.creatorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to edit this campaign' });
    }

    const updateData = {
      ...(req.body.title && { title: req.body.title.trim() }),
      ...(req.body.description && { description: req.body.description.trim() }),
      ...(req.body.shortDescription && { shortDescription: req.body.shortDescription.trim() }),
      ...(req.body.category && { category: req.body.category }),
      ...(req.body.goalAmount && { goalAmount: parseFloat(req.body.goalAmount) }),
      ...(req.body.images && { images: req.body.images }),
      ...(req.body.video !== undefined && { video: req.body.video }),
      ...(req.body.tags && { tags: req.body.tags }),
      ...(req.body.endDate && { endDate: new Date(req.body.endDate) }),
      updatedAt: new Date(),
    };

    await db.collection('campaigns').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    const updated = await db.collection('campaigns').findOne({ _id: new ObjectId(req.params.id) });
    res.json({ campaign: updated });
  } catch (error) {
    console.error('Update campaign error:', error);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

// PATCH /api/campaigns/:id/status - Update campaign status
router.patch('/:id/status', authenticate, authorize('creator', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const { status } = req.body;

    if (!['draft', 'active', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.params.id) });
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.creatorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await db.collection('campaigns').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updatedAt: new Date() } }
    );

    res.json({ message: 'Status updated' });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// DELETE /api/campaigns/:id - Delete campaign
router.delete('/:id', authenticate, authorize('creator', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.params.id) });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.creatorId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await db.collection('campaigns').deleteOne({ _id: new ObjectId(req.params.id) });
    await db.collection('contributions').deleteMany({ campaignId: req.params.id });

    res.json({ message: 'Campaign deleted' });
  } catch (error) {
    console.error('Delete campaign error:', error);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

module.exports = router;
