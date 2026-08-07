const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGODB_URI;

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db("crowdfunding");
    const result = await db.collection("user").updateOne(
      { email: "jannatrahman1290@gmail.com" },
      { $set: { role: "creator", credits: 500 } }
    );
    console.log("Update result:", result);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await client.close();
  }
}

run();
