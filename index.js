const express = require('express');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config({ path: path.resolve(__dirname, '../client/.env') });
dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 5000;
const jwtSecret = process.env.JWT_SECRET || process.env.BETTER_AUTH_SECRET || 'momentum-dev-secret';
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_DB_URI;
if (!uri) {
  throw new Error('MONGO_DB_URI is not configured. Check the shared environment file.');
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const toObjectId = id => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const now = () => new Date();
const approvedOpenCampaignQuery = () => ({
  status: 'approved',
  deadline: { $gte: now() },
});

const normalizeCampaign = body => ({
  campaignTitle: body.campaignTitle || body.campaign_title || '',
  campaignStory: body.campaignStory || body.campaign_story || '',
  category: body.category || '',
  fundingGoal: Number(body.fundingGoal || body.funding_goal || 0),
  minimumContribution: Number(body.minimumContribution || body.minimum_Contribution || 0),
  deadline: new Date(body.deadline),
  rewardInfo: body.rewardInfo || body.reward_info || '',
  campaignImage: body.campaignImage || body.campaign_image_url || '',
});

const createNotification = async (notificationsCollection, notification) => {
  await notificationsCollection.insertOne({
    ...notification,
    read: false,
    time: now(),
  });
};

const run = async () => {
  try {
    await client.connect();
    console.log('Mongo Connected');

    const database = client.db('Crowdfunding');
    const usersCollection = database.collection('users');
    const campaignsCollection = database.collection('campaigns');
    const contributionsCollection = database.collection('contributions');
    const withdrawalsCollection = database.collection('withdrawals');
    const paymentsCollection = database.collection('payments');
    const notificationsCollection = database.collection('notifications');
    const reportsCollection = database.collection('reports');

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await campaignsCollection.createIndex({ creatorEmail: 1, deadline: -1 });
    await contributionsCollection.createIndex({ supporterEmail: 1, status: 1 });
    await notificationsCollection.createIndex({ toEmail: 1, time: -1 });

    const verifyToken = (req, res, next) => {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return res.status(401).send({ success: false, message: 'Unauthorized' });
      }

      try {
        req.decoded = jwt.verify(token, jwtSecret);
        next();
      } catch (error) {
        return res.status(401).send({ success: false, message: 'Invalid token' });
      }
    };

    const verifyRole = role => async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      if (!user || user.role !== role) {
        return res.status(403).send({ success: false, message: `${role} access required` });
      }
      req.currentUser = user;
      next();
    };

    const verifySupporter = verifyRole('Supporter');
    const verifyCreator = verifyRole('Creator');
    const verifyAdmin = verifyRole('Admin');

    app.get('/', (req, res) => {
      res.send('Momentum Crowdfunding Backend Server Running');
    });

    app.post('/api/jwt', async (req, res) => {
      const { email } = req.body;
      if (!email) {
        return res.status(400).send({ success: false, message: 'Email is required' });
      }

      const token = jwt.sign({ email }, jwtSecret, { expiresIn: '7d' });
      res.send({ success: true, token });
    });

    app.post('/api/users/register', async (req, res) => {
      const { displayName, name, email, photoURL, image, role = 'Supporter' } = req.body;
      if (!email) {
        return res.status(400).send({ success: false, message: 'Email is required' });
      }

      const safeRole = ['Supporter', 'Creator'].includes(role) ? role : 'Supporter';
      const credits = safeRole === 'Creator' ? 20 : 50;
      const userDoc = {
        displayName: displayName || name || email.split('@')[0],
        email,
        photoURL: photoURL || image || '',
        role: safeRole,
        credits,
        raisedCredits: 0,
        createdAt: now(),
      };

      await usersCollection.updateOne(
        { email },
        { $setOnInsert: userDoc },
        { upsert: true },
      );

      const user = await usersCollection.findOne({ email });
      res.send({ success: true, data: user });
    });

    app.get('/api/users/me', verifyToken, async (req, res) => {
      let user = await usersCollection.findOne({ email: req.decoded.email });
      if (!user) {
        user = {
          displayName: req.decoded.email.split('@')[0],
          email: req.decoded.email,
          photoURL: '',
          role: 'Supporter',
          credits: 50,
          raisedCredits: 0,
          createdAt: now(),
        };
        await usersCollection.insertOne(user);
      }
      res.send({ success: true, data: user });
    });

    app.get('/api/users', verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.find().sort({ createdAt: -1 }).toArray();
      res.send({ success: true, data: users });
    });

    app.patch('/api/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      const { role } = req.body;
      if (!objectId || !['Admin', 'Creator', 'Supporter'].includes(role)) {
        return res.status(400).send({ success: false, message: 'Invalid request' });
      }
      await usersCollection.updateOne({ _id: objectId }, { $set: { role } });
      res.send({ success: true });
    });

    app.delete('/api/users/:id', verifyToken, verifyAdmin, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      if (!objectId) return res.status(400).send({ success: false, message: 'Invalid ID' });
      await usersCollection.deleteOne({ _id: objectId });
      res.send({ success: true });
    });

    app.get('/api/campaigns/top-funded', async (req, res) => {
      const data = await campaignsCollection
        .find({ status: 'approved' })
        .sort({ amountRaised: -1 })
        .limit(6)
        .toArray();
      res.send({ success: true, data });
    });

    app.get('/api/campaigns', async (req, res) => {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 6;
      const category = req.query.category;
      const includeAll = req.query.includeAll === 'true';
      const query = includeAll ? {} : approvedOpenCampaignQuery();

      if (category && category !== 'all') {
        query.category = { $regex: new RegExp(`^${category}$`, 'i') };
      }

      const skip = (page - 1) * limit;
      const totalCampaigns = await campaignsCollection.countDocuments(query);
      const data = await campaignsCollection
        .find(query)
        .sort({ deadline: 1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.send({
        success: true,
        data,
        currentPage: page,
        totalCampaigns,
        totalPages: Math.max(Math.ceil(totalCampaigns / limit), 1),
      });
    });

    app.post('/api/campaigns', verifyToken, verifyCreator, async (req, res) => {
      const campaign = normalizeCampaign(req.body);
      if (!campaign.campaignTitle || !campaign.campaignStory || !campaign.category || !campaign.fundingGoal || !campaign.deadline) {
        return res.status(400).send({ success: false, message: 'Missing required campaign fields' });
      }

      const doc = {
        ...campaign,
        creatorName: req.currentUser.displayName,
        creatorEmail: req.currentUser.email,
        amountRaised: 0,
        status: 'pending',
        createdAt: now(),
      };
      const result = await campaignsCollection.insertOne(doc);
      res.send({ success: true, insertedId: result.insertedId });
    });

    app.get('/api/campaigns/creator/:email', verifyToken, verifyCreator, async (req, res) => {
      if (req.params.email !== req.decoded.email) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
      }
      const data = await campaignsCollection
        .find({ creatorEmail: req.params.email })
        .sort({ deadline: -1 })
        .toArray();
      res.send({ success: true, data });
    });

    app.get('/api/campaigns/:id', async (req, res) => {
      const objectId = toObjectId(req.params.id);
      if (!objectId) return res.status(400).send({ success: false, message: 'Invalid ID' });
      const data = await campaignsCollection.findOne({ _id: objectId });
      if (!data) return res.status(404).send({ success: false, message: 'Campaign not found' });
      res.send({ success: true, data });
    });

    app.patch('/api/campaigns/:id', verifyToken, verifyCreator, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      if (!objectId) return res.status(400).send({ success: false, message: 'Invalid ID' });
      const allowed = {
        campaignTitle: req.body.campaignTitle,
        campaignStory: req.body.campaignStory,
        rewardInfo: req.body.rewardInfo,
      };
      Object.keys(allowed).forEach(key => allowed[key] === undefined && delete allowed[key]);
      const result = await campaignsCollection.updateOne(
        { _id: objectId, creatorEmail: req.decoded.email },
        { $set: allowed },
      );
      res.send({ success: result.matchedCount > 0 });
    });

    app.delete('/api/campaigns/:id', verifyToken, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      if (!objectId) return res.status(400).send({ success: false, message: 'Invalid ID' });
      const campaign = await campaignsCollection.findOne({ _id: objectId });
      if (!campaign) return res.status(404).send({ success: false, message: 'Campaign not found' });
      const user = await usersCollection.findOne({ email: req.decoded.email });
      if (user.role !== 'Admin' && campaign.creatorEmail !== req.decoded.email) {
        return res.status(403).send({ success: false, message: 'Forbidden' });
      }

      const approvedContributions = await contributionsCollection.find({
        campaignId: req.params.id,
        status: 'approved',
      }).toArray();
      for (const contribution of approvedContributions) {
        await usersCollection.updateOne(
          { email: contribution.supporterEmail },
          { $inc: { credits: contribution.contributionAmount } },
        );
      }
      await campaignsCollection.deleteOne({ _id: objectId });
      res.send({ success: true, refunded: approvedContributions.length });
    });

    app.patch('/api/campaigns/:id/status', verifyToken, verifyAdmin, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      const { status } = req.body;
      if (!objectId || !['approved', 'rejected'].includes(status)) {
        return res.status(400).send({ success: false, message: 'Invalid status' });
      }
      const campaign = await campaignsCollection.findOne({ _id: objectId });
      await campaignsCollection.updateOne({ _id: objectId }, { $set: { status } });
      if (campaign) {
        await createNotification(notificationsCollection, {
          message: `Your campaign "${campaign.campaignTitle}" was ${status} by admin`,
          toEmail: campaign.creatorEmail,
          actionRoute: '/dashboard/my-campaigns',
        });
      }
      res.send({ success: true });
    });

    app.get('/api/contributions', verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      let query = {};
      if (user.role === 'Supporter') query.supporterEmail = user.email;
      if (user.role === 'Creator') query.creatorEmail = user.email;
      if (req.query.status) query.status = req.query.status;

      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 10;
      const skip = (page - 1) * limit;
      const total = await contributionsCollection.countDocuments(query);
      const data = await contributionsCollection.find(query).sort({ currentDate: -1 }).skip(skip).limit(limit).toArray();
      res.send({ success: true, data, totalPages: Math.max(Math.ceil(total / limit), 1) });
    });

    app.post('/api/contributions', verifyToken, verifySupporter, async (req, res) => {
      const { campaignId, contributionAmount, message = '' } = req.body;
      const amount = Number(contributionAmount);
      const objectId = toObjectId(campaignId);
      if (!objectId || !amount || amount <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid contribution' });
      }

      const campaign = await campaignsCollection.findOne({ _id: objectId });
      if (!campaign || campaign.status !== 'approved' || new Date(campaign.deadline) < now()) {
        return res.status(400).send({ success: false, message: 'Campaign is not open' });
      }
      if (amount < Number(campaign.minimumContribution || 0)) {
        return res.status(400).send({ success: false, message: 'Minimum contribution not met' });
      }
      if (req.currentUser.credits < amount) {
        return res.status(400).send({ success: false, message: 'Insufficient credits' });
      }

      await usersCollection.updateOne({ email: req.currentUser.email }, { $inc: { credits: -amount } });
      await contributionsCollection.insertOne({
        campaignId,
        campaignTitle: campaign.campaignTitle,
        contributionAmount: amount,
        supporterEmail: req.currentUser.email,
        supporterName: req.currentUser.displayName,
        creatorName: campaign.creatorName,
        creatorEmail: campaign.creatorEmail,
        message,
        currentDate: now(),
        status: 'pending',
      });
      await createNotification(notificationsCollection, {
        message: `${req.currentUser.displayName} contributed ${amount} credits to ${campaign.campaignTitle}`,
        toEmail: campaign.creatorEmail,
        actionRoute: '/dashboard/creator-home',
      });
      res.send({ success: true });
    });

    app.patch('/api/contributions/:id/status', verifyToken, verifyCreator, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      const { status } = req.body;
      if (!objectId || !['approved', 'rejected'].includes(status)) {
        return res.status(400).send({ success: false, message: 'Invalid status' });
      }

      const contribution = await contributionsCollection.findOne({ _id: objectId, creatorEmail: req.decoded.email });
      if (!contribution || contribution.status !== 'pending') {
        return res.status(404).send({ success: false, message: 'Pending contribution not found' });
      }

      await contributionsCollection.updateOne({ _id: objectId }, { $set: { status } });
      if (status === 'approved') {
        await campaignsCollection.updateOne(
          { _id: toObjectId(contribution.campaignId) },
          { $inc: { amountRaised: contribution.contributionAmount } },
        );
        await usersCollection.updateOne(
          { email: contribution.creatorEmail },
          { $inc: { raisedCredits: contribution.contributionAmount } },
        );
      } else {
        await usersCollection.updateOne(
          { email: contribution.supporterEmail },
          { $inc: { credits: contribution.contributionAmount } },
        );
      }

      await createNotification(notificationsCollection, {
        message: `Your Contribution of ${contribution.contributionAmount} credits to ${contribution.campaignTitle} was ${status} by ${contribution.creatorName}`,
        toEmail: contribution.supporterEmail,
        actionRoute: '/dashboard/supporter-home',
      });
      res.send({ success: true });
    });

    app.get('/api/stats', verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      if (user.role === 'Creator') {
        const campaigns = await campaignsCollection.find({ creatorEmail: user.email }).toArray();
        return res.send({
          success: true,
          data: {
            campaignCount: campaigns.length,
            activeCampaigns: campaigns.filter(c => new Date(c.deadline) >= now()).length,
            totalRaised: campaigns.reduce((sum, c) => sum + Number(c.amountRaised || 0), 0),
          },
        });
      }
      if (user.role === 'Admin') {
        const supporters = await usersCollection.countDocuments({ role: 'Supporter' });
        const creators = await usersCollection.countDocuments({ role: 'Creator' });
        const creditAgg = await usersCollection.aggregate([{ $group: { _id: null, total: { $sum: '$credits' } } }]).toArray();
        const payments = await paymentsCollection.countDocuments({ status: 'approved' });
        return res.send({ success: true, data: { supporters, creators, totalCredits: creditAgg[0]?.total || 0, payments } });
      }
      const contributions = await contributionsCollection.find({ supporterEmail: user.email }).toArray();
      res.send({
        success: true,
        data: {
          contributionCount: contributions.length,
          pendingContributions: contributions.filter(c => c.status === 'pending').length,
          approvedAmount: contributions.filter(c => c.status === 'approved').reduce((sum, c) => sum + Number(c.contributionAmount || 0), 0),
        },
      });
    });

    app.post('/api/withdrawals', verifyToken, verifyCreator, async (req, res) => {
      const withdrawalCredit = Number(req.body.withdrawalCredit);
      if (withdrawalCredit < 200 || withdrawalCredit > Number(req.currentUser.raisedCredits || 0)) {
        return res.status(400).send({ success: false, message: 'Insufficient credit' });
      }
      const doc = {
        creatorEmail: req.currentUser.email,
        creatorName: req.currentUser.displayName,
        withdrawalCredit,
        withdrawalAmount: withdrawalCredit / 20,
        paymentSystem: req.body.paymentSystem,
        accountNumber: req.body.accountNumber,
        withdrawDate: now(),
        status: 'pending',
      };
      await withdrawalsCollection.insertOne(doc);
      res.send({ success: true });
    });

    app.get('/api/withdrawals', verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      const query = user.role === 'Admin' ? {} : { creatorEmail: user.email };
      if (req.query.status) query.status = req.query.status;
      const data = await withdrawalsCollection.find(query).sort({ withdrawDate: -1 }).toArray();
      res.send({ success: true, data });
    });

    app.patch('/api/withdrawals/:id/approve', verifyToken, verifyAdmin, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      const withdrawal = await withdrawalsCollection.findOne({ _id: objectId, status: 'pending' });
      if (!withdrawal) return res.status(404).send({ success: false, message: 'Request not found' });
      await withdrawalsCollection.updateOne({ _id: objectId }, { $set: { status: 'approved' } });
      await usersCollection.updateOne({ email: withdrawal.creatorEmail }, { $inc: { raisedCredits: -withdrawal.withdrawalCredit } });
      await createNotification(notificationsCollection, {
        message: `Your withdrawal request for $${withdrawal.withdrawalAmount} was approved`,
        toEmail: withdrawal.creatorEmail,
        actionRoute: '/dashboard/payment-history',
      });
      res.send({ success: true });
    });

    app.post('/api/payments/create-intent', verifyToken, verifySupporter, async (req, res) => {
      const { credits, price } = req.body;
      if (!stripe) {
        return res.send({ success: true, dummy: true, clientSecret: 'dummy-payment' });
      }
      const intent = await stripe.paymentIntents.create({
        amount: Number(price) * 100,
        currency: 'usd',
        metadata: { email: req.currentUser.email, credits: String(credits) },
      });
      res.send({ success: true, clientSecret: intent.client_secret });
    });

    app.post('/api/payments/confirm', verifyToken, verifySupporter, async (req, res) => {
      const credits = Number(req.body.credits);
      const price = Number(req.body.price);
      if (!credits || !price) return res.status(400).send({ success: false, message: 'Invalid package' });
      await paymentsCollection.insertOne({
        supporterEmail: req.currentUser.email,
        supporterName: req.currentUser.displayName,
        credits,
        price,
        transactionId: req.body.transactionId || `dummy-${Date.now()}`,
        date: now(),
        status: 'approved',
      });
      await usersCollection.updateOne({ email: req.currentUser.email }, { $inc: { credits } });
      res.send({ success: true });
    });

    app.get('/api/payments', verifyToken, async (req, res) => {
      const user = await usersCollection.findOne({ email: req.decoded.email });
      const data = await paymentsCollection
        .find(user.role === 'Admin' ? {} : { supporterEmail: user.email })
        .sort({ date: -1 })
        .toArray();
      res.send({ success: true, data });
    });

    app.post('/api/reports', verifyToken, verifySupporter, async (req, res) => {
      const objectId = toObjectId(req.body.campaignId);
      const campaign = await campaignsCollection.findOne({ _id: objectId });
      if (!campaign) return res.status(404).send({ success: false, message: 'Campaign not found' });
      await reportsCollection.insertOne({
        reporterName: req.currentUser.displayName,
        reporterEmail: req.currentUser.email,
        campaignId: req.body.campaignId,
        campaignTitle: campaign.campaignTitle,
        reason: req.body.reason,
        date: now(),
        status: 'open',
      });
      res.send({ success: true });
    });

    app.get('/api/reports', verifyToken, verifyAdmin, async (req, res) => {
      const data = await reportsCollection.find().sort({ date: -1 }).toArray();
      res.send({ success: true, data });
    });

    app.get('/api/notifications', verifyToken, async (req, res) => {
      const data = await notificationsCollection
        .find({ toEmail: req.decoded.email })
        .sort({ time: -1 })
        .limit(20)
        .toArray();
      res.send({ success: true, data });
    });

    app.patch('/api/notifications/:id/read', verifyToken, async (req, res) => {
      const objectId = toObjectId(req.params.id);
      await notificationsCollection.updateOne(
        { _id: objectId, toEmail: req.decoded.email },
        { $set: { read: true } },
      );
      res.send({ success: true });
    });

    app.get('/api/funded/data', async (req, res) => {
      const data = await campaignsCollection.find({ status: 'approved' }).sort({ amountRaised: -1 }).limit(6).toArray();
      res.status(200).send(data);
    });

    app.get('/api/all/data', async (req, res) => {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 6;
      const category = req.query.category;
      const query = approvedOpenCampaignQuery();
      if (category && category !== 'all') {
        query.category = { $regex: new RegExp(`^${category}$`, 'i') };
      }
      const skip = (page - 1) * limit;
      const totalCampaigns = await campaignsCollection.countDocuments(query);
      const data = await campaignsCollection.find(query).skip(skip).limit(limit).toArray();
      res.status(200).send({ success: true, data, currentPage: page, totalCampaigns, totalPages: Math.max(Math.ceil(totalCampaigns / limit), 1) });
    });

    app.get('/api/details/:id', async (req, res) => {
      const objectId = toObjectId(req.params.id);
      if (!objectId) return res.status(400).send({ success: false, message: 'Invalid ID format' });
      const data = await campaignsCollection.findOne({ _id: objectId });
      if (!data) return res.status(404).send({ success: false, message: 'Data not found!' });
      res.status(200).send({ success: true, data });
    });

    await client.db('admin').command({ ping: 1 });
    console.log('Pinged your deployment successfully!');
  } catch (error) {
    console.error(error);
  }
};

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Momentum backend listening on port ${port}`);
});
