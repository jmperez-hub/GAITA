/**
 * corredor.js
 * Portal de corredores (/corredor) — La Occidental C.A. de Seguros.
 * Autenticación por JWT (token guardado en localStorage, enviado como
 * "Authorization: Bearer <token>" en cada petición — ver apiFetch), ruteo entre
 * vistas con la History API (no hay recarga de página al navegar), y un stream SSE
 * de notificaciones en tiempo real (toasts).
 */

(function () {
  "use strict";

  const TOKEN_KEY = "co_token";
  const RAMO_LABELS = {
    automoviles: "Automóviles",
    autos: "Automóviles",
    hcm: "HCM",
    personas: "Personas",
    patrimonial: "Patrimonial",
    patrimoniales: "Patrimoniales",
    fianza: "Fianza",
    fianzas: "Fianzas",
  };
  const SINIESTRO_ESTADO_LABELS = {
    recibido: "Recibido",
    pendiente_documentacion: "Pendiente de documentación",
    en_investigacion: "En investigación",
    aprobado: "Aprobado",
    rechazado: "Rechazado",
    por_pagar: "Por pagar",
    pagado: "Pagado",
  };
  // Vocabulario del campo `tipo` de un siniestro — distinto de RAMO_LABELS (que es el
  // vocabulario de `ramo` de una póliza); "colision" es alias de "accidente" (mismo
  // criterio que server.js#SINIESTRO_TIPO_LABELS).
  const SINIESTRO_TIPO_LABELS = {
    accidente: "Accidente de tránsito",
    colision: "Accidente de tránsito",
    robo: "Robo",
    incendio: "Incendio",
    hospitalizacion: "Hospitalización (HCM)",
  };
  const EMISION_ESTADO_LABELS = {
    pendiente_aprobacion: "Pendiente de aprobación",
    aprobada: "Aprobada",
    rechazada: "Rechazada",
  };

  const state = {
    corredor: null,
    quoterConfig: null,
    eventSource: null,
  };

  function qs(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function debounce(fn, wait) {
    let timer = null;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function money(amount, currency) {
    if (amount == null) return "—";
    return `${Number(amount).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ""}`.trim();
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("es-VE", { day: "2-digit", month: "short", year: "numeric" });
    } catch (_e) {
      return iso;
    }
  }

  function vigenciaBadgeHtml(vig) {
    if (!vig) return "—";
    if (vig.vencida) return `<span class="lo-admin-badge lo-admin-badge-vencida">Vencida hace ${Math.abs(vig.diasRestantes)} d</span>`;
    if (vig.porVencer) return `<span class="lo-admin-badge lo-admin-badge-por-vencer">Vence en ${vig.diasRestantes} d</span>`;
    return `<span class="lo-admin-badge lo-admin-badge-vigente">Vigente</span>`;
  }

  function siniestroBadgeHtml(estado) {
    const label = SINIESTRO_ESTADO_LABELS[estado] || estado;
    return `<span class="lo-admin-badge lo-admin-badge-siniestro-${estado}">${escapeHtml(label)}</span>`;
  }

  function emisionBadgeHtml(estado) {
    const cls = estado === "aprobada" ? "lo-admin-badge-vigente" : estado === "rechazada" ? "lo-admin-badge-vencida" : "lo-admin-badge-por-vencer";
    return `<span class="lo-admin-badge ${cls}">${escapeHtml(EMISION_ESTADO_LABELS[estado] || estado)}</span>`;
  }

  // -------------------------------------------------------------------------
  // Autenticación (JWT en localStorage) + fetch autenticado
  // -------------------------------------------------------------------------

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (_e) {
      return "";
    }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_e) {
      /* localStorage no disponible (modo privado, etc.) — la sesión no persistirá al recargar */
    }
  }

  /** fetch con el header Authorization ya puesto — si el servidor responde 401
   *  (token ausente/inválido/expirado), cierra la sesión y vuelve al login. */
  async function apiFetch(url, options) {
    const token = getToken();
    const opts = Object.assign({}, options, {
      headers: Object.assign({}, options && options.headers, token ? { Authorization: `Bearer ${token}` } : {}),
    });
    const res = await fetch(url, opts);
    if (res.status === 401) {
      logout();
    }
    return res;
  }

  function showLogin(message) {
    qs("co-login").hidden = false;
    qs("co-app").hidden = true;
    if (message) {
      qs("co-login-error").textContent = message;
      qs("co-login-error").hidden = false;
    }
    stopEventStream();
  }

  function showApp() {
    qs("co-login").hidden = true;
    qs("co-app").hidden = false;
  }

  function logout() {
    setToken("");
    state.corredor = null;
    showLogin();
  }

  async function tryRestoreSession() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }
    const res = await apiFetch("/api/corredor/me");
    if (!res.ok) {
      showLogin();
      return;
    }
    const data = await res.json();
    state.corredor = data.corredor;
    onLoggedIn();
  }

  function onLoggedIn() {
    showApp();
    qs("co-header-sub").textContent = `${state.corredor.nombre} · ${state.corredor.email}`;
    startEventStream();
    router();
  }

  // -------------------------------------------------------------------------
  // Ruteo entre vistas (History API) — 4 rutas reales, sin recargar la página al
  // navegar entre ellas (mismo cascarón HTML, servido por server.js para las 4).
  // -------------------------------------------------------------------------

  const VIEWS = {
    "/corredor": "dashboard",
    "/corredor/clientes": "clientes",
    "/corredor/cotizar": "cotizar",
    "/corredor/siniestros": "siniestros",
  };

  function router() {
    const path = window.location.pathname;
    const view = VIEWS[path] || "dashboard";
    Object.keys(VIEWS).forEach((route) => {
      const isActive = VIEWS[route] === view;
      qs(`co-view-${VIEWS[route]}`).hidden = !isActive;
    });
    document.querySelectorAll(".lo-admin-tab[data-route]").forEach((a) => {
      a.classList.toggle("lo-admin-tab-active", a.getAttribute("data-route") === path);
    });
    if (view === "dashboard") loadDashboard();
    if (view === "clientes") loadClientes();
    if (view === "cotizar") loadCotizarView();
    if (view === "siniestros") loadSiniestros();
  }

  function navigate(path) {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    router();
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-route]");
    if (!link) return;
    event.preventDefault();
    navigate(link.getAttribute("data-route"));
  });
  window.addEventListener("popstate", router);

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  async function loadDashboard() {
    const [carteraRes, porVencerRes, siniestrosRes, comisionRes, emisionesRes, documentosRes] = await Promise.all([
      apiFetch("/api/corredor/cartera"),
      apiFetch("/api/corredor/polizas-por-vencer?dias=30"),
      apiFetch("/api/corredor/siniestros"),
      apiFetch("/api/corredor/comision"),
      apiFetch("/api/corredor/emisiones"),
      apiFetch("/api/corredor/documentos"),
    ]);
    if (!carteraRes.ok) return;

    const cartera = (await carteraRes.json()).cartera || [];
    const porVencer = (await porVencerRes.json()).polizas || [];
    const siniestros = (await siniestrosRes.json()).siniestros || [];
    const comision = comisionRes.ok ? await comisionRes.json() : { totalAcumulado: 0 };
    const emisiones = emisionesRes.ok ? (await emisionesRes.json()).emisiones || [] : [];
    const documentos = documentosRes.ok ? (await documentosRes.json()).documentos || [] : [];

    const siniestrosAbiertos = siniestros.filter((s) => s.abierto).length;

    qs("co-stats").innerHTML = `
      <div class="lo-admin-stat-card"><div class="lo-admin-stat-value">${cartera.length}</div><div class="lo-admin-stat-label">Clientes en tu cartera</div></div>
      <div class="lo-admin-stat-card"><div class="lo-admin-stat-value">${porVencer.length}</div><div class="lo-admin-stat-label">Pólizas por vencer (30 días)</div></div>
      <div class="lo-admin-stat-card"><div class="lo-admin-stat-value">${siniestrosAbiertos}</div><div class="lo-admin-stat-label">Siniestros abiertos</div></div>
      <div class="lo-admin-stat-card"><div class="lo-admin-stat-value">${money(comision.totalAcumulado, "USD")}</div><div class="lo-admin-stat-label">Comisión acumulada</div></div>
    `;

    const tbody = qs("co-dashboard-vencer-body");
    const empty = qs("co-dashboard-vencer-empty");
    if (porVencer.length === 0) {
      tbody.innerHTML = "";
      empty.hidden = false;
    } else {
      empty.hidden = true;
      tbody.innerHTML = porVencer
        .map(
          (p) => `
            <tr>
              <td>${escapeHtml(p.numero)}</td>
              <td>${escapeHtml(p.titular)}</td>
              <td>${escapeHtml(RAMO_LABELS[p.ramo] || p.ramo)}</td>
              <td>${vigenciaBadgeHtml(p.vigencia)}</td>
              <td>$${escapeHtml(String(p.prima_anual))}</td>
            </tr>
          `
        )
        .join("");
    }

    const emisionesBody = qs("co-dashboard-emisiones-body");
    const emisionesEmpty = qs("co-dashboard-emisiones-empty");
    if (emisiones.length === 0) {
      emisionesBody.innerHTML = "";
      emisionesEmpty.hidden = false;
    } else {
      emisionesEmpty.hidden = true;
      emisionesBody.innerHTML = emisiones
        .slice(0, 8)
        .map(
          (e) => `
            <tr>
              <td>${escapeHtml(e.id)}</td>
              <td>${escapeHtml(e.cliente.nombre)}</td>
              <td>${escapeHtml(RAMO_LABELS[e.ramo] || e.ramo)}</td>
              <td>${emisionBadgeHtml(e.estado)}</td>
            </tr>
          `
        )
        .join("");
    }

    qs("co-documentos-list").innerHTML = documentos
      .map(
        (d) => `
          <div class="co-doc-item">
            <span>📄 ${escapeHtml(d.titulo)}</span>
            <button type="button" class="lo-admin-btn-ghost co-doc-download" data-key="${escapeAttr(d.key)}">Descargar</button>
          </div>
        `
      )
      .join("");
    document.querySelectorAll(".co-doc-download").forEach((btn) => {
      btn.addEventListener("click", () => downloadDocumento(btn.getAttribute("data-key")));
    });
  }

  async function downloadDocumento(key) {
    const res = await apiFetch(`/api/corredor/documentos/${encodeURIComponent(key)}`);
    if (!res.ok) return;
    const blob = await res.blob();
    window.open(URL.createObjectURL(blob), "_blank");
  }

  qs("co-btn-recordatorios") &&
    qs("co-btn-recordatorios").addEventListener("click", async () => {
      const btn = qs("co-btn-recordatorios");
      const statusEl = qs("co-recordatorios-status");
      btn.disabled = true;
      statusEl.hidden = true;
      try {
        const res = await apiFetch("/api/corredor/recordatorios", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "No se pudieron enviar los recordatorios.");
        statusEl.className = "lo-quoter-save-status lo-status-ok";
        statusEl.textContent = `✓ Enviados a ${data.enviados.length} cliente(s)${data.sinTelefono.length ? ` — ${data.sinTelefono.length} sin teléfono registrado` : ""}${data.twilioConfigurado ? "" : " (WhatsApp no está configurado en este servidor — no se envió nada realmente)"}.`;
        statusEl.hidden = false;
      } catch (err) {
        statusEl.className = "lo-quoter-save-status lo-status-error";
        statusEl.textContent = err.message || "Error al enviar los recordatorios.";
        statusEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });

  // -------------------------------------------------------------------------
  // Clientes (cartera)
  // -------------------------------------------------------------------------

  let carteraCache = [];

  async function loadClientes() {
    qs("co-clientes-loading").hidden = false;
    qs("co-clientes-empty").hidden = true;
    const res = await apiFetch("/api/corredor/cartera");
    qs("co-clientes-loading").hidden = true;
    if (!res.ok) return;
    const data = await res.json();
    carteraCache = data.cartera || [];
    renderClientes(carteraCache);
  }

  function renderClientes(cartera) {
    const tbody = qs("co-clientes-table-body");
    const empty = qs("co-clientes-empty");
    if (cartera.length === 0) {
      tbody.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    tbody.innerHTML = cartera
      .map((c) => {
        const polizasHtml = c.polizas.map((p) => `${escapeHtml(p.numero)} ${vigenciaBadgeHtml(p.vigencia)}`).join("<br/>");
        const peorVigencia = c.polizas.some((p) => p.vigencia.vencida)
          ? { vencida: true, diasRestantes: Math.min(...c.polizas.map((p) => p.vigencia.diasRestantes)) }
          : c.polizas.find((p) => p.vigencia.porVencer)
            ? c.polizas.find((p) => p.vigencia.porVencer).vigencia
            : { vigente: true };
        return `
          <tr>
            <td>${escapeHtml(c.cedula)}</td>
            <td>${escapeHtml(c.nombre)}</td>
            <td>${polizasHtml}</td>
            <td>${vigenciaBadgeHtml(peorVigencia)}</td>
          </tr>
        `;
      })
      .join("");
  }

  qs("co-clientes-search") &&
    qs("co-clientes-search").addEventListener(
      "input",
      debounce(() => {
        const q = qs("co-clientes-search").value.trim().toLowerCase();
        const filtered = !q
          ? carteraCache
          : carteraCache.filter((c) => c.nombre.toLowerCase().includes(q) || c.cedula.toLowerCase().includes(q));
        renderClientes(filtered);
      }, 200)
    );
  qs("co-clientes-refresh") && qs("co-clientes-refresh").addEventListener("click", loadClientes);

  // -------------------------------------------------------------------------
  // Cotizador profesional + solicitud de emisión
  // -------------------------------------------------------------------------

  let cotizarViewLoaded = false;

  async function loadCotizarView() {
    if (cotizarViewLoaded) return;
    cotizarViewLoaded = true;
    const res = await fetch("/api/quote-config");
    if (!res.ok) return;
    const data = await res.json();
    state.quoterConfig = data.config;

    const cfgRcv = state.quoterConfig.rcv || {};
    qs("co-rcv-tipo").innerHTML = (cfgRcv.tarifas || []).map((t) => `<option value="${escapeAttr(t.id)}">${escapeHtml(t.label)}</option>`).join("");
    qs("co-rcv-recargos").innerHTML = (cfgRcv.recargos || [])
      .map(
        (r) => `
          <label class="lo-quote-checkbox">
            <input type="checkbox" class="co-rcv-recargo-check" value="${escapeAttr(r.id)}" />
            <span>${escapeHtml(r.label)} (+${r.pct}%)</span>
          </label>
        `
      )
      .join("");

    const cfgHcm = state.quoterConfig.hcm || {};
    qs("co-hcm-suma").innerHTML = (cfgHcm.sumasAseguradas || []).map((s) => `<option value="${escapeAttr(s.id)}">${escapeHtml(s.label)}</option>`).join("");
  }

  qs("co-cotizar-ramo") &&
    qs("co-cotizar-ramo").addEventListener("change", () => {
      const ramo = qs("co-cotizar-ramo").value;
      qs("co-cotizar-form-rcv").hidden = ramo !== "automoviles";
      qs("co-cotizar-form-hcm").hidden = ramo !== "hcm";
    });

  qs("co-cotizar-submit") &&
    qs("co-cotizar-submit").addEventListener("click", async () => {
      const btn = qs("co-cotizar-submit");
      const statusEl = qs("co-cotizar-status");
      const ramo = qs("co-cotizar-ramo").value;
      const cliente = {
        nombre: qs("co-cotizar-cliente-nombre").value.trim(),
        cedula: qs("co-cotizar-cliente-cedula").value.trim(),
        vehiculo: qs("co-cotizar-cliente-vehiculo").value.trim(),
      };
      if (!cliente.nombre || !cliente.cedula) {
        statusEl.className = "lo-quoter-save-status lo-status-error";
        statusEl.textContent = "Completa el nombre y la cédula del cliente.";
        statusEl.hidden = false;
        return;
      }

      let inputs;
      if (ramo === "automoviles") {
        inputs = {
          tipoId: qs("co-rcv-tipo").value,
          placaId: qs("co-rcv-placa").value,
          usoId: qs("co-rcv-uso").value,
          recargoIds: Array.from(document.querySelectorAll(".co-rcv-recargo-check")).filter((el) => el.checked).map((el) => el.value),
        };
      } else {
        inputs = {
          titularAge: Number(qs("co-hcm-edad").value),
          sumaId: qs("co-hcm-suma").value,
          beneficiarioAges: qs("co-hcm-beneficiarios")
            .value.split(",")
            .map((s) => Number(s.trim()))
            .filter((n) => !Number.isNaN(n)),
        };
      }

      btn.disabled = true;
      statusEl.hidden = true;
      try {
        const res = await apiFetch("/api/corredor/cotizar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ramo, cliente, inputs }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "No se pudo generar la cotización.");
        }
        const blob = await res.blob();
        window.open(URL.createObjectURL(blob), "_blank");
        statusEl.className = "lo-quoter-save-status lo-status-ok";
        statusEl.textContent = "✓ Cotización generada — se abrió en una pestaña nueva.";
        statusEl.hidden = false;
      } catch (err) {
        statusEl.className = "lo-quoter-save-status lo-status-error";
        statusEl.textContent = err.message || "Error al generar la cotización.";
        statusEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });

  qs("co-emision-submit") &&
    qs("co-emision-submit").addEventListener("click", async () => {
      const btn = qs("co-emision-submit");
      const statusEl = qs("co-emision-status");
      const cliente = {
        nombre: qs("co-emision-nombre").value.trim(),
        cedula: qs("co-emision-cedula").value.trim(),
        telefono: qs("co-emision-telefono").value.trim(),
      };
      if (!cliente.nombre || !cliente.cedula) {
        statusEl.className = "lo-quoter-save-status lo-status-error";
        statusEl.textContent = "Completa el nombre y la cédula del cliente.";
        statusEl.hidden = false;
        return;
      }
      btn.disabled = true;
      statusEl.hidden = true;
      try {
        const res = await apiFetch("/api/corredor/emisiones", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cliente,
            ramo: qs("co-emision-ramo").value,
            detalle: { notas: qs("co-emision-detalle").value.trim() },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "No se pudo enviar la solicitud.");
        statusEl.className = "lo-quoter-save-status lo-status-ok";
        statusEl.textContent = `✓ Solicitud ${data.emision.id} enviada — queda pendiente de aprobación.`;
        statusEl.hidden = false;
        qs("co-emision-nombre").value = "";
        qs("co-emision-cedula").value = "";
        qs("co-emision-telefono").value = "";
        qs("co-emision-detalle").value = "";
      } catch (err) {
        statusEl.className = "lo-quoter-save-status lo-status-error";
        statusEl.textContent = err.message || "Error al enviar la solicitud.";
        statusEl.hidden = false;
      } finally {
        btn.disabled = false;
      }
    });

  // -------------------------------------------------------------------------
  // Siniestros de la cartera
  // -------------------------------------------------------------------------

  let siniestrosCache = [];

  async function loadSiniestros() {
    qs("co-siniestros-loading").hidden = false;
    qs("co-siniestros-empty").hidden = true;
    const res = await apiFetch("/api/corredor/siniestros");
    qs("co-siniestros-loading").hidden = true;
    if (!res.ok) return;
    const data = await res.json();
    siniestrosCache = data.siniestros || [];
    renderSiniestros(siniestrosCache);
  }

  function renderSiniestros(list) {
    const tbody = qs("co-siniestros-table-body");
    const empty = qs("co-siniestros-empty");
    if (list.length === 0) {
      tbody.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    tbody.innerHTML = list
      .map(
        (s) => `
          <tr>
            <td>${escapeHtml(s.numero)}</td>
            <td>${escapeHtml(s.cedula_titular)}</td>
            <td>${escapeHtml(SINIESTRO_TIPO_LABELS[s.tipo] || s.tipo)}</td>
            <td>${siniestroBadgeHtml(s.estado)}</td>
            <td>${escapeHtml(s.ajustador_asignado || "—")}</td>
          </tr>
        `
      )
      .join("");
  }

  qs("co-siniestros-search") &&
    qs("co-siniestros-search").addEventListener(
      "input",
      debounce(() => {
        const q = qs("co-siniestros-search").value.trim().toLowerCase();
        const filtered = !q
          ? siniestrosCache
          : siniestrosCache.filter((s) => s.numero.toLowerCase().includes(q) || s.cedula_titular.toLowerCase().includes(q));
        renderSiniestros(filtered);
      }, 200)
    );
  qs("co-siniestros-refresh") && qs("co-siniestros-refresh").addEventListener("click", loadSiniestros);

  // -------------------------------------------------------------------------
  // Notificaciones en tiempo real (SSE) + toasts
  // -------------------------------------------------------------------------

  function startEventStream() {
    stopEventStream();
    const token = getToken();
    if (!token) return;
    // EventSource no permite headers personalizados — el token va en la query string
    // (única excepción a Authorization: Bearer en todo el portal, ver requireCorredorAuth).
    const es = new EventSource(`/api/corredor/events?token=${encodeURIComponent(token)}`);
    es.addEventListener("siniestro-abierto", (ev) => {
      const data = JSON.parse(ev.data);
      showToast({
        cls: "co-toast-siniestro",
        title: "🚨 Nuevo siniestro en tu cartera",
        body: `${data.titular} abrió el siniestro ${data.numero} (póliza ${data.poliza}).`,
      });
      if (!qs("co-view-siniestros").hidden) loadSiniestros();
    });
    es.addEventListener("poliza-por-vencer", (ev) => {
      const data = JSON.parse(ev.data);
      showToast({
        cls: "co-toast-mayor",
        title: "⏰ Póliza por vencer",
        body: `${data.titular} — ${data.numero} vence en ${data.diasRestantes} día(s).`,
      });
      if (!qs("co-view-dashboard").hidden) loadDashboard();
    });
    es.addEventListener("emision-resuelta", (ev) => {
      const data = JSON.parse(ev.data);
      const aprobada = data.estado === "aprobada";
      showToast({
        cls: aprobada ? "" : "co-toast-siniestro",
        title: aprobada ? "✅ Emisión aprobada" : "❌ Emisión rechazada",
        body: `${data.cliente.nombre} — solicitud ${data.id} (${RAMO_LABELS[data.ramo] || data.ramo}).`,
      });
      if (!qs("co-view-dashboard").hidden) loadDashboard();
    });
    es.onerror = () => {
      // EventSource reintenta solo — no hace falta lógica adicional aquí.
    };
    state.eventSource = es;
  }

  function stopEventStream() {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  }

  function showToast({ cls, title, body }) {
    const container = qs("co-toasts");
    const el = document.createElement("div");
    el.className = `co-toast ${cls || ""}`;
    el.innerHTML = `
      <button type="button" class="co-toast-close" aria-label="Cerrar">✕</button>
      <div class="co-toast-title">${escapeHtml(title)}</div>
      <div>${escapeHtml(body)}</div>
    `;
    el.querySelector(".co-toast-close").addEventListener("click", () => el.remove());
    container.appendChild(el);
    setTimeout(() => el.remove(), 12000);
  }

  // -------------------------------------------------------------------------
  // Login / logout
  // -------------------------------------------------------------------------

  qs("co-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const btn = qs("co-login-submit");
    const errorEl = qs("co-login-error");
    errorEl.hidden = true;
    btn.disabled = true;
    try {
      const res = await fetch("/api/corredor/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: qs("co-login-email").value.trim(), password: qs("co-login-password").value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "No se pudo iniciar sesión.");
      setToken(data.token);
      state.corredor = data.corredor;
      qs("co-login-password").value = "";
      onLoggedIn();
    } catch (err) {
      errorEl.textContent = err.message || "Error al iniciar sesión.";
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  qs("co-logout").addEventListener("click", logout);

  // -------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------

  function init() {
    tryRestoreSession();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
