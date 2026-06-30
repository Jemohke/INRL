import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import pairRouter from './pair.js';
import qrRouter from './qr.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 8000;

import('events').then(e => { e.EventEmitter.defaultMaxListeners = 500; });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/code', pairRouter);
app.use('/qr', qrRouter);
app.use('/pair', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
app.use('/qr-page', (req, res) => res.sendFile(path.join(__dirname, 'qr-page.html')));

app.get('/ping', (req, res) => res.status(200).json({ status: 'alive', time: new Date().toISOString() }));
app.use('/', (req, res) => res.sendFile(path.join(__dirname, 'home.html')));

app.listen(PORT, () => {
  console.log(`🚀 BLACK-MD Session Generator on port ${PORT}`);

  const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${appUrl}/ping`);
      console.log(`🏓 Keep-alive ping sent → ${appUrl}/ping`);
    } catch (err) {
      console.warn(`⚠️ Keep-alive ping failed: ${err.message}`);
    }
  }, 10 * 60 * 1000);
});

export default app;
