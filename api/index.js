// Vercel entry point: the whole Express app runs as one serverless function.
// vercel.json rewrites /api/* and /webhook here; public/ is served as static files.
module.exports = require("../src/server");
