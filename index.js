const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

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
    const productsCollection = database.collection("campaigns")


    // Home Route
    app.get("/", (req, res) => {
      res.send("🚀 E-commerce Backend Server Running");
    });

    // get funded crowdfunding data

    app.get("/api/funded/data", async (req, res) => {
      try {
        const data = await productsCollection.find().sort({ amountRaised: -1 }).limit(6).toArray()

        if (!data || data.length === 0) {
          return res.status(404).send({ success: false, message: "No data found!" });
        }


        res.status(200).send(data)

      } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).send({
          success: false,
          message: "Internal Server Error",
          error: error.message
        });
      }
    })



    // get all data api created
    app.get("/api/all/data", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 6;
        const category = req.query.category;


        let query = {};
        if (category && category !== 'all') {

          query.category = { $regex: new RegExp(`^${category}$`, 'i') };
        }

        const skip = (page - 1) * limit;

        const totalCampaigns = await productsCollection.countDocuments(query);
        const totalPages = Math.ceil(totalCampaigns / limit);

        const data = await productsCollection
          .find(query)
          .skip(skip)
          .limit(limit)
          .toArray();

        res.status(200).send({
          success: true,
          data,
          currentPage: page,
          totalCampaigns,
          totalPages
        });

      } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).send({
          success: false,
          message: "Internal Server Error",
          error: error.message
        });
      }
    });
    // get single data api

    app.get("/api/details/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ success: false, message: "Invalid ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const data = await productsCollection.findOne(query);

        if (!data) {
          return res.status(404).send({ success: false, message: "Data not found!" });
        }

        res.status(200).send({
          success: true,
          data: data
        })

      } catch (error) {
        console.error("Error fetching data:", error);
        res.status(500).send({
          success: false,
          message: "Internal Server Error",
          error: error.message
        });
      }
    })

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