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