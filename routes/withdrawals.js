const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/roleGuard');
const { validateWithdrawal } = require('../utils/validators');

// POST /api/withdrawals - Request withdrawal
router.post('/', authenticate, authorize('creator', 'admin'), async (req, res) => {
  try {
    const errors = validateWithdrawal(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const db = getDB();
    const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.body.campaignId) });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.creatorId !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const amount = parseFloat(req.body.amount);
    if (amount > campaign.currentAmount) {
      return res.status(400).json({ error: 'Insufficient campaign balance' });
    }

    const pendingWithdrawals = await db.collection('withdrawals')
      .find({ campaignId: req.body.campaignId, status: { $in: ['pending', 'approved'] } })
      .toArray();

    const pendingAmount = pendingWithdrawals.reduce((sum, w) => sum + w.amount, 0);
    if (pendingAmount + amount > campaign.currentAmount) {
      return res.status(400).json({ error: 'Exceeds available balance with pending withdrawals' });
    }

    const withdrawal = {
      campaignId: req.body.campaignId,
      creatorId: req.user.id,
      amount,
      status: 'pending',
      bankDetails: {
        accountHolder: req.body.bankDetails.accountHolder,
        accountNumber: req.body.bankDetails.accountNumber,
        bankName: req.body.bankDetails.bankName,
      },
      adminNote: '',
      processedAt: null,
      createdAt: new Date(),
    };

    const result = await db.collection('withdrawals').insertOne(withdrawal);

    await db.collection('notifications').insertOne({
      userId: req.user.id,
      title: 'Withdrawal requested',
      message: `Your withdrawal request for $${amount} from "${campaign.title}" is pending review.`,
      type: 'withdrawal',
      read: false,
      link: `/dashboard/creator/withdrawals`,
      createdAt: new Date(),
    });

    res.status(201).json({ withdrawal: { ...withdrawal, _id: result.insertedId } });
  } catch (error) {
    console.error('Create withdrawal error:', error);
    res.status(500).json({ error: 'Failed to create withdrawal' });
  }
});

// GET /api/withdrawals/my - My withdrawals
router.get('/my', authenticate, authorize('creator', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 12, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { creatorId: req.user.id };
    if (status) filter.status = status;

    const total = await db.collection('withdrawals').countDocuments(filter);
    const withdrawals = await db.collection('withdrawals')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const enriched = await Promise.all(
      withdrawals.map(async (w) => {
        const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(w.campaignId) });
        return { ...w, campaign: campaign ? { title: campaign.title } : null };
      })
    );

    res.json({
      withdrawals: enriched,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), limit: parseInt(limit) },
    });
  } catch (error) {
    console.error('Get my withdrawals error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// GET /api/withdrawals/pending - Pending withdrawals (admin)
router.get('/pending', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { status: 'pending' };
    const total = await db.collection('withdrawals').countDocuments(filter);
    const withdrawals = await db.collection('withdrawals')
      .find(filter)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const enriched = await Promise.all(
      withdrawals.map(async (w) => {
        const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(w.campaignId) });
        const creator = await db.collection('user').findOne({ _id: new ObjectId(w.creatorId) }, { projection: { name: 1, email: 1 } });
        return { ...w, campaign: campaign ? { title: campaign.title } : null, creator };
      })
    );

    res.json({
      withdrawals: enriched,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), limit: parseInt(limit) },
    });
  } catch (error) {
    console.error('Get pending withdrawals error:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// PATCH /api/withdrawals/:id/approve - Approve withdrawal (admin)
router.patch('/:id/approve', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const withdrawal = await db.collection('withdrawals').findOne({ _id: new ObjectId(req.params.id) });

    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal is not pending' });
    }

    await db.collection('withdrawals').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'approved', adminNote: req.body.adminNote || '', processedAt: new Date() } }
    );

    await db.collection('campaigns').updateOne(
      { _id: new ObjectId(withdrawal.campaignId) },
      { $inc: { currentAmount: -withdrawal.amount }, $set: { updatedAt: new Date() } }
    );

    await db.collection('notifications').insertOne({
      userId: withdrawal.creatorId,
      title: 'Withdrawal approved',
      message: `Your withdrawal request for $${withdrawal.amount} has been approved.`,
      type: 'withdrawal',
      read: false,
      link: `/dashboard/creator/withdrawals`,
      createdAt: new Date(),
    });

    res.json({ message: 'Withdrawal approved' });
  } catch (error) {
    console.error('Approve withdrawal error:', error);
    res.status(500).json({ error: 'Failed to approve withdrawal' });
  }
});

// PATCH /api/withdrawals/:id/reject - Reject withdrawal (admin)
router.patch('/:id/reject', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const withdrawal = await db.collection('withdrawals').findOne({ _id: new ObjectId(req.params.id) });

    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    await db.collection('withdrawals').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status: 'rejected', adminNote: req.body.adminNote || '', processedAt: new Date() } }
    );

    await db.collection('notifications').insertOne({
      userId: withdrawal.creatorId,
      title: 'Withdrawal rejected',
      message: `Your withdrawal request for $${withdrawal.amount} has been rejected. ${req.body.adminNote || ''}`,
      type: 'withdrawal',
      read: false,
      link: `/dashboard/creator/withdrawals`,
      createdAt: new Date(),
    });

    res.json({ message: 'Withdrawal rejected' });
  } catch (error) {
    console.error('Reject withdrawal error:', error);
    res.status(500).json({ error: 'Failed to reject withdrawal' });
  }
});

module.exports = router;
