"use strict";

// Schlankes, abhängigkeitsfreies strukturiertes Logging (JSON-Lines).
// Bewusst ohne externe Bibliothek (pino/winston), um die schlanke
// Dependency-Liste und den build-freien Betrieb beizubehalten.
//
// Steuerung über Umgebungsvariablen:
//   LOG_LEVEL   debug | info | warn | error            (Default: info)
//   LOG_PRETTY  "1"/"true" → menschenlesbar statt JSON  (Default: aus)
//   LOG_FORMAT  "pretty" | "json"                       (Alternative zu LOG_PRETTY)

const cfAccess = require("./cfAccess");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const envLevel = String(process.env.LOG_LEVEL || "info").toLowerCase();
const threshold = LEVELS[envLevel] != null ? LEVELS[envLevel] : LEVELS.info;

const pretty =
  String(process.env.LOG_PRETTY || "").match(/^(1|true|yes)$/i) != null ||
  String(process.env.LOG_FORMAT || "").toLowerCase() === "pretty";

// Schlüssel, deren Werte niemals im Klartext geloggt werden dürfen.
const REDACT = /^(authorization|cookie|set-cookie|api[-_]?key|x[-_]api[-_]key|password|secret|token|anthropic[-_]api[-_]key)$/i;

function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

const COLORS = { debug: "\x1b[2m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...redact(fields || {}) };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;

  if (pretty) {
    const { ts, ...rest } = rec;
    delete rest.level;
    delete rest.msg;
    const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
    stream.write(`${COLORS[level] || ""}${ts} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${extra}\n`);
  } else {
    stream.write(JSON.stringify(rec) + "\n");
  }
}

// Erzeugt einen Logger mit festen Zusatzfeldern (z. B. reqId), die jeder
// Log-Eintrag dieses Loggers automatisch mitführt.
function makeLogger(bindings = {}) {
  const log = (level, msg, fields) => write(level, msg, { ...bindings, ...fields });
  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (extra) => makeLogger({ ...bindings, ...extra }),
  };
}

const logger = makeLogger();

// Ermittelt den handelnden Benutzer aus den Headern, die ein vorgeschalteter
// Auth-Proxy (Cloudflare Access) setzt. Ist die kryptografische Cloudflare-
// Access-Verifikation aktiv, kommt die Identität ausschließlich aus dem
// verifizierten JWT (von der cfAccess-Middleware in req.actor gesetzt) – der
// fälschbare Klartext-Header wird hier dann NICHT vertraut. Ohne Proxy/Config
// bleibt das Feld leer und die App läuft unverändert weiter.
function actorFromRequest(req) {
  if (cfAccess.isEnabled()) return "";
  const h = req.headers || {};
  const v =
    h["cf-access-authenticated-user-email"] ||
    h["x-forwarded-email"] ||
    h["x-forwarded-preferred-username"] ||
    h["x-forwarded-user"] ||
    h["x-auth-request-email"] ||
    h["x-auth-request-user"] ||
    h["remote-user"] ||
    "";
  return typeof v === "string" ? v.trim() : "";
}

// Express-Middleware: vergibt eine Request-ID, hängt einen Kind-Logger an
// (req.log) und protokolliert jeden abgeschlossenen Request inkl. Dauer.
function httpLogger() {
  const crypto = require("crypto");
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    req.id = req.headers["x-request-id"] || crypto.randomUUID();
    req.actor = actorFromRequest(req);
    req.log = logger.child({ reqId: req.id, ...(req.actor ? { actor: req.actor } : {}) });
    res.setHeader("X-Request-Id", req.id);

    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      req.log[level]("http_request", {
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs: Math.round(ms * 10) / 10,
      });
    });
    next();
  };
}

module.exports = { logger, httpLogger, actorFromRequest };
