const express = require('express');
const router = express.Router();
const { ObjectId } = require('mongodb');
const { getDB } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authorize } = require('../middleware/roleGuard');
const { validateReport } = require('../utils/validators');

// POST /api/reports - Submit report
router.post('/', authenticate, async (req, res) => {
  try {
    const errors = validateReport(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const db = getDB();

    const existing = await db.collection('reports').findOne({
      reporterId: req.user.id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      status: { $in: ['pending', 'reviewed'] },
    });

    if (existing) {
      return res.status(409).json({ error: 'You have already reported this item' });
    }

    const report = {
      reporterId: req.user.id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      reason: req.body.reason,
      description: req.body.description || '',
      status: 'pending',
      adminNote: '',
      createdAt: new Date(),
    };

    const result = await db.collection('reports').insertOne(report);
    res.status(201).json({ report: { ...report, _id: result.insertedId } });
  } catch (error) {
    console.error('Create report error:', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// GET /api/reports - List all reports (admin)
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const { page = 1, limit = 20, status } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (status) filter.status = status;

    const total = await db.collection('reports').countDocuments(filter);
    const reports = await db.collection('reports')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const enriched = await Promise.all(
      reports.map(async (r) => {
        const reporter = await db.collection('user').findOne({ _id: new ObjectId(r.reporterId) }, { projection: { name: 1, email: 1 } });
        let target = null;
        if (r.targetType === 'campaign') {
          target = await db.collection('campaigns').findOne({ _id: new ObjectId(r.targetId) }, { projection: { title: 1 } });
        }
        return { ...r, reporter, target };
      })
    );

    res.json({
      reports: enriched,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), limit: parseInt(limit) },
    });
  } catch (error) {
    console.error('Get reports error:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// PATCH /api/reports/:id - Update report status (admin)
router.patch('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const db = getDB();
    const { status, adminNote } = req.body;

    if (!['pending', 'reviewed', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await db.collection('reports').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, adminNote: adminNote || '' } }
    );

    const report = await db.collection('reports').findOne({ _id: new ObjectId(req.params.id) });
    if (report) {
      await db.collection('notifications').insertOne({
        userId: report.reporterId,
        title: 'Report updated',
        message: `Your report has been ${status}.`,
        type: 'report',
        read: false,
        link: `/dashboard/admin/reports`,
        createdAt: new Date(),
      });
    }

    res.json({ message: 'Report updated' });
  } catch (error) {
    console.error('Update report error:', error);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

module.exports = router;
