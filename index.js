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
`).then(() => console.log('✅ Sessions table ready')).catch(console.error);

function generateKey() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const activeSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of activeSessions.entries()) {
    if (entry.closedAt && now - entry.closedAt > 30000) {
      activeSessions.delete(id);
    }
  }
}, 15000);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        try {
          const credsPath = path.join(sessionDir, 'creds.json');
          await new Promise(r => setTimeout(r, 3000));
          const creds = fs.readFileSync(credsPath, 'utf8');

          let sessionKey, saved = false;
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
          const entry = activeSessions.get(sessionId);
          if (entry) entry.session = fullSession;

          await sock.sendMessage(sock.user.id, {
            text: `╔══════════════════════╗\n║   🔐 BLACK-MD SESSION  \n╚══════════════════════╝\n\n*Your session key:*\n\`\`\`${fullSession}\`\`\`\n\n⚠️ *Keep this private! Don't share it with anyone.*\n\n📌 Copy and paste it as your SESSION env variable.`
          });

          console.log(`✅ Session saved: ${fullSession}`);
          setTimeout(() => {
            try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
            activeSessions.delete(sessionId);
          }, 10000);

        } catch (err) {
          console.error('❌ Error saving session:', err.message);
        }
      } else if (connection === 'close') {
        const entry = activeSessions.get(sessionId);
        if (entry) entry.closedAt = Date.now();
        try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
      }
    });

    res.json({ success: true, code: formatted, sessionId });

  } catch (err) {
    try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
    res.json({ success: false, error: err.message });
  }
});

app.post('/qr', async (req, res) => {
  const sessionId = 'session_' + Date.now();
  const sessionDir = path.join(__dirname, 'temp', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  let responded = false;

  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
      activeSessions.delete(sessionId);
      res.json({ success: false, error: 'Timed out waiting for QR. Please try again.' });
    }
  }, 20000);

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

    sock.ev.on('connection.update', async ({ connection, qr }) => {
      if (qr && !responded) {
        responded = true;
        clearTimeout(timeout);
        const qrImage = await QRCode.toDataURL(qr);
        const entry = activeSessions.get(sessionId);
        if (entry) entry.qr = qrImage;
        res.json({ success: true, sessionId, qr: qrImage });
      }

      if (connection === 'open') {
        try {
          const credsPath = path.join(sessionDir, 'creds.json');
          await new Promise(r => setTimeout(r, 3000));
          const creds = fs.readFileSync(credsPath, 'utf8');

          let sessionKey, saved = false;
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
          }, 10000);

        } catch (err) {
          console.error('❌ Error saving session:', err.message);
        }
      } else if (connection === 'close') {
        const entry = activeSessions.get(sessionId);
        if (entry) entry.closedAt = Date.now();
        try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
      }
    });

  } catch (err) {
    if (!responded) {
      responded = true;
      clearTimeout(timeout);
      try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
      activeSessions.delete(sessionId);
      res.json({ success: false, error: err.message });
    }
  }
});

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

app.get('/status/:sessionId', (req, res) => {
  const entry = activeSessions.get(req.params.sessionId);
  if (!entry) return res.json({ status: 'expired' });
  if (entry.session) return res.json({ status: 'connected', session: entry.session });
  if (entry.closedAt) return res.json({ status: 'expired' });
  if (entry.qr) return res.json({ status: 'qr', qr: entry.qr });
  res.json({ status: 'waiting' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BLACK-MD Session Generator running on port ${PORT}`));
