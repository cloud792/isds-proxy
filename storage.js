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
//       "2025-10": { included: 18, extra: 0 },
//       "2025-11": { included: 100, extra: 7 }
//     },
//     "lastUsedAt": "2025-11-20T11:03:00.000Z"
//   }
// }
export async function loadUsage() {
  return await readJson(USAGE_PATH, {});
}

export async function getUsage(code) {
  const usage = await loadUsage();
  return usage[code] || { total: 0, byMonth: {}, lastUsedAt: null };
}

export async function incrementUsage(code, isExtra) {
  return await withLock('usage', async () => {
    const usage = await readJson(USAGE_PATH, {});
    const month = new Date().toISOString().slice(0, 7); // "2025-11"
    const entry = usage[code] || { total: 0, byMonth: {}, lastUsedAt: null };
    entry.total = (entry.total || 0) + 1;
    entry.byMonth[month] = entry.byMonth[month] || { included: 0, extra: 0 };
    if (isExtra) entry.byMonth[month].extra += 1;
    else entry.byMonth[month].included += 1;
    entry.lastUsedAt = new Date().toISOString();
    usage[code] = entry;
    await writeJsonAtomic(USAGE_PATH, usage);
    return entry;
  });
}
