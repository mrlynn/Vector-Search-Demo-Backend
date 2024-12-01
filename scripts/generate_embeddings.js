import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// Load environment variables
const { MONGODB_URI, OPENAI_API_KEY } = process.env;

if (!MONGODB_URI || !OPENAI_API_KEY) {
    console.error('Error: Missing MONGODB_URI or OPENAI_API_KEY in .env file.');
    process.exit(1);
}

// Initialize OpenAI and MongoDB clients
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const client = new MongoClient(MONGODB_URI);

const dbName = 'product_search';
const collectionName = 'products';

async function generateEmbedding(text) {
    try {
        const response = await openai.embeddings.create({
            model: 'text-embedding-ada-002', // Adjust model as needed
            input: text,
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding:', error.message);
        throw error;
    }
}

async function updateEmbeddings() {
    try {
        // Connect to MongoDB
        await client.connect();
        console.log('Connected to MongoDB.');

        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        // Fetch all documents from the collection
        const cursor = collection.find({});
        let count = 0;

        for await (const doc of cursor) {
            const { _id, title, description, category } = doc;

            if (!title && !description && !category) {
                console.warn(`Skipping document with _id ${_id}: Missing fields for embedding.`);
                continue;
            }

            // Combine relevant fields for embedding
            const textForEmbedding = `${title || ''} ${description || ''} ${category || ''}`.trim();
            console.log(`Generating embedding for document ${_id}: "${textForEmbedding}"`);

            try {
                // Generate embedding
                const embedding = await generateEmbedding(textForEmbedding);

                // Update the document with the new embedding
                await collection.updateOne(
                    { _id },
                    { $set: { description_embedding: embedding } }
                );
                console.log(`Updated embedding for document ${_id}.`);
                count++;
            } catch (error) {
                console.error(`Failed to update embedding for document ${_id}:`, error.message);
            }
        }

        console.log(`Embedding update completed. Total documents updated: ${count}`);
    } catch (error) {
        console.error('Error during embedding update:', error.message);
    } finally {
        // Ensure the client is closed
        await client.close();
        console.log('MongoDB connection closed.');
    }
}

// Run the embedding update process
updateEmbeddings().catch(console.error);
