/**
 * Pruebas de services/siniestros.service.js: apertura de siniestros (numeración,
 * documentos por tipo, ajustador, siniestro mayor), recepción de documentos y cambios
 * desde el panel, incluyendo la persistencia en disco.
 */
const { escribirJson } = require("../helpers/entorno");

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const YEAR = new Date().getFullYear();
process.env.SINIESTROS_FILE = escribirJson("siniestros-prueba.json", {
  siniestros: [
    { numero: `SIN-${YEAR}-0007`, cedula_titular: "V-11111111", fecha_reporte: `${YEAR}-01-10`, estado: "recibido" },
    { numero: `SIN-${YEAR}-0003`, cedula_titular: "V-11111111", fecha_reporte: `${YEAR}-03-10`, estado: "pagado" },
    { numero: "SIN-2020-0099", cedula_titular: "V-22222222", fecha_reporte: "2020-05-01", estado: "rechazado" },
  ],
});

const siniestros = require("../../services/siniestros.service");

function leerDisco() {
  return JSON.parse(fs.readFileSync(process.env.SINIESTROS_FILE, "utf8")).siniestros;
}

describe("consultas", () => {
  test("listarPorCedula devuelve los del cliente, más recientes primero", async () => {
    const lista = await siniestros.listarPorCedula("V-11111111");
    assert.deepEqual(lista.map((s) => s.numero), [`SIN-${YEAR}-0003`, `SIN-${YEAR}-0007`]);
    assert.deepEqual(await siniestros.listarPorCedula(""), []);
  });

  test("consultarEstado devuelve el registro o null", async () => {
    assert.equal((await siniestros.consultarEstado("SIN-2020-0099")).estado, "rechazado");
    assert.equal(await siniestros.consultarEstado("SIN-0000-0000"), null);
  });
});

describe("abrirSiniestro", () => {
  test("asigna el siguiente número correlativo del año en curso", async () => {
    const s = await siniestros.abrirSiniestro({ poliza: "AUTO-1", cedula_titular: "V-11111111", tipo: "robo" });
    assert.equal(s.numero, `SIN-${YEAR}-0008`);
  });

  test("calcula los documentos pendientes según el tipo y queda pendiente de documentación", async () => {
    const s = await siniestros.abrirSiniestro({ tipo: "Hospitalizacion", cedula_titular: "V-3" });
    assert.equal(s.tipo, "hospitalizacion");
    assert.deepEqual(s.documentos_pendientes, siniestros.DOCUMENTOS_POR_TIPO.hospitalizacion);
    assert.equal(s.estado, "pendiente_documentacion");
    assert.deepEqual(s.documentos_recibidos, []);
  });

  test("un tipo sin documentos requeridos queda como 'recibido'", async () => {
    const s = await siniestros.abrirSiniestro({ tipo: "otro" });
    assert.equal(s.estado, "recibido");
    assert.deepEqual(s.documentos_pendientes, []);
  });

  test("marca siniestro mayor solo por encima del umbral", async () => {
    const umbral = siniestros.UMBRAL_SINIESTRO_MAYOR;
    const enUmbral = await siniestros.abrirSiniestro({ tipo: "robo", monto_reclamado: umbral });
    const sobreUmbral = await siniestros.abrirSiniestro({ tipo: "robo", monto_reclamado: umbral + 1 });
    assert.equal(enUmbral.siniestro_mayor, false);
    assert.equal(sobreUmbral.siniestro_mayor, true);
  });

  test("reparte los ajustadores de forma rotativa", async () => {
    const asignados = [];
    for (let i = 0; i < 3; i++) {
      asignados.push((await siniestros.abrirSiniestro({ tipo: "robo" })).ajustador_asignado);
    }
    assert.equal(new Set(asignados).size, 3);
  });

  test("fija la resolución estimada 30 días después del reporte", async () => {
    const s = await siniestros.abrirSiniestro({ tipo: "robo" });
    const dias = (new Date(s.fecha_estimada_resolucion) - new Date(s.fecha_reporte)) / 86_400_000;
    assert.equal(dias, 30);
  });

  test("persiste en disco sin duplicar números", async () => {
    const enDisco = leerDisco();
    const numeros = enDisco.map((s) => s.numero);
    assert.equal(new Set(numeros).size, numeros.length);
    assert.ok(numeros.includes(`SIN-${YEAR}-0008`));
  });

  test("aperturas concurrentes no pierden registros al escribir", async () => {
    const antes = leerDisco().length;
    await Promise.all(Array.from({ length: 5 }, () => siniestros.abrirSiniestro({ tipo: "robo" })));
    assert.equal(leerDisco().length, antes + 5);
  });
});

describe("actualizarDocumentos", () => {
  test("mueve un documento de pendientes a recibidos y pasa a investigación al completarse", async () => {
    const s = await siniestros.abrirSiniestro({ tipo: "robo" }); // denuncia_policial, inventario_bienes
    let act = await siniestros.actualizarDocumentos(s.numero, { documentoRecibido: "denuncia_policial" });
    assert.deepEqual(act.documentos_pendientes, ["inventario_bienes"]);
    assert.deepEqual(act.documentos_recibidos, ["denuncia_policial"]);
    assert.equal(act.estado, "pendiente_documentacion");

    act = await siniestros.actualizarDocumentos(s.numero, { documentoRecibido: "inventario_bienes" });
    assert.deepEqual(act.documentos_pendientes, []);
    assert.equal(act.estado, "en_investigacion");
  });

  test("no duplica un documento recibido dos veces", async () => {
    const s = await siniestros.abrirSiniestro({ tipo: "robo" });
    await siniestros.actualizarDocumentos(s.numero, { documentoRecibido: "denuncia_policial" });
    const act = await siniestros.actualizarDocumentos(s.numero, { documentoRecibido: "denuncia_policial" });
    assert.deepEqual(act.documentos_recibidos, ["denuncia_policial"]);
  });

  test("devuelve null si el siniestro no existe", async () => {
    assert.equal(await siniestros.actualizarDocumentos("SIN-0000-0000", { documentoRecibido: "x" }), null);
  });
});

describe("cambios desde el panel", () => {
  test("asignarAjustador reasigna el ajustador", async () => {
    const s = await siniestros.abrirSiniestro({ tipo: "robo" });
    const act = await siniestros.asignarAjustador(s.numero, "María López");
    assert.equal(act.ajustador_asignado, "María López");
  });

  test("actualizarSiniestro agrega comentarios recortados a 500 caracteres", async () => {
    const s = await siniestros.abrirSiniestro({ tipo: "robo" });
    const act = await siniestros.actualizarSiniestro(s.numero, {
      estado: "aprobado",
      monto_aprobado: 700,
      nuevoComentario: "  " + "x".repeat(600),
    });
    assert.equal(act.estado, "aprobado");
    assert.equal(act.monto_aprobado, 700);
    assert.equal(act.comentarios.length, 1);
    assert.equal(act.comentarios[0].texto.length, 500);
    assert.equal(act.comentarios[0].autor, "admin");
    assert.equal("nuevoComentario" in act, false);
  });
});
