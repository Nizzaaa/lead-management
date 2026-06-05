"use strict";

// --- Zustand ---------------------------------------------------------------
let leads = [];
let statuses = [];
let aiEnabled = false;
let activeFilter = "alle";
let searchTerm = "";

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
    badge.textContent = "🤖 KI aktiv";
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

  const aiButtons = aiEnabled
    ? `<button class="btn btn-ai btn-sm" data-action="score" data-id="${l.id}">⚡ KI-Score</button>
       <button class="btn btn-ai btn-sm" data-action="email" data-id="${l.id}">✉️ E-Mail</button>
       <button class="btn btn-ai btn-sm" data-action="insights" data-id="${l.id}">💡 Tipps</button>`
    : "";

  return `<article class="lead-card">
    <div class="lead-top">
      <div>
        <div class="lead-name">${esc(l.name) || "—"}</div>
        <div class="lead-company">${esc(l.company) || ""}</div>
      </div>
      <span class="status-pill s-${l.status}">${l.status}</span>
    </div>
    <div class="lead-meta">
      ${l.email ? `<span>✉️ <a href="mailto:${esc(l.email)}">${esc(l.email)}</a></span>` : ""}
      ${l.phone ? `<span>📞 ${esc(l.phone)}</span>` : ""}
      ${l.source ? `<span>📍 ${esc(l.source)}</span>` : ""}
      <span class="lead-value">💶 ${fmtEuro(l.value)}</span>
    </div>
    ${l.notes ? `<div class="lead-notes">${esc(l.notes)}</div>` : ""}
    ${ai}
    <div class="lead-actions">
      ${aiButtons}
      <button class="btn btn-sm" data-action="edit" data-id="${l.id}">✏️ Bearbeiten</button>
      <button class="btn btn-sm" data-action="delete" data-id="${l.id}">🗑️</button>
    </div>
  </article>`;
}

// --- Events ----------------------------------------------------------------
function bindEvents() {
  $("#addLeadBtn").addEventListener("click", () => openLeadModal());
  $("#closeModal").addEventListener("click", closeLeadModal);
  $("#cancelBtn").addEventListener("click", closeLeadModal);
  $("#leadForm").addEventListener("submit", saveLead);

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
