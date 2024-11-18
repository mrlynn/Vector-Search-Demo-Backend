import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import multer from 'multer';
import cors from 'cors';

dotenv.config();

const app = express();

app.use((req, res, next) => {
    // Log incoming requests for debugging
    console.log('Incoming request:', req.method, req.path, req.headers.origin);
    next();
  });
// Updated CORS configuration
app.use(cors({
    origin: ['https://vector-search-demo-frontend.vercel.app', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    optionsSuccessStatus: 200,
    credentials: true
  }));

app.use(express.json());

app.options('*', cors()); // Enable pre-flight for all routes

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
const debugAtlasSearch = async (collection, pipeline) => {
    try {
        // Check if index exists
        const indexes = await collection.listSearchIndexes().toArray();
        const advancedIndex = indexes.find(idx => idx.name === 'advanced');

        if (!advancedIndex) {
            console.error('Advanced search index not found! Available indexes:',
                indexes.map(idx => idx.name));
            return false;
        }

        console.log('Advanced index configuration:', JSON.stringify(advancedIndex, null, 2));

        // Test the pipeline
        const explain = await collection.aggregate([
            ...pipeline,
            { $explain: true }
        ]).toArray();

        console.log('Pipeline explanation:', JSON.stringify(explain, null, 2));
        return true;
    } catch (error) {
        console.error('Atlas Search debug error:', error);
        return false;
    }
};

async function updateDocumentsWithSearchableTitle() {
    const collection = client.db(dbName).collection(collectionName);
    const cursor = collection.find({});

    for await (const doc of cursor) {
        await collection.updateOne(
            { _id: doc._id },
            {
                $set: {
                    searchableTitle: doc.title
                }
            }
        );
    }
    console.log('Updated all documents with searchableTitle field');
}
// Search endpoint with multiple search types
app.post('/api/search', upload.single('image'), async (req, res) => {
    console.log('Search request received:', req.body);

    const startTime = performance.now();
    try {
        const searchType = req.body.type;
        console.log('Starting search process for type:', req.body.type);

        const collection = client.db(dbName).collection(collectionName);
        let results = [];

        switch (searchType) {
            case 'basic': {
                console.log('Performing basic search');
                const query = req.body.query;
                results = await collection.find({
                    $or: [
                        { title: { $regex: query, $options: 'i' } },
                        { description: { $regex: query, $options: 'i' } },
                        { category: { $regex: query, $options: 'i' } }
                    ]
                }).limit(10).toArray();
                console.log('Basic search results:', results);

                break;
            }

            case 'atlas': {
                console.log('Performing Atlas search');

                const shouldClauses = [];
                const options = req.body.options || {
                    fuzzyMatching: true,
                    autoComplete: true,
                    phraseMatching: true
                };

                console.log('Search options:', options);

                // Add phrase matching
                if (options.phraseMatching) {
                    shouldClauses.push({
                        text: {
                            query: req.body.query,
                            path: ["searchableTitle", "description"],
                            score: { boost: { value: 3 } }
                        }
                    });
                }

                // Add fuzzy matching
                if (options.fuzzyMatching) {
                    shouldClauses.push({
                        text: {
                            query: req.body.query,
                            path: ["searchableTitle", "description", "category"],
                            fuzzy: {
                                maxEdits: 2,
                                prefixLength: 1,
                                maxExpansions: 100
                            },
                            score: { boost: { value: 1 } }
                        }
                    });
                }

                // Add autocomplete
                if (options.autoComplete) {
                    shouldClauses.push({
                        autocomplete: {
                            query: req.body.query,
                            path: "title",
                            score: { boost: { value: 2 } }
                        }
                    });
                }

                const searchPipeline = [
                    {
                        $search: {
                            index: 'advanced',
                            compound: {
                                should: shouldClauses,
                                minimumShouldMatch: 1
                            },
                            highlight: {
                                path: ["title", "description"]
                            }
                        }
                    },
                    {
                        $addFields: {
                            score: { $meta: "searchScore" },
                            highlights: { $meta: "searchHighlights" },
                            matchDetails: {
                                fuzzyMatches: {
                                    $filter: {
                                        input: { $meta: "searchScoreDetails" },
                                        as: "detail",
                                        cond: { $eq: ["$$detail.type", "fuzzy"] }
                                    }
                                },
                                phraseMatches: {
                                    $filter: {
                                        input: { $meta: "searchScoreDetails" },
                                        as: "detail",
                                        cond: { $eq: ["$$detail.type", "phrase"] }
                                    }
                                },
                                autocompleteMatches: {
                                    $filter: {
                                        input: { $meta: "searchScoreDetails" },
                                        as: "detail",
                                        cond: { $eq: ["$$detail.type", "autocomplete"] }
                                    }
                                }
                            }
                        }
                    },
                    { $sort: { score: -1 } },
                    {
                        $project: {
                            _id: 0,
                            title: 1,
                            description: 1,
                            category: 1,
                            price: 1,
                            image: 1,
                            score: 1,
                            highlights: 1,
                            matchDetails: 1
                        }
                    },
                    { $limit: 10 }
                ];

                console.log('Executing Atlas Search pipeline:', JSON.stringify(searchPipeline, null, 2));
                results = await collection.aggregate(searchPipeline).toArray();
                break;
            }

            case 'vector': {
                // Standard vector search
                console.log('Generating embedding for query:', req.body.query);
                console.log('Starting vector search process');
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

                const endTime = performance.now();
                return res.json({
                    results: results.map(result => ({
                        ...result,
                        score: result.score ? Math.min(Math.max(result.score, 0), 1) : undefined
                    })),
                    searchTime: (endTime - startTime).toFixed(2),
                    imageDescription
                });
            }

            default:
                throw new Error('Invalid search type');
        }

    } catch (error) {
        console.error('Error during search:', error);
        res.status(500).json({
            error: 'Search failed',
            details: error.message
        });
    }
});

// Helper functions

async function generateEmbedding(text) {
    console.log('Sending text to OpenAI for embedding:', text);

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
        // console.log(data);
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
        model: "gpt-4o-mini",  // Updated model name
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

    // console.log('Enhanced query:', completion.choices[0].message.content);
    return completion.choices[0].message.content;
}

async function processImage(imageBuffer) {
    const base64Image = imageBuffer.toString('base64');
    // console.log('Base64 image:', base64Image);
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",  // Updated model name
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
        //   console.log(`Inserted ${sampleProducts.length} sample products`);
    }
}

// Start server
const PORT = process.env.PORT || 3003;

async function startServer() {
    try {
        const dbInitialized = await initializeDB();
        if (dbInitialized) {
            await seedSampleData();
            await updateDocumentsWithSearchableTitle();

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