// ─── src/routes/admin.js ──────────────────────────────────────────
// Route admin protette da Bearer token (ADMIN_TOKEN).
// Permettono di: gestire codici clienti, vedere statistiche uso.

import express from 'express';
import crypto from 'node:crypto';
import { loadCodes, upsertCode, deleteCode, loadUsage, getUsage, costOfTokens } from './storage.js';
import { getPlan } from './plans.js';
import { adminAuth } from './middleware-admin.js';

const router = express.Router();

router.use(adminAuth); // Tutte le route qui sotto richiedono il token admin

// ─── GET /admin/codes ─────────────────────────────────────────────
// Lista tutti i codici clienti con stato e info base
router.get('/codes', async (req, res) => {
  const codes = await loadCodes();
  const usage = await loadUsage();
  const now = new Date();

  const list = Object.entries(codes).map(([code, entry]) => {
    const u = usage[code] || { total: 0, byMonth: {} };
    let status = entry.stato || 'attivo';
    if (entry.expiresAt && new Date(entry.expiresAt) < now) status = 'scaduto';
    const plan = getPlan(entry.piano);
    return {
      code,
      cliente: entry.cliente,
      piano: entry.piano || 'starter',
      planName: plan.name,
      giorni: entry.giorni,
      createdAt: entry.createdAt,
      firstUse: entry.firstUse,
      expiresAt: entry.expiresAt,
      stato: status,
      totalExtractions: u.total,
      lastUsedAt: u.lastUsedAt
    };
  });

  // Ordina: attivi prima, per data di creazione decrescente
  list.sort((a, b) => {
    if (a.stato !== b.stato) return a.stato === 'attivo' ? -1 : 1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });

  res.json({ ok: true, total: list.length, codes: list });
});

// ─── POST /admin/codes ────────────────────────────────────────────
// Crea o aggiorna un codice cliente
// Body: { code, cliente, piano, giorni, stato?, note? }
// Se code è omesso, ne genera uno automatico nel formato ISDS-YYYY-XXXXXX
router.post('/codes', async (req, res) => {
  let { code, cliente, piano, giorni, stato, note } = req.body || {};

  if (!cliente) return res.status(400).json({ ok: false, error: 'cliente obbligatorio' });
  piano = piano || 'starter';
  if (!getPlan(piano) || !(piano in { payperuse:1, starter:1, professional:1, business:1 })) {
    return res.status(400).json({ ok: false, error: 'piano non valido' });
  }
  giorni = parseInt(giorni || 365, 10);

  // Se il codice non è fornito, ne generiamo uno univoco
  if (!code) {
    const year = new Date().getFullYear();
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    code = `ISDS-${year}-${rand}`;
  }
  code = String(code).trim().toUpperCase();

  const existing = await (await import('./storage.js')).getCode(code);
  const payload = {
    cliente,
    piano,
    giorni,
    stato: stato || 'attivo',
    note: note || '',
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  const saved = await upsertCode(code, payload);
  res.json({ ok: true, code, data: saved });
});

// ─── PATCH /admin/codes/:code ─────────────────────────────────────
// Modifica parziale di un codice (es. cambiare piano, bloccare, aggiungere nota)
router.patch('/codes/:code', async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const { piano, giorni, stato, note, cliente } = req.body || {};
  const patch = {};
  if (cliente !== undefined) patch.cliente = cliente;
  if (piano !== undefined)   patch.piano = piano;
  if (giorni !== undefined)  patch.giorni = parseInt(giorni, 10);
  if (stato !== undefined)   patch.stato = stato;
  if (note !== undefined)    patch.note = note;

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ ok: false, error: 'nessun campo da modificare' });
  }
  const saved = await upsertCode(code, patch);
  res.json({ ok: true, code, data: saved });
});

// ─── DELETE /admin/codes/:code ────────────────────────────────────
router.delete('/codes/:code', async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const existed = await deleteCode(code);
  if (!existed) return res.status(404).json({ ok: false, error: 'codice non trovato' });
  res.json({ ok: true, deleted: code });
});

// ─── GET /admin/usage ─────────────────────────────────────────────
// Statistiche globali di utilizzo
router.get('/usage', async (req, res) => {
  const usage = await loadUsage();
  const codes = await loadCodes();
  const month = new Date().toISOString().slice(0, 7);

  let totalMonth = 0, totalLifetime = 0, extraMonth = 0;
  const perClient = [];

  for (const [code, u] of Object.entries(usage)) {
    const mu = u.byMonth[month] || { included: 0, extra: 0 };
    totalMonth += mu.included + mu.extra;
    extraMonth += mu.extra;
    totalLifetime += u.total || 0;
    const c = codes[code];
    perClient.push({
      code,
      cliente: c?.cliente || '(codice rimosso)',
      piano: c?.piano || '-',
      monthIncluded: mu.included,
      monthExtra: mu.extra,
      total: u.total,
      lastUsedAt: u.lastUsedAt
    });
  }

  perClient.sort((a, b) => (b.monthIncluded + b.monthExtra) - (a.monthIncluded + a.monthExtra));

  res.json({
    ok: true,
    month,
    summary: { totalMonth, extraMonth, totalLifetime, activeCodes: Object.keys(codes).length },
    clients: perClient
  });
});

// ─── GET /admin/usage/:code ───────────────────────────────────────
// Dettaglio uso di un singolo cliente
router.get('/usage/:code', async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const u = await getUsage(code);
  res.json({ ok: true, code, usage: u });
});

// ─── GET /admin/costs ─────────────────────────────────────────────
// Costi API REALI (dai token restituiti da Anthropic), aggregati.
// Visibile SOLO all'admin (protetto da ADMIN_TOKEN). Mai esposto ai clienti.
// Query opzionale: ?month=YYYY-MM (default: mese corrente)
router.get('/costs', async (req, res) => {
  const usage = await loadUsage();
  const codes = await loadCodes();
  const month = (req.query?.month && /^\d{4}-\d{2}$/.test(req.query.month))
    ? req.query.month
    : new Date().toISOString().slice(0, 7);

  const PRICE_IN_PER_M  = parseFloat(process.env.PRICE_IN_PER_M  || '3');
  const PRICE_OUT_PER_M = parseFloat(process.env.PRICE_OUT_PER_M || '15');

  let life = { n: 0, inTok: 0, outTok: 0, costUsd: 0 };
  let cur  = { n: 0, inTok: 0, outTok: 0, costUsd: 0 };
  let maxSingleUsd = 0;
  const perClient = [];

  for (const [code, u] of Object.entries(usage)) {
    const mu = u.byMonth?.[month] || {};
    const mN = (mu.included || 0) + (mu.extra || 0);
    // lifetime
    life.n     += u.total || 0;
    life.inTok += u.tokIn || 0;
    life.outTok+= u.tokOut || 0;
    life.costUsd += u.costUsd || 0;
    if ((u.maxCostUsd || 0) > maxSingleUsd) maxSingleUsd = u.maxCostUsd || 0;
    // mese richiesto
    cur.n      += mN;
    cur.inTok  += mu.inTok || 0;
    cur.outTok += mu.outTok || 0;
    cur.costUsd+= mu.costUsd || 0;

    const c = codes[code];
    const label = code.startsWith('firebase:')
      ? (c?.cliente || 'Utente area riservata')
      : (c?.cliente || '(codice rimosso)');
    perClient.push({
      code,
      cliente: label,
      piano: c?.piano || '-',
      monthN: mN,
      monthInTok: mu.inTok || 0,
      monthOutTok: mu.outTok || 0,
      monthCostUsd: +(mu.costUsd || 0).toFixed(4),
      monthAvgUsd: mN ? +((mu.costUsd || 0) / mN).toFixed(4) : 0,
      lifeN: u.total || 0,
      lifeCostUsd: +(u.costUsd || 0).toFixed(4),
      maxSingleUsd: +(u.maxCostUsd || 0).toFixed(4),
      lastUsedAt: u.lastUsedAt
    });
  }

  perClient.sort((a, b) => b.monthCostUsd - a.monthCostUsd);

  const avgLifeUsd = life.n ? life.costUsd / life.n : 0;
  const avgCurUsd  = cur.n  ? cur.costUsd  / cur.n  : 0;
  const hasTokenData = life.inTok > 0 || life.outTok > 0;

  res.json({
    ok: true,
    month,
    pricing: { inPerM: PRICE_IN_PER_M, outPerM: PRICE_OUT_PER_M, currency: 'USD', model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5' },
    hasTokenData,            // false = nessuna estrazione dopo l'aggiornamento proxy
    lifetime: {
      n: life.n, inTok: life.inTok, outTok: life.outTok,
      costUsd: +life.costUsd.toFixed(4),
      avgUsd: +avgLifeUsd.toFixed(4),
      maxSingleUsd: +maxSingleUsd.toFixed(4)
    },
    current: {
      n: cur.n, inTok: cur.inTok, outTok: cur.outTok,
      costUsd: +cur.costUsd.toFixed(4),
      avgUsd: +avgCurUsd.toFixed(4)
    },
    clients: perClient
  });
});

export default router;
