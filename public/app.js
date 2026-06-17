"use strict";

// --- Zustand ---------------------------------------------------------------
let leads = [];
let statuses = [];
let aiEnabled = false;
let activeFilter = "alle";
let dueOnly = false; // Filter: nur fällige/überfällige Wiedervorlagen
let staleOnly = false; // Filter: nur "kalte" Leads (lange keine Aktivität)
let tagFilter = ""; // aktiver Tag-Filter ("" = alle)
let sortBy = localStorage.getItem("leadpilot_sort") || "created_desc";
let selectMode = false; // Mehrfachauswahl (Bulk) aktiv?
const selectedIds = new Set(); // ausgewählte Lead-IDs (Bulk)
let discoveryCriteria = null; // zuletzt genutzte Discovery-Kriterien
let prospects = [];           // persistente Prospect-Liste (Discovery-Treffer)
let prospectGroupBy = localStorage.getItem("leadpilot_prospect_group") || "potenzial"; // branche|groesse|potenzial
let prospectStatusFilter = "offen"; // offen|abgelehnt
let prospectSearch = "";
const prospectSelected = new Set(); // ausgewählte Prospect-IDs (Bulk)
let models = [];
let currentModel = "";
let stageProbabilities = {};
let staleDays = 14; // „Kalt"-Schwelle (Tage ohne Aktivität), kommt aus /api/config
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
    staleDays = cfg.staleDays || 14;
    renderUserBar(cfg);
    renderStatusFilters();
    renderViewToggle();
    populateStatusSelect();
    const sb = $("#sortBy");
    if (sb) sb.value = sortBy;
    await refresh();
    loadProspects(); // Prospects für die globale Suche vorladen (rendert versteckt)
  } catch (err) {
    toast(err.message, "error");
  }
  bindEvents();
  setupInfoTips();
  window.addEventListener("hashchange", router);
  router();
  resumeJobs(); // noch laufende Recherchen nach Reload ins Dock zurückholen
}

// "i"-Symbole: zeigen ihren versteckten .info-content als schwebenden Tooltip
// bei Hover/Fokus. Ein gemeinsames, fixed positioniertes Element vermeidet das
// Abschneiden durch das scrollbare Modal.
function setupInfoTips() {
  let tip = document.getElementById("infoTooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "infoTooltip";
    tip.className = "hidden";
    document.body.appendChild(tip);
  }
  const show = (el) => {
    const content = el.querySelector(".info-content");
    if (!content) return;
    tip.innerHTML = content.innerHTML;
    tip.classList.remove("hidden");
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 8) top = r.top - th - 8; // bei wenig Platz nach oben kippen
    tip.style.left = left + "px";
    tip.style.top = Math.max(8, top) + "px";
  };
  const hide = () => tip.classList.add("hidden");
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".info-tip");
    if (el) show(el);
  });
  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest(".info-tip");
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest(".info-tip");
    if (el) show(el);
  });
  document.addEventListener("focusout", (e) => {
    const el = e.target.closest(".info-tip");
    if (el) hide();
  });
}

// Zeigt den angemeldeten Benutzer + Logout-Link klein unten im Einstellungen-
// Modal an. Beides kommt vom Auth-Proxy (über /api/config). Ohne angemeldeten
// Benutzer (z. B. lokal ohne Proxy) bleibt die Zeile ausgeblendet.
function renderUserBar(cfg) {
  const acct = $("#settingsAccount");
  if (!acct) return;
  if (!cfg.user) { acct.hidden = true; acct.innerHTML = ""; return; }
  const logout = cfg.logoutUrl
    ? ` · <a class="settings-logout" href="${esc(cfg.logoutUrl)}" target="_top" rel="noopener">Abmelden</a>`
    : "";
  acct.innerHTML = `Eingeloggt als <strong>${esc(cfg.user)}</strong>${logout}`;
  acct.hidden = false;
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

// --- Routing (Liste ⇄ Detail ⇄ Heute ⇄ Prospects ⇄ Berichte) ---------------
const VIEWS = ["listView", "detailView", "agendaView", "prospectsView", "reportsView"];
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
  if (location.hash === "#/heute") return showAgenda();
  // Discovery ist jetzt ein Modal auf der Prospects-Seite (keine eigene Seite mehr).
  if (location.hash === "#/discovery") { location.hash = "#/prospects"; return; }
  if (location.hash === "#/prospects") return showProspects();
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
  renderTagFilter();
  updateAgendaBadge();
  renderStats(await api("/api/stats"));
  // Die jeweils aktive Ansicht neu zeichnen (Detail, Heute oder Liste/Board).
  if (detailId) {
    renderDetail();
    loadDetailExtras(detailId);
  } else if (location.hash === "#/heute") {
    renderAgenda();
  } else if (location.hash === "#/prospects") {
    loadProspects();
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

// Offener Lead ohne Aktivität (bzw. seit Anlage) seit mehr als staleDays Tagen
// (konfigurierbar in den Einstellungen, Default 14). Gewonnene/verlorene Leads
// zählen nie als kalt.
function isStale(l) {
  if (l.status === "gewonnen" || l.status === "verloren") return false;
  const iso = l.lastActivityAt || l.createdAt;
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() > staleDays * 86400000;
}

// Gemeinsame Filter (Fällig, Kalt, Tag) – ohne Status, da dieser je nach
// Ansicht anders behandelt wird (Chips in der Liste, Spalten im Board). Die
// frühere Textsuche entfällt (globale Schnellsuche in der Topbar übernimmt das).
function matchesCommon(l) {
  const today = todayYMD();
  if (dueOnly && !(l.nextStepAt && l.nextStepAt <= today)) return false;
  if (staleOnly && !isStale(l)) return false;
  if (tagFilter && !(Array.isArray(l.tags) && l.tags.includes(tagFilter))) return false;
  return true;
}

// Sortiert eine Lead-Liste nach der aktuell gewählten Sortierung (sortBy).
function sortLeads(arr) {
  const out = arr.slice();
  const t = (iso) => (iso ? new Date(iso).getTime() : 0);
  const act = (l) => t(l.lastActivityAt) || t(l.createdAt);
  const score = (l) => (l.ai && Number.isFinite(l.ai.score) ? l.ai.score : -1);
  const ns = (l) => (l.nextStepAt ? new Date(l.nextStepAt).getTime() : Infinity);
  const cmp = {
    created_asc: (a, b) => t(a.createdAt) - t(b.createdAt),
    created_desc: (a, b) => t(b.createdAt) - t(a.createdAt),
    activity_desc: (a, b) => act(b) - act(a),
    activity_asc: (a, b) => act(a) - act(b),
    next_step_asc: (a, b) => ns(a) - ns(b),
    score_desc: (a, b) => score(b) - score(a),
    value_desc: (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0),
    company_asc: (a, b) =>
      (a.company || a.name || "").localeCompare(b.company || b.name || "", "de", { sensitivity: "base" }),
  };
  out.sort(cmp[sortBy] || cmp.created_desc);
  return out;
}

function filteredLeads() {
  return sortLeads(leads.filter((l) => {
    if (activeFilter !== "alle" && l.status !== activeFilter) return false;
    return matchesCommon(l);
  }));
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

// Gemeinsame Filter + Sortierung fürs Kanban-Board (der Status-Filter entfällt –
// jede Spalte IST ein Status).
function searchFiltered() {
  return sortLeads(leads.filter(matchesCommon));
}

function renderViewToggle() {
  const sw = $("#viewToggle");
  if (!sw) return;
  sw.querySelectorAll(".vs-option").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  sw.classList.toggle("sw-kanban", view === "kanban");
}

function renderLeads() {
  $("#emptyState").classList.toggle("hidden", leads.length !== 0);
  const isKanban = view === "kanban";
  $("#leadList").classList.toggle("hidden", isKanban);
  $("#kanban").classList.toggle("hidden", !isKanban);
  // Status-Filter-Chips ergeben im Board keinen Sinn (jede Spalte IST ein
  // Status) – nur der Fällig-Filter bleibt sichtbar.
  $("#statusFilters").classList.toggle("hidden", isKanban);
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
  const list = $("#leadList");
  list.classList.toggle("selecting", selectMode);
  list.innerHTML = filteredLeads().map(leadCard).join("");
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
  // Drop-Ziel ist die ganze Spalte (nicht nur die Kartenzone). So lassen sich
  // Karten auch in eingeklappte Spalten ziehen, deren Kartenzone ausgeblendet ist.
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest(".kanban-col");
    if (!col || !dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".kanban-col.drop").forEach((c) => c.classList.remove("drop"));
    col.classList.add("drop");
  });
  board.addEventListener("drop", (e) => {
    const col = e.target.closest(".kanban-col");
    if (!col || !dragId) return;
    e.preventDefault();
    changeStatus(dragId, col.dataset.status);
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

// Tag-Chips (für Karten, Board, Detail).
function tagsHtml(tags, cls = "lead-card-tags") {
  if (!Array.isArray(tags) || !tags.length) return "";
  return `<div class="${cls}">${tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("")}</div>`;
}

// Hinweis auf die letzte Aktivität ("vor 3 Tg."), bei Stillstand als "kalt"
// hervorgehoben (💤). Basis: lastActivityAt bzw. Anlagedatum.
function activityHint(l) {
  const iso = l.lastActivityAt || l.createdAt;
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  const stale = isStale(l);
  const label = days <= 0 ? "heute aktiv" : `vor ${days} Tg.`;
  return `<span class="act-age${stale ? " stale" : ""}" title="Letzte Aktivität: ${esc(fmtDateTime(iso))}">${stale ? "💤" : "🕓"} ${esc(label)}</span>`;
}

// Auswahl-Checkbox (nur im Mehrfachauswahl-Modus).
function selectBoxHtml(l) {
  if (!selectMode) return "";
  return `<label class="lead-select" title="Auswählen">
    <input type="checkbox" data-select="${l.id}" ${selectedIds.has(l.id) ? "checked" : ""} aria-label="Lead auswählen" />
  </label>`;
}

// Kartenansicht: nur Firma, Ansprechpartner, Status, Branche, Wert, KI-Score.
function leadCard(l) {
  const branche = l.research ? fieldVal(l.research.fields && l.research.fields.branche) : "";
  return `<article class="lead-card${selectedIds.has(l.id) ? " selected" : ""}" data-nav="${l.id}" tabindex="0" role="button" aria-label="Lead öffnen">
    ${selectBoxHtml(l)}
    <div class="lead-card-head">
      <div class="lead-card-title">${esc(l.company) || esc(l.name) || "—"}</div>
      <span class="status-pill s-${l.status}">${l.status}</span>
    </div>
    <div class="lead-card-sub">
      ${l.company && l.name ? `<span>👤 ${esc(l.name)}</span>` : ""}
      ${branche ? `<span>🏷️ ${esc(branche)}</span>` : ""}
      ${activityHint(l)}
      ${!l.research ? `<span class="muted-note">keine Recherche</span>` : ""}
    </div>
    ${tagsHtml(l.tags)}
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
    ${tagsHtml(l.tags, "kanban-card-tags")}
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
      <a class="btn btn-sm" href="#/" title="Zurück zur Übersicht">← <span class="btn-text">Zurück</span></a>
      <div class="detail-bar-actions">
        ${aiEnabled && r ? `<button class="btn btn-sm" data-action="research" title="Neu recherchieren">🔄 <span class="btn-text">Neu recherchieren</span></button>` : ""}
        <button class="btn btn-sm" data-action="pdf" title="Lead-Details als PDF (Drucken / Als PDF speichern)">📄 <span class="btn-text">PDF</span></button>
        <button class="btn btn-sm" data-action="export" title="Alle Daten dieses Leads als JSON (DSGVO-Auskunft)">⬇️ <span class="btn-text">Datenauskunft</span></button>
        <button class="btn btn-sm" data-action="edit" title="Lead bearbeiten">✏️ <span class="btn-text">Bearbeiten</span></button>
        <button class="btn btn-sm btn-danger" data-action="delete" title="Lead löschen">🗑️ <span class="btn-text">Löschen</span></button>
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
    Array.isArray(l.tags) && l.tags.length ? ["Tags", tagsHtml(l.tags, "about-tags")] : null,
    l.lastActivityAt ? ["Letzte Aktivität", esc(fmtDateTime(l.lastActivityAt))] : null,
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
        ${input("ed_tags", "Tags (mit Komma getrennt)", Array.isArray(l.tags) ? l.tags.join(", ") : "")}
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
    tags: parseTags(g("ed_tags")),
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
  // FAB der mobilen Tab-Leiste öffnet denselben Recherche-Dialog.
  $("#fabResearchBtn")?.addEventListener("click", openResearchModal);
  // Logo-Fallback auf Wortmarke (zuvor inline onerror – wegen strikter CSP
  // ausgelagert).
  const brandLogo = $("#brandLogo");
  if (brandLogo) {
    brandLogo.addEventListener("error", () => {
      brandLogo.style.display = "none";
      const wm = $("#brandWordmark");
      if (wm) wm.style.display = "inline-block";
    });
  }
  // Empty-State-Button öffnet den Recherche-Dialog (zuvor inline onclick).
  const emptyAdd = $("#emptyStateAddBtn");
  if (emptyAdd) emptyAdd.addEventListener("click", openResearchModal);
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
  $("#closeDiscoveryModal").addEventListener("click", closeDiscoveryModal);
  $("#cancelDiscoveryBtn").addEventListener("click", closeDiscoveryModal);
  $("#discoveryForm").addEventListener("submit", (e) => { e.preventDefault(); submitDiscovery(); });
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
  $("#stageProbFields").addEventListener("input", onProbInput);
  $("#exportCsvBtn").addEventListener("click", () => downloadFile("/api/leads/export.csv"));
  $("#exportXlsxBtn").addEventListener("click", () => downloadFile("/api/leads/export.xlsx"));
  $("#exportProspectsCsvBtn").addEventListener("click", () => downloadFile("/api/prospects/export.csv"));
  $("#importCsvBtn").addEventListener("click", importCsv);
  $("#importProspectsCsvBtn").addEventListener("click", importProspectsCsv);
  setupDropzone("importCsvInput", "importCsvBtn");
  setupDropzone("importProspectsCsvInput", "importProspectsCsvBtn");

  $("#statusFilters").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    renderStatusFilters();
    renderLeads();
  });

  // Sortierung
  $("#sortBy").addEventListener("change", (e) => {
    sortBy = e.target.value;
    localStorage.setItem("leadpilot_sort", sortBy);
    renderLeads();
  });
  // Tag-Filter
  $("#tagFilter").addEventListener("change", (e) => { tagFilter = e.target.value; renderLeads(); });
  // „Kalt"-Filter (Stillstand)
  $("#staleFilter").addEventListener("click", () => {
    staleOnly = !staleOnly;
    $("#staleFilter").classList.toggle("active", staleOnly);
    renderLeads();
  });
  // Mehrfachauswahl ein/aus
  $("#selectToggle").addEventListener("click", () => setSelectMode(!selectMode));
  // Auswahl-Checkboxen in der Liste
  $("#leadList").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-select]");
    if (cb) toggleSelect(cb.dataset.select, cb.checked);
  });

  // Globale Schnellsuche (Topbar)
  const gsInput = $("#globalSearchInput");
  if (gsInput) {
    gsInput.addEventListener("input", (e) => renderGlobalResults(e.target.value));
    gsInput.addEventListener("keydown", onGlobalSearchKey);
    gsInput.addEventListener("focus", (e) => { if (e.target.value.trim()) renderGlobalResults(e.target.value); });
  }
  $("#globalSearchResults").addEventListener("click", (e) => {
    const item = e.target.closest("[data-gs-idx]");
    if (item) runGsResult(Number(item.dataset.gsIdx));
  });
  // Klick außerhalb schließt die Trefferliste.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#globalSearch")) hideGlobalResults();
  });

  // Heute/Agenda: öffnen, erledigen, verschieben/planen.
  $("#agendaView").addEventListener("click", (e) => {
    const done = e.target.closest("[data-agenda-done]");
    if (done) { completeNextStep(done.dataset.agendaDone); return; }
    const edit = e.target.closest("[data-agenda-edit]");
    if (edit) { openNextStepModal(edit.dataset.agendaEdit); return; }
    const open = e.target.closest("[data-nav]");
    if (open) location.hash = "#/lead/" + encodeURIComponent(open.dataset.nav);
  });

  // Prospects-Seite: Live-Suche (nur Gruppen neu zeichnen), Auswahl, Aktionen.
  $("#prospectsView").addEventListener("input", (e) => {
    if (e.target.id === "prospectSearch") { prospectSearch = e.target.value.toLowerCase().trim(); renderProspectGroups(); }
  });
  $("#prospectsView").addEventListener("change", (e) => {
    const cb = e.target.closest("[data-prospect-sel]");
    if (cb) toggleProspectSelect(cb.dataset.prospectSel, cb.checked);
  });
  $("#prospectsView").addEventListener("click", (e) => {
    const dco = e.target.closest("[data-discovery-open]");
    if (dco) { openDiscoveryModal(); return; }
    const g = e.target.closest("[data-prospect-group]");
    if (g) { prospectGroupBy = g.dataset.prospectGroup; localStorage.setItem("leadpilot_prospect_group", prospectGroupBy); renderProspects(); return; }
    const s = e.target.closest("[data-prospect-status]");
    if (s) { prospectStatusFilter = s.dataset.prospectStatus; prospectSelected.clear(); renderProspects(); return; }
    const rr = e.target.closest("[data-prospect-research]");
    if (rr) { prospectSelected.clear(); prospectSelected.add(rr.dataset.prospectResearch); researchSelectedProspects(); return; }
    const rj = e.target.closest("[data-prospect-reject]");
    if (rj) { rejectProspect(rj.dataset.prospectReject); return; }
    const re = e.target.closest("[data-prospect-restore]");
    if (re) { restoreProspect(re.dataset.prospectRestore); return; }
    const dl = e.target.closest("[data-prospect-delete]");
    if (dl) { deleteProspectHard(dl.dataset.prospectDelete); return; }
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
    if (e.target.closest(".lead-select")) return; // Auswahl-Checkbox: nicht navigieren
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
    $("#f_tags").value = Array.isArray(l.tags) ? l.tags.join(", ") : "";
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
    tags: parseTags($("#f_tags").value),
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
    await refresh(); // view-aware: zeichnet Detail/Heute/Liste passend neu
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
    // Druck aus dem Opener-Kontext anstoßen (zuvor inline onload="window.print()",
    // das unter der strikten CSP des geerbten about:blank-Dokuments blockiert
    // würde). Ein Flag verhindert doppeltes Drucken aus load + Fallback-Timeout.
    let printed = false;
    const triggerPrint = () => {
      if (printed) return;
      printed = true;
      try { win.focus(); win.print(); } catch { /* Fenster ggf. geschlossen */ }
    };
    win.addEventListener("load", triggerPrint);
    setTimeout(triggerPrint, 1200);
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
<body>
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
    .map((s) => {
      const val = Number(stageProbabilities[s] ?? 0);
      return `<div class="prob-item" style="--val:${val}%">
        <div class="prob-item-head">
          <span class="prob-label">${esc(s)}</span>
          <span class="prob-val"><b data-prob-out="${esc(s)}">${val}</b>&thinsp;%</span>
        </div>
        <input type="range" class="prob-range" min="0" max="100" step="5"
          data-prob="${esc(s)}" value="${val}"
          aria-label="Abschlusswahrscheinlichkeit ${esc(s)}" />
      </div>`;
    })
    .join("");
}

// Live-Update beim Schieben: Prozentzahl und Füllstand des Reglers.
function onProbInput(e) {
  const input = e.target.closest(".prob-range");
  if (!input) return;
  const item = input.closest(".prob-item");
  const out = item && item.querySelector("[data-prob-out]");
  if (out) out.textContent = input.value;
  if (item) item.style.setProperty("--val", input.value + "%");
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
  $("#settingsStaleDays").value = staleDays;
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
  body.staleDays = Number($("#settingsStaleDays").value) || staleDays;
  try {
    const cfg = await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    currentModel = cfg.model;
    stageProbabilities = cfg.stageProbabilities || stageProbabilities;
    if (cfg.staleDays) staleDays = cfg.staleDays;
    await refresh(); // Pipeline-Wert + „Kalt"-Filter mit neuen Werten neu berechnen
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

// Verwandelt ein <label class="dropzone"> mit verstecktem File-Input in eine
// klickbare Drag&Drop-Zone: zeigt Dateiname/-größe an und (de)aktiviert den
// zugehörigen Import-Button. Reagiert auch auf programmatisches Leeren des
// Inputs (dispatch "change") nach erfolgreichem Import.
function setupDropzone(inputId, btnId) {
  const input = $("#" + inputId);
  const btn = $("#" + btnId);
  if (!input || !btn) return;
  const zone = input.closest(".dropzone");
  if (!zone) return;
  const icon = zone.querySelector(".dz-icon");
  const title = zone.querySelector(".dz-title");
  const hint = zone.querySelector(".dz-hint");
  const def = { icon: icon ? icon.textContent : "", title: title.textContent, hint: hint.textContent };

  const update = () => {
    const file = input.files && input.files[0];
    zone.classList.toggle("has-file", !!file);
    btn.disabled = !file;
    if (icon) icon.textContent = file ? "✅" : def.icon;
    title.textContent = file ? file.name : def.title;
    hint.textContent = file ? `${Math.max(1, Math.round(file.size / 1024))} KB · klicken zum Ändern` : def.hint;
  };

  input.addEventListener("change", update);
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove("dragover"); });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    try { input.files = files; } catch (_) { /* manche Browser erlauben kein Setzen – Klick-Auswahl bleibt */ }
    update();
  });
  update(); // Initialzustand: kein File → Button deaktiviert
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
    input.dispatchEvent(new Event("change")); // Dropzone zurücksetzen (Datei geleert)
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.textContent = prev;
    btn.disabled = !(input.files && input.files[0]); // ohne Datei deaktiviert
  }
}

// CSV-Import für Prospects: liest die gewählte Datei, schickt sie an den Server
// und meldet das Ergebnis. Anschließend wird die Prospect-Liste aktualisiert.
async function importProspectsCsv() {
  const input = $("#importProspectsCsvInput");
  const file = input.files && input.files[0];
  if (!file) {
    toast("Bitte zuerst eine CSV-Datei auswählen.", "error");
    return;
  }
  const btn = $("#importProspectsCsvBtn");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Importiere…";
  try {
    const csv = await file.text();
    const res = await api("/api/prospects/import", {
      method: "POST",
      body: JSON.stringify({ csv }),
    });
    const parts = [`${res.created} angelegt`];
    if (res.skippedDuplicate) parts.push(`${res.skippedDuplicate} Dublette(n) übersprungen`);
    if (res.skippedEmpty) parts.push(`${res.skippedEmpty} leer`);
    if (res.errors && res.errors.length) parts.push(`${res.errors.length} fehlerhaft`);
    toast("Prospect-Import: " + parts.join(" · "), res.created ? "success" : "");
    input.value = "";
    input.dispatchEvent(new Event("change")); // Dropzone zurücksetzen (Datei geleert)
    await loadProspects();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.textContent = prev;
    btn.disabled = !(input.files && input.files[0]); // ohne Datei deaktiviert
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
  // Discovery-Jobs haben kein Lead-Modal – stattdessen zur Prospects-Seite.
  if (job.kind === "discovery") { location.hash = "#/prospects"; return; }
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
  const arr = [...jobs.values()].map((j) => ({ id: j.id, label: j.label, startTs: j.startTs, kind: j.kind }));
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
// kind: "research" (Standard) oder "discovery".
function addJob(jobId, label, startTs, kind = "research") {
  jobs.set(jobId, { id: jobId, label, status: "running", steps: [], startTs: startTs || Date.now(), leadId: null, kind });
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
    if (j && j.id && !jobs.has(j.id)) addJob(j.id, j.label || "Recherche", j.startTs, j.kind || "research");
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
      if (job.kind === "discovery") {
        dropJob(jobId);
        const r = data.result || { added: 0, skippedDuplicate: 0, total: 0 };
        toast(`✅ Discovery: ${r.added} neue Prospects · ${r.skippedDuplicate} Dublette(n) übersprungen`, "success");
        // Treffer sind serverseitig bereits als Prospects gespeichert →
        // Liste aktualisieren (zeichnet sich neu, falls gerade sichtbar).
        loadProspects();
        return;
      }
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
        `<span class="job-chip-x" data-cancel="${j.id}" role="button" title="Abbrechen">✕</span>`;
      chip.querySelector(".job-chip-title").textContent = (j.kind === "discovery" ? "🧭 " : "🔎 ") + j.label;
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

// "2026-06-15" -> "15.06."
function dayLabel(ymd) {
  const [, m, d] = ymd.split("-");
  return d && m ? `${d}.${m}.` : ymd;
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

// Lesbare Modellnamen für die Kosten-Aufteilung im Tooltip.
const MODEL_NAMES = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};
const shortModel = (m) => MODEL_NAMES[m] || m;

// Rundet auf einen „schönen" oberen Achsenwert (1/2/2,5/5/10 × Zehnerpotenz).
function niceCeil(x) {
  if (!(x > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / pow;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * pow;
}

function dayLabelLong(ymd) {
  const [y, m, d] = String(ymd).split("-");
  return d ? `${d}.${m}.${y}` : ymd;
}

// Interaktives KI-Kosten-Diagramm: Hintergrund-Raster + Y-Skala, je Tag ein
// Balken. Der Hover-Tooltip (siehe wireCostChart) zeigt Modell-Aufteilung und
// Anzahl recherchierter Leads.
function costChart(days) {
  if (!days.length) return `<p class="d-muted">Keine Daten.</p>`;
  const usd = (v) => "$" + (Number(v) || 0).toFixed(2);
  const maxVal = Math.max(...days.map((d) => d.value || 0), 0);
  const top = niceCeil(maxVal);
  const W = 640, H = 220, padL = 48, padR = 14, padT = 14, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const yFor = (v) => padT + plotH - (v / top) * plotH;
  const ticks = 4;

  let grid = "";
  for (let t = 0; t <= ticks; t++) {
    const val = (top * t) / ticks;
    const y = yFor(val);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" class="grid-line" />`;
    grid += `<text x="${padL - 8}" y="${y + 3}" class="axis-lbl">${esc(usd(val))}</text>`;
  }

  const bw = plotW / days.length;
  // Gestapelter Balken je Tag: unten KI-Recherche/Übrige (grün), oben Discovery
  // (amber) – so heben sich die Discovery-Kosten farblich ab.
  const bars = days.map((d, i) => {
    const x = padL + i * bw;
    const total = d.value || 0;
    const disc = Math.min(Math.max(0, d.discovery || 0), total);
    const other = total - disc;
    const bx = x + bw * 0.18, bwid = bw * 0.64;
    const hOther = top > 0 ? (other / top) * plotH : 0;
    const hDisc = top > 0 ? (disc / top) * plotH : 0;
    const yOther = padT + plotH - hOther;
    const yDisc = yOther - hDisc;
    const payload = esc(JSON.stringify({
      day: d.day, value: total, discovery: disc, models: d.models || {},
      researched: d.researched || 0, discovered: d.discovered || 0,
    }));
    const otherRect = hOther > 0 ? `<rect class="cc-bar" x="${bx}" y="${yOther}" width="${bwid}" height="${hOther}" rx="3" />` : "";
    const discRect = hDisc > 0 ? `<rect class="cc-bar-disc" x="${bx}" y="${yDisc}" width="${bwid}" height="${hDisc}" rx="3" />` : "";
    return `<g class="cc-col" data-tip="${payload}">
        <rect class="cc-hit" x="${x}" y="${padT}" width="${bw}" height="${plotH}" />
        ${otherRect}
        ${discRect}
        <text x="${x + bw / 2}" y="${H - 8}" class="cc-lbl">${esc(dayLabel(d.day))}</text>
      </g>`;
  }).join("");

  return `<div class="cost-chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" class="cost-chart" preserveAspectRatio="xMidYMid meet">
        ${grid}
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="axis-line" />
        ${bars}
      </svg>
      <div class="chart-tip hidden"></div>
    </div>
    <div class="cost-legend">
      <span class="cost-legend-item"><span class="ci-swatch ci-research"></span> KI-Recherche</span>
      <span class="cost-legend-item"><span class="ci-swatch ci-disc"></span> Discovery</span>
    </div>`;
}

// Verdrahtet die Hover-Tooltips des Kosten-Diagramms nach dem Einfügen ins DOM.
function wireCostChart(root) {
  const wrap = root.querySelector(".cost-chart-wrap");
  if (!wrap) return;
  const tip = wrap.querySelector(".chart-tip");
  const usd = (v) => "$" + (Number(v) || 0).toFixed(2);

  wrap.querySelectorAll(".cc-col").forEach((col) => {
    const show = (ev) => {
      let d;
      try { d = JSON.parse(col.getAttribute("data-tip")); } catch { return; }
      const models = Object.entries(d.models || {}).sort((a, b) => b[1] - a[1]);
      const rows = models.length
        ? models.map(([m, c]) => `<div class="tip-row"><span>${esc(shortModel(m))}</span><span>${esc(usd(c))}</span></div>`).join("")
        : `<div class="tip-row d-muted"><span>Keine KI-Kosten</span><span></span></div>`;
      const discRow = (Number(d.discovery) || 0) > 0
        ? `<div class="tip-row tip-disc"><span>· davon Discovery</span><span>${esc(usd(d.discovery))}</span></div>`
        : "";
      tip.innerHTML = `<div class="tip-head">${esc(dayLabelLong(d.day))}</div>
        <div class="tip-row tip-total"><span>Gesamt</span><span>${esc(usd(d.value))}</span></div>
        ${discRow}
        ${rows}
        <div class="tip-row tip-meta"><span>Recherchierte Leads</span><span>${Number(d.researched) || 0}</span></div>
        <div class="tip-row tip-meta"><span>Entdeckte Leads</span><span>${Number(d.discovered) || 0}</span></div>`;
      tip.classList.remove("hidden");

      const wr = wrap.getBoundingClientRect();
      const tw = tip.offsetWidth || 180;
      let left = ev.clientX - wr.left + 14;
      if (left + tw > wr.width) left = ev.clientX - wr.left - tw - 14;
      tip.style.left = Math.max(4, left) + "px";
      tip.style.top = Math.max(4, ev.clientY - wr.top + 12) + "px";
    };
    col.addEventListener("mouseenter", show);
    col.addEventListener("mousemove", show);
    col.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  });
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
  const usd = (v) => "$" + (Number(v) || 0).toFixed(2);
  const prospectsOpen = (r.prospects && r.prospects.open) || 0;

  const kpis = [
    ["Leads gesamt", s.total],
    ["Pipeline (gewichtet)", eur(s.weightedPipelineValue)],
    ["Gewonnen", eur(s.wonValue)],
    ["Abschlussquote", s.conversion + " %"],
    ["Ø Auftragswert", eur(r.avgWon)],
    ["Ø Vertriebszyklus", r.avgCycleDays ? r.avgCycleDays + " Tage" : "—"],
    ["Prospects offen", prospectsOpen],
    ["Discovery-Kosten (14 T)", usd(r.discoveryCost14d)],
  ].map(([label, val]) => `<div class="stat-card"><span class="stat-value">${esc(String(val))}</span><span class="stat-label">${esc(label)}</span></div>`).join("");

  const wonLeads = r.wonLeadsByMonth.map((m) => ({ label: monthLabel(m.month), value: m.value }));

  // KI-Kosten je Tag (USD, aus den Tokens + Tool-Gebühren errechnet).
  const costByDay = r.costByDay || [];
  const costTotal = costByDay.reduce((a, d) => a + (d.value || 0), 0);

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
        <h3>Gewonnene Leads je Monat</h3>
        ${barChart(wonLeads, { color: "var(--green)" })}
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

    <section class="card report-funnel">
      <h3>KI-Kosten je Tag <span class="d-muted" style="font-weight:400;font-size:13px;">· Summe 14 Tage: ${esc(usd(costTotal))}</span></h3>
      ${costChart(costByDay)}
    </section>
  `;

  wireCostChart(v);
}

// --- Tags-Helfer -----------------------------------------------------------
// Komma-getrennte Eingabe → bereinigtes String-Array (Server dedupliziert/deckelt).
function parseTags(str) {
  return String(str || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Befüllt den Tag-Filter im Toolbar mit allen vorkommenden Tags.
function renderTagFilter() {
  const sel = $("#tagFilter");
  if (!sel) return;
  const all = new Set();
  for (const l of leads) for (const t of l.tags || []) all.add(t);
  const sorted = [...all].sort((a, b) => a.localeCompare(b, "de", { sensitivity: "base" }));
  if (!sorted.includes(tagFilter)) tagFilter = ""; // Tag verschwunden → Filter zurücksetzen
  sel.innerHTML = `<option value="">Alle Tags</option>` +
    sorted.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  sel.value = tagFilter;
}

// --- Heute / Agenda --------------------------------------------------------
function showAgenda() {
  detailId = null;
  detailEditing = false;
  showOnly("agendaView");
  setActiveNav("agenda");
  renderAgenda();
  window.scrollTo(0, 0);
}

// Zahl fälliger Wiedervorlagen im „Heute"-Navigationspunkt anzeigen.
function updateAgendaBadge() {
  const n = dueLeadCount();
  document.querySelectorAll(".agenda-due").forEach((b) => {
    b.textContent = n;
    b.classList.toggle("hidden", n === 0);
  });
}

function agendaItemHtml(l) {
  const info = dueInfo(l.nextStepAt);
  const due = info ? `<span class="ns-due ${info.state}">⏰ ${esc(info.label)}</span>` : "";
  const hasPlan = !!(l.nextStep || l.nextStepAt);
  const actions = hasPlan
    ? `<button type="button" class="btn btn-sm" data-agenda-done="${l.id}">✓ Erledigt</button>
       <button type="button" class="btn btn-sm" data-agenda-edit="${l.id}">Verschieben</button>`
    : `<button type="button" class="btn btn-sm" data-agenda-edit="${l.id}">+ Planen</button>`;
  return `<div class="agenda-item">
    <button type="button" class="agenda-open" data-nav="${l.id}">
      <span class="agenda-title">${esc(l.company || l.name || "—")}</span>
      <span class="status-pill s-${l.status}">${l.status}</span>
      <span class="agenda-step">${esc(l.nextStep || "Kein nächster Schritt")} ${due} ${activityHint(l)}</span>
    </button>
    <div class="agenda-actions">${actions}</div>
  </div>`;
}

function renderAgenda() {
  const v = $("#agendaView");
  const open = leads.filter((l) => l.status !== "gewonnen" && l.status !== "verloren");
  const withStep = open
    .filter((l) => l.nextStepAt)
    .sort((a, b) => (a.nextStepAt < b.nextStepAt ? -1 : a.nextStepAt > b.nextStepAt ? 1 : 0));
  const today = todayYMD();
  const overdue = withStep.filter((l) => l.nextStepAt < today);
  const todays = withStep.filter((l) => l.nextStepAt === today);
  const upcoming = withStep.filter((l) => l.nextStepAt > today);
  // Neue Leads (Status "neu") bleiben außen vor – erst bearbeitete offene Leads
  // ohne geplanten nächsten Schritt brauchen Aufmerksamkeit.
  const noStep = open.filter((l) => l.status !== "neu" && !l.nextStepAt);

  const section = (title, arr, cls = "") => arr.length
    ? `<section class="card agenda-section ${cls}">
         <h3>${esc(title)} <span class="agenda-n">${arr.length}</span></h3>
         ${arr.map(agendaItemHtml).join("")}
       </section>`
    : "";

  const planned = overdue.length || todays.length || upcoming.length
    ? section("Überfällig", overdue, "overdue") + section("Heute", todays, "today") + section("Demnächst", upcoming)
    : `<section class="card"><p class="d-muted">Keine geplanten Wiedervorlagen. 🎉</p></section>`;

  v.innerHTML = `
    <div class="view-head"><h2>📅 Heute</h2><p class="d-muted">Anstehende Wiedervorlagen &amp; nächste Schritte</p></div>
    ${planned}
    ${noStep.length ? `<section class="card agenda-section nostep">
        <h3>Offen ohne Wiedervorlage <span class="agenda-n">${noStep.length}</span></h3>
        <p class="d-muted">Diese offenen Leads haben keinen geplanten nächsten Schritt.</p>
        ${noStep.slice(0, 25).map(agendaItemHtml).join("")}
      </section>` : ""}
  `;
}

// --- Mehrfachauswahl (Bulk) ------------------------------------------------
function setSelectMode(on) {
  selectMode = on;
  const btn = $("#selectToggle");
  if (btn) btn.classList.toggle("active", on);
  if (!on) selectedIds.clear();
  renderBulkBar();
  renderLeads();
}

function toggleSelect(id, on) {
  if (on) selectedIds.add(id); else selectedIds.delete(id);
  const card = document.querySelector(`.lead-card[data-nav="${CSS.escape(id)}"]`);
  if (card) card.classList.toggle("selected", on);
  renderBulkBar();
}

function clearSelection() {
  selectedIds.clear();
  renderBulkBar();
  renderLeads();
}

function renderBulkBar() {
  const bar = $("#bulkBar");
  if (!bar) return;
  const n = selectedIds.size;
  bar.classList.toggle("hidden", n === 0);
  if (!n) { bar.innerHTML = ""; return; }
  const statusOpts = statuses.map((s) => `<option value="${s}">${s}</option>`).join("");
  bar.innerHTML = `
    <span class="bulk-count">${n} ausgewählt</span>
    <select id="bulkStatus" class="bulk-select"><option value="">Status setzen…</option>${statusOpts}</select>
    <button class="btn btn-sm" id="bulkTagBtn">🏷️ Tag</button>
    <button class="btn btn-sm btn-danger" id="bulkDeleteBtn">🗑️ Löschen</button>
    <button class="btn btn-sm" id="bulkClearBtn">Aufheben</button>`;
  $("#bulkStatus").onchange = (e) => { if (e.target.value) applyBulkStatus(e.target.value); };
  $("#bulkTagBtn").onclick = applyBulkTag;
  $("#bulkDeleteBtn").onclick = applyBulkDelete;
  $("#bulkClearBtn").onclick = clearSelection;
}

// Führt eine Aktion sequenziell für alle ausgewählten Leads aus (nutzt die
// bestehenden Endpunkte, damit Aktivitäten/Logik erhalten bleiben).
async function bulkRun(label, fn) {
  const ids = [...selectedIds];
  let ok = 0;
  for (const id of ids) {
    try { await fn(id); ok++; } catch (err) { /* einzelne Fehler tolerieren */ }
  }
  toast(`${label}: ${ok}/${ids.length}`, ok ? "success" : "error");
  selectedIds.clear();
  await refresh();
  renderBulkBar();
}

function applyBulkStatus(status) {
  bulkRun(`Status → ${status}`, (id) =>
    api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify({ status }) }));
}

function applyBulkTag() {
  const tag = prompt("Tag für die ausgewählten Leads:");
  if (tag === null) return;
  const t = tag.trim();
  if (!t) return;
  bulkRun(`Tag „${t}"`, (id) => {
    const l = getLead(id);
    const tags = Array.isArray(l && l.tags) ? [...l.tags] : [];
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t);
    return api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify({ tags }) });
  });
}

function applyBulkDelete() {
  if (!confirm(`${selectedIds.size} Lead(s) endgültig löschen?`)) return;
  bulkRun("Gelöscht", (id) => api(`/api/leads/${id}`, { method: "DELETE" }));
}

// --- Globale Schnellsuche (Topbar) -----------------------------------------
// Durchsucht Funktionen, Leads, Prospects, Tags und Status (Eingruppierung).
// Jeder Treffer trägt eine run()-Aktion (Navigation/Filter/Modal).
let gsResults = [];

// Statische "Funktionen" (Navigation + Aktionen) für die Schnellsuche.
function globalFunctions() {
  return [
    { icon: "🗂", label: "Leads", keywords: "leads liste übersicht karten board", run: () => { location.hash = "#/"; } },
    { icon: "📅", label: "Heute", keywords: "heute agenda wiedervorlage fällig termine aufgaben", run: () => { location.hash = "#/heute"; } },
    { icon: "📇", label: "Prospects", keywords: "prospects discovery kandidaten liste", run: () => { location.hash = "#/prospects"; } },
    { icon: "📊", label: "Berichte", keywords: "berichte reports statistik auswertung kennzahlen", run: () => { location.hash = "#/reports"; } },
    { icon: "🧭", label: "Discovery starten", keywords: "discovery finden neue prospects suchen ki kriterien", run: () => { location.hash = "#/prospects"; openDiscoveryModal(); } },
    { icon: "🔎", label: "Lead recherchieren", keywords: "lead recherchieren ki research neuer anlegen website", run: () => openResearchModal() },
    { icon: "✏️", label: "Manueller Lead", keywords: "manuell neuer lead anlegen erstellen hinzufügen", run: () => openLeadModal() },
    { icon: "⚙️", label: "Einstellungen", keywords: "einstellungen settings ki modell import export csv abmelden konto", run: () => openSettingsModal() },
  ];
}

// Springt in die Listenansicht und setzt dort genau einen Filter (Tag oder
// Status); übrige Listenfilter werden zurückgesetzt – für vorhersehbare Treffer.
function gotoListFiltered({ tag = "", status = "alle" } = {}) {
  activeFilter = status;
  tagFilter = tag;
  dueOnly = false;
  staleOnly = false;
  location.hash = "#/";
  renderStatusFilters();
  const tf = $("#tagFilter"); if (tf) tf.value = tagFilter;
  $("#dueFilter")?.classList.remove("active");
  $("#staleFilter")?.classList.remove("active");
  renderLeads();
}

// Springt zur Prospects-Seite und stellt Suche + Status-Filter auf den Treffer.
function gotoProspect(p) {
  prospectSearch = (p.name || "").toLowerCase();
  prospectStatusFilter = p.status === "abgelehnt" ? "abgelehnt" : "offen";
  prospectSelected.clear();
  if (location.hash === "#/prospects") renderProspects();
  else location.hash = "#/prospects";
}

function renderGlobalResults(raw) {
  const q = (raw || "").toLowerCase().trim();
  const box = $("#globalSearchResults");
  if (!box) return;
  if (!q) { hideGlobalResults(); return; }

  gsResults = [];
  const sections = [];
  const take = (label, items) => { if (items.length) sections.push([label, items]); };

  // Funktionen (Navigation + Aktionen)
  take("Funktionen", globalFunctions()
    .filter((f) => (f.label + " " + f.keywords).toLowerCase().includes(q))
    .slice(0, 5)
    .map((f) => ({ icon: f.icon, title: f.label, sub: "Funktion", run: f.run })));

  // Leads
  take("Leads", leads
    .filter((l) => `${l.name} ${l.company} ${l.email} ${l.source} ${l.status} ${(l.tags || []).join(" ")}`.toLowerCase().includes(q))
    .slice(0, 6)
    .map((l) => ({
      icon: "🗂", title: l.company || l.name || "—",
      sub: [l.name && l.company ? l.name : "", l.status].filter(Boolean).join(" · "),
      run: () => { location.hash = "#/lead/" + encodeURIComponent(l.id); },
    })));

  // Prospects
  take("Prospects", prospects
    .filter((p) => `${p.name} ${p.branche} ${p.ort} ${p.groesse} ${p.potenzial}`.toLowerCase().includes(q))
    .slice(0, 6)
    .map((p) => ({
      icon: "📇", title: p.name || "—",
      sub: ["Prospect", p.branche, p.ort].filter(Boolean).join(" · "),
      run: () => gotoProspect(p),
    })));

  // Tags (über alle Leads, dedupliziert mit Anzahl)
  const tagCount = new Map();
  for (const l of leads) for (const t of (l.tags || [])) {
    if (t.toLowerCase().includes(q)) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }
  take("Tags", [...tagCount.entries()].slice(0, 5).map(([t, n]) => ({
    icon: "🏷", title: t, sub: `Tag · ${n} Lead${n === 1 ? "" : "s"}`,
    run: () => gotoListFiltered({ tag: t }),
  })));

  // Eingruppierung (Lead-Status)
  take("Eingruppierung", statuses
    .filter((s) => s.toLowerCase().includes(q))
    .slice(0, 4)
    .map((s) => ({ icon: "📁", title: s, sub: "Lead-Status", run: () => gotoListFiltered({ status: s }) })));

  if (!sections.length) {
    box.innerHTML = `<div class="gs-empty">Keine Treffer</div>`;
    box.classList.remove("hidden");
    return;
  }

  let html = "";
  for (const [label, items] of sections) {
    html += `<div class="gs-section">${esc(label)}</div>`;
    for (const it of items) {
      const idx = gsResults.length;
      gsResults.push(it);
      html += `
        <button type="button" class="gs-item${idx === 0 ? " active" : ""}" data-gs-idx="${idx}" role="option">
          <span class="gs-ico" aria-hidden="true">${it.icon}</span>
          <span class="gs-text">
            <span class="gs-item-title">${esc(it.title)}</span>
            ${it.sub ? `<span class="gs-item-sub">${esc(it.sub)}</span>` : ""}
          </span>
        </button>`;
    }
  }
  box.innerHTML = html;
  box.classList.remove("hidden");
}

function hideGlobalResults() {
  const box = $("#globalSearchResults");
  if (box) box.classList.add("hidden");
}

// Führt die Aktion eines Treffers aus und schließt die Suche.
function runGsResult(i) {
  const r = gsResults[i];
  if (!r) return;
  hideGlobalResults();
  const inp = $("#globalSearchInput");
  if (inp) inp.value = "";
  r.run();
}

function onGlobalSearchKey(e) {
  const box = $("#globalSearchResults");
  if (!box) return;
  if (e.key === "Escape") { hideGlobalResults(); e.target.blur(); return; }
  const items = [...box.querySelectorAll(".gs-item")];
  if (!items.length) return;
  let idx = items.findIndex((x) => x.classList.contains("active"));
  if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(0, idx - 1); }
  else if (e.key === "Enter") { e.preventDefault(); const sel = items[idx] || items[0]; if (sel) runGsResult(Number(sel.dataset.gsIdx)); return; }
  else return;
  items.forEach((x, i) => x.classList.toggle("active", i === idx));
}

// --- Lead-Discovery --------------------------------------------------------
// Öffnet das Discovery-Modal (Button auf der Prospects-Seite). Füllt die Felder
// mit den zuletzt genutzten Kriterien vor und spiegelt den KI-Status wider.
function openDiscoveryModal() {
  const c = discoveryCriteria || {};
  $("#dc_branche").value = c.branche || "";
  $("#dc_region").value = c.region || "";
  $("#dc_groesse").value = c.groesse || "";
  $("#dc_stichworte").value = c.stichworte || "";
  $("#dc_freitext").value = c.freitext || "";
  $("#dc_anzahl").value = c.anzahl || 10;
  $("#dcSubmit").disabled = !aiEnabled;
  $("#discoveryAiHint").classList.toggle("hidden", aiEnabled);
  $("#discoveryModal").classList.remove("hidden");
  setTimeout(() => $("#dc_branche").focus(), 0);
}

function closeDiscoveryModal() {
  $("#discoveryModal").classList.add("hidden");
}

async function submitDiscovery() {
  const criteria = {
    branche: $("#dc_branche").value.trim(),
    region: $("#dc_region").value.trim(),
    groesse: $("#dc_groesse").value.trim(),
    stichworte: $("#dc_stichworte").value.trim(),
    freitext: $("#dc_freitext").value.trim(),
    anzahl: Number($("#dc_anzahl").value) || 10,
  };
  if (!criteria.branche && !criteria.region && !criteria.stichworte && !criteria.freitext) {
    toast("Bitte mindestens ein Kriterium angeben", "error");
    return;
  }
  discoveryCriteria = criteria;
  try {
    const { jobId } = await api("/api/discovery", { method: "POST", body: JSON.stringify(criteria) });
    const label = criteria.branche || criteria.region || criteria.stichworte || "Discovery";
    addJob(jobId, "Discovery: " + label, undefined, "discovery");
    closeDiscoveryModal();
    toast("Discovery läuft… (Fortschritt unten rechts)", "");
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- Prospects (persistente Discovery-Liste) -------------------------------
const POTENZIAL_COLORS = { A: "var(--green)", B: "var(--amber)", C: "#E8703A", D: "var(--red)" };
function potenzialColor(p) { return POTENZIAL_COLORS[p] || "var(--muted)"; }

function showProspects() {
  detailId = null;
  detailEditing = false;
  showOnly("prospectsView");
  setActiveNav("prospects");
  loadProspects();
  window.scrollTo(0, 0);
}

async function loadProspects() {
  try { prospects = await api("/api/prospects"); } catch (err) { /* Liste bleibt */ }
  renderProspects();
}

function filteredProspects() {
  const q = prospectSearch;
  return prospects.filter((p) => {
    if ((p.status || "offen") !== prospectStatusFilter) return false;
    if (q) {
      const hay = `${p.name} ${p.branche} ${p.ort} ${p.groesse}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function prospectCardHtml(p) {
  const web = p.website && p.website !== "k.A." ? extUrl(p.website) : "";
  const ok = (x) => x && x !== "k.A.";
  const rejected = p.status === "abgelehnt";
  const actions = rejected
    ? `<button type="button" class="btn btn-sm" data-prospect-restore="${p.id}">↩︎ Wiederherstellen</button>
       <button type="button" class="btn btn-sm btn-danger" data-prospect-delete="${p.id}">🗑️ Endgültig löschen</button>`
    : `<button type="button" class="btn btn-sm btn-primary" data-prospect-research="${p.id}" ${aiEnabled ? "" : "disabled"}>🔎 Recherchieren</button>
       <button type="button" class="btn btn-sm" data-prospect-reject="${p.id}">🚫 Verwerfen</button>`;
  return `<div class="prospect-item">
    ${rejected ? "" : `<label class="prospect-check"><input type="checkbox" data-prospect-sel="${p.id}" ${prospectSelected.has(p.id) ? "checked" : ""} aria-label="Prospect auswählen" /></label>`}
    <span class="potenzial-badge" style="color:${potenzialColor(p.potenzial)};border-color:${potenzialColor(p.potenzial)}" title="${esc(p.potenzialGrund || "Erstbewertung Potenzial")}">${esc(p.potenzial || "—")}</span>
    <div class="prospect-main">
      <div class="prospect-title">${esc(p.name || "—")}</div>
      <div class="prospect-sub">
        ${ok(p.branche) ? `<span>🏷️ ${esc(p.branche)}</span>` : ""}
        ${ok(p.ort) ? `<span>📍 ${esc(p.ort)}</span>` : ""}
        ${ok(p.groesse) ? `<span>👥 ${esc(p.groesse)}</span>` : ""}
        ${web ? `<a href="${esc(web)}" target="_blank" rel="noopener">🌐 Website</a>` : ""}
      </div>
      ${p.begruendung ? `<div class="prospect-reason">${esc(p.begruendung)}</div>` : ""}
    </div>
    <div class="prospect-actions">${actions}</div>
  </div>`;
}

// Gruppen-HTML (gefiltert + nach gewählter Achse gruppiert) – separat, damit die
// Live-Suche nur diesen Teil neu zeichnet (Eingabefokus bleibt erhalten).
function prospectGroupsHtml() {
  const items = filteredProspects();
  if (!items.length) {
    return `<section class="card"><p class="d-muted">${prospectStatusFilter === "abgelehnt" ? "Keine abgelehnten Prospects." : "Noch keine Prospects. Starte eine Discovery (🧭)."}</p></section>`;
  }
  const keyFn = {
    branche: (p) => p.branche || "Ohne Branche",
    groesse: (p) => p.groesse || "k.A.",
    potenzial: (p) => "Potenzial " + (p.potenzial || "—"),
  }[prospectGroupBy] || ((p) => "Potenzial " + (p.potenzial || "—"));
  const groups = {};
  for (const p of items) { const k = keyFn(p); (groups[k] = groups[k] || []).push(p); }
  return Object.keys(groups).sort((a, b) => a.localeCompare(b, "de")).map((k) =>
    `<section class="card prospect-group">
       <h3>${esc(k)} <span class="agenda-n">${groups[k].length}</span></h3>
       ${groups[k].map(prospectCardHtml).join("")}
     </section>`).join("");
}

function renderProspectGroups() {
  const el = $("#prospectGroups");
  if (el) el.innerHTML = prospectGroupsHtml();
  renderProspectBulkBar();
}

function renderProspects() {
  const v = $("#prospectsView");
  const groupBtn = (key, label) => `<button type="button" class="chip ${prospectGroupBy === key ? "active" : ""}" data-prospect-group="${key}">${label}</button>`;
  const statusBtn = (key, label) => `<button type="button" class="chip ${prospectStatusFilter === key ? "active" : ""}" data-prospect-status="${key}">${label}</button>`;
  const openN = prospects.filter((p) => (p.status || "offen") !== "abgelehnt").length;
  const rejN = prospects.filter((p) => p.status === "abgelehnt").length;
  v.innerHTML = `
    <div class="view-head view-head-row">
      <div><h2>📇 Prospects</h2><p class="d-muted">Mögliche Leads aus der Discovery – gegliedert &amp; recherchierbar</p></div>
      <button type="button" class="btn btn-primary" data-discovery-open>🧭 Discovery starten</button>
    </div>
    <section class="toolbar prospect-toolbar">
      <div class="toolbar-top">
        <input type="search" id="prospectSearch" class="search" placeholder="🔍 Prospect suchen…" value="${esc(prospectSearch)}" />
        <div class="prospect-groupby">
          <span class="d-muted">Gruppieren:</span>
          ${groupBtn("potenzial", "Potenzial")} ${groupBtn("branche", "Branche")} ${groupBtn("groesse", "Größe")}
        </div>
      </div>
      <div class="toolbar-filters">
        ${statusBtn("offen", `Offen (${openN})`)} ${statusBtn("abgelehnt", `Abgelehnt (${rejN})`)}
      </div>
    </section>
    <div id="prospectGroups">${prospectGroupsHtml()}</div>
  `;
  renderProspectBulkBar();
}

// Bulk-Leiste (nur im Offen-Filter mit Auswahl) – nutzt das vorhandene #bulkBar.
function renderProspectBulkBar() {
  const bar = $("#bulkBar");
  if (!bar) return;
  const n = prospectSelected.size;
  if (!n || prospectStatusFilter !== "offen") { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <span class="bulk-count">${n} ausgewählt</span>
    <button class="btn btn-sm btn-primary" id="prospectBulkResearch" ${aiEnabled ? "" : "disabled"}>🔎 Recherchieren</button>
    <button class="btn btn-sm" id="prospectBulkReject">🚫 Verwerfen</button>
    <button class="btn btn-sm" id="prospectBulkClear">Aufheben</button>`;
  $("#prospectBulkResearch").onclick = () => researchSelectedProspects();
  $("#prospectBulkReject").onclick = () => rejectSelectedProspects();
  $("#prospectBulkClear").onclick = () => { prospectSelected.clear(); renderProspects(); };
}

function toggleProspectSelect(id, on) {
  if (on) prospectSelected.add(id); else prospectSelected.delete(id);
  renderProspectBulkBar();
}

async function rejectProspect(id) {
  try { await api(`/api/prospects/${id}`, { method: "PUT", body: JSON.stringify({ status: "abgelehnt" }) }); prospectSelected.delete(id); await loadProspects(); }
  catch (err) { toast(err.message, "error"); }
}
async function restoreProspect(id) {
  try { await api(`/api/prospects/${id}`, { method: "PUT", body: JSON.stringify({ status: "offen" }) }); await loadProspects(); }
  catch (err) { toast(err.message, "error"); }
}
async function deleteProspectHard(id) {
  if (!confirm("Diesen Prospect endgültig löschen? (DSGVO – nicht umkehrbar)")) return;
  try { await api(`/api/prospects/${id}`, { method: "DELETE" }); prospectSelected.delete(id); await loadProspects(); toast("Prospect gelöscht", "success"); }
  catch (err) { toast(err.message, "error"); }
}
async function rejectSelectedProspects() {
  const ids = [...prospectSelected];
  for (const id of ids) { try { await api(`/api/prospects/${id}`, { method: "PUT", body: JSON.stringify({ status: "abgelehnt" }) }); } catch {} }
  prospectSelected.clear();
  toast(`${ids.length} verworfen`, "success");
  await loadProspects();
}

// Ausgewählte Prospects recherchieren → je ein normaler Recherche-Job (gedrosselt
// auf 3 gleichzeitig). Der Server entfernt den Prospect nach erfolgreicher Recherche.
async function researchSelectedProspects() {
  const ids = [...prospectSelected];
  if (!ids.length) return;
  prospectSelected.clear();
  renderProspectBulkBar();
  toast(`Starte Recherche für ${ids.length} Prospect(s)…`, "");
  const queue = ids.slice();
  let started = 0;
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const p = prospects.find((x) => x.id === id);
      try {
        const { jobId } = await api(`/api/prospects/${id}/research`, { method: "POST" });
        addJob(jobId, (p && (p.name || p.website)) || "Prospect", undefined, "research");
        started++;
      } catch (err) {
        if (err.status === 429) { queue.unshift(id); await sleep(4000); }
        else toast(`${p ? p.name : id}: ${err.message}`, "error");
      }
      await sleep(400);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  toast(`${started} Recherche-Job(s) gestartet`, started ? "success" : "error");
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
