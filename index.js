const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
})

const run = async () => {
  try {

    await client.connect();
    console.log('Mongo Connected');

    const database = client.db("Crowdfunding");
    const productsCollection = database.collection("crowdfundingCollction")


    // Home Route
    app.get("/", (req, res) => {
      res.send("🚀 E-commerce Backend Server Running");
    });

    await client.db("admin").command({ ping: 1 });
    console.log("✅ Pinged your deployment successfully!");

  }
  catch (error) {
    res.status(500).send({
      success: false,
      message: error.message,
    });
  }
}

run().catch(console.dir);




app.listen(port, () => {
  console.log('Example app listening of port', port)
})