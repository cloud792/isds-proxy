// ─── src/middleware/admin.js ──────────────────────────────────────
// Middleware per proteggere gli endpoint /admin/*.
// Richiede header: Authorization: Bearer <ADMIN_TOKEN>

export function adminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || token === 'cambiami-con-un-token-lungo-e-casuale') {
    return res.status(500).json({ ok: false, error: 'ADMIN_TOKEN non configurato sul server' });
  }
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided) {
    return res.status(401).json({ ok: false, error: 'Token admin mancante' });
  }
  // Confronto timing-safe per evitare attacchi timing attack sul token
  if (!timingSafeEqual(provided, token)) {
    return res.status(403).json({ ok: false, error: 'Token admin non valido' });
  }
  next();
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
