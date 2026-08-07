const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGODB_URI;

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    const db = client.db("crowdfunding");
    const collections = await db.listCollections().toArray();
    console.log("Collections:");
    for (let col of collections) {
      console.log(` - ${col.name}`);
      const count = await db.collection(col.name).countDocuments();
      console.log(`   Count: ${count}`);
      if (count > 0) {
        const samples = await db.collection(col.name).find().limit(2).toArray();
        console.log(`   Samples:`, JSON.stringify(samples, null, 2));
      }
    }
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
  } finally {
    await client.close();
  }
}

run();
