import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import multer from 'multer';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const client = new MongoClient(process.env.MONGODB_URI);
const dbName = "product_search";
const collectionName = "products";

// Search endpoint with multiple search types
app.post('/api/search', upload.single('image'), async (req, res) => {
  const startTime = performance.now();
  try {
    const searchType = req.body.type;
    const collection = client.db(dbName).collection(collectionName);
    let results = [];

    switch (searchType) {
      case 'basic': {
        // Basic MongoDB find with regex
        const query = req.body.query;
        results = await collection.find({
          $or: [
            { title: { $regex: query, $options: 'i' } },
            { description: { $regex: query, $options: 'i' } },
            { category: { $regex: query, $options: 'i' } }
          ]
        }).limit(10).toArray();
        break;
      }

      case 'atlas': {
        // Atlas Search with text score
        results = await collection.aggregate([
          {
            $search: {
              text: {
                query: req.body.query,
                path: ["title", "description", "category"],
                fuzzy: {
                  maxEdits: 1,
                  prefixLength: 3
                }
              }
            }
          },
          {
            $addFields: {
              score: { $meta: "searchScore" }
            }
          },
          { $limit: 10 }
        ]).toArray();
        break;
      }

      case 'vector': {
        // Standard vector search
        const embedding = await generateEmbedding(req.body.query);
        results = await collection.aggregate([
          {
            $vectorSearch: {
              queryVector: embedding,
              path: "description_embedding",
              numCandidates: 100,
              limit: 10,
              index: "vector_index",
            }
          },
          {
            $addFields: {
              score: { $meta: "vectorSearchScore" }
            }
          }
        ]).toArray();
        break;
      }

      case 'semantic': {
        // Semantic search with GPT enhancement
        const enhancedQuery = await enhanceQueryWithGPT(req.body.query);
        const embedding = await generateEmbedding(enhancedQuery);
        results = await collection.aggregate([
          {
            $vectorSearch: {
              queryVector: embedding,
              path: "description_embedding",
              numCandidates: 100,
              limit: 10,
              index: "vector_index",
            }
          },
          {
            $addFields: {
              score: { $meta: "vectorSearchScore" }
            }
          }
        ]).toArray();
        break;
      }

      case 'image': {
        if (!req.file) {
          throw new Error('No image file provided');
        }
        const imageDescription = await processImage(req.file.buffer);
        const embedding = await generateEmbedding(imageDescription);
        results = await collection.aggregate([
          {
            $vectorSearch: {
              queryVector: embedding,
              path: "description_embedding",
              numCandidates: 100,
              limit: 10,
              index: "vector_index",
            }
          },
          {
            $addFields: {
              score: { $meta: "vectorSearchScore" }
            }
          }
        ]).toArray();
        break;
      }

      default:
        throw new Error('Invalid search type');
    }

    const endTime = performance.now();
    
    res.json({
      results: results.map(result => ({
        ...result,
        score: result.score ? Math.min(Math.max(result.score, 0), 1) : undefined
      })),
      searchTime: (endTime - startTime).toFixed(2)
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Search failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Helper functions

async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return response.data[0].embedding;
}

app.get('/api/data', async (req, res) => {
    try {
      const collection = client.db(dbName).collection(collectionName);
      const data = await collection.find({}).toArray();
      console.log(data);
      res.json(data);
    } catch (error) {
      console.error('Error fetching data:', error);
      res.status(500).json({
        error: 'Failed to fetch data',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
async function enhanceQueryWithGPT(query) {
    const completion = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",  // Updated model name
      messages: [
        {
          role: "system",
          content: "Convert the user's search query into a detailed product description that captures the semantic meaning. Focus on physical attributes, use cases, and key features."
        },
        {
          role: "user",
          content: query
        }
      ],
      max_tokens: 150
    });
    
    console.log('Enhanced query:', completion.choices[0].message.content);
    return completion.choices[0].message.content;
  }
  
  async function processImage(imageBuffer) {
    const base64Image = imageBuffer.toString('base64');
    
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4-vision-preview-1106",  // Updated model name
        messages: [
          {
            role: "user",
            content: [
              { 
                type: "text", 
                text: "Describe this product image in detail, focusing on visual characteristics, style, colors, and features that would be relevant for product search." 
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`
                }
              }
            ],
          },
        ],
        max_tokens: 300
      });
  
      console.log('Image description:', response.choices[0].message.content);
      return response.choices[0].message.content;
    } catch (error) {
      console.error('Error processing image:', error);
      throw error;
    }
  }
  
  // Initialize MongoDB connection and indexes
  async function initializeDB() {
    try {
      await client.connect();
      console.log("Connected to MongoDB");
  
      const db = client.db(dbName);
      const collection = db.collection(collectionName);
  
      // Test the connection
      await collection.findOne({});
      console.log("Successfully connected to collection");
  
      // Create indexes for different search types
      const indexes = await collection.listIndexes().toArray();
      
      // Basic search indexes
      if (!indexes.some(index => index.name === "text_search_idx")) {
        await collection.createIndex(
          { title: 1, description: 1, category: 1 },
          { name: "text_search_idx" }
        );
        console.log("Created basic search indexes");
      }
  
      // Atlas Search index
      const searchIndexes = await collection.listSearchIndexes().toArray();
      const atlasSearchExists = searchIndexes.some(index => index.name === "atlas_search_idx");
      
      if (!atlasSearchExists) {
        const atlasIndex = {
          name: "atlas_search_idx",
          definition: {
            mappings: {
              dynamic: false,
              fields: {
                title: {
                  type: "string",
                  analyzer: "lucene.standard"
                },
                description: {
                  type: "string",
                  analyzer: "lucene.standard"
                },
                category: {
                  type: "string",
                  analyzer: "lucene.standard"
                }
              }
            }
          }
        };
  
        try {
          await collection.createSearchIndex(atlasIndex);
          console.log("Created Atlas Search index");
        } catch (error) {
          console.warn("Warning: Atlas Search index creation failed:", error.message);
        }
      }
  
      // Vector search index
      const vectorIndexExists = searchIndexes.some(index => index.name === "vector_index");
      
      if (!vectorIndexExists) {
        const vectorIndex = {
          name: "vector_index",
          type: "vectorSearch",
          definition: {
            fields: [{
              type: "vector",
              numDimensions: 1536,
              path: "description_embedding",
              similarity: "cosine"
            }]
          }
        };
  
        try {
          await collection.createSearchIndex(vectorIndex);
          console.log("Created vector search index");
        } catch (error) {
          console.warn("Warning: Vector search index creation failed:", error.message);
        }
      }
  
      return true;
    } catch (error) {
      console.error('DB initialization error:', error);
      return false;
    }
  }
  
  // Add sample data if collection is empty
  async function seedSampleData() {
    const collection = client.db(dbName).collection(collectionName);
    const count = await collection.countDocuments();
    
    if (count === 0) {
      console.log("Seeding sample data...");
      
      const sampleProducts = [
        {
          title: "Professional DSLR Camera",
          description: "High-end digital camera with 24MP sensor, 4K video capabilities, and weather-sealed body",
          category: "Electronics",
          price: 1299.99,
          image: "/api/placeholder/400/400"
        },
        {
          title: "Ergonomic Office Chair",
          description: "Adjustable office chair with lumbar support, mesh back, and premium cushioning",
          category: "Furniture",
          price: 299.99,
          image: "/api/placeholder/400/400"
        },
        // Add more sample products as needed
      ];
  
      // Generate embeddings for sample products
      for (const product of sampleProducts) {
        const embedding = await generateEmbedding(
          `${product.title} ${product.description} ${product.category}`
        );
        product.description_embedding = embedding;
      }
  
      await collection.insertMany(sampleProducts);
      console.log(`Inserted ${sampleProducts.length} sample products`);
    }
  }
  
  // Start server
  const PORT = process.env.PORT || 3003;
  
  async function startServer() {
    try {
      const dbInitialized = await initializeDB();
      if (dbInitialized) {
        await seedSampleData();
        
        app.listen(PORT, () => {
          console.log(`Server running on port ${PORT}`);
          console.log(`Health check available at http://localhost:${PORT}/health`);
        });
      } else {
        console.error('Failed to initialize database. Server not started.');
        process.exit(1);
      }
    } catch (error) {
      console.error('Server startup error:', error);
      process.exit(1);
    }
  }
  
  // Health check endpoint
  app.get('/health', async (req, res) => {
    try {
      const dbStatus = await client.db(dbName).command({ ping: 1 });
      res.json({ 
        status: 'ok',
        mongodb: dbStatus.ok === 1 ? 'connected' : 'disconnected',
        search_types: ['basic', 'atlas', 'vector', 'semantic', 'image']
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        mongodb: 'disconnected',
        error: error.message
      });
    }
  });
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await client.close();
    process.exit(0);
  });
  
  startServer().catch(console.error);