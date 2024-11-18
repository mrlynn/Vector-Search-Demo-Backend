
# MongoDB Search Evolution Backend

This is the **backend** service for the **MongoDB Search Evolution Demo** application. It serves as the core API layer, enabling multiple search methodologies such as **Basic Find**, **Atlas Search**, **Vector Search**, **Semantic Search**, and **Image Search**. It leverages MongoDB, OpenAI's API, and advanced search capabilities to process and return results.

---

## Features

1. **API Endpoints**:
   - `/api/search`: Handles different search types and processes queries.
   - `/api/data`: Fetches all product data.
   - `/health`: Provides server health and MongoDB status.

2. **Search Methodologies**:
   - **Basic Find**: Regex-based search with MongoDB's native `.find()` method.
   - **Atlas Search**: Full-text search using MongoDB Atlas with fuzzy matching, autocomplete, and phrase matching.
   - **Vector Search**: Semantic search using vector similarity.
   - **Semantic Search**: Advanced vector search enhanced by OpenAI embeddings.
   - **Image Search**: Image-based search using OpenAI for image descriptions and vector embeddings.

3. **Data Management**:
   - Automatic indexing for different search methodologies (e.g., Atlas Search, Vector Search).
   - Seeding of sample product data on initialization.

4. **Middleware**:
   - CORS configuration for secure cross-origin requests.
   - Multer for image file uploads.
   - Winston for structured logging.

---

## Getting Started

### Prerequisites

- **Node.js**: Install [Node.js](https://nodejs.org/) (version 14 or later recommended).
- **MongoDB**: A running MongoDB instance (local or Atlas).
- **OpenAI API Key**: Required for embedding generation and query enhancement.

---

### Installation

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   Create a `.env` file in the root directory with the following:
   ```
   MONGODB_URI=<your-mongodb-uri>
   OPENAI_API_KEY=<your-openai-api-key>
   ```

---

### Running the Server

1. Start the server:
   ```bash
   npm start
   ```

2. The server will be available at:
   ```
   http://localhost:3003
   ```

3. Health check endpoint:
   ```
   http://localhost:3003/health
   ```

---

### API Endpoints

1. **Search Endpoint**:
   ```
   POST /api/search
   ```
   Request body example:
   ```json
   {
       "type": "basic",
       "query": "coffee"
   }
   ```

2. **Data Fetch Endpoint**:
   ```
   GET /api/data
   ```

3. **Health Check Endpoint**:
   ```
   GET /health
   ```

---

### Project Structure

- **server.js**: The main entry point for the backend service.
- **Middleware**:
  - CORS for secure cross-origin requests.
  - Winston for logging.
- **Helper Functions**:
  - `generateEmbedding`: Creates embeddings using OpenAI API.
  - `enhanceQueryWithGPT`: Enhances search queries for semantic relevance.
  - `processImage`: Processes image files for embedding generation.

---

### Logging and Debugging

- **Winston Logger**:
  - Logs are written to the console and `combined.log` file.
  - Levels include `info`, `error`, and `debug`.
- **Debugging Tips**:
  - Inspect logs for search pipeline and MongoDB queries.
  - Check `console.log` outputs for incoming requests and responses.

---

### Building for Production

To create an optimized build for deployment:

```bash
npm run build
```

---

### License

This project is licensed under the MIT License. See the LICENSE file for details.
