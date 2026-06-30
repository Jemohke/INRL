import express from 'express';
import fs from 'fs';
import pino from 'pino';
import QRCode from 'qrcode';
import { makeWASocket, useMultiFileAuthState, delay, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { saveSession } from './db.js';

const router = express.Router();

function removeFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
  } catch (e) {}
}

router.get('/', async (req, res) => {
  const dirs = `./temp_qr_${Date.now()}`;
  removeFile(dirs);

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).send('QR timeout — please refresh');
    }
  }, 25000);
  
  let retryCount = 0;
  const MAX_RETRIES = 3;

  async function initiateSession() {
    const { version } = await fetchLatestBaileysVersion();   
    const { state, saveCreds } = await useMultiFileAuthState(dirs);
    try {
      const logger = pino({ level: 'silent' });
      const sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        version,
        printQRInTerminal: false,
        logger,
        browser: Browsers.macOS('Desktop'),
      });

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr && !res.headersSent) {
          clearTimeout(timeout);
          const buf = await QRCode.toBuffer(qr);
          res.setHeader('Content-Type', 'image/png');
          res.end(buf);
        }

        if (connection === 'open') {
          try {
            await delay(5000);
            const creds = JSON.parse(fs.readFileSync(`${dirs}/creds.json`, 'utf8'));
            const sessionId = await saveSession(creds, 'qr');
            
await sock.sendMessage(sock.user.id, {
              text: `${sessionId}` });
            
            await sock.sendMessage(sock.user.id, {
              text: `╔══════════════════════╗\n║   🔐 BLACK-MD SESSION  \n╚══════════════════════╝\n\n☝️ *Above is Your session key:*\n\n⚠️ *Keep it private! Don't share it with anyone.*\n\n📌 Paste it as your SESSION env variable on deploy.`
            });

            console.log(`✅ QR session saved: ${sessionId}`);
          } catch (err) {
            console.error('❌ Error saving session:', err.message);
          } finally {
            await delay(1000);
            sock.end();
            removeFile(dirs);
          }
        } else if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          if (code !== 401 && retryCount < MAX_RETRIES) {
            retryCount++;
            await delay(5000);
            initiateSession();
          } else {
            removeFile(dirs);
          }
        }
      });

    } catch (err) {
      clearTimeout(timeout);
      console.error('Error:', err.message);
      if (!res.headersSent) res.status(503).send('Service Unavailable');
      removeFile(dirs);
    }
  }

  await initiateSession();
});

export default router;
