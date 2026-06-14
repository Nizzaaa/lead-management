"use strict";

// --- Zustand ---------------------------------------------------------------
let leads = [];
let statuses = [];
let aiEnabled = false;
let activeFilter = "alle";
let searchTerm = "";
let dueOnly = false; // Filter: nur fällige/überfällige Wiedervorlagen
let models = [];
let currentModel = "";
let stageProbabilities = {};
let view = localStorage.getItem("leadpilot_view") === "kanban" ? "kanban" : "list";

// Eingeklappte Board-Spalten (Status-Namen). Persistiert wie `view`, lebt
// außerhalb des DOM, da renderKanban() das Board per innerHTML neu aufbaut.
const COLLAPSE_KEY = "leadpilot_kanban_collapsed";
let collapsedStatuses = new Set(loadCollapsed());
function loadCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"); }
  catch { return []; }
}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedStatuses])); }
  catch {}
}

// Aktuell geöffnete Detailseite (Lead-ID) und ob sie im Bearbeiten-Modus ist.
let detailId = null;
let detailEditing = false;

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtEuro = (n) => (Number(n) || 0).toLocaleString("de-DE") + " €";
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const getLead = (id) => leads.find((x) => x.id === id);

// Macht eine Quell-URL absolut. Ohne Schema interpretiert der Browser
// "galabau.de" relativ → landet auf localhost:3000/galabau.de. Erlaubt nur
// http/https; andere Schemata (javascript:, mailto: …) werden verworfen.
function extUrl(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return "";
  return "https://" + v.replace(/^\/+/, "");
}

// Datum/Zeit-Helfer (deutsche Formatierung).
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("de-DE");
}
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}
// Relative Zeit ("vor 3 Std.", "in 2 Tagen").
function relTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const min = 60000, h = 3600000, day = 86400000;
  const rtf = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });
  if (abs < h) return rtf.format(Math.round(diff / min), "minute");
  if (abs < day) return rtf.format(Math.round(diff / h), "hour");
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), "day");
  return fmtDate(iso);
}
// ISO → Wert für <input type="datetime-local"> (lokale Zeit, ohne Sekunden).
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Heutiges Datum als "YYYY-MM-DD" (lokal) – für Fälligkeitsvergleiche.
function todayYMD() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Fälligkeit einer Wiedervorlage (ymd = "YYYY-MM-DD") → Zustand + Label.
function dueInfo(ymd) {
  if (!ymd) return null;
  const today = todayYMD();
  let state = "future";
  if (ymd < today) state = "overdue";
  else if (ymd === today) state = "today";
  const label = state === "overdue" ? "überfällig" : state === "today" ? "heute" : fmtDate(ymd);
  return { state, label };
}

// Felder der Sektion „Allgemeine Infos" (Schlüssel → Label), zentral definiert.
const RESEARCH_FIELDS = [
  ["branche", "Branche"],
  ["adresse", "Adresse"],
  ["telefonAllgemein", "Telefon (allgemein)"],
  ["ansprechpartner", "Ansprechpartner / Entscheider"],
  ["telefonDurchwahl", "Telefon (Durchwahl)"],
  ["oeffnungszeiten", "Öffnungszeiten"],
  ["mail", "Mail"],
  ["web", "Web"],
  ["kundenbewertung", "Kundenbewertung"],
];

// --- API -------------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Anfrage fehlgeschlagen");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// --- Initialisierung -------------------------------------------------------
async function init() {
  try {
    const cfg = await api("/api/config");
    statuses = cfg.statuses;
    aiEnabled = cfg.aiEnabled;
    models = cfg.models || [];
    currentModel = cfg.model || "";
    stageProbabilities = cfg.stageProbabilities || {};
    renderAiBadge(cfg);
    renderUserBar(cfg);
    renderStatusFilters();
    renderViewToggle();
    populateStatusSelect();
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
  bindEvents();
  window.addEventListener("hashchange", router);
  router();
  resumeJobs(); // noch laufende Recherchen nach Reload ins Dock zurückholen
}

// Zeigt den angemeldeten Benutzer und einen Logout-Link in der Topbar an.
// Beides stammt vom Auth-Proxy (über /api/config); ohne Proxy bleibt es leer.
function renderUserBar(cfg) {
  const info = $("#userInfo");
  if (info) {
    if (cfg.user) { info.textContent = "👤 " + cfg.user; info.hidden = false; }
    else { info.hidden = true; }
  }
  const link = $("#logoutLink");
  if (link) {
    if (cfg.logoutUrl) { link.href = cfg.logoutUrl; link.hidden = false; }
    else { link.hidden = true; }
  }
}

function renderAiBadge(cfg) {
  const badge = $("#aiBadge");
  if (cfg.aiEnabled) {
    const short = (cfg.model || "").replace("claude-", "");
    badge.textContent = "🤖 " + (short || "KI aktiv");
    badge.className = "badge badge-on";
    badge.title = "Modell: " + cfg.model;
  } else {
    badge.textContent = "KI inaktiv";
    badge.className = "badge badge-off";
    badge.title = "ANTHROPIC_API_KEY setzen, um KI-Funktionen zu aktivieren";
  }
}

function renderStatusFilters() {
  const wrap = $("#statusFilters");
  const all = ["alle", ...statuses];
  wrap.innerHTML = all
    .map(
      (s) =>
        `<button class="chip ${s === activeFilter ? "active" : ""}" data-filter="${s}">${s}</button>`
    )
    .join("");
}

function populateStatusSelect() {
  $("#f_status").innerHTML = statuses
    .map((s) => `<option value="${s}">${s}</option>`)
    .join("");
}

// --- Routing (Liste ⇄ Detail ⇄ Berichte) -----------------------------------
const VIEWS = ["listView", "detailView", "reportsView"];
function showOnly(viewId) {
  for (const v of VIEWS) $("#" + v).classList.toggle("hidden", v !== viewId);
}
function setActiveNav(name) {
  document.querySelectorAll("[data-nav-link]").forEach((a) => {
    a.classList.toggle("active", a.dataset.navLink === name);
  });
}

function router() {
  const lead = location.hash.match(/^#\/lead\/(.+)$/);
  if (lead) return showDetail(decodeURIComponent(lead[1]));
  if (location.hash === "#/reports") return showReports();
  showList();
}

function showList() {
  detailId = null;
  detailEditing = false;
  showOnly("listView");
  setActiveNav("list");
  renderLeads();
  window.scrollTo(0, 0);
}

function showDetail(id) {
  detailId = id;
  if (!getLead(id)) {
    // Daten evtl. noch nicht geladen – erst nach refresh entscheiden.
    if (!leads.length) return;
    toast("Lead nicht gefunden", "error");
    location.hash = "#/";
    return;
  }
  showOnly("detailView");
  setActiveNav("");
  renderDetail();
  loadDetailExtras(id);
  window.scrollTo(0, 0);
}

function showReports() {
  detailId = null;
  showOnly("reportsView");
  setActiveNav("reports");
  renderReportsView();
  window.scrollTo(0, 0);
}

// --- Daten laden + rendern -------------------------------------------------
async function refresh() {
  leads = await api("/api/leads");
  renderStats(await api("/api/stats"));
  if (detailId) {
    renderDetail();
    loadDetailExtras(detailId);
  } else {
    renderLeads();
  }
}

function renderStats(stats) {
  $("#statTotal").textContent = stats.total;
  // Primär der gewichtete (Erwartungs-)Wert; roh als Tooltip.
  const weighted = stats.weightedPipelineValue != null ? stats.weightedPipelineValue : stats.pipelineValue;
  $("#statPipeline").textContent = fmtEuro(Math.round(weighted));
  const card = $("#statPipeline").closest(".stat-card");
  if (card) card.title = `Roh (ungewichtet): ${fmtEuro(Math.round(stats.pipelineValue || 0))}\nGewichtet (Σ Wert × Wahrscheinlichkeit): ${fmtEuro(Math.round(weighted))}`;
  $("#statWon").textContent = fmtEuro(stats.wonValue);
  $("#statConversion").textContent = stats.conversion + " %";
}

function filteredLeads() {
  const today = todayYMD();
  return leads.filter((l) => {
    if (activeFilter !== "alle" && l.status !== activeFilter) return false;
    if (dueOnly && !(l.nextStepAt && l.nextStepAt <= today)) return false;
    if (searchTerm) {
      const hay = `${l.name} ${l.company} ${l.email} ${l.source}`.toLowerCase();
      if (!hay.includes(searchTerm)) return false;
    }
    return true;
  });
}

// Anzahl fälliger/überfälliger Wiedervorlagen (für den Toolbar-Chip).
function dueLeadCount() {
  const today = todayYMD();
  return leads.filter((l) => l.nextStepAt && l.nextStepAt <= today).length;
}

function scoreColor(score) {
  if (score >= 75) return "var(--green)";
  if (score >= 50) return "var(--amber)";
  if (score >= 25) return "#E8703A";
  return "var(--red)";
}

// Nur Suchbegriff anwenden (für das Kanban-Board, das nach Status spaltet).
function searchFiltered() {
  return leads.filter((l) => {
    if (!searchTerm) return true;
    const hay = `${l.name} ${l.company} ${l.email} ${l.source}`.toLowerCase();
    return hay.includes(searchTerm);
  });
}

function renderViewToggle() {
  document.querySelectorAll("#viewToggle .chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
}

function renderLeads() {
  $("#emptyState").classList.toggle("hidden", leads.length !== 0);
  const isKanban = view === "kanban";
  $("#leadList").classList.toggle("hidden", isKanban);
  $("#kanban").classList.toggle("hidden", !isKanban);
  if (isKanban) renderKanban();
  else renderList();
  // Fälligkeits-Chip mit Anzahl aktualisieren.
  const n = dueLeadCount();
  const badge = $("#dueCount");
  if (badge) {
    badge.textContent = n;
    badge.classList.toggle("hidden", n === 0);
  }
}

function renderList() {
  $("#leadList").innerHTML = filteredLeads().map(leadCard).join("");
}

function renderKanban() {
  const items = searchFiltered();
  const board = $("#kanban");
  board.innerHTML = statuses
    .map((status) => {
      const colItems = items.filter((l) => l.status === status);
      const cards = colItems.map(kanbanCard).join("") ||
        `<div class="kanban-empty">—</div>`;
      const isCollapsed = collapsedStatuses.has(status);
      return `<div class="kanban-col${isCollapsed ? " collapsed" : ""}" data-status="${status}">
        <button type="button" class="kanban-col-head" data-collapse="${status}"
          aria-expanded="${!isCollapsed}"
          aria-label="${status} ${isCollapsed ? "ausklappen" : "einklappen"}">
          <span class="status-pill s-${status}">${status}</span>
          <span class="kanban-count">${colItems.length}</span>
        </button>
        <div class="kanban-cards" data-status="${status}">${cards}</div>
      </div>`;
    })
    .join("");
}

// --- Kanban Drag & Drop ----------------------------------------------------
let dragId = null;
let dragMoved = false;
function bindKanbanDnd() {
  const board = $("#kanban");
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".kanban-card");
    if (!card) return;
    dragId = card.dataset.id;
    dragMoved = true;
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  board.addEventListener("dragend", (e) => {
    const card = e.target.closest(".kanban-card");
    if (card) card.classList.remove("dragging");
    document.querySelectorAll(".kanban-col.drop").forEach((c) => c.classList.remove("drop"));
    dragId = null;
    setTimeout(() => (dragMoved = false), 0);
  });
  board.addEventListener("dragover", (e) => {
    const zone = e.target.closest(".kanban-cards");
    if (!zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".kanban-col.drop").forEach((c) => c.classList.remove("drop"));
    zone.closest(".kanban-col").classList.add("drop");
  });
  board.addEventListener("drop", (e) => {
    const zone = e.target.closest(".kanban-cards");
    if (!zone || !dragId) return;
    e.preventDefault();
    changeStatus(dragId, zone.dataset.status);
  });
}

async function changeStatus(id, status) {
  const l = getLead(id);
  if (!l || l.status === status) {
    renderLeads();
    return;
  }
  try {
    await api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify({ status }) });
    await refresh();
    toast(`Status → ${status}`, "success");
  } catch (err) {
    toast(err.message, "error");
    renderLeads();
  }
}

// --- Karten (schlank: nur die wichtigsten Infos) ---------------------------
function fieldVal(f) {
  return f && f.value ? f.value : "";
}

function scoreBadge(l, cls) {
  if (!l.ai) return "";
  return `<span class="${cls}" style="color:${scoreColor(l.ai.score)};border-color:${scoreColor(l.ai.score)}">★ ${l.ai.score}</span>`;
}

// Wiedervorlage-Badge für Karten (rot=überfällig, amber=heute, dezent=zukünftig).
function nextStepBadge(l) {
  const info = dueInfo(l.nextStepAt);
  if (!info) return "";
  return `<span class="next-step-badge ${info.state}" title="${esc(l.nextStep || "Wiedervorlage")}">⏰ ${esc(info.label)}</span>`;
}

// Kartenansicht: nur Firma, Ansprechpartner, Status, Branche, Wert, KI-Score.
function leadCard(l) {
  const branche = l.research ? fieldVal(l.research.fields && l.research.fields.branche) : "";
  return `<article class="lead-card" data-nav="${l.id}" tabindex="0" role="button" aria-label="Lead öffnen">
    <div class="lead-card-head">
      <div class="lead-card-title">${esc(l.company) || esc(l.name) || "—"}</div>
      <span class="status-pill s-${l.status}">${l.status}</span>
    </div>
    <div class="lead-card-sub">
      ${l.company && l.name ? `<span>👤 ${esc(l.name)}</span>` : ""}
      ${branche ? `<span>🏷️ ${esc(branche)}</span>` : ""}
      ${!l.research ? `<span class="muted-note">keine Recherche</span>` : ""}
    </div>
    ${nextStepBadge(l) ? `<div class="lead-card-next">${nextStepBadge(l)}</div>` : ""}
    <div class="lead-card-foot">
      <span class="lead-value">💶 ${fmtEuro(l.value)}</span>
      ${scoreBadge(l, "score-chip")}
    </div>
  </article>`;
}

function kanbanCard(l) {
  return `<article class="kanban-card" draggable="true" data-id="${l.id}" data-nav="${l.id}">
    <div class="kanban-card-top">
      <div class="kanban-card-title">${esc(l.company) || esc(l.name) || "—"}</div>
      ${scoreBadge(l, "kanban-score")}
    </div>
    ${l.name && l.company ? `<div class="kanban-card-sub">${esc(l.name)}</div>` : ""}
    <div class="kanban-card-foot">
      <span class="lead-value">💶 ${fmtEuro(l.value)}</span>
      ${nextStepBadge(l)}
    </div>
  </article>`;
}

// --- Detailseite -----------------------------------------------------------
function renderDetail() {
  const l = getLead(detailId);
  if (!l) {
    location.hash = "#/";
    return;
  }
  const v = $("#detailView");
  v.innerHTML = detailEditing ? detailEditHtml(l) : detailViewHtml(l);
}

// Tabelle „Allgemeine Infos" (Lese-Modus, mit Quellen-Links).
function infoRowsView(f) {
  return RESEARCH_FIELDS.map(([key, label]) => {
    const field = f[key] || {};
    const value = field.value && field.value !== "k.A." ? field.value : "—";
    const href = extUrl(field.source);
    const src = href
      ? ` <a class="src" href="${esc(href)}" target="_blank" rel="noopener">↗ Quelle</a>`
      : "";
    return `<tr><th>${esc(label)}</th><td>${esc(value)}${src}</td></tr>`;
  }).join("");
}

// Hilfsblock: Abschnitt mit Überschrift + Freitext (oder „—").
function sectionView(title, text) {
  return `<section class="d-section">
    <h3>${esc(title)}</h3>
    <p class="d-text">${esc(text) || "—"}</p>
  </section>`;
}

function detailViewHtml(l) {
  const r = l.research;
  const ai = l.ai;

  const aiBox = ai
    ? `<div class="ai-score-card">
         <div class="score-ring" style="background:conic-gradient(${scoreColor(ai.score)} ${ai.score}%, var(--border) 0); color:${scoreColor(ai.score)}">
           <span class="score-ring-inner">${ai.score}</span>
         </div>
         <div class="ai-score-meta">
           <strong>KI-Score · Note ${esc(ai.grade)}</strong>
           ${ai.reasoning ? `<p>${esc(ai.reasoning)}</p>` : ""}
           ${ai.valueReasoning ? `<p class="value-reason">💶 Wert (12 Mon.): ${esc(ai.valueReasoning)}</p>` : ""}
         </div>
       </div>`
    : `<p class="d-muted">Noch keine KI-Bewertung. ${aiEnabled ? "" : "(KI nicht konfiguriert)"}</p>`;

  const aiActions = aiEnabled
    ? `<div class="d-btn-row">
         <button class="btn btn-ai btn-sm" data-action="score">⚡ ${ai ? "Neu bewerten" : "KI-Score"}</button>
         <button class="btn btn-ai btn-sm" data-action="email">✉️ E-Mail-Entwurf</button>
         <button class="btn btn-ai btn-sm" data-action="insights">💡 Empfehlung</button>
       </div>
       <div id="aiOutput" class="ai-output hidden"></div>`
    : "";

  // Recherche-Inhalt sauber formatiert (kein Markdown).
  let researchHtml;
  if (r) {
    const meta = [
      r.rechercheStand ? `Recherche-Stand: ${esc(r.rechercheStand)}` : "",
      r.input ? `Input: ${esc(r.input)}` : "",
      r.model ? `Modell: ${esc(String(r.model).replace("claude-", ""))}` : "",
    ].filter(Boolean).join(" · ");

    const pots = Array.isArray(r.potenziale) && r.potenziale.length
      ? r.potenziale.map((p) => `<li>
          <strong>${esc(p.titel)}</strong>
          <span>${esc(p.beschreibung)}</span>
          ${p.signal ? `<em class="signal">Signal: ${esc(p.signal)}</em>` : ""}
        </li>`).join("")
      : `<li class="d-muted">Keine Potenziale erfasst.</li>`;

    researchHtml = `
      ${meta ? `<p class="d-meta">${meta}</p>` : ""}
      ${r.ambiguityWarning ? `<p class="warn">⚠️ ${esc(r.ambiguityWarning)}</p>` : ""}

      <section class="d-section">
        <h3>Allgemeine Infos</h3>
        <table class="info-table"><tbody>${infoRowsView(r.fields || {})}</tbody></table>
      </section>

      ${sectionView("Negative Bewertungen → Potenzial", r.negativeBewertungen)}
      ${sectionView("Einordnung / Selbstdarstellung", r.einordnung)}
      ${sectionView("Eingesetzte Systeme / Integrationspotenzial", r.eingesetzteSysteme)}
      ${sectionView("Sichtbare Schwachstellen / Ansatzpunkte", r.schwachstellen)}

      <section class="d-section">
        <h3>Potenziale für FU/GE</h3>
        <ul class="pot-list">${pots}</ul>
      </section>

      ${sectionView("Strategie für Cold Call", r.coldCallStrategie)}
      ${sectionView("Risiken / Denkbare Ablehnungsgründe", r.risiken)}
    `;
  } else {
    researchHtml = `<div class="d-empty">
      <p>Für diesen Lead liegt noch keine Recherche vor.</p>
      ${aiEnabled ? `<button class="btn btn-ai" data-action="research">🔎 Jetzt recherchieren</button>` : ""}
    </div>`;
  }

  return `
    <div class="detail-bar">
      <a class="btn btn-sm" href="#/">← Zurück</a>
      <div class="detail-bar-actions">
        ${aiEnabled && r ? `<button class="btn btn-sm" data-action="research">🔄 Neu recherchieren</button>` : ""}
        <button class="btn btn-sm" data-action="pdf" title="Lead-Details als PDF (Drucken / Als PDF speichern)">📄 PDF</button>
        <button class="btn btn-sm" data-action="export" title="Alle Daten dieses Leads als JSON (DSGVO-Auskunft)">⬇️ Datenauskunft</button>
        <button class="btn btn-sm" data-action="edit">✏️ Bearbeiten</button>
        <button class="btn btn-sm btn-danger" data-action="delete">🗑️ Löschen</button>
      </div>
    </div>

    <header class="detail-hero">
      <div>
        <h1>${esc(l.company) || esc(l.name) || "—"}</h1>
        ${l.company && l.name ? `<p class="detail-sub">👤 ${esc(l.name)}</p>` : ""}
      </div>
      <div class="detail-hero-right">
        <span class="status-pill s-${l.status}">${l.status}</span>
        <span class="lead-value big">💶 ${fmtEuro(l.value)}</span>
      </div>
    </header>

    <div class="detail-layout">
      <aside class="detail-side">
        <section class="card lead-about">
          <h3>Über</h3>
          ${leadAboutHtml(l)}
        </section>
        <section class="card">
          <h3>KI-Bewertung</h3>
          ${aiBox}
          ${aiActions}
        </section>
      </aside>

      <div class="detail-main">
        <div class="detail-tabs" role="tablist">
          <button type="button" class="dtab active" data-dtab="activity">📌 Aktivitäten</button>
          <button type="button" class="dtab" data-dtab="dossier">📋 Dossier</button>
        </div>
        <div class="dtab-panel" data-dtab-panel="activity">
          ${nextStepBannerHtml(l)}
          <section class="card" id="activityPanel">${activityPanelHtml(null)}</section>
        </div>
        <div class="dtab-panel hidden" data-dtab-panel="dossier">
          ${l.notes ? `<section class="card"><h3>Notizen</h3><p class="d-text">${esc(l.notes)}</p></section>` : ""}
          <div class="card">${researchHtml}</div>
        </div>
      </div>
    </div>
  `;
}

// Kompakte „Über"-Karte (Sidebar): Kontakt- und Stammdaten des Leads.
function leadAboutHtml(l) {
  const dt = (iso) => (iso ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" }) : "—");
  const rows = [
    l.email ? ["E-Mail", `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>`] : null,
    l.phone ? ["Telefon", esc(l.phone)] : null,
    ["Quelle", l.source ? esc(l.source) : "—"],
    ["Wert", esc(fmtEuro(l.value))],
    ["Angelegt", esc(dt(l.createdAt))],
    ["Aktualisiert", esc(dt(l.updatedAt))],
  ].filter(Boolean);
  return `<dl class="about-list">${rows.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${val}</dd></div>`).join("")}</dl>`;
}

// Wiedervorlage-Banner oben im Aktivitäten-Tab: nächster Schritt + Fälligkeit.
function nextStepBannerHtml(l) {
  const info = dueInfo(l.nextStepAt);
  if (!l.nextStep && !info) {
    return `<div class="next-step-banner empty">
      <span class="ns-text">Kein nächster Schritt geplant.</span>
      <button type="button" class="btn btn-sm" data-action="next-step-edit">+ Wiedervorlage planen</button>
    </div>`;
  }
  const due = info ? `<span class="ns-due ${info.state}">⏰ ${esc(info.label)}</span>` : "";
  return `<div class="next-step-banner ${info ? info.state : ""}">
    <div class="ns-main">
      <span class="ns-label">Nächster Schritt</span>
      <span class="ns-text">${esc(l.nextStep || "—")}</span>
      ${due}
    </div>
    <div class="ns-actions">
      <button type="button" class="btn btn-sm" data-action="next-step-done">✓ Erledigt</button>
      <button type="button" class="btn btn-sm" data-action="next-step-edit">Bearbeiten</button>
    </div>
  </div>`;
}

// --- Detailseite: Aktivitäten-Timeline -------------------------------------
// Diese Daten liegen nicht im leads-Array, sondern werden je Detailseite
// nachgeladen und in das Platzhalter-Panel gerendert.
let detailActivities = [];
let composerType = "note";    // aktuell im Composer gewählter Aktivitätstyp
let activityFilter = "all";   // aktiver Timeline-Filter

async function loadDetailExtras(id) {
  try {
    const acts = await api(`/api/leads/${id}/activities`);
    if (detailId !== id) return; // inzwischen weggeblättert
    detailActivities = acts;
    const ap = $("#activityPanel");
    if (ap) ap.innerHTML = activityPanelHtml(acts);
  } catch (err) {
    /* Panel zeigt weiter den Ladezustand */
  }
}

const ACTIVITY_META = {
  note:    { icon: "📝", label: "Notiz" },
  call:    { icon: "📞", label: "Anruf" },
  email:   { icon: "✉️", label: "E-Mail" },
  meeting: { icon: "📅", label: "Termin" },
  status:  { icon: "🔄", label: "Status" },
  ai:      { icon: "🤖", label: "KI" },
  system:  { icon: "⚙️", label: "System" },
};

// --- Composer (Tab-basierte Aktivitätserfassung) ---------------------------
// Pro Typ: Platzhalter, Button-Text, ob ein Ergebnisfeld gezeigt wird und
// optionale Schnell-Ergebnisse (für Anrufe).
const COMPOSER_META = {
  note:    { ph: "Notiz hinzufügen … Kontext, Vereinbarungen, To-dos", btn: "Notiz speichern", outcome: false, chips: [] },
  call:    { ph: "Gesprächsnotiz … worüber wurde gesprochen?", btn: "Anruf protokollieren", outcome: true,
             chips: ["Erreicht", "Mailbox", "Kein Anschluss", "Rückruf vereinbart", "Termin vereinbart", "Kein Interesse"] },
  email:   { ph: "Worum ging es in der E-Mail?", btn: "E-Mail protokollieren", outcome: false, chips: [] },
  meeting: { ph: "Termin-Notiz … Teilnehmer, Ergebnis, nächste Schritte", btn: "Termin protokollieren", outcome: true, chips: [] },
};
const COMPOSER_TABS = [["note", "📝", "Notiz"], ["call", "📞", "Anruf"], ["email", "✉️", "E-Mail"], ["meeting", "📅", "Termin"]];

function composerHtml() {
  const c = COMPOSER_META[composerType] || COMPOSER_META.note;
  const tabs = COMPOSER_TABS.map(([t, ic, lb]) =>
    `<button type="button" class="act-tab ${t === composerType ? "active" : ""}" data-act-tab="${t}">${ic} ${lb}</button>`
  ).join("");
  const chips = c.chips.length
    ? `<div class="act-chips" id="actChips">${c.chips.map((o) => `<button type="button" class="act-chip" data-outcome="${esc(o)}">${esc(o)}</button>`).join("")}</div>`
    : "";
  const outcome = c.outcome
    ? `<input type="text" id="act_outcome" class="act-outcome-input" placeholder="Ergebnis (optional)" />`
    : "";
  return `<div class="act-composer" id="activityComposer">
    <div class="act-tabs">${tabs}</div>
    <form id="activityForm">
      <textarea id="act_body" rows="3" placeholder="${esc(c.ph)}"></textarea>
      ${chips}
      <div class="act-composer-foot">
        ${outcome}
        <button type="submit" class="btn btn-sm btn-primary" id="actSubmitBtn">${esc(c.btn)}</button>
      </div>
    </form>
  </div>`;
}

// Composer-Typ wechseln, ohne den bereits eingegebenen Text zu verlieren.
function setComposerType(type) {
  if (!COMPOSER_META[type]) return;
  const prev = $("#act_body") ? $("#act_body").value : "";
  composerType = type;
  const host = $("#activityComposer");
  if (host) host.outerHTML = composerHtml();
  const ta = $("#act_body");
  if (ta) { ta.value = prev; ta.focus(); }
}

// Schnell-Ergebnis-Chip (Anruf) übernimmt seinen Wert in das Ergebnisfeld.
function applyOutcomeChip(el) {
  const inp = $("#act_outcome");
  if (inp) inp.value = el.dataset.outcome;
  document.querySelectorAll("#actChips .act-chip").forEach((c) => c.classList.toggle("active", c === el));
}

// --- Timeline (gruppiert nach Datum, mit Typ-Filter) -----------------------
const FILTER_TYPES = { all: null, note: ["note"], call: ["call"], email: ["email"], meeting: ["meeting"], system: ["status", "ai", "system"] };
const FILTERS = [["all", "Alle"], ["note", "Notizen"], ["call", "Anrufe"], ["email", "E-Mails"], ["meeting", "Termine"], ["system", "System"]];

function filterActs(acts) {
  const types = FILTER_TYPES[activityFilter];
  return types ? acts.filter((a) => types.includes(a.type)) : acts;
}

function filterBarHtml(acts) {
  return `<div class="act-filters">${FILTERS.map(([k, lb]) => {
    const types = FILTER_TYPES[k];
    const n = types ? acts.filter((a) => types.includes(a.type)).length : acts.length;
    return `<button type="button" class="act-filter ${k === activityFilter ? "active" : ""}" data-filter="${k}">${esc(lb)}<span class="act-filter-n">${n}</span></button>`;
  }).join("")}</div>`;
}

function setActivityFilter(f) {
  if (!FILTER_TYPES[f]) return;
  activityFilter = f;
  document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b.dataset.filter === f));
  const list = $("#activityList");
  if (list) list.innerHTML = timelineHtml(filterActs(detailActivities));
}

// Datums-Gruppe für eine Aktivität: Heute / Gestern / Diese Woche / Datum.
function dateBucket(iso) {
  const d = new Date(iso), now = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff <= 0) return "Heute";
  if (diff === 1) return "Gestern";
  if (diff < 7) return "Diese Woche";
  return d.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" });
}

function activityItem(a) {
  const m = ACTIVITY_META[a.type] || ACTIVITY_META.note;
  const who = a.actor && a.actor !== "—" ? ` · ${esc(a.actor)}` : "";
  const canDelete = ["note", "call", "email", "meeting"].includes(a.type);
  const title = a.title ? esc(a.title) : esc(m.label);
  return `<li class="act-item act-${a.type}">
    <span class="act-dot" title="${esc(m.label)}">${m.icon}</span>
    <div class="act-card">
      <div class="act-head">
        <strong>${title}</strong>
        <span class="act-time" title="${esc(fmtDateTime(a.createdAt))}">${esc(relTime(a.createdAt))}${who}</span>
        ${canDelete ? `<button class="icon-btn act-del" data-del-act="${a.id}" title="Löschen">🗑️</button>` : ""}
      </div>
      ${a.body ? `<p class="act-text">${esc(a.body)}</p>` : ""}
      ${a.outcome ? `<span class="act-outcome-chip">${esc(a.outcome)}</span>` : ""}
    </div>
  </li>`;
}

function timelineHtml(acts) {
  if (acts == null) return `<p class="d-muted">Lädt…</p>`;
  if (!acts.length) return `<p class="act-empty">Keine Aktivitäten in dieser Ansicht.</p>`;
  let out = `<ul class="act-timeline">`;
  let bucket = null;
  for (const a of acts) {
    const b = dateBucket(a.createdAt);
    if (b !== bucket) { out += `<li class="act-date">${esc(b)}</li>`; bucket = b; }
    out += activityItem(a);
  }
  return out + `</ul>`;
}

function activityPanelHtml(acts) {
  composerType = "note";   // frischer Composer bei jedem (Neu-)Aufbau
  activityFilter = "all";
  const filters = acts && acts.length ? filterBarHtml(acts) : "";
  return `<div class="act-panel-head"><h3>Aktivitäten</h3></div>
    ${composerHtml()}
    ${filters}
    <div id="activityList">${timelineHtml(acts)}</div>`;
}

// --- Detailseite: Bearbeiten-Modus ----------------------------------------
function input(id, label, value, type = "text") {
  return `<label>${esc(label)}
    <input type="${type}" id="${id}" value="${esc(value)}" ${type === "number" ? 'min="0" step="100"' : ""} />
  </label>`;
}

function textarea(id, label, value, rows = 3) {
  return `<label>${esc(label)}
    <textarea id="${id}" rows="${rows}">${esc(value)}</textarea>
  </label>`;
}

// Editierbare Zeilen der „Allgemeine Infos"-Tabelle (Wert + Quelle).
function infoRowsEdit(f) {
  return RESEARCH_FIELDS.map(([key, label]) => {
    const field = f[key] || {};
    return `<tr>
      <th>${esc(label)}</th>
      <td><input class="edit-input" data-rf="${key}.value" value="${esc(field.value || "")}" placeholder="—" /></td>
      <td><input class="edit-input" data-rf="${key}.source" value="${esc(field.source || "")}" placeholder="Quelle (URL)" /></td>
    </tr>`;
  }).join("");
}

function potEditRow(p = {}) {
  return `<div class="pot-row">
    <input class="edit-input" data-pf="titel" value="${esc(p.titel || "")}" placeholder="Kurztitel" />
    <textarea class="edit-input" data-pf="beschreibung" rows="2" placeholder="Beschreibung / Nutzen">${esc(p.beschreibung || "")}</textarea>
    <input class="edit-input" data-pf="signal" value="${esc(p.signal || "")}" placeholder="Belegtes Signal" />
    <button type="button" class="icon-btn pot-remove" title="Entfernen">🗑️</button>
  </div>`;
}

function detailEditHtml(l) {
  const r = l.research;
  const statusOpts = statuses
    .map((s) => `<option value="${s}" ${s === l.status ? "selected" : ""}>${s}</option>`)
    .join("");

  const researchEdit = r
    ? `<div class="card">
        <h3>Recherche-Dossier bearbeiten</h3>
        <div class="form-row">
          ${input("ed_r_unternehmensname", "Unternehmensname", r.unternehmensname || "")}
          ${input("ed_r_rechercheStand", "Recherche-Stand", r.rechercheStand || "")}
        </div>
        ${input("ed_r_ambiguityWarning", "Hinweis / Mehrdeutigkeit", r.ambiguityWarning || "")}

        <h4 class="edit-subhead">Allgemeine Infos</h4>
        <table class="info-table edit"><tbody>${infoRowsEdit(r.fields || {})}</tbody></table>

        ${textarea("ed_r_negativeBewertungen", "Negative Bewertungen → Potenzial", r.negativeBewertungen || "")}
        ${textarea("ed_r_einordnung", "Einordnung / Selbstdarstellung", r.einordnung || "")}
        ${textarea("ed_r_eingesetzteSysteme", "Eingesetzte Systeme / Integrationspotenzial", r.eingesetzteSysteme || "")}
        ${textarea("ed_r_schwachstellen", "Sichtbare Schwachstellen / Ansatzpunkte", r.schwachstellen || "")}

        <h4 class="edit-subhead">Potenziale für FU/GE</h4>
        <div id="potEditList">${(Array.isArray(r.potenziale) ? r.potenziale : []).map(potEditRow).join("")}</div>
        <button type="button" class="btn btn-sm" data-action="add-pot">+ Potenzial hinzufügen</button>

        ${textarea("ed_r_coldCallStrategie", "Strategie für Cold Call", r.coldCallStrategie || "")}
        ${textarea("ed_r_risiken", "Risiken / Denkbare Ablehnungsgründe", r.risiken || "")}
      </div>`
    : `<div class="card"><p class="d-muted">Keine Recherchedaten zum Bearbeiten vorhanden.</p></div>`;

  return `
    <div class="detail-bar">
      <button class="btn btn-sm" data-action="cancel-edit">← Abbrechen</button>
      <div class="detail-bar-actions">
        <button class="btn btn-primary btn-sm" data-action="save-edit">💾 Speichern</button>
      </div>
    </div>

    <div id="detailEditForm" class="detail-edit">
      <div class="card">
        <h3>Stammdaten</h3>
        <div class="form-row">
          ${input("ed_name", "Name", l.name)}
          ${input("ed_company", "Firma", l.company)}
        </div>
        <div class="form-row">
          ${input("ed_email", "E-Mail", l.email, "email")}
          ${input("ed_phone", "Telefon", l.phone)}
        </div>
        <div class="form-row">
          ${input("ed_source", "Quelle", l.source)}
          ${input("ed_value", "Geschätzter Wert (€)", l.value, "number")}
        </div>
        <label>Status<select id="ed_status">${statusOpts}</select></label>
        <div class="form-row">
          ${input("ed_next_step", "Nächster Schritt", l.nextStep || "")}
          ${input("ed_next_step_at", "Wiedervorlage am", l.nextStepAt || "", "date")}
        </div>
        ${textarea("ed_notes", "Notizen", l.notes)}
      </div>
      ${researchEdit}
    </div>
  `;
}

// Sammelt die bearbeiteten Werte aus dem Detail-Formular.
function collectStammdaten() {
  const g = (id) => $("#" + id).value;
  return {
    name: g("ed_name"),
    company: g("ed_company"),
    email: g("ed_email"),
    phone: g("ed_phone"),
    source: g("ed_source"),
    value: g("ed_value"),
    status: g("ed_status"),
    nextStep: g("ed_next_step"),
    nextStepAt: g("ed_next_step_at"),
    notes: g("ed_notes"),
  };
}

function collectResearch() {
  const g = (id) => { const el = $("#" + id); return el ? el.value : ""; };
  const fields = {};
  RESEARCH_FIELDS.forEach(([key]) => {
    const valEl = document.querySelector(`[data-rf="${key}.value"]`);
    const srcEl = document.querySelector(`[data-rf="${key}.source"]`);
    fields[key] = {
      value: valEl ? valEl.value : "",
      source: srcEl ? srcEl.value : "",
    };
  });
  const potenziale = [...document.querySelectorAll("#potEditList .pot-row")].map((row) => ({
    titel: row.querySelector('[data-pf="titel"]').value,
    beschreibung: row.querySelector('[data-pf="beschreibung"]').value,
    signal: row.querySelector('[data-pf="signal"]').value,
  }));
  return {
    unternehmensname: g("ed_r_unternehmensname"),
    rechercheStand: g("ed_r_rechercheStand"),
    ambiguityWarning: g("ed_r_ambiguityWarning"),
    fields,
    negativeBewertungen: g("ed_r_negativeBewertungen"),
    einordnung: g("ed_r_einordnung"),
    eingesetzteSysteme: g("ed_r_eingesetzteSysteme"),
    schwachstellen: g("ed_r_schwachstellen"),
    potenziale,
    coldCallStrategie: g("ed_r_coldCallStrategie"),
    risiken: g("ed_r_risiken"),
  };
}

async function saveDetailEdit() {
  const l = getLead(detailId);
  if (!l) return;
  try {
    await api(`/api/leads/${l.id}`, {
      method: "PUT",
      body: JSON.stringify(collectStammdaten()),
    });
    if (l.research) {
      await api(`/api/leads/${l.id}/research`, {
        method: "PUT",
        body: JSON.stringify(collectResearch()),
      });
    }
    detailEditing = false;
    await refresh();
    toast("Änderungen gespeichert", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

// Delegierter Klick-Handler für die Detailseite (einmalig gebunden, deckt
// Lese- und Bearbeiten-Modus ab).
function onDetailClick(e) {
  if (e.target.closest(".pot-remove")) {
    e.target.closest(".pot-row").remove();
    return;
  }
  const dtab = e.target.closest("[data-dtab]");
  if (dtab) { switchDetailTab(dtab.dataset.dtab); return; }
  const atab = e.target.closest("[data-act-tab]");
  if (atab) { setComposerType(atab.dataset.actTab); return; }
  const chip = e.target.closest("[data-outcome]");
  if (chip) { applyOutcomeChip(chip); return; }
  const fil = e.target.closest("[data-filter]");
  if (fil) { setActivityFilter(fil.dataset.filter); return; }
  const delAct = e.target.closest("[data-del-act]");
  if (delAct) { removeActivity(delAct.dataset.delAct); return; }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const id = detailId;
  if (!id) return;

  switch (action) {
    case "edit":
      detailEditing = true;
      renderDetail();
      break;
    case "cancel-edit":
      detailEditing = false;
      renderDetail();
      break;
    case "save-edit":
      saveDetailEdit();
      break;
    case "add-pot":
      $("#potEditList").insertAdjacentHTML("beforeend", potEditRow());
      break;
    case "delete":
      deleteLead(id, true);
      break;
    case "export":
      exportLead(id);
      break;
    case "pdf":
      exportLeadPdf(id);
      break;
    case "next-step-done":
      completeNextStep(id);
      break;
    case "next-step-edit":
      openNextStepModal(id);
      break;
    case "research":
      researchLead(id, btn);
      break;
    case "score":
    case "email":
    case "insights":
      runAi(action, id, btn);
      break;
  }
}

// --- Events ----------------------------------------------------------------
function bindEvents() {
  $("#addLeadBtn").addEventListener("click", openResearchModal);
  $("#manualLeadBtn").addEventListener("click", () => openLeadModal());
  $("#closeModal").addEventListener("click", closeLeadModal);
  $("#cancelBtn").addEventListener("click", closeLeadModal);
  $("#leadForm").addEventListener("submit", saveLead);

  $("#dueFilter").addEventListener("click", () => {
    dueOnly = !dueOnly;
    $("#dueFilter").classList.toggle("active", dueOnly);
    renderLeads();
  });
  $("#dupClose").addEventListener("click", closeDupModal);
  $("#dupCancel").addEventListener("click", closeDupModal);
  $("#nsClose").addEventListener("click", closeNextStepModal);
  $("#nsCancel").addEventListener("click", closeNextStepModal);
  $("#nsClear").addEventListener("click", () => saveNextStep(null, true));
  $("#nextStepForm").addEventListener("submit", saveNextStep);

  $("#closeResearchModal").addEventListener("click", closeResearchModal);
  $("#cancelResearchBtn").addEventListener("click", closeResearchModal);
  $("#abortResearchBtn").addEventListener("click", () => { if (modalJobId) cancelJob(modalJobId); });
  $("#researchForm").addEventListener("submit", submitResearch);

  // Dock: ✕ bricht den Job ab, Klick auf den Chip öffnet das Detail-Modal.
  $("#jobDock").addEventListener("click", (e) => {
    const x = e.target.closest("[data-cancel]");
    if (x) { e.stopPropagation(); cancelJob(x.dataset.cancel); return; }
    const b = e.target.closest("[data-job]");
    if (b) openJobModal(b.dataset.job);
  });

  $("#settingsBtn").addEventListener("click", openSettingsModal);
  $("#closeSettingsModal").addEventListener("click", closeSettingsModal);
  $("#cancelSettingsBtn").addEventListener("click", closeSettingsModal);
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#exportCsvBtn").addEventListener("click", () => downloadFile("/api/leads/export.csv"));
  $("#exportXlsxBtn").addEventListener("click", () => downloadFile("/api/leads/export.xlsx"));
  $("#importCsvBtn").addEventListener("click", importCsv);

  $("#search").addEventListener("input", (e) => {
    searchTerm = e.target.value.toLowerCase().trim();
    renderLeads();
  });

  $("#statusFilters").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    renderStatusFilters();
    renderLeads();
  });

  $("#viewToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (!btn) return;
    view = btn.dataset.view;
    localStorage.setItem("leadpilot_view", view);
    renderViewToggle();
    renderLeads();
  });

  // Klick auf eine Karte (Liste oder Board) öffnet die Detailseite.
  const onCardNav = (e) => {
    const card = e.target.closest("[data-nav]");
    if (!card) return;
    if (dragMoved) return; // war ein Drag im Board, keine Navigation
    location.hash = "#/lead/" + encodeURIComponent(card.dataset.nav);
  };
  $("#leadList").addEventListener("click", onCardNav);
  $("#leadList").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest("[data-nav]");
    if (!card) return;
    e.preventDefault();
    location.hash = "#/lead/" + encodeURIComponent(card.dataset.nav);
  });
  $("#kanban").addEventListener("click", (e) => {
    const head = e.target.closest("[data-collapse]");
    if (head) {
      const s = head.dataset.collapse;
      collapsedStatuses.has(s) ? collapsedStatuses.delete(s) : collapsedStatuses.add(s);
      saveCollapsed();
      renderKanban();
      return;
    }
    onCardNav(e);
  });
  bindKanbanDnd();

  // Detailseite: ein delegierter Handler für alle Aktionen.
  $("#detailView").addEventListener("click", onDetailClick);
  // Aktivitäten-Formular – delegiert, da das Panel per innerHTML neu
  // aufgebaut wird.
  $("#detailView").addEventListener("submit", (e) => {
    if (e.target.id === "activityForm") { e.preventDefault(); addDetailActivity(); }
  });

  // Schließen per Klick auf Overlay
  document.querySelectorAll(".modal-overlay").forEach((ov) => {
    ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.classList.add("hidden");
    });
  });
}

// --- Lead-Formular (manuelles Anlegen) -------------------------------------
function openLeadModal(id) {
  const form = $("#leadForm");
  form.reset();
  if (id) {
    const l = getLead(id);
    if (!l) return;
    $("#modalTitle").textContent = "Lead bearbeiten";
    $("#leadId").value = l.id;
    $("#f_name").value = l.name;
    $("#f_company").value = l.company;
    $("#f_email").value = l.email;
    $("#f_phone").value = l.phone;
    $("#f_source").value = l.source;
    $("#f_value").value = l.value;
    $("#f_status").value = l.status;
    $("#f_next_step").value = l.nextStep || "";
    $("#f_next_step_at").value = l.nextStepAt || "";
    $("#f_notes").value = l.notes;
  } else {
    $("#modalTitle").textContent = "Neuer Lead";
    $("#leadId").value = "";
    $("#f_status").value = statuses[0];
  }
  $("#leadModal").classList.remove("hidden");
  $("#f_name").focus();
}

function closeLeadModal() {
  $("#leadModal").classList.add("hidden");
}

async function saveLead(e) {
  e.preventDefault();
  const id = $("#leadId").value;
  const payload = {
    name: $("#f_name").value,
    company: $("#f_company").value,
    email: $("#f_email").value,
    phone: $("#f_phone").value,
    source: $("#f_source").value,
    value: $("#f_value").value,
    status: $("#f_status").value,
    nextStep: $("#f_next_step").value,
    nextStepAt: $("#f_next_step_at").value,
    notes: $("#f_notes").value,
  };
  try {
    if (id) {
      await api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("Lead aktualisiert", "success");
      closeLeadModal();
      await refresh();
    } else {
      await createLeadFromPayload(payload);
    }
  } catch (err) {
    // Dublettenwarnung (409) → Dialog statt Toast.
    if (err.status === 409 && err.data && err.data.duplicates) {
      showDuplicateDialog(err.data.duplicates, payload);
      return;
    }
    toast(err.message, "error");
  }
}

// Legt einen neuen Lead an (optional mit force, um Dubletten zu übergehen).
async function createLeadFromPayload(payload) {
  const created = await api("/api/leads", { method: "POST", body: JSON.stringify(payload) });
  toast("Lead angelegt", "success");
  closeLeadModal();
  await refresh();
  if (created && created.id) location.hash = "#/lead/" + encodeURIComponent(created.id);
}

// Dubletten-Dialog: bestehenden Lead öffnen ODER trotzdem anlegen.
function showDuplicateDialog(duplicates, payload) {
  const body = $("#dupBody");
  body.innerHTML = duplicates.map((d) => `
    <div class="dup-item">
      <div>
        <strong>${esc(d.company || d.name || "—")}</strong>
        <span class="d-muted">${esc([d.email, d.name && d.company ? d.name : ""].filter(Boolean).join(" · "))}</span>
      </div>
      <span class="status-pill s-${d.status}">${esc(d.status)}</span>
    </div>`).join("");
  const open = $("#dupOpen");
  open.onclick = () => {
    closeDupModal();
    closeLeadModal();
    location.hash = "#/lead/" + encodeURIComponent(duplicates[0].id);
  };
  $("#dupForce").onclick = async () => {
    closeDupModal();
    try {
      await createLeadFromPayload({ ...payload, force: true });
    } catch (err) {
      toast(err.message, "error");
    }
  };
  $("#dupModal").classList.remove("hidden");
}

function closeDupModal() {
  $("#dupModal").classList.add("hidden");
}

// Wiedervorlage als erledigt markieren: nächsten Schritt leeren + protokollieren
// (inkl. Grund der Wiedervorlage im Aktivitäts-Log).
async function completeNextStep(id) {
  const l = getLead(id);
  const step = l && l.nextStep ? l.nextStep : "";
  try {
    await api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify({ nextStep: "", nextStepAt: null }) });
    await api(`/api/leads/${id}/activities`, {
      method: "POST",
      body: JSON.stringify({
        type: "system",
        title: step ? `Wiedervorlage erledigt: ${step}` : "Wiedervorlage erledigt",
      }),
    });
    toast("Wiedervorlage erledigt", "success");
    await refresh();
    renderDetail();
    loadDetailExtras(id);
  } catch (err) {
    toast(err.message, "error");
  }
}

// Eigenes, schlankes Modal zum Planen/Bearbeiten der Wiedervorlage.
function openNextStepModal(id) {
  const l = getLead(id);
  if (!l) return;
  $("#ns_lead_id").value = id;
  $("#ns_step").value = l.nextStep || "";
  $("#ns_at").value = l.nextStepAt || "";
  const planned = l.nextStep || l.nextStepAt;
  $("#nsModalTitle").textContent = planned ? "Wiedervorlage bearbeiten" : "Wiedervorlage planen";
  $("#nsClear").classList.toggle("hidden", !planned);
  $("#nextStepModal").classList.remove("hidden");
  $("#ns_step").focus();
}

function closeNextStepModal() {
  $("#nextStepModal").classList.add("hidden");
}

async function saveNextStep(e, clear = false) {
  if (e) e.preventDefault();
  const id = $("#ns_lead_id").value;
  const payload = clear
    ? { nextStep: "", nextStepAt: null }
    : { nextStep: $("#ns_step").value, nextStepAt: $("#ns_at").value };
  try {
    await api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify(payload) });
    toast(clear ? "Wiedervorlage entfernt" : "Wiedervorlage gespeichert", "success");
    closeNextStepModal();
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
}

// DSGVO-Datenauskunft: alle Daten des Leads als JSON herunterladen.
async function exportLead(id) {
  try {
    const data = await api(`/api/leads/${id}/export`);
    const l = data.lead || {};
    const slug = (l.company || l.name || "lead").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lead-${slug || "export"}-${todayYMD()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Datenauskunft heruntergeladen", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

// PDF-Export der Lead-Details: baut ein eigenständiges, druckfreundliches
// HTML-Dokument und öffnet den Druckdialog. Der Browser bietet dort „Als PDF
// speichern" – dependency-frei und mit korrekten Umlauten. Aktivitäten werden
// über den vorhandenen Export-Endpunkt mitgeladen.
async function exportLeadPdf(id) {
  try {
    const data = await api(`/api/leads/${id}/export`);
    const l = data.lead || {};
    const activities = Array.isArray(data.activities) ? data.activities : [];
    const html = buildLeadPdfHtml(l, activities);
    const win = window.open("", "_blank");
    if (!win) {
      toast("Bitte Pop-ups erlauben, um das PDF zu erzeugen.", "error");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Erzeugt das vollständige, eigenständige HTML-Dokument für den PDF-Druck.
function buildLeadPdfHtml(l, activities) {
  const r = l.research;
  const ai = l.ai;
  const title = l.company || l.name || "Lead";

  const row = (label, value) =>
    value ? `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>` : "";

  const stammdaten = `
    <table class="kv">
      ${row("Firma", l.company)}
      ${row("Ansprechpartner", l.name)}
      ${row("E-Mail", l.email)}
      ${row("Telefon", l.phone)}
      ${row("Quelle", l.source)}
      ${row("Status", l.status)}
      ${row("Geschätzter Wert", fmtEuro(l.value))}
      ${row("Nächster Schritt", l.nextStep)}
      ${row("Wiedervorlage", l.nextStepAt ? fmtDate(l.nextStepAt) : "")}
      ${row("Angelegt", fmtDateTime(l.createdAt))}
    </table>`;

  const aiBox = ai
    ? `<section>
         <h2>KI-Bewertung</h2>
         <p><strong>Score: ${esc(ai.score)}/100</strong> · Note ${esc(ai.grade || "—")}</p>
         ${ai.reasoning ? `<p>${esc(ai.reasoning)}</p>` : ""}
         ${ai.valueReasoning ? `<p><strong>Wert (12 Monate):</strong> ${esc(ai.valueReasoning)}</p>` : ""}
       </section>`
    : "";

  const notes = l.notes
    ? `<section><h2>Notizen</h2><p>${esc(l.notes).replace(/\n/g, "<br>")}</p></section>`
    : "";

  let dossier = "";
  if (r) {
    const f = r.fields || {};
    const fieldRows = RESEARCH_FIELDS.map(([key, label]) => {
      const v = fieldVal(f[key]);
      return v ? `<tr><th>${esc(label)}</th><td>${esc(v)}</td></tr>` : "";
    }).join("");

    const sect = (heading, text) =>
      text ? `<section><h3>${esc(heading)}</h3><p>${esc(text).replace(/\n/g, "<br>")}</p></section>` : "";

    const pots = Array.isArray(r.potenziale) && r.potenziale.length
      ? `<ul>${r.potenziale.map((p) =>
          `<li><strong>${esc(p.titel)}</strong>${p.beschreibung ? `: ${esc(p.beschreibung)}` : ""}${p.signal ? ` <em>(Signal: ${esc(p.signal)})</em>` : ""}</li>`
        ).join("")}</ul>`
      : "";

    dossier = `
      <section class="dossier">
        <h2>Recherche-Dossier</h2>
        ${r.rechercheStand ? `<p class="muted">Recherche-Stand: ${esc(r.rechercheStand)}</p>` : ""}
        ${fieldRows ? `<table class="kv">${fieldRows}</table>` : ""}
        ${sect("Negative Bewertungen → Potenzial", r.negativeBewertungen)}
        ${sect("Einordnung / Selbstdarstellung", r.einordnung)}
        ${sect("Eingesetzte Systeme / Integrationspotenzial", r.eingesetzteSysteme)}
        ${sect("Sichtbare Schwachstellen / Ansatzpunkte", r.schwachstellen)}
        ${pots ? `<section><h3>Potenziale für FU/GE</h3>${pots}</section>` : ""}
        ${sect("Strategie für Cold Call", r.coldCallStrategie)}
        ${sect("Risiken / Denkbare Ablehnungsgründe", r.risiken)}
      </section>`;
  }

  let timeline = "";
  if (activities.length) {
    const items = activities.map((a) => {
      const m = ACTIVITY_META[a.type] || ACTIVITY_META.note;
      const head = a.title || m.label;
      const who = a.actor && a.actor !== "—" ? ` · ${a.actor}` : "";
      return `<li>
        <div class="act-head">${m.icon} <strong>${esc(head)}</strong>
          <span class="muted">${esc(fmtDateTime(a.createdAt))}${esc(who)}</span></div>
        ${a.body ? `<p>${esc(a.body).replace(/\n/g, "<br>")}</p>` : ""}
        ${a.outcome ? `<p class="muted">Ergebnis: ${esc(a.outcome)}</p>` : ""}
      </li>`;
    }).join("");
    timeline = `<section><h2>Aktivitäten</h2><ul class="acts">${items}</ul></section>`;
  }

  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8">
<title>Lead · ${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
         color: #1a2330; margin: 32px; font-size: 13px; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #0A7A3B; color: #0A7A3B; }
  h3 { font-size: 13px; margin: 14px 0 4px; }
  .sub { color: #5b6878; margin: 0 0 4px; }
  .pills { margin: 6px 0 4px; }
  .pill { display: inline-block; background: #eef2f8; border-radius: 999px;
          padding: 3px 12px; font-weight: 600; margin-right: 6px; }
  table.kv { border-collapse: collapse; width: 100%; margin: 6px 0; }
  table.kv th { text-align: left; width: 200px; vertical-align: top; color: #5b6878;
                font-weight: 600; padding: 4px 10px 4px 0; }
  table.kv td { padding: 4px 0; vertical-align: top; }
  section { page-break-inside: avoid; }
  p { margin: 4px 0; }
  .muted { color: #5b6878; font-size: 12px; }
  ul.acts { list-style: none; padding: 0; margin: 0; }
  ul.acts li { border-left: 2px solid #e2e8f0; padding: 4px 0 10px 12px; margin-left: 4px; }
  ul.acts .act-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .foot { margin-top: 28px; padding-top: 8px; border-top: 1px solid #e2e8f0;
          color: #8a96a6; font-size: 11px; }
  @media print { body { margin: 0; } @page { margin: 16mm; } }
</style></head>
<body onload="window.print()">
  <h1>${esc(title)}</h1>
  ${l.company && l.name ? `<p class="sub">${esc(l.name)}</p>` : ""}
  <div class="pills">
    <span class="pill">${esc(l.status)}</span>
    <span class="pill">${esc(fmtEuro(l.value))}</span>
    ${ai ? `<span class="pill">KI-Score ${esc(ai.score)} · ${esc(ai.grade || "—")}</span>` : ""}
  </div>
  <section><h2>Stammdaten</h2>${stammdaten}</section>
  ${aiBox}
  ${notes}
  ${dossier}
  ${timeline}
  <div class="foot">FU/GE Solutions · erstellt am ${esc(fmtDateTime(new Date().toISOString()))}</div>
</body></html>`;
}

async function deleteLead(id, fromDetail = false) {
  const l = getLead(id);
  const name = l?.company || l?.name || "—";
  if (!confirm(`Lead "${name}" und alle zugehörigen Aktivitäten endgültig löschen?\n\nDies entspricht einer DSGVO-Löschung (Art. 17) und kann nicht rückgängig gemacht werden.`)) return;
  try {
    await api(`/api/leads/${id}`, { method: "DELETE" });
    toast("Lead gelöscht", "success");
    if (fromDetail) {
      location.hash = "#/";
      await refresh();
    } else {
      await refresh();
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- Einstellungen ---------------------------------------------------------
// Wahrscheinlichkeitsfelder für die offenen Status (ohne gewonnen/verloren).
function renderStageProbFields() {
  const open = statuses.filter((s) => s !== "gewonnen" && s !== "verloren");
  $("#stageProbFields").innerHTML = open
    .map(
      (s) => `<div class="prob-item">
        <span class="prob-label">${esc(s)}</span>
        <input type="number" min="0" max="100" step="5" data-prob="${esc(s)}" value="${Number(stageProbabilities[s] ?? 0)}" />
        <span class="prob-pct">%</span>
      </div>`
    )
    .join("");
}

function openSettingsModal() {
  const sel = $("#settingsModel");
  if (models.length) {
    sel.innerHTML = models
      .map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`)
      .join("");
    sel.value = currentModel;
    sel.disabled = false;
  } else {
    sel.innerHTML = `<option>KI nicht konfiguriert (ANTHROPIC_API_KEY fehlt)</option>`;
    sel.disabled = true;
  }
  renderStageProbFields();
  $("#settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  $("#settingsModal").classList.add("hidden");
}

async function saveSettings(e) {
  e.preventDefault();
  const body = {};
  if (models.length) body.model = $("#settingsModel").value;
  const probs = {};
  document.querySelectorAll("#stageProbFields [data-prob]").forEach((el) => {
    probs[el.dataset.prob] = Number(el.value);
  });
  body.stageProbabilities = probs;
  try {
    const cfg = await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    currentModel = cfg.model;
    stageProbabilities = cfg.stageProbabilities || stageProbabilities;
    renderAiBadge({ aiEnabled, model: currentModel });
    await refresh(); // Pipeline-Wert mit den neuen Gewichten neu berechnen
    toast("Einstellungen gespeichert", "success");
    closeSettingsModal();
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- Daten-Import & -Export (Einstellungen) --------------------------------
// Startet einen Datei-Download für eine Server-Route mit attachment-Disposition.
function downloadFile(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// CSV-Import: liest die gewählte Datei, schickt sie an den Server und meldet das
// Ergebnis. Anschließend wird die Lead-Liste aktualisiert.
async function importCsv() {
  const input = $("#importCsvInput");
  const file = input.files && input.files[0];
  if (!file) {
    toast("Bitte zuerst eine CSV-Datei auswählen.", "error");
    return;
  }
  const btn = $("#importCsvBtn");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Importiere…";
  try {
    const csv = await file.text();
    const res = await api("/api/leads/import", {
      method: "POST",
      body: JSON.stringify({ csv }),
    });
    const parts = [`${res.created} angelegt`];
    if (res.enriched) parts.push(`${res.enriched} ergänzt`);
    if (res.skippedDuplicate) parts.push(`${res.skippedDuplicate} Dublette(n) unverändert`);
    if (res.skippedEmpty) parts.push(`${res.skippedEmpty} leer`);
    if (res.errors && res.errors.length) parts.push(`${res.errors.length} fehlerhaft`);
    toast("Import: " + parts.join(" · "), res.created || res.enriched ? "success" : "");
    input.value = "";
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// --- Lead-Recherche (Hintergrund-Jobs + Dock) ------------------------------
// Laufende Recherche-Jobs: jobId -> { id, label, status, steps, startTs, leadId }
const jobs = new Map();
let modalJobId = null; // welchen Job zeigt das Modal gerade (null = frische Eingabe)?

// Öffnet das Modal für eine NEUE Recherche-Eingabe.
function openResearchModal() {
  modalJobId = null;
  stopResearchTimer();
  $("#researchForm").reset();
  $("#researchInput").disabled = false;
  $("#researchHint").classList.remove("hidden");
  $("#researchLoading").classList.add("hidden");
  $("#startResearchBtn").classList.remove("hidden");
  $("#abortResearchBtn").classList.add("hidden");
  $("#cancelResearchBtn").textContent = "Abbrechen";
  const steps = $("#researchSteps");
  steps.classList.add("hidden");
  steps.innerHTML = "";
  $("#researchModal").classList.remove("hidden");
  $("#researchInput").focus();
}

// Öffnet das Modal als Detailansicht eines bereits laufenden Jobs.
function openJobModal(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  modalJobId = jobId;
  $("#researchInput").value = job.label;
  $("#researchInput").disabled = true;
  $("#researchHint").classList.add("hidden");
  $("#startResearchBtn").classList.add("hidden");
  $("#abortResearchBtn").classList.remove("hidden");
  $("#cancelResearchBtn").textContent = "Im Hintergrund weiter ↓";
  $("#researchLoading").classList.remove("hidden");
  renderSteps(job.steps, job.status !== "running");
  startResearchTimer(job.startTs);
  $("#researchModal").classList.remove("hidden");
}

// Zeigt die Recherche-Schritte als Timeline. Der jeweils letzte Schritt ist
// „aktiv" (pulsierender Punkt), abgeschlossene Schritte bekommen einen Haken-Punkt.
function renderSteps(list, finished = false) {
  const el = $("#researchSteps");
  el.classList.remove("hidden");
  const items = (list || []).slice(-20);
  el.innerHTML = items
    .map((s, i) => {
      const isLast = i === items.length - 1;
      const cls = isLast && !finished ? "active" : "done";
      return `<li class="${cls}"><span class="step-dot"></span><span class="step-text">${esc(s.text)}</span></li>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

// Live-Timer für die Recherchedauer (mm:ss), gerechnet ab Job-Start.
let researchTimerId = null;
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function startResearchTimer(startTs) {
  stopResearchTimer();
  const el = $("#researchElapsed");
  const base = startTs || Date.now();
  const tick = () => { if (el) el.textContent = fmtElapsed(Date.now() - base); };
  tick();
  researchTimerId = setInterval(tick, 1000);
}
function stopResearchTimer() {
  if (researchTimerId) {
    clearInterval(researchTimerId);
    researchTimerId = null;
  }
}

// Modal schließen = minimieren. Der Job läuft serverseitig weiter und bleibt
// im Dock sichtbar.
function closeResearchModal() {
  stopResearchTimer();
  modalJobId = null;
  $("#researchModal").classList.add("hidden");
}

// Laufende Jobs in localStorage sichern, damit das Dock einen Seiten-Reload
// übersteht (die Recherche läuft serverseitig weiter).
const JOBS_KEY = "leadpilot_jobs";
function persistJobs() {
  const arr = [...jobs.values()].map((j) => ({ id: j.id, label: j.label, startTs: j.startTs }));
  try { localStorage.setItem(JOBS_KEY, JSON.stringify(arr)); } catch {}
}
function dropJob(jobId) {
  jobs.delete(jobId);
  persistJobs();
  renderDock();
}

// Bricht eine laufende Recherche ab (serverseitig via AbortController).
async function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (job && !confirm(`Recherche „${job.label}" wirklich abbrechen?`)) return;
  try {
    await api(`/api/research/${jobId}/cancel`, { method: "POST" });
  } catch (err) {
    /* Job evtl. schon weg – egal, lokal aufräumen */
  }
  const wasOpen = modalJobId === jobId;
  dropJob(jobId);
  toast("Recherche abgebrochen", "");
  if (wasOpen) closeResearchModal();
}

// Job registrieren und Polling starten. startTs optional (für Wiederaufnahme).
function addJob(jobId, label, startTs) {
  jobs.set(jobId, { id: jobId, label, status: "running", steps: [], startTs: startTs || Date.now(), leadId: null });
  persistJobs();
  renderDock();
  pollJob(jobId);
}

// Nimmt nach einem Seiten-Reload noch laufende Jobs aus localStorage wieder auf.
function resumeJobs() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(JOBS_KEY) || "[]"); } catch {}
  if (!Array.isArray(arr)) return;
  for (const j of arr) {
    if (j && j.id && !jobs.has(j.id)) addJob(j.id, j.label || "Recherche", j.startTs);
  }
}

// Pollt EINEN Job unabhängig vom Modal bis fertig/Fehler.
async function pollJob(jobId) {
  let misses = 0;
  while (true) {
    await sleep(1500);
    const job = jobs.get(jobId);
    if (!job) return; // wurde entfernt
    let res;
    try {
      res = await fetch(`/api/research/${jobId}`, { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      if (++misses > 20) { dropJob(jobId); return; }
      continue; // einzelne fehlgeschlagene Polls tolerieren
    }
    if (res.status === 404) { dropJob(jobId); return; } // Job abgelaufen/unbekannt
    let data;
    try { data = await res.json(); } catch { continue; }
    if (!res.ok) { if (++misses > 20) { dropJob(jobId); return; } continue; }
    misses = 0;

    job.steps = data.steps || job.steps;
    job.status = data.status;
    if (data.lead && data.lead.id) job.leadId = data.lead.id;
    if (modalJobId === jobId) renderSteps(job.steps, data.status !== "running");
    renderDock();

    if (data.status === "done") {
      const wasOpen = modalJobId === jobId;
      dropJob(jobId);
      toast(`✅ Recherche fertig: ${job.label}`, "success");
      await refresh();
      if (wasOpen) {
        closeResearchModal();
        if (job.leadId) location.hash = "#/lead/" + encodeURIComponent(job.leadId);
      }
      return;
    }
    if (data.status === "error") {
      const wasOpen = modalJobId === jobId;
      dropJob(jobId);
      toast(data.error || `Recherche fehlgeschlagen: ${job.label}`, "error");
      if (wasOpen) closeResearchModal();
      return;
    }
    if (data.status === "cancelled") {
      // z. B. aus einem anderen Tab abgebrochen
      const wasOpen = modalJobId === jobId;
      dropJob(jobId);
      if (wasOpen) closeResearchModal();
      return;
    }
  }
}

// Rendert das Dock laufender Jobs unten rechts. Aktualisiert IN PLACE: neue
// Jobs werden hinzugefügt (einmalige Einblend-Animation), bestehende Chips nur
// im Text aktualisiert. So zuckt/flackert nichts bei jedem Poll.
function renderDock() {
  const dock = $("#jobDock");
  const list = [...jobs.values()];
  dock.classList.toggle("hidden", list.length === 0);

  const seen = new Set();
  for (const j of list) {
    seen.add(j.id);
    const last = j.steps && j.steps.length ? j.steps[j.steps.length - 1].text : "Starte…";
    let chip = dock.querySelector(`[data-job="${j.id}"]`);
    if (!chip) {
      chip = document.createElement("button");
      chip.className = "job-chip";
      chip.setAttribute("data-job", j.id);
      chip.title = "Recherche-Fortschritt öffnen";
      chip.innerHTML =
        `<span class="spinner"></span>` +
        `<span class="job-chip-body">` +
        `<span class="job-chip-title"></span>` +
        `<span class="job-chip-step"></span></span>` +
        `<span class="job-chip-x" data-cancel="${j.id}" role="button" title="Recherche abbrechen">✕</span>`;
      chip.querySelector(".job-chip-title").textContent = "🔎 " + j.label;
      dock.appendChild(chip);
    }
    const stepEl = chip.querySelector(".job-chip-step");
    if (stepEl.textContent !== last) stepEl.textContent = last;
  }
  // Nicht mehr laufende Jobs entfernen.
  dock.querySelectorAll("[data-job]").forEach((el) => {
    if (!seen.has(el.getAttribute("data-job"))) el.remove();
  });
}

async function submitResearch(e) {
  e.preventDefault();
  const input = $("#researchInput").value.trim();
  if (!input) {
    toast("Bitte Website oder Firmennamen eingeben", "error");
    return;
  }
  try {
    const { jobId } = await api("/api/leads/research", {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    addJob(jobId, input);
    openJobModal(jobId);
  } catch (err) {
    toast(err.message, "error");
  }
}

// Recherchiert einen bestehenden Lead neu.
async function researchLead(id, btn) {
  const l = getLead(id);
  let body = {};
  let label = (l && (l.company || l.source)) || "";
  if (l && l.research) {
    const suggested = l.research.input || l.company || "";
    const input = prompt("Was soll recherchiert werden? (Website oder Firmenname)", suggested);
    if (input === null) return;
    const t = input.trim();
    if (!t) return;
    body = { input: t };
    label = t;
  } else if (!(l && (l.company || l.source))) {
    const input = prompt("Website oder Firmenname für die Recherche:", "");
    if (input === null) return;
    const t = input.trim();
    if (!t) return;
    body = { input: t };
    label = t;
  }
  try {
    const { jobId } = await api(`/api/leads/${id}/research`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    addJob(jobId, label);
    openJobModal(jobId);
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- KI-Aktionen (auf der Detailseite) -------------------------------------
async function runAi(action, id, btn) {
  if (action === "score") {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = "⏳ …";
    try {
      await api(`/api/leads/${id}/score`, { method: "POST" });
      toast("KI-Bewertung erstellt", "success");
      await refresh();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = orig;
    }
    return;
  }

  const out = $("#aiOutput");
  out.classList.remove("hidden");
  out.innerHTML = `<div class="ai-loading"><span class="spinner"></span> KI arbeitet…</div>`;

  try {
    let body = {};
    if (action === "email") {
      const goal = prompt(
        "Ziel der E-Mail (optional):",
        "Erstkontakt herstellen und ein kurzes Kennenlerngespräch vorschlagen"
      );
      if (goal === null) {
        out.classList.add("hidden");
        return;
      }
      body = { goal };
    }
    const data = await api(`/api/leads/${id}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const text = data.email || data.insights || "";
    const title = action === "email" ? "✉️ E-Mail-Entwurf" : "💡 Empfehlung";
    out.innerHTML = `
      <div class="ai-output-head">
        <strong>${title}</strong>
        <button class="btn btn-sm" id="copyAiOut">📋 Kopieren</button>
      </div>
      <pre class="ai-result">${esc(text)}</pre>`;
    $("#copyAiOut").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast("In Zwischenablage kopiert", "success");
      } catch {
        toast("Kopieren nicht möglich", "error");
      }
    });
  } catch (err) {
    out.innerHTML = `<p class="warn">Fehler: ${esc(err.message)}</p>`;
  }
}

// --- Detailseite: Tab-Umschaltung + Aktivitäten (Aktionen) -----------------
function switchDetailTab(name) {
  document.querySelectorAll("[data-dtab]").forEach((b) => b.classList.toggle("active", b.dataset.dtab === name));
  document.querySelectorAll("[data-dtab-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.dtabPanel !== name));
}

async function addDetailActivity() {
  const type = composerType;
  const bodyEl = $("#act_body");
  const body = bodyEl ? bodyEl.value.trim() : "";
  const outEl = $("#act_outcome");
  const outcome = outEl ? outEl.value.trim() : "";
  if (!body && !outcome) {
    toast("Bitte etwas eingeben", "error");
    return;
  }
  try {
    await api(`/api/leads/${detailId}/activities`, {
      method: "POST",
      body: JSON.stringify({ type, body, outcome }),
    });
    toast("Aktivität festgehalten", "success");
    loadDetailExtras(detailId);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function removeActivity(actId) {
  if (!confirm("Diese Aktivität löschen?")) return;
  try {
    await api(`/api/activities/${actId}`, { method: "DELETE" });
    loadDetailExtras(detailId);
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- Berichte-Ansicht ------------------------------------------------------
const MONTH_SHORT = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
function monthLabel(ym) {
  const [, m] = ym.split("-");
  return MONTH_SHORT[Number(m) - 1] || ym;
}

// Einfaches, abhängigkeitsfreies SVG-Säulendiagramm.
function barChart(series, { format = (v) => v, color = "var(--primary)" } = {}) {
  if (!series.length) return `<p class="d-muted">Keine Daten.</p>`;
  const max = Math.max(1, ...series.map((s) => s.value));
  const W = 640, H = 180, pad = 24, bw = (W - pad * 2) / series.length;
  const bars = series.map((s, i) => {
    const h = Math.round((s.value / max) * (H - 40));
    const x = pad + i * bw;
    const y = H - 20 - h;
    const cx = x + bw / 2;
    return `
      <g>
        <rect x="${x + bw * 0.15}" y="${y}" width="${bw * 0.7}" height="${h}" rx="3" fill="${color}">
          <title>${esc(s.label)}: ${esc(String(format(s.value)))}</title>
        </rect>
        ${s.value ? `<text x="${cx}" y="${y - 4}" class="bar-val">${esc(String(format(s.value)))}</text>` : ""}
        <text x="${cx}" y="${H - 6}" class="bar-lbl">${esc(s.label)}</text>
      </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="bar-chart" preserveAspectRatio="xMidYMid meet">${bars}</svg>`;
}

// Kräftige (dunklere) Status-Farben – guter Kontrast zu weißer Schrift im Trichter.
const FUNNEL_COLORS = {
  neu: "#6B706D",
  kontaktiert: "#529C72",
  qualifiziert: "#0A7A3B",
  angebot: "#B8740A",
  gewonnen: "#127A38",
};

// Echter, sich verjüngender SVG-Trichter. Stufen = Pipeline ohne "verloren".
// Zwischen den Stufen wird die Konversionsrate zur nächsten Stufe gezeigt.
function funnelHtml(funnel) {
  const stages = funnel.filter((f) => f.status !== "verloren");
  const total = stages.reduce((a, f) => a + f.count, 0);
  if (!total) return `<p class="d-muted">Noch keine Leads in der Pipeline.</p>`;

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const W = 720, segH = 72, gap = 4, padTop = 8;
  const H = padTop + stages.length * segH + (stages.length - 1) * gap + 8;
  const cx = W * 0.42;            // Trichter etwas links, rechts Platz für Konversionswerte
  const maxW = W * 0.62, minW = 120;
  const maxCount = Math.max(1, ...stages.map((s) => s.count));
  const widthFor = (c) => minW + (c / maxCount) * (maxW - minW);

  let y = padTop;
  const segs = stages.map((s, i) => {
    const next = stages[i + 1];
    const topW = widthFor(s.count);
    const botW = next ? widthFor(next.count) : topW * 0.82;
    const yTop = y, yBot = y + segH, mid = (yTop + yBot) / 2;
    const pts = `${cx - topW / 2},${yTop} ${cx + topW / 2},${yTop} ${cx + botW / 2},${yBot} ${cx - botW / 2},${yBot}`;
    const color = FUNNEL_COLORS[s.status] || "var(--primary)";

    let conv = "";
    if (next) {
      const pct = s.count ? Math.round((next.count / s.count) * 100) : 0;
      conv = `<g>
        <line x1="${cx + botW / 2}" y1="${yBot}" x2="${W - 160}" y2="${yBot}" class="funnel-guide" />
        <text x="${W - 152}" y="${yBot - 3}" class="funnel-conv-pct">${pct} %</text>
        <text x="${W - 152}" y="${yBot + 13}" class="funnel-conv-cap">${esc(cap(s.status))} → ${esc(next.status)}</text>
      </g>`;
    }
    y = yBot + gap;
    return `<g>
      <polygon points="${pts}" fill="${color}" fill-opacity="0.92" stroke="${color}" />
      <text x="${cx}" y="${mid - 4}" class="funnel-name">${esc(cap(s.status))}</text>
      <text x="${cx}" y="${mid + 15}" class="funnel-sub">${s.count} · ${esc(fmtEuro(Math.round(s.value)))}</text>
      ${conv}
    </g>`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="funnel-chart" preserveAspectRatio="xMidYMid meet">${segs}</svg>`;
}

async function renderReportsView() {
  const v = $("#reportsView");
  v.innerHTML = `<div class="view-head"><h2>📊 Berichte</h2></div><p class="d-muted">Lädt…</p>`;
  let r;
  try {
    r = await api("/api/report");
  } catch (err) {
    v.innerHTML = `<p class="warn">Fehler: ${esc(err.message)}</p>`;
    return;
  }
  const s = r.stats;
  const eur = (v) => fmtEuro(Math.round(v));

  const kpis = [
    ["Leads gesamt", s.total],
    ["Pipeline (gewichtet)", eur(s.weightedPipelineValue)],
    ["Gewonnen", eur(s.wonValue)],
    ["Abschlussquote", s.conversion + " %"],
    ["Ø Auftragswert", eur(r.avgWon)],
    ["Ø Vertriebszyklus", r.avgCycleDays ? r.avgCycleDays + " Tage" : "—"],
  ].map(([label, val]) => `<div class="stat-card"><span class="stat-value">${esc(String(val))}</span><span class="stat-label">${esc(label)}</span></div>`).join("");

  const won = r.wonByMonth.map((m) => ({ label: monthLabel(m.month), value: m.value }));
  const activity = r.activityByMonth.map((m) => ({ label: monthLabel(m.month), value: m.value }));

  // Verlust-Übersicht: Anzahl, Wert und Verlustquote (gegen abgeschlossene Deals).
  const lost = r.funnel.find((f) => f.status === "verloren") || { count: 0, value: 0 };
  const won_n = s.byStatus["gewonnen"] || 0;
  const decided = won_n + lost.count;
  const lostRate = decided ? Math.round((lost.count / decided) * 100) : 0;

  v.innerHTML = `
    <div class="view-head"><h2>📊 Berichte</h2></div>

    <section class="card report-funnel">
      <h3>Pipeline-Trichter</h3>
      ${funnelHtml(r.funnel)}
    </section>

    <section class="stats report-kpis">${kpis}</section>

    <div class="report-grid">
      <section class="card">
        <h3>Gewonnener Umsatz je Monat</h3>
        ${barChart(won, { color: "var(--green)", format: (val) => (val >= 1000 ? Math.round(val / 1000) + "k" : val) })}
      </section>
      <section class="card">
        <h3>Vertriebsaktivität je Monat</h3>
        ${barChart(activity, { color: "var(--accent)" })}
      </section>
      <section class="card">
        <h3>Verlust-Übersicht</h3>
        <div class="mini-stats">
          <div><span class="mini-val">${lost.count}</span><span class="mini-lbl">Verlorene Leads</span></div>
          <div><span class="mini-val">${esc(eur(lost.value))}</span><span class="mini-lbl">Verlorener Wert</span></div>
          <div><span class="mini-val">${lostRate} %</span><span class="mini-lbl">Verlustquote</span></div>
        </div>
      </section>
    </div>
  `;
}

// --- Toast -----------------------------------------------------------------
let toastTimer;
function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

init();
