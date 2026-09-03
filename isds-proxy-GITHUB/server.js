// ─── src/server.js ────────────────────────────────────────────────
// Proxy server ERIS per iSDS.
// Valida codici cliente, inoltra richieste AI a Anthropic, traccia consumi.

import express from 'express';
import cors from 'cors';
import publicRoutes from './public.js';
import adminRoutes from './admin.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ─────────────────────────────────────────────────────────
// Il client iSDS può essere aperto sia da un dominio (https://isds.eris-srl.com)
// sia da file:// (apertura locale del .html → Origin = "null")
// Configurabile via ALLOWED_ORIGINS
const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (allowed.includes('*')) return cb(null, true);
    if (!origin) return cb(null, true);  // curl, server-to-server
    if (allowed.includes(origin)) return cb(null, true);
    // file:// viene passato come origin "null" (stringa)
    if (allowed.includes('null') && origin === 'null') return cb(null, true);
    cb(new Error('Origin non consentito: ' + origin));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─── BODY PARSER ──────────────────────────────────────────────────
// I PDF in base64 possono essere grandi (5-10 MB). Alziamo il limite a 25 MB.
app.use(express.json({ limit: '25mb' }));

// ─── LOG REQUEST ──────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ─── HEALTHCHECK ──────────────────────────────────────────────────
// Railway lo chiama periodicamente per verificare che il servizio sia vivo
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'isds-proxy',
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Root → messaggio diagnostico minimo (nessuna info sensibile)
app.get('/', (req, res) => {
  res.type('text/plain').send('iSDS Proxy ERIS — vedi /health per status.');
});

// ─── ROUTES ───────────────────────────────────────────────────────
app.use('/api', publicRoutes);
app.use('/admin', adminRoutes);

// ─── ERROR HANDLER ────────────────────────────────────────────────
// Cattura errori non gestiti e non espone stack trace al client
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  if (err.message && err.message.startsWith('Origin non consentito')) {
    return res.status(403).json({ ok: false, error: 'CORS non consentito' });
  }
  res.status(500).json({ ok: false, error: 'Errore interno del server' });
});

// 404 per route inesistenti
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint non trovato' });
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`iSDS proxy ERIS in ascolto su :${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠ ANTHROPIC_API_KEY non impostata — /api/extract fallirà');
  }
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN === 'cambiami-con-un-token-lungo-e-casuale') {
    console.warn('⚠ ADMIN_TOKEN non configurato — /admin/* non funzionerà');
  }
});
