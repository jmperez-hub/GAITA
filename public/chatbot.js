/**
 * chatbot.js
 * Widget de chat flotante "Lucy" para La Occidental C.A. de Seguros.
 *
 * Uso: incluir chatbot.css y chatbot.js en cualquier página HTML.
 * Opcionalmente, definir `window.LO_CHATBOT_CONFIG` ANTES de cargar este script
 * para personalizar el backend, el saludo o las sugerencias rápidas:
 *
 *   <script>
 *     window.LO_CHATBOT_CONFIG = {
 *       apiUrl: "http://localhost:3000/api/chat",
 *       assistantName: "Lucy",
 *       companyName: "La Occidental",
 *       greeting: "¡Hola! Soy Lucy, la asistente virtual de La Occidental...",
 *       quickReplies: ["Cotizar un seguro", "Reportar un siniestro"],
 *     };
 *   </script>
 *   <script src="chatbot.js"></script>
 */

(function () {
  "use strict";

  // Carpeta donde vive este script — se usa para resolver "lucy-avatar.png"
  // aunque el widget se incruste desde otro dominio (ver README, sección de integración).
  // Debe leerse de forma síncrona: document.currentScript deja de ser válido
  // apenas termina de ejecutarse este bloque.
  const SCRIPT_DIR = (function () {
    try {
      if (document.currentScript && document.currentScript.src) {
        return document.currentScript.src.replace(/[^/]*$/, "");
      }
    } catch (_e) {
      /* ignorar y usar ruta relativa por defecto */
    }
    return "./";
  })();

  const DEFAULTS = {
    apiUrl: "/api/chat",
    assistantName: "Lucy",
    companyName: "La Occidental",
    headerSubtitle: "Asistente virtual · La Occidental Seguros",
    avatarUrl: SCRIPT_DIR + "lucy-avatar.png",
    greeting:
      "¡Hola! 👋 Soy Lucy, la asistente virtual de La Occidental. Puedo ayudarte con cotizaciones, información de coberturas y reportes de siniestros. ¿En qué puedo ayudarte hoy?",
    // Imagen de bienvenida del catálogo de Lucy (ver MEDIA_CATALOG en server.js) — se
    // muestra siempre junto al saludo, igual criterio que el audio de bienvenida.
    greetingMedia: {
      mediaKey: "bienvenida",
      title: "Bienvenida a La Occidental",
      url: "/assets/lucy-media/general/bienvenida.png",
    },
    quickReplies: [
      "Quiero cotizar un seguro",
      "Cómo reporto un siniestro",
      "Ver tipos de pólizas",
      "Hablar con un asesor",
    ],
    disclaimer:
      "Las respuestas son generadas por IA y pueden contener errores. Para trámites formales, consulta con un asesor.",
    storageKey: "lo_chatbot_history_v1",
    sessionIdKey: "lo_chatbot_session_id_v1",
  };

  const CONFIG = Object.assign({}, DEFAULTS, window.LO_CHATBOT_CONFIG || {});

  // -------------------------------------------------------------------------
  // Avatar de Lucy: ícono de respaldo (se ve mientras carga la foto, o si no
  // está disponible) + la foto real, superpuesta cuando termina de cargar.
  // -------------------------------------------------------------------------

  const AVATAR_FALLBACK_SVG = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="4" r="1.3"></circle>
      <rect x="11.3" y="5" width="1.4" height="2.6"></rect>
      <rect x="4.5" y="7.5" width="15" height="11" rx="5.5"></rect>
      <circle cx="9.4" cy="13" r="1.6" fill="#ffffff"></circle>
      <circle cx="14.6" cy="13" r="1.6" fill="#ffffff"></circle>
      <rect x="10" y="16.3" width="4" height="1.3" rx="0.65" fill="#ffffff"></rect>
    </svg>
  `;

  function avatarPhotoHtml() {
    return `<img src="${escapeHtml(CONFIG.avatarUrl)}" alt="" loading="lazy" onerror="this.remove()" />`;
  }

  function avatarHtml(size) {
    return `<div class="lo-avatar lo-avatar-${size}">${AVATAR_FALLBACK_SVG}${avatarPhotoHtml()}</div>`;
  }

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  /** @type {{role: "user"|"assistant", content: string, time?: string}[]} */
  let conversation = [];
  let isSending = false;
  let hasOpenedOnce = false;
  /** Identificador de esta conversación, usado por el panel de administración (/admin). */
  let sessionId = null;

  // -------------------------------------------------------------------------
  // Grabación de voz (nota de voz) — estado
  // -------------------------------------------------------------------------

  /** ¿El navegador puede grabar audio? (getUserMedia + MediaRecorder). Se calcula una
   *  sola vez; si es false, el micrófono se deja visible pero deshabilitado con un
   *  tooltip explicativo, y el botón de enviar nunca se oculta (ver updateMicSendToggle). */
  const AUDIO_RECORDING_SUPPORTED = Boolean(
    navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined"
  );

  // Orden de preferencia de formatos: Chrome/Firefox/Edge soportan WebM+Opus; Safari
  // (iOS 14.3+) solo soporta MP4/AAC. Se detecta el primero disponible en tiempo real.
  const AUDIO_MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];

  const AUDIO_MAX_DURATION_MS = 2 * 60 * 1000; // 2 minutos — luego se envía automáticamente
  const AUDIO_MIN_DURATION_MS = 700; // grabaciones más cortas se descartan (toque accidental)
  const RECORDING_CANCEL_DRAG_PX = 80; // distancia hacia la izquierda para cancelar (estilo WhatsApp)
  const MIC_INTRO_SEEN_KEY = "lo_chatbot_mic_intro_seen_v1";

  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let selectedAudioMimeType = null;
  let isRecording = false;
  let isCancellingRecording = false;
  let recordingStartedAt = 0;
  let recordingTimerInterval = null;
  let recordingMaxTimeout = null;
  let recordingAudioCtx = null;
  let recordingAnalyser = null;
  let recordingWaveformRaf = null;
  let micPointerId = null;
  let micPointerStartX = null;

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function getOrCreateSessionId() {
    try {
      const existing = sessionStorage.getItem(CONFIG.sessionIdKey);
      if (existing) return existing;
    } catch (_e) {
      /* almacenamiento no disponible */
    }
    const id = generateId();
    try {
      sessionStorage.setItem(CONFIG.sessionIdKey, id);
    } catch (_e) {
      /* ignorar: modo privado, cuota excedida, etc. */
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // Modo supervisor: conexión SSE persistente (GET /api/chat/live) para poder recibir
  // un mensaje del servidor SIN que el usuario haya escrito nada — "shadow messaging"
  // desde /admin (ver server.js#notifyConversationStream). A diferencia del resto del
  // chat (una petición corta por mensaje), esta conexión se abre UNA vez al cargar el
  // widget y se mantiene abierta mientras la página siga abierta.
  // -------------------------------------------------------------------------

  let liveEventSource = null;

  function deriveLiveUrl() {
    if (CONFIG.liveUrl) return CONFIG.liveUrl;
    return CONFIG.apiUrl.replace(/\/api\/chat\/?$/, "/api/chat/live");
  }

  function connectLiveStream() {
    if (typeof window.EventSource !== "function" || !sessionId) return;
    try {
      if (liveEventSource) liveEventSource.close();
      liveEventSource = new EventSource(`${deriveLiveUrl()}?sessionId=${encodeURIComponent(sessionId)}`);
      liveEventSource.addEventListener("assistant-message", (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data || typeof data.content !== "string" || !data.content) return;
          appendMessageEl("assistant", data.content, data.time);
          conversation.push({ role: "assistant", content: data.content, time: data.time || new Date().toISOString() });
          saveHistory();
        } catch (_e) {
          /* evento malformado — se ignora, no debe romper el chat */
        }
      });
      // EventSource reintenta la conexión solo ante un corte — no hace falta lógica
      // adicional en onerror; el chat sigue funcionando normal (petición/respuesta)
      // aunque este stream esté caído.
    } catch (_e) {
      /* el navegador no soporta EventSource, o falló al conectar */
    }
  }

  // -------------------------------------------------------------------------
  // Construcción del DOM
  // -------------------------------------------------------------------------

  function buildWidget() {
    const root = document.createElement("div");
    root.id = "lo-chatbot-root";
    root.innerHTML = `
      <div class="lo-chat-window" role="dialog" aria-label="Chat con ${escapeHtml(
        CONFIG.assistantName
      )} de ${escapeHtml(CONFIG.companyName)}">
        <div class="lo-chat-header">
          <div class="lo-avatar lo-avatar-md">
            ${AVATAR_FALLBACK_SVG}${avatarPhotoHtml()}
            <span class="lo-avatar-status" aria-hidden="true"></span>
          </div>
          <div class="lo-chat-header-info">
            <div class="lo-chat-header-title">${escapeHtml(CONFIG.assistantName)}</div>
            <div class="lo-chat-header-subtitle"><span class="lo-status-dot"></span>${escapeHtml(
              CONFIG.headerSubtitle
            )}</div>
          </div>
          <div class="lo-chat-header-actions">
            <button type="button" class="lo-chat-header-btn" id="lo-chat-minimize" aria-label="Minimizar chat" title="Minimizar">
              <svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="2" rx="1"/></svg>
            </button>
            <button type="button" class="lo-chat-header-btn" id="lo-chat-close" aria-label="Cerrar chat" title="Cerrar">
              <svg viewBox="0 0 24 24"><path d="M18.3 5.71L12 12.01l-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.29 1.4 1.4 6.3-6.29 6.3 6.29 1.4-1.4-6.3-6.29 6.3-6.3z"/></svg>
            </button>
          </div>
        </div>
        <div class="lo-chat-body" id="lo-chat-body" aria-live="polite"></div>
        <div class="lo-quick-replies" id="lo-quick-replies"></div>
        <div class="lo-chat-attachment-preview" id="lo-chat-attachment-preview" hidden></div>
        <div class="lo-chat-footer" id="lo-chat-footer">
          <input
            type="file"
            id="lo-chat-file-input"
            accept="image/jpeg,image/png,application/pdf"
            hidden
          />
          <button
            type="button"
            class="lo-chat-attach-btn"
            id="lo-chat-attach-btn"
            aria-label="Adjuntar foto o documento"
            title="Adjuntar foto o documento (JPG, PNG, PDF · máx. 5 MB)"
          >
            <svg viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5S13.5 3.62 13.5 5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
          </button>
          <textarea
            class="lo-chat-input"
            id="lo-chat-input"
            rows="1"
            maxlength="4000"
            placeholder="Escribe tu mensaje..."
            aria-label="Escribe tu mensaje"
          ></textarea>
          <div class="lo-recording-bar" id="lo-recording-bar" hidden>
            <span class="lo-recording-cancel-hint">
              <span class="lo-recording-cancel-arrow" aria-hidden="true">←</span>
              <span id="lo-recording-cancel-label">Desliza para cancelar</span>
            </span>
            <span class="lo-recording-meta">
              <span class="lo-recording-dot" aria-hidden="true"></span>
              <span class="lo-recording-timer" id="lo-recording-timer">0:00</span>
            </span>
            <canvas class="lo-recording-waveform" id="lo-recording-waveform" width="64" height="24" aria-hidden="true"></canvas>
          </div>
          <button type="button" class="lo-chat-send" id="lo-chat-send" aria-label="Enviar mensaje">
            <svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          </button>
          <button
            type="button"
            class="lo-mic-btn"
            id="lo-chat-mic-btn"
            hidden
            aria-label="Grabar nota de voz (mantén presionado)"
            title="Grabar nota de voz (mantén presionado)"
          >
            <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a1 1 0 0 0-2 0 3 3 0 0 1-6 0 1 1 0 0 0-2 0 5 5 0 0 0 4 4.9V18H9a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2h-2v-2.1A5 5 0 0 0 17 11z"/></svg>
          </button>
        </div>
        <span class="lo-sr-only" aria-live="polite" id="lo-voice-sr-status"></span>
        <div class="lo-chat-disclaimer">${escapeHtml(CONFIG.disclaimer)}</div>
      </div>
      <button type="button" class="lo-chat-launcher" id="lo-chat-launcher" aria-label="Abrir chat">
        <span class="lo-launcher-icon lo-icon-chat">${AVATAR_FALLBACK_SVG}${avatarPhotoHtml()}</span>
        <svg class="lo-launcher-icon lo-icon-close" viewBox="0 0 24 24"><path d="M18.3 5.71L12 12.01l-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.29 1.4 1.4 6.3-6.29 6.3 6.29 1.4-1.4-6.3-6.29 6.3-6.3z"/></svg>
        <span class="lo-chat-badge" id="lo-chat-badge">1</span>
      </button>
    `;
    document.body.appendChild(root);
    return root;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str == null ? "" : str);
    return div.innerHTML;
  }

  function formatTime(date) {
    try {
      return new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit" }).format(date);
    } catch (_e) {
      return date.toTimeString().slice(0, 5);
    }
  }

  function formatFileSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Da formato "m:ss" a una duración en segundos (timer de grabación, notas de voz). */
  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  /** Resuelve una URL relativa del servidor (p. ej. "/uploads/xyz") contra el mismo
   *  origen que CONFIG.apiUrl — necesario porque el widget puede estar incrustado
   *  en un dominio distinto al del backend (ver README, integración cross-domain). */
  function resolveAssetUrl(url) {
    if (!url) return url;
    if (/^https?:\/\//i.test(url)) return url;
    const base = CONFIG.apiUrl.replace(/\/api\/chat\/?$/, "");
    return base + url;
  }

  // -------------------------------------------------------------------------
  // Persistencia local (best-effort; el chat funciona igual si falla)
  // -------------------------------------------------------------------------

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(CONFIG.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_e) {
      /* almacenamiento no disponible: seguimos sin historial persistido */
    }
    return [];
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(CONFIG.storageKey, JSON.stringify(conversation));
    } catch (_e) {
      /* ignorar: modo privado, cuota excedida, etc. */
    }
  }

  // -------------------------------------------------------------------------
  // Render de mensajes
  // -------------------------------------------------------------------------

  /**
   * Construye el thumbnail/chip clicable de un adjunto (imagen o PDF) para
   * mostrarlo dentro de una burbuja de mensaje.
   */
  function buildAttachmentEl(attachment) {
    const url = resolveAssetUrl(attachment.url || `/uploads/${attachment.fileId}`);

    if (attachment.kind === "video") {
      return buildVideoPlayerEl(url, attachment);
    }

    if (attachment.kind === "audio") {
      return attachment.generatedBy === "lucy" ? buildLucyAudioPlayerEl(url, attachment) : buildAudioPlayerEl(url, attachment);
    }

    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "lo-msg-attachment";

    if (attachment.kind === "image") {
      const img = document.createElement("img");
      img.src = url;
      img.alt = attachment.filename || "Imagen adjunta";
      img.loading = "lazy";
      link.appendChild(img);
    } else {
      link.classList.add("lo-msg-attachment-file");
      const icon = document.createElement("span");
      icon.className = "lo-msg-attachment-icon";
      icon.textContent = "📄";
      const name = document.createElement("span");
      name.className = "lo-msg-attachment-name";
      name.textContent = attachment.filename || "Documento adjunto";
      link.appendChild(icon);
      link.appendChild(name);
    }

    return link;
  }

  /**
   * Construye el reproductor de un video explicativo de Lucy: <video> HTML5 con
   * controles nativos, poster (primer frame) mientras carga, ancho máx. 280px / alto
   * máx. 200px (ver .lo-msg-video en chatbot.css).
   */
  function buildVideoPlayerEl(url, attachment) {
    const wrap = document.createElement("div");
    wrap.className = "lo-msg-video-wrap";

    const video = document.createElement("video");
    video.className = "lo-msg-video";
    video.controls = true;
    video.preload = "metadata";
    video.src = url;
    if (attachment.posterUrl) video.poster = resolveAssetUrl(attachment.posterUrl);
    if (attachment.title) video.setAttribute("aria-label", attachment.title);

    // Un solo audio/video suena a la vez en todo el chat (mismo registro que usan los
    // reproductores de audio — ver registerActiveAudio más abajo).
    video.addEventListener("play", () => registerActiveAudio({ pause: () => video.pause() }));

    wrap.appendChild(video);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Imágenes/infografías de Lucy (catálogo de material visual) — burbuja con
  // bordes redondeados, botón de descarga, y lightbox de pantalla completa al
  // hacer clic.
  // -------------------------------------------------------------------------

  /** Overlay de lightbox actualmente abierto (o null) — un solo <div>, reutilizado,
   *  para no acumular overlays huérfanos si se abre más de uno seguido. */
  let lightboxOverlayEl = null;

  function openImageLightbox(url, title) {
    closeImageLightbox();
    const overlay = document.createElement("div");
    overlay.className = "lo-lightbox-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", title || "Imagen ampliada");
    overlay.innerHTML = `
      <button type="button" class="lo-lightbox-close" aria-label="Cerrar imagen">✕</button>
      <img class="lo-lightbox-img" src="${escapeHtml(url)}" alt="${escapeHtml(title || "Imagen")}" />
    `;
    // Clic en el fondo (no en la imagen) también cierra, como cualquier lightbox.
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeImageLightbox();
    });
    overlay.querySelector(".lo-lightbox-close").addEventListener("click", closeImageLightbox);
    document.body.appendChild(overlay);
    lightboxOverlayEl = overlay;
  }

  function closeImageLightbox() {
    if (lightboxOverlayEl) {
      lightboxOverlayEl.remove();
      lightboxOverlayEl = null;
    }
  }

  /**
   * Construye la burbuja de una imagen/infografía de Lucy: bordes redondeados, ancho
   * máx. 280px, botón de descarga (⬇️) en la esquina, y clic para abrir en lightbox
   * (overlay de pantalla completa) — ver .lo-msg-media-* / .lo-lightbox-* en
   * chatbot.css.
   */
  function buildLucyMediaPlayerEl(url, media) {
    const title = media.title || "Imagen";
    const downloadName = `${(media.mediaKey || "imagen").replace(/[^a-z0-9-]/gi, "-")}.png`;

    const wrap = document.createElement("div");
    wrap.className = "lo-msg-media-wrap";
    wrap.innerHTML = `
      <button type="button" class="lo-msg-media-btn" aria-label="Ver imagen en pantalla completa: ${escapeHtml(title)}">
        <img class="lo-msg-media-img" src="${escapeHtml(url)}" alt="${escapeHtml(title)}" loading="lazy" />
      </button>
      <a
        class="lo-msg-media-download"
        href="${escapeHtml(url)}"
        download="${escapeHtml(downloadName)}"
        aria-label="Descargar imagen"
        title="Descargar imagen"
        >⬇️</a
      >
    `;
    wrap.querySelector(".lo-msg-media-btn").addEventListener("click", () => openImageLightbox(url, title));
    return wrap;
  }

  const AUDIO_WAVEFORM_BAR_COUNT = 27;

  /** Genera alturas pseudoaleatorias pero deterministas (mismo fileId -> mismo dibujo
   *  siempre) para el waveform simple de una nota de voz — no hay análisis real del
   *  audio en el cliente, es un detalle visual estilo WhatsApp/Telegram. */
  function seededWaveformHeights(seed, count) {
    let h = 0;
    const str = String(seed || "audio");
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    const heights = [];
    for (let i = 0; i < count; i++) {
      h = (Math.imul(h, 1103515245) + 12345) >>> 0;
      heights.push(0.22 + (h % 1000) / 1000 * 0.78); // entre 22% y 100% de alto
    }
    return heights;
  }

  /**
   * Construye el reproductor compacto (▶/⏸ + waveform simple + tiempo) para una nota
   * de voz dentro de una burbuja de mensaje, con la transcripción automática (Whisper)
   * debajo si está disponible. Un solo audio suena a la vez: al reproducir uno,
   * cualquier otro audio del chat que esté sonando se pausa.
   */
  function buildAudioPlayerEl(url, attachment) {
    const totalDuration = Number(attachment.duration) || 0;
    const transcript = String(attachment.transcript || "").trim();
    const heights = seededWaveformHeights(attachment.fileId || url, AUDIO_WAVEFORM_BAR_COUNT);
    const barsHtml = heights
      .map((h) => `<span class="lo-audio-bar" style="height:${Math.round(h * 100)}%"></span>`)
      .join("");

    const wrap = document.createElement("div");
    wrap.className = "lo-msg-audio-wrap";
    wrap.innerHTML = `
      <div class="lo-msg-audio">
        <button type="button" class="lo-audio-play" aria-label="Reproducir nota de voz">
          <svg class="lo-audio-icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <svg class="lo-audio-icon-pause" viewBox="0 0 24 24" hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
        </button>
        <div class="lo-audio-body">
          <div class="lo-audio-waveform" aria-hidden="true">${barsHtml}</div>
          <span class="lo-audio-time">${escapeHtml(formatDuration(totalDuration))}</span>
        </div>
        <audio preload="none" src="${escapeHtml(url)}"></audio>
      </div>
      ${transcript ? `<p class="lo-audio-transcript">📝 Transcripción: ${escapeHtml(transcript)}</p>` : ""}
    `;

    const audio = wrap.querySelector("audio");
    const playBtn = wrap.querySelector(".lo-audio-play");
    const iconPlay = wrap.querySelector(".lo-audio-icon-play");
    const iconPause = wrap.querySelector(".lo-audio-icon-pause");
    const bars = wrap.querySelectorAll(".lo-audio-bar");
    const timeLabel = wrap.querySelector(".lo-audio-time");

    function setPlayedBars(ratio) {
      const activeCount = Math.round(Math.min(1, Math.max(0, ratio)) * bars.length);
      bars.forEach((bar, i) => bar.classList.toggle("lo-audio-bar-played", i < activeCount));
    }

    playBtn.setAttribute("aria-label", "Reproducir nota de voz");
    playBtn.addEventListener("click", () => {
      if (audio.paused) {
        registerActiveAudio({ pause: () => audio.pause() });
        audio.play().catch(() => {
          appendMessageEl("error", "No se pudo reproducir la nota de voz.");
        });
      } else {
        audio.pause();
      }
    });

    audio.addEventListener("play", () => {
      iconPlay.hidden = true;
      iconPause.hidden = false;
      playBtn.setAttribute("aria-label", "Pausar nota de voz");
    });
    audio.addEventListener("pause", () => {
      iconPlay.hidden = false;
      iconPause.hidden = true;
      playBtn.setAttribute("aria-label", "Reproducir nota de voz");
    });
    audio.addEventListener("ended", () => {
      setPlayedBars(0);
      timeLabel.textContent = formatDuration(totalDuration);
    });
    audio.addEventListener("timeupdate", () => {
      const dur = audio.duration && isFinite(audio.duration) ? audio.duration : totalDuration;
      if (dur > 0) setPlayedBars(audio.currentTime / dur);
      timeLabel.textContent = formatDuration(Math.max(0, dur - audio.currentTime));
    });

    return wrap;
  }

  // -------------------------------------------------------------------------
  // Respuestas de Lucy en audio (texto-a-voz) — burbuja especial con waveform
  // animada (wavesurfer.js, cargada perezosamente desde CDN), transcripción
  // colapsable y botón de descarga.
  // -------------------------------------------------------------------------

  /** Solo un audio suena a la vez en todo el chat (notas de voz del usuario Y
   *  respuestas de Lucy comparten este registro) — reproducir uno pausa al anterior. */
  let activeAudioController = null;
  function registerActiveAudio(controller) {
    if (activeAudioController && activeAudioController !== controller) {
      activeAudioController.pause();
    }
    activeAudioController = controller;
  }

  const WAVESURFER_CDN_URL = "https://unpkg.com/wavesurfer.js@7.12.11/dist/wavesurfer.min.js";
  let wavesurferLoadPromise = null;

  /** Carga wavesurfer.js una sola vez (perezoso: solo cuando Lucy envía su primer
   *  audio), y reutiliza la misma promesa en cargas posteriores. Devuelve `true` si
   *  quedó disponible, `false` si el script no cargó (el reproductor cae a una
   *  waveform estática, igual que las notas de voz del usuario). */
  function ensureWaveSurferLoaded() {
    if (window.WaveSurfer) return Promise.resolve(true);
    if (wavesurferLoadPromise) return wavesurferLoadPromise;
    wavesurferLoadPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = WAVESURFER_CDN_URL;
      script.async = true;
      script.onload = () => resolve(Boolean(window.WaveSurfer));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
    return wavesurferLoadPromise;
  }

  /**
   * Construye la burbuja especial de una respuesta de Lucy en audio: waveform animada
   * (wavesurfer.js) que se pinta mientras reproduce, transcripción colapsable ("Ver
   * transcripción ▼") y botón de descarga. El avatar de Lucy ya lo pone la fila del
   * mensaje (es una respuesta del asistente); esta burbuja se inserta encima del texto
   * ya mostrado. Si wavesurfer.js no llega a cargar, se degrada a una waveform estática
   * (mismo dibujo que usa buildAudioPlayerEl) sin romper el reproductor.
   */
  function buildLucyAudioPlayerEl(url, attachment) {
    const totalDuration = Number(attachment.duration) || 0;
    const transcript = String(attachment.transcript || "").trim();
    const downloadName = `lucy-${(attachment.fileId || "audio").slice(0, 8)}.mp3`;

    const wrap = document.createElement("div");
    wrap.className = "lo-lucy-audio-wrap";
    wrap.innerHTML = `
      <div class="lo-lucy-audio">
        <button type="button" class="lo-audio-play lo-lucy-audio-play" aria-label="Reproducir respuesta en audio">
          <svg class="lo-audio-icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <svg class="lo-audio-icon-pause" viewBox="0 0 24 24" hidden><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
        </button>
        <div class="lo-lucy-audio-body">
          <div class="lo-lucy-waveform"></div>
          <span class="lo-audio-time">${escapeHtml(formatDuration(totalDuration))}</span>
        </div>
        <a
          class="lo-lucy-audio-download"
          href="${escapeHtml(url)}"
          download="${escapeHtml(downloadName)}"
          aria-label="Descargar audio"
          title="Descargar audio"
          >⬇️</a
        >
      </div>
      ${
        transcript
          ? `<details class="lo-lucy-audio-transcript">
               <summary>Ver transcripción <span class="lo-lucy-transcript-arrow">▼</span></summary>
               <p>${escapeHtml(transcript)}</p>
             </details>`
          : ""
      }
    `;

    const playBtn = wrap.querySelector(".lo-lucy-audio-play");
    const iconPlay = wrap.querySelector(".lo-audio-icon-play");
    const iconPause = wrap.querySelector(".lo-audio-icon-pause");
    const timeLabel = wrap.querySelector(".lo-audio-time");
    const waveformContainer = wrap.querySelector(".lo-lucy-waveform");

    // wavesurfer necesita que su contenedor ya esté en el documento (con un ancho
    // real) para dibujar — se inicializa en el siguiente frame, después de que quien
    // llama haya insertado `wrap` en el chat (ver el evento SSE "audio" y openChat()).
    requestAnimationFrame(() => {
      ensureWaveSurferLoaded().then((loaded) => {
        if (!loaded || !waveformContainer.isConnected) {
          setupFallbackWaveform();
          return;
        }
        setupWaveSurferPlayer();
      });
    });

    function setupWaveSurferPlayer() {
      let wavesurfer;
      try {
        wavesurfer = window.WaveSurfer.create({
          container: waveformContainer,
          waveColor: "#d9dcda",
          progressColor: "#00bf63",
          cursorWidth: 0,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          height: 30,
          url,
        });
      } catch (_e) {
        setupFallbackWaveform();
        return;
      }

      playBtn.addEventListener("click", () => {
        registerActiveAudio({ pause: () => wavesurfer.pause() });
        wavesurfer.playPause();
      });
      wavesurfer.on("play", () => {
        iconPlay.hidden = true;
        iconPause.hidden = false;
        playBtn.setAttribute("aria-label", "Pausar respuesta en audio");
      });
      wavesurfer.on("pause", () => {
        iconPlay.hidden = false;
        iconPause.hidden = true;
        playBtn.setAttribute("aria-label", "Reproducir respuesta en audio");
      });
      wavesurfer.on("finish", () => {
        timeLabel.textContent = formatDuration(wavesurfer.getDuration() || totalDuration);
      });
      wavesurfer.on("timeupdate", (currentTime) => {
        const dur = wavesurfer.getDuration() || totalDuration;
        timeLabel.textContent = formatDuration(Math.max(0, dur - currentTime));
      });
      wavesurfer.on("ready", () => {
        timeLabel.textContent = formatDuration(wavesurfer.getDuration() || totalDuration);
      });
    }

    /** Reproductor sin wavesurfer (CDN no cargó): mismo <audio> nativo + waveform
     *  estática que usan las notas de voz del usuario, para que igual funcione. */
    function setupFallbackWaveform() {
      const heights = seededWaveformHeights(attachment.fileId || url, AUDIO_WAVEFORM_BAR_COUNT);
      waveformContainer.innerHTML = heights
        .map((h) => `<span class="lo-audio-bar" style="height:${Math.round(h * 100)}%"></span>`)
        .join("");
      waveformContainer.classList.add("lo-audio-waveform");

      const audio = document.createElement("audio");
      audio.preload = "none";
      audio.src = url;
      wrap.appendChild(audio);

      const bars = waveformContainer.querySelectorAll(".lo-audio-bar");
      function setPlayedBars(ratio) {
        const activeCount = Math.round(Math.min(1, Math.max(0, ratio)) * bars.length);
        bars.forEach((bar, i) => bar.classList.toggle("lo-audio-bar-played", i < activeCount));
      }

      playBtn.addEventListener("click", () => {
        if (audio.paused) {
          registerActiveAudio({ pause: () => audio.pause() });
          audio.play().catch(() => {
            appendMessageEl("error", "No se pudo reproducir el audio.");
          });
        } else {
          audio.pause();
        }
      });
      audio.addEventListener("play", () => {
        iconPlay.hidden = true;
        iconPause.hidden = false;
      });
      audio.addEventListener("pause", () => {
        iconPlay.hidden = false;
        iconPause.hidden = true;
      });
      audio.addEventListener("ended", () => {
        setPlayedBars(0);
        timeLabel.textContent = formatDuration(totalDuration);
      });
      audio.addEventListener("timeupdate", () => {
        const dur = audio.duration && isFinite(audio.duration) ? audio.duration : totalDuration;
        if (dur > 0) setPlayedBars(audio.currentTime / dur);
        timeLabel.textContent = formatDuration(Math.max(0, dur - audio.currentTime));
      });
    }

    return wrap;
  }

  /**
   * Agrega una fila de mensaje (avatar + adjunto opcional + burbuja + hora) al
   * cuerpo del chat. `role` puede ser "user", "assistant" o "error".
   */
  function appendMessageEl(role, text, time, attachment, media) {
    const body = document.getElementById("lo-chat-body");
    const isUser = role === "user";
    const bubbleClass = isUser ? "lo-msg-user" : role === "error" ? "lo-msg-error" : "lo-msg-bot";
    const timeLabel = formatTime(time || new Date());

    const row = document.createElement("div");
    row.className = `lo-msg-row ${isUser ? "lo-row-user" : "lo-row-bot"}`;

    if (!isUser) {
      row.insertAdjacentHTML("beforeend", avatarHtml("sm"));
    }

    const col = document.createElement("div");
    col.className = "lo-msg-col";
    const hasAttachment = Boolean(attachment && (attachment.fileId || attachment.videoKey));

    // Los videos van DESPUÉS del texto ("Te envío este video explicativo 👇" antes
    // del reproductor); el resto de adjuntos (fotos, documentos, notas de voz) van
    // ANTES de su burbuja de texto, como siempre.
    if (hasAttachment && attachment.kind !== "video") {
      col.appendChild(buildAttachmentEl(attachment));
    }

    const bubble = document.createElement("div");
    bubble.className = `lo-msg ${bubbleClass}`;
    bubble.textContent = text;
    col.appendChild(bubble);

    if (hasAttachment && attachment.kind === "video") {
      col.appendChild(buildAttachmentEl(attachment));
    }

    // `media` (imagen/infografía del catálogo de Lucy) va después de la burbuja de
    // texto, en el mismo mensaje — es un campo aparte de `attachment` para poder
    // convivir con el audio de la respuesta sin pisarse (ver server.js).
    if (media && media.mediaKey) {
      col.appendChild(buildLucyMediaPlayerEl(resolveAssetUrl(media.url), media));
    }

    const time_ = document.createElement("span");
    time_.className = "lo-msg-time";
    time_.textContent = timeLabel;
    col.appendChild(time_);

    row.appendChild(col);
    body.appendChild(row);
    scrollToBottom();

    return bubble;
  }

  function appendSystemNote(text) {
    const body = document.getElementById("lo-chat-body");
    const el = document.createElement("div");
    el.className = "lo-msg lo-msg-system";
    el.textContent = text;
    body.appendChild(el);
    scrollToBottom();
    return el;
  }

  /**
   * Botón "📍 Compartir mi ubicación" — aparece cuando el flujo de apertura de un
   * siniestro llega al paso de ubicación (evento SSE "location_request", ver
   * handleSiniestroFlowGate en server.js). Usa la Geolocation API del navegador; si el
   * usuario la deniega o no está disponible, simplemente puede escribir la dirección a
   * mano (el paso acepta texto libre igual). Se autoelimina al usarse o al enviar
   * cualquier otro mensaje mientras tanto (ver clearLocationRequestButton).
   */
  function appendLocationRequestButton() {
    clearLocationRequestButton();
    const body = document.getElementById("lo-chat-body");
    const wrap = document.createElement("div");
    wrap.className = "lo-location-request";
    wrap.id = "lo-location-request";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lo-location-btn";
    btn.textContent = "📍 Compartir mi ubicación";
    btn.addEventListener("click", () => {
      if (!navigator.geolocation) {
        appendSystemNote("Tu navegador no soporta compartir ubicación — puedes escribir la dirección en el chat.");
        clearLocationRequestButton();
        return;
      }
      btn.disabled = true;
      btn.textContent = "Obteniendo ubicación…";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearLocationRequestButton();
          const { latitude, longitude } = pos.coords;
          sendMessage(`📍 Mi ubicación: https://www.google.com/maps?q=${latitude},${longitude}`);
        },
        () => {
          appendSystemNote("No pude acceder a tu ubicación — puedes escribir la dirección en el chat.");
          clearLocationRequestButton();
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
    wrap.appendChild(btn);
    body.appendChild(wrap);
    scrollToBottom();
  }

  function clearLocationRequestButton() {
    const existing = document.getElementById("lo-location-request");
    if (existing) existing.remove();
  }

  function scrollToBottom() {
    const body = document.getElementById("lo-chat-body");
    body.scrollTop = body.scrollHeight;
  }

  function showTyping() {
    hideTyping();
    const body = document.getElementById("lo-chat-body");
    const row = document.createElement("div");
    row.className = "lo-typing-row";
    row.id = "lo-typing-indicator";
    row.innerHTML = `
      ${avatarHtml("sm")}
      <div class="lo-typing">
        <span class="lo-typing-label">${escapeHtml(CONFIG.assistantName)} está escribiendo</span>
        <span class="lo-typing-dots"><span></span><span></span><span></span></span>
      </div>
    `;
    body.appendChild(row);
    scrollToBottom();
  }

  function hideTyping() {
    const existing = document.getElementById("lo-typing-indicator");
    if (existing) existing.remove();
  }

  function renderQuickReplies() {
    const container = document.getElementById("lo-quick-replies");
    container.innerHTML = "";
    if (!CONFIG.quickReplies || CONFIG.quickReplies.length === 0) return;
    CONFIG.quickReplies.forEach((label) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lo-quick-reply";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        if (isSending) return;
        sendMessage(label);
      });
      container.appendChild(btn);
    });
  }

  function setQuickRepliesVisible(visible) {
    const container = document.getElementById("lo-quick-replies");
    container.style.display = visible ? "flex" : "none";
  }

  // -------------------------------------------------------------------------
  // Adjuntos (fotos de siniestros/vehículos, documentos — botón 📎)
  // -------------------------------------------------------------------------

  const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
  const ATTACHMENT_ALLOWED_TYPES = ["image/jpeg", "image/png", "application/pdf"];

  /** Adjunto ya subido, listo para ir en el próximo mensaje enviado (o null). */
  let pendingAttachment = null;
  let isUploadingAttachment = false;

  function deriveUploadUrl() {
    if (CONFIG.uploadUrl) return CONFIG.uploadUrl;
    return CONFIG.apiUrl.replace(/\/api\/chat\/?$/, "/api/upload");
  }

  function defaultCaptionForAttachment(attachment) {
    if (attachment.kind === "pdf") {
      return `📄 Documento adjunto: ${attachment.filename}`;
    }
    if (attachment.kind === "audio") {
      return `🎤 Nota de voz (${formatDuration(attachment.duration)})`;
    }
    return "📷 Foto adjunta";
  }

  function setAttachControlsEnabled(enabled) {
    const attachBtn = document.getElementById("lo-chat-attach-btn");
    if (attachBtn) attachBtn.disabled = !enabled;
    const micBtn = document.getElementById("lo-chat-mic-btn");
    if (micBtn && AUDIO_RECORDING_SUPPORTED) micBtn.disabled = !enabled;
  }

  function renderAttachmentPreview(info) {
    const wrap = document.getElementById("lo-chat-attachment-preview");
    wrap.hidden = false;

    const thumbHtml =
      info.kind === "image" && info.previewUrl
        ? `<img src="${escapeHtml(info.previewUrl)}" alt="" class="lo-attach-thumb" />`
        : `<span class="lo-attach-file-icon">📄</span>`;

    wrap.innerHTML = `
      <div class="lo-attach-chip${info.uploading ? " lo-attach-uploading" : ""}">
        ${thumbHtml}
        <div class="lo-attach-info">
          <span class="lo-attach-name">${escapeHtml(info.filename)}</span>
          <span class="lo-attach-meta">${info.uploading ? "Subiendo…" : escapeHtml(formatFileSize(info.size))}</span>
        </div>
        <button type="button" class="lo-attach-remove" aria-label="Quitar adjunto"${
          info.uploading ? " disabled" : ""
        }>✕</button>
      </div>
    `;

    const removeBtn = wrap.querySelector(".lo-attach-remove");
    if (removeBtn) removeBtn.addEventListener("click", clearPendingAttachment);
  }

  function clearPendingAttachment() {
    pendingAttachment = null;
    const wrap = document.getElementById("lo-chat-attachment-preview");
    wrap.hidden = true;
    wrap.innerHTML = "";
    const fileInput = document.getElementById("lo-chat-file-input");
    if (fileInput) fileInput.value = "";
    updateMicSendToggle();
  }

  async function handleFileSelected(file) {
    if (!file) return;

    if (!ATTACHMENT_ALLOWED_TYPES.includes(file.type)) {
      appendMessageEl("error", "Solo se aceptan imágenes JPG/PNG o documentos PDF.");
      const fileInput = document.getElementById("lo-chat-file-input");
      if (fileInput) fileInput.value = "";
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      appendMessageEl("error", "El archivo supera el límite de 5 MB.");
      const fileInput = document.getElementById("lo-chat-file-input");
      if (fileInput) fileInput.value = "";
      return;
    }

    const kind = file.type === "application/pdf" ? "pdf" : "image";
    const localPreviewUrl = kind === "image" ? URL.createObjectURL(file) : null;

    isUploadingAttachment = true;
    setAttachControlsEnabled(false);
    setSendEnabled(false);
    renderAttachmentPreview({ uploading: true, kind, filename: file.name, previewUrl: localPreviewUrl });

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("sessionId", sessionId);

      const response = await fetch(deriveUploadUrl(), { method: "POST", body: formData });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "No se pudo subir el archivo. Intenta de nuevo.");
      }

      pendingAttachment = {
        fileId: data.fileId,
        kind: data.kind,
        mimetype: data.mimetype,
        filename: data.filename,
        size: data.size,
        url: data.url,
      };
      renderAttachmentPreview({
        uploading: false,
        kind: pendingAttachment.kind,
        filename: pendingAttachment.filename,
        size: pendingAttachment.size,
        previewUrl: pendingAttachment.kind === "image" ? resolveAssetUrl(pendingAttachment.url) : null,
      });
    } catch (err) {
      clearPendingAttachment();
      appendMessageEl("error", err.message || "No se pudo subir el archivo. Intenta de nuevo.");
      console.error("[La Occidental Chatbot] Error al subir adjunto:", err);
    } finally {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
      isUploadingAttachment = false;
      setAttachControlsEnabled(true);
      setSendEnabled(true);
      updateMicSendToggle();
    }
  }

  // -------------------------------------------------------------------------
  // Grabación de voz (nota de voz) — botón de micrófono estilo WhatsApp:
  // mantener presionado para grabar, soltar para enviar, deslizar hacia la
  // izquierda para cancelar. Ver también el estado declarado al inicio del archivo.
  // -------------------------------------------------------------------------

  /** Primer plano/segundo plano del botón derecho del footer: mientras se escribe
   *  texto o hay un adjunto listo, se muestra "Enviar"; si no, el micrófono (salvo
   *  que el navegador no soporte grabación, en cuyo caso "Enviar" es siempre visible). */
  function updateMicSendToggle() {
    const sendBtn = document.getElementById("lo-chat-send");
    const micBtn = document.getElementById("lo-chat-mic-btn");
    if (!sendBtn || !micBtn) return;

    if (!AUDIO_RECORDING_SUPPORTED) {
      // El ícono de micrófono se deja visible pero inerte (disabled + tooltip
      // explicativo, ver init()); el botón de enviar nunca se oculta en este caso.
      sendBtn.hidden = false;
      return;
    }

    if (isRecording) {
      micBtn.hidden = false;
      sendBtn.hidden = true;
      return;
    }

    const input = document.getElementById("lo-chat-input");
    const hasContent = Boolean((input && input.value.trim()) || pendingAttachment);
    micBtn.hidden = hasContent;
    sendBtn.hidden = !hasContent;
  }

  function announceToScreenReader(text) {
    const el = document.getElementById("lo-voice-sr-status");
    if (el) el.textContent = text;
  }

  function hasSeenMicIntro() {
    try {
      return localStorage.getItem(MIC_INTRO_SEEN_KEY) === "1";
    } catch (_e) {
      return false;
    }
  }

  function markMicIntroSeen() {
    try {
      localStorage.setItem(MIC_INTRO_SEEN_KEY, "1");
    } catch (_e) {
      /* almacenamiento no disponible: se volverá a mostrar el mensaje la próxima vez */
    }
  }

  function getSupportedAudioMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
    for (const candidate of AUDIO_MIME_CANDIDATES) {
      try {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate;
      } catch (_e) {
        /* seguir probando el siguiente candidato */
      }
    }
    return null;
  }

  function setRecordingTimerLabel(elapsedSeconds) {
    const el = document.getElementById("lo-recording-timer");
    if (el) el.textContent = formatDuration(elapsedSeconds);
  }

  function setCancelHintActive(active) {
    const footer = document.getElementById("lo-chat-footer");
    const label = document.getElementById("lo-recording-cancel-label");
    if (footer) footer.classList.toggle("lo-recording-cancelling", active);
    if (label) label.textContent = active ? "Suelta para cancelar" : "Desliza para cancelar";
  }

  /** Dibuja el waveform en tiempo real leyendo el nivel de audio con un AnalyserNode
   *  (Web Audio API). Si algo falla (navegador sin soporte, etc.) la grabación sigue
   *  funcionando igual — el waveform es un detalle visual, no crítico. */
  function setupRecordingWaveform(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      recordingAudioCtx = new AudioCtx();
      const source = recordingAudioCtx.createMediaStreamSource(stream);
      recordingAnalyser = recordingAudioCtx.createAnalyser();
      recordingAnalyser.fftSize = 64;
      recordingAnalyser.smoothingTimeConstant = 0.6;
      source.connect(recordingAnalyser);

      const canvas = document.getElementById("lo-recording-waveform");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const data = new Uint8Array(recordingAnalyser.frequencyBinCount);
      const barCount = 10;

      const draw = () => {
        if (!isRecording || !recordingAnalyser) return;
        recordingWaveformRaf = requestAnimationFrame(draw);
        recordingAnalyser.getByteFrequencyData(data);
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#e6453b";
        const step = Math.max(1, Math.floor(data.length / barCount));
        const barWidth = w / barCount;
        for (let i = 0; i < barCount; i++) {
          const value = data[i * step] || 0;
          const barHeight = Math.max(2, (value / 255) * h);
          const x = i * barWidth;
          const y = (h - barHeight) / 2;
          ctx.fillRect(x + 1, y, Math.max(1.5, barWidth - 2), barHeight);
        }
      };
      draw();
    } catch (_e) {
      // Sin waveform: la grabación (timer, envío) sigue funcionando con normalidad.
      recordingAnalyser = null;
    }
  }

  function cleanupRecordingResources() {
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
    if (recordingMaxTimeout) {
      clearTimeout(recordingMaxTimeout);
      recordingMaxTimeout = null;
    }
    if (recordingWaveformRaf) {
      cancelAnimationFrame(recordingWaveformRaf);
      recordingWaveformRaf = null;
    }
    if (recordingAudioCtx) {
      recordingAudioCtx.close().catch(() => {});
      recordingAudioCtx = null;
    }
    recordingAnalyser = null;
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    mediaRecorder = null;
  }

  function enterRecordingUI() {
    const input = document.getElementById("lo-chat-input");
    const attachBtn = document.getElementById("lo-chat-attach-btn");
    const recordingBar = document.getElementById("lo-recording-bar");
    const micBtn = document.getElementById("lo-chat-mic-btn");

    if (input) input.hidden = true;
    if (attachBtn) attachBtn.hidden = true;
    if (recordingBar) recordingBar.hidden = false;
    if (micBtn) {
      micBtn.classList.add("lo-mic-btn-recording");
      micBtn.setAttribute(
        "aria-label",
        "Grabando nota de voz. Suelta para enviar, desliza a la izquierda para cancelar."
      );
    }
    setCancelHintActive(false);
    updateMicSendToggle();
  }

  function exitRecordingUI() {
    const input = document.getElementById("lo-chat-input");
    const attachBtn = document.getElementById("lo-chat-attach-btn");
    const recordingBar = document.getElementById("lo-recording-bar");
    const micBtn = document.getElementById("lo-chat-mic-btn");
    const footer = document.getElementById("lo-chat-footer");

    if (input) input.hidden = false;
    if (attachBtn) attachBtn.hidden = false;
    if (recordingBar) recordingBar.hidden = true;
    if (footer) footer.classList.remove("lo-recording-cancelling");
    if (micBtn) {
      micBtn.classList.remove("lo-mic-btn-recording");
      micBtn.style.transform = "";
      micBtn.setAttribute("aria-label", "Grabar nota de voz (mantén presionado)");
    }
    setRecordingTimerLabel(0);
    updateMicSendToggle();
  }

  async function beginRecording() {
    if (isRecording || isSending || isUploadingAttachment) return;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      appendMessageEl(
        "error",
        "No se pudo acceder al micrófono. Revisa los permisos de tu navegador e intenta de nuevo."
      );
      console.error("[La Occidental Chatbot] Error al acceder al micrófono:", err);
      return;
    }

    selectedAudioMimeType = getSupportedAudioMimeType();
    try {
      mediaRecorder = new MediaRecorder(stream, selectedAudioMimeType ? { mimeType: selectedAudioMimeType } : undefined);
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop());
      appendMessageEl("error", "Tu navegador no pudo iniciar la grabación de voz.");
      console.error("[La Occidental Chatbot] Error al crear MediaRecorder:", err);
      return;
    }

    mediaStream = stream;
    recordedChunks = [];
    isCancellingRecording = false;
    isRecording = true;

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) recordedChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", onRecordingStopped);

    recordingStartedAt = Date.now();
    mediaRecorder.start();

    enterRecordingUI();
    announceToScreenReader("Grabando nota de voz.");
    setRecordingTimerLabel(0);
    recordingTimerInterval = setInterval(() => {
      setRecordingTimerLabel((Date.now() - recordingStartedAt) / 1000);
    }, 200);
    setupRecordingWaveform(stream);
    recordingMaxTimeout = setTimeout(() => {
      if (isRecording) finishRecording(false);
    }, AUDIO_MAX_DURATION_MS);
  }

  /** Detiene la grabación en curso. `cancelled` decide si el audio se descarta
   *  (deslizar hasta cancelar, o Escape) o se envía (soltar el botón normalmente). */
  function finishRecording(cancelled) {
    if (!isRecording || !mediaRecorder) return;
    isCancellingRecording = cancelled;
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop(); // dispara onRecordingStopped de forma asíncrona
    }
  }

  function onRecordingStopped() {
    const cancelled = isCancellingRecording;
    const durationMs = Date.now() - recordingStartedAt;
    const chunks = recordedChunks;
    const mimeType = selectedAudioMimeType || (chunks[0] && chunks[0].type) || "audio/webm";

    cleanupRecordingResources();
    exitRecordingUI();
    recordedChunks = [];
    isCancellingRecording = false;
    isRecording = false;

    if (cancelled) {
      announceToScreenReader("Grabación cancelada.");
      return;
    }
    if (chunks.length === 0 || durationMs < AUDIO_MIN_DURATION_MS) {
      return; // toque accidental / grabación demasiado corta: se descarta en silencio
    }

    const blob = new Blob(chunks, { type: mimeType });
    uploadAndSendAudio(blob, Math.round(durationMs / 1000), mimeType);
  }

  /** Sube la nota de voz grabada (igual que un adjunto de foto/documento) y la envía
   *  de inmediato como el siguiente mensaje — sin paso de confirmación intermedio,
   *  igual que en WhatsApp: soltar el micrófono ya implica "enviar". */
  async function uploadAndSendAudio(blob, durationSec, mimeType) {
    const ext = mimeType && mimeType.includes("mp4") ? "m4a" : mimeType && mimeType.includes("ogg") ? "ogg" : "webm";
    const file = new File([blob], `nota-de-voz-${Date.now()}.${ext}`, { type: mimeType });

    isUploadingAttachment = true;
    setAttachControlsEnabled(false);
    setSendEnabled(false);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("sessionId", sessionId);
      formData.append("duration", String(durationSec));

      const response = await fetch(deriveUploadUrl(), { method: "POST", body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "No se pudo enviar la nota de voz. Intenta de nuevo.");
      }

      pendingAttachment = {
        fileId: data.fileId,
        kind: data.kind,
        mimetype: data.mimetype,
        filename: data.filename,
        size: data.size,
        url: data.url,
        duration: data.duration,
        transcript: data.transcript || null,
      };

      isUploadingAttachment = false;
      setAttachControlsEnabled(true);
      announceToScreenReader("Nota de voz enviada.");
      await sendMessage("");
    } catch (err) {
      appendMessageEl("error", err.message || "No se pudo enviar la nota de voz. Intenta de nuevo.");
      console.error("[La Occidental Chatbot] Error al enviar nota de voz:", err);
    } finally {
      isUploadingAttachment = false;
      setAttachControlsEnabled(true);
      setSendEnabled(true);
      updateMicSendToggle();
    }
  }

  /** Actualiza el "desliza para cancelar" a medida que se arrastra el dedo/mouse, y
   *  desplaza visualmente el botón (con el gesto) hacia la izquierda. */
  function updateRecordingDrag(deltaX) {
    const micBtn = document.getElementById("lo-chat-mic-btn");
    const clamped = Math.min(0, Math.max(-(RECORDING_CANCEL_DRAG_PX + 24), deltaX));
    if (micBtn) micBtn.style.transform = `translateX(${clamped}px)`;

    const shouldCancel = deltaX <= -RECORDING_CANCEL_DRAG_PX;
    if (shouldCancel !== isCancellingRecording) {
      isCancellingRecording = shouldCancel;
      setCancelHintActive(shouldCancel);
    }
  }

  function onMicPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return; // solo click principal / toque
    event.preventDefault();

    if (!hasSeenMicIntro()) {
      markMicIntroSeen();
      appendMessageEl(
        "assistant",
        "Para enviarme una nota de voz, mantén presionado el micrófono 🎙️ y suéltalo cuando termines de grabar " +
          "(deslízalo hacia la izquierda para cancelar). Tu navegador te pedirá permiso para usar el micrófono."
      );
      return; // la primera vez solo se explica el gesto; la grabación arranca desde el próximo toque
    }

    micPointerStartX = event.clientX;
    micPointerId = event.pointerId;
    const micBtn = document.getElementById("lo-chat-mic-btn");
    if (micBtn && micBtn.setPointerCapture && event.pointerId != null) {
      try {
        micBtn.setPointerCapture(event.pointerId);
      } catch (_e) {
        /* algunos navegadores móviles no soportan setPointerCapture en botones — se ignora */
      }
    }
    beginRecording();
  }

  function onMicPointerMove(event) {
    if (!isRecording || micPointerStartX == null) return;
    if (micPointerId != null && event.pointerId !== micPointerId) return;
    updateRecordingDrag(event.clientX - micPointerStartX);
  }

  function onMicPointerUp(event) {
    if (micPointerId != null && event.pointerId !== micPointerId) return;
    micPointerStartX = null;
    micPointerId = null;
    if (!isRecording) return;
    finishRecording(isCancellingRecording);
  }

  function onMicKeyDown(event) {
    if (event.code !== "Space" || event.repeat || isRecording) return;
    event.preventDefault();

    if (!hasSeenMicIntro()) {
      markMicIntroSeen();
      appendMessageEl(
        "assistant",
        "Mantén presionada la barra espaciadora para grabar una nota de voz y suéltala para enviarla " +
          "(presiona Escape para cancelar mientras grabas)."
      );
      return;
    }
    beginRecording();
  }

  function onMicKeyUp(event) {
    if (event.code !== "Space" || !isRecording) return;
    event.preventDefault();
    finishRecording(false);
  }

  // -------------------------------------------------------------------------
  // Envío de mensajes y streaming SSE
  // -------------------------------------------------------------------------

  async function sendMessage(text) {
    if (isSending || isUploadingAttachment) return;

    const trimmed = text.trim();
    const attachment = pendingAttachment;
    if (!trimmed && !attachment) return;

    clearLocationRequestButton();
    const finalText = trimmed || defaultCaptionForAttachment(attachment);

    isSending = true;
    setSendEnabled(false);
    setAttachControlsEnabled(false);
    setQuickRepliesVisible(false);
    clearPendingAttachment();

    appendMessageEl("user", finalText, undefined, attachment);
    conversation.push({
      role: "user",
      content: finalText,
      time: new Date().toISOString(),
      attachment: attachment
        ? {
            fileId: attachment.fileId,
            kind: attachment.kind,
            filename: attachment.filename,
            url: attachment.url,
            duration: attachment.duration,
            transcript: attachment.transcript,
          }
        : undefined,
    });
    saveHistory();

    const input = document.getElementById("lo-chat-input");
    input.value = "";
    autoResizeInput(input);

    // El cotizador automático se activa localmente (sin llamar a Lucy) cuando el
    // mensaje del usuario expresa intención de cotizar — ver sección "Cotizador
    // automático" más abajo. Esto evita que el modelo tenga que inventar precios.
    if (detectQuoteIntent(trimmed)) {
      isSending = false;
      setSendEnabled(true);
      setAttachControlsEnabled(true);
      updateMicSendToggle();
      startQuoteFlow();
      return;
    }

    showTyping();

    let assistantEl = null;
    let assistantText = "";
    let assistantAudioAttachment = null;
    let assistantMedia = null;
    let audioPendingNoteEl = null;

    try {
      const response = await fetch(CONFIG.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: conversation, sessionId }),
      });

      if (!response.ok) {
        let errMsg = "No se pudo contactar al asistente. Intenta de nuevo.";
        try {
          const errBody = await response.json();
          if (errBody && errBody.error) errMsg = errBody.error;
        } catch (_e) {
          /* respuesta sin cuerpo JSON */
        }
        hideTyping();
        appendMessageEl("error", errMsg);
        isSending = false;
        setSendEnabled(true);
        updateMicSendToggle();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Los eventos SSE están separados por línea en blanco.
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const rawEvent of events) {
          const parsed = parseSseEvent(rawEvent);
          if (!parsed) continue;

          if (parsed.event === "delta" && parsed.data && typeof parsed.data.text === "string") {
            if (!assistantEl) {
              hideTyping();
              assistantEl = appendMessageEl("assistant", "");
            }
            assistantText += parsed.data.text;
            assistantEl.textContent = assistantText;
            scrollToBottom();
          } else if (parsed.event === "error") {
            hideTyping();
            const msg = (parsed.data && parsed.data.message) || "Ocurrió un error inesperado.";
            if (assistantText) {
              appendSystemNote(msg);
            } else {
              appendMessageEl("error", msg);
            }
          } else if (parsed.event === "location_request") {
            appendLocationRequestButton();
          } else if (parsed.event === "audio-pending") {
            audioPendingNoteEl = appendSystemNote("🎙️ Generando respuesta en audio…");
          } else if (parsed.event === "audio") {
            if (audioPendingNoteEl) {
              audioPendingNoteEl.remove();
              audioPendingNoteEl = null;
            }
            if (parsed.data && parsed.data.fileId && assistantEl) {
              assistantAudioAttachment = {
                fileId: parsed.data.fileId,
                kind: "audio",
                url: parsed.data.url,
                duration: parsed.data.duration,
                transcript: parsed.data.transcript,
                generatedBy: "lucy",
                ttsProvider: parsed.data.provider,
              };
              const lucyPlayer = buildAttachmentEl(assistantAudioAttachment);
              assistantEl.insertAdjacentElement("beforebegin", lucyPlayer);
              scrollToBottom();
            }
          } else if (parsed.event === "audio-error") {
            if (audioPendingNoteEl) {
              audioPendingNoteEl.remove();
              audioPendingNoteEl = null;
            }
            appendSystemNote((parsed.data && parsed.data.message) || "No se pudo generar el audio de la respuesta.");
          } else if (parsed.event === "media") {
            if (parsed.data && parsed.data.mediaKey && assistantEl) {
              assistantMedia = {
                kind: "image",
                mediaKey: parsed.data.mediaKey,
                title: parsed.data.title,
                url: parsed.data.url,
                generatedBy: "lucy",
              };
              const mediaEl = buildLucyMediaPlayerEl(resolveAssetUrl(assistantMedia.url), assistantMedia);
              assistantEl.insertAdjacentElement("afterend", mediaEl);
              scrollToBottom();
            }
          } else if (parsed.event === "video") {
            if (parsed.data && parsed.data.videoKey) {
              const videoAttachment = {
                kind: "video",
                videoKey: parsed.data.videoKey,
                title: parsed.data.title,
                url: parsed.data.url,
                posterUrl: parsed.data.posterUrl,
              };
              const caption = parsed.data.caption || "Te envío este video explicativo 👇";
              appendMessageEl("assistant", caption, undefined, videoAttachment);
              conversation.push({ role: "assistant", content: caption, time: new Date().toISOString(), attachment: videoAttachment });
              saveHistory();
            }
          } else if (parsed.event === "done") {
            // fin de la respuesta, no requiere acción adicional
          } else if (parsed.event === "meta") {
            // El servidor confirma/asigna el identificador de esta conversación
            // (se usa en el panel de administración /admin).
            if (parsed.data && typeof parsed.data.sessionId === "string" && parsed.data.sessionId !== sessionId) {
              sessionId = parsed.data.sessionId;
              try {
                sessionStorage.setItem(CONFIG.sessionIdKey, sessionId);
              } catch (_e) {
                /* ignorar */
              }
            }
          }
        }
      }

      hideTyping();

      if (assistantText) {
        conversation.push({
          role: "assistant",
          content: assistantText,
          time: new Date().toISOString(),
          attachment: assistantAudioAttachment || undefined,
          media: assistantMedia || undefined,
        });
        saveHistory();
      }
    } catch (err) {
      hideTyping();
      appendMessageEl(
        "error",
        "No se pudo conectar con el asistente. Verifica tu conexión e intenta de nuevo."
      );
      console.error("[La Occidental Chatbot] Error de red:", err);
    } finally {
      isSending = false;
      setSendEnabled(true);
      setAttachControlsEnabled(true);
      updateMicSendToggle();
      input.focus();
    }
  }

  /**
   * Convierte un bloque de texto "event: X\ndata: {...}" en { event, data }.
   */
  function parseSseEvent(rawEvent) {
    const lines = rawEvent.split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    let event = "message";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataStr += line.slice(5).trim();
      }
    }

    let data = null;
    if (dataStr) {
      try {
        data = JSON.parse(dataStr);
      } catch (_e) {
        data = null;
      }
    }

    return { event, data };
  }

  function setSendEnabled(enabled) {
    const sendBtn = document.getElementById("lo-chat-send");
    sendBtn.disabled = !enabled;
  }

  function autoResizeInput(input) {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 90) + "px";
  }

  // -------------------------------------------------------------------------
  // Cotizador automático (Automóviles RCV · HCM · Patrimoniales)
  // -------------------------------------------------------------------------
  //
  // Cuando el usuario expresa intención de cotizar, el widget activa un flujo
  // estructurado con formularios reales (selects/inputs) en vez de dejar que Lucy
  // (el modelo) recopile los datos por texto libre. Todos los cálculos se hacen
  // aquí mismo con la configuración pública de /api/quote-config (editable desde
  // el panel /admin sin tocar código) — así Lucy nunca "inventa" precios.

  const QUOTE_TRIGGER_FALLBACK = [
    "cotiz",
    "cuanto cuesta",
    "cuánto cuesta",
    "cuanto sale",
    "cuánto sale",
    "precio del seguro",
  ];

  let quoterConfig = null;
  let quoterConfigPromise = null;
  let quoteFlowStarting = false;
  /** Tarjeta interactiva actualmente abierta (chooser o formulario) — se reemplaza sola. */
  let activeQuoteCardEl = null;

  function deriveQuoteConfigUrl() {
    if (CONFIG.quoteConfigUrl) return CONFIG.quoteConfigUrl;
    return CONFIG.apiUrl.replace(/\/api\/chat\/?$/, "/api/quote-config");
  }

  function deriveQuoteSaveUrl() {
    if (CONFIG.quoteSaveUrl) return CONFIG.quoteSaveUrl;
    return CONFIG.apiUrl.replace(/\/api\/chat\/?$/, "/api/quote");
  }

  function loadQuoterConfig() {
    if (quoterConfigPromise) return quoterConfigPromise;
    quoterConfigPromise = fetch(deriveQuoteConfigUrl())
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        quoterConfig = data && data.config && Object.keys(data.config).length ? data.config : null;
      })
      .catch(() => {
        quoterConfig = null;
      });
    return quoterConfigPromise;
  }

  function normalizeForMatch(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  function detectQuoteIntent(text) {
    const keywords =
      (quoterConfig && quoterConfig.general && quoterConfig.general.triggerKeywords) || QUOTE_TRIGGER_FALLBACK;
    const normalized = normalizeForMatch(text);
    return keywords.some((kw) => normalized.includes(normalizeForMatch(kw)));
  }

  function removeActiveCard() {
    if (activeQuoteCardEl && activeQuoteCardEl.closest(".lo-msg-row")) {
      activeQuoteCardEl.closest(".lo-msg-row").remove();
    }
    activeQuoteCardEl = null;
  }

  /**
   * Agrega una tarjeta interactiva (formulario, opciones, resumen) como mensaje de
   * Lucy. A diferencia de appendMessageEl admite HTML real (selects, inputs, tablas).
   * Por defecto reemplaza la tarjeta interactiva anterior; pasa `keepPrevious: true`
   * para dejar la tarjeta previa donde está (usado para el resumen final, que debe
   * permanecer visible en el chat en vez de ser reemplazado por el siguiente paso).
   */
  function appendQuoteCard(innerHtml, { keepPrevious } = {}) {
    if (!keepPrevious) removeActiveCard();

    const body = document.getElementById("lo-chat-body");
    const row = document.createElement("div");
    row.className = "lo-msg-row lo-row-bot";
    row.insertAdjacentHTML("beforeend", avatarHtml("sm"));

    const col = document.createElement("div");
    col.className = "lo-quote-col";

    const card = document.createElement("div");
    card.className = "lo-quote-card";
    card.innerHTML = innerHtml;

    col.appendChild(card);
    row.appendChild(col);
    body.appendChild(row);
    scrollToBottom();

    if (!keepPrevious) activeQuoteCardEl = card;
    return card;
  }

  /** Agrega un mensaje sintético visible en el chat Y lo guarda en el historial real. */
  function pushSyntheticMessage(role, text) {
    appendMessageEl(role, text);
    conversation.push({ role, content: text, time: new Date().toISOString() });
    saveHistory();
  }

  /** Guarda un mensaje solo en el historial (sin duplicar burbuja visible) — para el
   *  resumen de la cotización, que ya se ve como tarjeta enriquecida. */
  function pushHistoryOnly(role, text) {
    conversation.push({ role, content: text, time: new Date().toISOString() });
    saveHistory();
  }

  function money(value, currencyLabel) {
    const formatted = Number(value || 0).toLocaleString("es-VE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return currencyLabel ? `${formatted} ${currencyLabel}` : formatted;
  }

  function buildSummaryTableHtml(title, rows, note) {
    const rowsHtml = rows
      .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join("");
    return `
      <div class="lo-quote-card-header">${escapeHtml(title)}</div>
      <div class="lo-quote-card-body">
        <table class="lo-quote-table">${rowsHtml}</table>
        ${note ? `<p class="lo-quote-note">${escapeHtml(note)}</p>` : ""}
      </div>
    `;
  }

  function buildSummaryTableText(title, rows, note) {
    const lines = rows.map(([label, value]) => `• ${label}: ${value}`);
    return [title, ...lines, note].filter(Boolean).join("\n");
  }

  function saveQuote(payload) {
    fetch(deriveQuoteSaveUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ messages: conversation }, payload)),
    }).catch((err) => {
      console.error("[La Occidental Chatbot] No se pudo guardar la cotización:", err);
    });
  }

  async function startQuoteFlow() {
    if (quoteFlowStarting) return;
    quoteFlowStarting = true;
    try {
      await loadQuoterConfig();

      if (!quoterConfig) {
        appendMessageEl(
          "error",
          "El cotizador automático no está disponible en este momento. Cuéntame qué seguro te interesa y te ayudo a coordinar con un asesor."
        );
        return;
      }

      const intro =
        (quoterConfig.general && quoterConfig.general.introMessage) ||
        "¿Qué tipo de seguro te gustaría cotizar?";
      pushSyntheticMessage("assistant", intro);
      renderRamoChooser();
    } finally {
      quoteFlowStarting = false;
    }
  }

  function renderRamoChooser() {
    const options = [];
    if (quoterConfig.rcv && quoterConfig.rcv.enabled !== false) {
      options.push({ ramo: "autos", icon: "🚗", label: quoterConfig.rcv.label || "Automóviles (RCV)" });
    }
    if (quoterConfig.hcm && quoterConfig.hcm.enabled !== false) {
      options.push({ ramo: "personas", icon: "🏥", label: quoterConfig.hcm.label || "HCM" });
    }
    if (quoterConfig.patrimoniales && quoterConfig.patrimoniales.enabled !== false) {
      options.push({
        ramo: "patrimoniales",
        icon: "🏠",
        label: quoterConfig.patrimoniales.label || "Patrimoniales",
      });
    }

    if (options.length === 0) {
      appendMessageEl("error", "El cotizador automático no tiene ramos configurados en este momento.");
      return;
    }

    const buttonsHtml = options
      .map(
        (o) =>
          `<button type="button" class="lo-quote-choice" data-ramo="${escapeHtml(
            o.ramo
          )}" data-label="${escapeHtml(o.label)}">${o.icon} ${escapeHtml(o.label)}</button>`
      )
      .join("");

    const card = appendQuoteCard(`<div class="lo-quote-card-body"><div class="lo-quote-choices">${buttonsHtml}</div></div>`);

    card.querySelectorAll(".lo-quote-choice").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ramo = btn.getAttribute("data-ramo");
        const label = btn.getAttribute("data-label");
        removeActiveCard();
        pushSyntheticMessage("user", `Deseas cotizar: ${label}`);
        if (ramo === "autos") renderAutoForm();
        else if (ramo === "personas") renderHcmForm();
        else if (ramo === "patrimoniales") renderPatrimonialForm();
      });
    });
  }

  /**
   * Muestra el resumen final (tarjeta enriquecida con tabla), guarda la cotización
   * en el servidor y ofrece el botón "Solicitar póliza formal".
   */
  function showQuoteSummary({ ramo, ramoLabel, inputs, result, html, text }) {
    const quoteId = generateId();
    const disclaimer = (quoterConfig.general && quoterConfig.general.disclaimer) || "";

    const summaryHtml = `
      ${html}
      ${disclaimer ? `<p class="lo-quote-disclaimer">${escapeHtml(disclaimer)}</p>` : ""}
      <div class="lo-quote-card-actions">
        <button type="button" class="lo-quote-submit lo-quote-formal-btn">📄 Solicitar póliza formal</button>
      </div>
    `;

    // La tarjeta enriquecida se queda visible permanentemente en el chat (no se
    // auto-reemplaza al abrir el siguiente formulario/tarjeta).
    const card = appendQuoteCard(summaryHtml, { keepPrevious: true });

    const fullText = disclaimer ? `${text}\n\n${disclaimer}` : text;
    pushHistoryOnly("assistant", fullText);

    saveQuote({ sessionId, quoteId, ramo, inputs, result });

    const formalBtn = card.querySelector(".lo-quote-formal-btn");
    formalBtn.addEventListener("click", () => {
      formalBtn.disabled = true;
      formalBtn.textContent = "✓ Formulario abierto abajo";
      renderFormalRequestForm({ quoteId, ramo, ramoLabel, prefillEmail: inputs.correo || "" });
    });
  }

  /** Formulario final: nombre, cédula y correo para solicitar la póliza formal. */
  function renderFormalRequestForm({ quoteId, ramo, ramoLabel, prefillEmail }) {
    const card = appendQuoteCard(`
      <div class="lo-quote-card-header">📄 Solicitar póliza formal — ${escapeHtml(ramoLabel)}</div>
      <form class="lo-quote-card-body">
        <label class="lo-quote-field">
          <span>Nombre completo</span>
          <input type="text" name="nombre" maxlength="150" required />
        </label>
        <label class="lo-quote-field">
          <span>Cédula de identidad</span>
          <input type="text" name="cedula" maxlength="20" placeholder="V-12345678" required />
        </label>
        <label class="lo-quote-field">
          <span>Correo electrónico</span>
          <input type="email" name="correo" maxlength="150" value="${escapeHtml(prefillEmail || "")}" required />
        </label>
        <p class="lo-quote-note">
          Este es un estimado referencial sujeto a evaluación de riesgo. Un asesor de La Occidental se pondrá en
          contacto contigo para formalizar tu póliza.
        </p>
        <div class="lo-quote-card-actions">
          <button type="button" class="lo-quote-cancel">Cancelar</button>
          <button type="submit" class="lo-quote-submit">Enviar solicitud</button>
        </div>
      </form>
    `);

    card.querySelector(".lo-quote-cancel").addEventListener("click", () => removeActiveCard());

    card.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const contact = {
        nombre: (formData.get("nombre") || "").trim(),
        cedula: (formData.get("cedula") || "").trim(),
        correo: (formData.get("correo") || "").trim(),
      };
      if (!contact.nombre || !contact.cedula || !contact.correo) return;

      removeActiveCard();

      pushSyntheticMessage(
        "user",
        `Solicitó formalizar su póliza — Nombre: ${contact.nombre} · Cédula: ${contact.cedula} · Correo: ${contact.correo}`
      );
      pushSyntheticMessage(
        "assistant",
        `¡Perfecto, ${contact.nombre.split(" ")[0] || "gracias"}! 🎉 Registré tu solicitud de póliza de ${ramoLabel}. ` +
          `Un asesor de La Occidental te contactará a ${contact.correo} para formalizarla. Recuerda que el monto ` +
          `mostrado es un estimado referencial sujeto a evaluación de riesgo.`
      );

      saveQuote({ sessionId, quoteId, ramo, contact, formalRequest: true });
    });
  }

  // --- Automóviles (RCV) -----------------------------------------------------

  function buildYearOptions(minYear) {
    const currentYear = new Date().getFullYear();
    let opts = "";
    for (let y = currentYear; y >= minYear; y--) {
      opts += `<option value="${y}">${y}</option>`;
    }
    return opts;
  }

  function renderAutoForm() {
    const cfg = quoterConfig.rcv;
    const marcaOptions = (cfg.marcasComunes || [])
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join("");
    const tipoOptions = (cfg.tarifas || [])
      .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`)
      .join("");
    const placaOptions = (cfg.placaOptions || [])
      .map(
        (p) =>
          `<option value="${escapeHtml(p.id)}"${p.id === "nacional" ? " selected" : ""}>${escapeHtml(
            p.label
          )}</option>`
      )
      .join("");
    const usoOptions = (cfg.usoOptions || [])
      .map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.label)}</option>`)
      .join("");
    const recargosHtml = (cfg.recargos || [])
      .filter((r) => r.enabled !== false)
      .map(
        (r) => `
          <label class="lo-quote-checkbox">
            <input type="checkbox" name="recargo" value="${escapeHtml(r.id)}" />
            <span>${escapeHtml(r.label)} (+${r.pct}%)</span>
          </label>`
      )
      .join("");

    const card = appendQuoteCard(`
      <div class="lo-quote-card-header">🚗 Cotizar Automóviles (RCV)</div>
      <form class="lo-quote-card-body">
        <label class="lo-quote-field">
          <span>Marca</span>
          <select name="marca" required>${marcaOptions}</select>
        </label>
        <div class="lo-quote-field" data-role="marca-otra" hidden>
          <span>Especifica la marca</span>
          <input type="text" name="marcaOtra" maxlength="60" />
        </div>
        <label class="lo-quote-field">
          <span>Modelo</span>
          <input type="text" name="modelo" maxlength="60" required />
        </label>
        <label class="lo-quote-field">
          <span>Año</span>
          <select name="anio" required>${buildYearOptions(cfg.minYear || 1990)}</select>
        </label>
        <label class="lo-quote-field">
          <span>Tipo de vehículo</span>
          <select name="tipo" required>${tipoOptions}</select>
        </label>
        <label class="lo-quote-field">
          <span>Origen de la placa</span>
          <select name="placa" required>${placaOptions}</select>
        </label>
        <label class="lo-quote-field">
          <span>Uso</span>
          <select name="uso" required>${usoOptions}</select>
        </label>
        ${
          recargosHtml
            ? `<div class="lo-quote-field"><span>¿Alguna condición especial? (opcional)</span>${recargosHtml}</div>`
            : ""
        }
        <div class="lo-quote-card-actions">
          <button type="button" class="lo-quote-cancel">Cancelar</button>
          <button type="submit" class="lo-quote-submit">Calcular cotización</button>
        </div>
      </form>
    `);

    const marcaSelect = card.querySelector('select[name="marca"]');
    const otraWrap = card.querySelector('[data-role="marca-otra"]');
    marcaSelect.addEventListener("change", () => {
      otraWrap.hidden = marcaSelect.value !== "Otra";
    });

    card.querySelector(".lo-quote-cancel").addEventListener("click", () => removeActiveCard());

    card.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const marcaRaw = formData.get("marca");
      const marca = marcaRaw === "Otra" ? (formData.get("marcaOtra") || "").trim() || "Otra" : marcaRaw;

      const inputs = {
        marca,
        modelo: (formData.get("modelo") || "").trim(),
        anio: Number(formData.get("anio")),
        tipoId: formData.get("tipo"),
        placaId: formData.get("placa"),
        usoId: formData.get("uso"),
        recargoIds: formData.getAll("recargo"),
      };

      const result = computeRcv(inputs, cfg);
      if (!result) {
        appendSystemNote("No se pudo calcular la cotización con los datos ingresados. Intenta de nuevo.");
        return;
      }

      removeActiveCard();
      finishAutoQuote(inputs, result);
    });
  }

  function computeRcv(inputs, cfg) {
    const tarifa = (cfg.tarifas || []).find((t) => t.id === inputs.tipoId);
    if (!tarifa) return null;
    const cols = inputs.placaId === "extranjera" ? tarifa.extranjera : tarifa.nacional;
    if (!cols) return null;

    const primaBase = cols.prima;
    const rebajaPct = inputs.usoId === "sinLucro" && tarifa.aplicaRebajaSinLucro ? cfg.rebajaSinLucroPct || 0 : 0;
    const rebajaMonto = primaBase * (rebajaPct / 100);
    const primaTrasRebaja = primaBase - rebajaMonto;

    const recargosAplicados = (inputs.recargoIds || [])
      .map((id) => (cfg.recargos || []).find((r) => r.id === id))
      .filter(Boolean);
    const totalRecargoPct = recargosAplicados.reduce((sum, r) => sum + (r.pct || 0), 0);
    const montoRecargo = primaTrasRebaja * (totalRecargoPct / 100);
    const primaFinal = Math.round((primaTrasRebaja + montoRecargo) * 100) / 100;

    return {
      tarifaLabel: tarifa.label,
      placaLabel: inputs.placaId === "extranjera" ? "Extranjera" : "Nacional",
      cosas: cols.cosas,
      personas: cols.personas,
      primaBase,
      rebajaPct,
      rebajaMonto: Math.round(rebajaMonto * 100) / 100,
      recargosAplicados: recargosAplicados.map((r) => ({ label: r.label, pct: r.pct })),
      totalRecargoPct,
      montoRecargo: Math.round(montoRecargo * 100) / 100,
      primaFinal,
      currencyLabel: cfg.currencyLabel || "TCR",
      currencyNote: cfg.currencyNote || "",
    };
  }

  function finishAutoQuote(inputs, result) {
    const rows = [
      ["Tipo de vehículo", result.tarifaLabel],
      ["Marca / Modelo / Año", `${inputs.marca} / ${inputs.modelo} / ${inputs.anio}`],
      ["Origen de placa", result.placaLabel],
      ["Cobertura — Daños a cosas (terceros)", money(result.cosas, result.currencyLabel)],
      ["Cobertura — Daños a personas (terceros)", money(result.personas, result.currencyLabel)],
      ["Prima anual base", money(result.primaBase, result.currencyLabel)],
    ];
    if (result.rebajaPct > 0) {
      rows.push([
        `Rebaja sin fines de lucro (-${result.rebajaPct}%)`,
        `- ${money(result.rebajaMonto, result.currencyLabel)}`,
      ]);
    }
    if (result.recargosAplicados.length > 0) {
      rows.push([
        `Recargos aplicados (+${result.totalRecargoPct}%)`,
        `+ ${money(result.montoRecargo, result.currencyLabel)}`,
      ]);
    }
    rows.push(["Prima anual estimada", money(result.primaFinal, result.currencyLabel)]);

    const html = buildSummaryTableHtml("🚗 Resumen — Automóviles (RCV)", rows, result.currencyNote);
    const text = buildSummaryTableText("Resumen — Automóviles (RCV)", rows, result.currencyNote);

    showQuoteSummary({ ramo: "autos", ramoLabel: "Automóviles (RCV)", inputs, result, html, text });
  }

  // --- HCM (Hospitalización y Cirugía) ---------------------------------------

  function findAgeBand(age, rangos) {
    return (rangos || []).find((r) => age >= r.min && age <= r.max) || null;
  }

  function renderHcmForm() {
    const cfg = quoterConfig.hcm;
    const sumaOptions = (cfg.sumasAseguradas || [])
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`)
      .join("");

    const card = appendQuoteCard(`
      <div class="lo-quote-card-header">🏥 Cotizar HCM (Hospitalización y Cirugía)</div>
      <form class="lo-quote-card-body">
        <label class="lo-quote-field">
          <span>Edad del titular</span>
          <input type="number" name="titularAge" min="0" max="${cfg.maxAge}" required />
        </label>
        <label class="lo-quote-field">
          <span>Suma asegurada deseada</span>
          <select name="suma" required>${sumaOptions}</select>
        </label>
        <label class="lo-quote-field">
          <span>Cantidad de beneficiarios adicionales</span>
          <input type="number" name="cantidadBeneficiarios" min="0" max="${cfg.maxBeneficiarios}" value="0" data-role="hcm-count" />
        </label>
        <div class="lo-quote-field" data-role="hcm-beneficiarios"></div>
        <p class="lo-quote-note">Cobertura disponible hasta ${cfg.maxAge} años. Para mayores de ${cfg.maxAge}, contáctanos directamente con un asesor.</p>
        <div class="lo-quote-card-actions">
          <button type="button" class="lo-quote-cancel">Cancelar</button>
          <button type="submit" class="lo-quote-submit">Calcular cotización</button>
        </div>
      </form>
    `);

    const countInput = card.querySelector('[data-role="hcm-count"]');
    const beneficiariosWrap = card.querySelector('[data-role="hcm-beneficiarios"]');

    function renderBeneficiaryInputs() {
      const count = Math.max(0, Math.min(cfg.maxBeneficiarios || 0, Number(countInput.value) || 0));
      countInput.value = count;
      let html = "";
      for (let i = 0; i < count; i++) {
        html += `
          <label class="lo-quote-field lo-quote-field-inline">
            <span>Edad beneficiario ${i + 1}</span>
            <input type="number" name="beneficiarioAge" min="0" max="${cfg.maxAge}" required />
          </label>`;
      }
      beneficiariosWrap.innerHTML = html;
    }

    countInput.addEventListener("input", renderBeneficiaryInputs);
    card.querySelector(".lo-quote-cancel").addEventListener("click", () => removeActiveCard());

    card.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const inputs = {
        titularAge: Number(formData.get("titularAge")),
        sumaId: formData.get("suma"),
        beneficiarioAges: formData.getAll("beneficiarioAge").map(Number),
      };

      const result = computeHcm(inputs, cfg);
      if (!result || result.titular.rate == null) {
        appendSystemNote(
          `No pudimos calcular la cotización: la edad del titular debe estar entre 0 y ${cfg.maxAge} años.`
        );
        return;
      }
      if (result.invalidBeneficiary) {
        appendSystemNote(
          `Alguno de los beneficiarios tiene una edad fuera del rango cubierto (0 a ${cfg.maxAge} años). Ajusta las edades e intenta de nuevo.`
        );
        return;
      }

      removeActiveCard();
      finishHcmQuote(inputs, result);
    });
  }

  function computeHcm(inputs, cfg) {
    const sumaId = inputs.sumaId;
    const titularBand = findAgeBand(inputs.titularAge, cfg.rangosEdad);
    const titularRate = titularBand ? titularBand.rates[sumaId] : null;

    const beneficiarios = (inputs.beneficiarioAges || []).map((age) => {
      const band = findAgeBand(age, cfg.rangosEdad);
      return { age, bandLabel: band ? band.label : null, rate: band ? band.rates[sumaId] : null };
    });

    const invalidBeneficiary = beneficiarios.some((b) => b.rate == null);
    const total = (titularRate || 0) + beneficiarios.reduce((sum, b) => sum + (b.rate || 0), 0);
    const sumaOption = (cfg.sumasAseguradas || []).find((s) => s.id === sumaId);

    return {
      titular: { age: inputs.titularAge, bandLabel: titularBand ? titularBand.label : null, rate: titularRate },
      beneficiarios,
      invalidBeneficiary,
      total: Math.round(total * 100) / 100,
      sumaLabel: sumaOption ? sumaOption.label : sumaId,
      currencyLabel: cfg.currencyLabel || "USD",
    };
  }

  function finishHcmQuote(inputs, result) {
    const rows = [
      ["Suma asegurada", result.sumaLabel],
      [
        `Titular (${result.titular.age} años · ${result.titular.bandLabel})`,
        money(result.titular.rate, result.currencyLabel),
      ],
    ];
    result.beneficiarios.forEach((b, i) => {
      rows.push([`Beneficiario ${i + 1} (${b.age} años · ${b.bandLabel})`, money(b.rate, result.currencyLabel)]);
    });
    rows.push(["Prima anual total estimada", money(result.total, result.currencyLabel)]);

    const html = buildSummaryTableHtml("🏥 Resumen — HCM (Hospitalización y Cirugía)", rows);
    const text = buildSummaryTableText("Resumen — HCM (Hospitalización y Cirugía)", rows);

    showQuoteSummary({ ramo: "personas", ramoLabel: "HCM (Hospitalización y Cirugía)", inputs, result, html, text });
  }

  // --- Patrimoniales (Incendio/Robo) ------------------------------------------

  function renderPatrimonialForm() {
    const cfg = quoterConfig.patrimoniales;
    const tipoOptions = (cfg.tiposBien || [])
      .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`)
      .join("");

    const card = appendQuoteCard(`
      <div class="lo-quote-card-header">🏠 Cotizar Patrimoniales (Incendio/Robo)</div>
      <form class="lo-quote-card-body">
        <label class="lo-quote-field">
          <span>Tipo de bien</span>
          <select name="tipoBien" required>${tipoOptions}</select>
        </label>
        <label class="lo-quote-field">
          <span>Valor asegurado (USD)</span>
          <input type="number" name="valor" min="1" step="1" required />
        </label>
        <label class="lo-quote-field">
          <span>Correo electrónico</span>
          <input type="email" name="correo" maxlength="150" required />
        </label>
        <div class="lo-quote-card-actions">
          <button type="button" class="lo-quote-cancel">Cancelar</button>
          <button type="submit" class="lo-quote-submit">Enviar cotización</button>
        </div>
      </form>
    `);

    card.querySelector(".lo-quote-cancel").addEventListener("click", () => removeActiveCard());

    card.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const tipoOpt = (cfg.tiposBien || []).find((t) => t.id === formData.get("tipoBien"));
      const inputs = {
        tipoBienId: formData.get("tipoBien"),
        tipoBienLabel: tipoOpt ? tipoOpt.label : formData.get("tipoBien"),
        valor: Number(formData.get("valor")),
        correo: (formData.get("correo") || "").trim(),
      };

      removeActiveCard();
      finishPatrimonialQuote(inputs, cfg);
    });
  }

  function finishPatrimonialQuote(inputs, cfg) {
    const rows = [
      ["Tipo de bien", inputs.tipoBienLabel],
      ["Valor asegurado", money(inputs.valor, "USD")],
      ["Correo de contacto", inputs.correo],
    ];

    const note = cfg.mensajeEnvio || "Tu cotización fue enviada a nuestro equipo comercial.";
    const html = buildSummaryTableHtml("🏠 Resumen — Patrimoniales (Incendio/Robo)", rows, note);
    const text = buildSummaryTableText("Resumen — Patrimoniales (Incendio/Robo)", rows, note);

    showQuoteSummary({
      ramo: "patrimoniales",
      ramoLabel: "Patrimoniales (Incendio/Robo)",
      inputs,
      result: { message: note },
      html,
      text,
    });
  }

  // -------------------------------------------------------------------------
  // Apertura / minimizado / cierre del widget
  // -------------------------------------------------------------------------

  function deriveGreetingAudioUrl() {
    if (CONFIG.greetingAudioUrl) return CONFIG.greetingAudioUrl;
    return CONFIG.apiUrl.replace(/\/api\/chat\/?$/, "/api/greeting-audio");
  }

  /** Pide (o recibe desde la caché del servidor) el audio del saludo — regla "Lucy
   *  responde con audio en la bienvenida, siempre". Falla en silencio: el saludo en
   *  texto ya se mostró de todos modos, el audio es un plus si está disponible. */
  function fetchGreetingAudio(greetingBubble) {
    fetch(deriveGreetingAudioUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: CONFIG.greeting }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !data.available || !data.fileId) return;
        const attachment = {
          fileId: data.fileId,
          kind: "audio",
          url: data.url,
          duration: data.duration,
          transcript: data.transcript,
          generatedBy: "lucy",
          ttsProvider: data.provider,
        };
        const lucyPlayer = buildAttachmentEl(attachment);
        greetingBubble.insertAdjacentElement("beforebegin", lucyPlayer);
        scrollToBottom();
      })
      .catch(() => {
        /* silencioso: sin audio de bienvenida, el chat sigue funcionando igual */
      });
  }

  function openChat(root) {
    root.classList.add("lo-open");
    document.getElementById("lo-chat-launcher").setAttribute("aria-label", "Cerrar chat");
    const badge = document.getElementById("lo-chat-badge");
    if (badge) badge.style.display = "none";

    if (!hasOpenedOnce) {
      hasOpenedOnce = true;
      if (conversation.length === 0) {
        const greetingBubble = appendMessageEl("assistant", CONFIG.greeting, undefined, undefined, CONFIG.greetingMedia);
        fetchGreetingAudio(greetingBubble);
      } else {
        // Restaurar historial visual desde la sesión guardada.
        conversation.forEach((msg) =>
          appendMessageEl(
            msg.role === "user" ? "user" : "assistant",
            msg.content,
            msg.time ? new Date(msg.time) : null,
            msg.attachment,
            msg.media
          )
        );
      }
    }

    setTimeout(() => document.getElementById("lo-chat-input").focus(), 220);
  }

  /** Minimiza u oculta la ventana del chat; conserva la conversación. */
  function minimizeChat(root) {
    root.classList.remove("lo-open");
    document.getElementById("lo-chat-launcher").setAttribute("aria-label", "Abrir chat");
  }

  // -------------------------------------------------------------------------
  // Inicialización
  // -------------------------------------------------------------------------

  function init() {
    if (document.getElementById("lo-chatbot-root")) return; // evita doble inicialización

    const root = buildWidget();
    conversation = loadHistory();
    sessionId = getOrCreateSessionId();
    connectLiveStream(); // modo supervisor: recibe mensajes que el equipo mande desde /admin
    loadQuoterConfig(); // precarga en segundo plano — no bloquea el resto del widget

    renderQuickReplies();

    const launcher = document.getElementById("lo-chat-launcher");
    const minimizeBtn = document.getElementById("lo-chat-minimize");
    const closeBtn = document.getElementById("lo-chat-close");
    const input = document.getElementById("lo-chat-input");
    const sendBtn = document.getElementById("lo-chat-send");
    const attachBtn = document.getElementById("lo-chat-attach-btn");
    const fileInput = document.getElementById("lo-chat-file-input");
    const micBtn = document.getElementById("lo-chat-mic-btn");

    attachBtn.addEventListener("click", () => {
      if (!isUploadingAttachment) fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) handleFileSelected(file);
    });

    launcher.addEventListener("click", () => {
      if (root.classList.contains("lo-open")) {
        minimizeChat(root);
      } else {
        openChat(root);
      }
    });

    minimizeBtn.addEventListener("click", () => minimizeChat(root));
    closeBtn.addEventListener("click", () => minimizeChat(root));

    sendBtn.addEventListener("click", () => sendMessage(input.value));

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage(input.value);
      }
    });

    input.addEventListener("input", () => {
      autoResizeInput(input);
      updateMicSendToggle();
    });

    // Botón de micrófono / nota de voz — mantener presionado para grabar (mouse y
    // táctil vía Pointer Events, o teclado con la barra espaciadora — ver más abajo).
    if (!AUDIO_RECORDING_SUPPORTED) {
      micBtn.disabled = true;
      micBtn.title = "Tu navegador no soporta grabación de voz";
      micBtn.setAttribute("aria-label", "Tu navegador no soporta grabación de voz");
    } else {
      micBtn.addEventListener("pointerdown", onMicPointerDown);
      micBtn.addEventListener("pointermove", onMicPointerMove);
      micBtn.addEventListener("pointerup", onMicPointerUp);
      micBtn.addEventListener("pointercancel", onMicPointerUp);
      micBtn.addEventListener("keydown", onMicKeyDown);
      micBtn.addEventListener("keyup", onMicKeyUp);
      // Evita que un "mantener presionado" táctil abra el menú contextual del navegador.
      micBtn.addEventListener("contextmenu", (event) => event.preventDefault());
    }
    updateMicSendToggle();

    // Cerrar con la tecla Escape cuando el chat está abierto; si hay un lightbox de
    // imagen abierto, Escape lo cierra primero; si hay una grabación en curso, la
    // cancela (atajo de teclado para el gesto de "deslizar para cancelar", que con
    // teclado no es posible) — en ambos casos, sin cerrar el chat de paso.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (lightboxOverlayEl) {
        closeImageLightbox();
        return;
      }
      if (isRecording) {
        finishRecording(true);
        return;
      }
      if (root.classList.contains("lo-open")) {
        minimizeChat(root);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
