// ─── src/lib/anthropic.js ─────────────────────────────────────────
// Wrapper unico per chiamate all'API Anthropic.
// La chiave viene letta da process.env.ANTHROPIC_API_KEY e NON esce mai da qui.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '6000', 10);

// Prompt di estrazione SDS (identico a quello del client originale).
// Centralizzato qui in modo che posso aggiornarlo per tutti i clienti con un solo redeploy.
function buildSdsPrompt(filename) {
  return `Sei un esperto di schede di sicurezza (SDS/MSDS) secondo REACH.
Leggi SOLO le sezioni 1, 2, 3, 8, 9, 14, 15. Ignora tutto il resto.
Rispondi SOLO con array JSON valido, senza testo aggiuntivo o backtick.
Non inventare dati: usa "" se non trovato.

Per ogni prodotto estrai:
SEZ 1: nome_prodotto, codice_prodotto, numero_cas, numero_ce, numero_index, fornitore_nome, fornitore_indirizzo, fornitore_telefono, uso_raccomandato, numero_emergenza
SEZ 2: segnale_pericolo(solo:Pericolo|Avvertenza|Non classificato|""), pittogrammi, frasi_h, frasi_euh, frasi_p, altri_pericoli
SEZ 3: tipo_sostanza(Sostanza|Miscela|""), sostanze(array di oggetti con: nome,numero_cas,numero_ce,numero_index,concentrazione,classificazione), additivi
SEZ 8: vlep, misure_ingegneristiche, dpi_respiratorio, dpi_mani, dpi_occhi, dpi_corpo, dpi_note
SEZ 9: stato_fisico, colore, odore, ph, punto_ebollizione, punto_fusione, punto_infiammabilita, densita, solubilita, pressione_vapore, viscosita
SEZ 14: numero_onu, denominazione_spedizione, classe_adr, gruppo_imballaggio, pericoli_ambientali, codice_tunnel, trasporto_note
SEZ 15: reg_reach, reg_clp, reg_seveso, reg_voc, reg_altre

File: ${filename}`;
}

export async function extractSds({ pdfBase64, filename }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY non configurata sul server');

  const body = {
    model: DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: buildSdsPrompt(filename) }
      ]
    }]
  };

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await resp.json();

  if (!resp.ok) {
    // Non propagare messaggi interni Anthropic tali e quali verso il client.
    // Logghiamo lato server e ritorniamo un errore generico.
    console.error('[anthropic] errore API:', resp.status, data?.error);
    const msg = data?.error?.message || `Errore Anthropic (HTTP ${resp.status})`;
    const err = new Error(msg);
    err.statusCode = resp.status;
    err.isAnthropic = true;
    throw err;
  }

  // Estrae il JSON pulito dalla risposta (stesso parsing del client originale)
  const text = (data.content || []).map(b => b.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  let arr;
  try {
    arr = JSON.parse(clean);
  } catch {
    const m = clean.match(/\[[\s\S]*\]/);
    if (m) arr = JSON.parse(m[0]);
    else {
      const err = new Error('Risposta AI non parsabile come JSON');
      err.statusCode = 502;
      throw err;
    }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return {
    products: arr,
    usage: data.usage || null  // tokens usati, utile per metriche
  };
}
