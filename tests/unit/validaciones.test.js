/**
 * Pruebas de validación de entradas y utilidades de seguridad: payload del cotizador,
 * configuración del cotizador, detección real del tipo de archivo subido, nombres de
 * archivo, comparación en tiempo constante, cookies y escape de CSV.
 */
require("../helpers/entorno");

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeQuotePayload,
  validateQuoterConfig,
  detectRealMimeType,
  sanitizeOriginalName,
  formatDurationLabel,
  safeEqual,
  parseCookies,
  csvEscape,
} = require("../../server");

describe("sanitizeQuotePayload", () => {
  const base = { sessionId: "sesion-12345678", quoteId: "q-1234", ramo: "autos", inputs: {}, result: {} };

  test("acepta un payload válido", () => {
    const r = sanitizeQuotePayload(base);
    assert.equal(r.error, undefined);
    assert.equal(r.quoteId, "q-1234");
    assert.equal(r.ramo, "autos");
    assert.equal(r.contact, null);
    assert.equal(r.formalRequest, false);
  });

  test("rechaza quoteId y ramo inválidos", () => {
    assert.ok(sanitizeQuotePayload({ ...base, quoteId: "../x" }).error);
    assert.ok(sanitizeQuotePayload({ ...base, ramo: "vida" }).error);
  });

  test("rechaza inputs/result que no sean objetos", () => {
    assert.ok(sanitizeQuotePayload({ ...base, inputs: [1, 2] }).error);
    assert.ok(sanitizeQuotePayload({ ...base, result: "caro" }).error);
  });

  test("rechaza payloads excesivamente grandes", () => {
    assert.ok(sanitizeQuotePayload({ ...base, inputs: { x: "a".repeat(9000) } }).error);
  });

  test("exige nombre, cédula y un correo válido en la solicitud formal", () => {
    assert.ok(sanitizeQuotePayload({ ...base, contact: { nombre: "Ana" } }).error);
    assert.ok(
      sanitizeQuotePayload({ ...base, contact: { nombre: "Ana", cedula: "V-1234567", correo: "no-es-correo" } }).error
    );
    const ok = sanitizeQuotePayload({
      ...base,
      formalRequest: true,
      contact: { nombre: "  Ana  ", cedula: "V-1234567", correo: "ana@correo.com", extra: "descartado" },
    });
    assert.deepEqual(ok.contact, { nombre: "Ana", cedula: "V-1234567", correo: "ana@correo.com" });
    assert.equal(ok.formalRequest, true);
  });

  test("genera un sessionId nuevo si el enviado no es válido", () => {
    assert.match(sanitizeQuotePayload({ ...base, sessionId: "<script>" }).sessionId, /^[0-9a-f-]{36}$/);
  });
});

describe("validateQuoterConfig", () => {
  const valida = {
    general: {},
    rcv: { tarifas: [], recargos: [] },
    hcm: { rangosEdad: [], sumasAseguradas: [] },
    patrimoniales: { tiposBien: [] },
  };

  test("acepta la configuración real del proyecto", () => {
    assert.equal(validateQuoterConfig(require("../../quoter-config.json")), null);
  });

  test("acepta una configuración mínima válida", () => {
    assert.equal(validateQuoterConfig(valida), null);
  });

  test("rechaza configuraciones sin forma de objeto o con secciones faltantes", () => {
    assert.ok(validateQuoterConfig(null));
    assert.ok(validateQuoterConfig([]));
    const { hcm, ...sinHcm } = valida;
    assert.match(validateQuoterConfig(sinHcm), /hcm/);
    assert.match(validateQuoterConfig({ ...valida, rcv: { tarifas: {}, recargos: [] } }), /rcv\.tarifas/);
  });
});

describe("detectRealMimeType", () => {
  const b = (...bytes) => Buffer.from(bytes);

  test("reconoce los formatos permitidos por su firma binaria", () => {
    assert.equal(detectRealMimeType(b(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
    assert.equal(detectRealMimeType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
    assert.equal(detectRealMimeType(Buffer.from("%PDF-1.7 ...")), "application/pdf");
    assert.equal(detectRealMimeType(b(0x1a, 0x45, 0xdf, 0xa3)), "audio/webm");
    assert.equal(detectRealMimeType(Buffer.from("OggS\0\0")), "audio/ogg");
    assert.equal(detectRealMimeType(Buffer.from("\0\0\0\x20ftypM4A ")), "audio/mp4");
    assert.equal(detectRealMimeType(Buffer.from("ID3\x04")), "audio/mpeg");
  });

  test("rechaza ejecutables, HTML y archivos vacíos aunque traigan extensión de imagen", () => {
    assert.equal(detectRealMimeType(Buffer.from("MZ\x90\0")), null); // .exe de Windows
    assert.equal(detectRealMimeType(Buffer.from("<html><script>alert(1)</script>")), null);
    assert.equal(detectRealMimeType(Buffer.alloc(0)), null);
  });
});

describe("sanitizeOriginalName", () => {
  test("elimina rutas para evitar path traversal", () => {
    assert.equal(sanitizeOriginalName("../../etc/passwd"), "passwd");
  });

  test("elimina caracteres que romperían un header Content-Disposition", () => {
    assert.equal(sanitizeOriginalName('fo"to\r\n.jpg'), "foto.jpg");
  });

  test("repara nombres UTF-8 que llegaron decodificados como Latin-1", () => {
    const comoLlegaDeMulter = Buffer.from("daño.jpg", "utf8").toString("latin1");
    assert.equal(sanitizeOriginalName(comoLlegaDeMulter), "daño.jpg");
  });

  test("limita el largo y usa un nombre por defecto si queda vacío", () => {
    assert.equal(sanitizeOriginalName("a".repeat(300)).length, 150);
    assert.equal(sanitizeOriginalName(""), "archivo");
  });
});

describe("formatDurationLabel", () => {
  test("da formato m:ss", () => {
    assert.equal(formatDurationLabel(0), "0:00");
    assert.equal(formatDurationLabel(65), "1:05");
    assert.equal(formatDurationLabel(-3), "0:00");
    assert.equal(formatDurationLabel("no-numero"), "0:00");
  });
});

describe("safeEqual", () => {
  test("compara correctamente, incluso con longitudes distintas", () => {
    assert.equal(safeEqual("secreto", "secreto"), true);
    assert.equal(safeEqual("secreto", "secretO"), false);
    assert.equal(safeEqual("secreto", "secreto-largo"), false);
    assert.equal(safeEqual("", ""), true);
  });
});

describe("parseCookies", () => {
  test("interpreta varias cookies y decodifica valores", () => {
    const req = { headers: { cookie: "a=1; lo_admin=abc%20def; vacia=; sinigual" } };
    assert.deepEqual(parseCookies(req), { a: "1", lo_admin: "abc def", vacia: "" });
  });

  test("no falla con valores mal codificados ni sin header", () => {
    assert.deepEqual(parseCookies({ headers: { cookie: "x=%E0%A4%A" } }), { x: "%E0%A4%A" });
    assert.deepEqual(parseCookies({ headers: {} }), {});
  });
});

describe("csvEscape", () => {
  test("escapa comas, comillas y saltos de línea", () => {
    assert.equal(csvEscape("simple"), "simple");
    assert.equal(csvEscape("a,b"), '"a,b"');
    assert.equal(csvEscape('dijo "hola"'), '"dijo ""hola"""');
    assert.equal(csvEscape("línea1\nlínea2"), '"línea1\nlínea2"');
    assert.equal(csvEscape(null), "");
  });
});
