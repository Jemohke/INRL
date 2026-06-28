require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create sessions table
pool.query(`
  CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    session_key TEXT UNIQUE NOT NULL,
    creds TEXT NOT NULL,
    phone TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('✅ Sessions table ready')).catch(console.error);

// Generate short random key (8 chars)
function generateKey() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const activeSessions = new Map();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── PAIRING CODE ────────────────────────────────────────────
app.post('/pair', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ success: false, error: 'Phone number required' });

  const sessionId = 'session_' + Date.now();
  const sessionDir = path.join(__dirname, 'temp', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['BLACK-MD', 'Chrome', '1.0.0']
    });

    activeSessions.set(sessionId, { sock, sessionDir, saveCreds });
    sock.ev.on('creds.update', saveCreds);

    await new Promise(r => setTimeout(r, 2000));
    const code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
    const formatted = code.match(/.{1,4}/g).join('-');

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        try {
          const credsPath = path.join(sessionDir, 'creds.json');
          await new Promise(r => setTimeout(r, 3000));
          const creds = fs.readFileSync(credsPath, 'utf8');

          let sessionKey;
          let saved = false;
          while (!saved) {
            sessionKey = generateKey();
            try {
              await pool.query(
                'INSERT INTO sessions (session_key, creds, phone) VALUES ($1, $2, $3)',
                [sessionKey, creds, phone]
              );
              saved = true;
            } catch (e) {}
          }

          const fullSession = `BLACK-MD:~${sessionKey}`;

          await sock.sendMessage(sock.user.id, {
            text: `╔══════════════════════╗\n║   🔐 BLACK-MD SESSION  \n╚══════════════════════╝\n\n*Your session key:*\n\`\`\`${fullSession}\`\`\`\n\n⚠️ *Keep this private! Don't share it with anyone.*\n\n📌 Copy and paste it as your SESSION env variable.`
          });

          console.log(`✅ Session saved: ${fullSession}`);

          setTimeout(() => {
            try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
            activeSessions.delete(sessionId);
          }, 5000);

        } catch (err) {
          console.error('❌ Error saving session:', err.message);
        }
      } else if (connection === 'close') {
        try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
        activeSessions.delete(sessionId);
      }
    });

    res.json({ success: true, code: formatted, sessionId });

  } catch (err) {
    try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
    res.json({ success: false, error: err.message });
  }
});

// ─── QR CODE ─────────────────────────────────────────────────
app.post('/qr', async (req, res) => {
  const sessionId = 'session_' + Date.now();
  const sessionDir = path.join(__dirname, 'temp', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['BLACK-MD', 'Chrome', '1.0.0']
    });

    activeSessions.set(sessionId, { sock, sessionDir, saveCreds });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (qr) {
        const qrImage = await QRCode.toDataURL(qr);
        const entry = activeSessions.get(sessionId);
        if (entry) entry.qr = qrImage;
      }

      if (connection === 'open') {
        try {
          const credsPath = path.join(sessionDir, 'creds.json');
          await new Promise(r => setTimeout(r, 3000));
          const creds = fs.readFileSync(credsPath, 'utf8');

          let sessionKey;
          let saved = false;
          while (!saved) {
            sessionKey = generateKey();
            try {
              await pool.query(
                'INSERT INTO sessions (session_key, creds, phone) VALUES ($1, $2, $3)',
                [sessionKey, creds, 'qr']
              );
              saved = true;
            } catch (e) {}
          }

          const fullSession = `BLACK-MD:~${sessionKey}`;
          const entry = activeSessions.get(sessionId);
          if (entry) entry.session = fullSession;

          await sock.sendMessage(sock.user.id, {
            text: `╔══════════════════════╗\n║   🔐 BLACK-MD SESSION  \n╚══════════════════════╝\n\n*Your session key:*\n\`\`\`${fullSession}\`\`\`\n\n⚠️ *Keep this private! Don't share it with anyone.*\n\n📌 Copy and paste it as your SESSION env variable.`
          });

          console.log(`✅ Session saved: ${fullSession}`);

          setTimeout(() => {
            try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
            activeSessions.delete(sessionId);
          }, 5000);

        } catch (err) {
          console.error('❌ Error saving session:', err.message);
        }
      } else if (connection === 'close') {
        try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
        activeSessions.delete(sessionId);
      }
    });

    res.json({ success: true, sessionId });

  } catch (err) {
    try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
    res.json({ success: false, error: err.message });
  }
});

// ─── GET SESSION (for bots to fetch creds using short key) ───
app.get('/getsession', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.json({ success: false, error: 'No key provided' });
  try {
    const result = await pool.query(
      'SELECT creds FROM sessions WHERE session_key = $1',
      [key.toUpperCase()]
    );
    if (!result.rows.length) return res.json({ success: false, error: 'Session not found' });
    res.json({ success: true, creds: result.rows[0].creds });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ─── STATUS POLLING ───────────────────────────────────────────
app.get('/status/:sessionId', (req, res) => {
  const entry = activeSessions.get(req.params.sessionId);
  if (!entry) return res.json({ status: 'expired' });
  if (entry.session) return res.json({ status: 'connected', session: entry.session });
  if (entry.qr) return res.json({ status: 'qr', qr: entry.qr });
  res.json({ status: 'waiting' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BLACK-MD Session Generator running on port ${PORT}`));
