import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, delay, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import { saveSession } from './db.js';

const router = express.Router();

function removeFile(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
  } catch (e) {}
}

router.get('/', async (req, res) => {
  const num = req.query.number;
  if (!num) return res.status(400).json({ code: 'Number required' });

  const dirs = `./temp_pair_${num}_${Date.now()}`;
  removeFile(dirs);

  let retryCount = 0;
  const MAX_RETRIES = 3;

  async function initiateSession() {
    const { version } = await fetchLatestBaileysVersion();  
    const { state, saveCreds } = await useMultiFileAuthState(dirs);
    try {
      const sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
        },
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.windows('Edge'),
      });

      if (!sock.authState.creds.registered) {
        await delay(1500);
        const code = await sock.requestPairingCode(num.replace(/[^0-9]/g, ''));
        if (!res.headersSent) {
          console.log({ num, code });
          res.json({ code });
        }
      }

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
          try {
            await delay(5000);
            const creds = JSON.parse(fs.readFileSync(`${dirs}/creds.json`, 'utf8'));
            const sessionId = await saveSession(creds, num);

            await sock.sendMessage(sock.user.id, {
              text: `╔══════════════════════╗\n║   🔐 BLACK-MD SESSION  \n╚══════════════════════╝\n\n*Your session key:*\n\`\`\`${sessionId}\`\`\`\n\n⚠️ *Keep this private! Don't share it with anyone.*\n\n📌 Paste it as your SESSION env variable on deploy.`
            });

            console.log(`✅ Session saved for ${num}: ${sessionId}`);
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
            console.log(`Retrying ${retryCount}/${MAX_RETRIES}...`);
            await delay(5000);
            initiateSession();
          } else {
            removeFile(dirs);
          }
        }
      });

    } catch (err) {
      console.error('Error:', err.message);
      if (!res.headersSent) res.status(503).json({ code: 'Service Unavailable' });
      removeFile(dirs);
    }
  }

  await initiateSession();
});

export default router;
