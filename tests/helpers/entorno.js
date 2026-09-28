/**
 * tests/helpers/entorno.js
 * Prepara un entorno aislado para cada archivo de pruebas: copia los fixtures de
 * data/ a una carpeta temporal y apunta las variables de entorno (*_FILE, UPLOADS_DIR)
 * hacia ella, para que ninguna prueba lea ni escriba los datos reales del proyecto.
 *
 * DEBE requerirse ANTES que server.js o cualquier servicio: esos módulos leen las rutas
 * de process.env una sola vez, al cargarse. `node --test` ejecuta cada archivo de
 * pruebas en su propio proceso, así que cada archivo obtiene su propia carpeta.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const RAIZ = path.join(__dirname, "..", "..");
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gaita-tests-"));

function copiarFixture(nombre) {
  const destino = path.join(TMP_DIR, nombre);
  fs.copyFileSync(path.join(RAIZ, "data", nombre), destino);
  return destino;
}

/** Escribe un JSON en la carpeta temporal y devuelve su ruta absoluta. */
function escribirJson(nombre, contenido) {
  const destino = path.join(TMP_DIR, nombre);
  fs.writeFileSync(destino, JSON.stringify(contenido, null, 2), "utf8");
  return destino;
}

/** Fecha ISO (AAAA-MM-DD) desplazada `dias` días respecto de hoy. */
function fechaRelativa(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

const quoterConfigTmp = path.join(TMP_DIR, "quoter-config.json");
fs.copyFileSync(path.join(RAIZ, "quoter-config.json"), quoterConfigTmp);

Object.assign(process.env, {
  NODE_ENV: "test",
  ANTHROPIC_API_KEY: "sk-ant-test-no-real",
  ADMIN_PASSWORD: "admin-test-123",
  JWT_SECRET: "jwt-secreto-solo-para-pruebas-0123456789",
  ALLOWED_ORIGINS: "http://localhost:3000",
  POLIZAS_API_URL: "",
  SINIESTROS_API_URL: "",
  POLIZAS_FILE: copiarFixture("polizas.json"),
  SINIESTROS_FILE: copiarFixture("siniestros.json"),
  CORREDORES_FILE: copiarFixture("corredores.json"),
  EMISIONES_FILE: path.join(TMP_DIR, "emisiones.json"),
  CLIENTES_FILE: path.join(TMP_DIR, "clientes.json"),
  CONVERSATIONS_FILE: path.join(TMP_DIR, "conversations.json"),
  QUOTER_CONFIG_FILE: quoterConfigTmp,
  GAPS_CONOCIMIENTO_FILE: path.join(TMP_DIR, "gaps-conocimiento.json"),
  NOTIFICACIONES_PROGRAMADAS_FILE: path.join(TMP_DIR, "notificaciones-programadas.json"),
  UPLOADS_DIR: path.join(TMP_DIR, "uploads"),
});

// Las variables de Twilio/OpenAI/ElevenLabs/SMTP se vacían para que ninguna prueba
// intente contactar un servicio externo real aunque exista un .env local.
for (const k of [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_NUMBER",
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "SMTP_HOST",
]) {
  process.env[k] = "";
}

process.on("exit", () => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

module.exports = { TMP_DIR, escribirJson, fechaRelativa };
