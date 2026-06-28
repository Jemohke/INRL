import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.SESSION_DB_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.query(`
  CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    session_key TEXT UNIQUE NOT NULL,
    creds TEXT NOT NULL,
    phone TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('✅ DB ready')).catch(console.error);

export async function saveSession(creds, phone = 'qr') {
  let sessionKey, saved = false;
  while (!saved) {
    sessionKey = crypto.randomBytes(4).toString('hex').toUpperCase();
    try {
      await pool.query(
        'INSERT INTO sessions (session_key, creds, phone) VALUES ($1, $2, $3)',
        [sessionKey, JSON.stringify(creds), phone]
      );
      saved = true;
    } catch (e) { /* key collision, retry */ }
  }
  return `BLACK-MD:~${sessionKey}`;
}
