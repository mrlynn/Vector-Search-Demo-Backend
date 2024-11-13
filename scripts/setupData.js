import { MongoClient } from 'mongodb';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const client = new MongoClient(process.env.MONGODB_URI);

const sampleProducts = [
  // Coffee Makers & Equipment
  {
    title: "Professional Barista Coffee Maker",
    description: "Commercial-grade programmable coffee maker with precision brewing temperature control, built-in grinder, and LCD display. Perfect for serious coffee enthusiasts and small cafes.",
    category: "Coffee Makers",
    price: 599.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Pro+Coffee"
  },
  {
    title: "Smart WiFi Coffee Machine",
    description: "Voice-controlled coffee maker with mobile app integration. Schedule your morning brew, customize strength, and monitor brewing from your phone. Works with Alexa and Google Home.",
    category: "Smart Home",
    price: 299.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Smart+Coffee"
  },
  {
    title: "Precision Coffee Bean Grinder",
    description: "Professional-grade coffee grinder with 40 precision settings and built-in digital scale. Conical burr design preserves flavor and aroma. Perfect for pour-over, espresso, and French press.",
    category: "Accessories",
    price: 149.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Grinder"
  },
  {
    title: "Portable Espresso Maker",
    description: "Manual espresso maker for travel and camping. No electricity needed. Makes rich, creamy espresso with 18 bars of pressure. Includes carrying case and scoop.",
    category: "Coffee Makers",
    price: 89.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Portable"
  },
  {
    title: "Cold Brew Coffee System",
    description: "Large capacity cold brew maker with precision filters and easy-pour spout. Makes smooth, low-acid coffee concentrate. Perfect for summer drinks and coffee cocktails.",
    category: "Coffee Makers",
    price: 49.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Cold+Brew"
  },

  // Coffee & Beans
  {
    title: "Single Origin Ethiopian Yirgacheffe",
    description: "Light roast coffee beans with floral notes, bright acidity, and hints of bergamot and jasmine. Sourced from small farms in Ethiopia's Yirgacheffe region.",
    category: "Coffee Beans",
    price: 18.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Ethiopian"
  },
  {
    title: "Dark Roast Espresso Blend",
    description: "Bold, dark roasted coffee blend perfect for espresso. Notes of dark chocolate and caramel with a smooth finish. Blend of beans from Colombia and Brazil.",
    category: "Coffee Beans",
    price: 16.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Espresso"
  },
  {
    title: "Organic Medium Roast Blend",
    description: "Balanced medium roast with notes of brown sugar and citrus. 100% organic certified beans from Guatemala and Peru. Perfect for daily drinking.",
    category: "Coffee Beans",
    price: 15.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Medium"
  },

  // Accessories
  {
    title: "Gooseneck Pour-Over Kettle",
    description: "Electric kettle with precise temperature control and curved spout for optimal pour-over brewing. Digital display and keep-warm function.",
    category: "Accessories",
    price: 79.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Kettle"
  },
  {
    title: "Ceramic Pour-Over Dripper",
    description: "Hand-crafted ceramic coffee dripper with spiral ribs for optimal extraction. Designed for making clean, flavorful pour-over coffee. Includes filters.",
    category: "Accessories",
    price: 29.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Dripper"
  },
  {
    title: "Double-Wall Glass Set",
    description: "Set of 2 double-wall glass coffee cups. Heat-resistant borosilicate glass keeps coffee hot and hands cool. Modern, minimalist design.",
    category: "Accessories",
    price: 34.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Glasses"
  },

  // Smart Devices
  {
    title: "Smart Coffee Scale",
    description: "Bluetooth-enabled coffee scale with timing function and app connectivity. Track your pour-over recipes and share with other coffee enthusiasts.",
    category: "Smart Home",
    price: 99.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Scale"
  },
  {
    title: "Coffee Freshness Monitor",
    description: "Smart sensor that tracks coffee bean freshness and optimal storage conditions. Monitors temperature, humidity, and CO2 levels. Sends alerts to your phone.",
    category: "Smart Home",
    price: 39.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Monitor"
  },

  // Specialty Items
  {
    title: "Coffee Roasting Kit",
    description: "Home coffee roasting kit with sample green beans and temperature guide. Learn to roast your own beans and discover unique flavor profiles.",
    category: "Specialty",
    price: 199.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Roasting"
  },
  {
    title: "Coffee Tasting Journal",
    description: "Premium leather-bound coffee tasting journal with guided entry pages. Record brewing methods, flavor notes, and coffee origins.",
    category: "Specialty",
    price: 24.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Journal"
  },
  {
    title: "Coffee Subscription Box",
    description: "Monthly subscription of carefully curated single-origin coffees. Includes tasting notes, brewing guides, and stories about coffee farmers.",
    category: "Specialty",
    price: 39.99,
    image: "https://placehold.co/120x120/e2e8f0/1e293b?text=Subscription"
  }
];

async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return response.data[0].embedding;
}

async function setupDatabase() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    
    const db = client.db("product_search");
    const collection = db.collection("products");

    // Clear existing data
    await collection.deleteMany({});
    console.log("Cleared existing products");

    console.log("Starting to process products...");
    let processed = 0;
    
    // Process and insert products
    for (const product of sampleProducts) {
      const description_embedding = await generateEmbedding(
        `${product.title} ${product.description}`
      );
      
      await collection.insertOne({
        ...product,
        description_embedding
      });
      
      processed++;
      console.log(`Processed ${processed}/${sampleProducts.length} products`);
    }

    console.log('Database setup complete!');
    console.log(`Total products inserted: ${processed}`);

    // Verify the vector search index
    const indexes = await collection.listIndexes().toArray();
    const hasVectorIndex = indexes.some(idx => idx.name === "vector_index");
    console.log(`Vector search index status: ${hasVectorIndex ? 'Present' : 'Missing'}`);

  } catch (error) {
    console.error('Setup error:', error);
  } finally {
    await client.close();
    console.log("Database connection closed");
  }
}

setupDatabase().catch(console.error);