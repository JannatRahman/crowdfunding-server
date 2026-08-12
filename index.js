const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();
// Lazy-init Stripe so a missing STRIPE_SECRET_KEY never crashes module load
// (e.g. a serverless cold start). Stripe endpoints return 501 until configured.
let stripeClient;
function getStripe() {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not set in environment variables.');
    }
    stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 5000;
const isProd = process.env.NODE_ENV === 'production';

// ─── Trust Proxy ──────────────────────────────────────────────────────────────
// Required so express-rate-limit and req.ip work correctly behind Nginx / AWS ALB
app.set('trust proxy', 1);

// ─── Global Unhandled Rejection / Exception Guards ───────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1); // restart via PM2 / Docker
});

// ─── HTTP Request Logging ─────────────────────────────────────────────────────
// 'combined' (Apache format) in production → write to stdout for log aggregators
// 'dev' (coloured) in development for readability
app.use(morgan(isProd ? 'combined' : 'dev'));

// ─── Security Headers ─────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // Strict-Transport-Security (HSTS) — only enable in production over HTTPS
  strictTransportSecurity: isProd
    ? { maxAge: 63072000, includeSubDomains: true, preload: true }
    : false,
}));

// ─── Health Check ─────────────────────────────────────────────────────────────
// Lightweight endpoint for uptime monitors and load-balancer health checks.
// Intentionally placed BEFORE rate limiters so monitors are never throttled.
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', env: process.env.NODE_ENV || 'development', ts: new Date().toISOString() });
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Origins configured explicitly via ALLOWED_ORIGINS / CLIENT_URL env vars.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.CLIENT_URL || '')
  .split(',').map(o => o.trim()).filter(Boolean);

// Always trust local dev plus the production / preview Vercel deployments
// of this project, so the deployed frontend works even if ALLOWED_ORIGINS
// has not been set in the environment yet.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://crowdfunding-client-flame.vercel.app',
];

// Vercel preview/alias deployments share the <project>-<hash>-<scope>.vercel.app
// pattern — treat any such origin as trusted so preview deploys work too.
const vercelAppPattern = /^https:\/\/[a-zA-Z0-9-]+\.vercel\.app$/;

function isOriginAllowed(origin) {
  if (!origin) return true; // server-to-server requests carry no Origin header
  if (allowedOrigins.includes(origin)) return true;
  if (DEFAULT_ALLOWED_ORIGINS.includes(origin)) return true;
  return vercelAppPattern.test(origin);
}

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server (no origin) and trusted origins.
    if (isOriginAllowed(origin)) return cb(null, true);
    // Reject cleanly (no CORS headers → browser blocks) instead of throwing,
    // which would surface as an opaque 500 in the browser console.
    cb(null, false);
  },
  credentials: true,
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/api/', generalLimiter);
app.use('/api/payments/create-checkout-session', strictLimiter);
app.use('/api/payments/purchase-credit', strictLimiter);
app.use('/api/withdrawals', strictLimiter);

// ─── Body Parser ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ─── Input Sanitizer ──────────────────────────────────────────────────────────
/**
 * Strips control characters and trims a string.
 * @param {unknown} val
 * @param {number} [maxLen]
 * @returns {string}
 */
function sanitizeStr(val, maxLen = 1000) {
  if (typeof val !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, maxLen);
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────
const uri = process.env.MONGODB_URI;
if (!uri) {
  const msg = 'FATAL: MONGODB_URI is not set in environment variables.';
  console.error(msg);
  // process.exit() would silently kill a Vercel serverless instance mid-import;
  // throwing surfaces a clear error in the deployment logs instead.
  if (process.env.VERCEL === '1') throw new Error(msg);
  process.exit(1);
}

const mongoClient = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
});

let db;
let campaignCollection;
let contributionCollection;
let userCollection;
let sessionCollection;

async function createIndexes() {
  try {
    await campaignCollection.createIndex({ status: 1 });
    await campaignCollection.createIndex({ creatorEmail: 1 });
    await campaignCollection.createIndex({ createdAt: -1 });
    await contributionCollection.createIndex({ campaignId: 1 });
    await contributionCollection.createIndex({ supporterEmail: 1 });
    await contributionCollection.createIndex({ status: 1 });
    await userCollection.createIndex({ email: 1 }, { unique: true, sparse: true });
    await userCollection.createIndex({ role: 1 });
    await db.collection('notifications').createIndex({ toEmail: 1 });
    await db.collection('notifications').createIndex({ time: -1 });
    await db.collection('payments').createIndex({ userId: 1 });
    await db.collection('payments').createIndex({ stripeSessionId: 1 }, { sparse: true });
    await db.collection('withdrawals').createIndex({ creator_email: 1 });
    await db.collection('withdrawals').createIndex({ status: 1 });
    console.log('MongoDB indexes ensured.');
  } catch (err) {
    console.warn('Index creation warning (non-fatal):', err.message);
  }
}

async function connectDB() {
  await mongoClient.connect();
  db = mongoClient.db('crowdfunding');
  campaignCollection = db.collection('campaigns');
  contributionCollection = db.collection('contributions');
  userCollection = db.collection('user');
  sessionCollection = db.collection('session');
  console.log('Connected to MongoDB crowdfunding database');
  await createIndexes();
  return db;
}

// ─── Vercel Serverless Support ─────────────────────────────────────────────────
// @vercel/node requires this module to export a handler. We export a lazy async
// handler that connects to MongoDB on the first invocation (the cached promise
// is reused across warm invocations) and then delegates to the Express app.
// Local / PM2 / Docker runs instead call app.listen() once the DB is ready.
const isServerless = process.env.VERCEL === '1';

if (isServerless) {
  let dbPromise;
  async function vercelHandler(req, res) {
    if (!dbPromise) dbPromise = connectDB();
    try {
      await dbPromise;
    } catch (err) {
      dbPromise = undefined; // allow the next invocation to retry the connection
      console.error('MongoDB connection failed:', err.message);
      res.status(500).json({ error: 'Database connection failed' });
      return;
    }
    app(req, res);
  }
  module.exports = vercelHandler;
} else {
  // Only start listening after the DB is ready — avoids serving requests before
  // collections are available, which would cause immediate 500s.
  connectDB()
    .then(() => {
      app.listen(port, () => {
        console.log(`Express Server listening on port ${port} [${process.env.NODE_ENV || 'development'}]`);
      });
    })
    .catch((err) => {
      console.error('MongoDB connection failed:', err);
      process.exit(1);
    });
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully...`);
  try {
    await mongoClient.close();
    console.log('MongoDB connection closed.');
  } catch (e) {
    console.error('Error closing MongoDB:', e.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Helper to query by ID supporting both String and ObjectId
const getByIdQuery = (id) => {
  if (!id) return {};
  try {
    const objId = new ObjectId(id);
    return { $or: [{ _id: id }, { _id: objId }] };
  } catch (e) {
    return { _id: id };
  }
};


// Helper to parse Session Token from Cookies or Authorization Header
function getSessionToken(req) {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.split(' ')[1];
  }
  const cookies = req.headers.cookie;
  if (cookies) {
    const sessionCookie = cookies
      .split(';')
      .find((c) => c.trim().startsWith('better-auth.session_token='));
    if (sessionCookie) {
      return sessionCookie.split('=')[1].trim();
    }
  }
  return null;
}

// Authentication Middleware using Better Auth session tables
const authMiddleware = async (req, res, next) => {
  try {
    const token = getSessionToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No session token found' });
    }

    const session = await sessionCollection.findOne({ token });
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized: Session not found' });
    }

    if (new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({ error: 'Unauthorized: Session expired' });
    }

    let user = await userCollection.findOne({ _id: session.userId });
    if (!user) {
      try {
        user = await userCollection.findOne(getByIdQuery(session.userId));
      } catch (err) {}
    }

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Requires the authenticated user to have the 'admin' role
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};

// Map campaign fields to standard format for the client
const mapCampaign = (c) => {
  if (!c) return null;
  const current = c.currentAmount !== undefined ? c.currentAmount : (c.amountRaised !== undefined ? c.amountRaised : 0);
  const goal = c.goalAmount !== undefined ? c.goalAmount : (c.fundingGoal !== undefined ? c.fundingGoal : 0);
  const deadlineDate = c.endDate || c.deadline || '';
  const imagesList = c.images || (c.campaignImage ? [c.campaignImage] : []);
  return {
    _id: c._id ? c._id.toString() : null,
    title: c.title || c.campaignTitle || '',
    description: c.description || c.campaignStory || '',
    shortDescription: c.shortDescription || c.campaignStory?.substring(0, 150) || '',
    category: (c.category || 'Other').toLowerCase(),
    goalAmount: Number(goal),
    currentAmount: Number(current),
    endDate: deadlineDate,
    images: imagesList,
    status: c.status || 'active',
    creatorId: c.creatorId || '',
    creatorName: c.creatorName || '',
    creatorEmail: c.creatorEmail || '',
    backersCount: c.backersCount || 0,
    rewardInfo: c.rewardInfo || c.reward_info || '',
    createdAt: c.createdAt || new Date(),
    updatedAt: c.updatedAt || new Date()
  };
};

app.get('/', (req, res) => {
  res.send('Crowdfunding Backend API is running!');
});

// GET /api/campaigns - Get all campaigns with filters
app.get('/api/campaigns', async (req, res) => {
  try {
    const { search, category, sort, page = 1, limit = 12, status } = req.query;
    const query = {};

    // By default, do not return 'pending' campaigns unless queried explicitly
    if (status) {
      query.status = status;
    } else {
      query.status = { $in: ['active', 'approved'] };
    }

    if (category) {
      query.category = { $regex: new RegExp(`^${category}$`, 'i') };
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { campaignTitle: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { campaignStory: { $regex: search, $options: 'i' } }
      ];
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let sortQuery = { _id: -1 };
    if (sort === 'oldest') sortQuery = { _id: 1 };
    else if (sort === 'popular' || sort === 'most-backed') sortQuery = { backersCount: -1 };
    else if (sort === 'most-funded') sortQuery = { currentAmount: -1, amountRaised: -1 };
    else if (sort === 'ending-soon') sortQuery = { deadline: 1, endDate: 1 };

    const total = await campaignCollection.countDocuments(query);
    const rawCampaigns = await campaignCollection.find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limitNum)
      .toArray();

    const campaigns = rawCampaigns.map(mapCampaign).filter(Boolean);

    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json({
      campaigns,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum) || 1,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching campaigns' });
  }
});

// GET /api/campaigns/my - Get user's campaigns, sorted descending by deadline
app.get('/api/campaigns/my', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const query = { creatorEmail: email };
    const total = await campaignCollection.countDocuments(query);

    // Sort in descending order based on deadline (deadline or endDate)
    const rawCampaigns = await campaignCollection.find(query)
      .sort({ deadline: -1, endDate: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();
    const campaigns = rawCampaigns.map(mapCampaign).filter(Boolean);
    res.json({
      campaigns,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching user campaigns' });
  }
});

// GET /api/campaigns/:id - Get campaign details
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let campaign = await campaignCollection.findOne(getByIdQuery(id));
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const mapped = mapCampaign(campaign);

    // Fetch creator details + recent contributions in parallel to cut latency.
    const [creatorResult, recentContributions] = await Promise.all([
      mapped.creatorEmail
        ? userCollection.findOne({ email: mapped.creatorEmail })
        : Promise.resolve(null),
      contributionCollection.find({
        campaignId: id,
        status: { $in: ['approved', 'pending'] }
      }).sort({ _id: -1 }).limit(10).toArray(),
    ]);

    const creator = creatorResult || {
      name: mapped.creatorName || 'Emily Johnson',
      email: mapped.creatorEmail || 'emily@example.com',
      image: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb'
    };

    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.json({
      campaign: mapped,
      creator,
      recentContributions
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching campaign' });
  }
});

// POST /api/campaigns - Create a new campaign (Default status: 'pending')
app.post('/api/campaigns', authMiddleware, async (req, res) => {
  try {
    const { title, description, shortDescription, category, goalAmount, endDate, rewardInfo } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    const cleanTitle = sanitizeStr(title, 200);
    const cleanDescription = sanitizeStr(description, 10000);
    const cleanCategory = sanitizeStr(category, 100);
    const cleanRewardInfo = sanitizeStr(rewardInfo || '', 5000);

    if (!cleanTitle) return res.status(400).json({ error: 'Campaign title is required.' });
    if (!cleanDescription) return res.status(400).json({ error: 'Campaign description is required.' });
    if (!cleanCategory) return res.status(400).json({ error: 'Campaign category is required.' });

    const parsedGoal = Number(goalAmount);
    if (!parsedGoal || parsedGoal <= 0 || parsedGoal > 10_000_000) {
      return res.status(400).json({ error: 'Goal amount must be a positive number (max 10,000,000).' });
    }

    if (!endDate || isNaN(Date.parse(endDate))) {
      return res.status(400).json({ error: 'A valid end date is required.' });
    }
    if (new Date(endDate) <= new Date()) {
      return res.status(400).json({ error: 'End date must be in the future.' });
    }

    const newCamp = {
      creatorId: req.user._id.toString(),
      creatorName: req.user.name,
      creatorEmail: req.user.email,
      campaignTitle: cleanTitle,
      campaignStory: cleanDescription,
      shortDescription: sanitizeStr(shortDescription || cleanDescription.substring(0, 150), 300),
      category: cleanCategory,
      fundingGoal: parsedGoal,
      minimumContribution: 1,
      amountRaised: 0,
      currentAmount: 0,
      goalAmount: parsedGoal,
      deadline: endDate,
      endDate: endDate,
      status: 'pending', // Visible to supporters ONLY after Admin approval
      backersCount: 0,
      rewardInfo: cleanRewardInfo,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await campaignCollection.insertOne(newCamp);
    const saved = await campaignCollection.findOne({ _id: result.insertedId });
    res.status(201).json(mapCampaign(saved));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating campaign' });
  }
});

// PUT /api/campaigns/:id - Update campaign info (title, campaign_story, reward_info)
app.put('/api/campaigns/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, campaign_story, reward_info, description, rewardInfo } = req.body;

    const campaign = await campaignCollection.findOne(getByIdQuery(id));
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.creatorEmail !== req.user.email) {
      return res.status(403).json({ error: 'Unauthorized to update this campaign' });
    }

    const updatedFields = {
      title: title || campaign.title || campaign.campaignTitle,
      campaignTitle: title || campaign.campaignTitle || campaign.title,
      description: description || campaign_story || campaign.description || campaign.campaignStory,
      campaignStory: campaign_story || description || campaign.campaignStory || campaign.description,
      rewardInfo: rewardInfo || reward_info || campaign.rewardInfo || campaign.reward_info,
      reward_info: reward_info || rewardInfo || campaign.reward_info || campaign.rewardInfo,
      updatedAt: new Date()
    };

    await campaignCollection.updateOne(
      getByIdQuery(id),
      { $set: updatedFields }
    );

    const saved = await campaignCollection.findOne(getByIdQuery(id));
    res.json(mapCampaign(saved));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error updating campaign' });
  }
});

// DELETE /api/campaigns/:id - Delete campaign & refund all approved backers
app.delete('/api/campaigns/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const campaign = await campaignCollection.findOne(getByIdQuery(id));
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.creatorEmail !== req.user.email) {
      return res.status(403).json({ error: 'Unauthorized to delete this campaign' });
    }

    // Find all approved contributions for this campaign
    const approvedContributions = await contributionCollection.find({
      campaignId: id,
      status: 'approved'
    }).toArray();

    // Refund credits to all approved supporters
    for (let contr of approvedContributions) {
      const refundAmount = Number(contr.amount);
      const supporterId = contr.supporterId;

      let updateResult = null;
      try {
        updateResult = await userCollection.updateOne(
          { _id: supporterId },
          { $inc: { credits: refundAmount } }
        );
      } catch (e) {}

      if (!updateResult || updateResult.matchedCount === 0) {
        try {
          updateResult = await userCollection.updateOne(
            getByIdQuery(supporterId),
            { $inc: { credits: refundAmount } }
          );
        } catch (e) {}
      }

      // Add a notification for the supporter
      await db.collection("notifications").insertOne({
        userId: supporterId,
        title: "Campaign Deleted - Credits Refunded",
        message: `The campaign "${campaign.campaignTitle || campaign.title}" was deleted by its creator. Your contribution of $${refundAmount} has been refunded to your wallet.`,
        read: false,
        createdAt: new Date()
      });
    }

    // Update statuses of all contributions to refunded
    await contributionCollection.updateMany(
      { campaignId: id },
      { $set: { status: 'refunded', updatedAt: new Date() } }
    );

    // Delete the campaign
    await campaignCollection.deleteOne(getByIdQuery(id));

    res.json({ success: true, message: 'Campaign deleted and supporters refunded successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting campaign' });
  }
});

// GET /api/contributions/my - Get user's contributions with pagination & stats
app.get('/api/contributions/my', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const query = {
      $or: [
        { supporterEmail: email },
        { Supporter_email: email }
      ]
    };

    // Calculate user statistics
    const allUserContributions = await contributionCollection.find(query).toArray();
    const totalContributions = allUserContributions.length;
    const totalPendingContributions = allUserContributions.filter(c => c.status === 'pending').length;
    const totalAmountContributed = allUserContributions
      .filter(c => c.status === 'approved')
      .reduce((sum, c) => sum + Number(c.amount || c.Contribution_amount || 0), 0);

    // Support pagination parameters
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || 10;
    const skip = (pageNum - 1) * limitNum;

    const paginatedContributions = await contributionCollection.find(query)
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    // Map contributions to ensure they contain campaign details populated if needed by standard format
    const contributionsWithCampaigns = [];
    for (let c of paginatedContributions) {
      let campaign = null;
      if (c.campaignId) {
        try {
          const rawCamp = await campaignCollection.findOne(getByIdQuery(c.campaignId));
          campaign = rawCamp ? mapCampaign(rawCamp) : null;
        } catch (err) {}
      }
      contributionsWithCampaigns.push({
        ...c,
        campaign: campaign || null
      });
    }

    res.json({
      contributions: contributionsWithCampaigns,
      stats: {
        totalContributions,
        totalPendingContributions,
        totalAmountContributed
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalContributions,
        pages: Math.ceil(totalContributions / limitNum) || 1
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching my contributions' });
  }
});

// GET /api/contributions/pending - Get pending contributions for creator's campaigns
app.get('/api/contributions/pending', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const myCampaigns = await campaignCollection.find({ creatorEmail: email }).toArray();
    const campaignIds = myCampaigns.map(c => c._id.toString());

    const pendingContributions = await contributionCollection.find({
      campaignId: { $in: campaignIds },
      status: 'pending'
    }).sort({ _id: -1 }).toArray();

    res.json(pendingContributions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching contributions' });
  }
});

// PATCH /api/contributions/:id/approve - Approve contribution
app.patch('/api/contributions/:id/approve', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const contribution = await contributionCollection.findOne(getByIdQuery(id));
    if (!contribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    if (contribution.status !== 'pending') {
      return res.status(400).json({ error: 'Contribution is not pending' });
    }

    // Verify req.user is the owner of the campaign
    const campaign = await campaignCollection.findOne(getByIdQuery(contribution.campaignId));
    if (!campaign || campaign.creatorEmail !== req.user.email) {
      return res.status(403).json({ error: 'Unauthorized to approve this contribution' });
    }

    // Update status to approved
    await contributionCollection.updateOne(
      getByIdQuery(id),
      { $set: { status: 'approved', updatedAt: new Date() } }
    );

    // Add amount raised to campaign
    const contributionAmount = Number(contribution.amount);
    await campaignCollection.updateOne(
      getByIdQuery(contribution.campaignId),
      { 
        $inc: { 
          amountRaised: contributionAmount, 
          currentAmount: contributionAmount,
          backersCount: 1 
        } 
      }
    );

    // Generate a notification for the supporter (new toEmail schema)
    const campaignTitleApprove = campaign.campaignTitle || campaign.title || 'the campaign';
    const creatorNameApprove = campaign.creatorName || req.user.name || 'the creator';
    const supporterEmailApprove = contribution.supporterEmail || contribution.Supporter_email || '';
    await db.collection("notifications").insertOne({
      message: `Your Contribution of ${contributionAmount} credits to ${campaignTitleApprove} was approved by ${creatorNameApprove}`,
      toEmail: supporterEmailApprove,
      actionRoute: "/dashboard/supporter/contributions",
      time: new Date(),
      read: false,
    });

    res.json({ success: true, message: 'Contribution approved successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error approving contribution' });
  }
});

// PATCH /api/contributions/:id/reject - Reject contribution and refund supporter
app.patch('/api/contributions/:id/reject', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const contribution = await contributionCollection.findOne(getByIdQuery(id));
    if (!contribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    if (contribution.status !== 'pending') {
      return res.status(400).json({ error: 'Contribution is not pending' });
    }

    // Verify req.user is the owner of the campaign
    const campaign = await campaignCollection.findOne(getByIdQuery(contribution.campaignId));
    if (!campaign || campaign.creatorEmail !== req.user.email) {
      return res.status(403).json({ error: 'Unauthorized to reject this contribution' });
    }

    // Update status to rejected
    await contributionCollection.updateOne(
      getByIdQuery(id),
      { $set: { status: 'rejected', updatedAt: new Date() } }
    );

    // Refund credits to supporter user
    const refundAmount = Number(contribution.amount);
    let supporterUserId = contribution.supporterId;

    let updateResult = null;
    try {
      updateResult = await userCollection.updateOne(
        { _id: supporterUserId },
        { $inc: { credits: refundAmount } }
      );
    } catch (e) {}

    if (!updateResult || updateResult.matchedCount === 0) {
      try {
        updateResult = await userCollection.updateOne(
          getByIdQuery(supporterUserId),
          { $inc: { credits: refundAmount } }
        );
      } catch (e) {}
    }

    // Generate a notification for the supporter (new toEmail schema)
    const campaignTitleReject = campaign.campaignTitle || campaign.title || 'the campaign';
    const creatorNameReject = campaign.creatorName || req.user.name || 'the creator';
    const supporterEmailReject = contribution.supporterEmail || contribution.Supporter_email || '';
    await db.collection("notifications").insertOne({
      message: `Your Contribution of ${refundAmount} credits to ${campaignTitleReject} was rejected by ${creatorNameReject}. Credits have been refunded to your account.`,
      toEmail: supporterEmailReject,
      actionRoute: "/dashboard/supporter/contributions",
      time: new Date(),
      read: false,
    });

    res.json({ success: true, message: 'Contribution rejected and refunded successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error rejecting contribution' });
  }
});

// Notifications Endpoint — query by toEmail matching the logged-in user's email
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const notifications = await db.collection("notifications")
      .find({ toEmail: userEmail })
      .sort({ time: -1, _id: -1 })
      .toArray();
    const unread = await db.collection("notifications").countDocuments({ toEmail: userEmail, read: false });
    res.json({ notifications, unread });
  } catch (err) {
    res.json({ notifications: [], unread: 0 });
  }
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await db.collection("notifications").updateOne(
      getByIdQuery(req.params.id),
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

app.patch('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await db.collection("notifications").updateMany(
      { toEmail: req.user.email, read: false },
      { $set: { read: true } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error' });
  }
});

// GET /api/withdrawals/my - Get withdrawals for the creator
app.get('/api/withdrawals/my', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const list = await db.collection("withdrawals").find({ creator_email: email }).sort({ _id: -1 }).toArray();
    
    // Calculate total raised credits across all creator's campaigns
    const campaigns = await campaignCollection.find({ creatorEmail: email }).toArray();
    const totalRaisedCredits = campaigns.reduce((sum, c) => sum + (c.currentAmount || 0), 0);

    // Calculate total already withdrawn credits (status is not rejected)
    const previousWithdrawals = list.filter(w => w.status !== 'rejected');
    const totalWithdrawnCredits = previousWithdrawals.reduce((sum, w) => sum + (w.withdrawal_credit || 0), 0);

    const availableCredits = totalRaisedCredits - totalWithdrawnCredits;

    res.json({
      withdrawals: list,
      totalRaisedCredits,
      totalWithdrawnCredits,
      availableCredits
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching withdrawals' });
  }
});

// POST /api/withdrawals - Submit withdrawal request
app.post('/api/withdrawals', authMiddleware, async (req, res) => {
  try {
    const { withdrawal_credit, payment_system, account_number } = req.body;
    const credits = Number(withdrawal_credit);

    if (!credits || credits <= 0) {
      return res.status(400).json({ error: 'Invalid credits amount' });
    }

    // Calculate total raised credits across all creator's campaigns
    const email = req.user.email;
    const campaigns = await campaignCollection.find({ creatorEmail: email }).toArray();
    const totalRaisedCredits = campaigns.reduce((sum, c) => sum + (c.currentAmount || 0), 0);

    // Calculate total already withdrawn credits
    const previousWithdrawals = await db.collection("withdrawals").find({
      creator_email: email,
      status: { $ne: 'rejected' }
    }).toArray();
    const totalWithdrawnCredits = previousWithdrawals.reduce((sum, w) => sum + (w.withdrawal_credit || 0), 0);

    const availableCredits = totalRaisedCredits - totalWithdrawnCredits;

    // Checks
    if (totalRaisedCredits < 200) {
      return res.status(400).json({ error: 'You need a minimum of 200 credits raised in total to withdraw' });
    }

    if (credits > availableCredits) {
      return res.status(400).json({ error: `Withdrawal amount exceeds available credits (${availableCredits})` });
    }

    const withdrawalAmountUSD = credits / 20; // 20 credits = 1 dollar

    let stripeTxId = null;
    if (payment_system === 'stripe') {
      // Simulate real Stripe payment transfer / payout creation
      stripeTxId = "po_sim_" + Math.random().toString(36).substring(2, 15);
    }

    const withdrawalDoc = {
      creator_email: email,
      creator_name: req.user.name,
      withdrawal_credit: credits,
      withdrawal_amount: withdrawalAmountUSD,
      payment_system: payment_system,
      account_number: account_number,
      withdraw_date: new Date(),
      status: 'pending',
      stripeTxId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection("withdrawals").insertOne(withdrawalDoc);
    const saved = await db.collection("withdrawals").findOne({ _id: result.insertedId });

    res.status(201).json({ success: true, withdrawal: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error processing withdrawal' });
  }
});

// Payments & Withdrawals unified history endpoint
app.get('/api/payments/history', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'creator') {
      const withdrawals = await db.collection("withdrawals").find({ creator_email: req.user.email })
        .sort({ _id: -1 }).toArray();
      // Map withdrawals to match client expected history item keys
      const mapped = withdrawals.map(w => ({
        _id: w._id.toString(),
        type: 'withdrawal',
        amount: w.withdrawal_amount,
        createdAt: w.withdraw_date,
        status: w.status,
        paymentSystem: w.payment_system,
        accountNumber: w.account_number,
        credits: w.withdrawal_credit
      }));
      res.json(mapped);
    } else {
      const history = await db.collection("payments").find({ userId: req.user._id.toString() })
        .sort({ _id: -1 }).toArray();
      res.json(history);
    }
  } catch (err) {
    console.error('Payment history error:', err);
    res.status(500).json({ error: 'Server error fetching payment history' });
  }
});

app.post('/api/payments/purchase-credit', authMiddleware, async (req, res) => {
  const { amount, credits } = req.body;
  try {
    const usdAmount = Number(amount);
    if (!usdAmount || usdAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const creditsToPurchase = Number(credits !== undefined ? credits : usdAmount * 10);

    let updateResult = null;
    try {
      updateResult = await userCollection.updateOne(
        { _id: req.user._id },
        { $inc: { credits: creditsToPurchase } }
      );
    } catch (e) {}

    if (!updateResult || updateResult.matchedCount === 0) {
      try {
        updateResult = await userCollection.updateOne(
          getByIdQuery(req.user._id),
          { $inc: { credits: creditsToPurchase } }
        );
      } catch (e) {}
    }
    
    // Add record to payments
    await db.collection("payments").insertOne({
      userId: req.user._id.toString(),
      userName: req.user.name,
      amount: usdAmount,
      credits: creditsToPurchase,
      type: 'credit_purchase',
      status: 'completed',
      createdAt: new Date()
    });

    res.json({ success: true, message: 'Credits purchased successfully' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to purchase credit' });
  }
});

// Create a real Stripe Checkout Session for purchasing credits
app.post('/api/payments/create-checkout-session', authMiddleware, async (req, res) => {
  const { price, credits } = req.body;
  try {
    const usdAmount = Number(price);
    if (!usdAmount || usdAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const creditsToPurchase = Number(credits !== undefined ? credits : usdAmount * 10);

    const origin = req.headers.referer || req.headers.origin || 'http://localhost:3000';

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${creditsToPurchase} Credits Wallet Upgrade`,
              description: `Purchase of ${creditsToPurchase} credits for CrowdFund.`,
            },
            unit_amount: Math.round(usdAmount * 100), // in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${origin.endsWith('/') ? origin.slice(0, -1) : origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin.endsWith('/') ? origin.slice(0, -1) : origin}/payment/cancel`,
      metadata: {
        userId: req.user._id.toString(),
        credits: creditsToPurchase.toString(),
        amount: usdAmount.toString(),
      },
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Create Stripe session error:', err);
    // Never expose raw Stripe error messages to the client
    res.status(500).json({ error: 'Server error creating Stripe session' });
  }
});

// Verify Stripe Checkout Session and credit user
app.post('/api/payments/verify-checkout-session', authMiddleware, async (req, res) => {
  const { sessionId } = req.body;
  try {
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Stripe session not found' });
    }

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment has not been completed' });
    }

    // Check if processed
    const existingPayment = await db.collection("payments").findOne({ stripeSessionId: sessionId });
    if (existingPayment) {
      return res.json({ success: true, alreadyProcessed: true, credits: existingPayment.credits });
    }

    const userId = session.metadata.userId;
    const creditsToPurchase = Number(session.metadata.credits);
    const usdAmount = Number(session.metadata.amount);

    let updateResult = null;
    try {
      updateResult = await userCollection.updateOne(
        { _id: userId },
        { $inc: { credits: creditsToPurchase } }
      );
    } catch (e) {}

    if (!updateResult || updateResult.matchedCount === 0) {
      try {
        updateResult = await userCollection.updateOne(
          getByIdQuery(userId),
          { $inc: { credits: creditsToPurchase } }
        );
      } catch (e) {}
    }

    // Add to payments
    await db.collection("payments").insertOne({
      userId: userId,
      userName: req.user.name,
      amount: usdAmount,
      credits: creditsToPurchase,
      type: 'credit_purchase',
      status: 'completed',
      stripeSessionId: sessionId,
      createdAt: new Date()
    });

    res.json({ success: true, credits: creditsToPurchase });
  } catch (err) {
    console.error('Verify Stripe session error:', err);
    res.status(500).json({ error: 'Server error verifying Stripe session' });
  }
});


app.post('/api/payments/create-session', authMiddleware, async (req, res) => {
  const { campaignId, amount, Contribution_amount, message, anonymous } = req.body;
  try {
    const finalAmount = Number(Contribution_amount !== undefined ? Contribution_amount : amount);
    if (!finalAmount || finalAmount <= 0) {
      return res.status(400).json({ error: 'Invalid contribution amount' });
    }

    // D2: Pre-check user has sufficient credits before deducting
    const currentUser = await userCollection.findOne(getByIdQuery(req.user._id));
    const userCredits = Number((currentUser && currentUser.credits) || 0);
    if (userCredits < finalAmount) {
      return res.status(400).json({ error: `Insufficient credits. You have ${userCredits} credits but need ${finalAmount}.` });
    }

    const campaign = await campaignCollection.findOne(getByIdQuery(campaignId));
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const creatorName = campaign.creatorName || 'Emily Johnson';
    const creatorEmail = campaign.creatorEmail || 'emily@example.com';
    const finalCampaignTitle = campaign.campaignTitle || campaign.title || 'Campaign';

    const contr = {
      // Standard keys
      supporterId: req.user._id.toString(),
      supporterName: req.user.name,
      supporterEmail: req.user.email,
      campaignId,
      campaignTitle: finalCampaignTitle,
      amount: finalAmount,
      message: message || '',
      anonymous: !!anonymous,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),

      // Exact prompt keys
      campaign_id: campaignId,
      campaign_title: finalCampaignTitle,
      Contribution_amount: finalAmount,
      Supporter_email: req.user.email,
      Supporter_name: req.user.name,
      creator_name: creatorName,
      creator_email: creatorEmail,
      current_date: new Date()
    };

    await contributionCollection.insertOne(contr);

    // Notify the campaign creator about the new contribution
    await db.collection("notifications").insertOne({
      message: `${req.user.name} made a new Contribution of ${finalAmount} credits to your campaign "${finalCampaignTitle}"`,
      toEmail: creatorEmail,
      actionRoute: "/dashboard/creator/campaigns",
      time: new Date(),
      read: false,
    });
    
    // Deduct credits from user immediately
    let updateResult = null;
    try {
      updateResult = await userCollection.updateOne(
        { _id: req.user._id },
        { $inc: { credits: -finalAmount } }
      );
    } catch (e) {}

    if (!updateResult || updateResult.matchedCount === 0) {
      try {
        updateResult = await userCollection.updateOne(
          getByIdQuery(req.user._id),
          { $inc: { credits: -finalAmount } }
        );
      } catch (e) {}
    }

    res.json({ url: '/dashboard/supporter/contributions' }); // redirect to contributions list instead of Stripe URL
  } catch (e) {
    console.error('Payment session creation failed:', e);
    res.status(500).json({ error: 'Payment failed' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/withdrawals/pending — All pending withdrawal requests (Admin only)
app.get('/api/withdrawals/pending', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const total = await db.collection('withdrawals').countDocuments({ status: 'pending' });
    const withdrawals = await db.collection('withdrawals')
      .find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({
      withdrawals,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      }
    });
  } catch (err) {
    console.error('Pending withdrawals error:', err);
    res.status(500).json({ error: 'Server error fetching pending withdrawals' });
  }
});

// PATCH /api/withdrawals/:id/approve — Mark withdrawal as approved & deduct credits from creator
// requireAdmin: only admins may approve withdrawal requests
app.patch('/api/withdrawals/:id/approve', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body;

    const withdrawal = await db.collection('withdrawals').findOne(getByIdQuery(id));
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal is not pending' });
    }

    const creditsToDeduct = Number(withdrawal.withdrawal_credit || 0);
    const creatorEmail = withdrawal.creator_email;

    // Mark the withdrawal as approved
    await db.collection('withdrawals').updateOne(
      getByIdQuery(id),
      { $set: { status: 'approved', adminNote: adminNote || '', updatedAt: new Date() } }
    );

    // Deduct the withdrawal credits from the creator's campaigns (reduce currentAmount)
    // We spread the deduction proportionally across campaigns that have raised funds,
    // starting from the most-funded, until the full amount is deducted.
    if (creditsToDeduct > 0 && creatorEmail) {
      const campaigns = await campaignCollection
        .find({ creatorEmail, currentAmount: { $gt: 0 } })
        .sort({ currentAmount: -1 })
        .toArray();

      let remaining = creditsToDeduct;
      for (const camp of campaigns) {
        if (remaining <= 0) break;
        const deduct = Math.min(remaining, camp.currentAmount || 0);
        await campaignCollection.updateOne(
          { _id: camp._id },
          { $inc: { currentAmount: -deduct, amountRaised: -deduct } }
        );
        remaining -= deduct;
      }
    }

    // Notify the creator (new toEmail schema)
    if (creatorEmail) {
      const usdAmount = withdrawal.withdrawal_amount || (creditsToDeduct / 20);
      await db.collection('notifications').insertOne({
        message: `Your withdrawal of ${creditsToDeduct} credits ($${Number(usdAmount).toFixed(2)}) has been approved by Admin via ${withdrawal.payment_system || 'your payment method'}`,
        toEmail: creatorEmail,
        actionRoute: "/dashboard/creator/withdrawals",
        time: new Date(),
        read: false,
      });
    }

    res.json({ success: true, message: 'Withdrawal approved and credits deducted from creator' });
  } catch (err) {
    console.error('Approve withdrawal error:', err);
    res.status(500).json({ error: 'Server error approving withdrawal' });
  }
});

// PATCH /api/withdrawals/:id/reject — Reject a withdrawal request
// requireAdmin: only admins may reject withdrawal requests
app.patch('/api/withdrawals/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body;

    const withdrawal = await db.collection('withdrawals').findOne(getByIdQuery(id));
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal is not pending' });
    }

    await db.collection('withdrawals').updateOne(
      getByIdQuery(id),
      { $set: { status: 'rejected', adminNote: adminNote || '', updatedAt: new Date() } }
    );

    // Notify the creator
    const creatorEmail = withdrawal.creator_email;
    if (creatorEmail) {
      const creator = await userCollection.findOne({ email: creatorEmail });
      if (creator) {
        const noteText = adminNote ? ` Reason: ${adminNote}` : '';
        await db.collection('notifications').insertOne({
          userId: creator._id.toString(),
          title: 'Withdrawal Request Rejected',
          message: `Your withdrawal request of ${withdrawal.withdrawal_credit} credits was rejected.${noteText} Please contact support if you have questions.`,
          read: false,
          createdAt: new Date(),
        });
      }
    }

    res.json({ success: true, message: 'Withdrawal rejected' });
  } catch (err) {
    console.error('Reject withdrawal error:', err);
    res.status(500).json({ error: 'Server error rejecting withdrawal' });
  }
});


// GET /api/admin/stats — 4 key platform statistics for the Admin Home page
app.get('/api/admin/stats', authMiddleware, requireAdmin, async (req, res) => {
  try {
    // Count supporters (role === 'supporter')
    const totalSupporters = await userCollection.countDocuments({ role: 'supporter' });

    // Count creators (role === 'creator')
    const totalCreators = await userCollection.countDocuments({ role: 'creator' });

    // Sum of all users' credits
    const creditAgg = await userCollection.aggregate([
      { $group: { _id: null, total: { $sum: '$credits' } } }
    ]).toArray();
    const totalAvailableCredits = creditAgg.length > 0 ? (creditAgg[0].total || 0) : 0;

    // Total payments processed (sum of all payment amounts)
    const paymentAgg = await db.collection('payments').aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const totalPaymentsProcessed = paymentAgg.length > 0 ? (paymentAgg[0].total || 0) : 0;

    res.json({
      stats: {
        totalSupporters,
        totalCreators,
        totalAvailableCredits,
        totalPaymentsProcessed,
      }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Server error fetching admin stats' });
  }
});

// GET /api/admin/campaigns/pending — All campaigns with status === 'pending'
app.get('/api/admin/campaigns/pending', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const rawCampaigns = await campaignCollection
      .find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .toArray();
    // Filter out any null results from mapCampaign (e.g. corrupted docs with null _id)
    const campaigns = rawCampaigns.map(mapCampaign).filter(Boolean);
    res.json({ campaigns });
  } catch (err) {
    console.error('Pending campaigns error:', err);
    res.status(500).json({ error: 'Server error fetching pending campaigns' });
  }
});

// PATCH /api/admin/campaigns/:id/approve — Approve a pending campaign
app.patch('/api/admin/campaigns/:id/approve', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // D3: Atomic update — only approve if still 'pending' to prevent race conditions
    const query = { ...getByIdQuery(id), status: 'pending' };
    const campaign = await campaignCollection.findOneAndUpdate(
      query,
      { $set: { status: 'approved', updatedAt: new Date() } },
      { returnDocument: 'before' }
    );
    if (!campaign) {
      // Either not found or already approved/rejected by concurrent request
      const existing = await campaignCollection.findOne(getByIdQuery(id));
      if (!existing) return res.status(404).json({ error: 'Campaign not found' });
      return res.status(409).json({ error: `Campaign is already '${existing.status}' — cannot approve` });
    }

    // Notify the creator (new toEmail schema)
    const creatorEmail = campaign.creatorEmail;
    if (creatorEmail) {
      await db.collection('notifications').insertOne({
        message: `Your campaign "${campaign.campaignTitle || campaign.title}" has been approved by Admin and is now live for supporters!`,
        toEmail: creatorEmail,
        actionRoute: "/dashboard/creator/campaigns",
        time: new Date(),
        read: false,
      });
    }

    res.json({ success: true, message: 'Campaign approved successfully' });
  } catch (err) {
    console.error('Approve campaign error:', err);
    res.status(500).json({ error: 'Server error approving campaign' });
  }
});

// PATCH /api/admin/campaigns/:id/reject — Reject a pending campaign & notify creator
app.patch('/api/admin/campaigns/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const campaign = await campaignCollection.findOne(getByIdQuery(id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await campaignCollection.updateOne(
      getByIdQuery(id),
      { $set: { status: 'rejected', updatedAt: new Date() } }
    );

    // Notify the creator (new toEmail schema)
    const creatorEmail = campaign.creatorEmail;
    if (creatorEmail) {
      const reasonText = reason ? ` Reason: ${reason}` : '';
      await db.collection('notifications').insertOne({
        message: `Your campaign "${campaign.campaignTitle || campaign.title}" was rejected by Admin.${reasonText} Please review and resubmit.`,
        toEmail: creatorEmail,
        actionRoute: "/dashboard/creator/campaigns",
        time: new Date(),
        read: false,
      });
    }

    res.json({ success: true, message: 'Campaign rejected and creator notified' });
  } catch (err) {
    console.error('Reject campaign error:', err);
    res.status(500).json({ error: 'Server error rejecting campaign' });
  }
});

// GET /api/admin/users — All users with search, role filter, pagination
app.get('/api/admin/users', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { search = '', role = '', page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (role) query.role = role;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const total = await userCollection.countDocuments(query);
    const rawUsers = await userCollection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    // Map to safe fields (no password hashes etc.); S8: null-guard _id
    const users = rawUsers
      .filter(u => u && u._id)
      .map(u => ({
        _id: u._id.toString(),
        name: u.name || u.displayName || '',
        email: u.email || '',
        image: u.image || u.photoURL || u.photo_url || '',
        role: u.role || 'supporter',
        credits: u.credits || 0,
        createdAt: u.createdAt || null,
      }));

    res.json({
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ error: 'Server error fetching users' });
  }
});

// PATCH /api/admin/users/:id/role — Update a user’s role
app.patch('/api/admin/users/:id/role', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const validRoles = ['admin', 'creator', 'supporter'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be admin, creator, or supporter.' });
    }

    let result = null;
    try {
      result = await userCollection.updateOne(
        { _id: id },
        { $set: { role, updatedAt: new Date() } }
      );
    } catch (e) {}

    if (!result || result.matchedCount === 0) {
      try {
        result = await userCollection.updateOne(
          getByIdQuery(id),
          { $set: { role, updatedAt: new Date() } }
        );
      } catch (e) {}
    }

    if (!result || result.matchedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: `User role updated to ${role}` });
  } catch (err) {
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Server error updating user role' });
  }
});

// DELETE /api/admin/users/:id — Delete a user from the database
app.delete('/api/admin/users/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    let result = null;
    try {
      result = await userCollection.deleteOne({ _id: id });
    } catch (e) {}

    if (!result || result.deletedCount === 0) {
      try {
        result = await userCollection.deleteOne(getByIdQuery(id));
      } catch (e) {}
    }

    if (!result || result.deletedCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Server error deleting user' });
  }
});

// GET /api/admin/all-campaigns — All campaigns for admin (all statuses, paginated, searchable)
app.get('/api/admin/all-campaigns', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { search = '', status = '', category = '', page = 1, limit = 15 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (status) query.status = status;
    if (category) query.category = { $regex: new RegExp(`^${category}$`, 'i') };
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { campaignTitle: { $regex: search, $options: 'i' } },
        { creatorName: { $regex: search, $options: 'i' } },
        { creatorEmail: { $regex: search, $options: 'i' } },
      ];
    }

    const total = await campaignCollection.countDocuments(query);
    const rawCampaigns = await campaignCollection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    res.json({
      campaigns: rawCampaigns.map(mapCampaign).filter(Boolean),
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) || 1 },
    });
  } catch (err) {
    console.error('Admin all-campaigns error:', err);
    res.status(500).json({ error: 'Server error fetching campaigns' });
  }
});

// DELETE /api/admin/campaigns/:id — Admin force-delete any campaign
app.delete('/api/admin/campaigns/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const campaign = await campaignCollection.findOne(getByIdQuery(id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Refund approved backers
    const approved = await contributionCollection.find({ campaignId: id, status: 'approved' }).toArray();
    for (const contr of approved) {
      const refund = Number(contr.amount);
      let r = null;
      try { r = await userCollection.updateOne({ _id: contr.supporterId }, { $inc: { credits: refund } }); } catch (e) {}
      if (!r || r.matchedCount === 0) {
        try { await userCollection.updateOne(getByIdQuery(contr.supporterId), { $inc: { credits: refund } }); } catch (e) {}
      }
      await db.collection('notifications').insertOne({
        userId: contr.supporterId,
        title: 'Campaign Removed — Credits Refunded',
        message: `The campaign "${campaign.campaignTitle || campaign.title}" was removed by an admin. Your contribution of $${refund} has been refunded.`,
        read: false, createdAt: new Date(),
      });
    }

    await contributionCollection.updateMany({ campaignId: id }, { $set: { status: 'refunded', updatedAt: new Date() } });
    await campaignCollection.deleteOne(getByIdQuery(id));

    res.json({ success: true, message: 'Campaign deleted by admin' });
  } catch (err) {
    console.error('Admin delete campaign error:', err);
    res.status(500).json({ error: 'Server error deleting campaign' });
  }
});

// PATCH /api/admin/campaigns/:id/suspend — Suspend a campaign
app.patch('/api/admin/campaigns/:id/suspend', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const campaign = await campaignCollection.findOne(getByIdQuery(id));
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    await campaignCollection.updateOne(
      getByIdQuery(id),
      { $set: { status: 'suspended', updatedAt: new Date() } }
    );

    // Notify creator
    if (campaign.creatorEmail) {
      const creator = await userCollection.findOne({ email: campaign.creatorEmail });
      if (creator) {
        await db.collection('notifications').insertOne({
          userId: creator._id.toString(),
          title: 'Campaign Suspended',
          message: `Your campaign "${campaign.campaignTitle || campaign.title}" has been suspended by an admin pending review. Please contact support for more information.`,
          read: false, createdAt: new Date(),
        });
      }
    }

    res.json({ success: true, message: 'Campaign suspended' });
  } catch (err) {
    console.error('Suspend campaign error:', err);
    res.status(500).json({ error: 'Server error suspending campaign' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Reports
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/reports — Admin: list all reports with populated campaign & reporter info
app.get('/api/reports', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { status = '', page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (status) query.status = status;

    const total = await db.collection('reports').countDocuments(query);
    const rawReports = await db.collection('reports')
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .toArray();

    // Populate campaign title & reporter name
    const reports = await Promise.all(rawReports.map(async (r) => {
      let campaignTitle = r.campaignTitle || '';
      let campaignStatus = '';
      if (r.campaignId && !campaignTitle) {
        try {
          const camp = await campaignCollection.findOne(getByIdQuery(r.campaignId));
          if (camp) { campaignTitle = camp.campaignTitle || camp.title || ''; campaignStatus = camp.status; }
        } catch (e) {}
      }

      let reporterName = r.reporterName || '';
      let reporterEmail = r.reporterEmail || '';
      if (r.reporterId && !reporterName) {
        try {
          const user = await userCollection.findOne(getByIdQuery(r.reporterId));
          if (user) { reporterName = user.name || ''; reporterEmail = user.email || ''; }
        } catch (e) {}
      }

      return {
        _id: r._id.toString(),
        campaignId: r.campaignId || '',
        campaignTitle,
        campaignStatus,
        reporterId: r.reporterId || '',
        reporterName,
        reporterEmail,
        reason: r.reason || '',
        description: r.description || '',
        status: r.status || 'pending',
        adminNote: r.adminNote || '',
        createdAt: r.createdAt || new Date(),
      };
    }));

    res.json({
      reports,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) || 1 },
    });
  } catch (err) {
    console.error('Get reports error:', err);
    res.status(500).json({ error: 'Server error fetching reports' });
  }
});

// POST /api/reports — Supporter submits a report on a campaign
app.post('/api/reports', authMiddleware, async (req, res) => {
  try {
    const { campaignId, reason, description } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    const cleanReason = sanitizeStr(reason, 500);
    const cleanDescription = sanitizeStr(description || '', 3000);

    if (!campaignId) return res.status(400).json({ error: 'campaignId is required' });
    if (!cleanReason) return res.status(400).json({ error: 'reason is required (max 500 chars)' });

    let campaignTitle = '';
    try {
      const camp = await campaignCollection.findOne(getByIdQuery(campaignId));
      if (camp) campaignTitle = camp.campaignTitle || camp.title || '';
    } catch (e) {}

    const report = {
      campaignId,
      campaignTitle,
      reporterId: req.user._id.toString(),
      reporterName: req.user.name || '',
      reporterEmail: req.user.email || '',
      reason: cleanReason,
      description: cleanDescription,
      status: 'pending',
      adminNote: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection('reports').insertOne(report);
    res.status(201).json({ success: true, _id: result.insertedId });
  } catch (err) {
    console.error('Submit report error:', err);
    res.status(500).json({ error: 'Server error submitting report' });
  }
});

// PATCH /api/reports/:id — Admin updates report status
app.patch('/api/reports/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNote } = req.body;
    await db.collection('reports').updateOne(
      getByIdQuery(id),
      { $set: { status, adminNote: adminNote || '', updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ error: 'Server error updating report' });
  }
});

// On Vercel serverless this module exports a lazy handler (see the startup
// block near connectDB()); on local / PM2 runs app.listen() starts after the
// database connection is fully established.
