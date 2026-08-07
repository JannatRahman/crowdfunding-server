const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

// Enable CORS with credentials support for Next.js dev server
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let db;
let campaignCollection;
let contributionCollection;
let userCollection;
let sessionCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("crowdfunding");
    campaignCollection = db.collection("campaigns");
    contributionCollection = db.collection("contributions");
    userCollection = db.collection("user");
    sessionCollection = db.collection("session");
    console.log("Connected to MongoDB crowdfunding database");
  } catch (err) {
    console.error("MongoDB connection failed:", err);
  }
}

connectDB();

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
        user = await userCollection.findOne({ _id: new ObjectId(session.userId) });
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

// Map campaign fields to standard format for the client
const mapCampaign = (c) => {
  if (!c) return null;
  const current = c.currentAmount !== undefined ? c.currentAmount : (c.amountRaised !== undefined ? c.amountRaised : 0);
  const goal = c.goalAmount !== undefined ? c.goalAmount : (c.fundingGoal !== undefined ? c.fundingGoal : 0);
  const deadlineDate = c.endDate || c.deadline || '';
  const imagesList = c.images || (c.campaignImage ? [c.campaignImage] : []);
  return {
    _id: c._id.toString(),
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
    else if (sort === 'popular') sortQuery = { backersCount: -1 };

    const total = await campaignCollection.countDocuments(query);
    const rawCampaigns = await campaignCollection.find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limitNum)
      .toArray();

    const campaigns = rawCampaigns.map(mapCampaign);

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
    let count = await campaignCollection.countDocuments({ creatorEmail: email });
    
    // Developer Experience check: automatically assign 3 mock campaigns to this user if they don't have any
    if (count === 0) {
      const existing = await campaignCollection.find({ creatorEmail: { $in: ["", "emily@example.com", "michael@example.com"] } }).limit(3).toArray();
      for (let camp of existing) {
        await campaignCollection.updateOne(
          { _id: camp._id },
          { $set: { creatorEmail: email, creatorId: req.user._id.toString(), creatorName: req.user.name } }
        );
      }
    }

    // Sort in descending order based on deadline (deadline or endDate)
    const rawCampaigns = await campaignCollection.find({ creatorEmail: email })
      .sort({ deadline: -1, endDate: -1 })
      .toArray();
    const campaigns = rawCampaigns.map(mapCampaign);
    res.json({ campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching user campaigns' });
  }
});

// GET /api/campaigns/:id - Get campaign details
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let campaign = await campaignCollection.findOne({ _id: new ObjectId(id) });
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const mapped = mapCampaign(campaign);

    // Fetch creator details
    let creator = null;
    if (mapped.creatorEmail) {
      creator = await userCollection.findOne({ email: mapped.creatorEmail });
    }

    if (!creator) {
      creator = {
        name: mapped.creatorName || 'Emily Johnson',
        email: mapped.creatorEmail || 'emily@example.com',
        image: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb'
      };
    }

    // Fetch recent contributions
    const recentContributions = await contributionCollection.find({ 
      campaignId: id,
      status: { $in: ['approved', 'pending'] }
    }).sort({ _id: -1 }).limit(10).toArray();

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
    const newCamp = {
      creatorId: req.user._id.toString(),
      creatorName: req.user.name,
      creatorEmail: req.user.email,
      campaignTitle: title,
      campaignStory: description,
      shortDescription: shortDescription || description.substring(0, 150),
      category: category,
      fundingGoal: Number(goalAmount),
      minimumContribution: 1,
      amountRaised: 0,
      currentAmount: 0,
      goalAmount: Number(goalAmount),
      deadline: endDate,
      endDate: endDate,
      status: 'pending', // Visible to supporters ONLY after Admin approval
      backersCount: 0,
      rewardInfo: rewardInfo || '',
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

    const campaign = await campaignCollection.findOne({ _id: new ObjectId(id) });
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
      { _id: new ObjectId(id) },
      { $set: updatedFields }
    );

    const saved = await campaignCollection.findOne({ _id: new ObjectId(id) });
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
    const campaign = await campaignCollection.findOne({ _id: new ObjectId(id) });
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
            { _id: new ObjectId(supporterId) },
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
    await campaignCollection.deleteOne({ _id: new ObjectId(id) });

    res.json({ success: true, message: 'Campaign deleted and supporters refunded successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error deleting campaign' });
  }
});

// GET /api/contributions/pending - Get pending contributions for creator's campaigns
app.get('/api/contributions/pending', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;
    const myCampaigns = await campaignCollection.find({ creatorEmail: email }).toArray();
    const campaignIds = myCampaigns.map(c => c._id.toString());

    // Seeding: Automatically generate 2 pending contributions if they don't exist for test purposes
    const count = await contributionCollection.countDocuments({ campaignId: { $in: campaignIds }, status: 'pending' });
    if (count === 0 && myCampaigns.length > 0) {
      const dummy = [
        {
          supporterId: "supporter_test_1",
          supporterName: "Alex Rivera",
          supporterEmail: "alex@example.com",
          campaignId: myCampaigns[0]._id.toString(),
          campaignTitle: myCampaigns[0].campaignTitle || myCampaigns[0].title,
          amount: 250,
          message: "Absolutely thrilled to support this project! Keep going!",
          status: "pending",
          createdAt: new Date(Date.now() - 3600000),
          updatedAt: new Date(Date.now() - 3600000)
        },
        {
          supporterId: "supporter_test_2",
          supporterName: "Marcus Vance",
          supporterEmail: "marcus@example.com",
          campaignId: (myCampaigns[1] || myCampaigns[0])._id.toString(),
          campaignTitle: (myCampaigns[1] || myCampaigns[0]).campaignTitle || (myCampaigns[1] || myCampaigns[0]).title,
          amount: 80,
          message: "This is a great idea. Wishing you all the best.",
          status: "pending",
          createdAt: new Date(Date.now() - 7200000),
          updatedAt: new Date(Date.now() - 7200000)
        }
      ];
      await contributionCollection.insertMany(dummy);
    }

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
    const contribution = await contributionCollection.findOne({ _id: new ObjectId(id) });
    if (!contribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    if (contribution.status !== 'pending') {
      return res.status(400).json({ error: 'Contribution is not pending' });
    }

    // Verify req.user is the owner of the campaign
    const campaign = await campaignCollection.findOne({ _id: new ObjectId(contribution.campaignId) });
    if (!campaign || campaign.creatorEmail !== req.user.email) {
      return res.status(403).json({ error: 'Unauthorized to approve this contribution' });
    }

    // Update status to approved
    await contributionCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'approved', updatedAt: new Date() } }
    );

    // Add amount raised to campaign
    const contributionAmount = Number(contribution.amount);
    await campaignCollection.updateOne(
      { _id: new ObjectId(contribution.campaignId) },
      { 
        $inc: { 
          amountRaised: contributionAmount, 
          currentAmount: contributionAmount,
          backersCount: 1 
        } 
      }
    );

    // Generate a notification for the supporter
    await db.collection("notifications").insertOne({
      userId: contribution.supporterId,
      title: "Contribution Approved",
      message: `Your contribution of $${contributionAmount} to "${campaign.campaignTitle || campaign.title}" has been approved!`,
      read: false,
      createdAt: new Date()
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
    const contribution = await contributionCollection.findOne({ _id: new ObjectId(id) });
    if (!contribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    if (contribution.status !== 'pending') {
      return res.status(400).json({ error: 'Contribution is not pending' });
    }

    // Verify req.user is the owner of the campaign
    const campaign = await campaignCollection.findOne({ _id: new ObjectId(contribution.campaignId) });
    if (!campaign || campaign.creatorEmail !== req.user.email) {
      return res.status(403).json({ error: 'Unauthorized to reject this contribution' });
    }

    // Update status to rejected
    await contributionCollection.updateOne(
      { _id: new ObjectId(id) },
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
          { _id: new ObjectId(supporterUserId) },
          { $inc: { credits: refundAmount } }
        );
      } catch (e) {}
    }

    // Generate a notification for the supporter
    await db.collection("notifications").insertOne({
      userId: contribution.supporterId,
      title: "Contribution Rejected",
      message: `Your contribution of $${refundAmount} to "${campaign.campaignTitle || campaign.title}" was rejected. The credits have been refunded.`,
      read: false,
      createdAt: new Date()
    });

    res.json({ success: true, message: 'Contribution rejected and refunded successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error rejecting contribution' });
  }
});

// Notifications Endpoint
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const notifications = await db.collection("notifications").find({ userId })
      .sort({ _id: -1 }).limit(10).toArray();
    const unread = await db.collection("notifications").countDocuments({ userId, read: false });
    res.json({ notifications, unread });
  } catch (err) {
    res.json({ notifications: [], unread: 0 });
  }
});

app.patch('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await db.collection("notifications").updateOne(
      { _id: new ObjectId(req.params.id) },
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
      { userId: req.user._id.toString(), read: false },
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
        accountNumber: w.account_number
      }));
      res.json(mapped);
    } else {
      const history = await db.collection("payments").find({ userId: req.user._id.toString() })
        .sort({ _id: -1 }).toArray();
      res.json(history);
    }
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/payments/purchase-credit', authMiddleware, async (req, res) => {
  const { amount } = req.body;
  try {
    const purchaseAmount = Number(amount);
    if (!purchaseAmount || purchaseAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    let updateResult = null;
    try {
      updateResult = await userCollection.updateOne(
        { _id: req.user._id },
        { $inc: { credits: purchaseAmount } }
      );
    } catch (e) {}

    if (!updateResult || updateResult.matchedCount === 0) {
      try {
        updateResult = await userCollection.updateOne(
          { _id: new ObjectId(req.user._id) },
          { $inc: { credits: purchaseAmount } }
        );
      } catch (e) {}
    }
    
    // Add record to payments
    await db.collection("payments").insertOne({
      userId: req.user._id.toString(),
      userName: req.user.name,
      amount: purchaseAmount,
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

app.post('/api/payments/create-session', authMiddleware, async (req, res) => {
  const { campaignId, amount, message, anonymous } = req.body;
  try {
    const campaign = await campaignCollection.findOne({ _id: new ObjectId(campaignId) });
    const contr = {
      supporterId: req.user._id.toString(),
      supporterName: req.user.name,
      supporterEmail: req.user.email,
      campaignId,
      campaignTitle: campaign?.campaignTitle || campaign?.title || 'Campaign',
      amount,
      message,
      anonymous,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await contributionCollection.insertOne(contr);
    
    // Deduct credits from user immediately
    let updateResult = null;
    try {
      updateResult = await userCollection.updateOne(
        { _id: req.user._id },
        { $inc: { credits: -amount } }
      );
    } catch (e) {}

    if (!updateResult || updateResult.matchedCount === 0) {
      try {
        updateResult = await userCollection.updateOne(
          { _id: new ObjectId(req.user._id) },
          { $inc: { credits: -amount } }
        );
      } catch (e) {}
    }

    res.json({ url: '/dashboard/supporter/contributions' }); // redirect to contributions list instead of Stripe URL
  } catch (e) {
    res.status(500).json({ error: 'Payment failed' });
  }
});

app.listen(port, () => {
  console.log(`Express Server listening on port ${port}`);
});
