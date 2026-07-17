import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL.");
  process.exit(1);
}

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on("error", error => {
  console.error(
    "Unexpected PostgreSQL pool error:",
    error
  );
});

export async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      watchlist JSONB NOT NULL DEFAULT '[]'::jsonb,
      geo TEXT,
      market TEXT,
      brief JSONB,
      brief_generated_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log("PostgreSQL initialized.");
}
