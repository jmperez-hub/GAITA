/**
 * polizas.service.js
 * Acceso a los datos de pólizas de los clientes de La Occidental.
 *
 * Hoy lee /data/polizas.json (fixture local, "mientras no hay sistema externo" — ver
 * el pedido original). Si se configura POLIZAS_API_URL en el .env, las funciones de
 * búsqueda consultan esa API REST en su lugar, sin que el resto del código (server.js)
 * tenga que saber de dónde vienen realmente los datos — así el día que exista un
 * sistema de pólizas real, alcanza con definir esa variable de entorno.
 *
 * Contrato asumido para POLIZAS_API_URL (ajústalo aquí si tu API real es distinta):
 *   GET {POLIZAS_API_URL}/polizas                   -> arreglo con TODAS las pólizas (uso: portal de corredores)
 *   GET {POLIZAS_API_URL}/polizas?cedula=<cedula>  -> arreglo de pólizas (mismo shape
 *     que data/polizas.json) de ese cliente, o [] si no tiene ninguna.
 *   GET {POLIZAS_API_URL}/polizas/<numero>          -> una póliza (o 404 si no existe).
 */

const fs = require("fs");
const path = require("path");

const POLIZAS_FILE = process.env.POLIZAS_FILE
  ? path.resolve(__dirname, "..", process.env.POLIZAS_FILE)
  : path.join(__dirname, "..", "data", "polizas.json");

// Sin protocolo/slash final — se concatena tal cual delante de cada ruta.
const POLIZAS_API_URL = (process.env.POLIZAS_API_URL || "").trim().replace(/\/$/, "");

/** ¿Hay que usar la API REST externa en vez del JSON local? */
function usingRemoteApi() {
  return Boolean(POLIZAS_API_URL);
}

// --- Fuente local (data/polizas.json) ---------------------------------------

/** @type {any[]|null} */
let polizasCache = null;

function loadPolizasFromDisk() {
  try {
    const raw = fs.readFileSync(POLIZAS_FILE, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[aviso] No se pudo leer ${path.basename(POLIZAS_FILE)}:`, err.message);
    return [];
  }
}

function getAllPolizasLocal() {
  if (!polizasCache) polizasCache = loadPolizasFromDisk();
  return polizasCache;
}

/** Fuerza a releer data/polizas.json en el próximo acceso (por si se edita a mano
 *  con el servidor corriendo — no hay endpoint de edición en /admin todavía). */
function invalidateLocalCache() {
  polizasCache = null;
}

// --- Fuente remota (POLIZAS_API_URL) -----------------------------------------

async function fetchFromApi(pathSuffix) {
  const response = await fetch(`${POLIZAS_API_URL}${pathSuffix}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`POLIZAS_API_URL respondió ${response.status} para ${pathSuffix}`);
  }
  return response.json();
}

// --- API del servicio ---------------------------------------------------------

/** Todas las pólizas existentes — usado por el portal de corredores (ver
 *  services/corredores.service.js#listarCartera) para armar la cartera de un corredor
 *  filtrando por el campo `corredor` de cada póliza. No se usa en el flujo
 *  conversacional (ese siempre filtra por cliente, ver buscarPorCedula). */
async function listarTodas() {
  if (usingRemoteApi()) {
    try {
      const data = await fetchFromApi("/polizas");
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn("[aviso] No se pudo consultar POLIZAS_API_URL (listarTodas):", err.message);
      return [];
    }
  }
  return getAllPolizasLocal();
}

/**
 * Busca todas las pólizas de un cliente por su cédula (formato "V-12345678").
 * Devuelve siempre un arreglo (vacío si no tiene ninguna, o si la consulta falla —
 * nunca lanza: quien llama decide cómo avisarle al usuario que no se pudo consultar).
 */
async function buscarPorCedula(cedula) {
  if (!cedula) return [];
  if (usingRemoteApi()) {
    try {
      const data = await fetchFromApi(`/polizas?cedula=${encodeURIComponent(cedula)}`);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn("[aviso] No se pudo consultar POLIZAS_API_URL (buscarPorCedula):", err.message);
      return [];
    }
  }
  return getAllPolizasLocal().filter((p) => p.cedula === cedula);
}

/** Busca una póliza puntual por su número (p. ej. "AUTO-2024-001"). Devuelve `null`
 *  si no existe o si la consulta falla. */
async function buscarPorNumero(numero) {
  if (!numero) return null;
  if (usingRemoteApi()) {
    try {
      return await fetchFromApi(`/polizas/${encodeURIComponent(numero)}`);
    } catch (err) {
      console.warn("[aviso] No se pudo consultar POLIZAS_API_URL (buscarPorNumero):", err.message);
      return null;
    }
  }
  return getAllPolizasLocal().find((p) => p.numero === numero) || null;
}

/** Coberturas de una póliza (arreglo de strings), o `[]` si no existe o no tiene. */
async function obtenerCoberturas(numero) {
  const poliza = await buscarPorNumero(numero);
  return poliza && Array.isArray(poliza.coberturas) ? poliza.coberturas : [];
}

/**
 * Calcula el estado de vigencia REAL de una póliza según la fecha de hoy — no confía
 * en el campo `estado` del propio registro (que puede reflejar otra cosa, p. ej. un
 * estado administrativo desincronizado), sino que compara `vigencia_fin` contra la
 * fecha actual. Devuelve `{ vigente, porVencer, vencida, diasRestantes }`:
 *   - `diasRestantes` es negativo si la póliza ya venció.
 *   - `porVencer` es `true` cuando faltan 30 días o menos (y todavía no venció).
 */
function verificarVigencia(poliza) {
  if (!poliza || !poliza.vigencia_fin) {
    return { vigente: false, porVencer: false, vencida: false, diasRestantes: null };
  }
  const fin = new Date(`${poliza.vigencia_fin}T23:59:59`);
  if (Number.isNaN(fin.getTime())) {
    return { vigente: false, porVencer: false, vencida: false, diasRestantes: null };
  }
  const diasRestantes = Math.ceil((fin.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  return {
    vigente: diasRestantes >= 0,
    porVencer: diasRestantes >= 0 && diasRestantes <= 30,
    vencida: diasRestantes < 0,
    diasRestantes,
  };
}

module.exports = {
  listarTodas,
  buscarPorCedula,
  buscarPorNumero,
  obtenerCoberturas,
  verificarVigencia,
  usingRemoteApi,
  invalidateLocalCache,
};
