const express = require('express');
const cors = require('cors');
const app = express()
const port = process.env.PORT || 5000
require('dotenv').config();

app.use(cors());
app.use(express.json());


const { MongoClient, ServerApiVersion } = require('mongodb');

app.get('/', (req, res) => {
  res.send('Hello World!')
})



const uri = process.env.MONGODB_URI


const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
   
    await client.connect();

    const database = client.db("crowdfunding");
    const campaignCollection = database.collection("campaigns");

    app.get('/campaigns', async (req, res) => {
      const campaigns = await campaignCollection.find({}).toArray();
      res.json(campaigns);
    });
    
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    
    // await client.close();
  }
}
run().catch(console.dir);



app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})




// const express = require('express');
// const cors = require('cors');
// require('dotenv').config();



// const campaignRoutes = require('./routes/campaigns');
// const contributionRoutes = require('./routes/contributions');
// const withdrawalRoutes = require('./routes/withdrawals');
// const paymentRoutes = require('./routes/payments');
// const notificationRoutes = require('./routes/notifications');
// const reportRoutes = require('./routes/reports');
// const adminRoutes = require('./routes/admin');

// const app = express();
// const port = process.env.PORT || 5000;

// app.use(cors({
//   origin: process.env.CLIENT_URL || 'http://localhost:3000',
//   credentials: true,
// }));
// app.use(express.json());

// app.get('/', (req, res) => {
//   res.send('Crowdfunding API is running!');
// });

// app.use('/api/campaigns', campaignRoutes);
// app.use('/api/contributions', contributionRoutes);
// app.use('/api/withdrawals', withdrawalRoutes);
// app.use('/api/payments', paymentRoutes);
// app.use('/api/notifications', notificationRoutes);
// app.use('/api/reports', reportRoutes);
// app.use('/api/admin', adminRoutes);



// connectDB().then(() => {
//   app.listen(port, () => {
//     console.log(`Server running on port ${port}`);
//   });
// }).catch(console.dir);
