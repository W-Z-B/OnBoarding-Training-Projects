const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("WARNING: DATABASE_URL is not set. The API will fail on DB calls.");
}

const pool = new Pool({
  connectionString,
  // Railway Postgres needs SSL in production
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
});

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema migrated.");
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, migrate };
