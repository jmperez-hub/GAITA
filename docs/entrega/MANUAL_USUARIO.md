# Manual de usuario — Lucy, C.A. de Seguros La Occidental

Guía de uso para las cuatro audiencias del sistema: **clientes** (widget web y WhatsApp),
**personal de La Occidental** (panel `/admin`) y **corredores/intermediarios** (portal
`/corredor`).

---

## 1. Para el cliente — chat web

El widget aparece como un botón flotante verde en la esquina inferior derecha de cualquier
página donde esté embebido. Al abrirlo por primera vez, Lucy saluda con un video de bienvenida y
un menú de accesos rápidos.

### 1.1 Identificarse (opcional, pero recomendado)

En cualquier momento, Lucy puede pedir la **cédula** (ej. `V-12345678`) o el **número de
póliza** (ej. `AUTO-2024-001`) para poder mostrar información real y personalizada (pólizas
vigentes, siniestros abiertos, próximas renovaciones). Si preferís no identificarte, basta con
escribir **"prefiero no decir"** y la conversación sigue con normalidad.

Al identificarte por primera vez desde un canal nuevo (el widget web, o un número de WhatsApp
que no está registrado a tu nombre), Lucy pide confirmar tu identidad con un **código de 6
dígitos** enviado a tu correo — vence en 10 minutos, y podés pedir que te lo reenvíe escribiendo
"reenviar código". Esto evita que alguien que solo conozca tu cédula pueda ver tus datos.
**Si escribís por WhatsApp desde el mismo número que ya tenés registrado, no hace falta el
código** — ese canal ya es confiable.

### 1.2 Qué puede hacer Lucy

| Pedido | Qué pasa |
|---|---|
| "Quiero cotizar un seguro" | Se abre un formulario interactivo (Automóviles/RCV, HCM o Patrimoniales) con listas desplegables — Lucy calcula un estimado al instante con las tarifas oficiales. Para otros ramos (Vida, Accidentes Personales, Funerario, Fianzas), Lucy recopila tus datos de forma conversacional y un asesor te contacta. |
| "Quiero reportar un siniestro" / "tuve un accidente" | Lucy responde primero con empatía y pregunta si hay heridos; luego pide tu identificación (con el código OTP si aplica), y sigue con un flujo guiado (tipo de siniestro, fecha, descripción, ubicación, documentos). Al final te da el **número de siniestro**. Si el monto reclamado supera USD 3.000, tu caso queda marcado como "siniestro mayor" para atención prioritaria. |
| "¿Cómo va mi siniestro?" / "¿qué documentos me faltan?" | Si estás identificado, Lucy consulta el estado real de tus siniestros abiertos. |
| Preguntas generales (misión, sucursales, Defensor del Asegurado, métodos de pago, requisitos por producto, etc.) | Lucy responde con el conocimiento oficial de la compañía. |
| Adjuntar una foto o un PDF | Podés enviar fotos de daños (para un siniestro) o de un vehículo (referencia para cotizar), y documentos (cédula, póliza). Lucy los usa como contexto conversacional — nunca reemplazan el proceso formal de peritaje o cotización. |
| Enviar una nota de voz | Se transcribe automáticamente y Lucy responde (en texto, o también en audio si tu perfil tiene esa preferencia activada). |
| "Quiero hablar con un asesor" | Lucy te da de inmediato el correo/teléfono de contacto humano. |

### 1.3 Al terminar la conversación

Cuando das por cerrada la conversación (un agradecimiento, "eso es todo", etc.), Lucy se
despide con un video y te pregunta **"Califica tu experiencia del 1 al 5 ⭐"** — respondé con un
número, la palabra ("cinco"), o una cadena de estrellas (⭐⭐⭐⭐⭐). Las calificaciones de 1 o 2
quedan marcadas para que el equipo de La Occidental las revise.

---

## 2. Para el cliente — WhatsApp

Mismo "cerebro" que el chat web, adaptado al formato de WhatsApp (mensajes cortos, sin
formularios interactivos):

- **Primer mensaje** ("hola", o cualquier saludo): Lucy responde con el video de bienvenida y un
  **menú numerado**:
  ```
  1️⃣ Cotizar seguro
  2️⃣ Reportar siniestro
  3️⃣ Consultar póliza
  4️⃣ Hablar con asesor
  ```
  También podés escribir tu consulta directamente, sin usar el menú.
- Para **cotizar** Automóviles, HCM o Patrimoniales, Lucy pide los datos uno por uno por
  mensaje (no hay listas desplegables en WhatsApp) y al final indica que un asesor formalizará
  la cotización.
- El resto de funciones (siniestros, identificación + OTP, adjuntos, notas de voz, valoración
  final) funciona igual que en el chat web (§1).
- Si escribís **"menú"** en cualquier momento, Lucy vuelve a mostrar las 4 opciones — salvo que
  estés en medio de un trámite guionado (identificación, reporte de siniestro, verificación
  OTP), en cuyo caso ese trámite tiene prioridad.

---

## 3. Para el personal de La Occidental — panel `/admin`

Accedé a `https://<tu-dominio>/admin` (o `http://localhost:3000/admin` en desarrollo) con el
usuario **`admin`** y la contraseña definida en `ADMIN_PASSWORD`.

### 3.1 Pestañas del panel

| Pestaña | Para qué sirve |
|---|---|
| **Conversaciones** | Lista de todas las conversaciones (web y WhatsApp), con filtros. Al abrir una, ves el historial completo en tiempo real (si el cliente sigue escribiendo, los mensajes nuevos aparecen solos). |
| **Modo supervisor** (dentro del detalle de una conversación) | Podés **tomar control total** de la conversación (Lucy deja de responder automáticamente, todo lo que escribas vos llega directo al cliente) o mandar un **mensaje en la sombra** (una sola respuesta manual, sin tomar control permanente). También podés dejar **notas internas** que no ve el cliente. |
| **👤 Clientes** | Base de datos de clientes identificados — buscá por cédula, nombre o teléfono. Editá el perfil (nombre, teléfono, correo, próxima renovación, notas internas), marcá VIP / preferencia de audio / caso de siniestro abierto, y consultá sus pólizas y siniestros reales con un clic. |
| **Base de pólizas** | Consulta de todas las pólizas cargadas (`data/polizas.json`, o el sistema externo si está configurado). |
| **Siniestros** | Todos los siniestros — filtrá por estado, asigná un ajustador, actualizá el estado y los documentos recibidos/pendientes. |
| **Cotizador** | Editá las tarifas del cotizador automático (RCV, HCM, Patrimoniales) sin tocar código — cambios de precio, marcas de vehículo, rangos de edad, etc. |
| **❓ Preguntas sin respuesta** | Preguntas que Lucy no supo responder bien (detectadas automáticamente) — usalas para identificar contenido que falta agregar al conocimiento de Lucy. |
| **Solicitudes de emisión** | Pólizas que los corredores pidieron emitir desde su portal — aprobalas o rechazalas. |
| **Reportes / exportación CSV** | Descarga de cotizaciones y conversaciones en CSV para análisis externo. |

### 3.2 Cosas a tener en cuenta

- La sesión del panel dura 8 horas por defecto (`ADMIN_SESSION_TTL_MS`) y vive en memoria del
  servidor — se cierra sola si el servidor se reinicia.
- Todo lo que se edita desde el panel (tarifas del cotizador, perfiles de clientes, estado de
  siniestros) tiene efecto inmediato, sin reiniciar el servidor.

---

## 4. Para corredores/intermediarios — portal `/corredor`

Accedé a `https://<tu-dominio>/corredor` (o `http://localhost:3000/corredor`) con tu correo y
contraseña de corredor (dados de alta por el administrador en `data/corredores.json`, o el
sistema que lo reemplace).

> Cuentas de **demostración** incluidas en este entorno (cambialas antes de producción):
> `jose.martinez@laoccidental.com` / `corredor123`, `ana.torres@laoccidental.com` / `corredor123`.

### 4.1 Qué podés hacer

| Sección | Para qué sirve |
|---|---|
| **Cartera de clientes** | Los clientes cuyas pólizas tenés asignadas como corredor. |
| **Pólizas por vencer** | Alertas de vencimiento próximo — recibís una notificación en tiempo real apenas una póliza cruza el umbral de "vence en 7 días". |
| **Siniestros de cartera** | Siniestros abiertos sobre pólizas de tu cartera. |
| **Comisiones** | Cálculo de tu comisión según período, con el detalle de pólizas que la componen. |
| **Cotizador profesional** | Igual al de Lucy, pero con más control y un **PDF formal** descargable con el resultado, listo para enviar a tu cliente. |
| **Emisión de póliza** | Formulario para pedir la emisión de una nueva póliza — queda pendiente de **aprobación administrativa** (no se emite automáticamente); recibís una notificación en tiempo real cuando se resuelve. |
| **Documentos** | Documentos descargables (condicionados, formularios). |
| **Recordatorios masivos por WhatsApp** | Enviá recordatorios a varios clientes de tu cartera a la vez (con criterio de frecuencia razonable, para no caer en spam). |

### 4.2 Notificaciones en tiempo real

Mientras tengas el portal abierto, recibís avisos instantáneos (sin recargar la página) cuando:
se abre un siniestro sobre una póliza tuya, una póliza tuya está por vencer, o se resuelve
(aprueba/rechaza) una solicitud de emisión que enviaste.
