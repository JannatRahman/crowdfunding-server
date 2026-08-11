const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGODB_URI;

async function run() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db('crowdfunding');
    const campaigns = await db.collection('campaigns').find().sort({ _id: 1 }).toArray();
    console.log(`Total campaigns: ${campaigns.length}`);
    const now = new Date();
    let ended = 0;
    for (const c of campaigns) {
      const endDate = c.endDate || c.deadline;
      const end = endDate ? new Date(endDate) : null;
      const isEnded = !end || isNaN(end.getTime()) || end <= now;
      if (isEnded) ended++;
      console.log(
        `${c._id.toString().slice(-6)} | status=${c.status} | end=${endDate} | ended=${isEnded ? 'YES' : 'no'} | title=${(c.title || c.campaignTitle || '').slice(0, 45)}`
      );
    }
    console.log(`\nEnded: ${ended}/${campaigns.length}`);
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await client.close();
  }
}

run();
