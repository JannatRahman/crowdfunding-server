const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/roleGuard');

// GET /api/admin/stats - Dashboard stats
router.get('/stats', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();

    const totalUsers = await db.collection('user').countDocuments();
    const totalCampaigns = await db.collection('campaigns').countDocuments();
    const activeCampaigns = await db.collection('campaigns').countDocuments({ status: 'active' });
    const fundedCampaigns = await db.collection('campaigns').countDocuments({ status: 'funded' });

    const contributionsAgg = await db.collection('contributions').aggregate([
      { $match: { paymentStatus: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]).toArray();

    const totalContributions = contributionsAgg[0]?.total || 0;
    const totalBackers = contributionsAgg[0]?.count || 0;

    const pendingWithdrawals = await db.collection('withdrawals').countDocuments({ status: 'pending' });
    const pendingReports = await db.collection('reports').countDocuments({ status: 'pending' });

    const recentCampaigns = await db.collection('campaigns')
      .find()
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    const recentContributions = await db.collection('contributions')
      .find({ paymentStatus: 'completed' })
      .sort({ createdAt: -1 })
      .limit(5)
      .toArray();

    res.json({
      stats: {
        totalUsers,
        totalCampaigns,
        activeCampaigns,
        fundedCampaigns,
        totalContributions,
        totalBackers,
        pendingWithdrawals,
        pendingReports,
      },
      recentCampaigns,
      recentContributions,
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/admin/users - List all users
router.get('/users', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 20, role, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const total = await db.collection('user').countDocuments(filter);
    const users = await db.collection('user')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .project({ name: 1, email: 1, role: 1, image: 1, createdAt: 1 })
      .toArray();

    res.json({
      users,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), limit: parseInt(limit) },
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// PATCH /api/admin/users/:id/role - Change user role
router.patch('/users/:id/role', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const { role } = req.body;

    if (!['supporter', 'creator', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    await db.collection('user').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { role } }
    );

    res.json({ message: 'Role updated' });
  } catch (error) {
    console.error('Change role error:', error);
    res.status(500).json({ error: 'Failed to change role' });
  }
});

// DELETE /api/admin/users/:id - Delete user
router.delete('/users/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();

    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    await db.collection('user').deleteOne({ _id: new ObjectId(req.params.id) });
    await db.collection('session').deleteMany({ userId: req.params.id });

    res.json({ message: 'User deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// PATCH /api/admin/campaigns/:id/feature - Feature/unfeature campaign
router.patch('/campaigns/:id/feature', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const campaign = await db.collection('campaigns').findOne({ _id: new ObjectId(req.params.id) });

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    await db.collection('campaigns').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { featured: !campaign.featured, updatedAt: new Date() } }
    );

    res.json({ message: campaign.featured ? 'Unfeatured' : 'Featured' });
  } catch (error) {
    console.error('Feature campaign error:', error);
    res.status(500).json({ error: 'Failed to feature campaign' });
  }
});

module.exports = router;
