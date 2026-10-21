// ─── src/lib/storage.js ───────────────────────────────────────────
// Storage semplice su file JSON con write atomico.
// Adatto a 10-50 clienti con traffico moderato. Per volumi maggiori
// migrare a SQLite (better-sqlite3) o Postgres.

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');
const CODES_PATH = path.join(DATA_DIR, 'codes.json');
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');

// Lock in-memory per evitare race su scritture concorrenti.
// Sufficiente finché gira un solo processo (Railway = 1 istanza).
const locks = new Map();
async function withLock(key, fn) {
  while (locks.get(key)) await locks.get(key);
  let release;
  const promise = new Promise(r => { release = r; });
  locks.set(key, promise);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const txt = await fs.readFile(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// Write atomico: scrivi su .tmp, poi rename (operazione atomica sul fs).
// Evita di corrompere il file se il processo crasha a metà scrittura.
async function writeJsonAtomic(filePath, data) {
  await ensureDir();
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

// ─── CODICI CLIENTI ───────────────────────────────────────────────
// Shape del file codes.json:
// {
//   "ISDS-2025-ALFA-0001": {
//     "cliente": "Chimici Rossi S.r.l.",
//     "piano": "professional",          // payperuse | starter | professional | business
//     "giorni": 365,
//     "createdAt": "2025-10-01T10:00:00.000Z",
//     "firstUse": "2025-10-05T14:22:00.000Z",  // compilato al primo utilizzo
//     "expiresAt": "2026-10-05T14:22:00.000Z", // calcolato al primo utilizzo
//     "stato": "attivo",                // attivo | sospeso | bloccato
//     "note": ""
//   }
// }
export async function loadCodes() {
  return await readJson(CODES_PATH, {});
}

export async function saveCodes(codes) {
  return await withLock('codes', () => writeJsonAtomic(CODES_PATH, codes));
}

export async function getCode(code) {
  const codes = await loadCodes();
  return codes[code] || null;
}

export async function upsertCode(code, data) {
  return await withLock('codes', async () => {
    const codes = await readJson(CODES_PATH, {});
    codes[code] = { ...(codes[code] || {}), ...data };
    await writeJsonAtomic(CODES_PATH, codes);
    return codes[code];
  });
}

export async function deleteCode(code) {
  return await withLock('codes', async () => {
    const codes = await readJson(CODES_PATH, {});
    const existed = code in codes;
    delete codes[code];
    await writeJsonAtomic(CODES_PATH, codes);
    return existed;
  });
}

// ─── USAGE / CONTATORI ────────────────────────────────────────────
// Shape del file usage.json:
// {
//   "ISDS-2025-ALFA-0001": {
//     "total": 42,                        // analisi totali lifetime
//     "byMonth": {
//       "2025-10": { included: 18, extra: 0, inTok: 90000, outTok: 42000, costUsd: 0.9 },
//       "2025-11": { included: 100, extra: 7, inTok: ..., outTok: ..., costUsd: ... }
//     },
//     "tokIn": 132000,                     // token input lifetime
//     "tokOut": 61000,                     // token output lifetime
//     "costUsd": 1.8,                      // costo API lifetime (USD, stima da listino)
//     "maxCostUsd": 0.083,                 // scheda singola più cara vista (per diagnosi)
//     "lastUsedAt": "2025-11-20T11:03:00.000Z"
//   }
// }

// Prezzo di listino del modello (USD per 1 MILIONE di token).
// Aggiornabili via env senza toccare il codice.
const PRICE_IN_PER_M  = parseFloat(process.env.PRICE_IN_PER_M  || '3');   // input  $/Mtok
const PRICE_OUT_PER_M = parseFloat(process.env.PRICE_OUT_PER_M || '15');  // output $/Mtok

export function costOfTokens(inTok, outTok) {
  const i = (Number(inTok) || 0) / 1e6 * PRICE_IN_PER_M;
  const o = (Number(outTok) || 0) / 1e6 * PRICE_OUT_PER_M;
  return i + o;
}

export async function loadUsage() {
  return await readJson(USAGE_PATH, {});
}

export async function getUsage(code) {
  const usage = await loadUsage();
  return usage[code] || { total: 0, byMonth: {}, lastUsedAt: null };
}

// tokens = { input_tokens, output_tokens } (dal campo usage di Anthropic), opzionale.
export async function incrementUsage(code, isExtra, tokens) {
  return await withLock('usage', async () => {
    const usage = await readJson(USAGE_PATH, {});
    const month = new Date().toISOString().slice(0, 7); // "2025-11"
    const entry = usage[code] || { total: 0, byMonth: {}, lastUsedAt: null };
    entry.total = (entry.total || 0) + 1;
    const m = entry.byMonth[month] || { included: 0, extra: 0 };
    if (isExtra) m.extra = (m.extra || 0) + 1;
    else m.included = (m.included || 0) + 1;

    // ── Metriche token/costo (se il proxy le ha passate) ──
    if (tokens) {
      const inTok  = Number(tokens.input_tokens)  || 0;
      const outTok = Number(tokens.output_tokens) || 0;
      const cost   = costOfTokens(inTok, outTok);
      m.inTok   = (m.inTok   || 0) + inTok;
      m.outTok  = (m.outTok  || 0) + outTok;
      m.costUsd = (m.costUsd || 0) + cost;
      entry.tokIn    = (entry.tokIn    || 0) + inTok;
      entry.tokOut   = (entry.tokOut   || 0) + outTok;
      entry.costUsd  = (entry.costUsd  || 0) + cost;
      if (cost > (entry.maxCostUsd || 0)) entry.maxCostUsd = cost;
    }

    entry.byMonth[month] = m;
    entry.lastUsedAt = new Date().toISOString();
    usage[code] = entry;
    await writeJsonAtomic(USAGE_PATH, usage);
    return entry;
  });
}
