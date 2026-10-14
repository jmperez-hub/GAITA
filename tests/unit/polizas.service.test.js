/**
 * Pruebas de services/polizas.service.js: búsquedas sobre el JSON local y cálculo de
 * la vigencia real de una póliza (vigente / por vencer / vencida).
 */
const { escribirJson, fechaRelativa } = require("../helpers/entorno");

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const POLIZAS = [
  { numero: "AUTO-2026-001", cedula: "V-11111111", titular: "Ana", coberturas: ["casco", "rc"], vigencia_fin: fechaRelativa(200) },
  { numero: "HCM-2026-002", cedula: "V-11111111", titular: "Ana", vigencia_fin: fechaRelativa(10) },
  { numero: "AUTO-2025-003", cedula: "V-22222222", titular: "Luis", coberturas: "no-es-arreglo", vigencia_fin: fechaRelativa(-5) },
];
process.env.POLIZAS_FILE = escribirJson("polizas-prueba.json", POLIZAS);

const polizas = require("../../services/polizas.service");

beforeEach(() => polizas.invalidateLocalCache());

describe("búsquedas locales", () => {
  test("usa el JSON local cuando no hay POLIZAS_API_URL", () => {
    assert.equal(polizas.usingRemoteApi(), false);
  });

  test("listarTodas devuelve todas las pólizas", async () => {
    assert.equal((await polizas.listarTodas()).length, 3);
  });

  test("buscarPorCedula filtra por cliente y nunca lanza", async () => {
    assert.deepEqual(
      (await polizas.buscarPorCedula("V-11111111")).map((p) => p.numero),
      ["AUTO-2026-001", "HCM-2026-002"]
    );
    assert.deepEqual(await polizas.buscarPorCedula("V-99999999"), []);
    assert.deepEqual(await polizas.buscarPorCedula(""), []);
  });

  test("buscarPorNumero devuelve la póliza o null", async () => {
    assert.equal((await polizas.buscarPorNumero("AUTO-2025-003")).titular, "Luis");
    assert.equal(await polizas.buscarPorNumero("NO-EXISTE"), null);
    assert.equal(await polizas.buscarPorNumero(null), null);
  });

  test("obtenerCoberturas devuelve [] si la póliza no existe o el campo está mal formado", async () => {
    assert.deepEqual(await polizas.obtenerCoberturas("AUTO-2026-001"), ["casco", "rc"]);
    assert.deepEqual(await polizas.obtenerCoberturas("AUTO-2025-003"), []);
    assert.deepEqual(await polizas.obtenerCoberturas("NO-EXISTE"), []);
  });

  test("tolera un archivo corrupto devolviendo una lista vacía", async () => {
    const fs = require("fs");
    const original = fs.readFileSync(process.env.POLIZAS_FILE, "utf8");
    fs.writeFileSync(process.env.POLIZAS_FILE, "{ esto no es json");
    try {
      polizas.invalidateLocalCache();
      assert.deepEqual(await polizas.listarTodas(), []);
    } finally {
      fs.writeFileSync(process.env.POLIZAS_FILE, original);
    }
  });
});

describe("verificarVigencia", () => {
  test("póliza vigente con más de 30 días restantes", () => {
    const v = polizas.verificarVigencia({ vigencia_fin: fechaRelativa(200) });
    assert.equal(v.vigente, true);
    assert.equal(v.porVencer, false);
    assert.equal(v.vencida, false);
  });

  test("póliza por vencer (30 días o menos)", () => {
    const v = polizas.verificarVigencia({ vigencia_fin: fechaRelativa(10) });
    assert.equal(v.vigente, true);
    assert.equal(v.porVencer, true);
    assert.ok(v.diasRestantes >= 10 && v.diasRestantes <= 11);
  });

  test("una póliza que vence hoy sigue vigente hasta el final del día", () => {
    const v = polizas.verificarVigencia({ vigencia_fin: fechaRelativa(0) });
    assert.equal(v.vigente, true);
    assert.equal(v.vencida, false);
  });

  test("póliza vencida: días restantes negativos", () => {
    const v = polizas.verificarVigencia({ vigencia_fin: fechaRelativa(-5) });
    assert.equal(v.vencida, true);
    assert.equal(v.vigente, false);
    assert.ok(v.diasRestantes < 0);
  });

  test("ignora el campo `estado` del registro y confía solo en la fecha", () => {
    const v = polizas.verificarVigencia({ estado: "vigente", vigencia_fin: fechaRelativa(-1) });
    assert.equal(v.vencida, true);
  });

  test("una póliza que venció ayer ya cuenta como vencida (-1 día), no como vigente", () => {
    // Regresión: Math.ceil sobre el negativo la dejaba en 0 días y "vigente" un día más.
    const v = polizas.verificarVigencia({ vigencia_fin: fechaRelativa(-1) });
    assert.equal(v.diasRestantes, -1);
    assert.equal(v.vigente, false);
  });

  test("datos faltantes o inválidos no se consideran vigentes", () => {
    for (const p of [null, {}, { vigencia_fin: "no-es-fecha" }]) {
      const v = polizas.verificarVigencia(p);
      assert.equal(v.vigente, false);
      assert.equal(v.diasRestantes, null);
    }
  });
});
