// src/config.js
const configs = {
    development: {
      apiUrl: 'http://localhost:3003',
      corsOrigins: ['http://localhost:5173']
    },
    production: {
      apiUrl: 'https://vector-search-demo-backend.vercel.app',
      corsOrigins: ['https://vector-search-demo-frontend.vercel.app']
    }
  };
  
  const environment = import.meta.env.MODE || 'development';
  export default configs[environment];
  
  // Backend config (config/index.js)
  const environment = process.env.NODE_ENV || 'development';
  const configs = {
    development: {
      port: 3003,
      corsOrigins: ['http://localhost:5173']
    },
    production: {
      port: process.env.PORT || 3003,
      corsOrigins: ['https://vector-search-demo-frontend.vercel.app']
    }
  };
  
  export default configs[environment];
  
  // Update your App.jsx usage:
  import config from './config';
  
  const API_URL = `${config.apiUrl}/api`;
  
  // Update backend server.js:
  import config from './config/index.js';
  
  app.use(cors({
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      credentials: true
  }));
  
  app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
  });