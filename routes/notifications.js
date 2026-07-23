const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { authenticate } = require('../middleware/auth');

// GET /api/notifications - Get user notifications
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { userId: req.user.id };
    const total = await db.collection('notifications').countDocuments(filter);
    const unread = await db.collection('notifications').countDocuments({ ...filter, read: false });

    const notifications = await db.collection('notifications')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    res.json({
      notifications,
      unread,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), limit: parseInt(limit) },
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// PATCH /api/notifications/:id/read - Mark as read
router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    const db = getDB();
    await db.collection('notifications').updateOne(
      { _id: new ObjectId(req.params.id), userId: req.user.id },
      { $set: { read: true } }
    );
    res.json({ message: 'Marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// PATCH /api/notifications/read-all - Mark all as read
router.patch('/read-all', authenticate, async (req, res) => {
  try {
    const db = getDB();
    await db.collection('notifications').updateMany(
      { userId: req.user.id, read: false },
      { $set: { read: true } }
    );
    res.json({ message: 'All marked as read' });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

module.exports = router;
