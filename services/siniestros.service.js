/**
 * siniestros.service.js
 * Gestión de siniestros (apertura, consulta, documentos, ajustador) de La Occidental.
 *
 * Hoy lee/escribe /data/siniestros.json (fixture local, "mientras no hay sistema
 * externo" — mismo criterio que services/polizas.service.js). Si se configura
 * SINIESTROS_API_URL en el .env, las funciones consultan/escriben contra esa API REST
 * en su lugar, sin que el resto del código (server.js) tenga que saber de dónde vienen
 * realmente los datos — así el día que exista un sistema de siniestros real, alcanza
 * con definir esa variable de entorno.
 *
 * A diferencia de polizas.service.js (solo lectura), este servicio también ESCRIBE
 * (abrir un siniestro, actualizar documentos, reasignar ajustador) — en modo local
 * usa el mismo patrón de caché en memoria + cola de escritura serializada que
 * data/clientes.json en server.js, para evitar condiciones de carrera entre
 * peticiones concurrentes.
 *
 * Contrato asumido para SINIESTROS_API_URL (ajústalo aquí si tu API real es distinta):
 *   GET  {SINIESTROS_API_URL}/siniestros                    -> arreglo con TODOS los siniestros (uso: panel /admin)
 *   GET  {SINIESTROS_API_URL}/siniestros?cedula=<cedula>   -> arreglo de siniestros del cliente
 *   GET  {SINIESTROS_API_URL}/siniestros/<numero>           -> un siniestro (o 404)
 *   POST {SINIESTROS_API_URL}/siniestros                    -> crea uno, body = datos de abrirSiniestro(), responde el siniestro creado (con `numero`)
 *   PATCH {SINIESTROS_API_URL}/siniestros/<numero>          -> aplica cambios parciales, responde el siniestro actualizado
 */

const fs = require("fs");
const path = require("path");

const SINIESTROS_FILE = process.env.SINIESTROS_FILE
  ? path.resolve(__dirname, "..", process.env.SINIESTROS_FILE)
  : path.join(__dirname, "..", "data", "siniestros.json");

// Sin protocolo/slash final — se concatena tal cual delante de cada ruta.
const SINIESTROS_API_URL = (process.env.SINIESTROS_API_URL || "").trim().replace(/\/$/, "");

/** ¿Hay que usar la API REST externa en vez del JSON local? */
function usingRemoteApi() {
  return Boolean(SINIESTROS_API_URL);
}

// Monto (en la moneda de la póliza, normalmente USD) a partir del cual un siniestro
// se marca como "mayor" y se notifica a gerencia — ver abrirSiniestro().
const UMBRAL_SINIESTRO_MAYOR = 3000;

// Documentos requeridos según el tipo de siniestro (PASO 3 del flujo de apertura) —
// vocabulario propio de este servicio; server.js traduce cada clave a una etiqueta
// legible (ver SINIESTRO_DOC_LABELS) para mostrarla al cliente y en /admin.
const DOCUMENTOS_POR_TIPO = {
  accidente: ["fotos_dano", "denuncia_policial", "croquis", "presupuesto_taller"],
  colision: ["fotos_dano", "denuncia_policial", "croquis", "presupuesto_taller"], // alias de "accidente"
  robo: ["denuncia_policial", "inventario_bienes"],
  incendio: ["fotos_dano", "informe_bomberos", "presupuesto_reparacion"],
  hospitalizacion: ["diagnostico_medico", "facturas", "orden_hospitalizacion"],
};

// Ajustadores disponibles para asignación automática al abrir un siniestro (ver
// abrirSiniestro) — reparto simple por turno rotativo. Sin integración real con RR.HH.
const AJUSTADORES_DISPONIBLES = ["Pedro Rondón", "Gabriela Uzcátegui", "Luis Fernández"];
let siguienteAjustadorIndex = 0;

// --- Fuente local (data/siniestros.json) -------------------------------------

/** @type {any[]|null} */
let siniestrosCache = null;
let writeQueue = Promise.resolve();

function loadSiniestrosFromDisk() {
  try {
    const raw = fs.readFileSync(SINIESTROS_FILE, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : { siniestros: [] };
    return Array.isArray(parsed.siniestros) ? parsed.siniestros : [];
  } catch (err) {
    console.error(`[aviso] No se pudo leer ${path.basename(SINIESTROS_FILE)}, se iniciará vacío:`, err.message);
    return [];
  }
}

function getAllSiniestrosLocal() {
  if (!siniestrosCache) siniestrosCache = loadSiniestrosFromDisk();
  return siniestrosCache;
}

/** Serializa las escrituras a disco (mismo patrón que clientes.json en server.js). */
function persistLocal() {
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify({ siniestros: getAllSiniestrosLocal() }, null, 2);
        fs.writeFile(SINIESTROS_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar siniestros.json:", err.message);
          resolve();
        });
      })
  );
  return writeQueue;
}

/** Fuerza a releer data/siniestros.json en el próximo acceso (por si se edita a mano
 *  con el servidor corriendo). */
function invalidateLocalCache() {
  siniestrosCache = null;
}

// --- Fuente remota (SINIESTROS_API_URL) ---------------------------------------

async function fetchFromApi(pathSuffix, options) {
  const response = await fetch(`${SINIESTROS_API_URL}${pathSuffix}`, options);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`SINIESTROS_API_URL respondió ${response.status} para ${pathSuffix}`);
  }
  return response.json();
}

// --- Helpers internos ----------------------------------------------------------

/** Siguiente número de siniestro correlativo del año en curso ("SIN-2026-0043"),
 *  a partir de los ya existentes en el archivo local. Solo se usa en modo local — en
 *  modo API remota, es esa API quien decide el número (ver abrirSiniestro). */
function generarNumeroLocal() {
  const year = new Date().getFullYear();
  const prefijo = `SIN-${year}-`;
  const existentes = getAllSiniestrosLocal()
    .map((s) => s.numero)
    .filter((n) => typeof n === "string" && n.startsWith(prefijo))
    .map((n) => parseInt(n.slice(prefijo.length), 10))
    .filter((n) => !Number.isNaN(n));
  const siguiente = (existentes.length ? Math.max(...existentes) : 0) + 1;
  return `${prefijo}${String(siguiente).padStart(4, "0")}`;
}

/** Reparto rotativo simple entre AJUSTADORES_DISPONIBLES — sin integración real con
 *  RR.HH./carga de trabajo, solo para que cada siniestro nuevo quede con alguien
 *  asignado desde el inicio (ver PASO 5 del pedido original). */
function siguienteAjustadorDisponible() {
  const ajustador = AJUSTADORES_DISPONIBLES[siguienteAjustadorIndex % AJUSTADORES_DISPONIBLES.length];
  siguienteAjustadorIndex += 1;
  return ajustador;
}

function sumarDias(isoDate, dias) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// --- API del servicio -----------------------------------------------------------

/** Todos los siniestros existentes, más recientes primero — usado por el panel /admin
 *  (ver GET /api/admin/siniestros en server.js), no por el flujo conversacional (ese
 *  siempre filtra por cliente, ver listarPorCedula). */
async function listarTodos() {
  if (usingRemoteApi()) {
    try {
      const data = await fetchFromApi("/siniestros");
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn("[aviso] No se pudo consultar SINIESTROS_API_URL (listarTodos):", err.message);
      return [];
    }
  }
  return [...getAllSiniestrosLocal()].sort((a, b) => new Date(b.fecha_reporte || 0) - new Date(a.fecha_reporte || 0));
}

/**
 * Todos los siniestros de un cliente (por cédula del titular), más recientes primero.
 * Devuelve siempre un arreglo (vacío si no tiene ninguno o si la consulta falla —
 * nunca lanza: quien llama decide cómo avisarle al usuario que no se pudo consultar).
 */
async function listarPorCedula(cedula) {
  if (!cedula) return [];
  if (usingRemoteApi()) {
    try {
      const data = await fetchFromApi(`/siniestros?cedula=${encodeURIComponent(cedula)}`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn("[aviso] No se pudo consultar SINIESTROS_API_URL (listarPorCedula):", err.message);
      return [];
    }
  }
  return getAllSiniestrosLocal()
    .filter((s) => s.cedula_titular === cedula)
    .sort((a, b) => new Date(b.fecha_reporte || 0) - new Date(a.fecha_reporte || 0));
}

/** Busca un siniestro puntual por su número (p. ej. "SIN-2026-0042"). Devuelve `null`
 *  si no existe o si la consulta falla. */
async function buscarPorNumero(numero) {
  if (!numero) return null;
  if (usingRemoteApi()) {
    try {
      return await fetchFromApi(`/siniestros/${encodeURIComponent(numero)}`);
    } catch (err) {
      console.warn("[aviso] No se pudo consultar SINIESTROS_API_URL (buscarPorNumero):", err.message);
      return null;
    }
  }
  return getAllSiniestrosLocal().find((s) => s.numero === numero) || null;
}

/**
 * Consulta el estado actual de un siniestro — envoltorio fino sobre buscarPorNumero()
 * pensado para el caso de uso "¿cómo va mi siniestro?": devuelve el registro completo
 * (o `null` si no existe). El texto legible del estado lo arma quien llama (server.js
 * tiene el vocabulario de etiquetas, para mantenerlo junto al resto de textos de Lucy).
 */
async function consultarEstado(numero) {
  return buscarPorNumero(numero);
}

/**
 * Abre un siniestro nuevo. `datos` = { poliza, cedula_titular, tipo, fecha_ocurrencia,
 * descripcion, ubicacion?, heridos?, monto_reclamado? }. Genera el número
 * automáticamente, calcula los documentos pendientes según el tipo, asigna un
 * ajustador y marca "siniestro mayor" si el monto reclamado supera
 * UMBRAL_SINIESTRO_MAYOR (en ese caso, además, deja constancia en consola — no hay un
 * canal real de notificación a gerencia todavía, ver nota más abajo). Devuelve el
 * siniestro creado.
 */
async function abrirSiniestro(datos) {
  const tipo = String(datos.tipo || "").toLowerCase();
  const documentosPendientes = [...(DOCUMENTOS_POR_TIPO[tipo] || [])];
  const montoReclamado = Number(datos.monto_reclamado) || 0;
  const esSiniestroMayor = montoReclamado > UMBRAL_SINIESTRO_MAYOR;
  const fechaReporte = new Date().toISOString().slice(0, 10);

  const nuevo = {
    numero: usingRemoteApi() ? undefined : generarNumeroLocal(), // en modo remoto lo asigna la API
    poliza: datos.poliza || "",
    cedula_titular: datos.cedula_titular || "",
    tipo,
    fecha_ocurrencia: datos.fecha_ocurrencia || fechaReporte,
    fecha_reporte: fechaReporte,
    estado: documentosPendientes.length ? "pendiente_documentacion" : "recibido",
    descripcion: datos.descripcion || "",
    ubicacion: datos.ubicacion || "",
    heridos: datos.heridos || "",
    ajustador_asignado: datos.ajustador_asignado || siguienteAjustadorDisponible(),
    documentos_recibidos: [],
    documentos_pendientes: documentosPendientes,
    monto_reclamado: montoReclamado,
    monto_aprobado: null,
    siniestro_mayor: esSiniestroMayor,
    fecha_estimada_resolucion: sumarDias(fechaReporte, 30),
    comentarios: [],
  };

  let creado;
  if (usingRemoteApi()) {
    creado = await fetchFromApi("/siniestros", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nuevo),
    });
  } else {
    getAllSiniestrosLocal().push(nuevo);
    await persistLocal();
    creado = nuevo;
  }

  // "Notificar a gerencia" — sin un canal real (correo/Slack/etc.) todavía, se deja
  // constancia clara en el log del servidor; el panel /admin también resalta estos
  // casos (columna/insignia "Siniestro mayor") para que el equipo los vea sin depender
  // de revisar logs.
  if (creado && creado.siniestro_mayor) {
    console.warn(
      `🚨 SINIESTRO MAYOR: ${creado.numero} — monto reclamado $${creado.monto_reclamado} ` +
        `(supera el umbral de $${UMBRAL_SINIESTRO_MAYOR}). Notificar a gerencia.`
    );
  }

  return creado;
}

/**
 * Marca un documento como recibido para un siniestro: lo quita de `documentos_pendientes`
 * y lo agrega a `documentos_recibidos` (sin duplicar). Si ya no queda ningún documento
 * pendiente y el siniestro estaba en "pendiente_documentacion", pasa automáticamente a
 * "en_investigacion". `cambios` = { documentoRecibido } para marcar UNO (uso típico:
 * el usuario adjunta una foto/PDF en el chat, ver server.js), o { pendientes, recibidos }
 * para reemplazar ambas listas completas (uso típico: edición manual desde /admin).
 * Devuelve el siniestro actualizado, o `null` si no existe.
 */
async function actualizarDocumentos(numero, cambios) {
  const siniestro = await buscarPorNumero(numero);
  if (!siniestro) return null;

  const patch = {};
  if (cambios && typeof cambios.documentoRecibido === "string") {
    const doc = cambios.documentoRecibido;
    const pendientes = (siniestro.documentos_pendientes || []).filter((d) => d !== doc);
    const recibidos = siniestro.documentos_recibidos || [];
    patch.documentos_pendientes = pendientes;
    patch.documentos_recibidos = recibidos.includes(doc) ? recibidos : [...recibidos, doc];
    if (pendientes.length === 0 && siniestro.estado === "pendiente_documentacion") {
      patch.estado = "en_investigacion";
    }
  } else if (cambios && (Array.isArray(cambios.pendientes) || Array.isArray(cambios.recibidos))) {
    if (Array.isArray(cambios.pendientes)) patch.documentos_pendientes = cambios.pendientes;
    if (Array.isArray(cambios.recibidos)) patch.documentos_recibidos = cambios.recibidos;
    const pendientesFinal = patch.documentos_pendientes || siniestro.documentos_pendientes || [];
    if (pendientesFinal.length === 0 && siniestro.estado === "pendiente_documentacion") {
      patch.estado = "en_investigacion";
    }
  } else {
    return siniestro;
  }

  return aplicarPatch(numero, patch);
}

/** Asigna (o reasigna) un ajustador a un siniestro. Devuelve el siniestro actualizado,
 *  o `null` si no existe. */
async function asignarAjustador(numero, nombreAjustador) {
  if (!nombreAjustador) return buscarPorNumero(numero);
  return aplicarPatch(numero, { ajustador_asignado: nombreAjustador });
}

/**
 * Cambios administrables desde /admin (estado, monto aprobado, comentario nuevo, etc.)
 * que no encajan en las funciones anteriores — no estaba en la lista de funciones del
 * pedido original, pero server.js la necesita para el panel de administración (mismo
 * criterio que touchCliente() junto a createCliente() en server.js). `patch` puede
 * incluir: estado, monto_aprobado, ajustador_asignado, documentos_recibidos,
 * documentos_pendientes, fecha_estimada_resolucion, y `nuevoComentario` (string —
 * se agrega a `comentarios` con fecha de hoy).
 */
async function actualizarSiniestro(numero, patch) {
  const cambios = { ...patch };
  if (typeof cambios.nuevoComentario === "string" && cambios.nuevoComentario.trim()) {
    const siniestro = await buscarPorNumero(numero);
    const comentarios = (siniestro && siniestro.comentarios) || [];
    cambios.comentarios = [
      ...comentarios,
      { fecha: new Date().toISOString().slice(0, 10), autor: "admin", texto: cambios.nuevoComentario.trim().slice(0, 500) },
    ];
  }
  delete cambios.nuevoComentario;
  return aplicarPatch(numero, cambios);
}

async function aplicarPatch(numero, patch) {
  if (usingRemoteApi()) {
    try {
      return await fetchFromApi(`/siniestros/${encodeURIComponent(numero)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (err) {
      console.warn("[aviso] No se pudo actualizar SINIESTROS_API_URL:", err.message);
      return null;
    }
  }
  const siniestro = getAllSiniestrosLocal().find((s) => s.numero === numero);
  if (!siniestro) return null;
  Object.assign(siniestro, patch);
  await persistLocal();
  return siniestro;
}

module.exports = {
  listarTodos,
  listarPorCedula,
  buscarPorNumero,
  consultarEstado,
  abrirSiniestro,
  actualizarDocumentos,
  asignarAjustador,
  actualizarSiniestro,
  usingRemoteApi,
  invalidateLocalCache,
  DOCUMENTOS_POR_TIPO,
  UMBRAL_SINIESTRO_MAYOR,
};
