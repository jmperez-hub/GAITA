# Diccionario de datos — Lucy, C.A. de Seguros La Occidental

Este proyecto **no usa una base de datos relacional**: cada "tabla" es un archivo JSON en disco,
cargado en memoria al iniciar el servidor (patrón de caché + escritura serializada, ver
`BLUEPRINT.md` §5). Este documento detalla campo por campo cada archivo — es el equivalente al
diccionario de tablas que tendría un sistema con base de datos SQL.

La ruta de cada archivo es configurable por variable de entorno (ver `MANUAL_INSTALACION.md`,
tabla de variables); se documenta aquí la ruta **por defecto**.

---

## 1. `conversations.json`

Historial completo de conversaciones, tanto del widget web como de WhatsApp. Es un objeto donde
cada clave es el identificador de la conversación (`sessionId` en web, número de teléfono sin
prefijo `whatsapp:` en WhatsApp) y el valor es un **registro de conversación**.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | string | Igual a la clave del objeto (sessionId o teléfono). |
| `startedAt` | string (ISO 8601) | Fecha/hora del primer mensaje. |
| `updatedAt` | string (ISO 8601) | Fecha/hora del último mensaje (se actualiza en cada turno). |
| `channel` | `"web"` \| `"whatsapp"` | Canal de origen. |
| `phone` | string \| null | Número de teléfono (solo WhatsApp). |
| `messages` | array de `Message` | Ver tabla `Message` abajo. |
| `messageCount` | number | Cantidad total de mensajes. |
| `ramos` | array de string | Temas/ramos detectados en la conversación (para el cotizador). |
| `advisorRequested` | boolean | El usuario pidió hablar con un asesor humano. |
| `siniestroFlow` | object \| null | Estado del flujo de apertura de siniestro en curso (`step`, `draft`, `attempts`) — `null` si no hay uno activo. |
| `identificationState` | string \| undefined | `undefined` \| `"asked"` \| `"asking-name"` \| `"asking-email"` \| `"otp-pending"` \| `"done"` \| `"skipped"` — estado del gate de identificación/OTP. |
| `identificationAttempts` | number | Intentos fallidos de identificación. |
| `clienteId` | string \| undefined | Cédula del cliente, una vez identificado (clave hacia `data/clientes.json`). |
| `pendingVerification` | object \| undefined | Código OTP vigente, expiración e intentos — **nunca se expone por la API** (se excluye explícitamente en `GET /api/admin/conversations/:id`). |
| `ratingState` | `"asked"` \| `"done"` \| `"skipped"` \| undefined | Estado de la pregunta de valoración 1-5 ⭐. |
| `rating` | number (1-5) \| undefined | Calificación dada por el usuario. |
| `ratingFlaggedForReview` | boolean \| undefined | `true` si la calificación fue ≤ 2 (queda marcada para revisión manual en `/admin`). |
| `ultimaIntencion` | string | Última intención detectada por el clasificador (`cotizar`, `reportar_siniestro`, `despedida`, etc.). |
| `ultimaEmocion` | string | Última emoción detectada (`urgente`, `molesto`, `confundido`, `satisfecho`, `neutral`). |
| `escalado` | boolean | `true` si la emoción detectada fue "molesto" (para priorización en `/admin`). |
| `controladoPorHumano` | boolean | `true` si un supervisor tomó control total desde `/admin` (modo supervisor). |
| `notasInternas` | string | Notas del staff, editables desde `/admin`. |

**`Message`** (elemento de `messages[]`):

| Campo | Tipo | Descripción |
|---|---|---|
| `role` | `"user"` \| `"assistant"` | Quién envió el mensaje. |
| `content` | string | Texto del mensaje. |
| `time` | string (ISO 8601) | Fecha/hora. |
| `media` | object \| undefined | Imagen/infografía adjunta del catálogo (`mediaKey`, `title`, `url`, ...). |
| `attachment` | object \| undefined | Adjunto del usuario (foto/PDF/nota de voz) o de Lucy (video del catálogo, audio de respuesta) — forma exacta según `kind`: `"image"` \| `"pdf"` \| `"audio"` \| `"video"`. |

---

## 2. `data/clientes.json`

Memoria persistente de clientes, por cédula — independiente de cualquier conversación puntual.
Objeto `Record<cédula, perfil>`.

| Campo | Tipo | Descripción |
|---|---|---|
| `cedula` | string | Clave primaria (ej. `"V-12345678"`). |
| `nombre` | string | Nombre completo. |
| `telefono` | string | Teléfono (con prefijo `whatsapp:` si aplica) — usado para el bypass de OTP en canal confiable. |
| `email` | string | Correo — usado para enviar el código OTP. |
| `polizas` | array de string | Números de póliza asociados (referencia informativa; la fuente real es `data/polizas.json`). |
| `canalPreferido` | string | `"whatsapp"` \| `"web"`. |
| `idiomaPreferido` | string | Por defecto `"español"`. |
| `historialTemas` | array de string | Temas de interés acumulados (ej. `"cotizacion_auto"`, `"siniestro"`) — alimenta la personalización del `system prompt`. |
| `clienteDesde` | string (ISO 8601) | Fecha de creación del perfil. |
| `ultimaInteraccion` | string (ISO 8601) | Última vez que escribió. |
| `preferenciaAudio` | boolean | Si Lucy debe responderle con nota de voz por defecto. |
| `vip` | boolean | Marca manual desde `/admin` — ajusta el tono del `system prompt`. |
| `casoAbiertoSiniestro` | boolean | Inferido por el catálogo de video/imagen; se cierra manualmente desde `/admin`. |
| `proximaRenovacion` | string | Campo editable manualmente (complementa las alertas automáticas de `data/polizas.json`). |
| `notasInternas` | string | Notas del staff — nunca se revelan textualmente al cliente. |

---

## 3. `data/polizas.json`

Array de pólizas — datos de ejemplo (fixture) mientras no exista un sistema externo real. Si se
define `POLIZAS_API_URL`, el servicio deja de leer este archivo y consulta esa API en su lugar
(mismo contrato de campos).

| Campo | Tipo | Descripción |
|---|---|---|
| `numero` | string | Número de póliza — clave primaria (ej. `"AUTO-2024-001"`). |
| `ramo` | string | `"automoviles"` \| `"hcm"` \| `"patrimoniales"` \| ... |
| `titular` | string | Nombre del titular. |
| `cedula` | string | Cédula del titular — clave foránea hacia `data/clientes.json`. |
| `vehiculo` | object \| undefined | Solo `ramo: "automoviles"` — `{ marca, modelo, año, placa }`. |
| `vigencia_inicio` | string (fecha) | Inicio de vigencia. |
| `vigencia_fin` | string (fecha) | Fin de vigencia — usado para las alertas de "vence pronto". |
| `prima_anual` | number | Prima anual. |
| `moneda` | string | `"USD"`. |
| `ultimo_pago` | string (fecha) | Fecha del último pago registrado. |
| `estado` | string | `"vigente"` \| ... |
| `coberturas` | array de string | Coberturas incluidas. |
| `suma_asegurada` | number | Suma asegurada. |
| `corredor` | string | Nombre del corredor asociado (referencia informativa hacia `data/corredores.json`). |
| `siniestros_activos` | number | Cantidad de siniestros abiertos sobre esta póliza. |

---

## 4. `data/siniestros.json`

Objeto `{ "siniestros": Siniestro[] }` — datos de ejemplo (fixture). Si se define
`SINIESTROS_API_URL`, el servicio deja de leer/escribir este archivo y consulta/actualiza esa
API en su lugar.

| Campo | Tipo | Descripción |
|---|---|---|
| `numero` | string | Número de siniestro — clave primaria, formato `SIN-AAAA-NNNN` (autogenerado al abrir uno). |
| `poliza` | string | Clave foránea hacia `data/polizas.json`. |
| `cedula_titular` | string | Clave foránea hacia `data/clientes.json`. |
| `tipo` | string | `"colision"` \| `"robo"` \| `"incendio"` \| `"hospitalizacion"` \| ... |
| `fecha_ocurrencia` | string (fecha) | Cuándo ocurrió. |
| `fecha_reporte` | string (fecha) | Cuándo se reportó. |
| `estado` | string | `"en_investigacion"` \| `"aprobado"` \| `"rechazado"` \| `"pagado"` \| ... |
| `descripcion` | string | Descripción libre dada por el cliente. |
| `ubicacion` | string | Dirección/lugar. |
| `heridos` | string | Respuesta libre a "¿hay heridos?" (PASO 1 del flujo de apertura). |
| `ajustador_asignado` | string \| null | Nombre del ajustador. |
| `documentos_recibidos` | array de string | Slugs de documentos ya recibidos. |
| `documentos_pendientes` | array de string | Slugs de documentos que aún faltan. |
| `monto_reclamado` | number | Monto reclamado — si supera **USD 3.000**, el siniestro se marca automáticamente como mayor. |
| `monto_aprobado` | number \| null | Monto aprobado, una vez resuelto. |
| `siniestro_mayor` | boolean | Ver umbral arriba. |
| `fecha_estimada_resolucion` | string (fecha) | Estimado dado al cliente. |
| `comentarios` | array | Notas internas de seguimiento. |

---

## 5. `data/corredores.json`

Objeto `{ "corredores": Corredor[] }` — cuentas del portal de corredores. En este entorno de
demo son credenciales de ejemplo documentadas en el `README.md`; en producción se reemplaza por
cuentas reales.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | string | Clave primaria (ej. `"corr-001"`). |
| `nombre` | string | Nombre del corredor. |
| `cedula` | string | Cédula. |
| `email` | string | Usado para iniciar sesión en `/corredor`. |
| `telefono` | string | Teléfono de contacto. |
| `passwordHash` | string | Hash `bcrypt` de la contraseña — **nunca** se guarda en texto plano. |
| `comisionPorcentaje` | number | Porcentaje de comisión sobre la cartera. |
| `activo` | boolean | Si la cuenta puede iniciar sesión. |
| `creadoEn` | string (ISO 8601) | Fecha de alta. |

---

## 6. `data/emisiones.json`

Objeto `{ "emisiones": Emision[] }` — solicitudes de emisión de póliza enviadas desde el
cotizador profesional del portal de corredores, pendientes de aprobación administrativa.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | string | Clave primaria. |
| `corredorId` | string | Clave foránea hacia `data/corredores.json`. |
| `ramo` | string | Ramo cotizado. |
| `cliente` | object | Datos del cliente final capturados en el formulario (nombre, cédula, contacto, datos propios del ramo). |
| `inputs` | object | Datos usados para el cálculo (vehículo, edades de beneficiarios, recargos aplicados, etc.). |
| `estimado` | number | Monto estimado calculado. |
| `estado` | string | `"pendiente"` \| `"aprobada"` \| `"rechazada"`. |
| `creadaEn` | string (ISO 8601) | Fecha de la solicitud. |
| `resueltaEn` | string (ISO 8601) \| undefined | Fecha de aprobación/rechazo. |
| `resueltaPor` | string \| undefined | Admin que la resolvió. |

---

## 7. `data/gaps-conocimiento.json`

Preguntas que Lucy no respondió bien (el modelo lo señaló, o quedó marcado por una valoración
baja) — alimenta la pestaña "❓ Preguntas sin respuesta" de `/admin`.

| Campo | Tipo | Descripción |
|---|---|---|
| `pregunta` | string | Texto de la pregunta del usuario. |
| `fecha` | string (ISO 8601) | Cuándo ocurrió. |
| `conversacionId` | string | Clave foránea hacia `conversations.json`. |
| `revisado` | boolean | Si el staff ya la revisó. |

---

## 8. `data/notificaciones-programadas.json`

Registro de qué recordatorios/seguimientos automáticos ya se enviaron, para no repetirlos a
diario (ver `config/scheduler.config.js`).

| Campo | Tipo | Descripción |
|---|---|---|
| `poliza` | string | Clave foránea hacia `data/polizas.json` (recordatorios de vencimiento). |
| `ultimoEnvio` | string (ISO 8601) | Última vez que se envió el recordatorio para esa póliza. |

---

## 9. `quoter-config.json`

Configuración completa del cotizador automático — **editable desde `/admin`** sin tocar código.
Estructura real (resumida; ver el archivo para el detalle numérico completo de tarifas):

```
{
  "updatedAt": "<ISO 8601>",
  "general": { "introMessage", "disclaimer", "triggerKeywords": [...] },
  "rcv": {
    "enabled", "label", "currencyLabel", "currencyNote", "minYear",
    "marcasComunes": [...], "placaOptions": [{id,label}],
    "usoOptions": [{id,label}], "rebajaSinLucroPct",
    "recargos": [{id,label,pct,enabled}],
    "tarifas": [{id,label,aplicaRebajaSinLucro,nacional:{cosas,personas,prima},extranjera:{...}}]
  },
  "hcm": {
    "enabled", "label", "currencyLabel", "maxAge", "maxBeneficiarios",
    "sumasAseguradas": [{id,label,value}],
    "rangosEdad": [{id,label,min,max,rates:{"<sumaId>": prima}}]
  },
  "patrimoniales": {
    "enabled", "label", "tiposBien": [{id,label}], "mensajeEnvio"
  }
}
```

- **`rcv.tarifas[]`**: una fila por tipo de vehículo (particular liviano/pesado, carga por
  tramos de tonelaje, autobuses/minibuses por alcance, motos, tracción de sangre, etc.), con
  montos de cobertura de cosas/personas y prima base, separados por placa nacional/extranjera.
- **`hcm.rangosEdad[]`**: una fila por rango etario, con la prima según cada suma asegurada
  disponible.
- El staff edita este archivo completo desde el panel `/admin` (`PUT /api/admin/quote-config`) —
  no requiere reiniciar el servidor.

---

## 10. `uploads/` (no es JSON — almacenamiento de archivos)

| Subcarpeta/patrón | Contenido |
|---|---|
| `uploads/<fileId>` | Fotos y PDFs subidos por usuarios (siniestros, cotizaciones). |
| `uploads/audio/` | Notas de voz del usuario y audio de respuestas de Lucy (TTS). |
| `uploads/video-cache/` | Videos del catálogo recomprimidos para caber en el límite de 16 MB de WhatsApp (con caché — no se recomprime dos veces el mismo video). |

Todo lo de `uploads/` está fuera de git (`.gitignore`) — son datos generados en tiempo de
ejecución, no parte del código fuente.
