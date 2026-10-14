/**
 * Pruebas de identificación del cliente y verificación de identidad (OTP):
 * cédula venezolana, número de póliza, ocultamiento de correo, código OTP y la
 * confianza implícita del canal WhatsApp.
 */
require("../helpers/entorno");

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCedula,
  extractPoliza,
  extractIdentification,
  wantsToSkipIdentification,
  ocultarEmail,
  generarCodigoOtp,
  esIdentidadYaVerificadaPorCanal,
} = require("../../server");

describe("normalizeCedula", () => {
  test("acepta las variantes habituales y devuelve la forma canónica V-12345678", () => {
    for (const entrada of ["V-12345678", "v12345678", "V.12345678", "V 12345678", "mi cédula es v-12345678"]) {
      assert.equal(normalizeCedula(entrada), "V-12345678", entrada);
    }
  });

  test("reconoce extranjeros (E) y RIF (J/G)", () => {
    assert.equal(normalizeCedula("e-8765432"), "E-8765432");
    assert.equal(normalizeCedula("J-123456789"), "J-123456789");
    assert.equal(normalizeCedula("g 20000123"), "G-20000123");
  });

  test("rechaza textos sin cédula o con una cantidad de dígitos fuera de rango", () => {
    assert.equal(normalizeCedula("hola"), null);
    assert.equal(normalizeCedula("V-12345"), null); // 5 dígitos
    assert.equal(normalizeCedula("V-1234567890"), null); // 10 dígitos
    assert.equal(normalizeCedula("X-12345678"), null); // letra no válida
    assert.equal(normalizeCedula(null), null);
    assert.equal(normalizeCedula(undefined), null);
  });
});

describe("extractPoliza", () => {
  test("extrae y normaliza a mayúsculas un número de póliza RAMO-AAAA-NNN", () => {
    assert.equal(extractPoliza("mi póliza es auto-2024-001"), "AUTO-2024-001");
    assert.equal(extractPoliza("HCM-2023-045"), "HCM-2023-045");
    assert.equal(extractPoliza("PATRIMONIAL-2025-012"), "PATRIMONIAL-2025-012");
  });

  test("devuelve null si no hay un número de póliza", () => {
    assert.equal(extractPoliza("quiero cotizar"), null);
    assert.equal(extractPoliza("AUTO-24-001"), null);
    assert.equal(extractPoliza(""), null);
  });
});

describe("extractIdentification", () => {
  test("prioriza la cédula cuando el texto trae ambos datos", () => {
    assert.deepEqual(extractIdentification("V-12345678 y AUTO-2024-001"), { type: "cedula", value: "V-12345678" });
  });

  test("devuelve la póliza si no hay cédula", () => {
    assert.deepEqual(extractIdentification("tengo la HCM-2023-045"), { type: "poliza", value: "HCM-2023-045" });
  });

  test("devuelve null si no hay ninguno de los dos", () => {
    assert.equal(extractIdentification("buenas tardes"), null);
  });
});

describe("wantsToSkipIdentification", () => {
  test("detecta frases de rechazo sin importar mayúsculas ni acentos", () => {
    assert.equal(wantsToSkipIdentification("No gracias"), true);
    assert.equal(wantsToSkipIdentification("Prefiero no darla"), true);
    assert.equal(wantsToSkipIdentification("mejor DESPUÉS"), true);
  });

  test("no confunde una respuesta normal con un rechazo", () => {
    assert.equal(wantsToSkipIdentification("V-12345678"), false);
    assert.equal(wantsToSkipIdentification("sí, claro"), false);
  });
});

describe("ocultarEmail", () => {
  test("muestra solo los dos primeros caracteres del usuario", () => {
    assert.equal(ocultarEmail("carlos@ejemplo.com"), "ca****@ejemplo.com");
  });

  test("siempre oculta al menos un carácter, incluso con usuarios muy cortos", () => {
    assert.equal(ocultarEmail("ab@x.com"), "ab*@x.com");
    assert.equal(ocultarEmail("a@x.com"), "a*@x.com");
  });

  test("devuelve el valor tal cual si no parece un correo", () => {
    assert.equal(ocultarEmail("sin-arroba"), "sin-arroba");
  });
});

describe("generarCodigoOtp", () => {
  test("genera siempre 6 dígitos (con ceros a la izquierda)", () => {
    for (let i = 0; i < 200; i++) {
      assert.match(generarCodigoOtp(), /^\d{6}$/);
    }
  });

  test("no repite el mismo código de forma sistemática", () => {
    const codigos = new Set(Array.from({ length: 50 }, generarCodigoOtp));
    assert.ok(codigos.size > 40, `demasiadas colisiones: ${codigos.size} códigos distintos de 50`);
  });
});

describe("esIdentidadYaVerificadaPorCanal", () => {
  const cliente = { telefono: "+584141234567" };

  test("confía en WhatsApp solo si escribe desde el mismo número guardado", () => {
    const seed = { canalPreferido: "whatsapp", telefono: "whatsapp:+58 414-123-4567" };
    assert.equal(esIdentidadYaVerificadaPorCanal(cliente, seed), true);
  });

  test("pide OTP si el número de WhatsApp es distinto", () => {
    const seed = { canalPreferido: "whatsapp", telefono: "whatsapp:+584149999999" };
    assert.equal(esIdentidadYaVerificadaPorCanal(cliente, seed), false);
  });

  test("pide OTP siempre en el chat web", () => {
    assert.equal(esIdentidadYaVerificadaPorCanal(cliente, { canalPreferido: "web", telefono: "+584141234567" }), false);
  });

  test("pide OTP si el cliente todavía no tiene teléfono guardado", () => {
    const seed = { canalPreferido: "whatsapp", telefono: "whatsapp:+584141234567" };
    assert.equal(esIdentidadYaVerificadaPorCanal({}, seed), false);
    assert.equal(esIdentidadYaVerificadaPorCanal(cliente, null), false);
  });
});
