// ─── src/lib/firebaseAuth.js ──────────────────────────────────────
// Verifica i token ID Firebase SENZA firebase-admin (leggero).
// Valida il JWT con le chiavi pubbliche di Google e controlla
// issuer/audience per il progetto eris-take-care.
//
// Un token valido = utente autenticato su Firebase Auth del progetto.
// L'autorizzazione fine (ruoli iSDS) è già garantita dalle Firestore
// Rules lato client; qui ci basta sapere che è un utente reale del progetto.

import crypto from 'crypto';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'eris-take-care';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const ISSUER = 'https://securetoken.google.com/' + PROJECT_ID;

// Cache delle chiavi pubbliche Google (ruotano ogni ~giorno)
let _certs = null;
let _certsExp = 0;

async function getGoogleCerts() {
  const now = Date.now();
  if (_certs && now < _certsExp) return _certs;
  const resp = await fetch(CERTS_URL);
  if (!resp.ok) throw new Error('Impossibile recuperare le chiavi Google');
  const certs = await resp.json();
  // Cache-Control: max-age dà la scadenza
  const cc = resp.headers.get('cache-control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const maxAge = m ? parseInt(m[1], 10) * 1000 : 3600 * 1000;
  _certs = certs;
  _certsExp = now + maxAge;
  return certs;
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// Verifica un ID token Firebase. Ritorna il payload se valido, altrimenti lancia.
export async function verifyFirebaseToken(idToken) {
  if (!idToken || typeof idToken !== 'string') throw new Error('Token mancante');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Token malformato');

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  const payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));

  // Controlli standard sul payload
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT_ID) throw new Error('Audience non valida');
  if (payload.iss !== ISSUER) throw new Error('Issuer non valido');
  if (payload.exp < now) throw new Error('Token scaduto');
  if (payload.iat > now + 300) throw new Error('Token non ancora valido');
  if (!payload.sub) throw new Error('Subject mancante');

  // Recupera la chiave pubblica corrispondente al kid
  const certs = await getGoogleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('Chiave pubblica non trovata per kid');

  // Verifica firma RS256
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(headerB64 + '.' + payloadB64);
  verifier.end();
  const ok = verifier.verify(pem, base64urlDecode(sigB64));
  if (!ok) throw new Error('Firma non valida');

  return payload; // payload.sub = uid, payload.email = email
}
