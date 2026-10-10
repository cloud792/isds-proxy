// ─── src/routes/public.js ─────────────────────────────────────────
// Route pubbliche chiamate dal client iSDS_Completo.html.

import express from 'express';
import { getCode, upsertCode, getUsage, incrementUsage } from './storage.js';
import { getPlan, computeRemaining, validateCode } from './plans.js';
import { extractSds } from './anthropic.js';
import { verifyFirebaseToken } from './firebaseAuth.js';

const router = express.Router();

// Helper: normalizza il codice (uppercase + trim) per evitare errori di casing
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Helper: current month "YYYY-MM"
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

// ─── POST /api/activate ───────────────────────────────────────────
// Prima attivazione del codice sul dispositivo del cliente.
// Il client chiama questa route quando l'utente inserisce il codice
// nella schermata di attivazione. Al primo utilizzo valido, compiliamo
// firstUse + expiresAt.
router.post('/activate', async (req, res) => {
  const code = normalizeCode(req.body?.code);
  if (!code) return res.status(400).json({ ok: false, error: 'Codice mancante' });

  const entry = await getCode(code);
  const check = validateCode(entry);
  if (!check.ok) return res.status(403).json({ ok: false, error: check.reason });

  // Se non c'è ancora un firstUse, lo inizializziamo ora
  let updated = entry;
  if (!entry.firstUse) {
    const now = new Date();
    const firstUse = now.toISOString();
    const exp = new Date(now.getTime() + (entry.giorni || 365) * 24 * 60 * 60 * 1000);
    updated = await upsertCode(code, {
      firstUse,
      expiresAt: exp.toISOString()
    });
  }

  return res.json({
    ok: true,
    cliente: updated.cliente,
    piano: updated.piano || 'starter',
    expiresAt: updated.expiresAt,
    giorni: updated.giorni
  });
});

// ─── GET /api/status ──────────────────────────────────────────────
// Il client chiama questa route al caricamento e periodicamente
// per sapere: stato codice, piano, crediti residui mese corrente.
// Query: ?code=ISDS-2025-...
router.get('/status', async (req, res) => {
  const code = normalizeCode(req.query?.code);
  if (!code) return res.status(400).json({ ok: false, error: 'Codice mancante' });

  const entry = await getCode(code);
  const check = validateCode(entry);
  if (!check.ok) return res.status(403).json({ ok: false, error: check.reason });

  const usage = await getUsage(code);
  const monthUsage = usage.byMonth[currentMonth()] || { included: 0, extra: 0 };
  const plan = getPlan(entry.piano);
  const { remaining, isExtra } = computeRemaining(entry.piano, monthUsage);

  return res.json({
    ok: true,
    cliente: entry.cliente,
    piano: entry.piano || 'starter',
    planName: plan.name,
    included: plan.included,
    extraEur: plan.extraEur,
    ppu: plan.ppu,
    remaining,
    isNextExtra: isExtra,
    monthUsage,
    totalLifetime: usage.total,
    expiresAt: entry.expiresAt,
    stato: entry.stato || 'attivo'
  });
});

// ─── POST /api/extract ────────────────────────────────────────────
// Il cuore: riceve un PDF in base64, valida il codice, inoltra a
// Anthropic con la chiave del server, registra il consumo.
// Body: { code, pdf_base64, filename }
router.post('/extract', async (req, res) => {
  const code = normalizeCode(req.body?.code);
  const pdfBase64 = req.body?.pdf_base64;
  const filename = req.body?.filename || 'documento.pdf';

  if (!pdfBase64) return res.status(400).json({ ok: false, error: 'PDF mancante' });

  // ─── AUTORIZZAZIONE: due modalità ───────────────────────────────
  // A) Token Firebase (nuovo modello ad area riservata): header
  //    Authorization: Bearer <idToken>  oppure  body.firebase_token
  // B) Codice cliente (modello legacy a file distribuiti): body.code
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const fbToken = bearer || req.body?.firebase_token || null;

  let entry = null;      // dati piano (solo per il modello a codici)
  let isFirebase = false;
  let fbUser = null;

  if (fbToken) {
    // Modalità Firebase: verifico il token. Se valido, utente autorizzato.
    try {
      fbUser = await verifyFirebaseToken(fbToken);
      isFirebase = true;
    } catch (e) {
      return res.status(401).json({ ok: false, error: 'Autenticazione Firebase non valida: ' + e.message });
    }
  } else {
    // Modalità codice (legacy)
    if (!code) return res.status(400).json({ ok: false, error: 'Autenticazione mancante (codice o token)' });
    entry = await getCode(code);
    const check = validateCode(entry);
    if (!check.ok) return res.status(403).json({ ok: false, error: check.reason });
  }

  // Determina se l'analisi sarà extra (solo nel modello a codici;
  // nel modello Firebase l'uso è tracciato a parte / illimitato per l'utente autorizzato)
  let isExtra = false;
  if (!isFirebase) {
    const usage = await getUsage(code);
    const monthUsage = usage.byMonth[currentMonth()] || { included: 0, extra: 0 };
    isExtra = computeRemaining(entry.piano, monthUsage).isExtra;
  }

  // 3. Chiama Anthropic
  let result;
  try {
    result = await extractSds({ pdfBase64, filename });
  } catch (err) {
    console.error('[extract] errore anthropic per', code, ':', err.message);
    return res.status(err.statusCode || 502).json({
      ok: false,
      error: err.message || 'Errore durante l\'estrazione AI'
    });
  }

  // Registra il consumo e prepara la risposta
  if (isFirebase) {
    // Modello Firebase: log minimale per-utente (traccia uso senza billing a codice)
    try { await incrementUsage('firebase:' + fbUser.sub, false); } catch(e) {}
    return res.json({
      ok: true,
      products: result.products,
      billed: { isExtra: false, amountEur: 0 },
      user: { uid: fbUser.sub, email: fbUser.email || null },
      tokens: result.usage
    });
  }

  // Modello a codici (legacy)
  await incrementUsage(code, isExtra);
  const newMonthUsage = (await getUsage(code)).byMonth[currentMonth()];
  const { remaining, isExtra: nextIsExtra } = computeRemaining(entry.piano, newMonthUsage);
  return res.json({
    ok: true,
    products: result.products,
    billed: { isExtra, amountEur: isExtra ? getPlan(entry.piano).extraEur : 0 },
    remaining,
    isNextExtra: nextIsExtra,
    tokens: result.usage
  });
});

export default router;
