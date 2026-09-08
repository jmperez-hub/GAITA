/**
 * admin.js
 * Panel de administración (/admin) — La Occidental C.A. de Seguros.
 * Login simple + listado, búsqueda/filtros, detalle y exportación CSV de las
 * conversaciones guardadas en conversations.json (vía la API /api/admin/*).
 */

(function () {
  "use strict";

  // Se sobreescribe con la respuesta del servidor (ver loadConversations),
  // esto es solo un valor por defecto mientras carga.
  const RAMO_LABELS_FALLBACK = {
    personas: "Personas",
    autos: "Automóviles",
    patrimoniales: "Patrimoniales",
    fianzas: "Fianzas",
  };

  const AVATAR_SVG = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="4" r="1.3"></circle>
      <rect x="11.3" y="5" width="1.4" height="2.6"></rect>
      <rect x="4.5" y="7.5" width="15" height="11" rx="5.5"></rect>
      <circle cx="9.4" cy="13" r="1.6" fill="#ffffff"></circle>
      <circle cx="14.6" cy="13" r="1.6" fill="#ffffff"></circle>
      <rect x="10" y="16.3" width="4" height="1.3" rx="0.65" fill="#ffffff"></rect>
    </svg>
  `;

  // Glifo clásico de WhatsApp (auricular en una burbuja de chat), en blanco — se usa
  // sobre el fondo verde de la insignia .lo-admin-badge-whatsapp.
  const WHATSAPP_ICON_SVG = `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="lo-whatsapp-icon">
      <path d="M12 2a10 10 0 00-8.6 15.1L2 22l5.06-1.33A10 10 0 1012 2zm0 18a8 8 0 01-4.08-1.12l-.29-.17-3.02.79.8-2.94-.19-.3A8 8 0 1112 20zm4.4-5.6c-.24-.12-1.43-.7-1.65-.79-.22-.08-.38-.12-.55.12-.16.24-.63.79-.77.95-.14.16-.28.18-.52.06-.24-.12-1.01-.37-1.92-1.18-.71-.63-1.19-1.42-1.33-1.66-.14-.24-.01-.37.11-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.7 2.6 4.13 3.64.58.25 1.03.4 1.38.51.58.18 1.11.16 1.53.1.47-.07 1.43-.58 1.63-1.15.2-.57.2-1.05.14-1.15-.06-.1-.22-.16-.46-.28z"/>
    </svg>
  `;

  const state = {
    conversations: [],
    filtered: [],
    ramoLabels: RAMO_LABELS_FALLBACK,
    clientes: [],
    clientesFiltered: [],
    siniestros: [],
    siniestrosFiltered: [],
    emisiones: [],
    emisionesFiltered: [],
    gaps: [],
    gapsFiltered: [],
  };

  function qs(id) {
    return document.getElementById(id);
  }

  /** fetch con manejo uniforme de sesión expirada (401 -> vuelve al login). */
  async function apiFetch(url, options) {
    const response = await fetch(url, Object.assign({ credentials: "same-origin" }, options));
    if (response.status === 401) {
      showLogin();
    }
    return response;
  }

  // -------------------------------------------------------------------------
  // Vistas: login vs. dashboard
  // -------------------------------------------------------------------------

  function showLogin() {
    qs("lo-admin-login").hidden = false;
    qs("lo-admin-dashboard").hidden = true;
    closeModal();
  }

  function showDashboard() {
    qs("lo-admin-login").hidden = true;
    qs("lo-admin-dashboard").hidden = false;
  }

  async function checkSession() {
    try {
      const res = await fetch("/api/admin/session", { credentials: "same-origin" });
      const data = await res.json();
      if (data && data.authenticated) {
        showDashboard();
        loadConversations();
      } else {
        showLogin();
      }
    } catch (_e) {
      showLogin();
    }
  }

  // -------------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------------

  async function handleLogin(event) {
    event.preventDefault();
    const password = qs("lo-admin-password").value;
    const errorEl = qs("lo-admin-login-error");
    const submitBtn = qs("lo-admin-login-submit");

    errorEl.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = "Ingresando…";

    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username: "admin", password }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        errorEl.textContent = data.error || "No se pudo iniciar sesión.";
        errorEl.hidden = false;
        return;
      }

      qs("lo-admin-password").value = "";
      showDashboard();
      loadConversations();
    } catch (_e) {
      errorEl.textContent = "No se pudo conectar con el servidor. Intenta de nuevo.";
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Ingresar";
    }
  }

  async function handleLogout() {
    try {
      await fetch("/api/admin/logout", { method: "POST", credentials: "same-origin" });
    } catch (_e) {
      /* ignorar: igual mostramos el login */
    }
    showLogin();
  }

  // -------------------------------------------------------------------------
  // Carga y estadísticas
  // -------------------------------------------------------------------------

  async function loadConversations() {
    const loadingEl = qs("lo-admin-loading");
    const emptyEl = qs("lo-admin-empty");
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    qs("lo-admin-table-body").innerHTML = "";

    try {
      const res = await apiFetch("/api/admin/conversations");
      if (!res.ok) throw new Error("No se pudieron cargar las conversaciones.");
      const data = await res.json();
      state.conversations = data.conversations || [];
      state.ramoLabels = data.ramoLabels || RAMO_LABELS_FALLBACK;
      applyFilters();
      renderStats();
    } catch (err) {
      console.error("[Panel admin] Error al cargar conversaciones:", err);
      emptyEl.textContent = "No se pudieron cargar las conversaciones. Intenta actualizar.";
      emptyEl.hidden = false;
    } finally {
      loadingEl.hidden = true;
    }
  }

  function renderStats() {
    const total = state.conversations.length;
    const advisorCount = state.conversations.filter((c) => c.advisorRequested).length;
    const avgMessages = total
      ? Math.round(state.conversations.reduce((sum, c) => sum + (c.messageCount || 0), 0) / total)
      : 0;
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayCount = state.conversations.filter((c) => (c.startedAt || "").slice(0, 10) === todayKey).length;

    const stats = [
      { value: total, label: "Conversaciones totales" },
      { value: todayCount, label: "Conversaciones hoy" },
      { value: advisorCount, label: "Solicitaron asesor" },
      { value: avgMessages, label: "Mensajes promedio" },
    ];

    qs("lo-admin-stats").innerHTML = stats
      .map(
        (s) =>
          `<div class="lo-admin-stat-card"><div class="lo-admin-stat-value">${s.value}</div><div class="lo-admin-stat-label">${escapeHtml(
            s.label
          )}</div></div>`
      )
      .join("");
  }

  // -------------------------------------------------------------------------
  // Búsqueda y filtros
  // -------------------------------------------------------------------------

  function applyFilters() {
    const search = qs("lo-admin-search").value.trim().toLowerCase();
    const dateFrom = qs("lo-admin-date-from").value; // yyyy-mm-dd
    const dateTo = qs("lo-admin-date-to").value;
    const channel = qs("lo-admin-filter-channel").value;
    const ramo = qs("lo-admin-filter-ramo").value;
    const advisor = qs("lo-admin-filter-advisor").value;
    const revisionFilter = qs("lo-admin-filter-revision").value;

    state.filtered = state.conversations.filter((c) => {
      if (search) {
        const haystack = `${c.id} ${c.phone || ""} ${c.preview || ""}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      const startedDate = (c.startedAt || "").slice(0, 10);
      if (dateFrom && startedDate < dateFrom) return false;
      if (dateTo && startedDate > dateTo) return false;
      if (channel && c.channel !== channel) return false;
      if (ramo && !(c.ramos || []).includes(ramo)) return false;
      if (advisor === "si" && !c.advisorRequested) return false;
      if (advisor === "no" && c.advisorRequested) return false;
      if (revisionFilter === "revision" && !c.requiereRevision) return false;
      if (revisionFilter === "escalado" && !c.escalado) return false;
      return true;
    });

    renderTable();
  }

  /** Insignia del canal — WhatsApp (verde, ícono de WhatsApp) o chat web. */
  function channelHtml(c) {
    if (c.channel === "whatsapp") {
      return `<span class="lo-admin-badge lo-admin-badge-whatsapp" title="${escapeAttr(
        c.phone || "WhatsApp"
      )}">${WHATSAPP_ICON_SVG} WhatsApp</span>`;
    }
    return '<span class="lo-admin-badge lo-admin-badge-web">💬 Web</span>';
  }

  function renderTable() {
    const tbody = qs("lo-admin-table-body");
    const emptyEl = qs("lo-admin-empty");

    if (state.filtered.length === 0) {
      tbody.innerHTML = "";
      emptyEl.textContent = "No hay conversaciones que coincidan con la búsqueda o los filtros.";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    tbody.innerHTML = state.filtered
      .map((c) => {
        const ramosHtml =
          (c.ramos || [])
            .map(
              (r) =>
                `<span class="lo-admin-badge lo-admin-badge-ramo">${escapeHtml(state.ramoLabels[r] || r)}</span>`
            )
            .join("") || "—";
        const advisorHtml = c.advisorRequested
          ? '<span class="lo-admin-badge lo-admin-badge-advisor-yes">Sí</span>'
          : '<span class="lo-admin-badge lo-admin-badge-advisor-no">No</span>';

        const quoteHtml =
          c.quoteRamos && c.quoteRamos.length
            ? c.quoteRamos
                .map(
                  (r) =>
                    `<span class="lo-admin-badge lo-admin-badge-quote">${escapeHtml(
                      state.ramoLabels[r] || r
                    )}</span>`
                )
                .join("") +
              (c.hasFormalRequest ? '<span class="lo-admin-badge lo-admin-badge-formal">📄 Póliza</span>' : "")
            : "—";

        const attachIcon = c.hasAttachments
          ? '<span class="lo-admin-attach-icon" title="Esta conversación tiene adjuntos">📎</span>'
          : "";

        // Valoración de calidad + escalamiento (ver classifyIntentAndEmotion/handleRatingGate
        // en server.js) — badge rojo si requiere revisión (⭐ ≤ 2) o quedó escalada
        // (tono molesto detectado), badge verde con la nota si ya se valoró bien.
        let ratingHtml = "—";
        if (c.rating != null) {
          ratingHtml = `<span class="lo-admin-badge ${c.rating <= 2 ? "lo-admin-badge-vencida" : "lo-admin-badge-vigente"}">⭐ ${c.rating}/5</span>`;
        } else if (c.requiereRevision) {
          ratingHtml = '<span class="lo-admin-badge lo-admin-badge-vencida">Revisar</span>';
        }
        if (c.escalado) {
          ratingHtml += ' <span class="lo-admin-badge lo-admin-badge-mayor">🚨</span>';
        }

        return `
          <tr data-id="${escapeHtml(c.id)}">
            <td>${channelHtml(c)}</td>
            <td>${escapeHtml(formatDateTime(c.startedAt))}</td>
            <td>${escapeHtml(formatDuration(c.durationSeconds))}</td>
            <td>${c.messageCount}</td>
            <td>${ramosHtml}</td>
            <td>${advisorHtml}</td>
            <td>${quoteHtml}</td>
            <td>${ratingHtml}</td>
            <td class="lo-admin-cell-preview" title="${escapeHtml(c.preview || "")}">${attachIcon}${escapeHtml(
          c.preview || "—"
        )}</td>
          </tr>
        `;
      })
      .join("");

    Array.from(tbody.querySelectorAll("tr")).forEach((row) => {
      row.addEventListener("click", () => openDetail(row.getAttribute("data-id")));
    });
  }

  // -------------------------------------------------------------------------
  // Detalle de conversación (modal)
  // -------------------------------------------------------------------------

  let currentConversationId = null;
  let liveEventSource = null;

  async function openDetail(id) {
    const modal = qs("lo-admin-modal");
    const body = qs("lo-admin-modal-body");
    const meta = qs("lo-admin-modal-meta");

    stopLiveMode(); // por si quedó una conexión abierta de la conversación anterior
    currentConversationId = id;
    modal.hidden = false;
    body.innerHTML = '<div class="lo-admin-loading">Cargando conversación…</div>';
    meta.textContent = "";

    try {
      const res = await apiFetch(`/api/admin/conversations/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error("No se pudo cargar la conversación.");
      const data = await res.json();
      renderDetail(data.conversation);
    } catch (err) {
      body.innerHTML = `<div class="lo-admin-empty">${escapeHtml(
        err.message || "Error al cargar la conversación."
      )}</div>`;
    }
  }

  function messageRowHtml(m) {
    const isUser = m.role === "user";
    const bubbleClass = isUser ? "lo-msg-user" : "lo-msg-bot";
    const timeLabel = m.time ? formatTime(m.time) : "";
    const avatar = isUser
      ? ""
      : `<div class="lo-avatar lo-avatar-sm">${AVATAR_SVG}<img src="lucy-avatar.png" alt="" onerror="this.remove()" /></div>`;
    // `staffAuthored` (ver POST .../message) se marca SOLO para el equipo — al usuario
    // le llegó igual que cualquier otro mensaje de Lucy ("shadow messaging").
    const staffTag = m.staffAuthored ? ' <span class="lo-admin-staff-tag">· equipo</span>' : "";
    return `
      <div class="lo-msg-row ${isUser ? "lo-row-user" : "lo-row-bot"}">
        ${avatar}
        <div class="lo-msg-col">
          ${attachmentHtml(m.attachment)}
          <div class="lo-msg ${bubbleClass}">${escapeHtml(m.content)}</div>
          ${attachmentHtml(m.media)}
          <span class="lo-msg-time">${escapeHtml(timeLabel)}${staffTag}</span>
        </div>
      </div>
    `;
  }

  function renderDetail(conversation) {
    const meta = qs("lo-admin-modal-meta");
    const body = qs("lo-admin-modal-body");

    const summary = state.conversations.find((c) => c.id === conversation.id);
    const ramosLabel =
      summary && summary.ramos && summary.ramos.length
        ? summary.ramos.map((r) => state.ramoLabels[r] || r).join(", ")
        : "sin ramo detectado";
    // Para WhatsApp, el ID de la conversación ES el número de teléfono — no repetirlo.
    const idLabel =
      summary && summary.channel === "whatsapp"
        ? `WhatsApp ${(summary.phone || conversation.id).replace(/^whatsapp:/i, "")}`
        : `ID ${conversation.id} · Chat web`;

    meta.textContent = `${idLabel} · Inicio ${formatDateTime(conversation.startedAt)} · ${ramosLabel}`;

    // Si esta conversación ya está vinculada a un cliente identificado (memoria
    // persistente), un enlace rápido para saltar a su perfil completo.
    if (conversation.clienteId) {
      const link = document.createElement("button");
      link.type = "button";
      link.className = "lo-admin-client-link";
      link.textContent = `👤 Ver perfil del cliente (${conversation.clienteId})`;
      link.addEventListener("click", () => {
        closeModal();
        openClientDetail(conversation.clienteId);
      });
      meta.appendChild(document.createElement("br"));
      meta.appendChild(link);
    }

    const messages = conversation.messages || [];
    const messagesHtml = messages.length
      ? messages.map(messageRowHtml).join("")
      : '<div class="lo-admin-empty">Esta conversación no tiene mensajes.</div>';

    body.innerHTML =
      supervisorBarHtml(summary) + `<div id="lo-admin-live-messages">${messagesHtml}</div>` + renderQuotesSection(conversation.quotes) + shadowComposerHtml();
    body.scrollTop = 0;

    wireSupervisorControls(conversation.id, summary);
  }

  // -------------------------------------------------------------------------
  // Modo supervisor: ver en vivo, tomar control, "shadow messaging", notas internas.
  // -------------------------------------------------------------------------

  function supervisorBarHtml(summary) {
    const escaladoBadge = summary && summary.escalado ? '<span class="lo-admin-badge lo-admin-badge-mayor">🚨 Escalado</span>' : "";
    const ratingBadge =
      summary && summary.rating != null
        ? `<span class="lo-admin-badge ${summary.rating <= 2 ? "lo-admin-badge-vencida" : "lo-admin-badge-vigente"}">⭐ ${summary.rating}/5</span>`
        : "";
    const revisionBadge =
      summary && summary.requiereRevision ? '<span class="lo-admin-badge lo-admin-badge-vencida">Requiere revisión</span>' : "";
    const controlActivo = Boolean(summary && summary.controladoPorHumano);

    return `
      <div class="lo-admin-supervisor-bar">
        <button type="button" class="lo-admin-btn-ghost" id="lo-admin-live-toggle">🔴 Ver en vivo</button>
        <button type="button" class="lo-admin-btn-ghost ${controlActivo ? "lo-admin-control-active" : ""}" id="lo-admin-control-toggle">
          ${controlActivo ? "🔓 Soltar control" : "🧑‍💼 Tomar control"}
        </button>
        ${escaladoBadge} ${ratingBadge} ${revisionBadge}
      </div>
      <div class="lo-admin-supervisor-notes">
        <label for="lo-admin-conv-notas">Notas internas (solo el equipo, no las ve el cliente)</label>
        <textarea id="lo-admin-conv-notas" rows="2" maxlength="2000">${escapeHtml((summary && summary.notasInternas) || "")}</textarea>
        <button type="button" class="lo-admin-btn-ghost" id="lo-admin-notas-save">💾 Guardar notas</button>
        <span class="lo-quoter-save-status" id="lo-admin-notas-status" hidden></span>
      </div>
    `;
  }

  function shadowComposerHtml() {
    return `
      <div class="lo-admin-shadow-composer">
        <input type="text" id="lo-admin-shadow-input" placeholder="Escribe un mensaje — se envía como si lo hubiera escrito Lucy..." maxlength="4000" />
        <button type="button" class="lo-admin-btn-primary" id="lo-admin-shadow-send">Enviar</button>
      </div>
      <span class="lo-quoter-save-status" id="lo-admin-shadow-status" hidden></span>
    `;
  }

  function wireSupervisorControls(conversationId, summary) {
    qs("lo-admin-live-toggle").addEventListener("click", () => toggleLiveMode(conversationId));
    qs("lo-admin-control-toggle").addEventListener("click", () => toggleControl(conversationId, summary));
    qs("lo-admin-notas-save").addEventListener("click", () => saveConversationNotes(conversationId));
    qs("lo-admin-shadow-send").addEventListener("click", () => sendShadowMessage(conversationId));
    qs("lo-admin-shadow-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") sendShadowMessage(conversationId);
    });
  }

  function toggleLiveMode(conversationId) {
    const btn = qs("lo-admin-live-toggle");
    if (liveEventSource) {
      stopLiveMode();
      if (btn) btn.textContent = "🔴 Ver en vivo";
      return;
    }
    liveEventSource = new EventSource(`/api/admin/conversations/${encodeURIComponent(conversationId)}/live`);
    liveEventSource.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        const container = qs("lo-admin-live-messages");
        if (!container) return;
        container.insertAdjacentHTML("beforeend", messageRowHtml(msg));
        const body = qs("lo-admin-modal-body");
        if (body) body.scrollTop = body.scrollHeight;
      } catch (_e) {
        /* evento malformado — se ignora */
      }
    });
    if (btn) btn.textContent = "⏹️ Detener vista en vivo";
  }

  function stopLiveMode() {
    if (liveEventSource) {
      liveEventSource.close();
      liveEventSource = null;
    }
  }

  async function toggleControl(conversationId, summary) {
    const btn = qs("lo-admin-control-toggle");
    const tomarControl = !(summary && summary.controladoPorHumano);
    btn.disabled = true;
    try {
      const res = await apiFetch(`/api/admin/conversations/${encodeURIComponent(conversationId)}/control`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tomarControl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudo actualizar el control de la conversación.");
      if (summary) summary.controladoPorHumano = data.controladoPorHumano;
      btn.textContent = data.controladoPorHumano ? "🔓 Soltar control" : "🧑‍💼 Tomar control";
      btn.classList.toggle("lo-admin-control-active", data.controladoPorHumano);
    } catch (err) {
      alert(err.message || "Error al actualizar el control de la conversación.");
    } finally {
      btn.disabled = false;
    }
  }

  async function saveConversationNotes(conversationId) {
    const statusEl = qs("lo-admin-notas-status");
    const notas = qs("lo-admin-conv-notas").value;
    statusEl.hidden = true;
    try {
      const res = await apiFetch(`/api/admin/conversations/${encodeURIComponent(conversationId)}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notas }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudieron guardar las notas.");
      statusEl.textContent = "✓ Notas guardadas.";
      statusEl.className = "lo-quoter-save-status lo-status-ok";
      statusEl.hidden = false;
    } catch (err) {
      statusEl.textContent = err.message || "Error al guardar las notas.";
      statusEl.className = "lo-quoter-save-status lo-status-error";
      statusEl.hidden = false;
    }
  }

  async function sendShadowMessage(conversationId) {
    const input = qs("lo-admin-shadow-input");
    const statusEl = qs("lo-admin-shadow-status");
    const text = input.value.trim();
    if (!text) return;
    statusEl.hidden = true;
    try {
      const res = await apiFetch(`/api/admin/conversations/${encodeURIComponent(conversationId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudo enviar el mensaje.");
      input.value = "";
      const container = qs("lo-admin-live-messages");
      if (container) {
        container.insertAdjacentHTML("beforeend", messageRowHtml(data.message));
        const body = qs("lo-admin-modal-body");
        if (body) body.scrollTop = body.scrollHeight;
      }
    } catch (err) {
      statusEl.textContent = err.message || "Error al enviar el mensaje.";
      statusEl.className = "lo-quoter-save-status lo-status-error";
      statusEl.hidden = false;
    }
  }

  /** Sección "Cotizaciones generadas" al final del detalle de la conversación. */
  function renderQuotesSection(quotes) {
    const list = quotes ? Object.values(quotes) : [];
    if (list.length === 0) return "";
    const itemsHtml = list
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map(quoteItemHtml)
      .join("");
    return `<div class="lo-admin-quotes-section"><h3>📋 Cotizaciones generadas (${list.length})</h3>${itemsHtml}</div>`;
  }

  function quoteItemHtml(q) {
    const ramoLabel = state.ramoLabels[q.ramo] || q.ramo;
    const rows = quoteResultRows(q);
    const rowsHtml = rows
      .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join("");
    const contactHtml = q.contact
      ? `<div class="lo-admin-quote-contact">📄 Solicitó póliza formal — ${escapeHtml(q.contact.nombre)} · ${escapeHtml(
          q.contact.cedula
        )} · ${escapeHtml(q.contact.correo)}</div>`
      : "";

    return `
      <div class="lo-admin-quote-item">
        <div class="lo-admin-quote-item-header">
          <strong>${escapeHtml(ramoLabel)}</strong>
          <span>${escapeHtml(formatDateTime(q.createdAt))}</span>
        </div>
        <table>${rowsHtml}</table>
        ${contactHtml}
      </div>
    `;
  }

  function quoteResultRows(q) {
    const inputs = q.inputs || {};
    const result = q.result || {};

    if (q.ramo === "autos") {
      return [
        ["Vehículo", `${inputs.marca || ""} ${inputs.modelo || ""} ${inputs.anio || ""}`.trim() || "—"],
        ["Tipo", result.tarifaLabel || "—"],
        ["Placa", result.placaLabel || "—"],
        [
          "Prima anual estimada",
          result.primaFinal != null ? `${result.primaFinal} ${result.currencyLabel || ""}` : "—",
        ],
      ];
    }
    if (q.ramo === "personas") {
      return [
        ["Suma asegurada", result.sumaLabel || "—"],
        ["Titular", result.titular ? `${result.titular.age} años` : "—"],
        ["Beneficiarios adicionales", String((result.beneficiarios || []).length)],
        [
          "Prima anual total",
          result.total != null ? `${result.total} ${result.currencyLabel || "USD"}` : "—",
        ],
      ];
    }
    if (q.ramo === "patrimoniales") {
      return [
        ["Tipo de bien", inputs.tipoBienLabel || "—"],
        ["Valor asegurado", inputs.valor != null ? `${inputs.valor} USD` : "—"],
        ["Correo", inputs.correo || "—"],
      ];
    }
    return [];
  }

  function closeModal() {
    qs("lo-admin-modal").hidden = true;
    stopLiveMode();
    currentConversationId = null;
  }

  // -------------------------------------------------------------------------
  // Utilidades de formato
  // -------------------------------------------------------------------------

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }

  /** Como escapeHtml, pero también escapa comillas — seguro para usar dentro de value="...". */
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** Thumbnail/chip clicable de un adjunto (imagen, PDF, nota de voz, video o imagen
   *  del catálogo de Lucy) dentro de una burbuja del transcript — reutiliza las clases
   *  .lo-msg-attachment / .lo-msg-video / .lo-msg-media de chatbot.css. Sirve tanto
   *  para `m.attachment` como para `m.media` (llamar con cada uno por separado). */
  function attachmentHtml(attachment) {
    if (!attachment || (!attachment.fileId && !attachment.videoKey && !attachment.mediaKey)) return "";
    if (attachment.mediaKey) {
      const mediaUrl = String(attachment.url || "");
      return `<a class="lo-msg-media-wrap" href="${escapeAttr(mediaUrl)}" target="_blank" rel="noopener noreferrer" style="display:block">
        <img class="lo-msg-media-img" src="${escapeAttr(mediaUrl)}" alt="${escapeAttr(attachment.title || "Imagen")}" loading="lazy" />
        <span class="lo-admin-video-title">🖼️ ${escapeHtml(attachment.title || attachment.filename || "Imagen")}</span>
      </a>`;
    }
    if (attachment.kind === "video") {
      const videoUrl = String(attachment.url || "");
      const posterUrl = String(attachment.posterUrl || "");
      return `<div class="lo-msg-video-wrap">
        <video class="lo-msg-video" controls preload="metadata" src="${escapeAttr(videoUrl)}"${
        posterUrl ? ` poster="${escapeAttr(posterUrl)}"` : ""
      }></video>
        <span class="lo-admin-video-title">🎬 ${escapeHtml(attachment.title || attachment.filename || "Video")}</span>
      </div>`;
    }
    const url = `/uploads/${escapeAttr(attachment.fileId)}`;
    if (attachment.kind === "image") {
      return `<a class="lo-msg-attachment" href="${url}" target="_blank" rel="noopener noreferrer">
        <img src="${url}" alt="${escapeAttr(attachment.filename || "Imagen adjunta")}" loading="lazy" />
      </a>`;
    }
    if (attachment.kind === "audio") {
      const transcript = String(attachment.transcript || "").trim();
      const isLucy = attachment.generatedBy === "lucy";
      const providerLabel = { elevenlabs: "ElevenLabs", openai: "OpenAI TTS" }[attachment.ttsProvider] || "";
      return `<div class="lo-admin-audio-chip">
        <span class="lo-msg-attachment-icon">${isLucy ? "🔊" : "🎤"}</span>
        <audio class="lo-admin-audio" controls preload="none" src="${url}"></audio>
        ${
          isLucy
            ? `<span class="lo-admin-audio-badge">Generado por Lucy${providerLabel ? ` · ${escapeHtml(providerLabel)}` : ""}</span>`
            : ""
        }
        ${
          transcript
            ? `<p class="lo-admin-audio-transcript">📝 Transcripción: ${escapeHtml(transcript)}</p>`
            : `<p class="lo-admin-audio-transcript lo-admin-audio-transcript-none">Sin transcripción disponible.</p>`
        }
      </div>`;
    }
    return `<a class="lo-msg-attachment lo-msg-attachment-file" href="${url}" target="_blank" rel="noopener noreferrer">
      <span class="lo-msg-attachment-icon">📄</span>
      <span class="lo-msg-attachment-name">${escapeHtml(attachment.filename || "Documento adjunto")}</span>
    </a>`;
  }

  function formatDateTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("es-VE", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
    } catch (_e) {
      return iso;
    }
  }

  function formatTime(iso) {
    try {
      return new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
    } catch (_e) {
      return "";
    }
  }

  function formatDuration(seconds) {
    const total = Number(seconds) || 0;
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    const remSeconds = total % 60;
    if (minutes < 60) return remSeconds ? `${minutes} min ${remSeconds}s` : `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours} h ${remMinutes} min`;
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // -------------------------------------------------------------------------
  // Pestañas: Conversaciones ↔ Cotizador ↔ Reportes
  // -------------------------------------------------------------------------

  const VIEWS = ["conversations", "clientes", "siniestros", "emisiones", "gaps", "quoter", "reports"];
  let quoterViewLoaded = false;
  let reportsViewLoaded = false;
  let clientesViewLoaded = false;
  let siniestrosViewLoaded = false;
  let emisionesViewLoaded = false;
  let gapsViewLoaded = false;

  function showView(name) {
    VIEWS.forEach((v) => {
      qs(`lo-admin-view-${v}`).hidden = v !== name;
      qs(`lo-admin-tab-${v}`).classList.toggle("lo-admin-tab-active", v === name);
    });

    if (name === "quoter" && !quoterViewLoaded) {
      quoterViewLoaded = true;
      loadAndRenderQuoterConfig();
    }
    if (name === "reports" && !reportsViewLoaded) {
      reportsViewLoaded = true;
      loadAndRenderReports();
    }
    if (name === "clientes" && !clientesViewLoaded) {
      clientesViewLoaded = true;
      loadClientes();
    }
    if (name === "siniestros" && !siniestrosViewLoaded) {
      siniestrosViewLoaded = true;
      loadSiniestros();
    }
    if (name === "emisiones" && !emisionesViewLoaded) {
      emisionesViewLoaded = true;
      loadEmisiones();
    }
    if (name === "gaps" && !gapsViewLoaded) {
      gapsViewLoaded = true;
      loadGaps();
    }
  }

  // -------------------------------------------------------------------------
  // Clientes (memoria persistente) — lista, búsqueda, y perfil editable
  // -------------------------------------------------------------------------

  const CANAL_LABELS = { web: "💬 Web", whatsapp: "WhatsApp" };

  async function loadClientes() {
    qs("lo-clientes-loading").hidden = false;
    qs("lo-clientes-empty").hidden = true;
    try {
      const res = await apiFetch("/api/admin/clientes");
      if (!res.ok) throw new Error("No se pudo cargar la lista de clientes.");
      const data = await res.json();
      state.clientes = data.clientes || [];
      applyClientesFilter();
    } catch (err) {
      qs("lo-clientes-table-body").innerHTML = "";
      qs("lo-clientes-empty").hidden = false;
      qs("lo-clientes-empty").textContent = err.message || "Error al cargar los clientes.";
    } finally {
      qs("lo-clientes-loading").hidden = true;
    }
  }

  function applyClientesFilter() {
    const term = normalizeSearch(qs("lo-clientes-search").value);
    state.clientesFiltered = !term
      ? state.clientes
      : state.clientes.filter((c) =>
          [c.cedula, c.nombre, c.telefono, c.email].some((f) => normalizeSearch(f).includes(term))
        );
    renderClientesTable();
  }

  function normalizeSearch(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  function renderClientesTable() {
    const tbody = qs("lo-clientes-table-body");
    const emptyEl = qs("lo-clientes-empty");

    if (state.clientesFiltered.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent =
        state.clientes.length === 0
          ? "Todavía no hay clientes identificados — aparecerán aquí en cuanto alguien le comparta su cédula o número de póliza a Lucy."
          : "No hay clientes que coincidan con la búsqueda.";
      return;
    }
    emptyEl.hidden = true;

    tbody.innerHTML = state.clientesFiltered
      .map((c) => {
        const vipHtml = c.vip ? '<span class="lo-admin-badge lo-admin-badge-formal">⭐ VIP</span>' : "—";
        const polizasHtml = (c.polizas || []).length ? escapeHtml(c.polizas.join(", ")) : "—";
        const canalHtml = escapeHtml(CANAL_LABELS[c.canalPreferido] || c.canalPreferido || "—");
        return `
          <tr data-cedula="${escapeAttr(c.cedula)}">
            <td>${escapeHtml(c.cedula)}</td>
            <td>${escapeHtml(c.nombre || "—")}</td>
            <td>${escapeHtml(c.telefono || "—")}</td>
            <td>${polizasHtml}</td>
            <td>${canalHtml}</td>
            <td>${vipHtml}</td>
            <td>${escapeHtml(formatDateTime(c.ultimaInteraccion))}</td>
          </tr>
        `;
      })
      .join("");

    Array.from(tbody.querySelectorAll("tr")).forEach((row) => {
      row.addEventListener("click", () => openClientDetail(row.getAttribute("data-cedula")));
    });
  }

  // -------------------------------------------------------------------------
  // Detalle de cliente (modal): perfil editable + historial de conversaciones
  // -------------------------------------------------------------------------

  let currentClienteCedula = null;

  async function openClientDetail(cedula) {
    const modal = qs("lo-client-modal");
    const body = qs("lo-client-modal-body");
    const meta = qs("lo-client-modal-meta");

    currentClienteCedula = cedula;
    modal.hidden = false;
    body.innerHTML = '<div class="lo-admin-loading">Cargando cliente…</div>';
    meta.textContent = "";

    try {
      const res = await apiFetch(`/api/admin/clientes/${encodeURIComponent(cedula)}`);
      if (!res.ok) throw new Error("No se pudo cargar el cliente.");
      const data = await res.json();
      renderClientDetail(data.cliente, data.conversaciones || [], data.polizas || []);
    } catch (err) {
      body.innerHTML = `<div class="lo-admin-empty">${escapeHtml(err.message || "Error al cargar el cliente.")}</div>`;
    }
  }

  const POLIZA_RAMO_LABELS = {
    automoviles: "Automóviles",
    autos: "Automóviles",
    hcm: "HCM",
    personas: "Personas",
    patrimonial: "Patrimonial",
    patrimoniales: "Patrimoniales",
    fianza: "Fianza",
    fianzas: "Fianzas",
  };

  /** Insignia de vigencia de una póliza — usa `poliza.vigencia`, ya calculada por
   *  polizasService.verificarVigencia() en el servidor (ver GET /api/admin/clientes/:cedula). */
  function polizaVigenciaBadge(vig) {
    if (!vig) return "—";
    if (vig.vencida) {
      return `<span class="lo-admin-badge lo-admin-badge-vencida">Vencida hace ${Math.abs(vig.diasRestantes)} d</span>`;
    }
    if (vig.porVencer) {
      return `<span class="lo-admin-badge lo-admin-badge-por-vencer">Vence en ${vig.diasRestantes} d</span>`;
    }
    return `<span class="lo-admin-badge lo-admin-badge-vigente">Vigente</span>`;
  }

  /** Sección de solo lectura con las pólizas REALES del cliente (services/polizas.service.js)
   *  — distinta del campo `polizas` (texto libre) del perfil, que es autoreportado. */
  function polizasSectionHtml(polizas) {
    if (!polizas.length) {
      return `
        <h3 class="lo-admin-client-history-title">📋 Pólizas registradas (0)</h3>
        <p class="lo-admin-hint" style="margin:0 20px 16px">
          No se encontró ninguna póliza de este cliente en el sistema de pólizas.
        </p>
      `;
    }
    const rowsHtml = polizas
      .map(
        (p) => `
          <tr>
            <td>${escapeHtml(p.numero)}</td>
            <td>${escapeHtml(POLIZA_RAMO_LABELS[p.ramo] || p.ramo)}</td>
            <td>${polizaVigenciaBadge(p.vigencia)}</td>
            <td>${escapeHtml(String(p.prima_anual))} ${escapeHtml(p.moneda || "")}</td>
            <td>${escapeHtml(String(p.suma_asegurada))} ${escapeHtml(p.moneda || "")}</td>
            <td>${escapeHtml(p.corredor || "—")}</td>
            <td>${p.siniestros_activos > 0 ? `<span class="lo-admin-badge lo-admin-badge-advisor-yes">${p.siniestros_activos}</span>` : "—"}</td>
          </tr>
        `
      )
      .join("");

    return `
      <h3 class="lo-admin-client-history-title">📋 Pólizas registradas (${polizas.length})</h3>
      <div class="lo-admin-table-scroll">
        <table class="lo-admin-table">
          <thead>
            <tr>
              <th>Número</th>
              <th>Ramo</th>
              <th>Vigencia</th>
              <th>Prima anual</th>
              <th>Suma asegurada</th>
              <th>Corredor</th>
              <th>Siniestros activos</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function renderClientDetail(cliente, conversaciones, polizas) {
    qs("lo-client-modal-title").textContent = cliente.nombre || cliente.cedula;
    qs("lo-client-modal-meta").textContent = `${cliente.cedula} · Cliente desde ${formatDateTime(cliente.clienteDesde)}`;

    const temasHtml = (cliente.historialTemas || []).length
      ? cliente.historialTemas.map((t) => `<span class="lo-admin-badge lo-admin-badge-ramo">${escapeHtml(t)}</span>`).join("")
      : '<span class="lo-admin-hint">Sin temas registrados todavía.</span>';

    const conversacionesHtml = conversaciones.length
      ? conversaciones
          .map(
            (c) => `
              <tr data-id="${escapeAttr(c.id)}">
                <td>${channelHtml(c)}</td>
                <td>${escapeHtml(formatDateTime(c.startedAt))}</td>
                <td>${c.messageCount}</td>
                <td class="lo-admin-cell-preview" title="${escapeAttr(c.preview || "")}">${escapeHtml(c.preview || "—")}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="4" class="lo-admin-empty">Sin conversaciones vinculadas todavía.</td></tr>`;

    qs("lo-client-modal-body").innerHTML = `
      <div class="lo-admin-client-profile">
        <div class="lo-admin-client-field-row">
          <label class="lo-quote-field">
            <span>Nombre completo</span>
            <input type="text" id="lo-client-field-nombre" value="${escapeAttr(cliente.nombre || "")}" maxlength="200" />
          </label>
          <label class="lo-quote-field">
            <span>Teléfono</span>
            <input type="text" id="lo-client-field-telefono" value="${escapeAttr(cliente.telefono || "")}" maxlength="30" />
          </label>
        </div>
        <div class="lo-admin-client-field-row">
          <label class="lo-quote-field">
            <span>Correo electrónico</span>
            <input type="email" id="lo-client-field-email" value="${escapeAttr(cliente.email || "")}" maxlength="200" />
          </label>
          <label class="lo-quote-field">
            <span>Próxima renovación</span>
            <input
              type="text"
              id="lo-client-field-renovacion"
              value="${escapeAttr(cliente.proximaRenovacion || "")}"
              placeholder="ej. 2026-10-15"
              maxlength="40"
            />
          </label>
        </div>

        <div class="lo-admin-client-field-row">
          <label class="lo-quote-checkbox">
            <input type="checkbox" id="lo-client-field-vip" ${cliente.vip ? "checked" : ""} />
            <span>⭐ Cliente VIP (Lucy le da atención prioritaria en el tono)</span>
          </label>
          <label class="lo-quote-checkbox">
            <input type="checkbox" id="lo-client-field-audio" ${cliente.preferenciaAudio ? "checked" : ""} />
            <span>🔊 Prefiere respuestas en audio</span>
          </label>
          <label class="lo-quote-checkbox">
            <input type="checkbox" id="lo-client-field-siniestro" ${cliente.casoAbiertoSiniestro ? "checked" : ""} />
            <span>🚨 Caso de siniestro abierto</span>
          </label>
        </div>

        <label class="lo-quote-field">
          <span>Pólizas registradas (separadas por coma)</span>
          <input type="text" id="lo-client-field-polizas" value="${escapeAttr((cliente.polizas || []).join(", "))}" />
        </label>

        <div class="lo-admin-client-field-row">
          <span class="lo-admin-hint">Canal preferido: ${escapeHtml(CANAL_LABELS[cliente.canalPreferido] || cliente.canalPreferido || "—")} · Idioma: ${escapeHtml(cliente.idiomaPreferido || "—")}</span>
        </div>

        <div class="lo-admin-hint">Temas de interés (automático, no editable): ${temasHtml}</div>

        <label class="lo-quote-field">
          <span>Notas internas del equipo (nunca se le muestran al cliente)</span>
          <textarea id="lo-client-field-notas" rows="3" maxlength="2000">${escapeHtml(cliente.notasInternas || "")}</textarea>
        </label>

        <div class="lo-admin-card-save">
          <p class="lo-quoter-save-status" id="lo-client-save-status" hidden></p>
          <button type="button" class="lo-admin-btn-primary" id="lo-client-save-btn">💾 Guardar cambios</button>
        </div>
      </div>

      ${polizasSectionHtml(polizas || [])}

      <h3 class="lo-admin-client-history-title">💬 Conversaciones vinculadas (${conversaciones.length})</h3>
      <div class="lo-admin-table-scroll">
        <table class="lo-admin-table">
          <thead>
            <tr>
              <th>Canal</th>
              <th>Fecha de inicio</th>
              <th>Mensajes</th>
              <th>Vista previa</th>
            </tr>
          </thead>
          <tbody>${conversacionesHtml}</tbody>
        </table>
      </div>
    `;

    qs("lo-client-save-btn").addEventListener("click", () => saveClientProfile(cliente.cedula));
    document.querySelectorAll("#lo-client-modal-body tbody tr[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        closeClientModal();
        openDetail(row.getAttribute("data-id"));
      });
    });
  }

  async function saveClientProfile(cedula) {
    const btn = qs("lo-client-save-btn");
    const statusEl = qs("lo-client-save-status");
    btn.disabled = true;
    statusEl.hidden = true;

    const polizas = qs("lo-client-field-polizas")
      .value.split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const patch = {
      nombre: qs("lo-client-field-nombre").value.trim(),
      telefono: qs("lo-client-field-telefono").value.trim(),
      email: qs("lo-client-field-email").value.trim(),
      proximaRenovacion: qs("lo-client-field-renovacion").value.trim(),
      vip: qs("lo-client-field-vip").checked,
      preferenciaAudio: qs("lo-client-field-audio").checked,
      casoAbiertoSiniestro: qs("lo-client-field-siniestro").checked,
      notasInternas: qs("lo-client-field-notas").value,
      polizas,
    };

    try {
      const res = await apiFetch(`/api/admin/clientes/${encodeURIComponent(cedula)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudo guardar el perfil.");

      statusEl.textContent = "✓ Cambios guardados correctamente.";
      statusEl.className = "lo-quoter-save-status lo-status-ok";
      statusEl.hidden = false;
      loadClientes(); // refresca la tabla en segundo plano (VIP, nombre, etc. pueden haber cambiado)
    } catch (err) {
      statusEl.textContent = err.message || "Error al guardar.";
      statusEl.className = "lo-quoter-save-status lo-status-error";
      statusEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  function closeClientModal() {
    qs("lo-client-modal").hidden = true;
    currentClienteCedula = null;
  }

  // -------------------------------------------------------------------------
  // Siniestros (services/siniestros.service.js) — lista, filtros, y detalle editable
  // -------------------------------------------------------------------------

  const SINIESTRO_ESTADO_LABELS = {
    recibido: "Recibido",
    pendiente_documentacion: "Pendiente de documentación",
    en_investigacion: "En investigación",
    aprobado: "Aprobado",
    rechazado: "Rechazado",
    por_pagar: "Por pagar",
    pagado: "Pagado",
  };

  const SINIESTRO_TIPO_LABELS = {
    accidente: "Accidente de tránsito",
    colision: "Accidente de tránsito",
    robo: "Robo",
    incendio: "Incendio",
    hospitalizacion: "Hospitalización (HCM)",
  };

  const SINIESTRO_DOC_LABELS = {
    fotos_dano: "Fotos del daño",
    denuncia_policial: "Denuncia policial",
    croquis: "Croquis del accidente",
    presupuesto_taller: "Presupuesto del taller",
    inventario_bienes: "Inventario de bienes",
    informe_bomberos: "Informe de bomberos",
    presupuesto_reparacion: "Presupuesto de reparación",
    diagnostico_medico: "Diagnóstico médico",
    facturas: "Facturas",
    orden_hospitalizacion: "Orden de hospitalización",
  };

  function siniestroBadgeHtml(s) {
    const cls = `lo-admin-badge lo-admin-badge-siniestro-${s.estado}`;
    const label = SINIESTRO_ESTADO_LABELS[s.estado] || s.estado;
    return `<span class="${cls}">${escapeHtml(label)}</span>`;
  }

  async function loadSiniestros() {
    qs("lo-siniestros-loading").hidden = false;
    qs("lo-siniestros-empty").hidden = true;
    try {
      const params = new URLSearchParams();
      const estado = qs("lo-siniestros-filter-estado").value;
      const mayor = qs("lo-siniestros-filter-mayor").value;
      if (estado) params.set("estado", estado);
      if (mayor === "si") params.set("mayor", "1");
      const qsStr = params.toString();
      const res = await apiFetch(`/api/admin/siniestros${qsStr ? `?${qsStr}` : ""}`);
      if (!res.ok) throw new Error("No se pudo cargar la lista de siniestros.");
      const data = await res.json();
      state.siniestros = data.siniestros || [];
      applySiniestrosFilter();
    } catch (err) {
      qs("lo-siniestros-table-body").innerHTML = "";
      qs("lo-siniestros-empty").hidden = false;
      qs("lo-siniestros-empty").textContent = err.message || "Error al cargar los siniestros.";
    } finally {
      qs("lo-siniestros-loading").hidden = true;
    }
  }

  function applySiniestrosFilter() {
    const term = normalizeSearch(qs("lo-siniestros-search").value);
    state.siniestrosFiltered = !term
      ? state.siniestros
      : state.siniestros.filter((s) =>
          [s.numero, s.cedula_titular, s.clienteNombre].some((f) => normalizeSearch(f).includes(term))
        );
    renderSiniestrosTable();
  }

  function renderSiniestrosTable() {
    const tbody = qs("lo-siniestros-table-body");
    const emptyEl = qs("lo-siniestros-empty");

    if (state.siniestrosFiltered.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent =
        state.siniestros.length === 0
          ? "Todavía no hay siniestros registrados — aparecerán aquí en cuanto Lucy abra uno en el chat."
          : "No hay siniestros que coincidan con la búsqueda o los filtros.";
      return;
    }
    emptyEl.hidden = true;

    tbody.innerHTML = state.siniestrosFiltered
      .map((s) => {
        const mayorHtml = s.siniestro_mayor ? '<span class="lo-admin-badge lo-admin-badge-mayor">🚨 Mayor</span>' : "";
        return `
          <tr data-numero="${escapeAttr(s.numero)}">
            <td>${escapeHtml(s.numero)}</td>
            <td>${escapeHtml(s.clienteNombre || s.cedula_titular || "—")}</td>
            <td>${escapeHtml(SINIESTRO_TIPO_LABELS[s.tipo] || s.tipo)}</td>
            <td>${siniestroBadgeHtml(s)}</td>
            <td>$${escapeHtml(String(s.monto_reclamado))}</td>
            <td>${escapeHtml(s.ajustador_asignado || "—")}</td>
            <td>${escapeHtml(formatDateTime(s.fecha_reporte))}</td>
            <td>${mayorHtml}</td>
          </tr>
        `;
      })
      .join("");

    Array.from(tbody.querySelectorAll("tr")).forEach((row) => {
      row.addEventListener("click", () => openSiniestroDetail(row.getAttribute("data-numero")));
    });
  }

  let currentSiniestroNumero = null;

  async function openSiniestroDetail(numero) {
    const modal = qs("lo-siniestro-modal");
    const body = qs("lo-siniestro-modal-body");
    const meta = qs("lo-siniestro-modal-meta");

    currentSiniestroNumero = numero;
    modal.hidden = false;
    body.innerHTML = '<div class="lo-admin-loading">Cargando siniestro…</div>';
    meta.textContent = "";

    try {
      const res = await apiFetch(`/api/admin/siniestros/${encodeURIComponent(numero)}`);
      if (!res.ok) throw new Error("No se pudo cargar el siniestro.");
      const data = await res.json();
      renderSiniestroDetail(data.siniestro);
    } catch (err) {
      body.innerHTML = `<div class="lo-admin-empty">${escapeHtml(err.message || "Error al cargar el siniestro.")}</div>`;
    }
  }

  function renderSiniestroDetail(s) {
    qs("lo-siniestro-modal-title").textContent = s.numero;
    qs("lo-siniestro-modal-meta").textContent =
      `${s.clienteNombre || s.cedula_titular || "—"} · Póliza ${s.poliza || "—"} · Reportado ${formatDateTime(s.fecha_reporte)}` +
      (s.siniestro_mayor ? " · 🚨 Siniestro mayor" : "");

    const estadoOptionsHtml = Object.entries(SINIESTRO_ESTADO_LABELS)
      .map(([value, label]) => `<option value="${value}" ${s.estado === value ? "selected" : ""}>${escapeHtml(label)}</option>`)
      .join("");

    // El checklist de documentos se arma con la UNIÓN de recibidos + pendientes (es la
    // lista completa que le pidió Lucy según el tipo, ver DOCUMENTOS_POR_TIPO en
    // services/siniestros.service.js) — marcar/desmarcar mueve el documento entre
    // ambas listas al guardar.
    const recibidosSet = new Set(s.documentos_recibidos || []);
    const todosLosDocs = [...new Set([...(s.documentos_recibidos || []), ...(s.documentos_pendientes || [])])];
    const documentosHtml = todosLosDocs.length
      ? todosLosDocs
          .map(
            (d) => `
              <label class="lo-quote-checkbox">
                <input type="checkbox" class="lo-siniestro-doc-check" value="${escapeAttr(d)}" ${recibidosSet.has(d) ? "checked" : ""} />
                <span>${escapeHtml(SINIESTRO_DOC_LABELS[d] || d)}</span>
              </label>
            `
          )
          .join("")
      : '<p class="lo-admin-hint">Este tipo de siniestro no requiere documentos.</p>';

    const comentariosHtml = (s.comentarios || []).length
      ? s.comentarios
          .map(
            (c) => `
              <div class="lo-admin-hint" style="margin-bottom:6px">
                <strong>${escapeHtml(formatDateTime(c.fecha))} — ${escapeHtml(c.autor || "—")}:</strong> ${escapeHtml(c.texto)}
              </div>
            `
          )
          .join("")
      : '<p class="lo-admin-hint">Sin comentarios todavía.</p>';

    qs("lo-siniestro-modal-body").innerHTML = `
      <div class="lo-admin-client-profile">
        <div class="lo-admin-hint">
          <strong>Tipo:</strong> ${escapeHtml(SINIESTRO_TIPO_LABELS[s.tipo] || s.tipo)} ·
          <strong>Ocurrió:</strong> ${escapeHtml(s.fecha_ocurrencia || "—")} ·
          <strong>Ubicación:</strong> ${escapeHtml(s.ubicacion || "—")}
        </div>
        <div class="lo-admin-hint" style="margin-top:6px">
          <strong>Descripción:</strong> ${escapeHtml(s.descripcion || "—")}
        </div>

        <div class="lo-admin-client-field-row" style="margin-top:14px">
          <label class="lo-quote-field">
            <span>Estado</span>
            <select id="lo-siniestro-field-estado">${estadoOptionsHtml}</select>
          </label>
          <label class="lo-quote-field">
            <span>Ajustador asignado</span>
            <input type="text" id="lo-siniestro-field-ajustador" value="${escapeAttr(s.ajustador_asignado || "")}" maxlength="100" />
          </label>
        </div>
        <div class="lo-admin-client-field-row">
          <label class="lo-quote-field">
            <span>Monto reclamado</span>
            <input type="text" value="$${escapeAttr(String(s.monto_reclamado))}" disabled />
          </label>
          <label class="lo-quote-field">
            <span>Monto aprobado</span>
            <input type="number" id="lo-siniestro-field-monto-aprobado" value="${s.monto_aprobado != null ? escapeAttr(String(s.monto_aprobado)) : ""}" min="0" step="0.01" placeholder="Sin definir" />
          </label>
        </div>
        <label class="lo-quote-field">
          <span>Fecha estimada de resolución</span>
          <input type="text" id="lo-siniestro-field-fecha" value="${escapeAttr(s.fecha_estimada_resolucion || "")}" placeholder="AAAA-MM-DD" maxlength="20" />
        </label>

        <div class="lo-admin-hint" style="margin-top:10px"><strong>📎 Documentos</strong></div>
        <div id="lo-siniestro-docs">${documentosHtml}</div>

        <div class="lo-admin-hint" style="margin-top:10px"><strong>💬 Comentarios</strong></div>
        <div id="lo-siniestro-comentarios">${comentariosHtml}</div>
        <label class="lo-quote-field">
          <span>Agregar comentario</span>
          <textarea id="lo-siniestro-field-comentario" rows="2" maxlength="500"></textarea>
        </label>

        <div class="lo-admin-card-save">
          <p class="lo-quoter-save-status" id="lo-siniestro-save-status" hidden></p>
          <button type="button" class="lo-admin-btn-primary" id="lo-siniestro-save-btn">💾 Guardar cambios</button>
        </div>
      </div>
    `;

    qs("lo-siniestro-save-btn").addEventListener("click", () => saveSiniestro(s.numero));
  }

  async function saveSiniestro(numero) {
    const btn = qs("lo-siniestro-save-btn");
    const statusEl = qs("lo-siniestro-save-status");
    btn.disabled = true;
    statusEl.hidden = true;

    const documentosRecibidos = Array.from(document.querySelectorAll(".lo-siniestro-doc-check"))
      .filter((el) => el.checked)
      .map((el) => el.value);
    const documentosPendientes = Array.from(document.querySelectorAll(".lo-siniestro-doc-check"))
      .filter((el) => !el.checked)
      .map((el) => el.value);

    const montoAprobadoRaw = qs("lo-siniestro-field-monto-aprobado").value;
    const patch = {
      estado: qs("lo-siniestro-field-estado").value,
      ajustador_asignado: qs("lo-siniestro-field-ajustador").value.trim(),
      monto_aprobado: montoAprobadoRaw === "" ? null : Number(montoAprobadoRaw),
      fecha_estimada_resolucion: qs("lo-siniestro-field-fecha").value.trim(),
      documentos_recibidos: documentosRecibidos,
      documentos_pendientes: documentosPendientes,
    };
    const nuevoComentario = qs("lo-siniestro-field-comentario").value.trim();
    if (nuevoComentario) patch.nuevoComentario = nuevoComentario;

    try {
      const res = await apiFetch(`/api/admin/siniestros/${encodeURIComponent(numero)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudo guardar el siniestro.");

      statusEl.textContent = "✓ Cambios guardados correctamente.";
      statusEl.className = "lo-quoter-save-status lo-status-ok";
      statusEl.hidden = false;
      renderSiniestroDetail(data.siniestro);
      loadSiniestros(); // refresca la tabla en segundo plano (estado, ajustador, etc.)
    } catch (err) {
      statusEl.textContent = err.message || "Error al guardar.";
      statusEl.className = "lo-quoter-save-status lo-status-error";
      statusEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  function closeSiniestroModal() {
    qs("lo-siniestro-modal").hidden = true;
    currentSiniestroNumero = null;
  }

  // -------------------------------------------------------------------------
  // Emisiones (solicitudes del portal de corredores) — lista, filtros, y
  // aprobar/rechazar con notificación en tiempo real al corredor.
  // -------------------------------------------------------------------------

  const EMISION_ESTADO_LABELS = {
    pendiente_aprobacion: "Pendiente de aprobación",
    aprobada: "Aprobada",
    rechazada: "Rechazada",
  };

  // Vocabulario propio del formulario de emisión del portal de corredores (ver
  // co-emision-ramo en corredor.html) — distinto de RAMO_LABELS_FALLBACK (que es el
  // vocabulario de detección de ramo en las conversaciones del chat).
  const EMISION_RAMO_LABELS = {
    automoviles: "Automóviles",
    autos: "Automóviles",
    hcm: "HCM",
    personas: "Personas",
    patrimonial: "Patrimonial",
    patrimoniales: "Patrimoniales",
    fianza: "Fianza",
    fianzas: "Fianzas",
  };

  function emisionBadgeHtml(estado) {
    const cls = estado === "aprobada" ? "lo-admin-badge-vigente" : estado === "rechazada" ? "lo-admin-badge-vencida" : "lo-admin-badge-por-vencer";
    return `<span class="lo-admin-badge ${cls}">${escapeHtml(EMISION_ESTADO_LABELS[estado] || estado)}</span>`;
  }

  async function loadEmisiones() {
    qs("lo-emisiones-loading").hidden = false;
    qs("lo-emisiones-empty").hidden = true;
    try {
      const res = await apiFetch("/api/admin/emisiones");
      if (!res.ok) throw new Error("No se pudo cargar la lista de solicitudes.");
      const data = await res.json();
      state.emisiones = data.emisiones || [];
      applyEmisionesFilter();
    } catch (err) {
      qs("lo-emisiones-table-body").innerHTML = "";
      qs("lo-emisiones-empty").hidden = false;
      qs("lo-emisiones-empty").textContent = err.message || "Error al cargar las solicitudes.";
    } finally {
      qs("lo-emisiones-loading").hidden = true;
    }
  }

  function applyEmisionesFilter() {
    const term = normalizeSearch(qs("lo-emisiones-search").value);
    const estado = qs("lo-emisiones-filter-estado").value;
    state.emisionesFiltered = state.emisiones.filter((e) => {
      const matchesTerm = !term || [e.id, e.cliente.nombre, e.cliente.cedula, e.corredorNombre].some((f) => normalizeSearch(f).includes(term));
      const matchesEstado = !estado || e.estado === estado;
      return matchesTerm && matchesEstado;
    });
    renderEmisionesTable();
  }

  function renderEmisionesTable() {
    const tbody = qs("lo-emisiones-table-body");
    const emptyEl = qs("lo-emisiones-empty");

    if (state.emisionesFiltered.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent =
        state.emisiones.length === 0
          ? "Todavía no hay solicitudes de emisión — aparecerán aquí en cuanto un corredor envíe una desde su portal."
          : "No hay solicitudes que coincidan con la búsqueda o los filtros.";
      return;
    }
    emptyEl.hidden = true;

    tbody.innerHTML = state.emisionesFiltered
      .map(
        (e) => `
          <tr data-id="${escapeAttr(e.id)}">
            <td>${escapeHtml(e.id)}</td>
            <td>${escapeHtml(e.corredorNombre)}</td>
            <td>${escapeHtml(e.cliente.nombre)} (${escapeHtml(e.cliente.cedula)})</td>
            <td>${escapeHtml(EMISION_RAMO_LABELS[e.ramo] || e.ramo)}</td>
            <td>${emisionBadgeHtml(e.estado)}</td>
            <td>${escapeHtml(formatDateTime(e.creadoEn))}</td>
          </tr>
        `
      )
      .join("");

    Array.from(tbody.querySelectorAll("tr")).forEach((row) => {
      row.addEventListener("click", () => openEmisionDetail(row.getAttribute("data-id")));
    });
  }

  let currentEmisionId = null;

  async function openEmisionDetail(id) {
    const modal = qs("lo-emision-modal");
    const body = qs("lo-emision-modal-body");
    currentEmisionId = id;
    modal.hidden = false;
    body.innerHTML = '<div class="lo-admin-loading">Cargando solicitud…</div>';

    const emision = state.emisiones.find((e) => e.id === id);
    if (!emision) {
      body.innerHTML = '<div class="lo-admin-empty">Solicitud no encontrada.</div>';
      return;
    }
    renderEmisionDetail(emision);
  }

  function renderEmisionDetail(e) {
    qs("lo-emision-modal-title").textContent = e.id;
    qs("lo-emision-modal-meta").textContent = `Corredor: ${e.corredorNombre} · Enviada ${formatDateTime(e.creadoEn)}`;

    const detalleHtml = e.detalle && e.detalle.notas ? `<p class="lo-admin-hint">${escapeHtml(e.detalle.notas)}</p>` : "";
    const puedeResolver = e.estado === "pendiente_aprobacion";

    qs("lo-emision-modal-body").innerHTML = `
      <div class="lo-admin-client-profile">
        <div class="lo-admin-hint">
          <strong>Cliente:</strong> ${escapeHtml(e.cliente.nombre)} (${escapeHtml(e.cliente.cedula)})
          ${e.cliente.telefono ? ` · ${escapeHtml(e.cliente.telefono)}` : ""}
        </div>
        <div class="lo-admin-hint" style="margin-top:4px">
          <strong>Ramo:</strong> ${escapeHtml(EMISION_RAMO_LABELS[e.ramo] || e.ramo)} ·
          <strong>Estado:</strong> ${emisionBadgeHtml(e.estado)}
        </div>
        ${detalleHtml}
        ${e.notasAdmin ? `<p class="lo-admin-hint"><strong>Notas internas:</strong> ${escapeHtml(e.notasAdmin)}</p>` : ""}

        <label class="lo-quote-field">
          <span>Notas internas (opcional)</span>
          <textarea id="lo-emision-field-notas" rows="2" maxlength="1000">${escapeHtml(e.notasAdmin || "")}</textarea>
        </label>

        <p class="lo-quoter-save-status" id="lo-emision-save-status" hidden></p>
        <div class="lo-admin-card-save">
          ${
            puedeResolver
              ? `
                <button type="button" class="lo-admin-btn-ghost" id="lo-emision-rechazar-btn">❌ Rechazar</button>
                <button type="button" class="lo-admin-btn-primary" id="lo-emision-aprobar-btn">✅ Aprobar</button>
              `
              : `<span class="lo-admin-hint">Esta solicitud ya fue resuelta (${emisionBadgeHtml(e.estado)}) — puedes actualizar las notas internas igual.</span>
                 <button type="button" class="lo-admin-btn-primary" id="lo-emision-notas-btn">💾 Guardar notas</button>`
          }
        </div>
      </div>
    `;

    if (puedeResolver) {
      qs("lo-emision-aprobar-btn").addEventListener("click", () => resolverEmision(e.id, "aprobada"));
      qs("lo-emision-rechazar-btn").addEventListener("click", () => resolverEmision(e.id, "rechazada"));
    } else {
      qs("lo-emision-notas-btn").addEventListener("click", () => resolverEmision(e.id, e.estado));
    }
  }

  async function resolverEmision(id, estado) {
    const statusEl = qs("lo-emision-save-status");
    statusEl.hidden = true;
    try {
      const res = await apiFetch(`/api/admin/emisiones/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estado, notasAdmin: qs("lo-emision-field-notas").value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudo actualizar la solicitud.");

      statusEl.textContent = "✓ Cambios guardados correctamente.";
      statusEl.className = "lo-quoter-save-status lo-status-ok";
      statusEl.hidden = false;
      const idx = state.emisiones.findIndex((em) => em.id === id);
      if (idx !== -1) state.emisiones[idx] = data.emision;
      renderEmisionDetail(data.emision);
      applyEmisionesFilter();
    } catch (err) {
      statusEl.textContent = err.message || "Error al guardar.";
      statusEl.className = "lo-quoter-save-status lo-status-error";
      statusEl.hidden = false;
    }
  }

  function closeEmisionModal() {
    qs("lo-emision-modal").hidden = true;
    currentEmisionId = null;
  }

  // -------------------------------------------------------------------------
  // Gaps de conocimiento ("❓ Preguntas sin respuesta") — se registran solos (ver
  // registrarGapConocimiento en server.js); aquí solo se listan y se marcan revisados.
  // -------------------------------------------------------------------------

  async function loadGaps() {
    qs("lo-gaps-loading").hidden = false;
    qs("lo-gaps-empty").hidden = true;
    try {
      const res = await apiFetch("/api/admin/gaps");
      if (!res.ok) throw new Error("No se pudo cargar la lista de preguntas sin respuesta.");
      const data = await res.json();
      state.gaps = data.gaps || [];
      applyGapsFilter();
    } catch (err) {
      qs("lo-gaps-table-body").innerHTML = "";
      qs("lo-gaps-empty").hidden = false;
      qs("lo-gaps-empty").textContent = err.message || "Error al cargar las preguntas sin respuesta.";
    } finally {
      qs("lo-gaps-loading").hidden = true;
    }
  }

  function applyGapsFilter() {
    const term = normalizeSearch(qs("lo-gaps-search").value);
    const estado = qs("lo-gaps-filter-estado").value;
    state.gapsFiltered = state.gaps.filter((g) => {
      const matchesTerm = !term || [g.pregunta, g.respuestaLucy].some((f) => normalizeSearch(f).includes(term));
      const matchesEstado = !estado || (estado === "resuelto" ? g.resuelto : !g.resuelto);
      return matchesTerm && matchesEstado;
    });
    renderGapsTable();
  }

  function renderGapsTable() {
    const tbody = qs("lo-gaps-table-body");
    const emptyEl = qs("lo-gaps-empty");

    if (state.gapsFiltered.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.textContent =
        state.gaps.length === 0
          ? "No hay preguntas sin respuesta registradas todavía — buena señal. 🎉"
          : "No hay resultados que coincidan con la búsqueda o los filtros.";
      return;
    }
    emptyEl.hidden = true;

    tbody.innerHTML = state.gapsFiltered
      .map(
        (g) => `
          <tr data-id="${escapeAttr(g.id)}">
            <td>${escapeHtml(formatDateTime(g.fecha))}</td>
            <td>${g.canal === "whatsapp" ? "WhatsApp" : "💬 Web"}</td>
            <td class="lo-admin-cell-preview" title="${escapeAttr(g.pregunta)}">${escapeHtml(g.pregunta || "—")}</td>
            <td class="lo-admin-cell-preview" title="${escapeAttr(g.respuestaLucy)}">${escapeHtml(g.respuestaLucy || "—")}</td>
            <td class="lo-admin-cell-preview" title="${escapeAttr(g.disparador)}">${escapeHtml(g.disparador || "—")}</td>
            <td>${g.resuelto ? '<span class="lo-admin-badge lo-admin-badge-vigente">Revisada</span>' : '<span class="lo-admin-badge lo-admin-badge-por-vencer">Pendiente</span>'}</td>
          </tr>
        `
      )
      .join("");

    Array.from(tbody.querySelectorAll("tr")).forEach((row) => {
      row.addEventListener("click", () => openGapDetail(row.getAttribute("data-id")));
    });
  }

  let currentGapId = null;

  function openGapDetail(id) {
    const gap = state.gaps.find((g) => g.id === id);
    if (!gap) return;
    currentGapId = id;
    qs("lo-gap-modal").hidden = false;
    qs("lo-gap-modal-meta").textContent = `${formatDateTime(gap.fecha)} · ${gap.canal === "whatsapp" ? "WhatsApp" : "Chat web"}`;
    qs("lo-gap-modal-body").innerHTML = `
      <div class="lo-admin-client-profile">
        <div class="lo-admin-hint"><strong>Pregunta del usuario:</strong></div>
        <p>${escapeHtml(gap.pregunta || "—")}</p>
        <div class="lo-admin-hint"><strong>Respuesta de Lucy:</strong></div>
        <p>${escapeHtml(gap.respuestaLucy || "—")}</p>
        <div class="lo-admin-hint"><strong>Lo que disparó el registro:</strong> ${escapeHtml(gap.disparador || "—")}</div>

        <label class="lo-quote-field">
          <span>Notas del equipo</span>
          <textarea id="lo-gap-field-notas" rows="3" maxlength="1000">${escapeHtml(gap.notas || "")}</textarea>
        </label>
        <label class="lo-quote-checkbox">
          <input type="checkbox" id="lo-gap-field-resuelto" ${gap.resuelto ? "checked" : ""} />
          <span>Ya revisado por el equipo</span>
        </label>

        <p class="lo-quoter-save-status" id="lo-gap-save-status" hidden></p>
        <div class="lo-admin-card-save">
          <button type="button" class="lo-admin-btn-primary" id="lo-gap-save-btn">💾 Guardar</button>
        </div>
      </div>
    `;
    qs("lo-gap-save-btn").addEventListener("click", () => saveGap(id));
  }

  async function saveGap(id) {
    const statusEl = qs("lo-gap-save-status");
    statusEl.hidden = true;
    try {
      const res = await apiFetch(`/api/admin/gaps/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resuelto: qs("lo-gap-field-resuelto").checked,
          notas: qs("lo-gap-field-notas").value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudo guardar.");
      const idx = state.gaps.findIndex((g) => g.id === id);
      if (idx !== -1) state.gaps[idx] = data.gap;
      statusEl.textContent = "✓ Guardado correctamente.";
      statusEl.className = "lo-quoter-save-status lo-status-ok";
      statusEl.hidden = false;
      applyGapsFilter();
    } catch (err) {
      statusEl.textContent = err.message || "Error al guardar.";
      statusEl.className = "lo-quoter-save-status lo-status-error";
      statusEl.hidden = false;
    }
  }

  function closeGapModal() {
    qs("lo-gap-modal").hidden = true;
    currentGapId = null;
  }

  // -------------------------------------------------------------------------
  // Configuración del cotizador (no-code) — tarifas RCV, tasas HCM, tipos de
  // bien patrimoniales y textos, editables sin tocar código.
  // -------------------------------------------------------------------------

  /** Config tal como llegó del servidor — se usa como base para preservar campos
   *  que esta pantalla no expone (p. ej. placaOptions/usoOptions de RCV). */
  let quoterLoadedConfig = {};

  async function loadAndRenderQuoterConfig() {
    const loadingEl = qs("lo-quoter-loading");
    const contentEl = qs("lo-quoter-content");
    loadingEl.hidden = false;
    contentEl.hidden = true;

    try {
      const res = await fetch("/api/quote-config", { credentials: "same-origin" });
      if (!res.ok) throw new Error("No se pudo cargar la configuración.");
      const data = await res.json();
      populateQuoterForm(data.config || {});
      loadingEl.hidden = true;
      contentEl.hidden = false;
    } catch (err) {
      loadingEl.textContent = "No se pudo cargar la configuración del cotizador. Intenta actualizar la página.";
      console.error("[Panel admin] Error al cargar quote-config:", err);
    }
  }

  function populateQuoterForm(cfg) {
    quoterLoadedConfig = cfg;
    const general = cfg.general || {};
    const rcv = cfg.rcv || {};
    const hcm = cfg.hcm || {};
    const pat = cfg.patrimoniales || {};

    qs("lo-quoter-intro").value = general.introMessage || "";
    qs("lo-quoter-disclaimer").value = general.disclaimer || "";
    qs("lo-quoter-keywords").value = (general.triggerKeywords || []).join(", ");

    qs("lo-quoter-rcv-enabled").checked = rcv.enabled !== false;
    qs("lo-quoter-rcv-label").value = rcv.label || "";
    qs("lo-quoter-rcv-minyear").value = rcv.minYear || 1990;
    qs("lo-quoter-rcv-currency-label").value = rcv.currencyLabel || "";
    qs("lo-quoter-rcv-rebaja-pct").value = rcv.rebajaSinLucroPct || 0;
    qs("lo-quoter-rcv-currency-note").value = rcv.currencyNote || "";
    qs("lo-quoter-rcv-marcas").value = (rcv.marcasComunes || []).filter((m) => m !== "Otra").join(", ");

    qs("lo-quoter-rcv-tarifas-body").innerHTML = (rcv.tarifas || []).map(rcvTarifaRowHtml).join("");
    qs("lo-quoter-rcv-recargos-body").innerHTML = (rcv.recargos || []).map(rcvRecargoRowHtml).join("");

    qs("lo-quoter-hcm-enabled").checked = hcm.enabled !== false;
    qs("lo-quoter-hcm-label").value = hcm.label || "";
    qs("lo-quoter-hcm-currency-label").value = hcm.currencyLabel || "";
    qs("lo-quoter-hcm-maxage").value = hcm.maxAge || 0;
    qs("lo-quoter-hcm-maxbenef").value = hcm.maxBeneficiarios || 0;

    const sumas = hcm.sumasAseguradas || [];
    qs("lo-quoter-hcm-sumas-body").innerHTML = sumas.map(hcmSumaRowHtml).join("");
    renderHcmRangosHeader(sumas.map((s) => s.label || s.id));
    qs("lo-quoter-hcm-rangos-body").innerHTML = (hcm.rangosEdad || []).map((r) => hcmRangoRowHtml(r, sumas)).join("");

    qs("lo-quoter-pat-enabled").checked = pat.enabled !== false;
    qs("lo-quoter-pat-label").value = pat.label || "";
    qs("lo-quoter-pat-mensaje").value = pat.mensajeEnvio || "";
    qs("lo-quoter-pat-tipos-body").innerHTML = (pat.tiposBien || []).map(patTipoRowHtml).join("");
  }

  function renderHcmRangosHeader(labels) {
    const tr = document.querySelector("#lo-quoter-hcm-rangos-head tr");
    tr.innerHTML =
      "<th>ID</th><th>Etiqueta</th><th>Edad mín.</th><th>Edad máx.</th>" +
      labels.map((l) => `<th>${escapeHtml(l)}</th>`).join("") +
      "<th></th>";
  }

  // --- Plantillas de fila (se usan tanto al cargar datos como al agregar filas vacías) ---

  function rcvTarifaRowHtml(t) {
    t = t || {};
    const nac = t.nacional || {};
    const ext = t.extranjera || {};
    return `<tr>
      <td><input type="text" data-field="id" value="${escapeAttr(t.id || "")}" /></td>
      <td><input type="text" data-field="label" value="${escapeAttr(t.label || "")}" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="aplicaRebajaSinLucro" ${
        t.aplicaRebajaSinLucro ? "checked" : ""
      } /></td>
      <td><input type="number" data-field="nacCosas" value="${nac.cosas ?? ""}" /></td>
      <td><input type="number" data-field="nacPersonas" value="${nac.personas ?? ""}" /></td>
      <td><input type="number" data-field="nacPrima" value="${nac.prima ?? ""}" /></td>
      <td><input type="number" data-field="extCosas" value="${ext.cosas ?? ""}" /></td>
      <td><input type="number" data-field="extPersonas" value="${ext.personas ?? ""}" /></td>
      <td><input type="number" data-field="extPrima" value="${ext.prima ?? ""}" /></td>
      <td><button type="button" class="lo-admin-row-remove" data-action="remove-row" title="Eliminar">🗑</button></td>
    </tr>`;
  }

  function rcvRecargoRowHtml(r) {
    r = r || {};
    return `<tr>
      <td><input type="text" data-field="id" value="${escapeAttr(r.id || "")}" /></td>
      <td><input type="text" data-field="label" value="${escapeAttr(r.label || "")}" /></td>
      <td><input type="number" data-field="pct" value="${r.pct ?? 0}" /></td>
      <td style="text-align:center"><input type="checkbox" data-field="enabled" ${
        r.enabled !== false ? "checked" : ""
      } /></td>
      <td><button type="button" class="lo-admin-row-remove" data-action="remove-row" title="Eliminar">🗑</button></td>
    </tr>`;
  }

  function hcmSumaRowHtml(s) {
    s = s || {};
    return `<tr>
      <td><input type="text" data-field="id" value="${escapeAttr(s.id || "")}" /></td>
      <td><input type="text" data-field="label" value="${escapeAttr(s.label || "")}" /></td>
      <td><input type="number" data-field="value" value="${s.value ?? 0}" /></td>
      <td><button type="button" class="lo-admin-row-remove" data-action="remove-suma" title="Eliminar">🗑</button></td>
    </tr>`;
  }

  function hcmRangoRowHtml(r, sumas) {
    r = r || {};
    const rateCells = (sumas || [])
      .map((s) => {
        const val = r.rates && r.rates[s.id] != null ? r.rates[s.id] : "";
        return `<td><input type="number" data-field="rate" value="${val}" /></td>`;
      })
      .join("");
    return `<tr>
      <td><input type="text" data-field="id" value="${escapeAttr(r.id || "")}" /></td>
      <td><input type="text" data-field="label" value="${escapeAttr(r.label || "")}" /></td>
      <td><input type="number" data-field="min" value="${r.min ?? 0}" /></td>
      <td><input type="number" data-field="max" value="${r.max ?? 0}" /></td>
      ${rateCells}
      <td><button type="button" class="lo-admin-row-remove" data-action="remove-row" title="Eliminar">🗑</button></td>
    </tr>`;
  }

  function hcmRangoBlankRowHtml(sumaCount) {
    const rateCells = Array.from({ length: sumaCount })
      .map(() => `<td><input type="number" data-field="rate" value="" /></td>`)
      .join("");
    return `<tr>
      <td><input type="text" data-field="id" value="" /></td>
      <td><input type="text" data-field="label" value="" /></td>
      <td><input type="number" data-field="min" value="0" /></td>
      <td><input type="number" data-field="max" value="0" /></td>
      ${rateCells}
      <td><button type="button" class="lo-admin-row-remove" data-action="remove-row" title="Eliminar">🗑</button></td>
    </tr>`;
  }

  function patTipoRowHtml(t) {
    t = t || {};
    return `<tr>
      <td><input type="text" data-field="id" value="${escapeAttr(t.id || "")}" /></td>
      <td><input type="text" data-field="label" value="${escapeAttr(t.label || "")}" /></td>
      <td><button type="button" class="lo-admin-row-remove" data-action="remove-row" title="Eliminar">🗑</button></td>
    </tr>`;
  }

  // --- Cableado: agregar/eliminar filas ---

  /** Tabla simple (sin dependencias cruzadas): eliminar fila y agregar fila vacía. */
  function wireSimpleTable(tbodyId, addBtnId, blankRowHtmlFn) {
    const tbody = qs(tbodyId);
    tbody.addEventListener("click", (event) => {
      if (event.target.dataset.action === "remove-row") {
        event.target.closest("tr").remove();
      }
    });
    const addBtn = qs(addBtnId);
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        tbody.insertAdjacentHTML("beforeend", blankRowHtmlFn());
      });
    }
  }

  /** HCM: las sumas aseguradas son columnas de la tabla de rangos de edad — hay que
   *  mantener ambas tablas en sincronía al agregar/quitar una suma asegurada. */
  function wireHcmTables() {
    const sumasBody = qs("lo-quoter-hcm-sumas-body");
    const rangosBody = qs("lo-quoter-hcm-rangos-body");
    const rangosHeadRow = document.querySelector("#lo-quoter-hcm-rangos-head tr");

    // Editar la etiqueta de una suma actualiza en vivo el encabezado de su columna.
    sumasBody.addEventListener("input", (event) => {
      if (event.target.dataset.field !== "label") return;
      const tr = event.target.closest("tr");
      const colIndex = Array.from(sumasBody.children).indexOf(tr);
      const th = rangosHeadRow.children[4 + colIndex];
      if (th) th.textContent = event.target.value || `Suma ${colIndex + 1}`;
    });

    sumasBody.addEventListener("click", (event) => {
      if (event.target.dataset.action !== "remove-suma") return;
      const tr = event.target.closest("tr");
      const colIndex = Array.from(sumasBody.children).indexOf(tr);
      tr.remove();

      const th = rangosHeadRow.children[4 + colIndex];
      if (th) th.remove();
      Array.from(rangosBody.children).forEach((rowEl) => {
        const cell = rowEl.children[4 + colIndex];
        if (cell) cell.remove();
      });
    });

    qs("lo-quoter-hcm-suma-add").addEventListener("click", () => {
      sumasBody.insertAdjacentHTML("beforeend", hcmSumaRowHtml());

      const emptyTh = rangosHeadRow.lastElementChild;
      const newTh = document.createElement("th");
      newTh.textContent = "Nueva suma";
      rangosHeadRow.insertBefore(newTh, emptyTh);

      Array.from(rangosBody.children).forEach((rowEl) => {
        const removeCell = rowEl.lastElementChild;
        const td = document.createElement("td");
        td.innerHTML = '<input type="number" data-field="rate" value="" />';
        rowEl.insertBefore(td, removeCell);
      });
    });

    rangosBody.addEventListener("click", (event) => {
      if (event.target.dataset.action === "remove-row") {
        event.target.closest("tr").remove();
      }
    });

    qs("lo-quoter-hcm-rango-add").addEventListener("click", () => {
      rangosBody.insertAdjacentHTML("beforeend", hcmRangoBlankRowHtml(sumasBody.children.length));
    });
  }

  // --- Lectura del formulario al guardar ---

  function collectSimpleRows(tbodyId, fields) {
    return Array.from(document.querySelectorAll(`#${tbodyId} tr`)).map((tr) => {
      const obj = {};
      fields.forEach(([field, type]) => {
        const input = tr.querySelector(`[data-field="${field}"]`);
        if (!input) return;
        if (type === "checkbox") obj[field] = input.checked;
        else if (type === "number") obj[field] = Number(input.value) || 0;
        else obj[field] = input.value.trim();
      });
      return obj;
    });
  }

  function collectRcvTarifas() {
    return Array.from(document.querySelectorAll("#lo-quoter-rcv-tarifas-body tr")).map((tr) => ({
      id: tr.querySelector('[data-field="id"]').value.trim(),
      label: tr.querySelector('[data-field="label"]').value.trim(),
      aplicaRebajaSinLucro: tr.querySelector('[data-field="aplicaRebajaSinLucro"]').checked,
      nacional: {
        cosas: Number(tr.querySelector('[data-field="nacCosas"]').value) || 0,
        personas: Number(tr.querySelector('[data-field="nacPersonas"]').value) || 0,
        prima: Number(tr.querySelector('[data-field="nacPrima"]').value) || 0,
      },
      extranjera: {
        cosas: Number(tr.querySelector('[data-field="extCosas"]').value) || 0,
        personas: Number(tr.querySelector('[data-field="extPersonas"]').value) || 0,
        prima: Number(tr.querySelector('[data-field="extPrima"]').value) || 0,
      },
    }));
  }

  function collectRcvRecargos() {
    return collectSimpleRows("lo-quoter-rcv-recargos-body", [
      ["id", "text"],
      ["label", "text"],
      ["pct", "number"],
      ["enabled", "checkbox"],
    ]);
  }

  function collectHcmSumas() {
    return collectSimpleRows("lo-quoter-hcm-sumas-body", [
      ["id", "text"],
      ["label", "text"],
      ["value", "number"],
    ]);
  }

  function collectHcmRangos(sumas) {
    return Array.from(document.querySelectorAll("#lo-quoter-hcm-rangos-body tr")).map((tr) => {
      const rateInputs = Array.from(tr.querySelectorAll('[data-field="rate"]'));
      const rates = {};
      sumas.forEach((s, i) => {
        if (rateInputs[i]) rates[s.id] = Number(rateInputs[i].value) || 0;
      });
      return {
        id: tr.querySelector('[data-field="id"]').value.trim(),
        label: tr.querySelector('[data-field="label"]').value.trim(),
        min: Number(tr.querySelector('[data-field="min"]').value) || 0,
        max: Number(tr.querySelector('[data-field="max"]').value) || 0,
        rates,
      };
    });
  }

  function collectPatTipos() {
    return collectSimpleRows("lo-quoter-pat-tipos-body", [
      ["id", "text"],
      ["label", "text"],
    ]);
  }

  function splitCommaList(value) {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  async function saveQuoterConfig() {
    const statusEl = qs("lo-quoter-status");
    const saveButtons = document.querySelectorAll(".lo-quoter-save-btn");
    saveButtons.forEach((b) => (b.disabled = true));
    statusEl.hidden = true;

    try {
      const marcas = splitCommaList(qs("lo-quoter-rcv-marcas").value);
      if (!marcas.includes("Otra")) marcas.push("Otra");

      const hcmSumas = collectHcmSumas();

      const config = {
        ...quoterLoadedConfig,
        general: {
          ...(quoterLoadedConfig.general || {}),
          introMessage: qs("lo-quoter-intro").value.trim(),
          disclaimer: qs("lo-quoter-disclaimer").value.trim(),
          triggerKeywords: splitCommaList(qs("lo-quoter-keywords").value),
        },
        rcv: {
          ...(quoterLoadedConfig.rcv || {}),
          enabled: qs("lo-quoter-rcv-enabled").checked,
          label: qs("lo-quoter-rcv-label").value.trim(),
          minYear: Number(qs("lo-quoter-rcv-minyear").value) || 1990,
          currencyLabel: qs("lo-quoter-rcv-currency-label").value.trim(),
          currencyNote: qs("lo-quoter-rcv-currency-note").value.trim(),
          rebajaSinLucroPct: Number(qs("lo-quoter-rcv-rebaja-pct").value) || 0,
          marcasComunes: marcas,
          tarifas: collectRcvTarifas(),
          recargos: collectRcvRecargos(),
        },
        hcm: {
          ...(quoterLoadedConfig.hcm || {}),
          enabled: qs("lo-quoter-hcm-enabled").checked,
          label: qs("lo-quoter-hcm-label").value.trim(),
          currencyLabel: qs("lo-quoter-hcm-currency-label").value.trim(),
          maxAge: Number(qs("lo-quoter-hcm-maxage").value) || 0,
          maxBeneficiarios: Number(qs("lo-quoter-hcm-maxbenef").value) || 0,
          sumasAseguradas: hcmSumas,
          rangosEdad: collectHcmRangos(hcmSumas),
        },
        patrimoniales: {
          ...(quoterLoadedConfig.patrimoniales || {}),
          enabled: qs("lo-quoter-pat-enabled").checked,
          label: qs("lo-quoter-pat-label").value.trim(),
          mensajeEnvio: qs("lo-quoter-pat-mensaje").value.trim(),
          tiposBien: collectPatTipos(),
        },
      };

      const res = await apiFetch("/api/admin/quote-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "No se pudo guardar la configuración.");

      quoterLoadedConfig = data.config || config;
      statusEl.textContent = "✓ Cambios guardados correctamente.";
      statusEl.className = "lo-quoter-save-status lo-status-ok";
      statusEl.hidden = false;
    } catch (err) {
      statusEl.textContent = err.message || "No se pudo guardar la configuración.";
      statusEl.className = "lo-quoter-save-status lo-status-error";
      statusEl.hidden = false;
    } finally {
      saveButtons.forEach((b) => (b.disabled = false));
      setTimeout(() => {
        statusEl.hidden = true;
      }, 6000);
    }
  }

  // -------------------------------------------------------------------------
  // Reportes y métricas (gráficos con Chart.js + tabla de cotizaciones)
  // -------------------------------------------------------------------------

  const RAMO_ORDER = ["personas", "autos", "patrimoniales", "fianzas"];

  /** Lee un token de color de marca (--lo-verde, --lo-amarillo, …) definido en chatbot.css. */
  function brandColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  let dailyChart = null;
  let ramoChart = null;
  let hourlyChart = null;
  let reportQuotes = [];

  async function loadAndRenderReports() {
    const loadingEl = qs("lo-report-loading");
    const contentEl = qs("lo-report-content");
    loadingEl.hidden = false;
    contentEl.hidden = true;

    try {
      const res = await apiFetch("/api/admin/reports");
      if (!res.ok) throw new Error("No se pudieron cargar los reportes.");
      const data = await res.json();

      renderReportStats(data.stats || {}, data.ramoLabels || RAMO_LABELS_FALLBACK);
      renderDailyChart(data.dailyCounts || []);
      renderRamoChart(data.ramoDistribution || {}, data.ramoLabels || RAMO_LABELS_FALLBACK);
      renderHourlyChart(data.hourlyActivity || new Array(24).fill(0));
      renderQuotesTable(data.quotes || [], data.ramoLabels || RAMO_LABELS_FALLBACK);

      loadingEl.hidden = true;
      contentEl.hidden = false;
    } catch (err) {
      loadingEl.textContent = "No se pudieron cargar los reportes. Intenta actualizar la página.";
      console.error("[Panel admin] Error al cargar reportes:", err);
    }
  }

  function renderReportStats(stats, ramoLabels) {
    const topRamoLabel = stats.topRamo ? ramoLabels[stats.topRamo] || stats.topRamo : "Sin datos aún";

    const cards = [
      { value: stats.todayCount ?? 0, label: "Conversaciones hoy" },
      { value: stats.weekCount ?? 0, label: "Conversaciones esta semana" },
      { value: stats.monthCount ?? 0, label: "Conversaciones este mes" },
      { value: stats.avgMessages ?? 0, label: "Mensajes promedio por conversación" },
      { value: `${stats.advisorPct ?? 0}%`, label: "Solicitaron asesor humano" },
      { value: `${stats.quotePct ?? 0}%`, label: "Generaron una cotización" },
      { value: topRamoLabel, label: "Ramo más consultado", isText: true },
    ];

    qs("lo-report-stats").innerHTML = cards
      .map(
        (c) =>
          `<div class="lo-admin-stat-card"><div class="lo-admin-stat-value${
            c.isText ? " lo-admin-stat-value-text" : ""
          }">${escapeHtml(c.value)}</div><div class="lo-admin-stat-label">${escapeHtml(c.label)}</div></div>`
      )
      .join("");
  }

  function shortDateLabel(isoDate) {
    try {
      return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short" }).format(new Date(`${isoDate}T00:00:00`));
    } catch (_e) {
      return isoDate;
    }
  }

  function renderDailyChart(dailyCounts) {
    const ctx = qs("lo-report-chart-daily").getContext("2d");
    const verde = brandColor("--lo-verde", "#00bf63");

    if (dailyChart) dailyChart.destroy();
    dailyChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: dailyCounts.map((d) => shortDateLabel(d.date)),
        datasets: [
          {
            label: "Conversaciones",
            data: dailyCounts.map((d) => d.count),
            backgroundColor: verde,
            borderRadius: 4,
            maxBarThickness: 18,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { maxRotation: 60, minRotation: 60, autoSkip: true, maxTicksLimit: 15 }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    });
  }

  function renderRamoChart(ramoDistribution, ramoLabels) {
    const ctx = qs("lo-report-chart-ramo").getContext("2d");
    const palette = [
      brandColor("--lo-verde", "#00bf63"),
      brandColor("--lo-verde-claro", "#37ce48"),
      brandColor("--lo-amarillo", "#fce809"),
      brandColor("--lo-gris-claro", "#a6a6a6"),
    ];

    const labels = RAMO_ORDER.map((r) => ramoLabels[r] || r);
    const values = RAMO_ORDER.map((r) => ramoDistribution[r] || 0);

    if (ramoChart) ramoChart.destroy();

    ramoChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data: values,
            backgroundColor: palette,
            borderColor: "#ffffff",
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, font: { family: "Poppins", size: 11.5 } } },
        },
      },
    });
  }

  function renderHourlyChart(hourlyActivity) {
    const ctx = qs("lo-report-chart-hourly").getContext("2d");
    const verde = brandColor("--lo-verde", "#00bf63");
    const verdeClaro = brandColor("--lo-verde-claro", "#37ce48");

    if (hourlyChart) hourlyChart.destroy();
    hourlyChart = new Chart(ctx, {
      type: "line",
      data: {
        labels: hourlyActivity.map((_v, hour) => `${hour}h`),
        datasets: [
          {
            label: "Mensajes",
            data: hourlyActivity,
            borderColor: verde,
            backgroundColor: `${verdeClaro}33`,
            fill: true,
            tension: 0.35,
            pointRadius: 2,
            pointBackgroundColor: verde,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    });
  }

  function quoteSolicitanteLabel(q) {
    if (!q.contact) return "—";
    return `${q.contact.nombre} · ${q.contact.cedula} · ${q.contact.correo}`;
  }

  function renderQuotesTable(quotes, ramoLabels) {
    reportQuotes = quotes;
    const tbody = qs("lo-report-quotes-body");
    const emptyEl = qs("lo-report-quotes-empty");

    if (quotes.length === 0) {
      tbody.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    tbody.innerHTML = quotes
      .map((q) => {
        const formalHtml = q.formalRequest
          ? '<span class="lo-admin-badge lo-admin-badge-formal">📄 Sí</span>'
          : '<span class="lo-admin-badge lo-admin-badge-advisor-no">No</span>';
        return `
          <tr>
            <td>${escapeHtml(formatDateTime(q.createdAt))}</td>
            <td><span class="lo-admin-badge lo-admin-badge-ramo">${escapeHtml(
              ramoLabels[q.ramo] || q.ramo
            )}</span></td>
            <td>${escapeHtml(q.estimatedValue || "—")}</td>
            <td>${escapeHtml(quoteSolicitanteLabel(q))}</td>
            <td>${formalHtml}</td>
          </tr>
        `;
      })
      .join("");
  }

  // -------------------------------------------------------------------------
  // Inicialización
  // -------------------------------------------------------------------------

  function init() {
    qs("lo-admin-login-form").addEventListener("submit", handleLogin);
    qs("lo-admin-logout").addEventListener("click", handleLogout);

    qs("lo-admin-search").addEventListener("input", debounce(applyFilters, 200));
    qs("lo-admin-date-from").addEventListener("change", applyFilters);
    qs("lo-admin-date-to").addEventListener("change", applyFilters);
    qs("lo-admin-filter-channel").addEventListener("change", applyFilters);
    qs("lo-admin-filter-ramo").addEventListener("change", applyFilters);
    qs("lo-admin-filter-advisor").addEventListener("change", applyFilters);
    qs("lo-admin-filter-revision").addEventListener("change", applyFilters);

    qs("lo-admin-clear-filters").addEventListener("click", () => {
      qs("lo-admin-search").value = "";
      qs("lo-admin-date-from").value = "";
      qs("lo-admin-date-to").value = "";
      qs("lo-admin-filter-channel").value = "";
      qs("lo-admin-filter-ramo").value = "";
      qs("lo-admin-filter-advisor").value = "";
      qs("lo-admin-filter-revision").value = "";
      applyFilters();
    });

    qs("lo-admin-refresh").addEventListener("click", loadConversations);
    qs("lo-admin-export").addEventListener("click", () => {
      window.location.href = "/api/admin/conversations-export.csv";
    });

    qs("lo-admin-modal-close").addEventListener("click", closeModal);
    qs("lo-admin-modal-backdrop").addEventListener("click", closeModal);
    qs("lo-client-modal-close").addEventListener("click", closeClientModal);
    qs("lo-client-modal-backdrop").addEventListener("click", closeClientModal);
    qs("lo-siniestro-modal-close").addEventListener("click", closeSiniestroModal);
    qs("lo-siniestro-modal-backdrop").addEventListener("click", closeSiniestroModal);
    qs("lo-emision-modal-close").addEventListener("click", closeEmisionModal);
    qs("lo-emision-modal-backdrop").addEventListener("click", closeEmisionModal);
    qs("lo-gap-modal-close").addEventListener("click", closeGapModal);
    qs("lo-gap-modal-backdrop").addEventListener("click", closeGapModal);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!qs("lo-gap-modal").hidden) {
        closeGapModal();
        return;
      }
      if (!qs("lo-emision-modal").hidden) {
        closeEmisionModal();
        return;
      }
      if (!qs("lo-siniestro-modal").hidden) {
        closeSiniestroModal();
        return;
      }
      if (!qs("lo-client-modal").hidden) {
        closeClientModal();
        return;
      }
      if (!qs("lo-admin-modal").hidden) closeModal();
    });

    // Pestañas
    qs("lo-admin-tab-conversations").addEventListener("click", () => showView("conversations"));
    qs("lo-admin-tab-clientes").addEventListener("click", () => showView("clientes"));
    qs("lo-admin-tab-siniestros").addEventListener("click", () => showView("siniestros"));
    qs("lo-admin-tab-emisiones").addEventListener("click", () => showView("emisiones"));
    qs("lo-admin-tab-gaps").addEventListener("click", () => showView("gaps"));
    qs("lo-admin-tab-quoter").addEventListener("click", () => showView("quoter"));
    qs("lo-admin-tab-reports").addEventListener("click", () => showView("reports"));

    // Clientes (memoria persistente)
    qs("lo-clientes-search").addEventListener("input", debounce(applyClientesFilter, 200));
    qs("lo-clientes-refresh").addEventListener("click", loadClientes);

    // Siniestros
    qs("lo-siniestros-search").addEventListener("input", debounce(applySiniestrosFilter, 200));
    qs("lo-siniestros-filter-estado").addEventListener("change", loadSiniestros);
    qs("lo-siniestros-filter-mayor").addEventListener("change", loadSiniestros);
    qs("lo-siniestros-refresh").addEventListener("click", loadSiniestros);

    // Emisiones (solicitudes del portal de corredores)
    qs("lo-emisiones-search").addEventListener("input", debounce(applyEmisionesFilter, 200));
    qs("lo-emisiones-filter-estado").addEventListener("change", applyEmisionesFilter);
    qs("lo-emisiones-refresh").addEventListener("click", loadEmisiones);

    // Gaps de conocimiento (preguntas sin respuesta)
    qs("lo-gaps-search").addEventListener("input", debounce(applyGapsFilter, 200));
    qs("lo-gaps-filter-estado").addEventListener("change", applyGapsFilter);
    qs("lo-gaps-refresh").addEventListener("click", loadGaps);

    // Editor del cotizador: tablas editables (agregar/eliminar filas)
    wireSimpleTable("lo-quoter-rcv-tarifas-body", "lo-quoter-rcv-tarifa-add", rcvTarifaRowHtml);
    wireSimpleTable("lo-quoter-rcv-recargos-body", "lo-quoter-rcv-recargo-add", rcvRecargoRowHtml);
    wireSimpleTable("lo-quoter-pat-tipos-body", "lo-quoter-pat-tipo-add", patTipoRowHtml);
    wireHcmTables();

    document.querySelectorAll(".lo-quoter-save-btn").forEach((btn) => {
      btn.addEventListener("click", saveQuoterConfig);
    });

    qs("lo-report-export-quotes").addEventListener("click", () => {
      window.location.href = "/api/admin/quotes-export.csv";
    });

    checkSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
