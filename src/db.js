const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set. Database routes will not work until it is configured.");
}

const databaseCa = process.env.DATABASE_SSL_CA
  ? process.env.DATABASE_SSL_CA.replace(/\\n/g, "\n")
  : null;

// Render-compatible fallback is retained when no CA is supplied. Set
// DATABASE_SSL_CA to the database provider's PEM CA certificate to enable
// certificate verification instead of accepting any TLS certificate.
const productionSsl = databaseCa
  ? { ca: databaseCa, rejectUnauthorized: true }
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.NODE_ENV === "production" || process.env.RENDER === "true") ? productionSsl : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
