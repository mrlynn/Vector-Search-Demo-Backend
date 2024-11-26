import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import multer from 'multer';
import winston from 'winston';
import config from './config/index.js';

dotenv.config();

const app = express();
app.use(express.json());
const allowedOrigins = [
    'https://vector-search-demo-frontend.vercel.app',
    'http://localhost:5173',
    'http://localhost:5174',
];

app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    }

    if (req.method === 'OPTIONS') {
        res.status(204).end();
    } else {
        next();
    }
});
// Preflight request handler
// Log request details for debugging
app.use((req, res, next) => {
    console.log('Request details:', {
        method: req.method,
        path: req.path,
        origin: req.headers.origin,
    });
    next();
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'combined.log' }) // Optional: log to file
    ]
});


logger.info(`Environment: ${process.env.NODE_ENV}`);

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
const books = "ancient_texts"
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

// Book-related endpoints
app.get('/api/books/:id', async (req, res) => {
    try {
        const collection = client.db(dbName).collection("books");
        const book = await collection.findOne(
            { _id: new ObjectId(req.params.id) },
            {
                projection: {
                    title: 1,
                    author: 1,
                    summary: 1,
                    period: 1,
                    date: 1,
                    contents: 1,
                    significance: 1,
                    keywords: 1,
                    references: 1
                }
            }
        );
        
        if (!book) {
            return res.status(404).json({ error: 'Book not found' });
        }
        
        res.json(book);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch book details' });
    }
});
// Updated ask-text endpoint
// Update the QA endpoint with the correct vector search syntax
app.post('/api/ask-text', async (req, res) => {
    try {
        const { question } = req.body;
        const collection = client.db(dbName).collection("books");
        
        // Get relevant context from vector search
        const questionEmbedding = await generateEmbedding(question);
        const searchResults = await collection.aggregate([
            {
                $vectorSearch: {
                    index: "vector_index", // Add the index name
                    queryVector: questionEmbedding,
                    path: "description_embedding",
                    numCandidates: 150,
                    limit: 5
                }
            },
            {
                $project: {
                    title: 1,
                    summary: 1,
                    contents: 1,
                    significance: 1,
                    score: { $meta: "vectorSearchScore" }
                }
            }
        ]).toArray();

        // Combine context for GPT
        const context = searchResults.map(r => 
            `${r.title}\n${r.summary}\n${r.contents || ''}\n${r.significance || ''}`
        ).join('\n\n');

        // Generate answer
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: `You are an expert on ancient texts and history.`
                },
                {
                    role: "user",
                    content: `Context: ${context}\n\nQuestion: ${question}`
                }
            ],
            max_tokens: 1000,
            temperature: 0.7
        });

        res.json({
            answer: completion.choices[0].message.content,
            books: searchResults.map(r => ({
                _id: r._id,
                title: r.title,
                summary: r.summary
            }))
        });
    } catch (error) {
        console.error('QA error:', error);
        res.status(500).json({ 
            error: 'Internal server error',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

app.get('/api/books/recommendations', async (req, res) => {
    try {
        const { topic, period, keywords } = req.query;
        const collection = client.db(dbName).collection('books');

        const pipeline = [
            {
                $search: {
                    compound: {
                        should: [
                            topic && {
                                text: {
                                    query: topic,
                                    path: ["title", "summary"],
                                    score: { boost: { value: 2 } }
                                }
                            },
                            period && {
                                text: {
                                    query: period,
                                    path: "period",
                                    score: { boost: { value: 1.5 } }
                                }
                            },
                            keywords && {
                                text: {
                                    query: keywords,
                                    path: "keywords",
                                    score: { boost: { value: 1 } }
                                }
                            }
                        ].filter(Boolean)
                    }
                }
            },
            { $limit: 5 },
            {
                $project: {
                    title: 1,
                    summary: 1,
                    period: 1,
                    keywords: 1,
                    score: { $meta: "searchScore" },
                    _id: 0
                }
            }
        ];

        const recommendations = await collection.aggregate(pipeline).toArray();
        res.json(recommendations);
    } catch (error) {
        console.error('Error getting recommendations:', error);
        res.status(500).json({ error: 'Failed to get recommendations' });
    }
});

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

app.get('/api/books', async (req, res) => {
    try {
        const collection = client.db(dbName).collection('books');

        const books = await collection.find({}, {
            projection: {
                title: 1,
                summary: 1,
                period: 1,
                author: 1,
                _id: 1 // Include _id
            }
        }).toArray();

        console.log('Fetched books:', books);
        res.json(books);
    } catch (error) {
        console.error('Error fetching books:', error);
        res.status(500).json({ error: 'Failed to fetch books' });
    }
});
// Search endpoint with multiple search types
app.post('/api/search', upload.single('image'), async (req, res) => {
    console.log('Search request received:', req.body);

    const startTime = performance.now();
    try {
        const searchType = req.body.type;
        console.log('Starting search process for type:', searchType);

        const collection = client.db(dbName).collection(collectionName);
        let results = [];

        switch (searchType) {
            case 'basic': {
                console.log('Performing basic search with query:', req.body.query);
                const query = req.body.query;
                results = await collection.find({
                    $or: [
                        { title: { $regex: query, $options: 'i' } },
                        { description: { $regex: query, $options: 'i' } },
                        { category: { $regex: query, $options: 'i' } }
                    ]
                }).limit(10).toArray();
                console.log('Basic search results:', results.length, 'matches found');
                break;
            }

            case 'atlas': {
                console.log('Performing Atlas Search');
                const pipeline = [
                    // Define the Atlas Search pipeline here
                ];
                console.log('Atlas Search pipeline:', JSON.stringify(pipeline, null, 2));
                results = await collection.aggregate(pipeline).toArray();
                console.log('Atlas search results:', results.length, 'matches found');
                break;
            }

            case 'vector': {
                console.log('Performing vector search with query:', req.body.query);
                const embedding = await generateEmbedding(req.body.query);
                console.log('Generated embedding:', embedding);
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
                    { $addFields: { score: { $meta: "vectorSearchScore" } } }
                ]).toArray();
                console.log('Vector search results:', results.length, 'matches found');
                break;
            }

            case 'semantic': {
                console.log('Enhancing query for semantic search:', req.body.query);
                const enhancedQuery = await enhanceQueryWithGPT(req.body.query);
                const embedding = await generateEmbedding(enhancedQuery);
                console.log('Enhanced query embedding:', embedding);
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
                    { $addFields: { score: { $meta: "vectorSearchScore" } } }
                ]).toArray();
                console.log('Semantic search results:', results.length, 'matches found');
                break;
            }

            case 'image': {
                console.log('Processing image for search');
                if (!req.file) {
                    throw new Error('No image file provided');
                }
                const imageDescription = await processImage(req.file.buffer);
                console.log('Generated image description:', imageDescription);
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
                    { $addFields: { score: { $meta: "vectorSearchScore" } } }
                ]).toArray();
                console.log('Image search results:', results.length, 'matches found');
                break;
            }

            default:
                throw new Error('Invalid search type');
        }

        console.log('Search completed. Returning results.');
        res.json({
            results: results.map(result => ({
                ...result,
                score: result.score ? Math.min(Math.max(result.score, 0), 1) : undefined
            })),
            searchTime: (performance.now() - startTime).toFixed(2),
        });

    } catch (error) {
        console.error('Error during search:', error);
        res.status(500).json({
            error: 'Search failed',
            details: error.message,
        });
    }
});


// Helper functions

async function generateEmbedding(text) {
    console.log('Sending text to OpenAI for embedding:', text);

    const response = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        input: text
    });
    return response.data[0].embedding;
}

app.get('/api/data', async (req, res) => {
    try {
      const collection = client.db(dbName).collection(collectionName);
      const data = await collection.find({}).toArray();
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
                content: "Convert the user's search query into a detailed product description, staying focused on the core concept. For misspelled words, correct them but maintain the original intent."
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

const initializeIndexes = async () => {
    const collection = client.db(dbName).collection("books");
    
    // Vector search index
    await collection.createSearchIndex({
        name: "vector_index",
        definition: {
            mappings: {
                dynamic: true,
                fields: {
                    "embeddings.description": {
                        dimensions: 384,
                        similarity: "cosine",
                        type: "knnVector"
                    }
                }
            }
        }
    });

    // Text search index
    await collection.createIndex({
        title: "text",
        summary: "text",
        keywords: "text"
    }, { name: "text_search_index" });
    
    // Regular indexes
    await collection.createIndex({ period: 1 });
    await collection.createIndex({ keywords: 1 });
    await collection.createIndex({ "metadata.dateAdded": 1 });
};

// Initialize MongoDB connection and indexes
async function initializeDB() {
    try {
        await client.connect();
        console.log("Connected to MongoDB");

        const db = client.db(dbName);
        const ancientTextsCollection = db.collection("ancient_texts");

        // Test the connection
        await ancientTextsCollection.findOne({});
        console.log("Successfully connected to ancient_texts collection");

        // Create indexes for ancient texts
        console.log('\nInitializing Ancient Texts Collection...');
        
        // Create vector search index for ancient texts
        try {
            const vectorIndex = {
                name: "vector_index",
                type: "vectorSearch",
                definition: {
                    fields: [{
                        type: "vector",
                        numDimensions: 1536, // for text-embedding-3-small
                        path: "description_embedding",
                        similarity: "cosine"
                    }]
                }
            };

            await ancientTextsCollection.createSearchIndex(vectorIndex);
            console.log("Created vector search index for ancient texts");
        } catch (error) {
            console.warn("Warning: Vector search index creation failed:", error.message);
        }

        // Create text search index for ancient texts
        try {
            await ancientTextsCollection.createIndex(
                { title: "text", description: "text", keywords: "text" },
                { name: "text_search_index" }
            );
            console.log("Created text search index for ancient texts");
        } catch (error) {
            console.warn("Warning: Text search index creation failed:", error.message);
        }

        // Create regular indexes
        await ancientTextsCollection.createIndex({ title: 1 });
        await ancientTextsCollection.createIndex({ period: 1 });
        await ancientTextsCollection.createIndex({ keywords: 1 });
        await ancientTextsCollection.createIndex({ "metadata.dateAdded": 1 });

        return true;
    } catch (error) {
        console.error('DB initialization error:', error);
        return false;
    }
}

// Add sample data if collection is empty
async function addInitialTexts() {
    try {
        const collection = client.db(dbName).collection("ancient_texts");
        const count = await collection.countDocuments();

        if (count === 0) {
            console.log("\nSeeding ancient texts data...");

            const ancientTexts = [
                {
                    title: "Book of the Dead",
                    author: "Various Egyptian Priests",
                    summary: "A collection of funerary texts consisting of spells and instructions to help the deceased navigate the afterlife.",
                    period: "New Kingdom",
                    date: "1550-1070 BCE",
                    contents: "Contains various spells including the famous Spell 125 (Weighing of the Heart ceremony)",
                    significance: "One of the most important religious texts in ancient Egyptian history",
                    keywords: [
                        "afterlife",
                        "funerary rituals",
                        "spells",
                        "Weighing of the Heart",
                        "Osiris",
                        "judgment",
                        "immortality"
                    ]
                },
                {
                    title: "Pyramid Texts",
                    author: "Royal Scribes of the Old Kingdom",
                    summary: "The oldest known religious texts in the world, inscribed on pyramid walls. Contains spells for the pharaoh's resurrection and ascension.",
                    period: "Old Kingdom",
                    date: "2400-2300 BCE",
                    contents: "Spells and rituals for the pharaoh's afterlife journey",
                    significance: "Earliest known corpus of ancient Egyptian religious texts",
                    keywords: [
                        "pyramids",
                        "royal afterlife",
                        "resurrection",
                        "ascension",
                        "divine kingship"
                    ]
                },
                {
                    title: "Instructions of Ptahhotep",
                    author: "Ptahhotep",
                    summary: "A collection of wisdom teachings from the vizier Ptahhotep, offering advice on behavior and moral living.",
                    period: "Middle Kingdom",
                    date: "2000-1800 BCE",
                    contents: "Maxims and teachings on proper conduct and wisdom",
                    significance: "One of the earliest works of moral philosophy",
                    keywords: [
                        "wisdom literature",
                        "moral teachings",
                        "leadership",
                        "ethics",
                        "vizier"
                    ]
                }
            ];

            // Generate embeddings for each text
            for (const text of ancientTexts) {
                console.log(`Generating embeddings for ${text.title}...`);
                
                const titleEmbedding = await generateEmbedding(text.title);
                const descriptionEmbedding = await generateEmbedding(text.summary);

                text.title_embedding = titleEmbedding;
                text.embeddings.description = descriptionEmbedding;
                text.searchableTitle = text.title.toLowerCase();
                text.metadata = {
                    dateAdded: new Date(),
                    lastUpdated: new Date()
                };
            }

            await collection.insertMany(ancientTexts);
            console.log(`Added ${ancientTexts.length} ancient texts to database`);
        }
    } catch (error) {
        console.error('Error seeding ancient texts:', error);
        throw error;
    }
}

// Update your startServer function
async function startServer() {
    try {
        const dbInitialized = await initializeDB();
        if (dbInitialized) {
            await addInitialTexts(); // Add initial ancient texts
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


// Health check endpoint
app.get('/api/health', async (req, res) => {
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

app.post('/api/books/search', async (req, res) => {
    const { type, query, era } = req.body;
    const startTime = performance.now();
    const collection = client.db(dbName).collection("books");
    
    try {
        let results = [];
        switch (type) {
            case 'vector': {
                const embedding = await generateEmbedding(query);
                results = await collection.aggregate([
                    {
                        $vectorSearch: {
                            queryVector: embedding,
                            path: "description_embedding",  // Changed from embeddings.description
                            numCandidates: 100,
                            limit: 10,
                            index: "vector_index"
                        }
                    },
                    {
                        $addFields: { score: { $meta: "vectorSearchScore" } }
                    },
                    {
                        $project: {
                            title: 1,
                            author: 1,
                            summary: 1,
                            period: 1,
                            keywords: 1,
                            score: 1,
                            year: "$date" // Map era to period
                        }
                    }
                ]).toArray();
                break;
            }
            case 'semantic': {
                const enhancedQuery = await enhanceAncientQuery(query);
                const embedding = await generateEmbedding(enhancedQuery);
                results = await collection.aggregate([
                    {
                        $vectorSearch: {
                            queryVector: embedding,
                            path: "description_embedding",  // Changed from embeddings.description
                            numCandidates: 100,
                            limit: 10,
                            index: "vector_index"
                        }
                    },
                    {
                        $addFields: { score: { $meta: "vectorSearchScore" } }
                    },
                    {
                        $project: {
                            title: 1,
                            author: 1,
                            summary: 1,
                            period: 1,
                            keywords: 1,
                            score: 1
                        }
                    }
                ]).toArray();
                break;
            }
            case 'concept': {
                results = await collection.aggregate([
                    {
                        $search: {
                            index: "default",
                            text: {
                                query: query,
                                path: ["keywords", "title", "summary"],
                                fuzzy: {}
                            }
                        }
                    },
                    {
                        $addFields: { score: { $meta: "searchScore" } }
                    },
                    { $limit: 10 }
                ]).toArray();
                break;
            }
        }

        const searchTime = performance.now() - startTime;
        res.json({
            results: results.map(r => ({
                ...r,
                score: Math.min(Math.max(r.score, 0), 1)
            })),
            searchTime: searchTime.toFixed(2)
        });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({
            error: 'Search failed',
            details: error.message
        });
    }
});

app.get('/api/books/periods', async (req, res) => {
    try {
        const collection = client.db(dbName).collection("books");
        const periods = await collection.distinct("period");
        res.json(periods);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch periods',
            details: error.message
        });
    }
});

app.get('/api/books/concepts', async (req, res) => {
    try {
        const collection = client.db(dbName).collection("books");
        const concepts = await collection.distinct("keywords");
        res.json(concepts);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch concepts',
            details: error.message
        });
    }
});

app.post('/api/ancient-texts/search', async (req, res) => {
    console.log('Ancient texts search request received:', req.body);
    const startTime = performance.now();

    try {
        const { type, query } = req.body;

        if (!type || !query) {
            throw new Error('Missing required parameters: "type" and "query".');
        }

        console.log('Search type:', type, '| Query:', query);

        const collection = client.db(dbName).collection("books");
        let results = [];

        switch (type) {
            case 'basic': {
                console.log('Performing basic search...');
                results = await collection.find({
                    $or: [
                        { title: { $regex: query, $options: 'i' } },
                        { author: { $regex: query, $options: 'i' } },
                        { description: { $regex: query, $options: 'i' } }
                    ]
                }).limit(10).toArray();

                console.log(`Basic search results: ${results.length} matches found.`);
                break;
            }

            case 'vector': {
                console.log('Generating embedding for vector search...');
                const embedding = await generateEmbedding(query);

                console.log('Performing vector search...');
                results = await collection.aggregate([
                    {
                        $vectorSearch: {
                            queryVector: embedding,
                            path: "description_embedding",  // Changed from embeddings.description
                            numCandidates: 100,
                            limit: 10,
                            index: "vector_index",
                        }
                    },
                    {
                        $addFields: {
                            score: { $meta: "vectorSearchScore" }
                        }
                    },
                    {
                        $project: {
                            title: 1,
                            author: 1,
                            description: 1,
                            concepts: 1,
                            era: 1,
                            year: 1,
                            score: 1
                        }
                    }
                ]).toArray();

                console.log(`Vector search results: ${results.length} matches found.`);
                break;
            }

            case 'semantic': {
                console.log('Enhancing query for semantic search...');
                const enhancedQuery = await enhanceAncientQuery(query);
                console.log('Enhanced query:', enhancedQuery);

                console.log('Generating embedding for enhanced query...');
                const embedding = await generateEmbedding(enhancedQuery);

                console.log('Performing semantic search...');
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
                    },
                    {
                        $project: {
                            title: 1,
                            author: 1,
                            description: 1,
                            concepts: 1,
                            era: 1,
                            year: 1,
                            score: 1
                        }
                    }
                ]).toArray();

                console.log(`Semantic search results: ${results.length} matches found.`);
                break;
            }

            case 'concept': {
                console.log('Performing hybrid concept search...');
                const embedding = await generateEmbedding(query);

                const vectorPipeline = [
                    {
                        $vectorSearch: {
                            queryVector: embedding,
                            path: "description_embedding",
                            numCandidates: 100,
                            limit: 20,
                            index: "vector_index",
                        }
                    },
                    { $addFields: { vectorScore: { $meta: "vectorSearchScore" } } },
                    { $project: { title: 1, description: 1, vectorScore: 1 } }
                ];

                const textPipeline = [
                    {
                        $search: {
                            index: "text_search_index",
                            text: { query, path: ["description"], fuzzy: {} }
                        }
                    },
                    { $project: { title: 1, description: 1, textScore: { $meta: "searchScore" } } }
                ];

                console.log('Running vector search pipeline...');
                const vectorResults = await collection.aggregate(vectorPipeline).toArray();
                console.log(`Vector search results: ${vectorResults.length}`);

                console.log('Running text search pipeline...');
                const textResults = await collection.aggregate(textPipeline).toArray();
                console.log(`Text search results: ${textResults.length}`);

                // Combine and score
                const finalResults = combineResults(vectorResults, textResults);
                results = finalResults.slice(0, 10); // Limit final results

                console.log(`Hybrid search results: ${results.length} matches found.`);
                break;
            }

            default:
                throw new Error(`Unsupported search type: ${type}`);
        }

        const searchTime = (performance.now() - startTime).toFixed(2);
        console.log(`Search completed in ${searchTime}ms.`);
        res.json({ results, searchTime });
    } catch (error) {
        console.error('Error during ancient texts search:', error);
        res.status(500).json({ error: 'Search failed', details: error.message });
    }
});

// Add this helper function for semantic search
async function enhanceAncientQuery(query) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4-0125-preview",
            messages: [
                {
                    role: "system",
                    content: "You are an expert in ancient Egyptian texts and concepts. Convert the user's search query into a detailed description that captures the semantic meaning in the context of ancient Egyptian literature, philosophy, and religious concepts."
                },
                {
                    role: "user",
                    content: query
                }
            ],
            max_tokens: 150,
            temperature: 0.7
        });

        return completion.choices[0].message.content;
    } catch (error) {
        console.error('Error enhancing query:', error);
        return query; // Fallback to original query if enhancement fails
    }
}
// Add this endpoint to get unique concepts
app.get('/api/ancient-texts/concepts', async (req, res) => {
    try {
        const collection = client.db(dbName).collection("ancient_texts");
        const concepts = await collection.distinct("concepts");
        res.json(concepts);
    } catch (error) {
        console.error('Error fetching concepts:', error);
        res.status(500).json({
            error: 'Failed to fetch concepts',
            details: error.message
        });
    }
});

app.get('/api/ancient-texts/search-status', async (req, res) => {
    try {
        const collection = client.db(dbName).collection("ancient_texts");
        const indexes = await collection.listSearchIndexes().toArray();

        const status = {
            textSearchIndex: indexes.find(idx => idx.name === "text_search_index"),
            vectorSearchIndex: indexes.find(idx => idx.name === "vector_index"),
            totalIndexes: indexes.length,
            indexNames: indexes.map(idx => idx.name)
        };

        // Test hybrid search
        if (status.textSearchIndex && status.vectorSearchIndex) {
            const testQuery = "wisdom teachings";
            const testResults = await collection.aggregate([
                {
                    $search: {
                        index: "text_search_index",
                        text: {
                            query: testQuery,
                            path: ["concepts", "title", "description"]
                        }
                    }
                },
                { $limit: 1 }
            ]).toArray();

            status.testSearch = {
                worked: testResults.length > 0,
                resultCount: testResults.length
            };
        }

        res.json(status);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to check search status',
            details: error.message
        });
    }
});

// Add this endpoint to get distinct eras
app.get('/api/ancient-texts/eras', async (req, res) => {
    try {
        const collection = client.db(dbName).collection("ancient_texts");
        const eras = await collection.distinct("era");
        res.json(eras);
    } catch (error) {
        console.error('Error fetching eras:', error);
        res.status(500).json({
            error: 'Failed to fetch eras',
            details: error.message
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