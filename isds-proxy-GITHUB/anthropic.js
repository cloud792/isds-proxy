// ─── src/lib/anthropic.js ─────────────────────────────────────────
// Wrapper unico per chiamate all'API Anthropic.
// La chiave viene letta da process.env.ANTHROPIC_API_KEY e NON esce mai da qui.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '8000', 10);

// Marcatore di versione del prompt: compare nella risposta /extract (campo _prompt_version).
// Serve SOLO per verificare quale build sta girando davvero su Railway.
const PROMPT_VERSION = 'sez-7-10-v3';

// Prompt di estrazione SDS (identico a quello del client originale).
// Centralizzato qui in modo che posso aggiornarlo per tutti i clienti con un solo redeploy.
function buildSdsPrompt(filename) {
  return `Sei un esperto di schede di sicurezza (SDS/MSDS) secondo REACH.
Leggi SOLO le sezioni 1, 2, 3, 7, 8, 9, 10, 14, 15. Ignora tutto il resto.
IMPORTANTE: se la scheda e' in inglese o altra lingua, TRADUCI SEMPRE in ITALIANO tutti i valori testuali descrittivi (es. stato fisico, colore, odore, usi, misure, DPI, note, denominazioni, condizioni, reattivita'). NON tradurre invece: codici tecnici (H###, EUH###, P###), numeri CAS/CE/Index/ONU, formule, sigle normative, nomi chimici IUPAC ufficiali.
Rispondi SOLO con array JSON valido, senza testo aggiuntivo o backtick.
Non inventare dati: usa "" se non trovato. Per i campi delle SEZ 7 e 10 includi SEMPRE la chiave anche se il valore e' "" (stringa vuota).

Per ogni prodotto estrai:
SEZ 1: nome_prodotto, codice_prodotto, numero_cas, numero_ce, numero_index, fornitore_nome, fornitore_indirizzo, fornitore_telefono, uso_raccomandato, numero_emergenza
SEZ 2: segnale_pericolo(solo:Pericolo|Avvertenza|Non classificato|""), pittogrammi, frasi_h, frasi_euh, frasi_p, altri_pericoli
SEZ 3: tipo_sostanza(Sostanza|Miscela|""), sostanze(array di oggetti con: nome,numero_cas,numero_ce,numero_index,concentrazione,classificazione), additivi
SEZ 7: stoccaggio_condizioni, stoccaggio_temperatura, stoccaggio_incompatibili, manipolazione_precauzioni, manipolazione_condizioni_evitare
SEZ 8: vlep, misure_ingegneristiche, dpi_respiratorio, dpi_mani, dpi_occhi, dpi_corpo, dpi_note
SEZ 9: stato_fisico, colore, odore, ph, punto_ebollizione, punto_fusione, punto_infiammabilita, densita, solubilita, pressione_vapore, viscosita
SEZ 10: reattivita, stabilita_chimica, reazioni_pericolose, condizioni_da_evitare, materiali_incompatibili, prodotti_decomposizione
SEZ 14: numero_onu, denominazione_spedizione, classe_adr, gruppo_imballaggio, pericoli_ambientali, codice_tunnel, trasporto_note
SEZ 15: reg_reach, reg_clp, reg_seveso, reg_voc, reg_altre

CLASSIFICAZIONE CHIMICA (per analisi incompatibilita') — in aggiunta, deduci dai dati della scheda:
famiglie_chimiche: array con le famiglie a cui appartiene il prodotto, SOLO tra questi valori esatti: ["acido_forte","acido_debole","base_forte","base_debole","ossidante","riducente","infiammabile","comburente","perossido","metallo_reattivo","composto_organico","solvente_organico","alogenato","cianuro","ipoclorito","nitrato","sale_inorganico","gas_compresso","tossico","corrosivo","acqua_reattivo"]. Scegli solo quelle davvero pertinenti in base a pH, frasi H, composizione, reattivita'. Usa [] se non determinabile.
famiglie_incompatibili: array con le famiglie (stesso elenco sopra) che la scheda indica come incompatibili con questo prodotto (dalla sez 10 "materiali incompatibili"). [] se non indicato.
seveso_categoria: se la sez 15 cita il D.Lgs 105/2015 (Seveso) o categorie Seveso (es. P5a, H2, E1...), riportale; altrimenti "".

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
        { type: 'docum
