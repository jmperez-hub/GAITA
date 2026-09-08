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

        return `
          <tr data-id="${escapeHtml(c.id)}">
            <td>${channelHtml(c)}</td>
            <td>${escapeHtml(formatDateTime(c.startedAt))}</td>
            <td>${escapeHtml(formatDuration(c.durationSeconds))}</td>
            <td>${c.messageCount}</td>
            <td>${ramosHtml}</td>
            <td>${advisorHtml}</td>
            <td>${quoteHtml}</td>
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

  async function openDetail(id) {
    const modal = qs("lo-admin-modal");
    const body = qs("lo-admin-modal-body");
    const meta = qs("lo-admin-modal-meta");

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

    const messages = conversation.messages || [];
    if (messages.length === 0) {
      body.innerHTML = '<div class="lo-admin-empty">Esta conversación no tiene mensajes.</div>';
      return;
    }

    const messagesHtml = messages
      .map((m) => {
        const isUser = m.role === "user";
        const bubbleClass = isUser ? "lo-msg-user" : "lo-msg-bot";
        const timeLabel = m.time ? formatTime(m.time) : "";
        const avatar = isUser
          ? ""
          : `<div class="lo-avatar lo-avatar-sm">${AVATAR_SVG}<img src="lucy-avatar.png" alt="" onerror="this.remove()" /></div>`;
        return `
          <div class="lo-msg-row ${isUser ? "lo-row-user" : "lo-row-bot"}">
            ${avatar}
            <div class="lo-msg-col">
              ${attachmentHtml(m.attachment)}
              <div class="lo-msg ${bubbleClass}">${escapeHtml(m.content)}</div>
              ${attachmentHtml(m.media)}
              <span class="lo-msg-time">${escapeHtml(timeLabel)}</span>
            </div>
          </div>
        `;
      })
      .join("");

    body.innerHTML = messagesHtml + renderQuotesSection(conversation.quotes);
    body.scrollTop = 0;
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

  const VIEWS = ["conversations", "quoter", "reports"];
  let quoterViewLoaded = false;
  let reportsViewLoaded = false;

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

    qs("lo-admin-clear-filters").addEventListener("click", () => {
      qs("lo-admin-search").value = "";
      qs("lo-admin-date-from").value = "";
      qs("lo-admin-date-to").value = "";
      qs("lo-admin-filter-channel").value = "";
      qs("lo-admin-filter-ramo").value = "";
      qs("lo-admin-filter-advisor").value = "";
      applyFilters();
    });

    qs("lo-admin-refresh").addEventListener("click", loadConversations);
    qs("lo-admin-export").addEventListener("click", () => {
      window.location.href = "/api/admin/conversations-export.csv";
    });

    qs("lo-admin-modal-close").addEventListener("click", closeModal);
    qs("lo-admin-modal-backdrop").addEventListener("click", closeModal);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !qs("lo-admin-modal").hidden) closeModal();
    });

    // Pestañas
    qs("lo-admin-tab-conversations").addEventListener("click", () => showView("conversations"));
    qs("lo-admin-tab-quoter").addEventListener("click", () => showView("quoter"));
    qs("lo-admin-tab-reports").addEventListener("click", () => showView("reports"));

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
