// ─── src/lib/plans.js ─────────────────────────────────────────────
// Definizione piani iSDS e logica crediti server-side.
// Deve rispecchiare quanto promesso nella brochure commerciale.

export const PLANS = {
  payperuse:    { name: 'A consumo',   included: 0,   extraEur: 5.00, ppu: true  },
  starter:      { name: 'Starter',     included: 20,  extraEur: 0.99, ppu: false },
  professional: { name: 'Professional',included: 100, extraEur: 0.79, ppu: false },
  business:     { name: 'Business',    included: 300, extraEur: 0.49, ppu: false }
};

export function getPlan(planKey) {
  return PLANS[planKey] || PLANS.starter;
}

// Calcola crediti residui nel mese corrente.
// Ritorna { remaining, isExtra } dove:
//   - remaining = analisi incluse ancora disponibili (0 se esaurite / piano ppu)
//   - isExtra   = true se la prossima analisi è extra
export function computeRemaining(planKey, monthUsage) {
  const plan = getPlan(planKey);
  if (plan.ppu) return { remaining: 0, isExtra: true };
  const included = (monthUsage && monthUsage.included) || 0;
  const remaining = Math.max(0, plan.included - included);
  return { remaining, isExtra: remaining === 0 };
}

// Verifica se il codice è ancora valido (non scaduto, non bloccato).
// Ritorna { ok: true } oppure { ok: false, reason: '...' }
export function validateCode(codeData) {
  if (!codeData) return { ok: false, reason: 'Codice non trovato' };
  if (codeData.stato === 'bloccato') return { ok: false, reason: 'Codice bloccato. Contatta ERIS.' };
  if (codeData.stato === 'sospeso')  return { ok: false, reason: 'Codice sospeso. Contatta ERIS.' };

  // Se il codice è già stato usato almeno una volta, verifica scadenza
  if (codeData.firstUse && codeData.expiresAt) {
    const now = new Date();
    const exp = new Date(codeData.expiresAt);
    if (now > exp) return { ok: false, reason: 'Codice scaduto. Contatta ERIS per rinnovare.' };
  }
  return { ok: true };
}
