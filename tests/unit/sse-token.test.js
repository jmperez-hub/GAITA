/**
 * Pruebas del exchange-token de un solo uso para el stream SSE de corredores.
 * Verifica que el token sea válido solo una vez y expire correctamente.
 */
require("../helpers/entorno");

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { issueSseToken, consumeSseToken } = require("../../server");

describe("issueSseToken / consumeSseToken", () => {
  test("emite un token válido y lo consume exitosamente", () => {
    const token = issueSseToken("corredor-1");
    assert.ok(typeof token === "string" && token.length > 10, "token debe ser un string no vacío");
    const id = consumeSseToken(token);
    assert.equal(id, "corredor-1");
  });

  test("el token es de un solo uso — el segundo consumo devuelve null", () => {
    const token = issueSseToken("corredor-2");
    const first = consumeSseToken(token);
    assert.equal(first, "corredor-2");
    const second = consumeSseToken(token);
    assert.equal(second, null, "segundo consumo debe devolver null");
  });

  test("un token desconocido devuelve null", () => {
    assert.equal(consumeSseToken("token-que-nunca-existio"), null);
    assert.equal(consumeSseToken(""), null);
  });

  test("corredores distintos reciben tokens distintos", () => {
    const t1 = issueSseToken("corredor-a");
    const t2 = issueSseToken("corredor-b");
    assert.notEqual(t1, t2);
    assert.equal(consumeSseToken(t1), "corredor-a");
    assert.equal(consumeSseToken(t2), "corredor-b");
  });
});
