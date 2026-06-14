"use strict";

// --- Cloudflare-Access-JWT-Verifikation ------------------------------------
// Cloudflare Access legt bei jedem Request, der die Access-Policy passiert hat,
// ein signiertes JWT im Header "Cf-Access-Jwt-Assertion" an den Origin an.
// Indem die App dieses Token kryptografisch prüft (statt nur dem fälschbaren
// Klartext-Header "Cf-Access-Authenticated-User-Email" zu vertrauen), kann eine
// Identität nicht mehr gefälscht werden, falls die App unter Umgehung von
// Cloudflare direkt erreicht wird.
//
// Bewusst abhängigkeitsfrei: eingebautes `crypto` (RS256-Prüfung) + globales
// `fetch` (JWKS-Abruf). Aktiv nur, wenn CF_ACCESS_TEAM_DOMAIN und CF_ACCESS_AUD
// gesetzt sind – sonst unverändertes Verhalten (lokal/Dev).

const crypto = require("crypto");

// Team-Domain normalisieren (ohne Schema/Pfad), z. B. "team.cloudflareaccess.com".
const TEAM_DOMAIN = String(process.env.CF_ACCESS_TEAM_DOMAIN || "")
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/.*$/, "");
const AUD = String(process.env.CF_ACCESS_AUD || "").trim();

const ISSUER = TEAM_DOMAIN ? `https://${TEAM_DOMAIN}` : "";
const CERTS_URL = TEAM_DOMAIN ? `${ISSUER}/cdn-cgi/access/certs` : "";

function isEnabled() {
  return Boolean(TEAM_DOMAIN && AUD);
}

// --- JWKS-Cache ------------------------------------------------------------
let keyCache = new Map(); // kid -> crypto.KeyObject
let keyCacheAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 h
let inflight = null; // parallele Refreshes bündeln

async function refreshKeys() {
  if (inflight) return inflight;
  inflight = (async () => {
    const res = await fetch(CERTS_URL, { method: "GET" });
    if (!res.ok) throw new Error(`JWKS-Abruf fehlgeschlagen (HTTP ${res.status})`);
    const data = await res.json();
    const keys = Array.isArray(data && data.keys) ? data.keys : [];
    const next = new Map();
    for (const jwk of keys) {
      if (!jwk || !jwk.kid) continue;
      try {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        /* ungültigen Schlüssel überspringen */
      }
    }
    if (!next.size) throw new Error("JWKS enthielt keine verwertbaren Schlüssel.");
    keyCache = next;
    keyCacheAt = Date.now();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// Liefert den öffentlichen Schlüssel zu einer kid; aktualisiert das JWKS bei
// unbekannter kid oder abgelaufenem Cache. Wirft mit code='JWKS_UNAVAILABLE',
// wenn die Schlüssel weder im Cache noch abrufbar sind (Infra-Problem → 503).
async function getKey(kid) {
  if (keyCache.has(kid) && Date.now() - keyCacheAt < CACHE_TTL_MS) {
    return keyCache.get(kid);
  }
  try {
    await refreshKeys();
  } catch (err) {
    if (keyCache.has(kid)) return keyCache.get(kid); // Notfalls alten Key nutzen
    const e = new Error(`Schlüssel nicht verfügbar: ${err.message}`);
    e.code = "JWKS_UNAVAILABLE";
    throw e;
  }
  return keyCache.get(kid) || null;
}

function b64urlToJson(s) {
  return JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
}

// Verifiziert ein Cf-Access-JWT und liefert { email, sub }. Wirft bei
// ungültigem Token; bei Schlüssel-Infrastrukturproblemen mit code='JWKS_UNAVAILABLE'.
async function verifyToken(token) {
  if (typeof token !== "string" || token.split(".").length !== 3) {
    throw new Error("Kein gültiges JWT.");
  }
  const [h, p, s] = token.split(".");
  let header, payload;
  try {
    header = b64urlToJson(h);
    payload = b64urlToJson(p);
  } catch {
    throw new Error("JWT nicht dekodierbar.");
  }

  if (header.alg !== "RS256") throw new Error(`Unerwarteter alg: ${header.alg}`);
  if (!header.kid) throw new Error("JWT ohne kid.");

  const key = await getKey(header.kid);
  if (!key) throw new Error("Kein passender Schlüssel (kid) gefunden.");

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  if (!verifier.verify(key, Buffer.from(s, "base64url"))) {
    throw new Error("JWT-Signatur ungültig.");
  }

  // Claims prüfen.
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error("JWT abgelaufen.");
  if (payload.nbf && now < payload.nbf) throw new Error("JWT noch nicht gültig.");
  if (payload.iss && payload.iss !== ISSUER) throw new Error("Falscher Issuer.");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(AUD)) throw new Error("Falsche Audience (aud).");

  return { email: payload.email || "", sub: payload.sub || "" };
}

// Liest und verifiziert das Token aus dem Request-Header.
async function verifyRequest(req) {
  const token = req && req.headers && req.headers["cf-access-jwt-assertion"];
  return verifyToken(token);
}

module.exports = { isEnabled, verifyRequest, verifyToken, ISSUER, AUD, TEAM_DOMAIN };
