"use strict";

// --- Zustand ---------------------------------------------------------------
let leads = [];
let statuses = [];
let aiEnabled = false;
let activeFilter = "alle";
let searchTerm = "";
let models = [];
let currentModel = "";
let stageProbabilities = {};
let view = localStorage.getItem("leadpilot_view") === "kanban" ? "kanban" : "list";

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
  if (!res.ok) throw new Error(data.error || "Anfrage fehlgeschlagen");
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

// --- Routing (Liste ⇄ Detailseite) -----------------------------------------
function router() {
  const m = location.hash.match(/^#\/lead\/(.+)$/);
  if (m) showDetail(decodeURIComponent(m[1]));
  else showList();
}

function showList() {
  detailId = null;
  detailEditing = false;
  $("#detailView").classList.add("hidden");
  $("#listView").classList.remove("hidden");
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
  $("#listView").classList.add("hidden");
  $("#detailView").classList.remove("hidden");
  renderDetail();
  window.scrollTo(0, 0);
}

// --- Daten laden + rendern -------------------------------------------------
async function refresh() {
  leads = await api("/api/leads");
  renderStats(await api("/api/stats"));
  if (detailId) renderDetail();
  else renderLeads();
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
  return leads.filter((l) => {
    if (activeFilter !== "alle" && l.status !== activeFilter) return false;
    if (searchTerm) {
      const hay = `${l.name} ${l.company} ${l.email} ${l.source}`.toLowerCase();
      if (!hay.includes(searchTerm)) return false;
    }
    return true;
  });
}

function scoreColor(score) {
  if (score >= 75) return "var(--green)";
  if (score >= 50) return "var(--amber)";
  if (score >= 25) return "#fb923c";
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
      return `<div class="kanban-col" data-status="${status}">
        <div class="kanban-col-head">
          <span class="status-pill s-${status}">${status}</span>
          <span class="kanban-count">${colItems.length}</span>
        </div>
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
           ${ai.nextStep ? `<p class="next-step">➡️ ${esc(ai.nextStep)}</p>` : ""}
           ${ai.valueReasoning ? `<p class="value-reason">💶 Wertschätzung: ${esc(ai.valueReasoning)}</p>` : ""}
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

  const contact = [
    l.email ? `<span>✉️ <a href="mailto:${esc(l.email)}">${esc(l.email)}</a></span>` : "",
    l.phone ? `<span>📞 ${esc(l.phone)}</span>` : "",
    l.source ? `<span>🌐 ${esc(l.source)}</span>` : "",
  ].filter(Boolean).join("");

  return `
    <div class="detail-bar">
      <a class="btn btn-sm" href="#/">← Zurück</a>
      <div class="detail-bar-actions">
        ${aiEnabled && r ? `<button class="btn btn-sm" data-action="research">🔄 Neu recherchieren</button>` : ""}
        <button class="btn btn-sm" data-action="edit">✏️ Bearbeiten</button>
        <button class="btn btn-sm btn-danger" data-action="delete">🗑️ Löschen</button>
      </div>
    </div>

    <header class="detail-hero">
      <div>
        <h1>${esc(l.company) || esc(l.name) || "—"}</h1>
        ${l.company && l.name ? `<p class="detail-sub">👤 ${esc(l.name)}</p>` : ""}
        <div class="detail-contact">${contact || `<span class="d-muted">Keine Kontaktdaten</span>`}</div>
      </div>
      <div class="detail-hero-right">
        <span class="status-pill s-${l.status}">${l.status}</span>
        <span class="lead-value big">💶 ${fmtEuro(l.value)}</span>
      </div>
    </header>

    <div class="detail-layout">
      <div class="detail-main">
        ${l.notes ? `<section class="d-section card"><h3>Notizen</h3><p class="d-text">${esc(l.notes)}</p></section>` : ""}
        <div class="card">${researchHtml}</div>
      </div>
      <aside class="detail-side">
        <section class="card">
          <h3>KI-Bewertung</h3>
          ${aiBox}
          ${aiActions}
        </section>
      </aside>
    </div>
  `;
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

  $("#closeResearchModal").addEventListener("click", closeResearchModal);
  $("#cancelResearchBtn").addEventListener("click", closeResearchModal);
  $("#researchForm").addEventListener("submit", submitResearch);

  // Dock: Klick auf einen laufenden Job öffnet wieder das Detail-Modal.
  $("#jobDock").addEventListener("click", (e) => {
    const b = e.target.closest("[data-job]");
    if (b) openJobModal(b.dataset.job);
  });

  $("#settingsBtn").addEventListener("click", openSettingsModal);
  $("#closeSettingsModal").addEventListener("click", closeSettingsModal);
  $("#cancelSettingsBtn").addEventListener("click", closeSettingsModal);
  $("#settingsForm").addEventListener("submit", saveSettings);

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
  $("#kanban").addEventListener("click", onCardNav);
  bindKanbanDnd();

  // Detailseite: ein delegierter Handler für alle Aktionen.
  $("#detailView").addEventListener("click", onDetailClick);

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
    notes: $("#f_notes").value,
  };
  try {
    if (id) {
      await api(`/api/leads/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("Lead aktualisiert", "success");
    } else {
      const created = await api("/api/leads", { method: "POST", body: JSON.stringify(payload) });
      toast("Lead angelegt", "success");
      closeLeadModal();
      await refresh();
      if (created && created.id) location.hash = "#/lead/" + encodeURIComponent(created.id);
      return;
    }
    closeLeadModal();
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteLead(id, fromDetail = false) {
  const l = getLead(id);
  if (!confirm(`Lead "${l?.company || l?.name || "—"}" wirklich löschen?`)) return;
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

// Job registrieren und Polling starten.
function addJob(jobId, label) {
  jobs.set(jobId, { id: jobId, label, status: "running", steps: [], startTs: Date.now(), leadId: null });
  renderDock();
  pollJob(jobId);
}

// Pollt EINEN Job unabhängig vom Modal bis fertig/Fehler.
async function pollJob(jobId) {
  while (true) {
    await sleep(1500);
    const job = jobs.get(jobId);
    if (!job) return; // wurde entfernt
    let data;
    try {
      data = await api(`/api/research/${jobId}`);
    } catch (err) {
      continue; // einzelne fehlgeschlagene Polls tolerieren
    }
    job.steps = data.steps || job.steps;
    job.status = data.status;
    if (data.lead && data.lead.id) job.leadId = data.lead.id;
    if (modalJobId === jobId) renderSteps(job.steps, data.status !== "running");
    renderDock();

    if (data.status === "done") {
      const wasOpen = modalJobId === jobId;
      jobs.delete(jobId);
      renderDock();
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
      jobs.delete(jobId);
      renderDock();
      toast(data.error || `Recherche fehlgeschlagen: ${job.label}`, "error");
      if (wasOpen) closeResearchModal();
      return;
    }
  }
}

// Rendert das Dock laufender Jobs unten rechts.
function renderDock() {
  const dock = $("#jobDock");
  const list = [...jobs.values()];
  if (!list.length) {
    dock.classList.add("hidden");
    dock.innerHTML = "";
    return;
  }
  dock.classList.remove("hidden");
  dock.innerHTML = list
    .map((j) => {
      const last = j.steps && j.steps.length ? j.steps[j.steps.length - 1].text : "Starte…";
      return `<button class="job-chip" data-job="${esc(j.id)}" title="Recherche-Fortschritt öffnen">
        <span class="spinner"></span>
        <span class="job-chip-body">
          <span class="job-chip-title">🔎 ${esc(j.label)}</span>
          <span class="job-chip-step">${esc(last)}</span>
        </span>
      </button>`;
    })
    .join("");
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
