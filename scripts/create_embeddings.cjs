require("dotenv").config();
const { MongoClient } = require("mongodb");
const { Configuration, OpenAIApi } = require("openai");

// MongoDB and OpenAI configuration from .env
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.DATABASE_NAME || "product_search";
const collectionName = process.env.COLLECTION_NAME || "products";
const openaiApiKey = process.env.OPENAI_API_KEY;

// Validate environment variables
if (!mongoUri || !databaseName || !collectionName || !openaiApiKey) {
  console.error("Missing required environment variables. Check your .env file.");
  process.exit(1);
}

// Initialize OpenAI API client
const configuration = new Configuration({
  apiKey: openaiApiKey,
});
const openai = new OpenAIApi(configuration);

// MongoDB client
const client = new MongoClient(mongoUri);

async function generateEmbedding(text) {
  try {
    const response = await openai.createEmbedding({
      model: "text-embedding-ada-002", // Use the correct model for embeddings
      input: text,
    });
    return response.data.data[0].embedding;
  } catch (error) {
    console.error("Error generating embedding for text:", text, error.message);
    throw error;
  }
}

async function updateEmbeddings() {
  try {
    // Connect to MongoDB
    await client.connect();
    console.log("Connected to MongoDB");

    const collection = client.db(databaseName).collection(collectionName);

    // Fetch documents without title_embedding field
    const cursor = collection.find({ title_embedding: { $exists: false } });
    let count = 0;

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      console.log(`Processing document with _id: ${doc._id}`);

      const title = doc.title;
      if (!title) {
        console.warn(`Skipping document with _id: ${doc._id} (no title)`);
        continue;
      }

      try {
        // Generate embedding for the document's title
        const embedding = await generateEmbedding(title);
        console.log(`Generated embedding for title: "${title}"`);

        // Update the document with the new embedding
        await collection.updateOne(
          { _id: doc._id },
          { $set: { title_embedding: embedding } }
        );

        console.log(`Updated document with _id: ${doc._id}`);
        count++;
      } catch (embeddingError) {
        console.error(`Error processing document with _id: ${doc._id}`, embeddingError.message);
      }
    }

    console.log(`Finished processing ${count} documents.`);
  } catch (error) {
    console.error("Error in updateEmbeddings:", error.message);
  } finally {
    // Ensure MongoDB connection is closed
    await client.close();
    console.log("MongoDB connection closed");
  }
}

// Execute the update
updateEmbeddings();
