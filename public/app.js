"use strict";

// --- Zustand ---------------------------------------------------------------
let leads = [];
let statuses = [];
let aiEnabled = false;
let activeFilter = "alle";
let searchTerm = "";
let models = [];
let currentModel = "";

const $ = (sel) => document.querySelector(sel);
const fmtEuro = (n) => (Number(n) || 0).toLocaleString("de-DE") + " €";
const esc = (s) =>
  String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

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
    renderAiBadge(cfg);
    renderStatusFilters();
    populateStatusSelect();
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
  bindEvents();
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

// --- Daten laden + rendern -------------------------------------------------
async function refresh() {
  leads = await api("/api/leads");
  renderStats(await api("/api/stats"));
  renderLeads();
}

function renderStats(stats) {
  $("#statTotal").textContent = stats.total;
  $("#statPipeline").textContent = fmtEuro(stats.pipelineValue);
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

function renderLeads() {
  const list = $("#leadList");
  const items = filteredLeads();
  $("#emptyState").classList.toggle("hidden", leads.length !== 0);
  list.innerHTML = items.map(leadCard).join("");
}

function fieldVal(f) {
  return f && f.value ? f.value : "";
}

function leadCard(l) {
  const ai = l.ai
    ? `<div class="ai-score">
         <div class="score-ring" style="background:conic-gradient(${scoreColor(l.ai.score)} ${l.ai.score}%, var(--border) 0); color:${scoreColor(l.ai.score)}">
           <span style="background:var(--surface-2);width:34px;height:34px;border-radius:50%;display:grid;place-items:center">${l.ai.score}</span>
         </div>
         <div>
           <small>KI-Score · Note ${esc(l.ai.grade)}</small>
           <div class="ai-step">${esc(l.ai.nextStep || l.ai.reasoning)}</div>
         </div>
       </div>`
    : "";

  // Recherche-Highlights (Branche, Bewertung, stärkstes Potenzial).
  const r = l.research;
  const branche = r ? fieldVal(r.fields && r.fields.branche) : "";
  const bewertung = r ? fieldVal(r.fields && r.fields.kundenbewertung) : "";
  const topPot = r && Array.isArray(r.potenziale) && r.potenziale[0];
  const research = r
    ? `<div class="lead-research">
         <div class="research-tags">
           ${branche ? `<span class="tag">🏷️ ${esc(branche)}</span>` : ""}
           ${bewertung ? `<span class="tag">⭐ ${esc(bewertung)}</span>` : ""}
           ${Array.isArray(r.potenziale) ? `<span class="tag">🎯 ${r.potenziale.length} Potenziale</span>` : ""}
         </div>
         ${topPot ? `<div class="research-top"><strong>Top-Potenzial:</strong> ${esc(topPot.titel)}</div>` : ""}
       </div>`
    : `<div class="lead-research lead-research-empty">Keine Recherchedaten – neu recherchieren.</div>`;

  const aiButtons = aiEnabled
    ? `<button class="btn btn-ai btn-sm" data-action="score" data-id="${l.id}">⚡ KI-Score</button>
       <button class="btn btn-ai btn-sm" data-action="email" data-id="${l.id}">✉️ E-Mail</button>
       <button class="btn btn-ai btn-sm" data-action="insights" data-id="${l.id}">💡 Tipps</button>`
    : "";

  const researchBtns = aiEnabled
    ? `${r ? `<button class="btn btn-sm" data-action="detail" data-id="${l.id}">📋 Dossier</button>` : ""}
       <button class="btn btn-sm" data-action="reresearch" data-id="${l.id}">🔄 Recherche</button>`
    : "";

  return `<article class="lead-card">
    <div class="lead-top">
      <div>
        <div class="lead-name">${esc(l.company) || esc(l.name) || "—"}</div>
        <div class="lead-company">${l.company && l.name ? esc(l.name) : ""}</div>
      </div>
      <span class="status-pill s-${l.status}">${l.status}</span>
    </div>
    <div class="lead-meta">
      ${l.email ? `<span>✉️ <a href="mailto:${esc(l.email)}">${esc(l.email)}</a></span>` : ""}
      ${l.phone ? `<span>📞 ${esc(l.phone)}</span>` : ""}
      ${l.source ? `<span>🌐 ${esc(l.source)}</span>` : ""}
      <span class="lead-value">💶 ${fmtEuro(l.value)}</span>
    </div>
    ${research}
    ${l.notes ? `<div class="lead-notes">${esc(l.notes)}</div>` : ""}
    ${ai}
    <div class="lead-actions">
      ${aiButtons}
      ${researchBtns}
      <button class="btn btn-sm" data-action="edit" data-id="${l.id}">✏️</button>
      <button class="btn btn-sm" data-action="delete" data-id="${l.id}">🗑️</button>
    </div>
  </article>`;
}

// --- Events ----------------------------------------------------------------
function bindEvents() {
  $("#addLeadBtn").addEventListener("click", openResearchModal);
  $("#closeModal").addEventListener("click", closeLeadModal);
  $("#cancelBtn").addEventListener("click", closeLeadModal);
  $("#leadForm").addEventListener("submit", saveLead);

  $("#closeResearchModal").addEventListener("click", closeResearchModal);
  $("#cancelResearchBtn").addEventListener("click", closeResearchModal);
  $("#researchForm").addEventListener("submit", submitResearch);

  $("#settingsBtn").addEventListener("click", openSettingsModal);
  $("#closeSettingsModal").addEventListener("click", closeSettingsModal);
  $("#cancelSettingsBtn").addEventListener("click", closeSettingsModal);
  $("#settingsForm").addEventListener("submit", saveSettings);

  $("#closeDetailModal").addEventListener("click", closeDetailModal);
  $("#closeDetailBtn").addEventListener("click", closeDetailModal);
  $("#copyDetailBtn").addEventListener("click", copyDetailMarkdown);

  $("#closeAiModal").addEventListener("click", closeAiModal);
  $("#closeAiBtn").addEventListener("click", closeAiModal);
  $("#copyAiBtn").addEventListener("click", copyAiResult);

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

  $("#leadList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === "edit") openLeadModal(id);
    else if (action === "delete") deleteLead(id);
    else if (action === "detail") openDetailModal(id);
    else if (action === "reresearch") reResearch(id, btn);
    else if (["score", "email", "insights"].includes(action)) runAi(action, id, btn);
  });

  // Schließen per Klick auf Overlay
  document.querySelectorAll(".modal-overlay").forEach((ov) => {
    ov.addEventListener("click", (e) => {
      if (e.target === ov) ov.classList.add("hidden");
    });
  });
}

// --- Lead-Formular ---------------------------------------------------------
function openLeadModal(id) {
  const form = $("#leadForm");
  form.reset();
  if (id) {
    const l = leads.find((x) => x.id === id);
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
      await api("/api/leads", { method: "POST", body: JSON.stringify(payload) });
      toast("Lead angelegt", "success");
    }
    closeLeadModal();
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deleteLead(id) {
  const l = leads.find((x) => x.id === id);
  if (!confirm(`Lead "${l?.name || l?.company || "—"}" wirklich löschen?`)) return;
  try {
    await api(`/api/leads/${id}`, { method: "DELETE" });
    toast("Lead gelöscht", "success");
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- Einstellungen ---------------------------------------------------------
function openSettingsModal() {
  const sel = $("#settingsModel");
  if (!models.length) {
    toast("Keine Modelle verfügbar (KI nicht konfiguriert)", "error");
    return;
  }
  sel.innerHTML = models
    .map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`)
    .join("");
  sel.value = currentModel;
  $("#settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  $("#settingsModal").classList.add("hidden");
}

async function saveSettings(e) {
  e.preventDefault();
  const model = $("#settingsModel").value;
  try {
    const cfg = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ model }),
    });
    currentModel = cfg.model;
    renderAiBadge({ aiEnabled, model: currentModel });
    toast("Modell gespeichert: " + currentModel.replace("claude-", ""), "success");
    closeSettingsModal();
  } catch (err) {
    toast(err.message, "error");
  }
}

// --- Lead-Recherche --------------------------------------------------------
function openResearchModal() {
  $("#researchForm").reset();
  $("#researchLoading").classList.add("hidden");
  setResearchBusy(false);
  $("#researchModal").classList.remove("hidden");
  $("#researchInput").focus();
}

function closeResearchModal() {
  $("#researchModal").classList.add("hidden");
}

function setResearchBusy(busy) {
  $("#startResearchBtn").disabled = busy;
  $("#cancelResearchBtn").disabled = busy;
  $("#researchInput").disabled = busy;
  $("#researchLoading").classList.toggle("hidden", !busy);
}

async function submitResearch(e) {
  e.preventDefault();
  const input = $("#researchInput").value.trim();
  if (!input) {
    toast("Bitte Website oder Firmennamen eingeben", "error");
    return;
  }
  setResearchBusy(true);
  try {
    const lead = await api("/api/leads/research", {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    toast("Lead recherchiert und angelegt", "success");
    closeResearchModal();
    await refresh();
    if (lead && lead.research) openDetailModal(lead.id);
  } catch (err) {
    toast(err.message, "error");
    setResearchBusy(false);
  }
}

async function reResearch(id, btn) {
  const l = leads.find((x) => x.id === id);
  const suggested = (l && l.research && l.research.input) || (l && l.company) || "";
  const input = prompt("Was soll recherchiert werden? (Website oder Firmenname)", suggested);
  if (input === null) return;
  const trimmed = input.trim();
  if (!trimmed) return;
  btn.disabled = true;
  btn.textContent = "⏳…";
  try {
    await api(`/api/leads/${id}/research`, {
      method: "POST",
      body: JSON.stringify({ input: trimmed }),
    });
    toast("Recherche aktualisiert", "success");
    await refresh();
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
    btn.textContent = "🔄 Recherche";
  }
}

// --- Recherche-Detail (Dossier) --------------------------------------------
let detailMarkdown = "";

function detailRow(label, field) {
  const v = field && field.value ? field.value : "—";
  const src = field && field.source ? field.source : "";
  const srcHtml = src
    ? ` <a class="src" href="${esc(src)}" target="_blank" rel="noopener">↗ Quelle</a>`
    : "";
  return `<tr><th>${esc(label)}</th><td>${esc(v)}${srcHtml}</td></tr>`;
}

function openDetailModal(id) {
  const l = leads.find((x) => x.id === id);
  if (!l || !l.research) {
    toast("Keine Recherchedaten vorhanden", "error");
    return;
  }
  const r = l.research;
  const f = r.fields || {};
  detailMarkdown = r.markdown || "";

  $("#detailTitle").textContent = r.unternehmensname || l.company || "Recherche-Dossier";

  const pots =
    Array.isArray(r.potenziale) && r.potenziale.length
      ? r.potenziale
          .map(
            (p) =>
              `<li><strong>${esc(p.titel)}</strong> — ${esc(p.beschreibung)}<br><em class="signal">Signal: ${esc(p.signal)}</em></li>`
          )
          .join("")
      : "<li>—</li>";

  const meta = [
    r.rechercheStand ? `Recherche-Stand: ${esc(r.rechercheStand)}` : "",
    r.input ? `Input: ${esc(r.input)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  $("#detailBody").innerHTML = `
    <p class="detail-meta">${meta}</p>
    ${r.ambiguityWarning ? `<p class="warn">⚠️ ${esc(r.ambiguityWarning)}</p>` : ""}

    <h3>1. Allgemeine Infos</h3>
    <table class="detail-table">
      ${detailRow("Branche", f.branche)}
      ${detailRow("Adresse", f.adresse)}
      ${detailRow("Telefon (allgemein)", f.telefonAllgemein)}
      ${detailRow("Ansprechpartner / Entscheider", f.ansprechpartner)}
      ${detailRow("Telefon (Durchwahl)", f.telefonDurchwahl)}
      ${detailRow("Öffnungszeiten", f.oeffnungszeiten)}
      ${detailRow("Mail", f.mail)}
      ${detailRow("Web", f.web)}
      ${detailRow("Kundenbewertung", f.kundenbewertung)}
    </table>

    <h3>Negative Bewertungen → Potenzial</h3>
    <p>${esc(r.negativeBewertungen) || "—"}</p>

    <h3>2. Einordnung / Selbstdarstellung</h3>
    <p>${esc(r.einordnung) || "—"}</p>

    <h3>3. Sichtbare Schwachstellen / Ansatzpunkte</h3>
    <p>${esc(r.schwachstellen) || "—"}</p>

    <h3>4. Potenziale für FU/GE</h3>
    <ul class="detail-pots">${pots}</ul>

    <h3>5. Strategie für Cold Call</h3>
    <p>${esc(r.coldCallStrategie) || "—"}</p>

    <h3>6. Risiken / Denkbare Ablehnungsgründe</h3>
    <p>${esc(r.risiken) || "—"}</p>
  `;

  $("#copyDetailBtn").classList.toggle("hidden", !detailMarkdown);
  $("#detailModal").classList.remove("hidden");
}

function closeDetailModal() {
  $("#detailModal").classList.add("hidden");
}

async function copyDetailMarkdown() {
  try {
    await navigator.clipboard.writeText(detailMarkdown);
    toast("Dossier in Zwischenablage kopiert", "success");
  } catch {
    toast("Kopieren nicht möglich", "error");
  }
}

// --- KI-Aktionen -----------------------------------------------------------
async function runAi(action, id, btn) {
  if (action === "score") {
    btn.disabled = true;
    btn.textContent = "⏳…";
    try {
      await api(`/api/leads/${id}/score`, { method: "POST" });
      toast("KI-Bewertung erstellt", "success");
      await refresh();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "⚡ KI-Score";
    }
    return;
  }

  // E-Mail oder Insights → Ergebnis-Modal
  const titles = { email: "✉️ KI-E-Mail-Entwurf", insights: "💡 KI-Empfehlung" };
  $("#aiModalTitle").textContent = titles[action];
  $("#aiResult").textContent = "";
  $("#aiLoading").classList.remove("hidden");
  $("#aiModal").classList.remove("hidden");

  try {
    let body = {};
    if (action === "email") {
      const goal = prompt(
        "Ziel der E-Mail (optional):",
        "Erstkontakt herstellen und ein kurzes Kennenlerngespräch vorschlagen"
      );
      if (goal === null) {
        closeAiModal();
        return;
      }
      body = { goal };
    }
    const data = await api(`/api/leads/${id}/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    $("#aiResult").textContent = data.email || data.insights || "";
  } catch (err) {
    $("#aiResult").textContent = "Fehler: " + err.message;
  } finally {
    $("#aiLoading").classList.add("hidden");
  }
}

function closeAiModal() {
  $("#aiModal").classList.add("hidden");
}

async function copyAiResult() {
  const text = $("#aiResult").textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast("In Zwischenablage kopiert", "success");
  } catch {
    toast("Kopieren nicht möglich", "error");
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
