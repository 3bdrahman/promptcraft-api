import pg from 'pg';

// Lazy-initialize pool for Vercel serverless functions
let pool = null;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

// Database connection object
export const db = {
  query: async (text, params) => {
    const pool = getPool();
    return await pool.query(text, params);
  },
  connect: async () => {
    const pool = getPool();
    return await pool.connect();
  },
  getClient: async () => {
    const pool = getPool();
    return await pool.connect();
  }
};

// Test database connection
export const testConnection = async () => {
  try {
    const client = await db.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
};