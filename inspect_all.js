const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGODB_URI;

async function run() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    console.log("Connected. Databases:");
    const dbs = await client.db().admin().listDatabases();
    for (const d of dbs.databases) {
      console.log(`\n=== ${d.name} (${Math.round(d.sizeOnDisk / 1024)} KB) ===`);
      const db = client.db(d.name);
      const cols = await db.listCollections().toArray();
      for (const c of cols) {
        const count = await db.collection(c.name).countDocuments();
        console.log(`  - ${c.name}: ${count}`);
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
  } finally {
    await client.close();
  }
}

run();
