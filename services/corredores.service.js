/**
 * corredores.service.js
 * Lógica de negocio del portal de corredores (/corredor): autenticación, cartera de
 * clientes, pólizas por vencer, siniestros de la cartera, comisiones, cotizador
 * profesional (con PDF formal), documentos descargables y solicitudes de emisión.
 *
 * Se apoya en polizasService y siniestrosService (nunca duplica esos datos) — la
 * "cartera" de un corredor se deriva en tiempo real filtrando `poliza.corredor` (un
 * nombre, mismo campo ya usado en data/polizas.json), no es una lista aparte que haya
 * que mantener sincronizada. Las cuentas de corredor SÍ son propias de este servicio
 * (data/corredores.json — email/contraseña, comisión), igual que las solicitudes de
 * emisión (data/emisiones.json).
 *
 * Autenticación JWT: este servicio expone `autenticar()` (verifica credenciales) pero
 * NO firma/valida tokens — eso es responsabilidad de la capa de transporte (ver
 * requireCorredorAuth en server.js), igual criterio que separar polizasService de la
 * sesión de administrador.
 */

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const PDFDocument = require("pdfkit");

const polizasService = require("./polizas.service");
const siniestrosService = require("./siniestros.service");

const CORREDORES_FILE = process.env.CORREDORES_FILE
  ? path.resolve(__dirname, "..", process.env.CORREDORES_FILE)
  : path.join(__dirname, "..", "data", "corredores.json");

const EMISIONES_FILE = process.env.EMISIONES_FILE
  ? path.resolve(__dirname, "..", process.env.EMISIONES_FILE)
  : path.join(__dirname, "..", "data", "emisiones.json");

// Umbral (en días) para "póliza por vencer" en las alertas del portal — mismo criterio
// que polizasService.verificarVigencia() (30 días), pero el dashboard también expone
// un umbral más corto (7 días) para las notificaciones en tiempo real (ver server.js).
const DIAS_POR_VENCER_DEFECTO = 30;

// ---------------------------------------------------------------------------
// Cuentas de corredor (data/corredores.json) — caché en memoria + cola de escritura
// serializada, mismo patrón que clientes.json/siniestros.json.
// ---------------------------------------------------------------------------

let corredoresCache = null;
let corredoresWriteQueue = Promise.resolve();

function loadCorredoresFromDisk() {
  try {
    const raw = fs.readFileSync(CORREDORES_FILE, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : { corredores: [] };
    return Array.isArray(parsed.corredores) ? parsed.corredores : [];
  } catch (err) {
    console.error(`[aviso] No se pudo leer ${path.basename(CORREDORES_FILE)}, se iniciará vacío:`, err.message);
    return [];
  }
}

function getAllCorredoresLocal() {
  if (!corredoresCache) corredoresCache = loadCorredoresFromDisk();
  return corredoresCache;
}

function persistCorredores() {
  corredoresWriteQueue = corredoresWriteQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify({ corredores: getAllCorredoresLocal() }, null, 2);
        fs.writeFile(CORREDORES_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar corredores.json:", err.message);
          resolve();
        });
      })
  );
  return corredoresWriteQueue;
}

/** Perfil público de un corredor (sin `passwordHash`) — lo que se manda al cliente. */
function toPublicCorredor(c) {
  if (!c) return null;
  const { passwordHash, ...pub } = c;
  return pub;
}

function buscarPorId(id) {
  return getAllCorredoresLocal().find((c) => c.id === id) || null;
}

function buscarPorEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return getAllCorredoresLocal().find((c) => c.email.toLowerCase() === normalized) || null;
}

/** Busca por nombre EXACTO — es el valor que usa `poliza.corredor` en data/polizas.json,
 *  así que este es el puente entre "una póliza quedó asignada a este nombre" y "la
 *  cuenta de corredor correspondiente" (ver notificaciones en tiempo real en server.js:
 *  al abrirse un siniestro, hay que ubicar a qué corredor avisarle). */
function buscarPorNombre(nombre) {
  return getAllCorredoresLocal().find((c) => c.nombre === nombre) || null;
}

/** Todas las cuentas de corredor activas (perfil público, sin `passwordHash`) — usado
 *  por el chequeo periódico de "pólizas por vencer en 7 días" (ver server.js), que
 *  necesita recorrerlas todas, no una en particular. */
function listarTodosCorredores() {
  return getAllCorredoresLocal()
    .filter((c) => c.activo)
    .map(toPublicCorredor);
}

/** Verifica email/contraseña. Devuelve el perfil PÚBLICO del corredor si son
 *  correctos y la cuenta está activa, o `null` en cualquier otro caso (usuario no
 *  encontrado, contraseña incorrecta, cuenta desactivada) — nunca distingue el motivo
 *  en la respuesta (evita filtrar si un email existe o no). */
// Hash de relleno (contraseña inventada, sin cuenta asociada) — se usa cuando el email
// no existe o la cuenta está desactivada, para que bcrypt.compare() se ejecute IGUAL en
// ese caso: si no, un email inexistente responde en <1ms mientras que uno válido con
// contraseña incorrecta paga el costo de bcrypt (~50-100ms), un canal de temporización
// que permite enumerar cuentas válidas midiendo la latencia de la respuesta.
const DUMMY_PASSWORD_HASH = "$2a$10$/c4jmJNb6gN6hXwM.RHmQeS5qFcV1K7OvdNY7lhfxFmqvRK3wXmqm";

async function autenticar(email, password) {
  const corredor = buscarPorEmail(email);
  const cuentaValida = Boolean(corredor && corredor.activo);
  const hashParaComparar = cuentaValida ? corredor.passwordHash : DUMMY_PASSWORD_HASH;
  const ok = await bcrypt.compare(String(password || ""), hashParaComparar);
  if (!cuentaValida || !ok) return null;
  return toPublicCorredor(corredor);
}

/** Hashea una contraseña nueva (bcrypt, 10 rondas) — utilidad para crear/editar
 *  cuentas de corredor a mano en data/corredores.json; no hay endpoint de alta todavía. */
async function hashPassword(plain) {
  return bcrypt.hash(String(plain || ""), 10);
}

// ---------------------------------------------------------------------------
// Cartera, pólizas por vencer, siniestros — derivados de polizasService /
// siniestrosService filtrando por el campo `corredor` (nombre) de cada póliza.
// ---------------------------------------------------------------------------

/** Todas las pólizas asignadas a este corredor (por nombre — mismo valor que el
 *  campo `corredor` de data/polizas.json). */
async function polizasDelCorredor(nombreCorredor) {
  const todas = await polizasService.listarTodas();
  return todas.filter((p) => p.corredor === nombreCorredor);
}

/**
 * Cartera de clientes del corredor: un registro por cédula (puede tener varias
 * pólizas), con sus pólizas y la vigencia real de cada una. Se deriva de las pólizas
 * mismas (campo `titular`) — no depende de que el cliente se haya identificado nunca
 * con Lucy, a diferencia de la memoria persistente de clientes del chatbot.
 */
async function listarCartera(nombreCorredor) {
  const polizas = await polizasDelCorredor(nombreCorredor);
  const porCedula = new Map();
  for (const p of polizas) {
    const vigencia = polizasService.verificarVigencia(p);
    if (!porCedula.has(p.cedula)) {
      porCedula.set(p.cedula, { cedula: p.cedula, nombre: p.titular, polizas: [] });
    }
    porCedula.get(p.cedula).polizas.push({ ...p, vigencia });
  }
  return Array.from(porCedula.values()).sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/** Pólizas de la cartera que vencen dentro de `diasLimite` días (por defecto 30 —
 *  "este mes"), o que ya vencieron — cada una marcada con su `vigencia` real. */
async function polizasPorVencer(nombreCorredor, diasLimite) {
  const limite = Number.isFinite(diasLimite) ? diasLimite : DIAS_POR_VENCER_DEFECTO;
  const polizas = await polizasDelCorredor(nombreCorredor);
  return polizas
    .map((p) => ({ ...p, vigencia: polizasService.verificarVigencia(p) }))
    .filter((p) => p.vigencia.vencida || (p.vigencia.porVencer && p.vigencia.diasRestantes <= limite))
    .sort((a, b) => a.vigencia.diasRestantes - b.vigencia.diasRestantes);
}

/** Siniestros de los clientes en la cartera del corredor (por cédula del titular),
 *  cada uno marcado con `abierto` (no está en un estado final: rechazado o pagado). */
async function siniestrosDeCartera(nombreCorredor) {
  const polizas = await polizasDelCorredor(nombreCorredor);
  const cedulas = new Set(polizas.map((p) => p.cedula));
  const todos = await siniestrosService.listarTodos();
  return todos
    .filter((s) => cedulas.has(s.cedula_titular))
    .map((s) => ({ ...s, abierto: s.estado !== "rechazado" && s.estado !== "pagado" }));
}

/**
 * Comisión acumulada del corredor, agrupada por mes de `ultimo_pago` de cada póliza de
 * su cartera — simplificación deliberada e ilustrativa (no hay un sistema real de
 * liquidación de comisiones): se reconoce el 100% de `prima_anual * comisionPorcentaje`
 * en el mes del último pago registrado. `desde`/`hasta` (formato "AAAA-MM", opcionales)
 * filtran el rango de meses.
 */
async function calcularComision(corredor, { desde, hasta } = {}) {
  const polizas = await polizasDelCorredor(corredor.nombre);
  const pct = Number(corredor.comisionPorcentaje) || 0;

  const porMes = new Map();
  for (const p of polizas) {
    // `p` puede venir de POLIZAS_API_URL (una API externa, en el futuro) — nunca se
    // confía en que sus campos tengan el tipo/formato esperado. Un registro malformado
    // (p. ej. `ultimo_pago` como número en vez de string) no debe tumbar TODO el
    // cálculo de comisión — se salta ese registro y se sigue con el resto.
    try {
      if (!p.ultimo_pago) continue;
      const mes = String(p.ultimo_pago).slice(0, 7); // "AAAA-MM"
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      if (desde && mes < desde) continue;
      if (hasta && mes > hasta) continue;
      const primaAnual = Number(p.prima_anual);
      if (!Number.isFinite(primaAnual)) continue;
      const monto = Math.round(primaAnual * (pct / 100) * 100) / 100;
      if (!porMes.has(mes)) porMes.set(mes, { mes, total: 0, polizas: [] });
      const entry = porMes.get(mes);
      entry.total = Math.round((entry.total + monto) * 100) / 100;
      entry.polizas.push({ numero: p.numero, titular: p.titular, prima_anual: primaAnual, comision: monto });
    } catch (err) {
      console.warn("[aviso] Póliza con datos inválidos, se omite del cálculo de comisión:", p && p.numero, err.message);
    }
  }

  const desglose = Array.from(porMes.values()).sort((a, b) => b.mes.localeCompare(a.mes));
  const totalAcumulado = Math.round(desglose.reduce((sum, m) => sum + m.total, 0) * 100) / 100;
  return { comisionPorcentaje: pct, totalAcumulado, desglose };
}

// ---------------------------------------------------------------------------
// Cotizador profesional — mismas fórmulas que el cotizador del cliente (RCV/HCM,
// ver computeRcv/computeHcm en public/chatbot.js), reimplementadas aquí porque ahí
// corren en el navegador y este cotizador necesita calcular en el SERVIDOR (para
// poder generar un PDF formal confiable, no basado en un monto que mande el cliente).
// Si cambias las tarifas o la fórmula, revisa también chatbot.js para no desincronizarlos.
// ---------------------------------------------------------------------------

function cotizarRcv(inputs, cfg) {
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
    ramo: "automoviles",
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

function findAgeBand(age, rangos) {
  return (rangos || []).find((r) => age >= r.min && age <= r.max) || null;
}

function cotizarHcm(inputs, cfg) {
  const sumaId = inputs.sumaId;
  const titularBand = findAgeBand(inputs.titularAge, cfg.rangosEdad);
  const titularRate = titularBand ? titularBand.rates[sumaId] : null;

  const beneficiarios = (inputs.beneficiarioAges || []).map((age) => {
    const band = findAgeBand(age, cfg.rangosEdad);
    return { age, bandLabel: band ? band.label : null, rate: band ? band.rates[sumaId] : null };
  });

  if (titularRate == null || beneficiarios.some((b) => b.rate == null)) return null;

  const total = titularRate + beneficiarios.reduce((sum, b) => sum + b.rate, 0);
  const sumaOption = (cfg.sumasAseguradas || []).find((s) => s.id === sumaId);

  return {
    ramo: "hcm",
    titular: { age: inputs.titularAge, bandLabel: titularBand.label, rate: titularRate },
    beneficiarios,
    total: Math.round(total * 100) / 100,
    sumaLabel: sumaOption ? sumaOption.label : sumaId,
    currencyLabel: cfg.currencyLabel || "USD",
  };
}

// ---------------------------------------------------------------------------
// PDF (pdfkit) — cotización formal con membrete, y documentos de referencia
// (condicionados generales, tarifario, formulario de siniestro) generados al vuelo.
// ---------------------------------------------------------------------------

const LO_VERDE = "#00bf63";
const LO_GRIS = "#7f8083";

function pdfHeader(doc, companyName, subtitle) {
  doc.rect(0, 0, doc.page.width, 90).fill(LO_VERDE);
  doc
    .fillColor("#ffffff")
    .fontSize(20)
    .font("Helvetica-Bold")
    .text(companyName, 50, 28);
  doc
    .fontSize(11)
    .font("Helvetica")
    .text(subtitle, 50, 55);
  doc.fillColor("#000000").moveDown(3);
  doc.y = 110;
}

function pdfFooter(doc, companyName) {
  const bottom = doc.page.height - 50;
  doc
    .fontSize(8)
    .fillColor(LO_GRIS)
    .text(
      `${companyName} · Regulada por la Superintendencia de la Actividad Aseguradora (SUDEASEG), código ES-51.`,
      50,
      bottom,
      { align: "center", width: doc.page.width - 100 }
    );
}

/**
 * Genera el PDF formal de una cotización profesional (cotizador de corredores) — con
 * membrete de la compañía, datos del cliente, desglose del cálculo y los datos del
 * corredor que la emite. Devuelve un Buffer (no escribe a disco: se sirve directo en
 * la respuesta HTTP, ver POST /api/corredor/cotizar en server.js).
 */
function generarCotizacionPdf({ companyName, cliente, corredor, resultado, inputs, numero }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    pdfHeader(doc, companyName, "Cotización formal de seguro");

    doc.fontSize(14).font("Helvetica-Bold").text(`Cotización N.º ${numero}`, 50, 120);
    doc.fontSize(9).font("Helvetica").fillColor(LO_GRIS).text(`Emitida el ${new Date().toISOString().slice(0, 10)}`);
    doc.moveDown(1);

    doc.fillColor("#000000").fontSize(11).font("Helvetica-Bold").text("Cliente");
    doc.font("Helvetica").fontSize(10);
    doc.text(`Nombre: ${cliente.nombre || "—"}`);
    doc.text(`Cédula: ${cliente.cedula || "—"}`);
    if (cliente.vehiculo) doc.text(`Vehículo: ${cliente.vehiculo}`);
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(11).text("Corredor");
    doc.font("Helvetica").fontSize(10);
    doc.text(`${corredor.nombre} · ${corredor.email}`);
    doc.moveDown(1);

    doc.font("Helvetica-Bold").fontSize(12).text(resultado.ramo === "hcm" ? "Detalle — HCM" : "Detalle — Automóviles (RCV)");
    doc.moveDown(0.3);

    const rows = [];
    if (resultado.ramo === "hcm") {
      rows.push(["Suma asegurada", resultado.sumaLabel]);
      rows.push([`Titular (${resultado.titular.age} años · ${resultado.titular.bandLabel})`, money(resultado.titular.rate, resultado.currencyLabel)]);
      resultado.beneficiarios.forEach((b, i) => {
        rows.push([`Beneficiario ${i + 1} (${b.age} años · ${b.bandLabel})`, money(b.rate, resultado.currencyLabel)]);
      });
      rows.push(["Prima anual total", money(resultado.total, resultado.currencyLabel)]);
    } else {
      rows.push(["Tipo de vehículo", resultado.tarifaLabel]);
      rows.push(["Origen de placa", resultado.placaLabel]);
      rows.push(["Cobertura — daños a cosas", money(resultado.cosas, resultado.currencyLabel)]);
      rows.push(["Cobertura — daños a personas", money(resultado.personas, resultado.currencyLabel)]);
      rows.push(["Prima anual base", money(resultado.primaBase, resultado.currencyLabel)]);
      if (resultado.rebajaPct > 0) rows.push([`Rebaja sin fines de lucro (-${resultado.rebajaPct}%)`, `- ${money(resultado.rebajaMonto, resultado.currencyLabel)}`]);
      if (resultado.totalRecargoPct > 0) rows.push([`Recargos (+${resultado.totalRecargoPct}%)`, `+ ${money(resultado.montoRecargo, resultado.currencyLabel)}`]);
      rows.push(["Prima anual final", money(resultado.primaFinal, resultado.currencyLabel)]);
    }

    doc.font("Helvetica").fontSize(10);
    rows.forEach(([label, value]) => {
      doc.text(label, 50, doc.y, { continued: true, width: 350 });
      doc.text(value, { align: "right" });
    });

    doc.moveDown(2);
    doc
      .fontSize(8)
      .fillColor(LO_GRIS)
      .text(
        "Esta cotización es un estimado referencial válido por 15 días, sujeto a inspección y aprobación final de suscripción. No constituye una póliza vigente.",
        { width: doc.page.width - 100 }
      );

    pdfFooter(doc, companyName);
    doc.end();
  });
}

function money(amount, currency) {
  if (amount == null) return "—";
  return `${Number(amount).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency || ""}`.trim();
}

// Catálogo mínimo de documentos de referencia descargables desde el portal — placeholders
// generados al vuelo (sin depender de archivos binarios versionados, mismo espíritu que
// el resto de este proyecto evita comitear binarios generados). Un documento real de
// La Occidental reemplazaría este generador por el archivo real (o un enlace a él).
const DOCUMENTOS_CATALOGO = {
  "condicionado-autos": { titulo: "Condiciones Generales — Automóviles (RCV)", ramo: "Automóviles" },
  "condicionado-hcm": { titulo: "Condiciones Generales — HCM", ramo: "Personas (HCM)" },
  "condicionado-patrimoniales": { titulo: "Condiciones Generales — Patrimoniales", ramo: "Patrimoniales" },
  tarifario: { titulo: "Tarifario vigente", ramo: "Todos los ramos" },
  "formulario-siniestro": { titulo: "Formulario de declaración de siniestro", ramo: "Todos los ramos" },
};

function listarDocumentos() {
  return Object.entries(DOCUMENTOS_CATALOGO).map(([key, doc]) => ({ key, ...doc }));
}

/** Genera el PDF placeholder de un documento del catálogo — `null` si `key` no existe. */
function generarDocumentoPdf(key, companyName) {
  const doc = DOCUMENTOS_CATALOGO[key];
  if (!doc) return null;
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    pdfHeader(pdf, companyName, doc.ramo);
    pdf.fontSize(16).font("Helvetica-Bold").text(doc.titulo, 50, 120);
    pdf.moveDown(1);
    pdf
      .fontSize(10)
      .font("Helvetica")
      .fillColor(LO_GRIS)
      .text(
        "Documento de referencia (placeholder) generado por el portal de corredores. Sustituye este " +
          "generador por el archivo real de la compañía cuando esté disponible — ver DOCUMENTOS_CATALOGO " +
          "en services/corredores.service.js.",
        { width: pdf.page.width - 100 }
      );
    pdfFooter(pdf, companyName);
    pdf.end();
  });
}

// ---------------------------------------------------------------------------
// Solicitudes de emisión (data/emisiones.json) — "iniciar emisión de nueva póliza",
// quedan en estado "pendiente_aprobacion" hasta que gerencia las revisa desde /admin.
// ---------------------------------------------------------------------------

let emisionesCache = null;
let emisionesWriteQueue = Promise.resolve();

function loadEmisionesFromDisk() {
  try {
    const raw = fs.readFileSync(EMISIONES_FILE, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : { emisiones: [] };
    return Array.isArray(parsed.emisiones) ? parsed.emisiones : [];
  } catch (err) {
    console.error(`[aviso] No se pudo leer ${path.basename(EMISIONES_FILE)}, se iniciará vacío:`, err.message);
    return [];
  }
}

function getAllEmisionesLocal() {
  if (!emisionesCache) emisionesCache = loadEmisionesFromDisk();
  return emisionesCache;
}

function persistEmisiones() {
  emisionesWriteQueue = emisionesWriteQueue.then(
    () =>
      new Promise((resolve) => {
        const data = JSON.stringify({ emisiones: getAllEmisionesLocal() }, null, 2);
        fs.writeFile(EMISIONES_FILE, data, "utf8", (err) => {
          if (err) console.error("Error al guardar emisiones.json:", err.message);
          resolve();
        });
      })
  );
  return emisionesWriteQueue;
}

function generarNumeroEmision() {
  const year = new Date().getFullYear();
  const prefijo = `EMI-${year}-`;
  const existentes = getAllEmisionesLocal()
    .map((e) => e.id)
    .filter((id) => typeof id === "string" && id.startsWith(prefijo))
    .map((id) => parseInt(id.slice(prefijo.length), 10))
    .filter((n) => !Number.isNaN(n));
  const siguiente = (existentes.length ? Math.max(...existentes) : 0) + 1;
  return `${prefijo}${String(siguiente).padStart(4, "0")}`;
}

/** Crea una solicitud de emisión de póliza nueva — `datos` = { corredorId, cliente:
 *  {nombre, cedula, telefono?}, ramo, detalle: {...específico del ramo} }. Siempre
 *  queda en estado "pendiente_aprobacion". */
async function crearEmision(datos) {
  const nueva = {
    id: generarNumeroEmision(),
    corredorId: datos.corredorId,
    cliente: datos.cliente || {},
    ramo: datos.ramo || "",
    detalle: datos.detalle || {},
    estado: "pendiente_aprobacion",
    creadoEn: new Date().toISOString(),
    resueltoEn: null,
    notasAdmin: "",
  };
  getAllEmisionesLocal().push(nueva);
  await persistEmisiones();
  return nueva;
}

async function listarEmisionesPorCorredor(corredorId) {
  return getAllEmisionesLocal()
    .filter((e) => e.corredorId === corredorId)
    .sort((a, b) => new Date(b.creadoEn) - new Date(a.creadoEn));
}

async function listarTodasEmisiones() {
  return [...getAllEmisionesLocal()].sort((a, b) => new Date(b.creadoEn) - new Date(a.creadoEn));
}

async function buscarEmision(id) {
  return getAllEmisionesLocal().find((e) => e.id === id) || null;
}

/** Aprueba/rechaza (o edita) una solicitud de emisión — uso: panel /admin. `patch`
 *  puede incluir `estado` ("aprobada" | "rechazada") y `notasAdmin`. Marca
 *  `resueltoEn` automáticamente al pasar a un estado distinto de "pendiente_aprobacion". */
async function actualizarEmision(id, patch) {
  const emision = getAllEmisionesLocal().find((e) => e.id === id);
  if (!emision) return null;
  Object.assign(emision, patch);
  if (patch.estado && patch.estado !== "pendiente_aprobacion" && !emision.resueltoEn) {
    emision.resueltoEn = new Date().toISOString();
  }
  await persistEmisiones();
  return emision;
}

module.exports = {
  toPublicCorredor,
  buscarPorId,
  buscarPorEmail,
  buscarPorNombre,
  listarTodosCorredores,
  autenticar,
  hashPassword,
  listarCartera,
  polizasPorVencer,
  siniestrosDeCartera,
  calcularComision,
  cotizarRcv,
  cotizarHcm,
  generarCotizacionPdf,
  listarDocumentos,
  generarDocumentoPdf,
  crearEmision,
  listarEmisionesPorCorredor,
  listarTodasEmisiones,
  buscarEmision,
  actualizarEmision,
  DIAS_POR_VENCER_DEFECTO,
};
