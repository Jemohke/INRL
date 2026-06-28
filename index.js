require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
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

// entry shape: { sock, sessionDir, saveCreds, qr?, session?, error?, closedAt? }
const activeSessions = new Map();

// Clean up sessions older than 3 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of activeSessions.entries()) {
    if (entry.closedAt && now - entry.closedAt > 180000) {
      activeSessions.delete(id);
    }
  }
}, 30000);

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

  // Respond immediately so frontend can start polling
  activeSessions.set(sessionId, { sessionDir, status: 'connecting' });
  res.json({ success: true, sessionId });

  // Generate code in background
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    const entry = activeSessions.get(sessionId);
    if (entry) { entry.sock = sock; entry.saveCreds = saveCreds; }
    sock.ev.on('creds.update', saveCreds);

    // Give socket a moment to register before requesting pairing code
    await new Promise(r => setTimeout(r, 1500));

    let code;
    try {
      code = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ''));
    } catch (e) {
      const en = activeSessions.get(sessionId);
      if (en) { en.error = 'Failed to generate pairing code: ' + e.message; en.closedAt = Date.now(); }
      try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
      return;
    }

    const formatted = code.match(/.{1,4}/g).join('-');
    const pairEntry = activeSessions.get(sessionId);
    if (pairEntry) { pairEntry.code = formatted; pairEntry.codeAt = Date.now(); pairEntry.status = 'code'; }

    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        try {
          await new Promise(r => setTimeout(r, 3000));
          const credsPath = path.join(sessionDir, 'creds.json');
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
          const e2 = activeSessions.get(sessionId);
          if (e2) { e2.session = fullSession; e2.status = 'connected'; }

          await sock.sendMessage(sock.user.id, {
            text: `╔══════════════════════╗\n║   🔐 BLACK-MD SESSION  \n╚══════════════════════╝\n\n*Your session key:*\n\`\`\`${fullSession}\`\`\`\n\n⚠️ *Keep this private! Don't share it with anyone.*\n\n📌 Copy and paste it as your SESSION env variable.`
          });

          console.log(`✅ Session saved: ${fullSession}`);
          setTimeout(() => {
            try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
            activeSessions.delete(sessionId);
          }, 30000);

        } catch (err) {
          console.error('❌ Error saving session:', err.message);
        }
      } else if (connection === 'close') {
        const ec = activeSessions.get(sessionId);
        if (ec && !ec.session) { ec.closedAt = Date.now(); ec.status = 'expired'; }
        try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
      }
    });

  } catch (err) {
    const ef = activeSessions.get(sessionId);
    if (ef) { ef.error = err.message; ef.closedAt = Date.now(); ef.status = 'expired'; }
    try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
  }
});

// ─── QR CODE ─────────────────────────────────────────────────
app.post('/qr', async (req, res) => {
  const sessionId = 'session_' + Date.now();
  const sessionDir = path.join(__dirname, 'temp', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Respond immediately — QR generated in background
  activeSessions.set(sessionId, { sessionDir, status: 'connecting' });
  res.json({ success: true, sessionId });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    const entry = activeSessions.get(sessionId);
    if (entry) { entry.sock = sock; entry.saveCreds = saveCreds; }
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, qr }) => {
      if (qr) {
        const qrImage = await QRCode.toDataURL(qr);
        const eq = activeSessions.get(sessionId);
        if (eq) { eq.qr = qrImage; eq.status = 'qr'; }
      }

      if (connection === 'open') {
        try {
          await new Promise(r => setTimeout(r, 3000));
          const credsPath = path.join(sessionDir, 'creds.json');
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
          const eo = activeSessions.get(sessionId);
          if (eo) { eo.session = fullSession; eo.status = 'connected'; }

          await sock.sendMessage(sock.user.id, {
            text: `╔══════════════════════╗\n║   🔐 BLACK-MD SESSION  \n╚══════════════════════╝\n\n*Your session key:*\n\`\`\`${fullSession}\`\`\`\n\n⚠️ *Keep this private! Don't share it with anyone.*\n\n📌 Copy and paste it as your SESSION env variable.`
          });

          console.log(`✅ Session saved: ${fullSession}`);
          setTimeout(() => {
            try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
            activeSessions.delete(sessionId);
          }, 30000);

        } catch (err) {
          console.error('❌ Error saving session:', err.message);
        }
      } else if (connection === 'close') {
        const ec = activeSessions.get(sessionId);
        if (ec && !ec.session) { ec.closedAt = Date.now(); ec.status = 'expired'; }
        try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
      }
    });

  } catch (err) {
    const ef = activeSessions.get(sessionId);
    if (ef) { ef.error = err.message; ef.closedAt = Date.now(); ef.status = 'expired'; }
    try { fs.rmSync(sessionDir, { recursive: true }); } catch {}
  }
});

// ─── GET SESSION ──────────────────────────────────────────────
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

  switch (entry.status) {
    case 'connected': return res.json({ status: 'connected', session: entry.session });
    case 'qr':        return res.json({ status: 'qr', qr: entry.qr });
    case 'code':      return res.json({ status: 'code', code: entry.code, codeAt: entry.codeAt });
    case 'expired':   return res.json({ status: 'expired', error: entry.error });
    default:          return res.json({ status: 'connecting' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BLACK-MD Session Generator running on port ${PORT}`));
