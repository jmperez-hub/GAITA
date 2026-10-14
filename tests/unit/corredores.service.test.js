/**
 * Pruebas de services/corredores.service.js: autenticación de corredores, cartera,
 * pólizas por vencer, comisiones, cotizador profesional (RCV/HCM), PDF y solicitudes
 * de emisión.
 */
const { escribirJson, fechaRelativa } = require("../helpers/entorno");

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const HASH = bcrypt.hashSync("clave-segura", 4);
process.env.CORREDORES_FILE = escribirJson("corredores-prueba.json", {
  corredores: [
    { id: "c-1", nombre: "José Martínez", email: "jose@ejemplo.com", passwordHash: HASH, comisionPorcentaje: 12, activo: true },
    { id: "c-2", nombre: "Inactivo", email: "inactivo@ejemplo.com", passwordHash: HASH, comisionPorcentaje: 10, activo: false },
  ],
});
process.env.POLIZAS_FILE = escribirJson("polizas-corredores.json", [
  { numero: "A-1", cedula: "V-1", titular: "Zoe", corredor: "José Martínez", prima_anual: 1000, ultimo_pago: "2026-01-05", vigencia_fin: fechaRelativa(5) },
  { numero: "A-2", cedula: "V-1", titular: "Zoe", corredor: "José Martínez", prima_anual: 500, ultimo_pago: "2026-01-20", vigencia_fin: fechaRelativa(100) },
  { numero: "A-3", cedula: "V-2", titular: "Ana", corredor: "José Martínez", prima_anual: 300, ultimo_pago: "2026-03-01", vigencia_fin: fechaRelativa(-3) },
  { numero: "A-4", cedula: "V-3", titular: "Otro", corredor: "Otra Persona", prima_anual: 9999, ultimo_pago: "2026-03-01", vigencia_fin: fechaRelativa(1) },
  { numero: "A-5", cedula: "V-2", titular: "Ana", corredor: "José Martínez", prima_anual: "malo", ultimo_pago: 20260301, vigencia_fin: fechaRelativa(50) },
]);
process.env.SINIESTROS_FILE = escribirJson("siniestros-corredores.json", {
  siniestros: [
    { numero: "S-1", cedula_titular: "V-1", estado: "en_investigacion" },
    { numero: "S-2", cedula_titular: "V-2", estado: "pagado" },
    { numero: "S-3", cedula_titular: "V-3", estado: "recibido" },
  ],
});

const corredores = require("../../services/corredores.service");
const quoterConfig = require("../../quoter-config.json");

describe("autenticar", () => {
  test("devuelve el perfil público (sin passwordHash) con credenciales correctas", async () => {
    const c = await corredores.autenticar("JOSE@ejemplo.com ", "clave-segura");
    assert.equal(c.id, "c-1");
    assert.equal("passwordHash" in c, false);
  });

  test("devuelve null con contraseña incorrecta, cuenta inexistente o desactivada", async () => {
    assert.equal(await corredores.autenticar("jose@ejemplo.com", "otra"), null);
    assert.equal(await corredores.autenticar("nadie@ejemplo.com", "clave-segura"), null);
    assert.equal(await corredores.autenticar("inactivo@ejemplo.com", "clave-segura"), null);
    assert.equal(await corredores.autenticar(undefined, undefined), null);
  });

  test("listarTodosCorredores solo incluye cuentas activas y sin hash", () => {
    const lista = corredores.listarTodosCorredores();
    assert.deepEqual(lista.map((c) => c.id), ["c-1"]);
    assert.equal("passwordHash" in lista[0], false);
  });

  test("hashPassword produce un hash bcrypt verificable", async () => {
    const hash = await corredores.hashPassword("abc");
    assert.ok(await bcrypt.compare("abc", hash));
  });
});

describe("cartera y alertas", () => {
  test("listarCartera agrupa por cédula solo las pólizas del corredor, ordenadas por nombre", async () => {
    const cartera = await corredores.listarCartera("José Martínez");
    assert.deepEqual(cartera.map((c) => c.cedula), ["V-2", "V-1"]);
    assert.equal(cartera[1].polizas.length, 2);
    assert.ok(cartera[1].polizas.every((p) => p.vigencia));
  });

  test("polizasPorVencer incluye vencidas y por vencer dentro del límite, ordenadas por urgencia", async () => {
    const lista = await corredores.polizasPorVencer("José Martínez");
    assert.deepEqual(lista.map((p) => p.numero), ["A-3", "A-1"]);
    const en7 = await corredores.polizasPorVencer("José Martínez", 7);
    assert.deepEqual(en7.map((p) => p.numero), ["A-3", "A-1"]);
    const en3 = await corredores.polizasPorVencer("José Martínez", 3);
    assert.deepEqual(en3.map((p) => p.numero), ["A-3"]);
  });

  test("siniestrosDeCartera devuelve solo los de clientes del corredor y marca los abiertos", async () => {
    const lista = await corredores.siniestrosDeCartera("José Martínez");
    assert.deepEqual(
      lista.map((s) => [s.numero, s.abierto]),
      [
        ["S-1", true],
        ["S-2", false],
      ]
    );
  });
});

describe("calcularComision", () => {
  const corredor = { nombre: "José Martínez", comisionPorcentaje: 12 };

  test("agrupa por mes de último pago y omite registros mal formados", async () => {
    const r = await corredores.calcularComision(corredor);
    assert.equal(r.comisionPorcentaje, 12);
    assert.deepEqual(
      r.desglose.map((m) => [m.mes, m.total]),
      [
        ["2026-03", 36],
        ["2026-01", 180],
      ]
    );
    assert.equal(r.totalAcumulado, 216);
  });

  test("filtra por rango de meses", async () => {
    const r = await corredores.calcularComision(corredor, { desde: "2026-02", hasta: "2026-03" });
    assert.deepEqual(r.desglose.map((m) => m.mes), ["2026-03"]);
    assert.equal(r.totalAcumulado, 36);
  });

  test("sin porcentaje la comisión es cero", async () => {
    const r = await corredores.calcularComision({ nombre: "José Martínez" });
    assert.equal(r.totalAcumulado, 0);
  });
});

describe("cotizarRcv", () => {
  const cfg = quoterConfig.rcv;

  test("calcula la prima base nacional sin rebaja ni recargos", () => {
    const r = corredores.cotizarRcv({ tipoId: "particular-liviano", placaId: "nacional", usoId: "conLucro" }, cfg);
    assert.equal(r.primaFinal, 33);
    assert.equal(r.rebajaPct, 0);
    assert.equal(r.placaLabel, "Nacional");
  });

  test("usa las columnas de placa extranjera", () => {
    const r = corredores.cotizarRcv({ tipoId: "particular-liviano", placaId: "extranjera" }, cfg);
    assert.equal(r.primaFinal, 120);
    assert.equal(r.placaLabel, "Extranjera");
  });

  test("aplica recargos acumulativos sobre la prima", () => {
    const r = corredores.cotizarRcv(
      { tipoId: "particular-liviano", placaId: "nacional", recargoIds: ["remolqueOcasional", "vehiculoOficial", "inexistente"] },
      cfg
    );
    assert.equal(r.totalRecargoPct, 80);
    assert.equal(r.primaFinal, 59.4);
    assert.equal(r.recargosAplicados.length, 2);
  });

  test("aplica la rebaja sin fines de lucro solo a tarifas que la admiten", () => {
    const conRebaja = cfg.tarifas.find((t) => t.aplicaRebajaSinLucro);
    assert.ok(conRebaja, "el fixture debe tener al menos una tarifa con rebaja");
    const r = corredores.cotizarRcv({ tipoId: conRebaja.id, placaId: "nacional", usoId: "sinLucro" }, cfg);
    assert.equal(r.rebajaPct, cfg.rebajaSinLucroPct);
    assert.equal(r.primaFinal, Math.round(conRebaja.nacional.prima * (1 - cfg.rebajaSinLucroPct / 100) * 100) / 100);

    const sin = corredores.cotizarRcv({ tipoId: "particular-liviano", placaId: "nacional", usoId: "sinLucro" }, cfg);
    assert.equal(sin.rebajaPct, 0);
  });

  test("devuelve null con tarifa desconocida", () => {
    assert.equal(corredores.cotizarRcv({ tipoId: "no-existe", placaId: "nacional" }, cfg), null);
  });
});

describe("cotizarHcm", () => {
  const cfg = quoterConfig.hcm;

  test("suma la tasa del titular y de cada beneficiario según su rango de edad", () => {
    const r = corredores.cotizarHcm({ sumaId: "10000", titularAge: 35, beneficiarioAges: [5, 22] }, cfg);
    assert.equal(r.total, 764 + 464 + 715);
    assert.equal(r.titular.bandLabel, "30 a 39 años");
    assert.equal(r.sumaLabel, "USD 10.000");
  });

  test("devuelve null si alguna edad no cae en ningún rango o la suma no existe", () => {
    assert.equal(corredores.cotizarHcm({ sumaId: "10000", titularAge: 200 }, cfg), null);
    assert.equal(corredores.cotizarHcm({ sumaId: "10000", titularAge: 30, beneficiarioAges: [-1] }, cfg), null);
    assert.equal(corredores.cotizarHcm({ sumaId: "999", titularAge: 30 }, cfg), null);
  });
});

describe("PDF y documentos", () => {
  test("generarCotizacionPdf devuelve un PDF válido", async () => {
    const resultado = corredores.cotizarRcv({ tipoId: "particular-liviano", placaId: "nacional" }, quoterConfig.rcv);
    const pdf = await corredores.generarCotizacionPdf({
      companyName: "Aseguradora Prueba",
      cliente: { nombre: "Zoe", cedula: "V-1" },
      corredor: { nombre: "José", email: "jose@ejemplo.com" },
      resultado,
      inputs: {},
      numero: "COT-TEST-1",
    });
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.toString("ascii", 0, 5), "%PDF-");
  });

  test("el catálogo de documentos genera PDFs y rechaza claves desconocidas", async () => {
    const docs = corredores.listarDocumentos();
    assert.ok(docs.length >= 3);
    const pdf = await corredores.generarDocumentoPdf(docs[0].key, "Aseguradora Prueba");
    assert.equal(pdf.toString("ascii", 0, 5), "%PDF-");
    assert.equal(corredores.generarDocumentoPdf("../etc/passwd", "X"), null);
  });
});

describe("solicitudes de emisión", () => {
  test("crea solicitudes correlativas pendientes de aprobación y las lista por corredor", async () => {
    const e1 = await corredores.crearEmision({ corredorId: "c-1", cliente: { nombre: "Zoe" }, ramo: "automoviles" });
    const e2 = await corredores.crearEmision({ corredorId: "c-2", ramo: "hcm" });
    const year = new Date().getFullYear();
    assert.equal(e1.id, `EMI-${year}-0001`);
    assert.equal(e2.id, `EMI-${year}-0002`);
    assert.equal(e1.estado, "pendiente_aprobacion");
    assert.deepEqual((await corredores.listarEmisionesPorCorredor("c-1")).map((e) => e.id), [e1.id]);
    assert.equal((await corredores.listarTodasEmisiones()).length, 2);
  });

  test("al aprobar/rechazar registra la fecha de resolución una sola vez", async () => {
    const e = await corredores.crearEmision({ corredorId: "c-1", ramo: "hcm" });
    const aprobada = await corredores.actualizarEmision(e.id, { estado: "aprobada", notasAdmin: "ok" });
    assert.ok(aprobada.resueltoEn);
    const primera = aprobada.resueltoEn;
    const otra = await corredores.actualizarEmision(e.id, { estado: "rechazada" });
    assert.equal(otra.resueltoEn, primera);
    assert.equal(await corredores.actualizarEmision("EMI-0000-0000", { estado: "aprobada" }), null);
  });
});
