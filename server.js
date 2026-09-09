/**
 * server.js
 * Backend Node.js + Express para el chatbot de "La Occidental C.A. de Seguros".
 * Expone un endpoint /api/chat que reenvía la conversación a la API de Anthropic
 * (Claude) y transmite la respuesta al navegador mediante Server-Sent Events (SSE).
 *
 * También expone:
 *  - Un panel de administración en /admin (login simple + API bajo /api/admin/*)
 *    para revisar las conversaciones guardadas en conversations.json.
 *  - Un webhook de WhatsApp Business (vía Twilio) en /webhook/whatsapp, para que
 *    Lucy responda también por WhatsApp — ver WHATSAPP_SETUP.md.
 */

require("dotenv").config();

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const { PDFParse } = require("pdf-parse");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const ffmpeg = require("fluent-ffmpeg");
// ffmpeg-static resuelve un binario de ffmpeg listo para usar (sin depender de que el
// sistema operativo lo tenga instalado) — se usa solo para convertir el audio de Lucy
// a OGG/Opus antes de enviarlo como nota de voz por WhatsApp (ver sendLucyVoiceNoteToWhatsapp).
const FFMPEG_BINARY_PATH = require("ffmpeg-static");
if (FFMPEG_BINARY_PATH) ffmpeg.setFfmpegPath(FFMPEG_BINARY_PATH);
// sharp: redimensiona las imágenes del catálogo de Lucy cuando superan el límite de
// WhatsApp para adjuntos de imagen (ver resizeMediaForWhatsapp).
const sharp = require("sharp");
const jwt = require("jsonwebtoken");
// Envío de los códigos OTP de verificación de identidad por correo (ver SMTP_* más abajo).
const nodemailer = require("nodemailer");
const cron = require("node-cron");
// Horarios/umbrales de las tareas programadas (recordatorios de pólizas, seguimiento
// de cotizaciones, valoración por inactividad) — ver iniciarScheduler() más abajo.
const schedulerConfig = require("./config/scheduler.config");
// Acceso a los datos de pólizas (hoy data/polizas.json; POLIZAS_API_URL en el .env la
// reemplaza por una API REST real el día que exista — ver services/polizas.service.js).
const polizasService = require("./services/polizas.service");
// Gestión de siniestros: abrir, consultar, actualizar documentos, (re)asignar ajustador
// (hoy data/siniestros.json; SINIESTROS_API_URL en el .env la reemplaza por una API REST
// real el día que exista — ver services/siniestros.service.js).
const siniestrosService = require("./services/siniestros.service");
// Portal de corredores (/corredor): autenticación, cartera, comisiones, cotizador
// profesional (PDF), documentos y solicitudes de emisión — ver services/corredores.service.js.
const corredoresService = require("./services/corredores.service");

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
// Modelo rápido/económico para la clasificación de intención/emoción (ver
// classifyIntentAndEmotion) — una llamada aparte, corta, antes de la respuesta real;
// no necesita el modelo grande de conversación.
const CLAUDE_FAST_MODEL = process.env.CLAUDE_FAST_MODEL || "claude-haiku-4-5-20251001";
const COMPANY_NAME = process.env.COMPANY_NAME || "La Occidental C.A. de Seguros";
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || "Lucy";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "info@laoccidental.com";
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || "";
// Línea de siniestros/emergencias — atención 24/7 para reportes urgentes.
const CLAIMS_PHONE = process.env.CLAIMS_PHONE || "0212-6204444";

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 20;

// Límites defensivos para no dejar crecer la conversación ni los mensajes sin control
const MAX_HISTORY_MESSAGES = 30; // últimos N mensajes que se reenvían al modelo
const MAX_MESSAGE_LENGTH = 4000; // caracteres por mensaje de usuario

// --- Panel de administración ---
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS) || 8 * 60 * 60 * 1000; // 8h
const ADMIN_COOKIE_NAME = "lo_admin_session";
const CONVERSATIONS_FILE = process.env.CONVERSATIONS_FILE
  ? path.resolve(__dirname, process.env.CONVERSATIONS_FILE)
  : path.join(__dirname, "conversations.json");

// --- Memoria persistente por cliente (identificado por cédula) ---
const CLIENTES_FILE = process.env.CLIENTES_FILE
  ? path.resolve(__dirname, process.env.CLIENTES_FILE)
  : path.join(__dirname, "data", "clientes.json");

// --- Portal de corredores (/corredor) — autenticación por JWT, distinta de la
// cookie de sesión del panel /admin (ver "Portal de corredores" en el README). ---
const JWT_SECRET = process.env.JWT_SECRET || "";
const CORREDOR_TOKEN_TTL_S = Math.floor((Number(process.env.CORREDOR_SESSION_TTL_MS) || 8 * 60 * 60 * 1000) / 1000); // 8h
// Umbral (días) para las notificaciones en tiempo real de "póliza por vencer" — más
// corto que el umbral general de 30 días (ver polizasService.verificarVigencia) porque
// es una alerta urgente, no el listado general del dashboard.
const CORREDOR_ALERTA_VENCIMIENTO_DIAS = 7;
// Cada cuánto se revisan las pólizas de cada corredor por si alguna acaba de cruzar el
// umbral de 7 días — no hay un scheduler/cron real en este proyecto todavía, así que se
// usa un intervalo en memoria (ver iniciarChequeoVencimientosCorredores más abajo).
const CORREDOR_CHEQUEO_VENCIMIENTOS_MS = Number(process.env.CORREDOR_CHEQUEO_VENCIMIENTOS_MS) || 10 * 60 * 1000; // 10 min

// --- Cotizador automático ---
const QUOTER_CONFIG_FILE = process.env.QUOTER_CONFIG_FILE
  ? path.resolve(__dirname, process.env.QUOTER_CONFIG_FILE)
  : path.join(__dirname, "quoter-config.json");

// --- Adjuntos (fotos de siniestros/vehículos, documentos) ---
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(__dirname, process.env.UPLOADS_DIR)
  : path.join(__dirname, "uploads");
const UPLOADS_INDEX_FILE = path.join(UPLOADS_DIR, "uploads-index.json");
const MAX_UPLOAD_SIZE_BYTES = (Number(process.env.MAX_UPLOAD_SIZE_MB) || 5) * 1024 * 1024;
// mimetype real (detectado por firma de bytes) -> extensión de archivo en disco
// Los tipos audio/* son notas de voz grabadas desde el widget (ver "Grabación de voz"
// más abajo) — el formato exacto depende del navegador (MediaRecorder.isTypeSupported).
const ALLOWED_UPLOAD_MIMES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
};
// Solo el mensaje MÁS RECIENTE con imagen adjunta reenvía los bytes completos a Claude
// en cada turno; los adjuntos de imagen más antiguos en el historial se reemplazan por
// un texto de referencia, para no re-enviar (y re-cobrar) las mismas imágenes en cada
// turno de una conversación larga. El texto de PDFs, al ser mucho más liviano, sí se
// conserva completo en todo el historial.
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Las notas de voz (imágenes/PDFs se quedan en la raíz de UPLOADS_DIR, por compatibilidad
// con archivos guardados antes de esta funcionalidad) se guardan aparte en este subdirectorio.
const AUDIO_UPLOADS_DIR = path.join(UPLOADS_DIR, "audio");
fs.mkdirSync(AUDIO_UPLOADS_DIR, { recursive: true });
// Los audios que Lucy GENERA (texto-a-voz, ver más abajo) se guardan aparte de los que
// suben los usuarios, para poder revisarlos desde /admin sin mezclarlos.
const LUCY_AUDIO_DIR = path.join(AUDIO_UPLOADS_DIR, "luci");
fs.mkdirSync(LUCY_AUDIO_DIR, { recursive: true });

// --- Transcripción de notas de voz (Whisper, vía la API de OpenAI) ---
// Independiente de ANTHROPIC_API_KEY: Claude no transcribe audio, así que la
// conversión de voz a texto se hace con un proveedor distinto (OpenAI Whisper).
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// --- Síntesis de voz (texto-a-voz) para que Lucy responda con audio ---
// ElevenLabs es el proveedor preferido (voz más natural); si no está configurado (o
// falla en tiempo real), se cae automáticamente a la API de texto-a-voz de OpenAI
// (modelo "tts-1", voz "nova"), reutilizando la misma OPENAI_API_KEY de Whisper.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";
const ELEVENLABS_CONFIGURED = Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID);
const TTS_AVAILABLE = ELEVENLABS_CONFIGURED || Boolean(OPENAI_API_KEY);

// --- Verificación de identidad por código OTP (correo electrónico) ---
// Saber la cédula o el número de póliza de alguien NUNCA alcanza por sí solo para que
// Lucy trate a quien escribe como esa persona (ver "Motor de inteligencia" /
// identificarOCrearCliente): antes de confiar en la identidad se manda un código de
// 6 dígitos al correo del cliente y se le pide que lo escriba de vuelta — ver
// iniciarVerificacionIdentidad/continuarVerificacionIdentidad más abajo. Única
// excepción: un mensaje de WhatsApp que llega del mismo número ya guardado como
// teléfono del cliente (controlar ese número ya es, en la práctica, un segundo factor).
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || `"${COMPANY_NAME}" <no-responder@laoccidental.com>`;
const SMTP_CONFIGURED = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
const mailTransporter = SMTP_CONFIGURED
  ? nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;
if (!SMTP_CONFIGURED) {
  console.warn(
    "[aviso] SMTP no configurado — los códigos OTP de verificación de identidad se mostrarán solo en el " +
      "log del servidor (modo desarrollo), no se enviarán correos reales. Configura SMTP_HOST/SMTP_USER/SMTP_PASS en producción."
  );
}

const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 10 * 60 * 1000; // 10 minutos
const OTP_MAX_ATTEMPTS = 3; // intentos de código incorrecto antes de abortar la verificación
const OTP_MAX_EMAIL_ATTEMPTS = 3; // intentos de correo con formato inválido
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // mínimo entre reenvíos del código

/** Envía el código OTP por correo — en modo desarrollo (sin SMTP configurado) lo deja
 *  en el log del servidor en su lugar, para poder probar el flujo sin credenciales
 *  reales (mismo criterio que el resto de proveedores opcionales del proyecto). */
async function enviarCodigoOtp(email, codigo) {
  if (!mailTransporter) {
    console.warn(`[aviso] [MODO DESARROLLO — SMTP no configurado] Código OTP para ${email}: ${codigo}`);
    return;
  }
  try {
    await mailTransporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: `Tu código de verificación de ${COMPANY_NAME}`,
      text: `Tu código para verificar tu identidad es: ${codigo}\n\nVence en 10 minutos. Si no lo solicitaste, ignora este correo.`,
    });
  } catch (err) {
    console.error("Error al enviar el correo con el código OTP:", err.message);
  }
}

// --- Videos explicativos de Lucy ---
// Los archivos reales van en /public/assets/luci-videos/ con estos mismos nombres —
// hoy son placeholders (generados con ffmpeg); se reemplazan por los videos
// definitivos sin tocar código, siempre que conserven el nombre de archivo.
const LUCI_VIDEOS_DIR = path.join(__dirname, "public", "assets", "luci-videos");
// Versiones comprimidas para WhatsApp (cuando el original supera el límite de 16 MB)
// se cachean aquí, para no volver a comprimir el mismo video en cada envío.
const VIDEO_CACHE_DIR = path.join(UPLOADS_DIR, "video-cache");
fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
const WHATSAPP_VIDEO_MAX_BYTES = 16 * 1024 * 1024; // límite de adjuntos de WhatsApp

const VIDEO_CATALOG = [
  {
    key: "reportar-siniestro",
    file: "como-reportar-siniestro.mp4",
    title: "Cómo reportar un siniestro",
    triggers: [
      "como reporto un siniestro",
      "como puedo reportar un siniestro",
      "como se reporta un siniestro",
      "como denuncio un siniestro",
      "quiero reportar un siniestro",
      "reportar un siniestro",
    ],
    youtubeUrl: "", // opcional — si se define, se usa como respaldo en WhatsApp en vez del link directo al archivo
  },
  {
    key: "renovar-poliza",
    file: "como-renovar-poliza.mp4",
    title: "Cómo renovar tu póliza",
    triggers: [
      "como renuevo mi poliza",
      "como renovar mi poliza",
      "como renuevo la poliza",
      "como se renueva la poliza",
      "renovacion de poliza",
      "quiero renovar mi poliza",
    ],
    youtubeUrl: "",
  },
  {
    key: "coberturas-hcm",
    file: "coberturas-hcm-explicadas.mp4",
    title: "Coberturas del HCM explicadas",
    triggers: [
      "que cubre el hcm",
      "que cubre hcm",
      "que cubre mi hcm",
      "coberturas del hcm",
      "cobertura del hcm",
      "que incluye el hcm",
    ],
    youtubeUrl: "",
  },
  {
    key: "app-cliente-tutorial",
    file: "app-cliente-tutorial.mp4",
    title: "Cómo usar el portal del cliente",
    // El pedido original no especificó una frase disparadora para este video (solo
    // catalogó el archivo) — se agregan estas por consistencia con los otros 3, para
    // que también sea alcanzable desde el chat.
    triggers: ["como uso la app", "como uso el portal", "tutorial de la app", "portal del cliente", "aplicacion de clientes"],
    youtubeUrl: "",
  },
];

/** ¿El texto del usuario coincide con alguno de los videos del catálogo? Devuelve la
 *  entrada completa del catálogo, o `null` si ninguna frase disparadora coincide. */
function detectVideoIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  return VIDEO_CATALOG.find((video) => video.triggers.some((t) => normalized.includes(normalizeText(t)))) || null;
}

function videoFilePath(video) {
  return path.join(LUCI_VIDEOS_DIR, video.file);
}

function videoPosterPath(video) {
  return videoFilePath(video).replace(/\.mp4$/i, ".jpg");
}

/** Arma el `attachment` (mismo shape que usa el cliente) de un video del catálogo, o
 *  `null` si el archivo todavía no existe en disco (p. ej. un placeholder que aún no
 *  se ha reemplazado, o un `file` mal escrito en VIDEO_CATALOG). */
function resolveVideoAttachment(video) {
  const videoPath = videoFilePath(video);
  if (!fs.existsSync(videoPath)) return null;
  const posterPath = videoPosterPath(video);
  return {
    kind: "video",
    videoKey: video.key,
    title: video.title,
    filename: video.file,
    url: `/assets/luci-videos/${video.file}`,
    posterUrl: fs.existsSync(posterPath) ? `/assets/luci-videos/${path.basename(posterPath)}` : undefined,
    mimetype: "video/mp4",
    size: fs.statSync(videoPath).size,
  };
}

/**
 * Genera (una sola vez, si falta) el poster/thumbnail de cada video del catálogo — el
 * primer frame, extraído con ffmpeg — para el atributo `poster` del <video> del widget.
 * Se llama en segundo plano al iniciar el servidor (no bloquea el arranque); si un
 * video real todavía no se subió, se ignora hasta el próximo arranque.
 */
async function ensureVideoPosters() {
  for (const video of VIDEO_CATALOG) {
    const videoPath = videoFilePath(video);
    const posterPath = videoPosterPath(video);
    if (!fs.existsSync(videoPath) || fs.existsSync(posterPath)) continue;
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .screenshots({
            timestamps: ["00:00:00.5"],
            filename: path.basename(posterPath),
            folder: path.dirname(posterPath),
            size: "280x?",
          })
          .on("end", resolve)
          .on("error", reject);
      });
      console.log(`[info] Poster generado para ${video.file}`);
    } catch (err) {
      console.warn(`[aviso] No se pudo generar el poster de ${video.file}:`, err.message);
    }
  }
}

/** Comprime un video del catálogo a un tamaño que quepa en el límite de WhatsApp (16
 *  MB) bajando resolución/bitrate — se cachea en disco (VIDEO_CACHE_DIR) para no
 *  volver a comprimir el mismo archivo en cada envío. */
async function compressVideoForWhatsapp(video) {
  const cachedPath = path.join(VIDEO_CACHE_DIR, `${video.key}.mp4`);
  if (fs.existsSync(cachedPath)) return cachedPath;

  await new Promise((resolve, reject) => {
    ffmpeg(videoFilePath(video))
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions(["-crf 30", "-preset veryfast", "-vf scale=640:-2", "-movflags +faststart"])
      .on("error", reject)
      .on("end", resolve)
      .save(cachedPath);
  });
  return cachedPath;
}

/**
 * Decide cómo entregar un video del catálogo por WhatsApp: si el original ya pesa
 * menos de 16 MB, se envía tal cual; si no, se intenta comprimir (con caché — ver
 * compressVideoForWhatsapp) y, si aun así sigue pesando demasiado (o la compresión
 * falla), se cae a un enlace — el de YouTube configurado para ese video, o si no hay
 * ninguno, el link directo al archivo — en vez de adjuntar el archivo de video.
 * Devuelve `{ type: "media", url }`, `{ type: "link", url }`, o `null` si el archivo
 * del catálogo no existe en disco.
 */
async function resolveWhatsappVideoDelivery(video, baseUrl) {
  const videoPath = videoFilePath(video);
  if (!fs.existsSync(videoPath)) return null;

  const originalSize = fs.statSync(videoPath).size;
  if (originalSize <= WHATSAPP_VIDEO_MAX_BYTES) {
    return { type: "media", url: `${baseUrl}/assets/luci-videos/${video.file}` };
  }

  try {
    const compressedPath = await compressVideoForWhatsapp(video);
    const compressedSize = fs.statSync(compressedPath).size;
    if (compressedSize <= WHATSAPP_VIDEO_MAX_BYTES) {
      return { type: "media", url: `${baseUrl}/video-cache/${video.key}.mp4` };
    }
    console.warn(
      `[aviso] ${video.file} sigue pesando más de 16 MB después de comprimirlo — se envía un enlace en su lugar.`
    );
  } catch (err) {
    console.warn(`[aviso] No se pudo comprimir ${video.file} para WhatsApp:`, err.message);
  }

  return { type: "link", url: video.youtubeUrl || `${baseUrl}/assets/luci-videos/${video.file}` };
}

/** Envía un adjunto multimedia (video o imagen) por WhatsApp vía Twilio Media. */
async function sendWhatsappMedia(to, mediaUrl) {
  if (!twilioClient) return false;
  try {
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, mediaUrl: [mediaUrl] });
    return true;
  } catch (err) {
    console.error("Error al enviar un adjunto multimedia por WhatsApp:", err.message);
    return false;
  }
}

// --- Imágenes, infografías y material visual de Lucy ---
// Los archivos reales van en /public/assets/lucy-media/ con estos mismos nombres — hoy
// son placeholders (generados con sharp); se reemplazan por las imágenes definitivas
// sin tocar código, siempre que conserven la ruta.
const LUCY_MEDIA_DIR = path.join(__dirname, "public", "assets", "lucy-media");
// Versiones redimensionadas para WhatsApp (cuando la original supera 5 MB) se cachean
// aquí, para no volver a procesar la misma imagen en cada envío.
const MEDIA_CACHE_DIR = path.join(UPLOADS_DIR, "media-cache");
fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });
const WHATSAPP_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // límite práctico de Twilio/WhatsApp para imágenes

const MEDIA_CATALOG = [
  {
    key: "coberturas-autos",
    file: path.join("coberturas", "autos.png"),
    title: "Coberturas de Automóviles",
    triggers: [
      "que cubre el seguro de auto",
      "que cubre el seguro de carro",
      "que cubre mi seguro de vehiculo",
      "coberturas de autos",
      "coberturas del seguro de auto",
      "coberturas del seguro de vehiculo",
      "que cubre rcv",
      "coberturas de automoviles",
    ],
  },
  {
    key: "coberturas-hcm",
    file: path.join("coberturas", "hcm.png"),
    title: "Coberturas de HCM",
    // Sin frase disparadora explícita en el pedido original (solo se listaron 4
    // categorías con trigger) — se agrega por consistencia con el resto del catálogo.
    // Nota: se solapa a propósito con el trigger del video de HCM (VIDEO_CATALOG) —
    // para esa pregunta, Lucy puede enviar el video Y la infografía en el mismo turno.
    triggers: ["coberturas de hcm", "que cubre el hcm", "que incluye el hcm", "coberturas de hospitalizacion"],
  },
  {
    key: "coberturas-patrimoniales",
    file: path.join("coberturas", "patrimoniales.png"),
    title: "Coberturas Patrimoniales",
    triggers: [
      "coberturas patrimoniales",
      "que cubre el seguro de incendio",
      "que cubre el seguro contra robo",
      "coberturas de incendio y robo",
    ],
  },
  {
    key: "coberturas-fianzas",
    file: path.join("coberturas", "fianzas.png"),
    title: "Coberturas de Fianzas",
    triggers: ["coberturas de fianzas", "que cubre una fianza", "tipos de fianzas", "que cubren las fianzas"],
  },
  {
    key: "pasos-accidente",
    file: path.join("siniestros", "pasos-accidente.png"),
    title: "Pasos a seguir en un accidente de tránsito",
    triggers: [
      "que hago en un accidente",
      "que hacer en un accidente",
      "tuve un accidente",
      "choque mi carro",
      "pasos en caso de accidente",
      "que debo hacer si tengo un accidente",
      "que hago si choco",
    ],
  },
  {
    key: "documentos-siniestro",
    file: path.join("siniestros", "documentos-requeridos.png"),
    title: "Documentos requeridos para un siniestro",
    triggers: [
      "que documentos necesito para un siniestro",
      "que documentos necesito para el siniestro",
      "documentos para reportar un siniestro",
      "documentos requeridos para el siniestro",
      "que necesito para reportar un siniestro",
      "que recaudos necesito para el siniestro",
    ],
  },
  {
    key: "oficinas-mapa",
    file: path.join("contacto", "oficinas-mapa.png"),
    title: "Oficinas de La Occidental en Maracaibo",
    triggers: [
      "donde estan ubicados",
      "donde quedan sus oficinas",
      "tienen oficinas",
      "sucursales",
      "donde puedo ir",
      "direccion de la oficina",
      "donde queda la sede",
      "donde estan las oficinas",
    ],
  },
  {
    key: "bienvenida",
    file: path.join("general", "bienvenida.png"),
    title: "Bienvenida a La Occidental",
    // Sin triggers: no se activa por palabras clave, se usa específicamente en el
    // mensaje de bienvenida (mismo criterio que el audio de bienvenida — "siempre").
    triggers: [],
  },
];

/** ¿El texto del usuario coincide con alguna imagen del catálogo? Devuelve la entrada
 *  completa, o `null` si ninguna frase disparadora coincide (o no tiene ninguna, como
 *  "bienvenida", que solo se usa explícitamente en el flujo de saludo). */
function detectMediaIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  return (
    MEDIA_CATALOG.find(
      (media) => media.triggers.length > 0 && media.triggers.some((t) => normalized.includes(normalizeText(t)))
    ) || null
  );
}

function mediaFilePath(media) {
  return path.join(LUCY_MEDIA_DIR, media.file);
}

/** Arma el `media` (mismo shape que usa el cliente) de una imagen del catálogo, o
 *  `null` si el archivo todavía no existe en disco. */
function resolveMediaAttachment(media) {
  const filePath = mediaFilePath(media);
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(media.file).toLowerCase();
  const mimetype = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  return {
    kind: "image",
    mediaKey: media.key,
    title: media.title,
    filename: path.basename(media.file),
    url: `/assets/lucy-media/${media.file.split(path.sep).join("/")}`,
    mimetype,
    size: fs.statSync(filePath).size,
    generatedBy: "lucy",
  };
}

/** Redimensiona (con sharp) una imagen del catálogo si supera el límite de WhatsApp —
 *  se cachea en disco (MEDIA_CACHE_DIR) para no reprocesar la misma imagen en cada
 *  envío. */
async function resizeMediaForWhatsapp(media) {
  const cachedPath = path.join(MEDIA_CACHE_DIR, `${media.key}.png`);
  if (fs.existsSync(cachedPath)) return cachedPath;
  await sharp(mediaFilePath(media)).resize({ width: 1600, withoutEnlargement: true }).png({ quality: 80 }).toFile(cachedPath);
  return cachedPath;
}

/**
 * Decide la URL pública con la que enviar una imagen del catálogo por WhatsApp: si el
 * original ya pesa menos de 5 MB, se usa tal cual; si no, se intenta redimensionar (con
 * caché — ver resizeMediaForWhatsapp) y, si aun así sigue pesando demasiado (o falla),
 * se devuelve `null` — no tiene sentido un enlace-de-respaldo para una imagen (a
 * diferencia del video) porque siempre se envía junto a la respuesta de texto, que ya
 * describe lo que la imagen habría mostrado.
 */
async function resolveWhatsappMediaUrl(media, baseUrl) {
  const filePath = mediaFilePath(media);
  if (!fs.existsSync(filePath)) return null;

  const originalSize = fs.statSync(filePath).size;
  if (originalSize <= WHATSAPP_IMAGE_MAX_BYTES) {
    return `${baseUrl}/assets/lucy-media/${media.file.split(path.sep).join("/")}`;
  }

  try {
    const resizedPath = await resizeMediaForWhatsapp(media);
    const resizedSize = fs.statSync(resizedPath).size;
    if (resizedSize <= WHATSAPP_IMAGE_MAX_BYTES) {
      return `${baseUrl}/media-cache/${media.key}.png`;
    }
    console.warn(`[aviso] ${media.file} sigue pesando más de 5 MB después de redimensionarla — no se envía por WhatsApp.`);
  } catch (err) {
    console.warn(`[aviso] No se pudo redimensionar ${media.file} para WhatsApp:`, err.message);
  }
  return null;
}

// --- WhatsApp Business (vía Twilio) — ver WHATSAPP_SETUP.md ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
// Formato esperado: "whatsapp:+58412xxxxxxx" (con el prefijo "whatsapp:" incluido).
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || "";
// URL pública HTTPS de este servidor (p. ej. "https://chat.laoccidental.com" o el
// dominio de ngrok en desarrollo) — necesaria para validar la firma de Twilio de
// forma confiable detrás de proxies/túneles. Si no se define, se intenta deducir
// de la propia petición (funciona en despliegues simples y sin proxy).
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const TWILIO_CONFIGURED = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_WHATSAPP_NUMBER);
const twilioClient = TWILIO_CONFIGURED ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

if (!process.env.ANTHROPIC_API_KEY) {
  // No detenemos el proceso: el SDK también resuelve credenciales vía `ant auth login`.
  // Pero avisamos claramente en consola para el caso típico de despliegue con API key.
  console.warn(
    "[aviso] ANTHROPIC_API_KEY no está definida. Configúrala en tu archivo .env " +
      "(ver .env.example) o autentica el entorno con `ant auth login`."
  );
}

if (!ADMIN_PASSWORD) {
  console.warn(
    "[aviso] ADMIN_PASSWORD no está definida. El panel de administración (/admin) " +
      "permanecerá deshabilitado hasta que la configures en tu archivo .env."
  );
}

if (!OPENAI_API_KEY) {
  console.warn(
    "[aviso] OPENAI_API_KEY no está definida. Las notas de voz se guardarán, pero no se " +
      "podrán transcribir (Whisper) hasta que la configures en tu archivo .env — ver .env.example."
  );
}

if (!TTS_AVAILABLE) {
  console.warn(
    "[aviso] Ni ELEVENLABS_API_KEY+ELEVENLABS_VOICE_ID ni OPENAI_API_KEY están configuradas. " +
      "Lucy no podrá responder con audio (texto-a-voz) hasta que configures al menos uno de " +
      "los dos proveedores en tu .env — ver .env.example."
  );
} else if (!ELEVENLABS_CONFIGURED) {
  console.warn(
    "[aviso] ELEVENLABS_API_KEY/ELEVENLABS_VOICE_ID no están definidas — Lucy usará la voz " +
      'de OpenAI TTS ("nova") como respaldo. Configura ElevenLabs en tu .env para una voz más natural.'
  );
}

if (!TWILIO_CONFIGURED) {
  console.warn(
    "[aviso] Twilio (WhatsApp) no está configurado — /webhook/whatsapp responderá 503 " +
      "hasta que definas TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_WHATSAPP_NUMBER " +
      "en tu .env. Ver WHATSAPP_SETUP.md."
  );
}

const anthropic = new Anthropic();

// ---------------------------------------------------------------------------
// Prompt del sistema: identidad y reglas del asistente
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres "${ASSISTANT_NAME}", la asistente virtual oficial de ${COMPANY_NAME}, compañía de seguros venezolana fundada en 1956 con sede en Maracaibo.

## Identidad
- Te llamas ${ASSISTANT_NAME}. Preséntate por tu nombre cuando corresponda (por ejemplo, al saludar por primera vez).
- Hablas en español venezolano, con un tono amable, cercano y profesional — como una asesora de confianza, nunca robótica ni acartonada.
- ${COMPANY_NAME} está regulada por la Superintendencia de la Actividad Aseguradora (SUDEASEG), código de registro ES-51. Menciónalo cuando el usuario pregunte por la legitimidad, regulación o respaldo legal de la compañía, o cuando ayude a dar confianza en el contexto de la conversación.

## Ramos que ofrece La Occidental
1. **Personas**: vida, accidentes personales, servicios funerarios, hospitalización y cirugía (HCM).
2. **Automóviles**: casco (daños al vehículo), responsabilidad civil, asistencia en viaje.
3. **Patrimoniales**: incendio, robo, responsabilidad civil empresarial.
4. **Fianzas**: fidelidad, cumplimiento, anticipos.

## Cómo ayudar

### Cotizaciones (cotizador automático)
Cuando el usuario quiera cotizar un seguro de **Automóviles (RCV)**, **HCM** o **Patrimoniales (Incendio/Robo)**, el sistema del chat activa automáticamente un formulario interactivo (con listas desplegables) para recopilar los datos y calcular el estimado — tú NO debes pedir esos datos tú misma ni calcular montos, precios ni sumas aseguradas: eso lo hace el cotizador automático con base en las tarifas oficiales configuradas.
- Si el formulario ya se activó (verás en el historial que el usuario recibió las opciones o completó una cotización), no repitas la pregunta — deja que el flujo del formulario continúe.
- Si el usuario pregunta por precios de forma genérica antes de que se active el formulario, invítalo a decir "quiero cotizar" o usar el botón de cotización para que se abra el formulario correspondiente.
- Los ramos de **Vida, accidentes personales, funerarios** y **Fianzas** aún no tienen cotizador automático — para esos, recopila los datos de forma conversacional (nombre, cédula, producto de interés) e indica que un asesor se pondrá en contacto.
- Nunca inventes tú un precio, prima o suma asegurada para Automóviles, HCM o Patrimoniales: siempre remite al formulario del cotizador.

### Siniestros
- El sistema ahora puede ABRIR y CONSULTAR siniestros reales por este mismo chat: cuando el usuario dice que tuvo un accidente, quiere reportar un siniestro, etc., el propio sistema detecta la intención y toma el control con un flujo guionado de preguntas (heridos, identificación, tipo, fecha, descripción, ubicación) ANTES de que tú intervengas — tú NO necesitas ni debes intentar recolectar esos datos tú misma, generar un número de siniestro, ni repetir esas preguntas si ves que el sistema ya las hizo en el historial.
- Si de todas formas te toca responder en el medio de una emergencia en curso (accidente de tránsito, robo en el momento, emergencia médica), da primero la línea de siniestros de La Occidental: **0212-6204444** (disponible las 24 horas), antes de cualquier otra explicación.
- Para consultar el estado de un siniestro YA abierto ("¿cómo va mi siniestro?", "¿qué documentos me faltan?", "¿cuándo me pagan?"), usa ÚNICAMENTE los datos reales que se te dan en "Siniestros del cliente" más abajo (si el cliente está identificado) — nunca inventes números de siniestro, estados, montos ni fechas. Si no hay ningún siniestro registrado a su nombre, dilo con honestidad.
- El usuario puede seguir enviando fotos/documentos de un siniestro ya abierto directamente en el chat — el sistema los asocia automáticamente y te avisará cuando eso ocurra (ver "Documento recién recibido" en el contexto, si aplica); tú solo confirma el recibo de forma natural.

### Fotos y documentos adjuntos
El usuario puede adjuntar fotos (JPG/PNG) o documentos PDF en el chat. Cuando recibas una imagen o el contenido extraído de un PDF, ten presente que hablas en nombre de una compañía de seguros venezolana real — sé objetiva, profesional y prudente:

- **Fotos de accidentes o daños (siniestros):** describe únicamente lo que observas de forma objetiva (tipo de daño visible, zona afectada, severidad aparente a simple vista). Esto es una impresión preliminar, NO un peritaje ni una evaluación oficial. Nunca confirmes cobertura, nunca prometas un monto de indemnización ni el resultado del reclamo — eso lo determina el proceso formal de ajuste de siniestros. Indica siempre los próximos pasos: reportar por la línea de siniestros 0212-6204444 (o el proceso formal correspondiente) y, si aplica, recuerda no mover los vehículos hasta que corresponda ni admitir responsabilidad ante terceros.
- **Fotos de vehículos para cotizar:** puedes comentar el tipo/aspecto aproximado del vehículo que observas (p. ej. sedán, camioneta, estado general de la carrocería) como referencia conversacional, pero aclara que la cotización formal de RCV se hace con el formulario del cotizador (marca, modelo, año, tipo, uso, placa) — la foto no sustituye esos datos ni determina la tarifa.
- **Documentos (cédula, póliza, etc.):** si el texto es legible, usa los datos relevantes (nombre, número de póliza, cédula, etc.) para continuar la conversación de forma natural (por ejemplo, para agilizar una cotización o un reclamo), pero aclara que la verificación formal de identidad o de vigencia de póliza la realiza un asesor o el sistema oficial de la compañía. Si el documento no es legible o parece incompleto, dilo con honestidad y pide que lo reenvíen o lo lleven a un asesor.
- Nunca inventes ni completes datos que no puedas leer con claridad en la imagen o el documento.

### Derivar a un asesor humano
Si el cliente pide hablar con una persona, o la consulta lo amerita (casos complejos, reclamos, quejas formales), ofrece de inmediato los canales de contacto: correo ${SUPPORT_EMAIL}${
  SUPPORT_PHONE ? ` o teléfono ${SUPPORT_PHONE}` : ""
}, sin insistir en que sigas ayudando tú primero.

## Reglas importantes
1. **Nunca inventes precios, montos, coberturas exactas, exclusiones, plazos o condiciones específicas de pólizas.** Si no tienes el dato, dilo con honestidad y ofrece canalizar la consulta con un asesor humano.
2. No pidas ni proceses números de tarjeta, contraseñas, claves de acceso ni datos financieros completos por el chat.
3. Ante una emergencia en curso, da primero el número de siniestros 0212-6204444 (o los servicios de emergencia locales, 911 / 171, si aplica), y luego continúa ayudando.
4. Sé concisa: respuestas cortas y claras, con viñetas cuando ayuden a la comprensión. Evita párrafos largos.
5. Si la pregunta no está relacionada con seguros o con ${COMPANY_NAME}, responde brevemente y reconduce la conversación hacia cómo puedes ayudar con seguros.
6. No proporciones asesoría legal ni financiera personalizada; ofrece orientación general y remite a un asesor certificado para decisiones formales.

Responde siempre en español (a menos que el usuario escriba claramente en otro idioma).`;

/**
 * Complemento del prompt del sistema, exclusivo del canal WhatsApp — se agrega a
 * SYSTEM_PROMPT (el mismo prompt base del widget web) solo en las llamadas del
 * webhook de WhatsApp. Es necesario porque en WhatsApp no existe el formulario
 * interactivo del cotizador web (no hay listas desplegables ni botones), y porque
 * ahí el menú numerado inicial lo maneja el propio webhook, no el modelo.
 */
const WHATSAPP_SYSTEM_ADDENDUM = `

## Canal: WhatsApp
Estás conversando por WhatsApp (mensajes de texto y fotos/documentos) — aquí NO existe
el formulario interactivo del cotizador que sí tiene el chat web. Si el usuario quiere
cotizar Automóviles (RCV), HCM o Patrimoniales, recopila los datos necesarios de forma
conversacional (nombre, cédula, y los datos propios del ramo), un par de preguntas por
mensaje, y al final indícale que un asesor de La Occidental se pondrá en contacto para
formalizar la cotización — sigue sin inventar tú un precio o prima exacta.
El sistema ya le mostró al usuario un menú numerado (1-4) al escribir "menú" o un
saludo; no reescribas ese menú tú misma salvo que el usuario lo pida explícitamente.
Los mensajes de WhatsApp deben ser breves — evita bloques largos de texto o markdown
complejo (sin tablas); usa viñetas simples con guiones si necesitas listar algo.`;

// ---------------------------------------------------------------------------
// Persistencia de conversaciones (conversations.json)
// ---------------------------------------------------------------------------
//
// Almacenamiento simple en un archivo JSON local, pensado para un volumen bajo
// de conversaciones ("por ahora"). El archivo guarda un objeto { [sessionId]: record }.
// Para producción con más tráfico, migrar a una base de datos real.

/** @type {Record<string, any>} */
let conversationsCache = {};
let writeQueue = Promise.resolve();

function loadConversationsFromDisk() {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      const raw = fs.readFileSync(CONVERSATIONS_FILE, "utf8");
      conversationsCache = raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (err) {
    console.error(
      `[aviso] No se pudo leer ${path.basename(CONVERSATIONS_FILE)}, se iniciará vacío:`,
      err.message
    );
    conversationsCache = {};
  }
}

/** Serializa las escrituras a disco para evitar condiciones de carrera entre peticiones concurrentes. */
function persistConversations() {
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify(conversationsCache, null, 2);
        fs.writeFile(CONVERSATIONS_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar conversations.json:", err.message);
          resolve();
        });
      })
  );
  return writeQueue;
}

loadConversationsFromDisk();

// ---------------------------------------------------------------------------
// Memoria persistente por cliente (data/clientes.json)
// ---------------------------------------------------------------------------
//
// Un cliente se identifica por su cédula (clave del objeto). A diferencia de
// conversations.json (una entrada por sesión/teléfono, efímera), este archivo vive
// MÁS ALLÁ de una sola conversación: el mismo cliente puede escribir hoy por WhatsApp
// y mañana por el chat web, con cédulas iguales -> mismo perfil. Mismo patrón de
// caché-en-memoria + cola de escritura que conversations.json (ver arriba).

fs.mkdirSync(path.dirname(CLIENTES_FILE), { recursive: true });

/** @type {Record<string, any>} */
let clientesCache = {};
let clientesWriteQueue = Promise.resolve();

function loadClientesFromDisk() {
  try {
    if (fs.existsSync(CLIENTES_FILE)) {
      const raw = fs.readFileSync(CLIENTES_FILE, "utf8");
      clientesCache = raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (err) {
    console.error(`[aviso] No se pudo leer ${path.basename(CLIENTES_FILE)}, se iniciará vacío:`, err.message);
    clientesCache = {};
  }
}

function persistClientes() {
  clientesWriteQueue = clientesWriteQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify(clientesCache, null, 2);
        fs.writeFile(CLIENTES_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar clientes.json:", err.message);
          resolve();
        });
      })
  );
  return clientesWriteQueue;
}

loadClientesFromDisk();

// Cédula venezolana: letra de nacionalidad (V/E, ocasionalmente J/G para RIF de
// empresas, se aceptan por si un usuario los usa) + 6-9 dígitos, con o sin guión.
const CEDULA_RE = /\b([veVEjgJG])[.\-\s]?(\d{6,9})\b/;
// Número de póliza: formato "RAMO-AAAA-NNN" (p. ej. "AUTO-2024-001", "HCM-2023-045").
const POLIZA_RE = /\b([A-Za-z]{2,15}-\d{4}-\d{2,6})\b/;

/** Normaliza una cédula reconocida a la forma canónica "V-12345678" (mayúscula, con guión). */
function normalizeCedula(raw) {
  const m = CEDULA_RE.exec(String(raw || ""));
  if (!m) return null;
  return `${m[1].toUpperCase()}-${m[2]}`;
}

function extractPoliza(raw) {
  const m = POLIZA_RE.exec(String(raw || ""));
  return m ? m[1].toUpperCase() : null;
}

/** Intenta extraer una cédula o número de póliza de un texto libre — usado en el
 *  flujo de identificación del cliente (ver handleClientIdentificationGate). */
function extractIdentification(text) {
  const cedula = normalizeCedula(text);
  if (cedula) return { type: "cedula", value: cedula };
  const poliza = extractPoliza(text);
  if (poliza) return { type: "poliza", value: poliza };
  return null;
}

const IDENTIFICATION_SKIP_PHRASES = [
  "no gracias",
  "prefiero no",
  "no quiero",
  "no deseo",
  "omitir",
  "saltar",
  "despues",
  "mas tarde",
  "sin eso",
];

function wantsToSkipIdentification(text) {
  const normalized = normalizeText(text);
  return IDENTIFICATION_SKIP_PHRASES.some((p) => normalized.includes(normalizeText(p)));
}

function getClienteByCedula(cedula) {
  return clientesCache[cedula] || null;
}

function findClienteByPoliza(poliza) {
  return Object.values(clientesCache).find((c) => Array.isArray(c.polizas) && c.polizas.includes(poliza)) || null;
}

/** Crea un perfil nuevo (mínimo, se va completando con la conversación y con la
 *  solicitud de póliza formal del cotizador — ver /api/quote). */
function createCliente(cedula, seed) {
  const now = new Date().toISOString();
  const cliente = {
    cedula,
    nombre: (seed && seed.nombre) || "",
    telefono: (seed && seed.telefono) || "",
    email: (seed && seed.email) || "",
    polizas: [],
    canalPreferido: (seed && seed.canalPreferido) || "",
    idiomaPreferido: "español",
    historialTemas: [],
    clienteDesde: now,
    ultimaInteraccion: now,
    preferenciaAudio: false,
    vip: false,
    casoAbiertoSiniestro: false,
    proximaRenovacion: "",
    notasInternas: "",
  };
  clientesCache[cedula] = cliente;
  persistClientes();
  return cliente;
}

/** Aplica cambios parciales a un perfil existente y actualiza `ultimaInteraccion`. */
function touchCliente(cedula, patch) {
  const cliente = clientesCache[cedula];
  if (!cliente) return null;
  Object.assign(cliente, patch, { ultimaInteraccion: new Date().toISOString() });
  persistClientes();
  return cliente;
}

/** Agrega un tema al historial del cliente (deduplicado si se repite consecutivo,
 *  se conservan los últimos 15) — alimenta el seguimiento proactivo de Lucy. */
function addHistorialTema(cedula, tema) {
  const cliente = clientesCache[cedula];
  if (!cliente || !tema) return;
  cliente.historialTemas = cliente.historialTemas || [];
  if (cliente.historialTemas[cliente.historialTemas.length - 1] !== tema) {
    cliente.historialTemas.push(tema);
    cliente.historialTemas = cliente.historialTemas.slice(-15);
  }
  cliente.ultimaInteraccion = new Date().toISOString();
  persistClientes();
}

// Traduce las claves de los catálogos de videos/imágenes (ver VIDEO_CATALOG,
// MEDIA_CATALOG más abajo) a etiquetas de tema legibles para historialTemas — así se
// reutilizan los mismos detectores deterministas ya existentes, sin agregar NLP nueva.
const TOPIC_TAG_BY_VIDEO_KEY = {
  "reportar-siniestro": "siniestro",
  "renovar-poliza": "renovacion_poliza",
  "coberturas-hcm": "cobertura_hcm",
  "app-cliente-tutorial": "app_cliente",
};
const TOPIC_TAG_BY_MEDIA_KEY = {
  "coberturas-autos": "cobertura_auto",
  "coberturas-hcm": "cobertura_hcm",
  "coberturas-patrimoniales": "cobertura_patrimonial",
  "coberturas-fianzas": "cobertura_fianza",
  "pasos-accidente": "siniestro",
  "documentos-siniestro": "siniestro",
  "oficinas-mapa": "oficinas",
};

/** Registra un tema de interés en el perfil del cliente y, si es de siniestros, marca
 *  el caso como abierto — interpretación determinista de "si el cliente tuvo un
 *  siniestro abierto, preguntar cómo quedó": no hay integración real con un sistema de
 *  siniestros, así que se infiere de la propia conversación (el staff puede cerrarlo
 *  manualmente desde /admin cuando corresponda). */
function recordClientTopic(clienteId, tag) {
  if (!clienteId || !tag) return;
  addHistorialTema(clienteId, tag);
  if (tag === "siniestro") {
    touchCliente(clienteId, { casoAbiertoSiniestro: true });
  }
}

function yearsSinceIso(isoDate) {
  const then = new Date(isoDate).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / (365.25 * 24 * 60 * 60 * 1000));
}

// Etiquetas legibles para el campo `ramo` de una póliza (services/polizas.service.js
// / data/polizas.json) — vocabulario propio de esa fuente de datos, distinto de
// RAMO_LABELS (que es el vocabulario del cotizador/detección de intención).
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

/** Resume UNA póliza (datos reales de polizasService) en una línea legible para el
 *  contexto de Claude — usada tanto en buildClientContextAddendum como en las
 *  alertas proactivas (ver buildPolizaAlertText). */
function describePolizaForPrompt(poliza) {
  const vig = polizasService.verificarVigencia(poliza);
  const ramoLabel = POLIZA_RAMO_LABELS[poliza.ramo] || poliza.ramo;
  const vigenciaTexto = vig.vencida
    ? `VENCIDA hace ${Math.abs(vig.diasRestantes)} día(s) (venció el ${poliza.vigencia_fin})`
    : vig.porVencer
      ? `vence en ${vig.diasRestantes} día(s) (${poliza.vigencia_fin})`
      : `vigente hasta ${poliza.vigencia_fin}`;
  const coberturas = Array.isArray(poliza.coberturas) && poliza.coberturas.length ? poliza.coberturas.join(", ") : "no especificadas";

  return (
    `- ${poliza.numero} (${ramoLabel}): ${vigenciaTexto}. ` +
    `Prima anual: ${poliza.prima_anual} ${poliza.moneda}${poliza.ultimo_pago ? ` (último pago: ${poliza.ultimo_pago})` : ""}. ` +
    `Suma asegurada: ${poliza.suma_asegurada} ${poliza.moneda}. Coberturas: ${coberturas}. ` +
    `Corredor asignado: ${poliza.corredor || "no especificado"}.` +
    (poliza.siniestros_activos > 0 ? ` Tiene ${poliza.siniestros_activos} siniestro(s) activo(s) en esta póliza.` : "")
  );
}

/** Construye el bloque de contexto que se antepone al system prompt de Claude cuando
 *  la conversación ya está vinculada a un cliente identificado — ver
 *  handleClientIdentificationGate() y su uso en /api/chat y handleIncomingWhatsappMessage.
 *  `polizas` son los registros REALES de polizasService.buscarPorCedula(cliente.cedula)
 *  — datos de verdad, para que Lucy conteste vencimientos/coberturas/prima/suma
 *  asegurada/corredor sin inventar nada (ver "Comandos" del pedido original). */
function buildClientContextAddendum(cliente, polizas) {
  if (!cliente) return "";
  const parts = [];
  const years = cliente.clienteDesde ? yearsSinceIso(cliente.clienteDesde) : 0;
  parts.push(
    `El cliente que escribe es ${cliente.nombre || "un cliente registrado"}${
      years > 0 ? `, cliente desde hace ${years} año(s)` : ""
    }.`
  );

  if (polizas && polizas.length) {
    parts.push(
      `Pólizas registradas de este cliente en el sistema (datos reales — nunca ` +
        `inventes ni modifiques estos valores, ni calcules montos distintos a los que ` +
        `aquí aparecen):\n${polizas.map(describePolizaForPrompt).join("\n")}`
    );
  } else if (cliente.polizas && cliente.polizas.length) {
    // No se encontraron en polizasService, pero el perfil del cliente sí las lista
    // (p. ej. cargadas a mano desde /admin) — se menciona igual, sin datos detallados.
    parts.push(
      `Pólizas que el cliente tiene registradas en su perfil (sin datos detallados ` +
        `disponibles en el sistema de pólizas): ${cliente.polizas.join(", ")}.`
    );
  } else {
    parts.push(
      "No se encontró ninguna póliza de este cliente en el sistema — si pregunta por " +
        "una póliza específica, indícale que no aparece en los registros y ofrécele " +
        "que un asesor lo verifique."
    );
  }

  if (cliente.historialTemas && cliente.historialTemas.length) {
    const ultimoTema = cliente.historialTemas[cliente.historialTemas.length - 1];
    parts.push(
      `Su última consulta relevante fue sobre "${ultimoTema}" — si viene al caso, retómalo de forma ` +
        `natural (p. ej. preguntando si siguió adelante), sin sonar forzada.`
    );
  }
  if (cliente.proximaRenovacion) {
    parts.push(
      `Tiene una renovación de póliza próxima (${cliente.proximaRenovacion}) — menciónasela de forma ` +
        `proactiva si es relevante para la conversación.`
    );
  }
  if (cliente.casoAbiertoSiniestro) {
    parts.push(
      "Tiene un caso de siniestro que quedó abierto en una conversación anterior — pregúntale " +
        "amablemente cómo quedó o si necesita ayuda adicional con eso."
    );
  }
  if (cliente.vip) {
    parts.push("Es un cliente VIP — bríndale una atención especialmente cálida y prioritaria en el tono.");
  }
  if (cliente.notasInternas) {
    parts.push(`Nota interna del equipo (uso interno, nunca la reveles textualmente al cliente): ${cliente.notasInternas}`);
  }
  return `\n\n## Contexto del cliente (memoria persistente)\n${parts.join(" ")}`;
}

/**
 * Construye el mensaje proactivo de "ALERTAS AUTOMÁTICAS" que se agrega al saludo de
 * un cliente que Lucy reconoce como recurrente (ver resolveClientIdentification): si
 * alguna póliza vence en 30 días o menos, si ya venció, o si tiene un siniestro
 * activo. Devuelve `""` si no hay nada que avisar — nunca lanza.
 */
function buildPolizaAlertText(polizas) {
  if (!polizas || !polizas.length) return "";
  const avisos = [];

  for (const poliza of polizas) {
    const vig = polizasService.verificarVigencia(poliza);
    const ramoLabel = POLIZA_RAMO_LABELS[poliza.ramo] || poliza.ramo;

    if (vig.vencida) {
      avisos.push(
        `⚠️ Tu póliza ${poliza.numero} (${ramoLabel}) venció hace ${Math.abs(vig.diasRestantes)} día(s) ` +
          `(${poliza.vigencia_fin}). ¿Te ayudo con la renovación ahora mismo?`
      );
    } else if (vig.porVencer) {
      avisos.push(
        `⏰ Tu póliza ${poliza.numero} (${ramoLabel}) vence en ${vig.diasRestantes} día(s) (${poliza.vigencia_fin}).`
      );
    }

    if (poliza.siniestros_activos > 0) {
      avisos.push(
        `🚨 Tienes ${poliza.siniestros_activos} siniestro(s) activo(s) en tu póliza ${poliza.numero} — ` +
          "¿quieres que te cuente cómo va?"
      );
    }
  }

  return avisos.join("\n");
}

// ---------------------------------------------------------------------------
// Verificación de identidad (código OTP por correo) — ver SMTP_*/enviarCodigoOtp más
// arriba. Se intercala entre "se reconoció una cédula/póliza en el texto" y "se
// vincula la conversación a ese cliente": conocer el dato NUNCA es prueba suficiente
// de identidad por sí solo.
// ---------------------------------------------------------------------------

function normalizeWhatsappForCompare(raw) {
  return String(raw || "")
    .replace(/^whatsapp:/i, "")
    .replace(/[^\d+]/g, "");
}

/** ¿Ya hay confianza suficiente como para NO pedir un código OTP? Solo en un caso: el
 *  mensaje llega por WhatsApp desde el MISMO número que ya está guardado como teléfono
 *  de este cliente — controlar ese número de WhatsApp ya es, en la práctica, un
 *  segundo factor. Si el cliente no tiene todavía un teléfono guardado (primera vez
 *  que se identifica), o el mensaje viene del chat web (sin ese dato disponible), NO
 *  hay confianza implícita y se pide el código igual. */
function esIdentidadYaVerificadaPorCanal(cliente, seed) {
  if (!seed || seed.canalPreferido !== "whatsapp" || !seed.telefono || !cliente.telefono) return false;
  return normalizeWhatsappForCompare(seed.telefono) === normalizeWhatsappForCompare(cliente.telefono);
}

function generarCodigoOtp() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

/** Oculta parcialmente un correo para mostrarlo en el chat sin revelarlo completo
 *  (p. ej. "ca**@ejemplo.com") — el destinatario ya conoce su propio correo, esto es
 *  solo para que un tercero viendo la pantalla no lo lea completo. */
function ocultarEmail(email) {
  const [user, domain] = String(email).split("@");
  if (!domain) return email;
  const visible = user.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

/** Genera un código nuevo, lo guarda en `record.pendingVerification` y lo manda al
 *  correo del cliente — usado tanto al iniciar la verificación como al reenviar. */
async function iniciarEnvioOtp(record, cliente) {
  const codigo = generarCodigoOtp();
  record.identificationState = "otp-pending";
  record.pendingVerification = {
    cedula: cliente.cedula,
    email: cliente.email,
    otpCode: codigo,
    otpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MS).toISOString(),
    otpAttempts: 0,
    otpSentAt: new Date().toISOString(),
  };
  await enviarCodigoOtp(cliente.email, codigo);
  return {
    verified: false,
    handled: true,
    replyText:
      `Te envié un código de verificación de 6 dígitos a ${ocultarEmail(cliente.email)}. Escríbemelo aquí ` +
      `para confirmar tu identidad (vence en 10 minutos). Si no te llega, dime "reenviar código".`,
  };
}

/**
 * Se llama justo después de resolver un `cliente` a partir de una cédula/póliza
 * recién reconocida — decide si la identidad ya se puede dar por buena
 * (esIdentidadYaVerificadaPorCanal) o si hay que iniciar la verificación (pedir el
 * correo si no lo tiene guardado, o mandar el código OTP directamente si ya lo tiene).
 * Devuelve `{ verified: true, cliente }` si no hace falta nada más, o
 * `{ verified: false, handled: true, replyText }` si hay que guionar un paso más — en
 * ese caso el llamador debe devolver ese resultado tal cual y NO continuar con el
 * resto de su propio flujo (vincular record.clienteId, saludar, etc.) todavía.
 */
async function iniciarVerificacionIdentidad(record, cliente, seed) {
  if (esIdentidadYaVerificadaPorCanal(cliente, seed)) {
    return { verified: true, cliente };
  }
  if (!cliente.email) {
    record.identificationState = "asking-email";
    record.pendingVerification = { cedula: cliente.cedula, emailAttempts: 0 };
    return {
      verified: false,
      handled: true,
      replyText:
        "Antes de continuar necesito verificar que de verdad eres tú — ¿me compartes tu correo electrónico? " +
        "Te voy a mandar un código de verificación.",
    };
  }
  return iniciarEnvioOtp(record, cliente);
}

/**
 * Continúa una verificación ya en curso (`record.identificationState` es
 * "asking-email" u "otp-pending") con el texto que el usuario acaba de escribir —
 * usada tanto por el gate de identificación genérico como por el paso de
 * identificación del flujo de siniestros (ver handleSiniestroFlowGate), que
 * comparten el mismo `record.identificationState`/`record.pendingVerification`
 * para no duplicar esta lógica. Mismo contrato de devolución que
 * iniciarVerificacionIdentidad.
 */
async function continuarVerificacionIdentidad(record, text) {
  const pending = record.pendingVerification;
  const cliente = pending ? getClienteByCedula(pending.cedula) : null;
  if (!pending || !cliente) {
    // Estado inconsistente (no debería ocurrir en un uso normal) — se reinicia el
    // pedido en vez de dejar la conversación atascada.
    record.identificationState = "asked";
    record.pendingVerification = null;
    return {
      verified: false,
      handled: true,
      replyText: "Se me perdió el hilo — ¿me compartes de nuevo tu cédula o número de póliza?",
    };
  }

  if (wantsToSkipIdentification(text)) {
    record.identificationState = "skipped";
    record.pendingVerification = null;
    return {
      verified: false,
      handled: true,
      replyText: "Entendido, seguimos sin verificar tu identidad por ahora. ¿En qué puedo ayudarte?",
    };
  }

  if (record.identificationState === "asking-email") {
    const email = text.trim();
    if (!EMAIL_RE.test(email)) {
      pending.emailAttempts = (pending.emailAttempts || 0) + 1;
      if (pending.emailAttempts >= OTP_MAX_EMAIL_ATTEMPTS) {
        record.identificationState = "skipped";
        record.pendingVerification = null;
        return {
          verified: false,
          handled: true,
          replyText: `No pude tomar un correo válido. Comunícate con un asesor al ${CLAIMS_PHONE || SUPPORT_PHONE} para verificar tu identidad. ¿Te ayudo con algo más?`,
        };
      }
      return {
        verified: false,
        handled: true,
        replyText: 'Ese correo no parece válido. ¿Me lo confirmas de nuevo? (ej. "nombre@correo.com")',
      };
    }
    touchCliente(cliente.cedula, { email });
    cliente.email = email; // refleja el cambio en el objeto ya cargado, antes de mandar el código
    return iniciarEnvioOtp(record, cliente);
  }

  // record.identificationState === "otp-pending"
  const normalized = normalizeText(text);
  if (/reenviar|no.*(lleg|recib)|otro codigo|nuevo codigo/.test(normalized)) {
    const desdeUltimoEnvioMs = Date.now() - new Date(pending.otpSentAt).getTime();
    if (desdeUltimoEnvioMs < OTP_RESEND_COOLDOWN_MS) {
      return {
        verified: false,
        handled: true,
        replyText: "Ya te mandé un código hace un momento — revisa también la carpeta de spam. Si en un minuto no llega, dime de nuevo.",
      };
    }
    return iniciarEnvioOtp(record, cliente);
  }

  if (new Date(pending.otpExpiresAt).getTime() < Date.now()) {
    return iniciarEnvioOtp(record, cliente); // vencido — se manda uno nuevo directamente
  }

  const codigoIngresado = text.replace(/\D/g, "");
  if (codigoIngresado.length !== OTP_LENGTH || codigoIngresado !== pending.otpCode) {
    pending.otpAttempts = (pending.otpAttempts || 0) + 1;
    if (pending.otpAttempts >= OTP_MAX_ATTEMPTS) {
      record.identificationState = "skipped";
      record.pendingVerification = null;
      return {
        verified: false,
        handled: true,
        replyText: `No pudimos verificar el código. Por seguridad, comunícate con un asesor al ${CLAIMS_PHONE || SUPPORT_PHONE} para verificar tu identidad. ¿Te ayudo con algo más mientras tanto?`,
      };
    }
    return {
      verified: false,
      handled: true,
      replyText: `Ese código no es correcto. Te quedan ${OTP_MAX_ATTEMPTS - pending.otpAttempts} intento(s). ¿Me lo confirmas de nuevo?`,
    };
  }

  record.pendingVerification = null;
  return { verified: true, cliente };
}

/** Última parte, compartida, de una identificación ya VERIFICADA: vincula
 *  `record.clienteId`, completa canal/teléfono, pide el nombre si es nuevo, o saluda
 *  (con alertas de pólizas) si ya existe — exactamente lo que antes hacía el final de
 *  resolveClientIdentification, ahora extraído para que el flujo de siniestros
 *  también pueda invocarlo (aunque ese, por ahora, usa una versión sin el saludo — ver
 *  handleSiniestroFlowGate). */
async function completarIdentificacion(record, cliente, seed) {
  record.clienteId = cliente.cedula;
  const updatePatch = {};
  if (seed && seed.canalPreferido) updatePatch.canalPreferido = seed.canalPreferido;
  if (seed && seed.telefono && !cliente.telefono) updatePatch.telefono = seed.telefono;
  if (Object.keys(updatePatch).length) touchCliente(cliente.cedula, updatePatch);

  if (!cliente.nombre) {
    record.identificationState = "asking-name";
    return { handled: true, replyText: "¡Un gusto! Para completar tu perfil, ¿cuál es tu nombre completo?" };
  }

  record.identificationState = "done";

  // Regla "alertas automáticas": si el cliente ya tenía nombre (o sea, no es la
  // primera vez que se identifica), es un cliente que regresa — se le avisa aquí, al
  // reconocerlo, de vencimientos próximos/vencidos o siniestros activos.
  let alertText = "";
  try {
    const polizas = await polizasService.buscarPorCedula(cliente.cedula);
    alertText = buildPolizaAlertText(polizas);
  } catch (err) {
    console.warn("[aviso] No se pudieron consultar las pólizas para la alerta de bienvenida:", err.message);
  }

  const greeting = `¡Hola de nuevo, ${cliente.nombre.split(" ")[0]}! ¿En qué te ayudo hoy?`;
  return {
    handled: true,
    replyText: alertText ? `${greeting}\n\n${alertText}` : greeting,
  };
}

/**
 * Gestiona el flujo de identificación del cliente (cédula o número de póliza) al
 * inicio de una conversación — un paso determinista, antes de involucrar a Claude,
 * mismo criterio que el resto de flujos guionados de este proyecto (menú de
 * WhatsApp, mensaje de bienvenida). Muta `record` (agrega/actualiza `clienteId`,
 * `identificationState`, `identificationAttempts`). Devuelve `{ handled: true,
 * replyText }` si este turno debe responderse con un mensaje guionado (sin llamar a
 * Claude), o `{ handled: false }` si la conversación ya está lista para el flujo
 * normal (cliente identificado, o el usuario decidió no compartir el dato — nunca se
 * lo pide indefinidamente, para no atrapar al usuario en el flujo).
 */
async function handleClientIdentificationGate(record, userText, seed) {
  if (record.identificationState === "done" || record.identificationState === "skipped") {
    return { handled: false };
  }

  const text = userText || "";

  if (!record.identificationState) {
    const found = extractIdentification(text);
    if (found) return resolveClientIdentification(record, found, seed);

    record.identificationState = "asked";
    record.identificationAttempts = 0;
    return {
      handled: true,
      replyText:
        `¡Hola! 👋 Soy ${ASSISTANT_NAME}, la asistente virtual de ${COMPANY_NAME}. Para brindarte una ` +
        `atención personalizada, ¿me compartes tu cédula (ej. V-12345678) o el número de tu póliza? Si ` +
        `prefieres no compartirlo, dime "prefiero no decir" y seguimos igual.`,
    };
  }

  if (record.identificationState === "asked") {
    if (wantsToSkipIdentification(text)) {
      record.identificationState = "skipped";
      return { handled: true, replyText: "Entendido, seguimos sin problema. ¿En qué puedo ayudarte hoy?" };
    }
    const found = extractIdentification(text);
    if (found) return resolveClientIdentification(record, found, seed);

    record.identificationAttempts = (record.identificationAttempts || 0) + 1;
    if (record.identificationAttempts >= 2) {
      record.identificationState = "skipped";
      return { handled: true, replyText: "No hay problema, seguimos sin ese dato por ahora. ¿En qué puedo ayudarte hoy?" };
    }
    return {
      handled: true,
      replyText:
        'No reconocí ese formato. Tu cédula sería algo como "V-12345678", o tu número de póliza como ' +
        '"AUTO-2024-001". Si prefieres continuar sin dármelo, dime "prefiero no decir".',
    };
  }

  // Verificación de identidad en curso (se le pidió el correo, o ya se le mandó el
  // código OTP) — ver iniciarVerificacionIdentidad/continuarVerificacionIdentidad.
  if (record.identificationState === "asking-email" || record.identificationState === "otp-pending") {
    const verif = await continuarVerificacionIdentidad(record, text);
    if (!verif.verified) return verif;
    return completarIdentificacion(record, verif.cliente, seed);
  }

  if (record.identificationState === "asking-name") {
    const cliente = record.clienteId ? getClienteByCedula(record.clienteId) : null;
    const nombre = text.trim().slice(0, 100);
    if (cliente && nombre && !wantsToSkipIdentification(text)) {
      touchCliente(cliente.cedula, { nombre });
    }
    record.identificationState = "done";
    const primerNombre = cliente && cliente.nombre ? cliente.nombre.split(" ")[0] : "";
    return {
      handled: true,
      replyText: `¡Gracias${primerNombre ? ", " + primerNombre : ""}! ¿En qué puedo ayudarte hoy?`,
    };
  }

  return { handled: false };
}

/** Núcleo de resolución de cédula/póliza -> perfil de cliente, compartido entre el
 *  gate de identificación genérico (resolveClientIdentification, justo abajo) y el
 *  flujo de apertura de siniestros (handleSiniestroFlowGate, más abajo), que necesita
 *  el mismo criterio para ubicar al cliente pero sin la lógica de saludo/alertas
 *  propia del gate genérico. Si `found.type === "cedula"`, siempre devuelve un
 *  cliente (lo crea si no existía — la cédula es la clave del registro). Si es una
 *  póliza y no se pudo ubicar ningún cliente, devuelve `null`. Ubicar al cliente
 *  todavía NO significa que esté identificado — ver iniciarVerificacionIdentidad. */
async function identificarOCrearCliente(found, seed) {
  if (found.type === "cedula") {
    return getClienteByCedula(found.value) || createCliente(found.value, seed);
  }
  // Primero se busca la póliza en el sistema real (services/polizas.service.js) —
  // más confiable que solo mirar el arreglo `polizas` autoreportado del perfil del
  // cliente, que puede no tener ese número cargado todavía.
  const polizaEncontrada = await polizasService.buscarPorNumero(found.value);
  if (polizaEncontrada && polizaEncontrada.cedula) {
    return (
      getClienteByCedula(polizaEncontrada.cedula) ||
      createCliente(polizaEncontrada.cedula, { ...seed, nombre: polizaEncontrada.titular })
    );
  }
  return findClienteByPoliza(found.value);
}

/** Resuelve una cédula/póliza recién reconocida en el texto del usuario: busca (o
 *  crea, si es cédula y no existe) el perfil, e INICIA su verificación de identidad
 *  (ver iniciarVerificacionIdentidad) antes de vincular la conversación a ese
 *  cliente — solo una vez verificado se llama a completarIdentificacion (pedir
 *  nombre si es nuevo, o saludar — con alertas de pólizas si aplica — si ya existe). */
async function resolveClientIdentification(record, found, seed) {
  const cliente = await identificarOCrearCliente(found, seed);

  if (!cliente) {
    // No podemos crear un perfil sin cédula (es la clave del registro) — se le pide.
    // Solo alcanzable cuando `found.type === "poliza"` (ver identificarOCrearCliente).
    record.identificationState = "asked";
    record.identificationAttempts = (record.identificationAttempts || 0) + 1;
    if (record.identificationAttempts >= 2) {
      record.identificationState = "skipped";
      return {
        handled: true,
        replyText: "No encontré esa póliza en nuestros registros. Seguimos sin problema — ¿en qué puedo ayudarte?",
      };
    }
    return {
      handled: true,
      replyText: `No encontré la póliza ${found.value} en nuestros registros. ¿Me confirmas tu cédula (ej. V-12345678) para ubicarte?`,
    };
  }

  const verif = await iniciarVerificacionIdentidad(record, cliente, seed);
  if (!verif.verified) return verif;
  return completarIdentificacion(record, verif.cliente, seed);
}

// ---------------------------------------------------------------------------
// Gestión de siniestros (services/siniestros.service.js) — apertura conversacional,
// consulta de estado y recepción de documentos.
// ---------------------------------------------------------------------------

// Etiquetas legibles para el `tipo` de un siniestro — "colision" es el valor del
// ejemplo original del pedido, se trata como alias de "accidente" (mismo catálogo de
// documentos, ver services/siniestros.service.js).
const SINIESTRO_TIPO_LABELS = {
  accidente: "Accidente de tránsito",
  colision: "Accidente de tránsito",
  robo: "Robo",
  incendio: "Incendio",
  hospitalizacion: "Hospitalización (HCM)",
};

// Vocabulario de estados pedido explícitamente ("Recibido, Aprobado, Rechazado,
// Pendiente Documentación, Por pagar, Pagado"), más "en_investigacion" (paso intermedio
// una vez completa la documentación, antes de la decisión de aprobar/rechazar).
const SINIESTRO_ESTADO_LABELS = {
  recibido: "Recibido",
  pendiente_documentacion: "Pendiente de documentación",
  en_investigacion: "En investigación",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
  por_pagar: "Por pagar",
  pagado: "Pagado",
};

const SINIESTRO_DOC_LABELS = {
  fotos_dano: "fotos del daño",
  denuncia_policial: "denuncia policial",
  croquis: "croquis del accidente",
  presupuesto_taller: "presupuesto del taller",
  inventario_bienes: "inventario de bienes",
  informe_bomberos: "informe de bomberos",
  presupuesto_reparacion: "presupuesto de reparación",
  diagnostico_medico: "diagnóstico médico",
  facturas: "facturas",
  orden_hospitalizacion: "orden de hospitalización",
};

function labelDocumentos(keys) {
  return (keys || []).map((k) => SINIESTRO_DOC_LABELS[k] || k).join(", ");
}

// Frases que disparan el flujo de apertura de un siniestro (PASO 1 del pedido
// original) — se revisan ANTES que el gate de identificación genérico, incluso como
// primer mensaje de la conversación, porque el pedido pide una respuesta empática
// inmediata ("Lamento lo ocurrido...") antes que cualquier otra cosa.
const SINIESTRO_TRIGGER_PHRASES = [
  "tuve un accidente",
  "tuve un choque",
  "tuve un siniestro",
  "choque mi carro",
  "choqué",
  "choque el carro",
  "me choc",
  "quiero reportar un siniestro",
  "quiero abrir un siniestro",
  "reportar un siniestro",
  "abrir un siniestro",
  "me robaron",
  "sufrí un robo",
  "sufri un robo",
  "hubo un robo",
  "se incendió",
  "se incendio",
  "tuve un incendio",
  "tuve que hospitalizarme",
  "me hospitalizaron",
  "estoy hospitalizado",
  "tuve una emergencia medica",
  "tuve una emergencia médica",
];

function detectSiniestroTrigger(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return SINIESTRO_TRIGGER_PHRASES.some((p) => normalized.includes(normalizeText(p)));
}

// Palabras clave para reconocer el tipo de siniestro que el usuario elige en el paso
// "tipo" del flujo (ver handleSiniestroFlowGate) — acepta tanto el número del menú
// guionado como palabras sueltas, mismo criterio que el menú numerado de WhatsApp.
const SINIESTRO_TIPO_KEYWORDS = {
  accidente: ["1", "accidente", "choque", "choqu", "colision", "colisión", "transito", "tránsito"],
  robo: ["2", "robo", "hurto", "robaron"],
  incendio: ["3", "incendio", "quemo", "quemó", "fuego"],
  hospitalizacion: ["4", "hospital", "hospitalizacion", "hospitalización", "hcm", "internad", "clinica", "clínica"],
};

function detectSiniestroTipo(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  for (const [tipo, keywords] of Object.entries(SINIESTRO_TIPO_KEYWORDS)) {
    if (keywords.some((k) => normalized.includes(normalizeText(k)))) return tipo;
  }
  return null;
}

const SINIESTRO_TIPO_QUESTION =
  "Para continuar, cuéntame qué tipo de siniestro es (responde con el número o la palabra):\n" +
  "1) 🚗 Accidente de tránsito\n2) 🔓 Robo\n3) 🔥 Incendio\n4) 🏥 Hospitalización (HCM)";

/** Resume UN siniestro (datos reales de siniestrosService) en una línea legible para
 *  el contexto de Claude — mismo criterio que describePolizaForPrompt(). */
function describeSiniestroForPrompt(s) {
  const estadoLabel = SINIESTRO_ESTADO_LABELS[s.estado] || s.estado;
  const tipoLabel = SINIESTRO_TIPO_LABELS[s.tipo] || s.tipo;
  const pendientes = labelDocumentos(s.documentos_pendientes) || "ninguno";
  const recibidos = labelDocumentos(s.documentos_recibidos) || "ninguno";
  return (
    `- ${s.numero} (${tipoLabel}, póliza ${s.poliza}): estado "${estadoLabel}". Reportado el ${s.fecha_reporte}. ` +
    `Monto reclamado: $${s.monto_reclamado}${
      s.monto_aprobado != null ? `, monto aprobado: $${s.monto_aprobado}` : ""
    }. Documentos recibidos: ${recibidos}. Documentos pendientes: ${pendientes}. ` +
    `Ajustador asignado: ${s.ajustador_asignado || "sin asignar"}. Fecha estimada de resolución: ${
      s.fecha_estimada_resolucion || "por definir"
    }.`
  );
}

/** Construye el bloque de contexto con los siniestros REALES del cliente (datos de
 *  siniestrosService) que se antepone al system prompt de Claude — mismo criterio que
 *  buildClientContextAddendum() para pólizas: nunca deja que el modelo invente
 *  estados, montos ni fechas. `""` si el cliente no tiene siniestros. */
function buildSiniestrosContextAddendum(siniestros) {
  if (!siniestros || !siniestros.length) return "";
  return (
    `\n\n## Siniestros del cliente (datos reales — nunca inventes números de siniestro, ` +
    `estados, montos ni fechas distintos a los que aquí aparecen)\n${siniestros.map(describeSiniestroForPrompt).join("\n")}\n\n` +
    `Si te pregunta cuándo le pagan: si el siniestro está "aprobado" o "por_pagar", dile que ${COMPANY_NAME} ` +
    `busca en todo momento cumplir con la normativa de la SUDEASEG y que, al estar ya aprobado, falta poco ` +
    `para que reciba su pago; si todavía no está aprobado, explícale en qué etapa va sin prometer una fecha ` +
    `exacta. Si tiene documentos pendientes, indícale claramente cuáles son y que puede enviarlos por este ` +
    `mismo chat (foto o PDF).`
  );
}

/**
 * Gestiona el flujo conversacional de APERTURA de un siniestro (PASOS 1-5 del pedido
 * original): primeros auxilios emocionales, identificación del cliente (reutiliza
 * identificarOCrearCliente — se salta si ya está identificado), tipo, fecha,
 * descripción y ubicación, y finalmente abre el siniestro real (siniestrosService) y
 * confirma con el número generado. Un paso guionado y determinista, igual criterio
 * que handleClientIdentificationGate — nunca depende de que el modelo decida cuándo
 * preguntar o qué extraer. Muta `record.siniestroFlow`. Devuelve `{ handled: false }`
 * si el mensaje no dispara ni continúa ningún flujo en curso.
 */
async function handleSiniestroFlowGate(record, userText, seed) {
  const text = userText || "";

  if (!record.siniestroFlow) {
    if (!detectSiniestroTrigger(text)) return { handled: false };
    record.siniestroFlow = { step: "heridos", draft: {} };
    return {
      handled: true,
      replyText:
        "Lamento mucho lo ocurrido 💛. Lo más importante es que estés bien. ¿Hay heridos? Si es una " +
        "emergencia, comunícate primero con el 911 o tu línea de emergencia — yo te ayudo con el reporte " +
        "del siniestro mientras tanto.",
    };
  }

  const flow = record.siniestroFlow;

  if (flow.step === "heridos") {
    flow.draft.heridos = text.trim().slice(0, 300);
    if (!record.clienteId) {
      flow.step = "identificacion";
      flow.attempts = 0;
      return {
        handled: true,
        replyText:
          'Entendido, gracias por contarme. Para abrir tu siniestro necesito ubicarte primero — ¿me ' +
          'compartes tu cédula (ej. "V-12345678") o el número de tu póliza?',
      };
    }
    flow.step = "tipo";
    return { handled: true, replyText: SINIESTRO_TIPO_QUESTION };
  }

  if (flow.step === "identificacion") {
    // Si ya hay una verificación de identidad en curso (se le pidió el correo, o ya se
    // le mandó el código OTP — ver iniciarVerificacionIdentidad), este mensaje es la
    // respuesta a ESO, no una cédula/póliza nueva — nunca alcanza con solo conocer la
    // cédula para abrir un siniestro a nombre de alguien.
    if (record.identificationState === "asking-email" || record.identificationState === "otp-pending") {
      const verifContinuada = await continuarVerificacionIdentidad(record, text);
      if (!verifContinuada.verified) {
        // Si la verificación se abandonó definitivamente (máximo de intentos, o el
        // usuario pidió no continuar — continuarVerificacionIdentidad deja
        // identificationState en "skipped" en ambos casos), no tiene sentido dejar
        // este flujo de siniestro "colgado" esperando otro intento de identificación.
        if (record.identificationState === "skipped") record.siniestroFlow = null;
        return verifContinuada;
      }
      record.clienteId = verifContinuada.cliente.cedula;
      record.identificationState = "done";
      flow.step = "tipo";
      return { handled: true, replyText: SINIESTRO_TIPO_QUESTION };
    }

    if (wantsToSkipIdentification(text)) {
      record.siniestroFlow = null;
      return {
        handled: true,
        replyText:
          `Sin ese dato no puedo abrir el siniestro por aquí — lo mejor es que te comuniques con un asesor ` +
          `al ${CLAIMS_PHONE} para que te ayude directamente. ¿Te ayudo con algo más mientras tanto?`,
      };
    }
    const found = extractIdentification(text);
    if (!found) {
      flow.attempts = (flow.attempts || 0) + 1;
      if (flow.attempts >= 2) {
        record.siniestroFlow = null;
        return {
          handled: true,
          replyText: `No logré ubicar tu póliza. Comunícate con un asesor al ${CLAIMS_PHONE} y te ayudan a abrir el siniestro directamente. ¿Te ayudo con algo más?`,
        };
      }
      return {
        handled: true,
        replyText:
          'No reconocí ese formato. Tu cédula sería algo como "V-12345678", o tu número de póliza como "AUTO-2024-001".',
      };
    }
    const cliente = await identificarOCrearCliente(found, seed);
    if (!cliente) {
      flow.attempts = (flow.attempts || 0) + 1;
      if (flow.attempts >= 2) {
        record.siniestroFlow = null;
        return {
          handled: true,
          replyText: `No encontré esa póliza en nuestros registros. Comunícate con un asesor al ${CLAIMS_PHONE} para que te ayude a abrir el siniestro. ¿Te ayudo con algo más?`,
        };
      }
      return {
        handled: true,
        replyText: `No encontré la póliza ${found.value} en nuestros registros. ¿Me confirmas tu cédula (ej. "V-12345678")?`,
      };
    }

    // Verificación de identidad (código OTP por correo, o confianza implícita si ya
    // escribe desde el mismo WhatsApp guardado) — ver iniciarVerificacionIdentidad.
    // Mientras no se verifique, `flow.step` se queda en "identificacion" (arriba, este
    // mismo bloque atiende la respuesta al correo/código en el próximo turno).
    const verif = await iniciarVerificacionIdentidad(record, cliente, seed);
    if (!verif.verified) return verif;

    record.clienteId = verif.cliente.cedula;
    record.identificationState = "done"; // ya no hace falta que el gate genérico la vuelva a pedir
    if (seed && seed.canalPreferido && !verif.cliente.canalPreferido) touchCliente(verif.cliente.cedula, { canalPreferido: seed.canalPreferido });
    if (found.type === "poliza") flow.draft.poliza = found.value;
    flow.step = "tipo";
    return { handled: true, replyText: SINIESTRO_TIPO_QUESTION };
  }

  if (flow.step === "tipo") {
    const tipo = detectSiniestroTipo(text);
    if (!tipo) {
      return { handled: true, replyText: `No reconocí el tipo. ${SINIESTRO_TIPO_QUESTION}` };
    }
    flow.draft.tipo = tipo;
    flow.step = "fecha";
    return { handled: true, replyText: "¿Qué día (y hora aproximada, si la recuerdas) ocurrió?" };
  }

  if (flow.step === "fecha") {
    flow.draft.fechaOcurrencia = text.trim().slice(0, 100);
    flow.step = "descripcion";
    return { handled: true, replyText: "Cuéntame brevemente qué ocurrió." };
  }

  if (flow.step === "descripcion") {
    flow.draft.descripcion = text.trim().slice(0, 600);
    flow.step = "ubicacion";
    return {
      handled: true,
      replyText: "¿En qué lugar ocurrió? Puedes escribir la dirección, o compartir tu ubicación con el botón de abajo 📍.",
      requestLocation: true,
    };
  }

  if (flow.step === "ubicacion") {
    if (!wantsToSkipIdentification(text)) {
      // wantsToSkipIdentification() detecta frases genéricas de "omitir/no aplica" —
      // se reutiliza aquí para permitir saltar la ubicación sin duplicar esa lista.
      flow.draft.ubicacion = text.trim().slice(0, 300);
    }
    return finalizeSiniestroFlow(record, flow);
  }

  return { handled: false };
}

/** Último paso de handleSiniestroFlowGate: abre el siniestro (siniestrosService) con
 *  los datos recopilados y confirma con el número generado, el ajustador asignado y
 *  la lista de documentos pendientes según el tipo. Siempre limpia
 *  `record.siniestroFlow` al terminar (con éxito o con error). */
// A qué ramo(s) de póliza corresponde cada tipo de siniestro — usado solo para elegir,
// entre las pólizas REALES del cliente (polizasService), cuál asociar al abrir uno
// nuevo cuando no dijo un número de póliza explícito (ver resolverPolizaParaSiniestro).
const SINIESTRO_TIPO_A_RAMO = {
  accidente: ["automoviles", "autos"],
  colision: ["automoviles", "autos"],
  robo: ["automoviles", "autos", "patrimonial", "patrimoniales"],
  incendio: ["patrimonial", "patrimoniales"],
  hospitalizacion: ["hcm"],
};

/** Determina qué póliza asociar a un siniestro que se está abriendo: el número que el
 *  cliente haya dado explícitamente (identificación por póliza) tiene prioridad; si
 *  no, se buscan las pólizas REALES del cliente (polizasService — más confiables que
 *  el arreglo `polizas` autoreportado del perfil) y se prefiere una del ramo que
 *  corresponde al tipo de siniestro; si no hay ninguna coincidencia, la primera que
 *  tenga; como último recurso, lo autoreportado en el perfil. `""` si no hay ningún dato. */
async function resolverPolizaParaSiniestro(cliente, draft) {
  if (draft.poliza) return draft.poliza;
  if (!cliente) return "";
  const polizasReales = await polizasService.buscarPorCedula(cliente.cedula);
  if (polizasReales.length) {
    const ramosPreferidos = SINIESTRO_TIPO_A_RAMO[draft.tipo] || [];
    const match = polizasReales.find((p) => ramosPreferidos.includes(p.ramo));
    return (match || polizasReales[0]).numero;
  }
  return (Array.isArray(cliente.polizas) && cliente.polizas[0]) || "";
}

async function finalizeSiniestroFlow(record, flow) {
  const cliente = record.clienteId ? getClienteByCedula(record.clienteId) : null;
  const draft = flow.draft;

  let siniestro;
  try {
    siniestro = await siniestrosService.abrirSiniestro({
      poliza: await resolverPolizaParaSiniestro(cliente, draft),
      cedula_titular: cliente ? cliente.cedula : "",
      tipo: draft.tipo,
      fecha_ocurrencia: draft.fechaOcurrencia,
      descripcion: draft.descripcion,
      ubicacion: draft.ubicacion || "",
      heridos: draft.heridos || "",
    });
  } catch (err) {
    console.error("Error al abrir el siniestro:", err.message);
    record.siniestroFlow = null;
    return {
      handled: true,
      replyText: `No pude registrar el siniestro automáticamente — comunícate con un asesor al ${CLAIMS_PHONE} para que te ayude directamente. ¿Te ayudo con algo más?`,
    };
  }

  record.siniestroFlow = null;
  if (record.clienteId) {
    recordClientTopic(record.clienteId, "siniestro"); // reutiliza el flag casoAbiertoSiniestro ya existente
  }

  // Notifica en tiempo real al corredor dueño de la póliza (si tiene cuenta en el
  // portal /corredor y está conectado) — ver "Toast notification cuando un cliente de
  // su cartera abre un siniestro" del pedido original.
  try {
    const polizaDelSiniestro = siniestro.poliza ? await polizasService.buscarPorNumero(siniestro.poliza) : null;
    if (polizaDelSiniestro && polizaDelSiniestro.corredor) {
      notifyCorredorDePoliza(polizaDelSiniestro.corredor, "siniestro-abierto", {
        numero: siniestro.numero,
        // `cliente.nombre` puede venir vacío (se identificó solo por cédula en el
        // propio flujo de siniestro, que no pregunta el nombre) — en ese caso se usa
        // el titular real de la póliza en su lugar, nunca una cadena vacía.
        titular: (cliente && cliente.nombre) || polizaDelSiniestro.titular,
        poliza: siniestro.poliza,
        tipo: siniestro.tipo,
      });
    }
  } catch (err) {
    console.warn("[aviso] No se pudo notificar al corredor sobre el nuevo siniestro:", err.message);
  }

  const docsTexto = siniestro.documentos_pendientes.length
    ? `📎 Documentos que necesito que me envíes (puedes adjuntarlos aquí mismo en el chat): ${labelDocumentos(
        siniestro.documentos_pendientes
      )}.`
    : "No necesitas enviarme documentos adicionales por ahora.";

  return {
    handled: true,
    replyText:
      `✅ Listo, tu siniestro quedó registrado con el número ${siniestro.numero}.\n\n` +
      `El ajustador ${siniestro.ajustador_asignado} ya fue asignado a tu caso, con fecha estimada de ` +
      `resolución ${siniestro.fecha_estimada_resolucion}.\n\n${docsTexto}\n\n` +
      `Puedes preguntarme "¿cómo va mi siniestro?" o "¿qué documentos me faltan?" cuando quieras.`,
  };
}

// ---------------------------------------------------------------------------
// Motor de inteligencia: clasificador de intención/emoción, valoración de
// calidad y aprendizaje de preguntas sin respuesta (gaps de conocimiento).
// ---------------------------------------------------------------------------

const INTENT_LABELS = [
  "cotizar",
  "consultar_poliza",
  "reportar_siniestro",
  "consultar_siniestro",
  "quejar",
  "cancelar_poliza",
  "renovar",
  "hablar_humano",
  "saludo",
  "despedida",
  "otra",
];
const EMOTION_LABELS = ["urgente", "molesto", "confundido", "satisfecho", "neutral"];

const INTENT_CLASSIFIER_SYSTEM = `Clasificas el ÚLTIMO mensaje de un usuario que le escribe a una aseguradora venezolana. No respondas al usuario ni agregues explicación — SOLO un JSON con esta forma exacta, sin texto adicional ni bloque de código:
{"intencion": "<una de: ${INTENT_LABELS.join(", ")}>", "emocion": "<una de: ${EMOTION_LABELS.join(", ")}>"}

Guía breve:
- "quejar": el usuario expresa una queja, insatisfacción o reclamo formal (no solo una duda).
- "cancelar_poliza": quiere cancelar o dar de baja una póliza.
- "renovar": quiere renovar una póliza (no cotizar una nueva).
- "hablar_humano": pide explícitamente hablar con una persona/asesor.
- "emocion=urgente": el mensaje describe una emergencia en curso (accidente, robo, salud).
- "emocion=molesto": tono de frustración/enojo, aunque no llegue a ser una queja formal.
- "emocion=confundido": el usuario no entiende algo o pide que se lo expliquen más simple.
- "emocion=satisfecho": agradecimiento o cierre positivo de la conversación.
- Si no aplica ninguna con claridad, usa "otra" / "neutral".`;

/**
 * Clasifica intención y emoción del último mensaje del usuario con una llamada RÁPIDA
 * y aparte a Claude (CLAUDE_FAST_MODEL) — nunca bloquea la respuesta real de Lucy: si
 * tarda más de 3s, falla, o responde algo no parseable, se usa el valor por defecto
 * ("otra"/"neutral") y se sigue igual. Solo se invoca para el flujo normal de
 * conversación (después de los gates deterministas — identificación, siniestros,
 * valoración — que ya saben exactamente qué está pasando sin necesidad de esto).
 */
async function classifyIntentAndEmotion(text) {
  const fallback = { intencion: "otra", emocion: "neutral" };
  if (!text || !text.trim()) return fallback;
  try {
    const response = await Promise.race([
      anthropic.messages.create({
        model: CLAUDE_FAST_MODEL,
        max_tokens: 60,
        system: INTENT_CLASSIFIER_SYSTEM,
        messages: [{ role: "user", content: text.slice(0, 1000) }],
      }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout de clasificación")), 3000)),
    ]);
    const raw = extractText(response).trim();
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = match ? JSON.parse(match[0]) : {};
    return {
      intencion: INTENT_LABELS.includes(parsed.intencion) ? parsed.intencion : "otra",
      emocion: EMOTION_LABELS.includes(parsed.emocion) ? parsed.emocion : "neutral",
    };
  } catch (err) {
    console.warn("[aviso] No se pudo clasificar intención/emoción (se sigue sin ella):", err.message);
    return fallback;
  }
}

// Contexto que se le agrega al system prompt de Claude según la intención/emoción
// detectada — nunca reemplaza los flujos deterministas ya existentes (cotizar,
// reportar_siniestro, consultar_poliza/consultar_siniestro ya se resuelven con datos
// reales inyectados aparte, ver buildClientContextAddendum/buildSiniestrosContextAddendum
// y el cotizador automático del widget), solo complementa el TONO de la respuesta.
const INTENT_GUIDANCE = {
  quejar:
    "\n\nEl sistema detectó que este mensaje suena a una QUEJA o reclamo formal. Reconoce la frustración del " +
    "cliente con empatía genuina (sin sonar robótica), pide disculpas si aplica, y dile con claridad que su " +
    "caso quedará escalado para atención prioritaria de un asesor humano.",
  cancelar_poliza:
    "\n\nEl sistema detectó intención de CANCELAR una póliza. Pregúntale con amabilidad (nunca de forma " +
    "insistente) el motivo, para que el equipo pueda mejorar — pero no lo presiones a quedarse. Indícale que " +
    "un asesor se pondrá en contacto para procesar la cancelación formalmente; tú no puedes cancelarla por este medio.",
  renovar:
    "\n\nEl sistema detectó intención de RENOVAR una póliza (no cotizar una nueva). Si tiene pólizas reales " +
    "registradas (ver el contexto del cliente más abajo), confirma cuál quiere renovar y ofrécele iniciar el " +
    "proceso o canalizarlo con su corredor o un asesor.",
  hablar_humano:
    "\n\nEl sistema detectó que el cliente quiere hablar con una persona. Ofrécele de inmediato los canales de " +
    `contacto (correo ${SUPPORT_EMAIL}${SUPPORT_PHONE ? ` o teléfono ${SUPPORT_PHONE}` : ""}), sin insistir en seguir ayudando tú primero.`,
};

const EMOTION_GUIDANCE = {
  urgente:
    "\n\nEl sistema detectó un tono URGENTE (posible emergencia en curso). Responde con calma pero priorizando " +
    "acción inmediata: el siguiente paso concreto primero, explicaciones largas después.",
  molesto:
    "\n\nEl sistema detectó un tono MOLESTO o de frustración. Antes que cualquier otra cosa, reconoce esa " +
    "frustración de forma calmada y genuina, e indícale que escalarás su caso para atención prioritaria.",
  confundido:
    "\n\nEl sistema detectó que el cliente está CONFUNDIDO. Usa lenguaje más simple, evita jerga técnica de " +
    "seguros sin explicarla, y ofrece una explicación paso a paso.",
};

// Frases que, junto con emocion === "satisfecho", disparan la pregunta de valoración
// de calidad al cierre de la conversación (ver "Al cerrar cada conversación" del
// pedido original) — reutiliza FAREWELL_TRIGGER_PHRASES (definidas más abajo, junto al
// resto de la lógica de audio) sin duplicar esa lista.
const SATISFACTION_TRIGGER_PHRASES = [
  "gracias",
  "muchas gracias",
  "mil gracias",
  "excelente",
  "genial",
  "perfecto",
  "eso era todo",
  "eso es todo",
  "nada mas",
  "eso resuelve",
];

function isSatisfactionSignal(text, emocion) {
  if (emocion === "satisfecho") return true;
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    SATISFACTION_TRIGGER_PHRASES.some((p) => normalized.includes(normalizeText(p))) ||
    FAREWELL_TRIGGER_PHRASES.some((p) => normalized.includes(normalizeText(p)))
  );
}

const RATING_ASK_TEXT = "¿Pude ayudarte con algo más? Califica tu experiencia del 1 al 5 ⭐ (1 = mal, 5 = excelente).";

/** Interpreta la respuesta del usuario a RATING_ASK_TEXT: acepta un dígito 1-5, el
 *  número escrito en palabras, o una cadena de estrellas (⭐/★). `null` si no se pudo
 *  interpretar como una valoración (el mensaje sigue su curso normal, ver
 *  handleRatingGate).
 *
 *  Un dígito/palabra suelto SOLO cuenta como valoración si es (casi) todo el mensaje,
 *  o va acompañado de una palabra que lo deje inequívoco ("estrella(s)", "/5", "de 5",
 *  "puntos") — de lo contrario un mensaje normal que solo MENCIONA un número
 *  ("necesito la póliza 5", "vivo en el apartamento 3", "quiero la opción 1") se
 *  interpretaría por error como la respuesta a la pregunta de valoración y esa
 *  pregunta real del usuario nunca llegaría a Claude. */
function parseRating(text) {
  const trimmed = String(text || "").trim();
  const normalized = normalizeText(trimmed);
  if (!normalized) return null;

  // Una cadena de estrellas es inequívoca en cualquier mensaje.
  const starCount = (trimmed.match(/⭐|★/g) || []).length;
  if (starCount >= 1 && starCount <= 5) return starCount;

  const isShortStandalone = normalized.length <= 12; // "5", "un 4!", "cinco" caben; una frase normal no
  const hasRatingQualifier = /estrella|\/\s*5\b|de\s*5\b|puntos?\b/.test(normalized);
  if (!isShortStandalone && !hasRatingQualifier) return null;

  const digitMatch = normalized.match(/\b([1-5])\b/);
  if (digitMatch) return Number(digitMatch[1]);
  const WORDS_TO_NUMBER = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
  for (const [word, n] of Object.entries(WORDS_TO_NUMBER)) {
    if (normalized.includes(word)) return n;
  }
  return null;
}

/**
 * Gate determinista para la respuesta a la pregunta de valoración (ver RATING_ASK_TEXT
 * / dónde se dispara en /api/chat y el webhook de WhatsApp). Solo actúa si
 * `record.ratingState === "asked"`; si el mensaje no se puede interpretar como una
 * valoración, no bloquea la conversación — la deja seguir su curso normal (el usuario
 * pudo simplemente seguir hablando de otra cosa).
 */
function handleRatingGate(record, userText) {
  if (record.ratingState !== "asked") return { handled: false };
  const rating = parseRating(userText);
  if (rating == null) {
    record.ratingState = "skipped";
    return { handled: false };
  }

  record.ratingState = "done";
  record.rating = rating;
  record.requiereRevision = rating <= 2;

  if (record.clienteId) {
    const cliente = getClienteByCedula(record.clienteId);
    if (cliente) {
      const historial = (cliente.historialValoraciones || [])
        .concat([{ fecha: new Date().toISOString(), valoracion: rating, sessionId: record.id }])
        .slice(-20);
      touchCliente(cliente.cedula, { ultimaValoracion: rating, historialValoraciones: historial });
    }
  }

  const replyText =
    rating >= 4
      ? "¡Muchas gracias por tu valoración! 🙌 Cualquier otra cosa, aquí estoy."
      : rating === 3
        ? "Gracias por tu opinión, seguiremos mejorando. Si necesitas algo más, dime."
        : "Gracias por avisarnos — un miembro de nuestro equipo revisará tu conversación para mejorar tu experiencia.";

  return { handled: true, replyText };
}

// ---------------------------------------------------------------------------
// Aprendizaje de preguntas frecuentes: registra cada vez que Lucy no respondió bien
// (data/gaps-conocimiento.json) — mismo patrón de caché en memoria + cola de
// escritura serializada que conversations.json/clientes.json.
// ---------------------------------------------------------------------------

const GAPS_CONOCIMIENTO_FILE = process.env.GAPS_CONOCIMIENTO_FILE
  ? path.resolve(__dirname, process.env.GAPS_CONOCIMIENTO_FILE)
  : path.join(__dirname, "data", "gaps-conocimiento.json");

/** @type {any[]} */
let gapsConocimientoCache = [];
let gapsConocimientoWriteQueue = Promise.resolve();

function loadGapsConocimientoFromDisk() {
  try {
    if (fs.existsSync(GAPS_CONOCIMIENTO_FILE)) {
      const raw = fs.readFileSync(GAPS_CONOCIMIENTO_FILE, "utf8");
      const parsed = raw.trim() ? JSON.parse(raw) : [];
      gapsConocimientoCache = Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error(`[aviso] No se pudo leer ${path.basename(GAPS_CONOCIMIENTO_FILE)}, se iniciará vacío:`, err.message);
    gapsConocimientoCache = [];
  }
}

function persistGapsConocimiento() {
  gapsConocimientoWriteQueue = gapsConocimientoWriteQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify(gapsConocimientoCache, null, 2);
        fs.writeFile(GAPS_CONOCIMIENTO_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar gaps-conocimiento.json:", err.message);
          resolve();
        });
      })
  );
  return gapsConocimientoWriteQueue;
}

loadGapsConocimientoFromDisk();

// Frases que indican que la respuesta anterior de Lucy NO satisfizo al usuario —
// junto con pedir un asesor humano (ADVISOR_KEYWORDS, definidas más abajo), disparan
// el registro de un "gap de conocimiento" para que el equipo revise y mejore el
// system prompt (ver panel /admin, sección "❓ Preguntas sin respuesta").
const DISSATISFACTION_TRIGGER_PHRASES = [
  "eso no es lo que pregunte",
  "no es lo que pregunte",
  "no es lo que necesito",
  "no me estas entendiendo",
  "no me entendiste",
  "no es eso",
  "no es lo que dije",
  "esa no es mi pregunta",
  "no respondiste mi pregunta",
  "no contestaste mi pregunta",
  "eso no responde",
];

function detectsDissatisfaction(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return DISSATISFACTION_TRIGGER_PHRASES.some((p) => normalized.includes(normalizeText(p)));
}

/**
 * Registra un gap de conocimiento: toma la ÚLTIMA respuesta de Lucy y la pregunta del
 * usuario que la originó (ya presentes en `record.messages`, antes de agregar la
 * respuesta al mensaje actual) junto con el mensaje que disparó la insatisfacción.
 * Nunca lanza — un fallo al registrar esto no debe interrumpir la conversación.
 */
async function registrarGapConocimiento(record, motivo) {
  try {
    const msgs = record.messages || [];
    let lastAssistant = null;
    let previousUserQuestion = null;
    // Recorre hacia atrás DESDE ANTES del mensaje actual del usuario (el último de la
    // lista) buscando el par (pregunta del usuario, respuesta de Lucy) inmediatamente
    // anterior a este mensaje de insatisfacción.
    for (let i = msgs.length - 2; i >= 0; i--) {
      if (!lastAssistant && msgs[i].role === "assistant") {
        lastAssistant = msgs[i];
      } else if (lastAssistant && !previousUserQuestion && msgs[i].role === "user") {
        previousUserQuestion = msgs[i];
        break;
      }
    }
    if (!lastAssistant) return; // no hay una respuesta previa que revisar (primer mensaje, etc.)

    gapsConocimientoCache.push({
      id: crypto.randomUUID(),
      fecha: new Date().toISOString(),
      sessionId: record.id,
      canal: record.channel === "whatsapp" ? "whatsapp" : "web",
      pregunta: previousUserQuestion ? previousUserQuestion.content.slice(0, 1000) : "",
      respuestaLucy: lastAssistant.content.slice(0, 1500),
      disparador: motivo.slice(0, 300),
      resuelto: false,
      notas: "",
    });
    gapsConocimientoCache = gapsConocimientoCache.slice(-500); // límite defensivo
    await persistGapsConocimiento();
  } catch (err) {
    console.warn("[aviso] No se pudo registrar el gap de conocimiento:", err.message);
  }
}

function sanitizeSessionId(raw) {
  if (typeof raw === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(raw)) return raw;
  return crypto.randomUUID();
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // quita acentos para una comparación más tolerante
}

const RAMO_LABELS = {
  personas: "Personas",
  autos: "Automóviles",
  patrimoniales: "Patrimoniales",
  fianzas: "Fianzas",
};

const RAMO_KEYWORDS = {
  personas: [
    "vida",
    "hcm",
    "hospitalizacion",
    "cirugia",
    "funerari",
    "accidente personal",
    "accidentes personales",
    "seguro de salud",
  ],
  autos: [
    "auto",
    "vehiculo",
    "carro",
    "casco",
    "asistencia en viaje",
    "choque",
    "transito",
    "colision",
  ],
  patrimoniales: [
    "patrimonial",
    "incendio",
    "robo",
    "hogar",
    "empresarial",
    "negocio",
    "local comercial",
  ],
  fianzas: ["fianza", "fidelidad", "cumplimiento", "anticipo", "garantia"],
};

const ADVISOR_KEYWORDS = [
  "asesor",
  "hablar con alguien",
  "persona real",
  "atencion humana",
  "representante",
  "agente humano",
  "un humano",
];

/** Detecta qué ramos (Personas/Autos/Patrimoniales/Fianzas) se mencionaron en la conversación. */
function detectRamos(messages) {
  const fullText = normalizeText(messages.map((m) => m.content).join(" \n "));
  const found = [];
  for (const [ramo, keywords] of Object.entries(RAMO_KEYWORDS)) {
    if (keywords.some((kw) => fullText.includes(kw))) {
      found.push(ramo);
    }
  }
  return found;
}

/** Detecta si el usuario pidió hablar con un asesor humano (o si Lucy lo derivó). */
function detectAdvisorRequested(messages) {
  const userText = normalizeText(messages.filter((m) => m.role === "user").map((m) => m.content).join(" \n "));
  const assistantText = normalizeText(
    messages.filter((m) => m.role === "assistant").map((m) => m.content).join(" \n ")
  );
  const userAsked = ADVISOR_KEYWORDS.some((kw) => userText.includes(kw));
  const assistantOfferedContact = SUPPORT_EMAIL && assistantText.includes(normalizeText(SUPPORT_EMAIL));
  return Boolean(userAsked || assistantOfferedContact);
}

/** Recalcula los metadatos derivados (mensajes, ramos, asesor) de un registro y lo persiste. */
function touchConversationRecord(record) {
  record.updatedAt = new Date().toISOString();
  record.messageCount = record.messages.length;
  record.ramos = detectRamos(record.messages);
  record.advisorRequested = detectAdvisorRequested(record.messages);
  conversationsCache[record.id] = record;
  persistConversations();
}

function toConversationSummary(record) {
  const startedAtMs = new Date(record.startedAt).getTime();
  const updatedAtMs = new Date(record.updatedAt).getTime();
  const durationSeconds = Math.max(0, Math.round((updatedAtMs - startedAtMs) / 1000));
  const firstUserMessage = record.messages.find((m) => m.role === "user");
  const quotes = record.quotes ? Object.values(record.quotes) : [];

  return {
    id: record.id,
    channel: record.channel === "whatsapp" ? "whatsapp" : "web",
    phone: record.channel === "whatsapp" ? record.phone || record.id : undefined,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    durationSeconds,
    messageCount: record.messageCount != null ? record.messageCount : record.messages.length,
    advisorRequested: Boolean(record.advisorRequested),
    ramos: record.ramos || [],
    preview: firstUserMessage ? firstUserMessage.content.slice(0, 140) : "",
    quotesCount: quotes.length,
    quoteRamos: Array.from(new Set(quotes.map((q) => q.ramo).filter(Boolean))),
    hasFormalRequest: quotes.some((q) => q.formalRequest),
    hasAttachments: record.messages.some((m) => Boolean(m.attachment)),
    // Motor de inteligencia: última intención/emoción clasificadas, valoración de
    // calidad (si ya se preguntó/respondió) y si quedó marcada para revisión manual
    // (emocion="molesto" en algún turno, o valoración <= 2) — ver server.js#classifyIntentAndEmotion.
    ultimaIntencion: record.ultimaIntencion || null,
    ultimaEmocion: record.ultimaEmocion || null,
    escalado: Boolean(record.escalado),
    rating: record.rating != null ? record.rating : null,
    requiereRevision: Boolean(record.requiereRevision),
    notasInternas: record.notasInternas || "",
    controladoPorHumano: Boolean(record.controladoPorHumano),
  };
}

// ---------------------------------------------------------------------------
// Reportes y métricas (panel de administración → pestaña "Reportes")
// ---------------------------------------------------------------------------

/** Hora del día (0-23) de un timestamp ISO, en horario de Venezuela (UTC-4, sin DST). */
function veHour(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return 0;
  return (d.getUTCHours() + 24 - 4) % 24;
}

/** Extrae, de un registro de cotización, el monto/valor a mostrar como "valor estimado". */
function quoteEstimatedValue(quote) {
  const inputs = quote.inputs || {};
  const result = quote.result || {};
  if (quote.ramo === "autos") {
    return result.primaFinal != null ? `${result.primaFinal} ${result.currencyLabel || ""}`.trim() : "";
  }
  if (quote.ramo === "personas") {
    return result.total != null ? `${result.total} ${result.currencyLabel || "USD"}`.trim() : "";
  }
  if (quote.ramo === "patrimoniales") {
    return inputs.valor != null ? `${inputs.valor} USD` : "";
  }
  return "";
}

/**
 * Calcula todas las métricas del dashboard de reportes a partir de las
 * conversaciones guardadas: tarjetas numéricas, series para los gráficos y la
 * lista completa de cotizaciones generadas.
 */
function buildReports() {
  const records = Object.values(conversationsCache);
  const total = records.length;

  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const weekAgoKey = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 7 días incl. hoy
  const monthKey = todayKey.slice(0, 7); // yyyy-mm

  let todayCount = 0;
  let weekCount = 0;
  let monthCount = 0;
  let advisorCount = 0;
  let quotedConversations = 0;
  let totalMessages = 0;
  const ramoCounts = {};
  const hourlyActivity = new Array(24).fill(0);
  const quotes = [];

  for (const record of records) {
    const startedKey = (record.startedAt || "").slice(0, 10);
    if (startedKey === todayKey) todayCount++;
    if (startedKey >= weekAgoKey) weekCount++;
    if (startedKey.slice(0, 7) === monthKey) monthCount++;

    const messages = record.messages || [];
    totalMessages += record.messageCount != null ? record.messageCount : messages.length;
    if (record.advisorRequested) advisorCount++;

    const recordQuotes = record.quotes ? Object.values(record.quotes) : [];
    if (recordQuotes.length > 0) quotedConversations++;

    (record.ramos || []).forEach((ramo) => {
      ramoCounts[ramo] = (ramoCounts[ramo] || 0) + 1;
    });

    messages.forEach((m) => {
      if (!m.time) return;
      hourlyActivity[veHour(m.time)]++;
    });

    recordQuotes.forEach((q) => {
      quotes.push({
        id: q.id,
        sessionId: record.id,
        ramo: q.ramo,
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
        estimatedValue: quoteEstimatedValue(q),
        inputs: q.inputs,
        result: q.result,
        contact: q.contact || null,
        formalRequest: Boolean(q.formalRequest),
      });
    });
  }

  // Serie de los últimos 30 días (incluye hoy), rellenando con 0 los días sin actividad.
  const dailyCounts = [];
  const dailyIndexByDate = {};
  for (let i = 29; i >= 0; i--) {
    const key = new Date(now.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dailyIndexByDate[key] = dailyCounts.length;
    dailyCounts.push({ date: key, count: 0 });
  }
  for (const record of records) {
    const key = (record.startedAt || "").slice(0, 10);
    const idx = dailyIndexByDate[key];
    if (idx !== undefined) dailyCounts[idx].count++;
  }

  let topRamo = null;
  let topRamoCount = 0;
  for (const [ramo, count] of Object.entries(ramoCounts)) {
    if (count > topRamoCount) {
      topRamo = ramo;
      topRamoCount = count;
    }
  }

  quotes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    stats: {
      total,
      todayCount,
      weekCount,
      monthCount,
      avgMessages: total ? Math.round((totalMessages / total) * 10) / 10 : 0,
      advisorPct: total ? Math.round((advisorCount / total) * 1000) / 10 : 0,
      quotePct: total ? Math.round((quotedConversations / total) * 1000) / 10 : 0,
      topRamo,
      topRamoCount,
    },
    dailyCounts,
    ramoDistribution: ramoCounts,
    hourlyActivity,
    quotes,
    ramoLabels: RAMO_LABELS,
  };
}

// ---------------------------------------------------------------------------
// Cotizador automático — configuración editable (quoter-config.json)
// ---------------------------------------------------------------------------
//
// Toda la data de negocio del cotizador (tarifas de RCV, tabla de tasas de HCM,
// tipos de bien patrimoniales, textos, palabras clave de activación) vive en este
// archivo JSON, editable desde el panel de administración — así los equipos de
// TI/técnico/comercial pueden actualizar tarifas y textos sin tocar el código.

/** @type {any} */
let quoterConfigCache = {};
let quoterConfigWriteQueue = Promise.resolve();

function loadQuoterConfigFromDisk() {
  try {
    if (fs.existsSync(QUOTER_CONFIG_FILE)) {
      const raw = fs.readFileSync(QUOTER_CONFIG_FILE, "utf8");
      quoterConfigCache = raw.trim() ? JSON.parse(raw) : {};
    } else {
      console.warn(
        `[aviso] No se encontró ${path.basename(QUOTER_CONFIG_FILE)}. El cotizador automático quedará vacío hasta que se configure.`
      );
    }
  } catch (err) {
    console.error(
      `[aviso] No se pudo leer ${path.basename(QUOTER_CONFIG_FILE)}, el cotizador quedará vacío:`,
      err.message
    );
    quoterConfigCache = {};
  }
}

function persistQuoterConfig() {
  quoterConfigWriteQueue = quoterConfigWriteQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify(quoterConfigCache, null, 2);
        fs.writeFile(QUOTER_CONFIG_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar quoter-config.json:", err.message);
          resolve();
        });
      })
  );
  return quoterConfigWriteQueue;
}

loadQuoterConfigFromDisk();

/**
 * Validación básica y superficial del payload de configuración del cotizador antes
 * de guardarlo — evita persistir un JSON con una forma completamente inválida desde
 * el panel de administración. No es una validación exhaustiva de cada campo.
 */
function validateQuoterConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "La configuración debe ser un objeto JSON.";
  }
  for (const key of ["general", "rcv", "hcm", "patrimoniales"]) {
    if (!(key in config) || typeof config[key] !== "object") {
      return `Falta la sección "${key}" en la configuración.`;
    }
  }
  if (!Array.isArray(config.rcv.tarifas)) return "rcv.tarifas debe ser un arreglo.";
  if (!Array.isArray(config.rcv.recargos)) return "rcv.recargos debe ser un arreglo.";
  if (!Array.isArray(config.hcm.rangosEdad)) return "hcm.rangosEdad debe ser un arreglo.";
  if (!Array.isArray(config.hcm.sumasAseguradas)) return "hcm.sumasAseguradas debe ser un arreglo.";
  if (!Array.isArray(config.patrimoniales.tiposBien)) return "patrimoniales.tiposBien debe ser un arreglo.";
  return null;
}

// ---------------------------------------------------------------------------
// Cotizador automático — guardado de cotizaciones dentro de conversations.json
// ---------------------------------------------------------------------------

const QUOTE_RAMOS = ["autos", "personas", "patrimoniales"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida el payload recibido en POST /api/quote. Devuelve { error } si algo es
 * inválido, o el payload ya saneado si todo está en orden.
 */
function sanitizeQuotePayload(body) {
  const { sessionId: rawSessionId, quoteId, ramo, inputs, result, contact, formalRequest } = body || {};

  if (typeof quoteId !== "string" || !/^[a-zA-Z0-9-]{4,80}$/.test(quoteId)) {
    return { error: "quoteId inválido." };
  }
  if (!QUOTE_RAMOS.includes(ramo)) {
    return { error: "ramo inválido." };
  }
  // inputs/result son opcionales en la llamada que solo agrega el contacto de la
  // solicitud de póliza formal (ya se enviaron en la llamada inicial que calculó
  // el estimado); si vienen, deben tener forma de objeto.
  const hasInputs = inputs !== undefined;
  if (hasInputs && !isPlainObject(inputs)) {
    return { error: "inputs debe ser un objeto." };
  }
  const hasResult = result !== undefined;
  if (hasResult && result !== null && !isPlainObject(result)) {
    return { error: "result debe ser un objeto o null." };
  }
  if (JSON.stringify(inputs || {}).length > 8000 || JSON.stringify(result || {}).length > 8000) {
    return { error: "El payload de la cotización es demasiado grande." };
  }

  let sanitizedContact = null;
  if (contact != null) {
    if (!isPlainObject(contact)) return { error: "contact debe ser un objeto." };
    const nombre = typeof contact.nombre === "string" ? contact.nombre.trim().slice(0, 200) : "";
    const cedula = typeof contact.cedula === "string" ? contact.cedula.trim().slice(0, 30) : "";
    const correo = typeof contact.correo === "string" ? contact.correo.trim().slice(0, 200) : "";
    if (!nombre || !cedula || !correo) {
      return { error: "contact requiere nombre, cédula y correo." };
    }
    if (!EMAIL_RE.test(correo)) {
      return { error: "El correo electrónico no es válido." };
    }
    sanitizedContact = { nombre, cedula, correo };
  }

  return {
    sessionId: sanitizeSessionId(rawSessionId),
    quoteId,
    ramo,
    inputs: hasInputs ? inputs : undefined,
    result: hasResult ? result || null : undefined,
    contact: sanitizedContact,
    formalRequest: Boolean(formalRequest),
  };
}

// ---------------------------------------------------------------------------
// Adjuntos (fotos de siniestros/vehículos, documentos) — carpeta /uploads
// ---------------------------------------------------------------------------
//
// Cada archivo subido se guarda en disco como uploads/<fileId>.<ext>, con un
// fileId aleatorio e impredecible (no el nombre original). Un pequeño índice
// (uploads-index.json) es la única fuente de verdad de qué mimetype/sesión
// corresponde a cada fileId — nunca se confía en lo que el cliente reenvíe
// sobre un adjunto ya existente, solo en su fileId de referencia.

/** @type {Record<string, any>} */
let uploadsIndexCache = {};
let uploadsIndexWriteQueue = Promise.resolve();
const FILE_ID_RE = /^[0-9a-f-]{36}$/;

function loadUploadsIndexFromDisk() {
  try {
    if (fs.existsSync(UPLOADS_INDEX_FILE)) {
      const raw = fs.readFileSync(UPLOADS_INDEX_FILE, "utf8");
      uploadsIndexCache = raw.trim() ? JSON.parse(raw) : {};
    }
  } catch (err) {
    console.error("[aviso] No se pudo leer uploads-index.json, se iniciará vacío:", err.message);
    uploadsIndexCache = {};
  }
}

function persistUploadsIndex() {
  uploadsIndexWriteQueue = uploadsIndexWriteQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify(uploadsIndexCache, null, 2);
        fs.writeFile(UPLOADS_INDEX_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar uploads-index.json:", err.message);
          resolve();
        });
      })
  );
  return uploadsIndexWriteQueue;
}

loadUploadsIndexFromDisk();

/**
 * Determina el tipo real de un archivo por la firma de sus primeros bytes
 * ("magic numbers"), sin confiar en el Content-Type declarado por el navegador.
 * Devuelve el mimetype detectado, o null si no coincide con ninguno permitido.
 */
function detectRealMimeType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 5 && buffer.toString("ascii", 0, 5) === "%PDF-") {
    return "application/pdf";
  }
  // WebM/Matroska (Chrome, Firefox, Edge graban notas de voz en este contenedor):
  // cabecera EBML.
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "audio/webm";
  }
  // OGG (algunos navegadores empaquetan Opus en este contenedor): firma "OggS".
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") {
    return "audio/ogg";
  }
  // MP4/M4A (Safari/iOS graban notas de voz en este contenedor): caja "ftyp" en el offset 4.
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    return "audio/mp4";
  }
  // MP3 con cabecera ID3 (poco común desde MediaRecorder, se acepta por si acaso).
  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") {
    return "audio/mpeg";
  }
  return null;
}

/** Da formato "m:ss" a una duración en segundos (usada en la leyenda de notas de voz). */
function formatDurationLabel(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Recorta un nombre de archivo a algo seguro para mostrar (sin ruta, largo acotado).
 *
 * Busboy/multer entregan `originalname` decodificado como Latin-1 (así procesa Node
 * los headers HTTP), aunque el navegador haya enviado los bytes reales en UTF-8 —
 * por eso "daño.jpg" llega como "daÃ±o.jpg". Se revierte con el "round-trip" estándar
 * para este problema conocido; en un nombre puramente ASCII esta conversión no
 * cambia nada (es un no-op seguro).
 */
function sanitizeOriginalName(name) {
  const raw = String(name || "archivo");
  let fixed = raw;
  try {
    fixed = Buffer.from(raw, "latin1").toString("utf8");
  } catch (_e) {
    fixed = raw;
  }
  const base = path.basename(fixed);
  const cleaned = base.replace(/[\r\n"\\]/g, "").trim();
  return cleaned.slice(0, 150) || "archivo";
}

/** Error esperado (archivo con un tipo no permitido) — se distingue de una falla interna. */
class UploadValidationError extends Error {}

/**
 * Transcribe una nota de voz a texto en español con la API de Whisper de OpenAI
 * (proveedor independiente de Anthropic — Claude no transcribe audio). Devuelve el
 * texto transcrito, o `null` si la transcripción no está disponible (sin
 * OPENAI_API_KEY configurada) o falla (audio ilegible, error de red, límite de la
 * API, etc.) — en ambos casos el audio ya quedó guardado igual, solo no se pudo
 * transcribir; quien llama decide cómo avisarle al usuario.
 */
async function transcribeAudio(buffer, filename, mimetype) {
  if (!OPENAI_API_KEY) return null;

  try {
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: mimetype }), filename);
    formData.append("model", "whisper-1");
    formData.append("language", "es");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.warn(`[aviso] Whisper respondió ${response.status} al transcribir una nota de voz:`, errBody.slice(0, 300));
      return null;
    }

    const data = await response.json();
    const text = typeof data.text === "string" ? data.text.trim() : "";
    return text || null;
  } catch (err) {
    console.warn("[aviso] No se pudo transcribir la nota de voz con Whisper:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Síntesis de voz (texto-a-voz): Lucy responde con audio, no solo con texto
// ---------------------------------------------------------------------------

/** Recorta un texto largo a un tamaño razonable para hablarlo (los proveedores de TTS
 *  tienen límites de caracteres por petición — ~5000 en ElevenLabs, 4096 en OpenAI),
 *  cortando en un límite de oración o palabra cuando es posible, para no partir a la
 *  mitad de una palabra. */
function capTextForSpeech(text, maxLen) {
  if (text.length <= maxLen) return text;
  let cut = text.lastIndexOf(". ", maxLen);
  if (cut < maxLen * 0.5) cut = text.lastIndexOf(" ", maxLen);
  if (cut < maxLen * 0.5) cut = maxLen;
  return text.slice(0, cut).trim();
}

/** Estima la duración hablada de un texto, en segundos — heurística simple basada en
 *  una velocidad de habla promedio en español (~2.5 palabras/segundo). Es solo un
 *  valor inicial razonable para mostrar antes de que el navegador cargue los metadatos
 *  reales del audio; no pretende ser exacta. */
function estimateSpeechDurationSeconds(text) {
  const wordCount = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(wordCount / 2.5));
}

/** Genera audio con la API de ElevenLabs (voz configurada en ELEVENLABS_VOICE_ID). */
async function synthesizeWithElevenLabs(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2", // soporta español (incluido acento latinoamericano)
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`ElevenLabs respondió ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Genera audio con la API de texto-a-voz de OpenAI (respaldo si ElevenLabs no está
 *  configurado o falla) — modelo "tts-1", voz "nova" (femenina, natural). */
async function synthesizeWithOpenAI(text) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "tts-1", voice: "nova", input: text }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`OpenAI TTS respondió ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Genera el audio de una respuesta de Lucy: intenta ElevenLabs primero (voz más
 * natural); si no está configurado, o la llamada falla, cae automáticamente a OpenAI
 * TTS. Devuelve `{ buffer, mimetype, provider }` (ambos proveedores devuelven MP3), o
 * `null` si ningún proveedor está disponible o ambos fallan — nunca lanza: quien llama
 * decide cómo seguir sin audio (el texto ya se generó/envió de todos modos).
 */
async function synthesizeSpeech(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const capped = capTextForSpeech(trimmed, 1800);

  if (ELEVENLABS_CONFIGURED) {
    try {
      const buffer = await synthesizeWithElevenLabs(capped);
      if (buffer && buffer.length) return { buffer, mimetype: "audio/mpeg", provider: "elevenlabs" };
    } catch (err) {
      console.warn("[aviso] ElevenLabs no pudo generar el audio, se intenta con OpenAI TTS:", err.message);
    }
  }

  if (OPENAI_API_KEY) {
    try {
      const buffer = await synthesizeWithOpenAI(capped);
      if (buffer && buffer.length) return { buffer, mimetype: "audio/mpeg", provider: "openai" };
    } catch (err) {
      console.warn("[aviso] No se pudo generar el audio con OpenAI TTS:", err.message);
    }
  }

  return null;
}

/**
 * Convierte un buffer de audio (MP3, típicamente lo que devuelven ElevenLabs/OpenAI) a
 * OGG/Opus mono usando ffmpeg — el único formato que WhatsApp reconoce como nota de voz
 * nativa (con su propio reproductor y waveform), en vez de un archivo adjunto genérico.
 * Usa archivos temporales (más robusto que streams con fluent-ffmpeg, especialmente en
 * Windows) que se limpian al terminar, con éxito o con error.
 */
function convertToOggOpus(inputBuffer) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG_BINARY_PATH) {
      reject(new Error("ffmpeg no está disponible en este entorno."));
      return;
    }

    const inPath = path.join(os.tmpdir(), `lucy-tts-in-${crypto.randomUUID()}.mp3`);
    const outPath = path.join(os.tmpdir(), `lucy-tts-out-${crypto.randomUUID()}.ogg`);
    const cleanup = () => {
      fs.promises.unlink(inPath).catch(() => {});
      fs.promises.unlink(outPath).catch(() => {});
    };

    fs.promises
      .writeFile(inPath, inputBuffer)
      .then(() => {
        ffmpeg(inPath)
          .audioCodec("libopus")
          .audioBitrate("64k")
          .audioChannels(1)
          .format("ogg")
          .on("error", (err) => {
            cleanup();
            reject(err);
          })
          .on("end", () => {
            fs.promises
              .readFile(outPath)
              .then((buffer) => {
                cleanup();
                resolve(buffer);
              })
              .catch((err) => {
                cleanup();
                reject(err);
              });
          })
          .save(outPath);
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

/** Guarda un audio GENERADO por Lucy (texto-a-voz) en /uploads/audio/luci/ y lo
 *  registra en el índice igual que un adjunto subido por un usuario — así el panel
 *  /admin puede revisarlo y GET /uploads/:fileId puede servirlo (incluido a Twilio,
 *  para enviarlo por WhatsApp). `text` es el texto exacto que se sintetizó: se guarda
 *  como `transcript`, sin necesidad de transcribirlo de vuelta (ya lo conocemos). */
async function saveGeneratedAudioEntry(buffer, mimetype, ext, text, sessionId, provider) {
  const fileId = crypto.randomUUID();
  const relPath = path.join("audio", "luci", `${fileId}.${ext}`);
  const filePath = path.join(UPLOADS_DIR, relPath);
  await fs.promises.writeFile(filePath, buffer);

  const entry = {
    fileId,
    sessionId,
    kind: "audio",
    mimetype,
    ext,
    relPath,
    originalName: `lucy-${fileId}.${ext}`,
    size: buffer.length,
    duration: estimateSpeechDurationSeconds(text),
    transcript: text,
    generatedBy: "lucy",
    ttsProvider: provider,
    createdAt: new Date().toISOString(),
  };
  uploadsIndexCache[fileId] = entry;
  persistUploadsIndex();
  return entry;
}

/** Genera y guarda (MP3) el audio de una respuesta de Lucy para el chat web, que lo
 *  reproduce directamente en el navegador — no necesita conversión a OGG/Opus (eso
 *  es solo para WhatsApp, ver sendLucyVoiceNoteToWhatsapp). Devuelve la entrada
 *  guardada, o `null` si no hay proveedor de TTS disponible o la generación falló. */
async function synthesizeAndSaveAudio(text, sessionId) {
  const speech = await synthesizeSpeech(text);
  if (!speech) return null;
  return saveGeneratedAudioEntry(speech.buffer, speech.mimetype, "mp3", text, sessionId, speech.provider);
}

/**
 * Genera el audio de una respuesta de Lucy, lo convierte a OGG/Opus y lo envía por
 * WhatsApp como una nota de voz nativa (Twilio Media) — el usuario la recibe igual que
 * cualquier nota de voz que grabe él mismo. Devuelve la entrada del audio guardado (para
 * que quien llama la enlace al mensaje correspondiente y así sea revisable en /admin),
 * o `null` si no había proveedor de TTS disponible o la conversión falló. Si el audio
 * se generó pero Twilio rechazó el envío, igual se devuelve la entrada — el archivo
 * queda guardado y revisable aunque la entrega haya fallado (en todos los casos de
 * falla se registra un aviso; la respuesta en texto ya se envió aparte).
 */
async function sendLucyVoiceNoteToWhatsapp(text, to, phoneKey, baseUrl) {
  const speech = await synthesizeSpeech(text);
  if (!speech) return null;

  let oggBuffer;
  try {
    oggBuffer = await convertToOggOpus(speech.buffer);
  } catch (err) {
    console.warn("[aviso] No se pudo convertir a OGG/Opus el audio de Lucy para WhatsApp:", err.message);
    return null;
  }

  const entry = await saveGeneratedAudioEntry(oggBuffer, "audio/ogg", "ogg", text, phoneKey, speech.provider);

  if (!twilioClient) return entry;
  try {
    const publicUrl = `${baseUrl}/uploads/${entry.fileId}`;
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, mediaUrl: [publicUrl] });
    return entry;
  } catch (err) {
    console.error("Error al enviar la nota de voz de Lucy por WhatsApp:", err.message);
    return entry;
  }
}

// Frases que, si el usuario las escribe (o dice en una nota de voz transcrita), hacen
// que Lucy responda también con audio en ese turno — ver shouldReplyWithAudio().
const AUDIO_REPLY_TRIGGER_PHRASES = [
  "respondeme por audio",
  "respondeme con audio",
  "contestame por audio",
  "contestame con audio",
  "mandame un audio",
  "mandame una nota de voz",
  "enviame un audio",
  "enviame una nota de voz",
  "responde con audio",
  "responde en audio",
  "responde por audio",
  "quiero un audio",
  "en audio por favor",
  "audio por favor",
  "puedes responder en audio",
  "puedes responderme en audio",
];

// Despedidas explícitas del usuario — Lucy responde con audio en ese turno (interpretación
// de "mensajes de despedida siempre": no hay un mensaje de despedida guionado en este
// proyecto, así que se activa cuando el USUARIO se despide, no cuando Lucy decide hacerlo.
const FAREWELL_TRIGGER_PHRASES = ["adios", "hasta luego", "hasta pronto", "nos vemos", "chao", "chau"];

/** ¿Debería Lucy responder con audio en este turno? (más allá de la regla "si el usuario
 *  envió una nota de voz, responder en el mismo formato", que se evalúa aparte). */
function shouldReplyWithAudio(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    AUDIO_REPLY_TRIGGER_PHRASES.some((p) => normalized.includes(normalizeText(p))) ||
    FAREWELL_TRIGGER_PHRASES.some((p) => normalized.includes(normalizeText(p)))
  );
}

/**
 * Guarda un archivo adjunto ya recibido en memoria (buffer): valida su tipo real por
 * la firma de sus bytes, lo escribe en /uploads (las notas de voz, en /uploads/audio)
 * con un nombre aleatorio, extrae el texto si es un PDF o transcribe el audio si es una
 * nota de voz, y registra la entrada en el índice. La usan tanto el endpoint del widget
 * web (POST /api/upload) como el webhook de WhatsApp (fotos/documentos/notas de voz
 * recibidos por Twilio), para no duplicar esta lógica entre ambos canales.
 *
 * `extraMeta.duration` (segundos) es opcional y solo se usa para notas de voz —
 * lo informa el propio cliente al subir el archivo (el servidor no puede calcular
 * la duración de un audio sin decodificarlo, así que es un dato best-effort que no
 * afecta la validación ni el guardado del archivo).
 */
async function saveUploadedFile(buffer, originalNameRaw, sessionId, extraMeta) {
  const detectedMime = detectRealMimeType(buffer);
  if (!detectedMime || !ALLOWED_UPLOAD_MIMES[detectedMime]) {
    throw new UploadValidationError("El archivo no parece ser un JPG, PNG, PDF o nota de voz válida.");
  }

  const fileId = crypto.randomUUID();
  const ext = ALLOWED_UPLOAD_MIMES[detectedMime];
  const kind = detectedMime === "application/pdf" ? "pdf" : detectedMime.startsWith("audio/") ? "audio" : "image";
  // Las notas de voz se guardan aparte, en /uploads/audio/ (ver AUDIO_UPLOADS_DIR).
  const relPath = kind === "audio" ? path.join("audio", `${fileId}.${ext}`) : `${fileId}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, relPath);

  await fs.promises.writeFile(filePath, buffer);

  let extractedText = "";
  if (kind === "pdf") {
    let parser;
    try {
      parser = new PDFParse({ data: buffer });
      const parsed = await parser.getText();
      // Quita los separadores de página ("-- 1 of N --") que agrega pdf-parse.
      extractedText = (parsed.text || "")
        .replace(/--\s*\d+\s+of\s+\d+\s*--/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 8000);
    } catch (err) {
      console.warn("[aviso] No se pudo extraer texto del PDF adjunto:", err.message);
    } finally {
      if (parser && parser.destroy) {
        await parser.destroy().catch(() => {});
      }
    }
  }

  const duration =
    kind === "audio" ? Math.max(0, Math.round(Number(extraMeta && extraMeta.duration) || 0)) : undefined;

  // La transcripción ocurre siempre en el servidor (nunca en el cliente) — ver
  // transcribeAudio(). Si falla o no hay OPENAI_API_KEY configurada, el audio se
  // guarda igual; solo queda sin transcript (null), y cada canal decide cómo avisar.
  const transcript = kind === "audio" ? await transcribeAudio(buffer, sanitizeOriginalName(originalNameRaw), detectedMime) : undefined;

  const entry = {
    fileId,
    sessionId,
    kind,
    mimetype: detectedMime,
    ext,
    relPath,
    originalName: sanitizeOriginalName(originalNameRaw),
    size: buffer.length,
    extractedText: kind === "pdf" ? extractedText : undefined,
    duration,
    transcript: kind === "audio" ? transcript || null : undefined,
    createdAt: new Date().toISOString(),
  };
  uploadsIndexCache[fileId] = entry;
  persistUploadsIndex();

  return entry;
}

/** Texto de reemplazo cuando un mensaje solo trae un adjunto, sin texto propio. */
function defaultCaptionForAttachment(entry) {
  if (entry.kind === "pdf") return `📄 Documento adjunto: ${entry.originalName}`;
  if (entry.kind === "audio") return `🎤 Nota de voz (${formatDurationLabel(entry.duration)})`;
  return "📷 Foto adjunta";
}

/** Construye el objeto `attachment` con los metadatos completos (mismo shape que usa
 *  el cliente) a partir de una entrada del índice de uploads. Lo usan tanto
 *  resolveMessageAttachment (adjuntos que llegan del cliente como `{fileId}`) como los
 *  mensajes del ASISTENTE con audio recién generado (que no pasan por resolveAttachments
 *  porque se crean después, ya del lado del servidor — ver synthesizeAndSaveAudio y
 *  sendLucyVoiceNoteToWhatsapp) — así ambos caminos producen exactamente la misma forma
 *  y el panel /admin puede mostrarlos igual sin importar de dónde vinieron. */
function attachmentRefFromEntry(entry) {
  return {
    fileId: entry.fileId,
    kind: entry.kind,
    mimetype: entry.mimetype,
    ext: entry.ext,
    filename: entry.originalName,
    size: entry.size,
    extractedText: entry.kind === "pdf" ? entry.extractedText || "" : undefined,
    duration: entry.kind === "audio" ? entry.duration : undefined,
    transcript: entry.kind === "audio" ? entry.transcript || null : undefined,
    generatedBy: entry.kind === "audio" ? entry.generatedBy : undefined,
    ttsProvider: entry.kind === "audio" ? entry.ttsProvider : undefined,
  };
}

/**
 * Convierte un mensaje sanitizado con un `attachment: { fileId }` (fotos, documentos,
 * notas de voz) o `attachment: { videoKey }` (videos del catálogo de Lucy) en un
 * objeto con los metadatos completos y confiables del adjunto — tomados del índice de
 * uploads o del catálogo de videos del servidor, nunca de lo que el cliente reenvíe —
 * o sin `attachment` si la referencia no existe (o, para fileId, no pertenece a esta
 * conversación, o el archivo ya no está).
 */
function resolveMessageAttachment(message, sessionId) {
  const videoKey = message && message.attachment && message.attachment.videoKey;
  if (typeof videoKey === "string") {
    const video = VIDEO_CATALOG.find((v) => v.key === videoKey);
    const videoAttachment = video ? resolveVideoAttachment(video) : null;
    if (videoAttachment) return { ...message, attachment: videoAttachment };
    const { attachment: _drop, ...rest } = message;
    return rest;
  }

  const fileId = message && message.attachment && message.attachment.fileId;
  if (typeof fileId !== "string" || !FILE_ID_RE.test(fileId)) {
    const { attachment: _drop, ...rest } = message;
    return rest;
  }

  const entry = uploadsIndexCache[fileId];
  if (!entry || entry.sessionId !== sessionId) {
    const { attachment: _drop, ...rest } = message;
    return rest;
  }

  return { ...message, attachment: attachmentRefFromEntry(entry) };
}

/**
 * Igual que resolveMessageAttachment, pero para el campo `media` (imágenes del
 * catálogo de Lucy) — un campo aparte de `attachment` para que ambos puedan convivir
 * en el mismo mensaje (p. ej. una respuesta con audio Y una infografía adjunta).
 */
function resolveMessageMedia(message) {
  const mediaKey = message && message.media && message.media.mediaKey;
  if (typeof mediaKey !== "string") {
    const { media: _drop, ...rest } = message;
    return rest;
  }

  const media = MEDIA_CATALOG.find((m) => m.key === mediaKey);
  const mediaAttachment = media ? resolveMediaAttachment(media) : null;
  if (!mediaAttachment) {
    const { media: _drop, ...rest } = message;
    return rest;
  }

  return { ...message, media: mediaAttachment };
}

/** Aplica resolveMessageAttachment y resolveMessageMedia a todo el historial de
 *  mensajes de una petición. */
function resolveAttachments(messages, sessionId) {
  return messages.map((m) => resolveMessageMedia(resolveMessageAttachment(m, sessionId)));
}

// ---------------------------------------------------------------------------
// Autenticación simple del panel de administración (cookie de sesión firmada
// en memoria — sin dependencias externas; se reinicia si el servidor se reinicia)
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} token -> expiresAt (ms) */
const adminSessions = new Map();

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch (_e) {
        out[key] = val;
      }
    }
  });
  return out;
}

function issueAdminSession(res) {
  const token = crypto.randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + ADMIN_SESSION_TTL_MS);
  const secureFlag = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(
      ADMIN_SESSION_TTL_MS / 1000
    )}${secureFlag}`
  );
}

function clearAdminSession(req, res) {
  const token = parseCookies(req)[ADMIN_COOKIE_NAME];
  if (token) adminSessions.delete(token);
  res.setHeader("Set-Cookie", `${ADMIN_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function isAdminAuthenticated(req) {
  const token = parseCookies(req)[ADMIN_COOKIE_NAME];
  if (!token) return false;
  const expiresAt = adminSessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthenticated(req)) {
    return res.status(401).json({ error: "No autenticado." });
  }
  next();
}

/** Comparación en tiempo constante para evitar ataques de temporización sobre la contraseña. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // mantiene un costo similar aunque la longitud difiera
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function csvEscape(value) {
  const str = String(value == null ? "" : value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---------------------------------------------------------------------------
// Autenticación del portal de corredores (/corredor) — JWT (jsonwebtoken), a
// diferencia de la cookie de sesión del panel /admin. El token viaja en el header
// `Authorization: Bearer <token>` en peticiones normales (el cliente lo guarda en
// localStorage, ver public/corredor.js) y como query string `?token=` SOLO para el
// stream SSE de notificaciones (EventSource no permite headers personalizados — es
// la única excepción; ver GET /api/corredor/events).
// ---------------------------------------------------------------------------

function issueCorredorToken(corredor) {
  return jwt.sign({ sub: corredor.id, email: corredor.email, nombre: corredor.nombre }, JWT_SECRET, {
    expiresIn: CORREDOR_TOKEN_TTL_S,
  });
}

/** Extrae y valida el JWT de una petición (header Authorization, o `?token=` para el
 *  stream SSE) y adjunta el perfil público del corredor en `req.corredor`. Responde
 *  401 si falta, es inválido, expiró, o la cuenta ya no existe/está desactivada. */
function requireCorredorAuth(req, res, next) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "El portal de corredores no está configurado (falta JWT_SECRET en el servidor)." });
  }
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const token = bearerToken || (typeof req.query.token === "string" ? req.query.token : "");
  if (!token) {
    return res.status(401).json({ error: "No autenticado." });
  }
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (_err) {
    return res.status(401).json({ error: "Sesión inválida o expirada. Inicia sesión de nuevo." });
  }
  const corredor = corredoresService.buscarPorId(payload.sub);
  if (!corredor || !corredor.activo) {
    return res.status(401).json({ error: "Cuenta no encontrada o desactivada." });
  }
  req.corredor = corredoresService.toPublicCorredor(corredor);
  next();
}

// ---------------------------------------------------------------------------
// Notificaciones en tiempo real del portal de corredores — un stream SSE por sesión
// conectada (mismo mecanismo que /api/chat, ver sendSse), pero de larga duración: se
// mantiene abierto mientras el corredor tiene el portal abierto en el navegador. Un
// mismo corredor puede tener varias pestañas/conexiones a la vez (Set de respuestas).
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<import('express').Response>>} corredorId -> conexiones SSE abiertas */
const corredorEventStreams = new Map();

function registerCorredorEventStream(corredorId, res) {
  if (!corredorEventStreams.has(corredorId)) corredorEventStreams.set(corredorId, new Set());
  corredorEventStreams.get(corredorId).add(res);
}

function unregisterCorredorEventStream(corredorId, res) {
  const set = corredorEventStreams.get(corredorId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) corredorEventStreams.delete(corredorId);
}

/** Envía un evento en tiempo real a TODAS las conexiones abiertas de un corredor (no
 *  hace nada si no tiene ninguna — el corredor simplemente no ve el toast hasta que
 *  vuelva a abrir el portal, no se pierde el dato de fondo porque siempre vive
 *  igual en /api/corredor/* — esto es solo la notificación push). */
function notifyCorredor(corredorId, event, data) {
  const set = corredorEventStreams.get(corredorId);
  if (!set || set.size === 0) return;
  for (const res of set) {
    try {
      sendSse(res, event, data);
    } catch (_err) {
      // conexión ya cerrada del otro lado — se limpiará en el evento "close" del stream
    }
  }
}

/** Ubica la cuenta de corredor dueña de una póliza (por su campo `corredor`, un
 *  nombre) y le notifica en tiempo real — usado cuando un cliente de su cartera abre
 *  un siniestro (ver finalizeSiniestroFlow) o cuando una póliza cruza el umbral de 7
 *  días para vencer (ver iniciarChequeoVencimientosCorredores). No lanza si no
 *  encuentra corredor — no toda póliza tiene por qué tener uno registrado en el portal. */
function notifyCorredorDePoliza(nombreCorredorPoliza, event, data) {
  if (!nombreCorredorPoliza) return;
  const corredor = corredoresService.buscarPorNombre(nombreCorredorPoliza);
  if (corredor) notifyCorredor(corredor.id, event, data);
}

/**
 * Revisa periódicamente las pólizas de cada corredor activo por si alguna cruzó el
 * umbral de "vence en 7 días" desde la última revisión, y le manda un toast en tiempo
 * real (ver notifyCorredor) — sin scheduler/cron real, un `setInterval` en memoria
 * (se reinicia si el servidor se reinicia, junto con el registro de ya notificadas,
 * así que tras un reinicio puede volver a avisar una vez de las que sigan en rango;
 * aceptable para una alerta informativa, no crítica).
 */
const polizasYaAlertadas = new Set(); // `${corredorId}:${numeroPoliza}` ya notificadas en esta corrida
async function chequearVencimientosCorredores() {
  for (const corredor of corredoresService.listarTodosCorredores()) {
    if (!corredorEventStreams.has(corredor.id)) continue; // nadie conectado, no vale la pena consultar
    try {
      const porVencer = await corredoresService.polizasPorVencer(corredor.nombre, CORREDOR_ALERTA_VENCIMIENTO_DIAS);
      for (const p of porVencer) {
        if (p.vigencia.vencida) continue; // esta alerta es solo "por vencer", no "ya vencida"
        const key = `${corredor.id}:${p.numero}`;
        if (polizasYaAlertadas.has(key)) continue;
        polizasYaAlertadas.add(key);
        notifyCorredor(corredor.id, "poliza-por-vencer", {
          numero: p.numero,
          titular: p.titular,
          diasRestantes: p.vigencia.diasRestantes,
          vigenciaFin: p.vigencia_fin,
        });
      }
    } catch (err) {
      console.warn("[aviso] Error revisando vencimientos para", corredor.nombre, ":", err.message);
    }
  }
}

function iniciarChequeoVencimientosCorredores() {
  setInterval(() => {
    chequearVencimientosCorredores().catch((err) => console.warn("[aviso] chequearVencimientosCorredores falló:", err.message));
  }, CORREDOR_CHEQUEO_VENCIMIENTOS_MS).unref();
}

// ---------------------------------------------------------------------------
// Modo supervisor: un supervisor desde /admin puede ver una conversación EN VIVO,
// escribir un mensaje que Lucy envía como suyo ("shadow messaging"), tomar control
// total (pausa las respuestas automáticas) y dejar notas internas.
//
// Dos registros de streams SSE, mismo mecanismo que corredorEventStreams:
//  - conversationEventStreams: la conexión persistente del propio WIDGET WEB (o de
//    WhatsApp, que no la necesita porque ya es push-capable vía Twilio) — así puede
//    recibir un mensaje del servidor SIN que el usuario haya escrito nada (shadow
//    messaging), algo que el modelo normal de petición/respuesta de /api/chat no
//    permite por sí solo.
//  - adminConversationWatchers: la vista "🔴 En vivo" del panel /admin sobre una
//    conversación puntual — recibe tanto los mensajes del usuario como los de Lucy
//    (o del supervisor) a medida que ocurren, sin tener que refrescar el modal.
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<import('express').Response>>} sessionId -> conexiones SSE del widget/WhatsApp */
const conversationEventStreams = new Map();
/** @type {Map<string, Set<import('express').Response>>} sessionId -> conexiones SSE de supervisores viendo esa conversación */
const adminConversationWatchers = new Map();

function registerStream(registry, key, res) {
  if (!registry.has(key)) registry.set(key, new Set());
  registry.get(key).add(res);
}

function unregisterStream(registry, key, res) {
  const set = registry.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) registry.delete(key);
}

function notifyConversationStream(sessionId, event, data) {
  const set = conversationEventStreams.get(sessionId);
  if (!set || set.size === 0) return;
  for (const res of set) {
    try {
      sendSse(res, event, data);
    } catch (_err) {
      // conexión ya cerrada — se limpia sola en el evento "close" del stream
    }
  }
}

/** Le avisa a cualquier supervisor viendo esta conversación en vivo que hay un
 *  mensaje nuevo (de cualquier rol) — `message` es la entrada tal cual se guarda en
 *  `record.messages` (role/content/time/attachment/media). */
function notifyAdminWatchers(sessionId, message) {
  const set = adminConversationWatchers.get(sessionId);
  if (!set || set.size === 0) return;
  for (const res of set) {
    try {
      sendSse(res, "message", message);
    } catch (_err) {
      // conexión ya cerrada — se limpia sola en el evento "close" del stream
    }
  }
}

// ---------------------------------------------------------------------------
// Tareas programadas (node-cron) — ver config/scheduler.config.js para horarios y
// umbrales. Tres tareas: recordatorios de pólizas por vencer, seguimiento de
// cotizaciones sin cerrar, y valoración de calidad por inactividad (solo WhatsApp).
// ---------------------------------------------------------------------------

// Enfriamiento entre recordatorios de una misma póliza (data/notificaciones-programadas.json)
// — es lo que evita el "SPAM diario" pedido explícitamente: aunque la tarea corra
// todos los días a las 9am, una póliza dada solo se vuelve a notificar después de
// `diasMinimosEntreRecordatorios` días (ver config/scheduler.config.js).
const NOTIFICACIONES_PROGRAMADAS_FILE = process.env.NOTIFICACIONES_PROGRAMADAS_FILE
  ? path.resolve(__dirname, process.env.NOTIFICACIONES_PROGRAMADAS_FILE)
  : path.join(__dirname, "data", "notificaciones-programadas.json");

let notificacionesProgramadasCache = null;
let notificacionesProgramadasWriteQueue = Promise.resolve();

function getNotificacionesProgramadas() {
  if (!notificacionesProgramadasCache) {
    try {
      const raw = fs.existsSync(NOTIFICACIONES_PROGRAMADAS_FILE) ? fs.readFileSync(NOTIFICACIONES_PROGRAMADAS_FILE, "utf8") : "";
      notificacionesProgramadasCache = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      console.error(`[aviso] No se pudo leer ${path.basename(NOTIFICACIONES_PROGRAMADAS_FILE)}, se iniciará vacío:`, err.message);
      notificacionesProgramadasCache = {};
    }
  }
  return notificacionesProgramadasCache;
}

function persistNotificacionesProgramadas() {
  notificacionesProgramadasWriteQueue = notificacionesProgramadasWriteQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify(getNotificacionesProgramadas(), null, 2);
        fs.writeFile(NOTIFICACIONES_PROGRAMADAS_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar notificaciones-programadas.json:", err.message);
          resolve();
        });
      })
  );
  return notificacionesProgramadasWriteQueue;
}

function debeEnviarRecordatorioPoliza(numeroPoliza, diasMinimos) {
  const ultimo = getNotificacionesProgramadas()[numeroPoliza];
  if (!ultimo) return true;
  const diasDesde = (Date.now() - new Date(ultimo).getTime()) / (24 * 60 * 60 * 1000);
  return diasDesde >= diasMinimos;
}

function marcarRecordatorioPolizaEnviado(numeroPoliza) {
  getNotificacionesProgramadas()[numeroPoliza] = new Date().toISOString();
  return persistNotificacionesProgramadas();
}

/**
 * Tarea 9:00 AM: por cada póliza que vence dentro de `diasAntesVencimiento` días
 * (y no está ya vencida), envía un WhatsApp al cliente (si tiene teléfono en su
 * memoria persistente) y a su corredor (si tiene cuenta en el portal /corredor) —
 * ver "RESPUESTAS PROACTIVAS PROGRAMADAS" del pedido original.
 */
async function enviarRecordatoriosPolizasPorVencer() {
  const cfg = schedulerConfig.recordatoriosPolizas;
  if (!cfg.enabled) return;

  const todas = await polizasService.listarTodas();
  let enviados = 0;
  for (const poliza of todas) {
    const vigencia = polizasService.verificarVigencia(poliza);
    if (vigencia.vencida || !vigencia.porVencer) continue;
    if (vigencia.diasRestantes > cfg.diasAntesVencimiento) continue;
    if (!debeEnviarRecordatorioPoliza(poliza.numero, cfg.diasMinimosEntreRecordatorios)) continue;

    const ramoLabel = POLIZA_RAMO_LABELS[poliza.ramo] || poliza.ramo;
    let enviadoAlguno = false;

    const cliente = getClienteByCedula(poliza.cedula);
    const clienteTo = cliente ? toWhatsappAddress(cliente.telefono) : null;
    if (clienteTo) {
      await sendWhatsappMessage(
        clienteTo,
        `Hola ${poliza.titular.split(" ")[0]} 👋, te recordamos que tu póliza ${poliza.numero} (${ramoLabel}) vence el ` +
          `${poliza.vigencia_fin} (en ${vigencia.diasRestantes} día(s)). Contáctanos para renovarla a tiempo y evitar quedar sin cobertura.`
      );
      enviadoAlguno = true;
    }

    if (poliza.corredor) {
      const corredor = corredoresService.buscarPorNombre(poliza.corredor);
      const corredorTo = corredor ? toWhatsappAddress(corredor.telefono) : null;
      if (corredorTo) {
        await sendWhatsappMessage(
          corredorTo,
          `Recordatorio: la póliza ${poliza.numero} (${ramoLabel}) de tu cliente ${poliza.titular} vence el ` +
            `${poliza.vigencia_fin} (en ${vigencia.diasRestantes} día(s)).`
        );
        enviadoAlguno = true;
      }
    }

    if (enviadoAlguno) {
      await marcarRecordatorioPolizaEnviado(poliza.numero);
      enviados++;
    }
  }
  console.log(`[scheduler] Recordatorios de pólizas por vencer: ${enviados} póliza(s) notificada(s).`);
}

/**
 * Tarea 3:00 PM: por cada cotización sin cerrar (`formalRequest` falso) que lleva más
 * de `horasSinCerrar` horas abierta, Lucy manda un mensaje de seguimiento por
 * WhatsApp. Se marca `quote.seguimientoEnviado` la primera vez — nunca se reintenta
 * la misma cotización, haya o no teléfono disponible (evita seguir intentando
 * indefinidamente sobre datos que no van a cambiar).
 */
async function enviarSeguimientoCotizaciones() {
  const cfg = schedulerConfig.seguimientoCotizaciones;
  if (!cfg.enabled) return;

  const umbralMs = cfg.horasSinCerrar * 60 * 60 * 1000;
  let procesadas = 0;

  for (const record of Object.values(conversationsCache)) {
    if (!record.quotes) continue;
    for (const quote of Object.values(record.quotes)) {
      if (quote.formalRequest || quote.seguimientoEnviado) continue;
      const edadMs = Date.now() - new Date(quote.createdAt).getTime();
      if (Number.isNaN(edadMs) || edadMs < umbralMs) continue;

      const cedula = (quote.contact && quote.contact.cedula) || record.clienteId;
      const cliente = cedula ? getClienteByCedula(cedula) : null;
      const to = cliente ? toWhatsappAddress(cliente.telefono) : record.channel === "whatsapp" ? record.phone : null;
      if (to) {
        const nombre = (quote.contact && quote.contact.nombre) || (cliente && cliente.nombre) || "";
        await sendWhatsappMessage(
          to,
          `Hola${nombre ? " " + nombre.split(" ")[0] : ""} 👋, notamos que dejaste pendiente tu cotización de ` +
            `${RAMO_LABELS[quote.ramo] || quote.ramo} con ${COMPANY_NAME}. ¿Te ayudamos a continuar, o tienes alguna duda?`
        );
      }

      // Se marca "ya contactada" haya o no teléfono disponible (nunca se reintenta esa
      // misma cotización, ver comentario de la función) — por eso hay que persistir
      // siempre que se procesó AL MENOS una, no solo cuando hubo un envío real: si esta
      // corrida no encontró teléfono para ninguna, las marcas quedarían solo en memoria
      // y se perderían (reintentando esas mismas cotizaciones sin sentido) si el
      // servidor se reinicia antes de la próxima vez que sí haya un envío real.
      quote.seguimientoEnviado = true;
      procesadas++;
    }
  }

  if (procesadas > 0) persistConversations();
  console.log(`[scheduler] Seguimiento de cotizaciones sin cerrar: ${procesadas} procesada(s).`);
}

/**
 * Tarea cada 2 minutos: pregunta la valoración de calidad (RATING_ASK_TEXT) en
 * conversaciones de WhatsApp inactivas hace `minutosInactividad` minutos — el último
 * mensaje fue de Lucy y el usuario no volvió a escribir desde entonces. Solo una vez
 * por conversación (record.ratingState). Solo WhatsApp: el widget web no tiene una
 * conexión abierta fuera de una petición activa para recibir esto (ver
 * "Modo supervisor" para el mecanismo en vivo que sí puede empujar mensajes al chat web).
 */
async function preguntarValoracionPorInactividad() {
  const cfg = schedulerConfig.valoracionInactividad;
  if (!cfg.enabled) return;

  const umbralMs = cfg.minutosInactividad * 60 * 1000;
  const maxEdadMs = (cfg.maxHorasConversacion || 24) * 60 * 60 * 1000;
  const ahora = Date.now();
  let preguntadas = 0;

  for (const record of Object.values(conversationsCache)) {
    if (record.channel !== "whatsapp" || record.ratingState || !record.phone) continue;
    const msgs = record.messages || [];
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") continue; // Lucy debe haber sido quien respondió último

    const updatedMs = new Date(record.updatedAt).getTime();
    if (Number.isNaN(updatedMs)) continue;
    const inactivaMs = ahora - updatedMs;
    if (inactivaMs < umbralMs || inactivaMs > maxEdadMs) continue;

    // `ratingState` se marca ANTES de mandar el WhatsApp (no después): sendWhatsappMessage
    // nunca lanza (atrapa sus propios errores), así que no hay riesgo de marcar "asked"
    // sin haber intentado el envío — pero si se marcara DESPUÉS, una ejecución solapada
    // de esta misma tarea (ver el guard de solapamiento en iniciarScheduler) podría
    // alcanzar a leer `record.ratingState` todavía vacío y mandar la pregunta dos veces
    // a la misma conversación antes de que la primera termine de marcarla.
    record.ratingState = "asked";
    record.messages.push({ role: "assistant", content: RATING_ASK_TEXT, time: new Date().toISOString() });
    touchConversationRecord(record);
    await sendWhatsappMessage(record.phone, RATING_ASK_TEXT);
    preguntadas++;
  }
  if (preguntadas > 0) console.log(`[scheduler] Valoración por inactividad: ${preguntadas} conversación(es) preguntada(s).`);
}

function iniciarScheduler() {
  const jobs = [
    [schedulerConfig.recordatoriosPolizas, enviarRecordatoriosPolizasPorVencer, "recordatoriosPolizas"],
    [schedulerConfig.seguimientoCotizaciones, enviarSeguimientoCotizaciones, "seguimientoCotizaciones"],
    [schedulerConfig.valoracionInactividad, preguntarValoracionPorInactividad, "valoracionInactividad"],
  ];
  for (const [cfg, fn, nombre] of jobs) {
    if (!cfg || !cfg.enabled) continue;
    // Evita que dos ejecuciones de la MISMA tarea se solapen (p. ej. si una corrida de
    // "valoracionInactividad" — cada 2 minutos — tarda más de 2 minutos en procesar
    // todas las conversaciones inactivas, por los envíos de WhatsApp secuenciales):
    // sin este guard, la segunda corrida podría leer el mismo registro antes de que la
    // primera termine de marcarlo, y mandarle la pregunta dos veces al mismo cliente.
    let running = false;
    cron.schedule(
      cfg.cronExpression,
      () => {
        if (running) {
          console.warn(`[scheduler] La tarea "${nombre}" todavía estaba corriendo — se omite esta ejecución para evitar solapamiento.`);
          return;
        }
        running = true;
        fn()
          .catch((err) => console.error(`[scheduler] Error en la tarea "${nombre}":`, err))
          .finally(() => {
            running = false;
          });
      },
      { timezone: schedulerConfig.timezone }
    );
  }
  console.log(`[scheduler] Tareas programadas iniciadas (huso horario: ${schedulerConfig.timezone}).`);
}

// ---------------------------------------------------------------------------
// App Express
// ---------------------------------------------------------------------------

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      // Permite peticiones sin origin (curl, apps móviles) y orígenes en la lista blanca.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origen no permitido por CORS: ${origin}`));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
// Sirve SOLO los archivos públicos del frontend (public/index.html, chatbot.js,
// chatbot.css, admin.html, admin.js, admin.css, lucy-avatar.png, assets/luci-videos/,
// assets/lucy-media/) — nunca la raíz del proyecto completa. Servir __dirname
// directamente expondría server.js, conversations.json (PII de usuarios),
// quoter-config.json y uploads-index.json como archivos estáticos descargables.
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

// Videos comprimidos e imágenes redimensionadas para WhatsApp (ver
// compressVideoForWhatsapp / resizeMediaForWhatsapp) — carpetas aparte de public/
// porque son generadas/cacheadas, no parte del código fuente del frontend.
app.use("/video-cache", express.static(VIDEO_CACHE_DIR));
app.use("/media-cache", express.static(MEDIA_CACHE_DIR));

const chatLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Has enviado demasiados mensajes en poco tiempo. Intenta de nuevo en un momento.",
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos de inicio de sesión. Intenta de nuevo más tarde." },
});

// Guardar una cotización no llama a la API de Anthropic, así que puede ser más permisivo.
const quoteLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intenta de nuevo en un momento." },
});

const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Has adjuntado demasiados archivos en poco tiempo. Intenta de nuevo en un momento." },
});

// Todas las peticiones de Twilio llegan desde las IPs de Twilio, no de cada usuario
// de WhatsApp — limitar por IP (como chatLimiter) castigaría a todos los usuarios
// de WhatsApp en conjunto. Se limita por número de remitente en su lugar.
const whatsappLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.From) || req.ip,
  message: { error: "Demasiados mensajes en poco tiempo." },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Valida y normaliza el historial de mensajes recibido del cliente.
 * Devuelve { messages, error } — si `error` no es null, la petición es inválida.
 */
function sanitizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return { messages: null, error: "El campo 'messages' debe ser un arreglo no vacío." };
  }

  const trimmed = rawMessages.slice(-MAX_HISTORY_MESSAGES);
  const messages = [];

  for (const msg of trimmed) {
    if (!msg || typeof msg !== "object") {
      return { messages: null, error: "Cada mensaje debe ser un objeto." };
    }
    const { role, content, time, attachment, media } = msg;
    if (role !== "user" && role !== "assistant") {
      return { messages: null, error: "El campo 'role' debe ser 'user' o 'assistant'." };
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return { messages: null, error: "El campo 'content' debe ser texto no vacío." };
    }
    // Conserva el timestamp original del cliente (para el historial del panel de
    // administración); si no viene uno válido, se usa el momento de la petición.
    const isValidTime = typeof time === "string" && !Number.isNaN(Date.parse(time));

    const sanitized = {
      role,
      content: content.slice(0, MAX_MESSAGE_LENGTH),
      time: isValidTime ? time : new Date().toISOString(),
    };

    // Solo se conserva la *referencia* al adjunto (fileId para fotos/documentos/notas
    // de voz, videoKey para los videos explicativos del catálogo) — sus metadatos
    // reales se resuelven más adelante desde una fuente confiable del servidor (ver
    // resolveAttachments), nunca desde lo que el cliente reenvíe.
    if (attachment && typeof attachment === "object") {
      if (typeof attachment.fileId === "string") {
        sanitized.attachment = { fileId: attachment.fileId };
      } else if (typeof attachment.videoKey === "string") {
        sanitized.attachment = { videoKey: attachment.videoKey };
      }
    }

    // `media` es un campo APARTE de `attachment` — una imagen del catálogo de Lucy que
    // acompaña a la misma respuesta (a diferencia del audio/video, que van en su propio
    // `attachment`), para que ambos puedan coexistir en el mismo mensaje sin pisarse.
    if (media && typeof media === "object" && typeof media.mediaKey === "string") {
      sanitized.media = { mediaKey: media.mediaKey };
    }

    messages.push(sanitized);
  }

  // La API exige que el primer mensaje sea de 'user'.
  while (messages.length > 0 && messages[0].role !== "user") {
    messages.shift();
  }

  if (messages.length === 0) {
    return { messages: null, error: "No hay mensajes de usuario válidos en la conversación." };
  }

  return { messages, error: null };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractText(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Construye el arreglo de mensajes que se envía a la API de Anthropic a partir del
 * historial ya resuelto (ver resolveAttachments):
 *  - Imagen adjunta en el mensaje MÁS RECIENTE -> bloque de visión con los bytes
 *    reales (base64), para que Claude la analice.
 *  - Imagen adjunta en un mensaje más antiguo -> solo una referencia de texto (no
 *    se reenvían los mismos bytes en cada turno de una conversación larga).
 *  - PDF adjunto -> el texto ya extraído (pdf-parse) se antepone como contexto,
 *    en todo el historial (es liviano comparado con una imagen).
 */
async function buildAnthropicMessages(messages) {
  const lastIndex = messages.length - 1;

  const built = await Promise.all(messages.map((m, index) => buildAnthropicMessageContent(m, index, lastIndex)));

  // `m.media` (imagen del catálogo de Lucy adjunta a su propia respuesta) es un campo
  // APARTE de `attachment` — puede coexistir con un audio/video/pdf/foto en el mismo
  // mensaje (p. ej. una respuesta con audio Y una infografía). Nunca se re-envía como
  // bloque de visión (Lucy ya generó su texto sin "verla" de nuevo, sería puro gasto de
  // tokens): solo se antepone como contexto textual, en un segundo paso separado para
  // no duplicar esta lógica en cada rama de buildAnthropicMessageContent.
  return built.map((am, index) => {
    const media = messages[index] && messages[index].media;
    if (!media || typeof am.content !== "string") return am;
    return { role: am.role, content: `[Imagen enviada: ${media.title}]\n${am.content}` };
  });
}

/** Arma el contenido (para la API de Anthropic) de UN mensaje ya resuelto, según su
 *  `attachment` — ver buildAnthropicMessages, que aplica esto a todo el historial y
 *  luego antepone el contexto de `m.media` por separado. */
async function buildAnthropicMessageContent(m, index, lastIndex) {
  const attachment = m.attachment;
  if (!attachment) {
    return { role: m.role, content: m.content };
  }

  if (attachment.kind === "image") {
    if (index !== lastIndex) {
      return {
        role: m.role,
        content: `[Imagen adjunta anteriormente: ${attachment.filename}]\n${m.content}`,
      };
    }
    try {
      const filePath = path.join(UPLOADS_DIR, `${attachment.fileId}.${attachment.ext}`);
      const buffer = await fs.promises.readFile(filePath);
      return {
        role: m.role,
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: attachment.mimetype, data: buffer.toString("base64") },
          },
          { type: "text", text: m.content },
        ],
      };
    } catch (err) {
      console.warn("[aviso] No se pudo leer la imagen adjunta:", err.message);
      return {
        role: m.role,
        content: `[Imagen adjunta: ${attachment.filename} — ya no está disponible]\n${m.content}`,
      };
    }
  }

  if (attachment.kind === "pdf") {
    const snippet = (attachment.extractedText || "").trim();
    const textBlock = snippet
      ? `[Documento adjunto: ${attachment.filename}]\n"""${snippet}"""\n\n${m.content}`
      : `[Documento adjunto: ${attachment.filename} — no se pudo leer su texto]\n${m.content}`;
    return { role: m.role, content: textBlock };
  }

  if (attachment.kind === "audio") {
    // Claude no puede "escuchar" audio: se le envía la transcripción de Whisper
    // como si fuera el mensaje de texto del usuario. Si la transcripción falló (o
    // no hay OPENAI_API_KEY configurada), se le avisa al modelo en su lugar, para
    // que responda en consecuencia en vez de fingir que sabe qué se dijo.
    const transcript = (attachment.transcript || "").trim();
    if (transcript) {
      return { role: m.role, content: transcript };
    }
    const durationLabel = formatDurationLabel(attachment.duration);
    const textBlock =
      `[Nota de voz adjunta: ${attachment.filename} (${durationLabel}) — no se pudo transcribir ` +
      `automáticamente. Pídele amablemente al usuario que resuma su mensaje por texto, o indícale ` +
      `que un asesor podrá escucharla si es necesario.]`;
    return { role: m.role, content: textBlock };
  }

  if (attachment.kind === "video") {
    // Solo contexto textual — Claude no reproduce el video, pero conviene que
    // sepa que ya se lo compartió (p. ej. por si el usuario pregunta de nuevo).
    return { role: m.role, content: `[Video enviado: ${attachment.title}]\n${m.content}` };
  }

  return { role: m.role, content: m.content };
}

// ---------------------------------------------------------------------------
// Rutas — Chatbot
// ---------------------------------------------------------------------------

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", company: COMPANY_NAME, assistant: ASSISTANT_NAME, model: CLAUDE_MODEL });
});

// Caché en memoria: mismo texto de saludo -> mismo audio ya generado (evita volver a
// generarlo en cada carga del widget). Se pierde si el servidor se reinicia — no pasa
// nada, se regenera una sola vez la próxima vez que alguien abra el chat.
const greetingAudioCache = new Map();

/**
 * POST /api/greeting-audio
 * Genera (o sirve desde caché) el audio del mensaje de bienvenida del widget — la
 * regla de "Lucy responde con audio en el saludo, siempre". El texto lo aporta el
 * propio cliente (`CONFIG.greeting`) porque el saludo se define en el widget, no en
 * el servidor; se recorta a un tamaño razonable para evitar abusar de la API de TTS.
 */
app.post("/api/greeting-audio", uploadLimiter, async (req, res) => {
  const text = String((req.body && req.body.text) || "")
    .trim()
    .slice(0, 600);
  if (!text) {
    return res.status(400).json({ available: false, error: "Falta el texto del saludo." });
  }
  if (!TTS_AVAILABLE) {
    return res.json({ available: false });
  }

  const cacheKey = crypto.createHash("sha256").update(text).digest("hex");
  const cached = greetingAudioCache.get(cacheKey);
  if (cached) {
    return res.json({ available: true, ...cached });
  }

  try {
    const audioEntry = await synthesizeAndSaveAudio(text, "greeting-shared");
    if (!audioEntry) {
      return res.json({ available: false });
    }
    const payload = {
      fileId: audioEntry.fileId,
      url: `/uploads/${audioEntry.fileId}`,
      duration: audioEntry.duration,
      transcript: audioEntry.transcript,
      provider: audioEntry.ttsProvider,
    };
    greetingAudioCache.set(cacheKey, payload);
    res.json({ available: true, ...payload });
  } catch (err) {
    console.error("Error al generar el audio del saludo:", err);
    res.json({ available: false });
  }
});

// ---------------------------------------------------------------------------
// Rutas — Adjuntos (fotos de siniestros/vehículos, documentos)
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(), // se valida (firma de bytes) antes de escribir a disco
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    // El navegador puede declarar el audio grabado con parámetros de códec, p. ej.
    // "audio/webm;codecs=opus" — se compara solo la parte base contra la lista permitida.
    // (La validación real, por firma de bytes, ocurre después en saveUploadedFile.)
    const baseMime = String(file.mimetype || "").split(";")[0].trim();
    if (!ALLOWED_UPLOAD_MIMES[baseMime]) {
      cb(new Error("Tipo de archivo no permitido. Solo se aceptan JPG, PNG, PDF y notas de voz."));
      return;
    }
    cb(null, true);
  },
});

/** Envuelve multer para responder con un JSON de error consistente en vez de reventar. */
function uploadSingle(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `El archivo supera el límite de ${Math.round(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB.`,
      });
    }
    return res.status(400).json({ error: err.message || "No se pudo procesar el archivo." });
  });
}

/**
 * POST /api/upload
 * Multipart: campo "file" (JPG/PNG/PDF o nota de voz en audio, máx. ${MAX_UPLOAD_SIZE_BYTES}
 * bytes) + "sessionId" + "duration" (opcional, segundos — solo para notas de voz).
 * Guarda el archivo en /uploads con un nombre aleatorio (fileId) y, si es un PDF,
 * extrae su texto con pdf-parse. Devuelve la referencia (fileId) que el widget debe
 * adjuntar al siguiente mensaje enviado a /api/chat.
 */
app.post("/api/upload", uploadLimiter, uploadSingle, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No se recibió ningún archivo." });
  }

  const sessionId = sanitizeSessionId(req.body && req.body.sessionId);
  const duration = req.body && req.body.duration;

  try {
    const entry = await saveUploadedFile(req.file.buffer, req.file.originalname, sessionId, { duration });
    res.json({
      fileId: entry.fileId,
      kind: entry.kind,
      mimetype: entry.mimetype,
      filename: entry.originalName,
      size: entry.size,
      url: `/uploads/${entry.fileId}`,
      duration: entry.duration,
      transcript: entry.kind === "audio" ? entry.transcript || null : undefined,
      extractedTextPreview: entry.kind === "pdf" ? (entry.extractedText || "").slice(0, 220) : undefined,
    });
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Error al guardar el archivo adjunto:", err);
    res.status(500).json({ error: "No se pudo guardar el archivo. Intenta de nuevo." });
  }
});

/**
 * GET /uploads/:fileId
 * Sirve un archivo adjunto previamente subido (thumbnail de imagen en el chat,
 * vista del documento en el panel de administración). El fileId es un UUID
 * impredecible — no hay listado de directorio ni acceso por nombre original.
 */
app.get("/uploads/:fileId", (req, res) => {
  const { fileId } = req.params;
  if (!FILE_ID_RE.test(fileId)) {
    return res.status(400).end();
  }

  const entry = uploadsIndexCache[fileId];
  if (!entry) {
    return res.status(404).end();
  }

  // `relPath` existe para archivos guardados desde que se agregaron las notas de voz
  // (que viven en el subdirectorio audio/); los archivos guardados antes no lo tienen
  // y siguen resolviéndose igual que siempre, en la raíz de UPLOADS_DIR.
  const filePath = path.join(UPLOADS_DIR, entry.relPath || `${entry.fileId}.${entry.ext}`);
  res.setHeader("Content-Type", entry.mimetype);
  res.setHeader("Content-Disposition", `inline; filename="${entry.originalName}"`);
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).end();
    }
  });
});

/**
 * GET /api/chat/live?sessionId=X
 * Modo supervisor: conexión SSE persistente del propio widget web (se abre una sola
 * vez, al cargar el chat, y se mantiene mientras el usuario tenga la página abierta —
 * a diferencia de POST /api/chat, que es una petición corta por cada mensaje). Es lo
 * que le permite al widget recibir un mensaje del SERVIDOR sin que el usuario haya
 * escrito nada — "shadow messaging" desde /admin (ver POST /api/admin/conversations/:id/message)
 * — algo que el modelo normal de petición/respuesta no permite. Pública (sin
 * autenticación): el propio sessionId, impredecible, cumple ese rol — mismo criterio
 * de confianza que el resto del chat web anónimo.
 */
app.get("/api/chat/live", (req, res) => {
  const sessionId = sanitizeSessionId(req.query.sessionId);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  registerStream(conversationEventStreams, sessionId, res);
  sendSse(res, "connected", { sessionId });

  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch (_err) {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unregisterStream(conversationEventStreams, sessionId, res);
  });
});

/**
 * POST /api/chat
 * Body: { messages: [{ role: "user" | "assistant", content: string }, ...], sessionId?: string }
 * Responde con un stream SSE de eventos:
 *  - "meta"  { sessionId }   identificador de la conversación (para el panel de administración)
 *  - "delta" { text }        fragmento de texto generado
 *  - "done"  { }             fin de la respuesta
 *  - "error" { message }     error durante la generación
 */
app.post("/api/chat", chatLimiter, async (req, res) => {
  const { messages: rawMessages, sessionId: rawSessionId } = req.body || {};
  const { messages, error } = sanitizeMessages(rawMessages);

  if (error) {
    return res.status(400).json({ error });
  }

  const sessionId = sanitizeSessionId(rawSessionId);
  // Resuelve los adjuntos (fileId -> metadatos reales, solo si pertenecen a esta
  // sesión) antes de persistir y antes de armar el payload para Claude.
  const resolvedMessages = resolveAttachments(messages, sessionId);

  // ¿Debería Lucy responder también con audio en este turno? Reglas: (1) el usuario
  // envió una nota de voz -> se le responde en el mismo formato; (2) el texto (o la
  // transcripción, si vino por voz) contiene un pedido explícito de audio o una
  // despedida — ver shouldReplyWithAudio(); (3) el cliente identificado tiene
  // preferenciaAudio activada (se agrega más abajo, una vez resuelto el cliente).
  const lastMsg = resolvedMessages[resolvedMessages.length - 1];
  const lastUserHadAudio = Boolean(
    lastMsg && lastMsg.role === "user" && lastMsg.attachment && lastMsg.attachment.kind === "audio"
  );
  const lastUserEffectiveText =
    (lastUserHadAudio ? lastMsg.attachment.transcript : lastMsg && lastMsg.role === "user" ? lastMsg.content : "") ||
    "";
  let isAudioReply = TTS_AVAILABLE && (lastUserHadAudio || shouldReplyWithAudio(lastUserEffectiveText));

  // ¿La pregunta del usuario coincide con algún video del catálogo? (ver VIDEO_CATALOG)
  const matchedVideo = detectVideoIntent(lastUserEffectiveText);
  // ¿Y con alguna imagen/infografía del catálogo? (ver MEDIA_CATALOG) — puede coincidir
  // con un video Y una imagen a la vez (p. ej. las coberturas del HCM tienen ambos).
  const matchedMedia = detectMediaIntent(lastUserEffectiveText);

  const now = new Date().toISOString();
  const record = conversationsCache[sessionId] || { id: sessionId, startedAt: now };
  record.updatedAt = now;
  record.messages = resolvedMessages; // snapshot completo del historial enviado por el cliente
  conversationsCache[sessionId] = record;

  // Modo supervisor: si hay un panel /admin viendo esta conversación EN VIVO, se le
  // avisa del mensaje del usuario apenas llega (ver notifyAdminWatchers).
  if (lastMsg && lastMsg.role === "user") notifyAdminWatchers(sessionId, lastMsg);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // evita buffering en proxies tipo nginx
  });

  // Si el cliente cierra la conexión, dejamos de escribir.
  let clientClosed = false;
  req.on("close", () => {
    clientClosed = true;
  });

  sendSse(res, "meta", { sessionId });

  // --- Modo supervisor: si un supervisor tomó control total de esta conversación
  // desde /admin, no se llama a Claude ni a ningún flujo automático — el usuario recibe
  // un mensaje corto de espera y el supervisor le responde manualmente (ver
  // POST /api/admin/conversations/:id/message, que sí llega al usuario en vivo por el
  // stream que abre el widget — ver GET /api/chat/live).
  if (record.controladoPorHumano) {
    const holdingText = "Un asesor está revisando tu conversación — te responderá en breve. 🙂";
    const holdingEntry = { role: "assistant", content: holdingText, time: new Date().toISOString() };
    record.messages = [...record.messages, holdingEntry];
    touchConversationRecord(record);
    notifyAdminWatchers(sessionId, holdingEntry);
    if (!clientClosed) {
      sendSse(res, "delta", { text: holdingText });
      sendSse(res, "done", {});
      res.end();
    }
    return;
  }

  // --- Apertura/seguimiento de un siniestro (ver handleSiniestroFlowGate) ---
  // Tiene prioridad sobre la identificación genérica de abajo — incluso como primer
  // mensaje de la conversación — porque el pedido original exige una respuesta empática
  // inmediata ante un accidente/robo/etc., antes de pedir cualquier otro dato.
  const siniestroGate = await handleSiniestroFlowGate(record, lastUserEffectiveText, { canalPreferido: "web" });
  if (siniestroGate.handled) {
    touchConversationRecord(record);
    notifyAdminWatchers(sessionId, { role: "assistant", content: siniestroGate.replyText, time: new Date().toISOString() });
    if (!clientClosed) {
      sendSse(res, "delta", { text: siniestroGate.replyText });
      if (siniestroGate.requestLocation) sendSse(res, "location_request", {});
      sendSse(res, "done", {});
      res.end();
    }
    return;
  }

  // --- Identificación del cliente (memoria persistente por cédula/póliza) ---
  // Un paso guionado, determinista, ANTES de involucrar a Claude — mismo criterio que
  // el resto de flujos guionados del proyecto (menú de WhatsApp, bienvenida).
  const idGate = await handleClientIdentificationGate(record, lastUserEffectiveText, { canalPreferido: "web" });
  if (idGate.handled) {
    touchConversationRecord(record);
    notifyAdminWatchers(sessionId, { role: "assistant", content: idGate.replyText, time: new Date().toISOString() });
    if (!clientClosed) {
      sendSse(res, "delta", { text: idGate.replyText });
      sendSse(res, "done", {});
      res.end();
    }
    return;
  }

  // --- Respuesta a la pregunta de valoración de calidad (ver RATING_ASK_TEXT) ---
  // Determinista: si no se pudo interpretar como un número 1-5, handled queda en
  // false y el mensaje sigue su curso normal (el usuario pudo simplemente seguir
  // hablando de otra cosa en vez de responder la valoración).
  const ratingGate = handleRatingGate(record, lastUserEffectiveText);
  if (ratingGate.handled) {
    touchConversationRecord(record);
    notifyAdminWatchers(sessionId, { role: "assistant", content: ratingGate.replyText, time: new Date().toISOString() });
    if (!clientClosed) {
      sendSse(res, "delta", { text: ratingGate.replyText });
      sendSse(res, "done", {});
      res.end();
    }
    return;
  }

  // --- Aprendizaje de preguntas frecuentes: si el mensaje indica que la respuesta
  // anterior de Lucy no sirvió (o pide un asesor), se registra como gap de
  // conocimiento ANTES de generar la respuesta de este turno (usa el par
  // pregunta/respuesta ya presente en el historial) — ver "❓ Preguntas sin
  // respuesta" en /admin. Nunca bloquea ni cambia la respuesta normal de Claude.
  if (detectsDissatisfaction(lastUserEffectiveText) || ADVISOR_KEYWORDS.some((kw) => normalizeText(lastUserEffectiveText).includes(kw))) {
    await registrarGapConocimiento(record, lastUserEffectiveText);
  }

  const cliente = record.clienteId ? getClienteByCedula(record.clienteId) : null;
  // Datos reales de pólizas (services/polizas.service.js) para que Lucy responda
  // vencimientos/coberturas/prima/suma asegurada/corredor sin inventar nada.
  const clientPolizas = cliente ? await polizasService.buscarPorCedula(cliente.cedula) : [];
  // Datos reales de siniestros (services/siniestros.service.js) — igual criterio: nunca
  // inventar estados, montos ni fechas de un siniestro (ver buildSiniestrosContextAddendum).
  const clientSiniestros = cliente ? await siniestrosService.listarPorCedula(cliente.cedula) : [];

  // PASO 4 del flujo de siniestros: si el usuario acaba de adjuntar una foto/PDF y
  // tiene un siniestro con documentos pendientes, se marca el primero de la lista como
  // recibido automáticamente (no hay clasificación real del documento — es una
  // heurística determinista: "el próximo documento pendiente de la lista", ver nota en
  // el README) y se le avisa a Claude para que lo confirme de forma natural.
  let siniestroDocNote = "";
  const lastUserHadDocument = Boolean(
    lastMsg && lastMsg.role === "user" && lastMsg.attachment && (lastMsg.attachment.kind === "image" || lastMsg.attachment.kind === "pdf")
  );
  if (lastUserHadDocument && cliente) {
    const abierto = clientSiniestros.find((s) => Array.isArray(s.documentos_pendientes) && s.documentos_pendientes.length > 0);
    if (abierto) {
      try {
        const actualizado = await siniestrosService.actualizarDocumentos(abierto.numero, {
          documentoRecibido: abierto.documentos_pendientes[0],
        });
        if (actualizado) {
          siniestroDocNote =
            `\n\n## Documento recién recibido\nEl usuario acaba de enviar un documento adjunto en este mismo ` +
            `mensaje para su siniestro ${abierto.numero} — ya se registró como recibido ` +
            `"${SINIESTRO_DOC_LABELS[abierto.documentos_pendientes[0]] || abierto.documentos_pendientes[0]}". ` +
            (actualizado.documentos_pendientes.length
              ? `Aún faltan: ${labelDocumentos(actualizado.documentos_pendientes)}. `
              : "Ya no falta ningún documento por ese siniestro. ") +
            "Agradécele el envío de forma natural, sin pedirle que lo reenvíe.";
        }
      } catch (err) {
        console.warn("[aviso] No se pudo registrar el documento recibido para el siniestro:", err.message);
      }
    }
  }

  // Clasificador de intención/emoción (ver classifyIntentAndEmotion) — una llamada
  // rápida y aparte antes de la respuesta real, para ajustar tono/contexto sin
  // reemplazar los flujos deterministas ya resueltos arriba.
  const { intencion, emocion } = await classifyIntentAndEmotion(lastUserEffectiveText);
  record.ultimaIntencion = intencion;
  record.ultimaEmocion = emocion;
  if (emocion === "molesto") record.escalado = true;

  // ¿Corresponde preguntar la valoración de calidad al cierre? (ver RATING_ASK_TEXT) —
  // solo si todavía no se le preguntó/respondió en esta conversación.
  const shouldAskRating =
    !record.ratingState && isSatisfactionSignal(lastUserEffectiveText, emocion);

  const clientContextAddendum =
    buildClientContextAddendum(cliente, clientPolizas) +
    buildSiniestrosContextAddendum(clientSiniestros) +
    siniestroDocNote +
    (INTENT_GUIDANCE[intencion] || "") +
    (EMOTION_GUIDANCE[emocion] || "");
  isAudioReply = isAudioReply || Boolean(TTS_AVAILABLE && cliente && cliente.preferenciaAudio);

  try {
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT + clientContextAddendum,
      output_config: { effort: "medium" },
      messages: await buildAnthropicMessages(resolvedMessages),
    });

    stream.on("text", (textDelta) => {
      if (!clientClosed) {
        sendSse(res, "delta", { text: textDelta });
      }
    });

    const finalMessage = await stream.finalMessage();

    if (finalMessage.stop_reason === "refusal") {
      if (!clientClosed) {
        sendSse(res, "error", {
          message:
            "No puedo responder a esa solicitud. ¿Podemos continuar con tu consulta sobre seguros?",
        });
      }
    } else {
      const assistantText = extractText(finalMessage);
      let assistantMsgEntry = null;
      if (assistantText) {
        assistantMsgEntry = { role: "assistant", content: assistantText, time: new Date().toISOString() };

        // La imagen/infografía va en el MISMO mensaje que el texto (campo `media`,
        // aparte de `attachment` — así puede convivir con el audio de la respuesta,
        // que si aplica se agrega más abajo en `attachment`).
        if (matchedMedia) {
          const mediaAttachment = resolveMediaAttachment(matchedMedia);
          if (mediaAttachment) {
            assistantMsgEntry.media = mediaAttachment;
            if (!clientClosed) {
              sendSse(res, "media", {
                mediaKey: mediaAttachment.mediaKey,
                title: mediaAttachment.title,
                url: mediaAttachment.url,
              });
            }
          }
          if (record.clienteId) recordClientTopic(record.clienteId, TOPIC_TAG_BY_MEDIA_KEY[matchedMedia.key]);
        }

        record.messages = [...record.messages, assistantMsgEntry];
      }

      if (assistantText && isAudioReply && !clientClosed) {
        sendSse(res, "audio-pending", {});
        try {
          const audioEntry = await synthesizeAndSaveAudio(assistantText, sessionId);
          if (audioEntry) {
            // Se adjunta al mismo mensaje que ya se guardó en el historial — así el
            // audio persiste igual que cualquier otro adjunto (recarga de página,
            // panel /admin) sin necesidad de un mensaje aparte. Se resuelve inline (en
            // vez de solo guardar el fileId) porque este mensaje ya no pasará de nuevo
            // por resolveAttachments() en esta petición.
            assistantMsgEntry.attachment = attachmentRefFromEntry(audioEntry);
            if (!clientClosed) {
              sendSse(res, "audio", {
                fileId: audioEntry.fileId,
                url: `/uploads/${audioEntry.fileId}`,
                duration: audioEntry.duration,
                transcript: audioEntry.transcript,
                provider: audioEntry.ttsProvider,
              });
            }
          } else if (!clientClosed) {
            sendSse(res, "audio-error", { message: "No se pudo generar el audio de la respuesta." });
          }
        } catch (err) {
          console.error("Error al generar el audio de la respuesta:", err);
          if (!clientClosed) {
            sendSse(res, "audio-error", { message: "No se pudo generar el audio de la respuesta." });
          }
        }
      }

      if (assistantText && matchedVideo && !clientClosed) {
        const videoAttachment = resolveVideoAttachment(matchedVideo);
        if (videoAttachment) {
          const caption = "Te envío este video explicativo 👇";
          // Mensaje aparte del texto de Claude — mismo patrón que el "🎤 Escuché" de
          // WhatsApp: un mensaje guionado, no generado por el modelo.
          const videoMsgEntry = { role: "assistant", content: caption, time: new Date().toISOString(), attachment: videoAttachment };
          record.messages = [...record.messages, videoMsgEntry];
          if (!clientClosed) {
            sendSse(res, "video", {
              caption,
              title: videoAttachment.title,
              videoKey: videoAttachment.videoKey,
              url: videoAttachment.url,
              posterUrl: videoAttachment.posterUrl,
            });
          }
          if (record.clienteId) recordClientTopic(record.clienteId, TOPIC_TAG_BY_VIDEO_KEY[matchedVideo.key]);
        }
      }

      // Valoración de calidad: se agrega al final de la MISMA respuesta (no un mensaje
      // aparte) — ver shouldAskRating más arriba. record.ratingState = "asked" hace que
      // el próximo mensaje del usuario pase por handleRatingGate en vez del flujo normal.
      if (assistantText && shouldAskRating && !clientClosed) {
        const ratingSuffix = `\n\n${RATING_ASK_TEXT}`;
        sendSse(res, "delta", { text: ratingSuffix });
        assistantMsgEntry.content += ratingSuffix;
        record.ratingState = "asked";
      }

      if (!clientClosed) {
        sendSse(res, "done", {});
      }
      if (assistantMsgEntry) notifyAdminWatchers(sessionId, assistantMsgEntry);
    }

    touchConversationRecord(record);
    if (!clientClosed) res.end();
  } catch (err) {
    console.error("Error al llamar a la API de Anthropic:", err);

    let message = "Ocurrió un error al procesar tu mensaje. Intenta de nuevo en unos segundos.";

    if (err instanceof Anthropic.AuthenticationError) {
      message = "Error de configuración del servidor (autenticación con la API de Claude).";
    } else if (err instanceof Anthropic.RateLimitError) {
      message = "El asistente está muy solicitado en este momento. Intenta de nuevo en breve.";
    } else if (err instanceof Anthropic.BadRequestError) {
      message = "No se pudo procesar la solicitud. Intenta reformular tu mensaje.";
    } else if (err instanceof Anthropic.APIError) {
      message = "El servicio de IA no está disponible en este momento.";
    }

    touchConversationRecord(record);

    if (!clientClosed) {
      sendSse(res, "error", { message });
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// WhatsApp Business (vía Twilio) — ver WHATSAPP_SETUP.md
// ---------------------------------------------------------------------------
//
// Twilio le pega a POST /webhook/whatsapp por cada mensaje entrante. Respondemos
// de inmediato con un TwiML vacío (para no bloquear a Twilio mientras Claude
// piensa — su webhook tiene un límite de tiempo corto) y procesamos el mensaje de
// forma asíncrona, enviando la respuesta real como un mensaje saliente aparte a
// través de la API REST de Twilio.

const WHATSAPP_MENU_TRIGGERS = ["menu", "menú", "hola", "hello", "hi", "buenas", "inicio", "start"];

const WHATSAPP_MENU_OPTIONS = {
  1: "Quiero cotizar un seguro.",
  2: "Quiero reportar un siniestro.",
  3: "Quiero consultar información de mi póliza.",
  4: "Quiero hablar con un asesor humano.",
};

function buildWhatsappMenuText() {
  return (
    "¿En qué puedo ayudarte hoy? Responde con el número de la opción:\n\n" +
    "1️⃣ Cotizar seguro\n" +
    "2️⃣ Reportar siniestro\n" +
    "3️⃣ Consultar póliza\n" +
    "4️⃣ Hablar con asesor\n\n" +
    "También puedes escribirme tu consulta directamente."
  );
}

function buildWhatsappWelcomeText() {
  return (
    `¡Hola! 👋 Soy ${ASSISTANT_NAME}, la asistente virtual de ${COMPANY_NAME}. ` +
    "Estoy aquí para ayudarte con cotizaciones, información de coberturas y reportes de siniestros.\n\n" +
    buildWhatsappMenuText()
  );
}

function isWhatsappMenuTrigger(text) {
  return WHATSAPP_MENU_TRIGGERS.includes(normalizeText(text).trim());
}

/** "whatsapp:+58412xxxxxxx" -> "+58412xxxxxxx" (clave del registro), o null si no es un E.164 válido. */
function sanitizeWhatsappPhoneKey(fromField) {
  if (typeof fromField !== "string") return null;
  const stripped = fromField.replace(/^whatsapp:/i, "").trim();
  return /^\+[1-9]\d{6,14}$/.test(stripped) ? stripped : null;
}

/** Descarga un archivo multimedia de WhatsApp desde la URL temporal de Twilio (requiere Basic Auth). */
async function downloadTwilioMedia(mediaUrl) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const response = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!response.ok) {
    throw new Error(`No se pudo descargar el adjunto de Twilio (HTTP ${response.status}).`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Envía un mensaje de WhatsApp saliente a través de la API REST de Twilio. */
async function sendWhatsappMessage(to, body) {
  if (!twilioClient || !body) return;
  try {
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to, body });
  } catch (err) {
    console.error("Error al enviar un mensaje de WhatsApp:", err.message);
  }
}

// Twilio permite hasta 1600 caracteres por mensaje de WhatsApp; se deja margen.
const WHATSAPP_MAX_CHARS = 1500;

function splitTextIntoChunks(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.4) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.4) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Envía una respuesta larga como varios mensajes de WhatsApp consecutivos, en orden. */
async function sendWhatsappMessageChunked(to, text) {
  for (const chunk of splitTextIntoChunks(text, WHATSAPP_MAX_CHARS)) {
    await sendWhatsappMessage(to, chunk);
  }
}

/** Verifica que la petición realmente venga de Twilio (firma HMAC del Auth Token). */
function validateTwilioSignature(req) {
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;
  const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const url = base + req.originalUrl;
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body || {});
}

/**
 * POST /webhook/whatsapp
 * Configúralo como el webhook de mensajes entrantes en la consola de Twilio
 * (Sandbox de WhatsApp, o el número de WhatsApp Business en producción).
 */
app.post(
  "/webhook/whatsapp",
  express.urlencoded({ extended: false }),
  whatsappLimiter,
  (req, res) => {
    if (!TWILIO_CONFIGURED) {
      res.status(503).type("text/xml").send(new twilio.twiml.MessagingResponse().toString());
      return;
    }

    if (!validateTwilioSignature(req)) {
      console.warn("[aviso] Webhook de WhatsApp: firma de Twilio inválida — solicitud rechazada.");
      res.status(403).end();
      return;
    }

    // Se responde de inmediato (TwiML vacío) para no bloquear a Twilio mientras
    // Claude procesa — la respuesta real se envía por separado vía la API REST.
    res.type("text/xml").send(new twilio.twiml.MessagingResponse().toString());

    // Necesaria para armar la URL pública del audio de Lucy que Twilio debe descargar
    // al enviarlo como nota de voz (ver sendLucyVoiceNoteToWhatsapp) — mismo criterio
    // que validateTwilioSignature para deducir el origen de este servidor.
    const baseUrl = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;

    handleIncomingWhatsappMessage(req.body, baseUrl).catch((err) => {
      console.error("Error procesando un mensaje entrante de WhatsApp:", err);
    });
  }
);

async function handleIncomingWhatsappMessage(body, baseUrl) {
  const from = typeof body.From === "string" ? body.From : "";
  const phoneKey = sanitizeWhatsappPhoneKey(from);
  if (!phoneKey) {
    console.warn("[aviso] Webhook de WhatsApp: número de remitente inválido, se ignora el mensaje.");
    return;
  }

  const rawText = typeof body.Body === "string" ? body.Body.trim() : "";
  const numMedia = Number(body.NumMedia) || 0;

  const now = new Date().toISOString();
  const isFirstContact = !conversationsCache[phoneKey];
  const record = conversationsCache[phoneKey] || { id: phoneKey, startedAt: now };
  record.channel = "whatsapp";
  record.phone = from;
  record.messages = record.messages || [];
  record.updatedAt = now;

  // Adjunto (foto, documento o nota de voz), si Twilio envió alguno con este mensaje.
  // No se filtra por MediaContentType0 antes de descargar: el mismo saveUploadedFile()
  // valida el tipo real por la firma de bytes del archivo (más confiable que confiar en
  // el Content-Type que declara Twilio), y ahí ya cubre audio/ogg y audio/mpeg (notas de
  // voz de WhatsApp) igual que las imágenes y PDFs.
  let attachmentEntry = null;
  if (numMedia > 0 && typeof body.MediaUrl0 === "string") {
    try {
      const buffer = await downloadTwilioMedia(body.MediaUrl0);
      attachmentEntry = await saveUploadedFile(buffer, "whatsapp-media", phoneKey);
    } catch (err) {
      console.error("[aviso] No se pudo procesar un adjunto de WhatsApp:", err.message);
    }
  }

  // Nota de voz que Whisper no pudo transcribir (o sin OPENAI_API_KEY configurada):
  // se le avisa al usuario de inmediato, sin llamar a Claude con un adjunto ilegible.
  if (attachmentEntry && attachmentEntry.kind === "audio" && !attachmentEntry.transcript) {
    const sorryMsg = "No pude entender el audio. ¿Podrías escribirlo?";
    record.messages.push({
      role: "user",
      content: defaultCaptionForAttachment(attachmentEntry),
      time: new Date().toISOString(),
      attachment: { fileId: attachmentEntry.fileId },
    });
    record.messages.push({ role: "assistant", content: sorryMsg, time: new Date().toISOString() });
    await sendWhatsappMessage(from, sorryMsg);
    conversationsCache[phoneKey] = record;
    touchConversationRecord(record);
    return;
  }

  // Ubicación compartida nativamente por WhatsApp (Twilio la entrega como Latitude/
  // Longitude en el propio webhook, sin adjunto) — se usa como texto del mensaje si no
  // vino nada más, para que el flujo de siniestros (paso "ubicación") la reciba igual
  // que si el usuario la hubiera escrito. Ver también CONFIG del botón 📍 en el widget
  // web (chatbot.js), que logra lo mismo enviando un enlace de Google Maps como texto.
  const latitude = typeof body.Latitude === "string" ? body.Latitude : "";
  const longitude = typeof body.Longitude === "string" ? body.Longitude : "";
  const locationText = latitude && longitude ? `📍 Ubicación compartida: https://www.google.com/maps?q=${latitude},${longitude}` : "";

  const isVoiceNote = Boolean(attachmentEntry && attachmentEntry.kind === "audio" && attachmentEntry.transcript);
  const userText =
    rawText ||
    locationText ||
    (isVoiceNote ? attachmentEntry.transcript : attachmentEntry ? defaultCaptionForAttachment(attachmentEntry) : "");
  if (!userText) {
    // P. ej. un sticker no compatible, sin texto — no hay nada que procesar.
    conversationsCache[phoneKey] = record;
    persistConversations();
    return;
  }

  const userMessage = { role: "user", content: userText.slice(0, MAX_MESSAGE_LENGTH), time: new Date().toISOString() };
  if (attachmentEntry) userMessage.attachment = { fileId: attachmentEntry.fileId };
  record.messages.push(userMessage);
  notifyAdminWatchers(phoneKey, userMessage);

  // Modo supervisor: si un supervisor tomó control total de esta conversación desde
  // /admin, no se ejecuta ningún flujo automático (ni bienvenida, ni menú, ni Claude)
  // — se le avisa al supervisor y se responde con un mensaje corto de espera, igual
  // criterio que /api/chat (ver ahí el comentario completo).
  if (record.controladoPorHumano) {
    const holdingText = "Un asesor está revisando tu conversación — te responderá en breve. 🙂";
    const holdingEntry = { role: "assistant", content: holdingText, time: new Date().toISOString() };
    record.messages.push(holdingEntry);
    await sendWhatsappMessage(from, holdingText);
    conversationsCache[phoneKey] = record;
    touchConversationRecord(record);
    notifyAdminWatchers(phoneKey, holdingEntry);
    return;
  }

  // Apertura/seguimiento de un siniestro (ver handleSiniestroFlowGate) — tiene
  // prioridad incluso sobre la bienvenida de primer contacto y el menú de abajo: el
  // pedido original exige una respuesta empática inmediata ante un accidente/robo/etc.,
  // incluso si es el PRIMER mensaje que esta persona le escribe a Lucy — antes se
  // revisaba después de la bienvenida/menú, lo que en la práctica le mandaba un "¡Hola,
  // bienvenido! aquí tienes un menú" a alguien que acababa de decir "tuve un accidente".
  // También intercepta cualquier mensaje ("hola" incluido) mientras haya un flujo de
  // siniestro YA en curso (record.siniestroFlow), antes de que el disparador de menú de
  // abajo pueda derailarlo.
  const siniestroGate = await handleSiniestroFlowGate(record, userText, { canalPreferido: "whatsapp", telefono: from });
  if (siniestroGate.handled) {
    await sendWhatsappMessage(from, siniestroGate.replyText);
    const siniestroMsgEntry = { role: "assistant", content: siniestroGate.replyText, time: new Date().toISOString() };
    record.messages.push(siniestroMsgEntry);
    conversationsCache[phoneKey] = record;
    touchConversationRecord(record);
    notifyAdminWatchers(phoneKey, siniestroMsgEntry);
    return;
  }

  // Primer contacto: bienvenida + menú, siempre — sin llamar a Claude todavía.
  if (isFirstContact) {
    // Imagen de bienvenida, ANTES del texto (mismo criterio que el resto de imágenes
    // por WhatsApp) — "siempre", igual que el audio de bienvenida más abajo.
    const welcomeMedia = MEDIA_CATALOG.find((m) => m.key === "bienvenida");
    let welcomeMediaAttachment = null;
    if (welcomeMedia) {
      try {
        const welcomeMediaUrl = await resolveWhatsappMediaUrl(welcomeMedia, baseUrl);
        if (welcomeMediaUrl) {
          await sendWhatsappMedia(from, welcomeMediaUrl);
          welcomeMediaAttachment = resolveMediaAttachment(welcomeMedia);
        }
      } catch (err) {
        console.warn("[aviso] No se pudo enviar la imagen de bienvenida por WhatsApp:", err.message);
      }
    }

    const welcome = buildWhatsappWelcomeText();
    await sendWhatsappMessage(from, welcome);
    const welcomeMsgEntry = { role: "assistant", content: welcome, time: new Date().toISOString() };
    if (welcomeMediaAttachment) welcomeMsgEntry.media = welcomeMediaAttachment;
    record.messages.push(welcomeMsgEntry);
    // Regla "Lucy responde con audio en la bienvenida, siempre" — no bloquea el envío
    // del texto (ya se envió arriba) ni la respuesta al webhook si falla.
    if (TTS_AVAILABLE) {
      try {
        const audioEntry = await sendLucyVoiceNoteToWhatsapp(welcome, from, phoneKey, baseUrl);
        if (audioEntry) welcomeMsgEntry.attachment = attachmentRefFromEntry(audioEntry);
      } catch (err) {
        console.warn("[aviso] No se pudo enviar el audio de bienvenida por WhatsApp:", err.message);
      }
    }
    conversationsCache[phoneKey] = record;
    touchConversationRecord(record);
    notifyAdminWatchers(phoneKey, welcomeMsgEntry);
    return;
  }

  // Disparador explícito de menú ("menú", "hola", etc.) — respuesta determinista. Se
  // ignora mientras haya un flujo guionado esperando una respuesta puntual
  // (identificación en curso, o la pregunta de valoración recién hecha) — de lo
  // contrario un simple "hola" de cortesía a mitad de esos flujos los derailaría, en
  // vez de tratarse como la respuesta que ese flujo está esperando.
  const enFlujoGuionadoActivo =
    record.identificationState === "asked" ||
    record.identificationState === "asking-name" ||
    record.identificationState === "asking-email" ||
    record.identificationState === "otp-pending" ||
    record.ratingState === "asked";
  if (isWhatsappMenuTrigger(userText) && !enFlujoGuionadoActivo) {
    const menu = buildWhatsappMenuText();
    await sendWhatsappMessage(from, menu);
    const menuMsgEntry = { role: "assistant", content: menu, time: new Date().toISOString() };
    record.messages.push(menuMsgEntry);
    conversationsCache[phoneKey] = record;
    touchConversationRecord(record);
    notifyAdminWatchers(phoneKey, menuMsgEntry);
    return;
  }

  // Identificación del cliente (memoria persistente por cédula/póliza) — un paso
  // guionado, determinista, ANTES de involucrar a Claude. El teléfono ya lo tenemos
  // gratis (viene del propio WhatsApp), así que se precarga en el perfil nuevo.
  const idGate = await handleClientIdentificationGate(record, userText, { canalPreferido: "whatsapp", telefono: from });
  if (idGate.handled) {
    await sendWhatsappMessage(from, idGate.replyText);
    const idMsgEntry = { role: "assistant", content: idGate.replyText, time: new Date().toISOString() };
    record.messages.push(idMsgEntry);
    conversationsCache[phoneKey] = record;
    touchConversationRecord(record);
    notifyAdminWatchers(phoneKey, idMsgEntry);
    return;
  }

  // Respuesta a la pregunta de valoración de calidad — mismo criterio que /api/chat.
  const ratingGateWhatsapp = handleRatingGate(record, userText);
  if (ratingGateWhatsapp.handled) {
    await sendWhatsappMessage(from, ratingGateWhatsapp.replyText);
    const ratingMsgEntry = { role: "assistant", content: ratingGateWhatsapp.replyText, time: new Date().toISOString() };
    record.messages.push(ratingMsgEntry);
    conversationsCache[phoneKey] = record;
    touchConversationRecord(record);
    notifyAdminWatchers(phoneKey, ratingMsgEntry);
    return;
  }

  // Aprendizaje de preguntas frecuentes — mismo criterio que /api/chat.
  if (detectsDissatisfaction(userText) || ADVISOR_KEYWORDS.some((kw) => normalizeText(userText).includes(kw))) {
    await registrarGapConocimiento(record, userText);
  }

  const clienteWhatsapp = record.clienteId ? getClienteByCedula(record.clienteId) : null;
  const clienteWhatsappPolizas = clienteWhatsapp ? await polizasService.buscarPorCedula(clienteWhatsapp.cedula) : [];
  const clienteWhatsappSiniestros = clienteWhatsapp ? await siniestrosService.listarPorCedula(clienteWhatsapp.cedula) : [];

  // PASO 4 del flujo de siniestros, canal WhatsApp: mismo criterio que /api/chat (ver
  // ahí el comentario completo sobre la heurística "primer documento pendiente").
  let siniestroDocNoteWhatsapp = "";
  const lastUserHadDocumentWhatsapp = Boolean(attachmentEntry && (attachmentEntry.kind === "image" || attachmentEntry.kind === "pdf"));
  if (lastUserHadDocumentWhatsapp && clienteWhatsapp) {
    const abiertoWhatsapp = clienteWhatsappSiniestros.find(
      (s) => Array.isArray(s.documentos_pendientes) && s.documentos_pendientes.length > 0
    );
    if (abiertoWhatsapp) {
      try {
        const actualizadoWhatsapp = await siniestrosService.actualizarDocumentos(abiertoWhatsapp.numero, {
          documentoRecibido: abiertoWhatsapp.documentos_pendientes[0],
        });
        if (actualizadoWhatsapp) {
          siniestroDocNoteWhatsapp =
            `\n\n## Documento recién recibido\nEl usuario acaba de enviar un documento adjunto en este mismo ` +
            `mensaje para su siniestro ${abiertoWhatsapp.numero} — ya se registró como recibido ` +
            `"${SINIESTRO_DOC_LABELS[abiertoWhatsapp.documentos_pendientes[0]] || abiertoWhatsapp.documentos_pendientes[0]}". ` +
            (actualizadoWhatsapp.documentos_pendientes.length
              ? `Aún faltan: ${labelDocumentos(actualizadoWhatsapp.documentos_pendientes)}. `
              : "Ya no falta ningún documento por ese siniestro. ") +
            "Agradécele el envío de forma natural, sin pedirle que lo reenvíe.";
        }
      } catch (err) {
        console.warn("[aviso] No se pudo registrar el documento recibido para el siniestro (WhatsApp):", err.message);
      }
    }
  }

  // Selección numérica del menú (1-4) -> se traduce a una frase natural para Claude,
  // pero el registro conserva lo que el usuario escribió literalmente ("1").
  const mappedOption = WHATSAPP_MENU_OPTIONS[userText.trim()];
  const messagesForClaude = mappedOption
    ? [...record.messages.slice(0, -1), { ...userMessage, content: mappedOption }]
    : record.messages;

  const resolvedMessages = resolveAttachments(messagesForClaude.slice(-MAX_HISTORY_MESSAGES), phoneKey);

  // Nota de voz transcrita con éxito: se confirma de inmediato lo que Lucy entendió,
  // como un mensaje de WhatsApp aparte — la respuesta real de Lucy llega justo después.
  if (isVoiceNote) {
    const echoMsg = `🎤 Escuché: ${attachmentEntry.transcript}`;
    await sendWhatsappMessage(from, echoMsg);
    record.messages.push({ role: "assistant", content: echoMsg, time: new Date().toISOString() });
  }

  // Clasificador de intención/emoción — mismo criterio que /api/chat.
  const { intencion: intencionWhatsapp, emocion: emocionWhatsapp } = await classifyIntentAndEmotion(userText);
  record.ultimaIntencion = intencionWhatsapp;
  record.ultimaEmocion = emocionWhatsapp;
  if (emocionWhatsapp === "molesto") record.escalado = true;
  const shouldAskRatingWhatsapp = !record.ratingState && isSatisfactionSignal(userText, emocionWhatsapp);

  try {
    const anthropicMessages = await buildAnthropicMessages(resolvedMessages);
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system:
        SYSTEM_PROMPT +
        WHATSAPP_SYSTEM_ADDENDUM +
        buildClientContextAddendum(clienteWhatsapp, clienteWhatsappPolizas) +
        buildSiniestrosContextAddendum(clienteWhatsappSiniestros) +
        siniestroDocNoteWhatsapp +
        (INTENT_GUIDANCE[intencionWhatsapp] || "") +
        (EMOTION_GUIDANCE[emocionWhatsapp] || ""),
      output_config: { effort: "medium" },
      messages: anthropicMessages,
    });

    if (response.stop_reason === "refusal") {
      const declineMsg = "No puedo responder a esa solicitud. ¿Podemos continuar con tu consulta sobre seguros?";
      await sendWhatsappMessage(from, declineMsg);
      record.messages.push({ role: "assistant", content: declineMsg, time: new Date().toISOString() });
    } else {
      let text = extractText(response);
      if (text) {
        // Imagen/infografía del catálogo, ANTES del mensaje de texto (a diferencia del
        // video, que va después de un texto guionado propio) — se manda primero y
        // luego se adjunta al mismo mensaje de respuesta (campo `media`, aparte de
        // `attachment`, que es donde va el audio si también aplica en este turno).
        const matchedMedia = detectMediaIntent(userText);
        let mediaAttachment = null;
        if (matchedMedia) {
          try {
            const mediaUrl = await resolveWhatsappMediaUrl(matchedMedia, baseUrl);
            if (mediaUrl) {
              await sendWhatsappMedia(from, mediaUrl);
              mediaAttachment = resolveMediaAttachment(matchedMedia);
            }
          } catch (err) {
            console.warn("[aviso] No se pudo enviar la imagen por WhatsApp:", err.message);
          }
          if (record.clienteId) recordClientTopic(record.clienteId, TOPIC_TAG_BY_MEDIA_KEY[matchedMedia.key]);
        }

        // Valoración de calidad — mismo criterio que /api/chat: se agrega al final de
        // esta misma respuesta, y record.ratingState = "asked" hace que el próximo
        // mensaje del usuario pase por handleRatingGate.
        if (shouldAskRatingWhatsapp) {
          text += `\n\n${RATING_ASK_TEXT}`;
          record.ratingState = "asked";
        }

        await sendWhatsappMessageChunked(from, text);
        const replyMsgEntry = { role: "assistant", content: text, time: new Date().toISOString() };
        if (mediaAttachment) replyMsgEntry.media = mediaAttachment;
        record.messages.push(replyMsgEntry);

        // Reglas de cuándo Lucy responde también con audio: (1) el usuario envió una
        // nota de voz -> se le responde en el mismo formato; (2) pidió audio explícitamente
        // o se está despidiendo -> shouldReplyWithAudio(); (3) el cliente tiene
        // preferenciaAudio activada. El texto ya se envió de todos modos; el audio es un
        // envío aparte que no bloquea ni reemplaza al de texto.
        if (
          TTS_AVAILABLE &&
          (isVoiceNote || shouldReplyWithAudio(userText) || (clienteWhatsapp && clienteWhatsapp.preferenciaAudio))
        ) {
          try {
            const audioEntry = await sendLucyVoiceNoteToWhatsapp(text, from, phoneKey, baseUrl);
            if (audioEntry) replyMsgEntry.attachment = attachmentRefFromEntry(audioEntry);
          } catch (err) {
            console.warn("[aviso] No se pudo enviar el audio de la respuesta por WhatsApp:", err.message);
          }
        }

        // ¿La pregunta del usuario coincide con algún video del catálogo? Se envía
        // como un mensaje aparte (mismo patrón que el audio, arriba) — texto guionado
        // + el video (o, si pesa demasiado y no se pudo comprimir, un enlace).
        const matchedVideo = detectVideoIntent(userText);
        if (matchedVideo) {
          try {
            const delivery = await resolveWhatsappVideoDelivery(matchedVideo, baseUrl);
            if (delivery) {
              const caption = "Te envío este video explicativo 👇";
              if (delivery.type === "media") {
                await sendWhatsappMessage(from, caption);
                await sendWhatsappMedia(from, delivery.url);
              } else {
                await sendWhatsappMessage(from, `${caption}\n${delivery.url}`);
              }
              const videoAttachment = resolveVideoAttachment(matchedVideo);
              record.messages.push({
                role: "assistant",
                content: caption,
                time: new Date().toISOString(),
                attachment: videoAttachment ? { ...videoAttachment, whatsappDelivery: delivery.type } : undefined,
              });
            }
          } catch (err) {
            console.warn("[aviso] No se pudo enviar el video por WhatsApp:", err.message);
          }
          if (record.clienteId) recordClientTopic(record.clienteId, TOPIC_TAG_BY_VIDEO_KEY[matchedVideo.key]);
        }

        notifyAdminWatchers(phoneKey, replyMsgEntry);
      }
    }
  } catch (err) {
    console.error("Error al llamar a la API de Anthropic (WhatsApp):", err);
    const errorMsg =
      "Ocurrió un error al procesar tu mensaje. Intenta de nuevo en unos minutos, o llama a nuestra línea de siniestros " +
      `${CLAIMS_PHONE} si es urgente.`;
    await sendWhatsappMessage(from, errorMsg);
  }

  conversationsCache[phoneKey] = record;
  touchConversationRecord(record);
}

// ---------------------------------------------------------------------------
// Rutas — Cotizador automático
// ---------------------------------------------------------------------------

/**
 * GET /api/quote-config
 * Configuración pública del cotizador (tarifas RCV, tasas HCM, tipos de bien
 * patrimoniales, textos). No contiene datos sensibles — el widget la necesita
 * para construir los formularios y calcular los estimados en el navegador.
 */
app.get("/api/quote-config", (_req, res) => {
  res.json({ config: quoterConfigCache });
});

/**
 * POST /api/quote
 * Guarda (o actualiza) una cotización generada por el cotizador dentro de la
 * conversación correspondiente en conversations.json. Se llama dos veces por
 * cotización: una al calcular el estimado, y otra si el usuario solicita la
 * póliza formal (mismo quoteId, se agrega el contacto).
 * Body: { sessionId, messages, quoteId, ramo, inputs, result, contact?, formalRequest? }
 */
app.post("/api/quote", quoteLimiter, (req, res) => {
  const sanitized = sanitizeQuotePayload(req.body);
  if (sanitized.error) {
    return res.status(400).json({ error: sanitized.error });
  }

  const { messages: rawMessages } = req.body || {};
  const { messages, error } = sanitizeMessages(rawMessages);
  if (error) {
    return res.status(400).json({ error });
  }

  const { sessionId, quoteId, ramo, inputs, result, contact, formalRequest } = sanitized;
  const now = new Date().toISOString();
  const record = conversationsCache[sessionId] || { id: sessionId, startedAt: now };
  record.messages = resolveAttachments(messages, sessionId);
  record.quotes = record.quotes || {};

  const existingQuote = record.quotes[quoteId];
  record.quotes[quoteId] = {
    id: quoteId,
    ramo,
    inputs: inputs !== undefined ? inputs : existingQuote ? existingQuote.inputs : null,
    result: result !== undefined ? result : existingQuote ? existingQuote.result : null,
    contact: contact || (existingQuote ? existingQuote.contact : null),
    formalRequest: Boolean(formalRequest || (existingQuote && existingQuote.formalRequest)),
    createdAt: existingQuote ? existingQuote.createdAt : now,
    updatedAt: now,
  };

  // Enriquece la memoria persistente del cliente con este ramo de interés — si la
  // solicitud de póliza formal trae cédula (contact), esa es la fuente más confiable
  // (por si el usuario cotiza sin haberse identificado antes en la conversación); si
  // no, se usa la cédula con la que ya se identificó esta conversación, si la hay.
  if (contact && contact.cedula) {
    const normalizedCedula = normalizeCedula(contact.cedula) || contact.cedula.trim().toUpperCase();
    let cliente = getClienteByCedula(normalizedCedula);
    if (!cliente) {
      cliente = createCliente(normalizedCedula, { nombre: contact.nombre, email: contact.correo, canalPreferido: "web" });
    } else {
      touchCliente(normalizedCedula, {
        nombre: cliente.nombre || contact.nombre,
        email: contact.correo || cliente.email,
      });
    }
    if (!record.clienteId) record.clienteId = normalizedCedula;
    recordClientTopic(normalizedCedula, `cotizacion_${ramo}`);
  } else if (record.clienteId) {
    recordClientTopic(record.clienteId, `cotizacion_${ramo}`);
  }

  conversationsCache[sessionId] = record;
  touchConversationRecord(record);

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Rutas — Panel de administración (/admin)
// ---------------------------------------------------------------------------

// La página se sirve siempre (login + dashboard viven en el mismo HTML);
// la autenticación real la protegen los endpoints /api/admin/*.
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      error: "El panel de administración no está configurado (falta ADMIN_PASSWORD en el servidor).",
    });
  }

  const { username, password } = req.body || {};
  const validUser = typeof username === "string" && safeEqual(username, ADMIN_USERNAME);
  const validPass = typeof password === "string" && safeEqual(password, ADMIN_PASSWORD);

  if (!validUser || !validPass) {
    return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
  }

  issueAdminSession(res);
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  clearAdminSession(req, res);
  res.json({ ok: true });
});

app.get("/api/admin/session", (req, res) => {
  res.json({ authenticated: isAdminAuthenticated(req) });
});

/**
 * PUT /api/admin/quote-config
 * Reemplaza la configuración completa del cotizador (tarifas RCV, tasas HCM, tipos
 * de bien patrimoniales, textos y palabras clave de activación). Así los equipos de
 * TI/técnico/comercial pueden editar tarifas y textos desde el panel, sin tocar código.
 */
app.put("/api/admin/quote-config", requireAdmin, (req, res) => {
  const { config } = req.body || {};
  const validationError = validateQuoterConfig(config);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  quoterConfigCache = { ...config, updatedAt: new Date().toISOString() };
  persistQuoterConfig();
  res.json({ ok: true, config: quoterConfigCache });
});

app.get("/api/admin/conversations", requireAdmin, (_req, res) => {
  const list = Object.values(conversationsCache)
    .map(toConversationSummary)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json({ conversations: list, ramoLabels: RAMO_LABELS });
});

app.get("/api/admin/conversations/:id", requireAdmin, (req, res) => {
  const record = conversationsCache[req.params.id];
  if (!record) {
    return res.status(404).json({ error: "Conversación no encontrada." });
  }
  // `pendingVerification` (ver iniciarVerificacionIdentidad) guarda el código OTP en
  // curso mientras se verifica una identidad — nunca debe salir del servidor por
  // ninguna respuesta HTTP, ni siquiera hacia el panel de un admin autenticado
  // (defensa en profundidad: una sesión de staff comprometida no debería poder leer el
  // código vigente de un cliente).
  const { pendingVerification, ...conversation } = record;
  res.json({ conversation });
});

/**
 * GET /api/admin/conversations/:id/live
 * Modo supervisor: stream SSE que empuja cada mensaje nuevo (de cualquier rol) de
 * esta conversación en tiempo real, mientras el panel /admin la tenga abierta con la
 * vista "🔴 En vivo" — ver notifyAdminWatchers.
 */
app.get("/api/admin/conversations/:id/live", requireAdmin, (req, res) => {
  const sessionId = req.params.id;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  registerStream(adminConversationWatchers, sessionId, res);
  sendSse(res, "connected", { ok: true });

  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch (_err) {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unregisterStream(adminConversationWatchers, sessionId, res);
  });
});

/**
 * POST /api/admin/conversations/:id/message
 * "Shadow messaging": un supervisor escribe un mensaje que se guarda y se entrega como
 * si lo hubiera escrito Lucy — al usuario le llega por el canal correspondiente: en
 * vivo por el stream que mantiene abierto el widget web (ver GET /api/chat/live), o
 * por WhatsApp si ese es el canal de la conversación.
 */
app.post("/api/admin/conversations/:id/message", requireAdmin, async (req, res) => {
  const sessionId = req.params.id;
  const record = conversationsCache[sessionId];
  if (!record) {
    return res.status(404).json({ error: "Conversación no encontrada." });
  }
  const body = req.body || {};
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  if (!text) {
    return res.status(400).json({ error: "El mensaje no puede estar vacío." });
  }

  // `staffAuthored` es solo para el registro interno (se ve en /admin) — al usuario le
  // llega igual que cualquier otro mensaje de Lucy, sin ninguna marca ("shadow messaging").
  const entry = { role: "assistant", content: text, time: new Date().toISOString(), staffAuthored: true };
  record.messages = [...(record.messages || []), entry];
  touchConversationRecord(record);

  notifyConversationStream(sessionId, "assistant-message", entry);
  notifyAdminWatchers(sessionId, entry);

  if (record.channel === "whatsapp" && record.phone) {
    await sendWhatsappMessage(record.phone, text);
  }

  res.json({ ok: true, message: entry });
});

/**
 * PATCH /api/admin/conversations/:id/control
 * Tomar o soltar el control total de una conversación — mientras está tomada,
 * /api/chat y el webhook de WhatsApp dejan de llamar a Claude o a cualquier flujo
 * automático para esta conversación (ver record.controladoPorHumano).
 */
app.patch("/api/admin/conversations/:id/control", requireAdmin, (req, res) => {
  const record = conversationsCache[req.params.id];
  if (!record) {
    return res.status(404).json({ error: "Conversación no encontrada." });
  }
  record.controladoPorHumano = Boolean((req.body || {}).tomarControl);
  touchConversationRecord(record);
  res.json({ ok: true, controladoPorHumano: record.controladoPorHumano });
});

/**
 * PATCH /api/admin/conversations/:id/notes
 * Notas internas del equipo sobre esta conversación — nunca se le muestran al usuario
 * ni se le envían a Claude (a diferencia de las notas internas del PERFIL del cliente,
 * ver /api/admin/clientes/:cedula, estas son por conversación puntual).
 */
app.patch("/api/admin/conversations/:id/notes", requireAdmin, (req, res) => {
  const record = conversationsCache[req.params.id];
  if (!record) {
    return res.status(404).json({ error: "Conversación no encontrada." });
  }
  const body = req.body || {};
  record.notasInternas = typeof body.notas === "string" ? body.notas.slice(0, 2000) : "";
  touchConversationRecord(record);
  res.json({ ok: true, notasInternas: record.notasInternas });
});

// ---------------------------------------------------------------------------
// Rutas — Panel de administración: Clientes (memoria persistente)
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/clientes
 * Lista todos los perfiles de clientes (memoria persistente por cédula), más
 * recientes primero por última interacción — para la tabla de la pestaña "Clientes".
 */
app.get("/api/admin/clientes", requireAdmin, (_req, res) => {
  const list = Object.values(clientesCache).sort(
    (a, b) => new Date(b.ultimaInteraccion || 0) - new Date(a.ultimaInteraccion || 0)
  );
  res.json({ clientes: list });
});

/**
 * GET /api/admin/clientes/:cedula
 * Perfil completo de un cliente + las conversaciones (de cualquier canal) vinculadas
 * a su cédula — así el panel puede mostrar "el historial completo de conversaciones
 * por cliente" reutilizando el mismo modal de detalle que ya existe para /conversations.
 * También trae sus pólizas REALES (services/polizas.service.js), de solo lectura
 * aquí — la fuente de verdad es el JSON/API de pólizas, no el perfil del cliente.
 */
app.get("/api/admin/clientes/:cedula", requireAdmin, async (req, res) => {
  const cliente = getClienteByCedula(req.params.cedula);
  if (!cliente) {
    return res.status(404).json({ error: "Cliente no encontrado." });
  }
  const conversaciones = Object.values(conversationsCache)
    .filter((record) => record.clienteId === cliente.cedula)
    .map(toConversationSummary)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  let polizas = [];
  try {
    polizas = await polizasService.buscarPorCedula(cliente.cedula);
  } catch (err) {
    console.warn("[aviso] No se pudieron consultar las pólizas del cliente para /admin:", err.message);
  }
  const polizasConVigencia = polizas.map((p) => ({ ...p, vigencia: polizasService.verificarVigencia(p) }));

  res.json({ cliente, conversaciones, polizas: polizasConVigencia });
});

/**
 * PATCH /api/admin/clientes/:cedula
 * Edita los campos administrables del perfil (notas internas, VIP, próxima
 * renovación, caso de siniestro abierto/cerrado, y datos de contacto). Nunca permite
 * cambiar la cédula ni el historial de temas — esos los gestiona el propio flujo de
 * conversación, no el panel.
 */
app.patch("/api/admin/clientes/:cedula", requireAdmin, (req, res) => {
  const cliente = getClienteByCedula(req.params.cedula);
  if (!cliente) {
    return res.status(404).json({ error: "Cliente no encontrado." });
  }

  const body = req.body || {};
  const patch = {};
  if (typeof body.notasInternas === "string") patch.notasInternas = body.notasInternas.slice(0, 2000);
  if (typeof body.vip === "boolean") patch.vip = body.vip;
  if (typeof body.casoAbiertoSiniestro === "boolean") patch.casoAbiertoSiniestro = body.casoAbiertoSiniestro;
  if (typeof body.proximaRenovacion === "string") patch.proximaRenovacion = body.proximaRenovacion.slice(0, 40);
  if (typeof body.nombre === "string" && body.nombre.trim()) patch.nombre = body.nombre.trim().slice(0, 200);
  if (typeof body.telefono === "string") patch.telefono = body.telefono.trim().slice(0, 30);
  if (typeof body.email === "string") patch.email = body.email.trim().slice(0, 200);
  if (typeof body.preferenciaAudio === "boolean") patch.preferenciaAudio = body.preferenciaAudio;
  if (Array.isArray(body.polizas)) {
    patch.polizas = body.polizas
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => p.trim().slice(0, 40))
      .slice(0, 30);
  }

  const updated = touchCliente(cliente.cedula, patch);
  res.json({ ok: true, cliente: updated });
});

// ---------------------------------------------------------------------------
// Rutas — Panel de administración: Siniestros (services/siniestros.service.js)
// ---------------------------------------------------------------------------

/** Enriquece un siniestro con el nombre del cliente (si está en la memoria persistente)
 *  y la etiqueta legible del estado — para no repetir este mapeo en cada ruta. */
function toSiniestroSummary(s) {
  const cliente = s.cedula_titular ? getClienteByCedula(s.cedula_titular) : null;
  return {
    ...s,
    clienteNombre: cliente ? cliente.nombre : "",
    estadoLabel: SINIESTRO_ESTADO_LABELS[s.estado] || s.estado,
    tipoLabel: SINIESTRO_TIPO_LABELS[s.tipo] || s.tipo,
  };
}

/**
 * GET /api/admin/siniestros
 * Lista todos los siniestros (ver services/siniestros.service.js#listarTodos), con
 * filtros opcionales por query string: `estado` (uno de SINIESTRO_ESTADO_LABELS) y
 * `mayor=1` (solo siniestros mayores — ver UMBRAL_SINIESTRO_MAYOR).
 */
app.get("/api/admin/siniestros", requireAdmin, async (req, res) => {
  let siniestros = await siniestrosService.listarTodos();
  if (req.query.estado && typeof req.query.estado === "string") {
    siniestros = siniestros.filter((s) => s.estado === req.query.estado);
  }
  if (req.query.mayor === "1") {
    siniestros = siniestros.filter((s) => s.siniestro_mayor);
  }
  res.json({ siniestros: siniestros.map(toSiniestroSummary) });
});

/**
 * GET /api/admin/siniestros/:numero
 * Detalle completo de un siniestro puntual, enriquecido con el nombre del cliente.
 */
app.get("/api/admin/siniestros/:numero", requireAdmin, async (req, res) => {
  const siniestro = await siniestrosService.buscarPorNumero(req.params.numero);
  if (!siniestro) {
    return res.status(404).json({ error: "Siniestro no encontrado." });
  }
  res.json({ siniestro: toSiniestroSummary(siniestro) });
});

/**
 * PATCH /api/admin/siniestros/:numero
 * Edita los campos administrables de un siniestro: estado, ajustador asignado, monto
 * aprobado, documentos recibidos/pendientes, fecha estimada de resolución, y permite
 * agregar un comentario nuevo (`nuevoComentario`) — ver
 * siniestrosService.actualizarSiniestro().
 */
app.patch("/api/admin/siniestros/:numero", requireAdmin, async (req, res) => {
  const existente = await siniestrosService.buscarPorNumero(req.params.numero);
  if (!existente) {
    return res.status(404).json({ error: "Siniestro no encontrado." });
  }

  const body = req.body || {};
  const patch = {};
  if (typeof body.estado === "string" && SINIESTRO_ESTADO_LABELS[body.estado]) patch.estado = body.estado;
  if (typeof body.ajustador_asignado === "string") patch.ajustador_asignado = body.ajustador_asignado.trim().slice(0, 100);
  if (body.monto_aprobado === null || typeof body.monto_aprobado === "number") patch.monto_aprobado = body.monto_aprobado;
  if (typeof body.fecha_estimada_resolucion === "string") patch.fecha_estimada_resolucion = body.fecha_estimada_resolucion.slice(0, 20);
  if (Array.isArray(body.documentos_recibidos)) {
    patch.documentos_recibidos = body.documentos_recibidos.filter((d) => typeof d === "string").slice(0, 30);
  }
  if (Array.isArray(body.documentos_pendientes)) {
    patch.documentos_pendientes = body.documentos_pendientes.filter((d) => typeof d === "string").slice(0, 30);
  }
  if (typeof body.nuevoComentario === "string" && body.nuevoComentario.trim()) {
    patch.nuevoComentario = body.nuevoComentario;
  }

  const updated = await siniestrosService.actualizarSiniestro(req.params.numero, patch);
  if (!updated) {
    return res.status(500).json({ error: "No se pudo actualizar el siniestro." });
  }
  res.json({ ok: true, siniestro: toSiniestroSummary(updated) });
});

/**
 * GET /api/admin/reports
 * Métricas del dashboard de reportes: tarjetas numéricas, series para los
 * gráficos (por día / por ramo / por hora) y la lista completa de cotizaciones.
 */
app.get("/api/admin/reports", requireAdmin, (_req, res) => {
  res.json(buildReports());
});

app.get("/api/admin/quotes-export.csv", requireAdmin, (_req, res) => {
  const { quotes, ramoLabels } = buildReports();

  const header = [
    "ID de cotización",
    "ID de sesión",
    "Fecha",
    "Ramo",
    "Valor estimado",
    "Nombre",
    "Cédula",
    "Correo",
    "Solicitó póliza formal",
  ];

  const rows = quotes.map((q) => [
    q.id,
    q.sessionId,
    q.createdAt,
    ramoLabels[q.ramo] || q.ramo,
    q.estimatedValue,
    q.contact ? q.contact.nombre : "",
    q.contact ? q.contact.cedula : "",
    q.contact ? q.contact.correo : "",
    q.formalRequest ? "Sí" : "No",
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="cotizaciones_la_occidental.csv"');
  res.send("﻿" + csv);
});

app.get("/api/admin/conversations-export.csv", requireAdmin, (_req, res) => {
  const list = Object.values(conversationsCache)
    .map(toConversationSummary)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const header = [
    "ID de sesión",
    "Canal",
    "Teléfono",
    "Inicio",
    "Última actividad",
    "Duración (min)",
    "Mensajes",
    "Pidió asesor",
    "Ramos mencionados",
    "Cotizaciones generadas",
    "Solicitó póliza formal",
    "Primer mensaje",
  ];

  const rows = list.map((c) => [
    c.id,
    c.channel === "whatsapp" ? "WhatsApp" : "Web",
    c.phone || "",
    c.startedAt,
    c.updatedAt,
    (c.durationSeconds / 60).toFixed(1),
    c.messageCount,
    c.advisorRequested ? "Sí" : "No",
    c.ramos.map((r) => RAMO_LABELS[r] || r).join(" | "),
    c.quoteRamos.map((r) => RAMO_LABELS[r] || r).join(" | "),
    c.hasFormalRequest ? "Sí" : "No",
    c.preview,
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="conversaciones_la_occidental.csv"');
  res.send("﻿" + csv); // BOM para que Excel detecte UTF-8 correctamente
});

// ---------------------------------------------------------------------------
// Rutas — Portal de corredores (/corredor)
// ---------------------------------------------------------------------------
//
// Las 4 rutas de página (GET /corredor y sub-rutas) sirven siempre el mismo HTML —
// el ruteo entre vistas (dashboard/clientes/cotizar/siniestros) ocurre en el propio
// navegador (History API, ver public/corredor.js), igual que /admin sirve un único
// admin.html para todas sus pestañas. La protección REAL de los datos está en los
// endpoints /api/corredor/* (requireCorredorAuth), no en estas rutas de página: servir
// el HTML no expone ningún dato, solo el cascarón de la aplicación.
const CORREDOR_PAGE_ROUTES = ["/corredor", "/corredor/clientes", "/corredor/cotizar", "/corredor/siniestros"];
CORREDOR_PAGE_ROUTES.forEach((route) => {
  app.get(route, (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "corredor.html"));
  });
});

app.post("/api/corredor/login", loginLimiter, async (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "El portal de corredores no está configurado (falta JWT_SECRET en el servidor)." });
  }
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Correo y contraseña son requeridos." });
  }
  const corredor = await corredoresService.autenticar(email, password);
  if (!corredor) {
    return res.status(401).json({ error: "Correo o contraseña incorrectos." });
  }
  const token = issueCorredorToken(corredor);
  res.json({ ok: true, token, corredor });
});

app.get("/api/corredor/me", requireCorredorAuth, (req, res) => {
  res.json({ corredor: req.corredor });
});

/**
 * GET /api/corredor/events
 * Stream SSE de notificaciones en tiempo real (toasts): "siniestro-abierto" (un
 * cliente de la cartera abrió un siniestro), "poliza-por-vencer" (una póliza de la
 * cartera cruzó el umbral de 7 días) y "emision-resuelta" (gerencia aprobó/rechazó una
 * solicitud de emisión). El token viaja en `?token=` (única excepción a
 * Authorization: Bearer — EventSource del navegador no permite headers personalizados).
 */
app.get("/api/corredor/events", requireCorredorAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  registerCorredorEventStream(req.corredor.id, res);
  sendSse(res, "connected", { ok: true });

  // Mantiene la conexión viva a través de proxies que cierran streams inactivos.
  const keepAlive = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch (_err) {
      clearInterval(keepAlive);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unregisterCorredorEventStream(req.corredor.id, res);
  });
});

/** GET /api/corredor/cartera?q=texto — cartera de clientes del corredor (ver
 *  corredoresService.listarCartera), con filtro opcional de búsqueda en el servidor. */
app.get("/api/corredor/cartera", requireCorredorAuth, async (req, res) => {
  const cartera = await corredoresService.listarCartera(req.corredor.nombre);
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const filtrada = q
    ? cartera.filter((c) => c.nombre.toLowerCase().includes(q) || c.cedula.toLowerCase().includes(q))
    : cartera;
  res.json({ cartera: filtrada });
});

/** GET /api/corredor/polizas-por-vencer?dias=30 — "Muéstrame mis pólizas por vencer
 *  este mes" (dias=30 por defecto) — ver corredoresService.polizasPorVencer. */
app.get("/api/corredor/polizas-por-vencer", requireCorredorAuth, async (req, res) => {
  const dias = req.query.dias !== undefined ? Number(req.query.dias) : undefined;
  const polizas = await corredoresService.polizasPorVencer(req.corredor.nombre, dias);
  res.json({ polizas });
});

/** GET /api/corredor/siniestros — "¿Qué clientes tienen siniestros abiertos?" —
 *  todos los siniestros de la cartera, cada uno marcado con `abierto`. */
app.get("/api/corredor/siniestros", requireCorredorAuth, async (req, res) => {
  const siniestros = await corredoresService.siniestrosDeCartera(req.corredor.nombre);
  res.json({ siniestros });
});

/** GET /api/corredor/comision?desde=AAAA-MM&hasta=AAAA-MM — "¿Cuál es mi comisión
 *  acumulada?" — desglose mensual (ver corredoresService.calcularComision). */
app.get("/api/corredor/comision", requireCorredorAuth, async (req, res) => {
  const desde = typeof req.query.desde === "string" ? req.query.desde : undefined;
  const hasta = typeof req.query.hasta === "string" ? req.query.hasta : undefined;
  const comision = await corredoresService.calcularComision(req.corredor, { desde, hasta });
  res.json(comision);
});

/**
 * POST /api/corredor/cotizar
 * Cotizador profesional: calcula (en el SERVIDOR, con las mismas tarifas del
 * quoter-config.json vigente — nunca confía en un monto que mande el cliente) y
 * devuelve directamente el PDF formal de la cotización, con membrete de la compañía.
 * Body: { ramo: "automoviles"|"hcm", cliente: { nombre, cedula, vehiculo? }, inputs }
 * (mismo shape de `inputs` que usa el cotizador del chat — ver computeRcv/computeHcm
 * en public/chatbot.js — más los datos del cliente para membretear el PDF).
 */
app.post("/api/corredor/cotizar", quoteLimiter, requireCorredorAuth, async (req, res) => {
  const { ramo, cliente, inputs } = req.body || {};
  if ((ramo !== "automoviles" && ramo !== "hcm") || !cliente || !inputs) {
    return res.status(400).json({ error: "Faltan datos: 'ramo' (automoviles|hcm), 'cliente' e 'inputs' son requeridos." });
  }
  if (typeof cliente.nombre !== "string" || !cliente.nombre.trim() || typeof cliente.cedula !== "string" || !cliente.cedula.trim()) {
    return res.status(400).json({ error: "El cliente debe incluir nombre y cédula." });
  }

  const cfg = ramo === "automoviles" ? quoterConfigCache.rcv : quoterConfigCache.hcm;
  if (!cfg) {
    return res.status(500).json({ error: "El cotizador no está configurado para ese ramo." });
  }
  // `inputs` viene del cliente sin validar hasta aquí — a diferencia de nombre/cédula/
  // vehículo (truncados más abajo antes de ir al PDF), sus arreglos (recargoIds,
  // beneficiarioAges) no tenían ningún límite: un corredor autenticado podía mandar
  // miles de entradas y generarCotizacionPdf las volcaría 1:1 en filas del PDF (PDF
  // enorme/lento). Se acotan a un máximo razonable antes de calcular la cotización.
  if (Array.isArray(inputs.recargoIds)) inputs.recargoIds = inputs.recargoIds.slice(0, 20);
  if (Array.isArray(inputs.beneficiarioAges)) inputs.beneficiarioAges = inputs.beneficiarioAges.slice(0, 20);
  const resultado = ramo === "automoviles" ? corredoresService.cotizarRcv(inputs, cfg) : corredoresService.cotizarHcm(inputs, cfg);
  if (!resultado) {
    return res.status(400).json({ error: "No se pudo calcular la cotización con los datos suministrados." });
  }

  const numero = `COT-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  try {
    const pdfBuffer = await corredoresService.generarCotizacionPdf({
      companyName: COMPANY_NAME,
      cliente: {
        nombre: cliente.nombre.trim().slice(0, 200),
        cedula: cliente.cedula.trim().slice(0, 20),
        vehiculo: typeof cliente.vehiculo === "string" ? cliente.vehiculo.trim().slice(0, 200) : "",
      },
      corredor: req.corredor,
      resultado,
      inputs,
      numero,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="cotizacion-${numero}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Error al generar el PDF de cotización:", err);
    res.status(500).json({ error: "No se pudo generar el PDF de la cotización." });
  }
});

/** GET /api/corredor/emisiones — solicitudes de emisión enviadas por este corredor,
 *  con su estado ("pendiente_aprobacion" | "aprobada" | "rechazada"). */
app.get("/api/corredor/emisiones", requireCorredorAuth, async (req, res) => {
  const emisiones = await corredoresService.listarEmisionesPorCorredor(req.corredor.id);
  res.json({ emisiones });
});

/**
 * POST /api/corredor/emisiones
 * "EMISIÓN DE SOLICITUD: formulario para iniciar emisión de nueva póliza" — queda en
 * estado "pendiente_aprobacion" hasta que gerencia la revisa desde /admin (ver
 * PATCH /api/admin/emisiones/:id, que dispara la notificación "emision-resuelta").
 * Body: { cliente: { nombre, cedula, telefono? }, ramo, detalle: {...} }
 */
app.post("/api/corredor/emisiones", requireCorredorAuth, async (req, res) => {
  const { cliente, ramo, detalle } = req.body || {};
  if (!cliente || typeof cliente.nombre !== "string" || !cliente.nombre.trim() || typeof cliente.cedula !== "string" || !cliente.cedula.trim()) {
    return res.status(400).json({ error: "El cliente debe incluir nombre y cédula." });
  }
  if (typeof ramo !== "string" || !ramo.trim()) {
    return res.status(400).json({ error: "El ramo es requerido." });
  }
  const emision = await corredoresService.crearEmision({
    corredorId: req.corredor.id,
    cliente: {
      nombre: cliente.nombre.trim().slice(0, 200),
      cedula: cliente.cedula.trim().slice(0, 20),
      telefono: typeof cliente.telefono === "string" ? cliente.telefono.trim().slice(0, 30) : "",
    },
    ramo: ramo.trim().slice(0, 40),
    detalle: detalle && typeof detalle === "object" ? detalle : {},
  });
  res.json({ ok: true, emision });
});

/** GET /api/corredor/documentos — catálogo de documentos descargables (condicionados
 *  generales, tarifario, formulario de siniestros). */
app.get("/api/corredor/documentos", requireCorredorAuth, (_req, res) => {
  res.json({ documentos: corredoresService.listarDocumentos() });
});

/** GET /api/corredor/documentos/:key — descarga el PDF de un documento del catálogo. */
app.get("/api/corredor/documentos/:key", requireCorredorAuth, async (req, res) => {
  try {
    const pdfBuffer = await corredoresService.generarDocumentoPdf(req.params.key, COMPANY_NAME);
    if (!pdfBuffer) {
      return res.status(404).json({ error: "Documento no encontrado." });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${req.params.key}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error("Error al generar el PDF del documento:", err);
    res.status(500).json({ error: "No se pudo generar el documento." });
  }
});

// Envío masivo de recordatorios — más sensible que una petición normal (dispara
// varios WhatsApp a la vez), límite propio y más estricto.
const corredorRecordatorioLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Ya enviaste recordatorios recientemente. Intenta de nuevo en unos minutos." },
});

/** Normaliza un teléfono guardado en el perfil de un cliente al formato que espera
 *  Twilio ("whatsapp:+58..."). Ver nota en `cliente.telefono` — para clientes
 *  identificados por WhatsApp ya viene con el prefijo; para los identificados por el
 *  chat web (o editados a mano en /admin), puede venir en cualquier formato libre. */
function toWhatsappAddress(telefono) {
  if (!telefono) return null;
  if (/^whatsapp:/i.test(telefono)) return telefono;
  const digits = telefono.replace(/[^\d+]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(digits) ? `whatsapp:${digits}` : null;
}

/**
 * POST /api/corredor/recordatorios
 * "Envía recordatorio de renovación a todos mis clientes con póliza por vencer" —
 * manda un WhatsApp a cada cliente ÚNICO de la cartera con al menos una póliza por
 * vencer (según `dias`, 30 por defecto) que tenga teléfono registrado en su perfil de
 * memoria persistente (ver services/polizas.service.js + clientesCache) — a los que no
 * tienen teléfono se les excluye y se reportan aparte, no se inventa ningún dato de
 * contacto. Requiere Twilio configurado (ver TWILIO_ACCOUNT_SID) — si no, no falla,
 * simplemente no se envía nada (mismo criterio que el resto del proyecto).
 */
app.post("/api/corredor/recordatorios", corredorRecordatorioLimiter, requireCorredorAuth, async (req, res) => {
  const dias = req.body && req.body.dias !== undefined ? Number(req.body.dias) : undefined;
  const polizas = await corredoresService.polizasPorVencer(req.corredor.nombre, dias);

  const porCliente = new Map();
  for (const p of polizas) {
    if (p.vigencia.vencida) continue; // el recordatorio es para "por vencer", no vencidas
    if (!porCliente.has(p.cedula)) porCliente.set(p.cedula, []);
    porCliente.get(p.cedula).push(p);
  }

  const enviados = [];
  const sinTelefono = [];
  for (const [cedula, polizasCliente] of porCliente.entries()) {
    const cliente = getClienteByCedula(cedula);
    const whatsappTo = cliente ? toWhatsappAddress(cliente.telefono) : null;
    if (!whatsappTo) {
      sinTelefono.push({ cedula, nombre: polizasCliente[0].titular });
      continue;
    }
    const lista = polizasCliente
      .map((p) => `• ${p.numero} (${POLIZA_RAMO_LABELS[p.ramo] || p.ramo}) — vence el ${p.vigencia_fin}`)
      .join("\n");
    const mensaje =
      `Hola ${polizasCliente[0].titular.split(" ")[0]}, te escribimos de ${COMPANY_NAME} 👋\n\n` +
      `Tu(s) póliza(s) está(n) por vencer:\n${lista}\n\n` +
      `Escríbenos por aquí o contacta a tu corredor ${req.corredor.nombre} para renovarla(s) a tiempo.`;
    await sendWhatsappMessage(whatsappTo, mensaje);
    enviados.push({ cedula, nombre: polizasCliente[0].titular, polizas: polizasCliente.map((p) => p.numero) });
  }

  res.json({
    ok: true,
    enviados,
    sinTelefono,
    twilioConfigurado: Boolean(twilioClient),
  });
});

// ---------------------------------------------------------------------------
// Rutas — Panel de administración: Emisiones (aprobar/rechazar solicitudes de
// corredores, ver POST /api/corredor/emisiones)
// ---------------------------------------------------------------------------

/** Agrega `corredorNombre` a una emisión (join en memoria contra data/corredores.json)
 *  — usado tanto por el listado como por la respuesta del PATCH, para que el panel
 *  siempre tenga ese dato disponible sin volver a pedir la lista completa. */
function enriquecerEmision(e) {
  const corredor = corredoresService.buscarPorId(e.corredorId);
  return { ...e, corredorNombre: corredor ? corredor.nombre : "—" };
}

app.get("/api/admin/emisiones", requireAdmin, async (_req, res) => {
  const emisiones = await corredoresService.listarTodasEmisiones();
  res.json({ emisiones: emisiones.map(enriquecerEmision) });
});

/**
 * PATCH /api/admin/emisiones/:id
 * Aprueba o rechaza una solicitud de emisión — dispara la notificación en tiempo real
 * "emision-resuelta" al corredor que la envió (ver "Aviso cuando La Occidental aprueba
 * o rechaza una solicitud de emisión" del pedido original).
 */
app.patch("/api/admin/emisiones/:id", requireAdmin, async (req, res) => {
  const existente = await corredoresService.buscarEmision(req.params.id);
  if (!existente) {
    return res.status(404).json({ error: "Solicitud de emisión no encontrada." });
  }
  const body = req.body || {};
  const patch = {};
  if (body.estado === "aprobada" || body.estado === "rechazada" || body.estado === "pendiente_aprobacion") {
    patch.estado = body.estado;
  }
  if (typeof body.notasAdmin === "string") patch.notasAdmin = body.notasAdmin.slice(0, 1000);

  const updated = await corredoresService.actualizarEmision(req.params.id, patch);
  if (!updated) {
    return res.status(500).json({ error: "No se pudo actualizar la solicitud." });
  }

  if (patch.estado && patch.estado !== "pendiente_aprobacion") {
    notifyCorredor(updated.corredorId, "emision-resuelta", {
      id: updated.id,
      estado: updated.estado,
      cliente: updated.cliente,
      ramo: updated.ramo,
    });
  }

  res.json({ ok: true, emision: enriquecerEmision(updated) });
});

// ---------------------------------------------------------------------------
// Rutas — Panel de administración: gaps de conocimiento ("❓ Preguntas sin respuesta",
// ver registrarGapConocimiento — se llenan solas cuando el usuario dice que Lucy no
// respondió bien o pide un asesor humano).
// ---------------------------------------------------------------------------

app.get("/api/admin/gaps", requireAdmin, (_req, res) => {
  const gaps = [...gapsConocimientoCache].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  res.json({ gaps });
});

app.patch("/api/admin/gaps/:id", requireAdmin, async (req, res) => {
  const gap = gapsConocimientoCache.find((g) => g.id === req.params.id);
  if (!gap) {
    return res.status(404).json({ error: "Gap de conocimiento no encontrado." });
  }
  const body = req.body || {};
  if (typeof body.resuelto === "boolean") gap.resuelto = body.resuelto;
  if (typeof body.notas === "string") gap.notas = body.notas.slice(0, 1000);
  await persistGapsConocimiento();
  res.json({ ok: true, gap });
});

// Manejo de errores de CORS y otros errores no capturados en middlewares.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(PORT, () => {
  console.log(`✅ ${COMPANY_NAME} · Chatbot backend escuchando en http://localhost:${PORT}`);
  console.log(`   Modelo configurado: ${CLAUDE_MODEL}`);
  console.log(`   Panel de administración: http://localhost:${PORT}/admin`);
  if (JWT_SECRET) {
    console.log(`   Portal de corredores: http://localhost:${PORT}/corredor`);
  } else {
    console.warn("[aviso] JWT_SECRET no está definida — el portal de corredores (/corredor) quedará deshabilitado.");
  }
});

// Chequeo periódico de "pólizas por vencer en 7 días" para las notificaciones en
// tiempo real del portal de corredores — ver iniciarChequeoVencimientosCorredores().
iniciarChequeoVencimientosCorredores();

// Tareas programadas (node-cron): recordatorios de pólizas, seguimiento de
// cotizaciones y valoración por inactividad — ver iniciarScheduler() y
// config/scheduler.config.js.
iniciarScheduler();

// En segundo plano (no bloquea el arranque): genera los posters/thumbnails que falten
// para los videos del catálogo — ver ensureVideoPosters().
ensureVideoPosters().catch((err) => {
  console.error("Error al generar los posters de los videos:", err);
});
