# Chatbot Web — La Occidental C.A. de Seguros

Widget de chat flotante para atención al cliente, impulsado por la API de Anthropic
(Claude). Incluye un backend en Node.js/Express que mantiene la clave de API en el
servidor (nunca en el navegador) y transmite las respuestas al widget en tiempo real
mediante Server-Sent Events (SSE). Lucy, la misma asistente, también responde por
**WhatsApp Business** (vía Twilio) — ver [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md).

## Estructura del proyecto

```
.
├── public/                 # ÚNICO directorio que el servidor expone como archivos
│   │                       #   estáticos — todo lo demás en la raíz NO es accesible
│   │                       #   por HTTP (ver "Seguridad" más abajo).
│   ├── index.html          #   Página de demostración con el widget embebido
│   ├── chatbot.js           #   Lógica del widget de chat (frontend)
│   ├── chatbot.css           #   Estilos del widget (marca La Occidental)
│   ├── lucy-avatar.png       #   Foto de Lucy usada como avatar (320×320, fondo transparente)
│   ├── admin.html           #   Panel de administración (login + dashboard) — /admin
│   ├── admin.js             #   Lógica del panel (login, tabla, filtros, detalle, reportes,
│   │                        #     export CSV, editor de configuración del cotizador)
│   ├── admin.css             #   Estilos del panel (reutiliza los tokens de chatbot.css)
│   ├── corredor.html        #   Portal de corredores (login + dashboard) — /corredor
│   ├── corredor.js          #   Lógica del portal (auth JWT, ruteo, cotizador, toasts SSE)
│   ├── corredor.css         #   Estilos propios del portal (reutiliza admin.css/chatbot.css)
│   ├── assets/luci-videos/  #   Catálogo de videos explicativos de Lucy — ver
│   │                        #     "Videos explicativos de Lucy" más abajo
│   └── assets/lucy-media/   #   Catálogo de imágenes/infografías de Lucy — ver
│                            #     "Imágenes e infografías de Lucy" más abajo
├── Avatar Lucy.png         # Imagen original subida (no se usa en producción, solo referencia)
├── uploads/                # Fotos/documentos/notas de voz que suben los usuarios, audios que
│                           #   genera Lucy, videos comprimidos y THUMBS para WhatsApp — se crea
│                           #   solo (ver "Adjuntos", "Videos" e "Imágenes" más abajo); no versionar
├── conversations.json      # Conversaciones y cotizaciones guardadas (se crea solo; no versionar)
├── data/clientes.json      # Memoria persistente de clientes, por cédula — se crea solo (ver
│                           #   "Memoria persistente de clientes" más abajo); no versionar
├── data/polizas.json       # Base de datos de pólizas (fixture de ejemplo) — SÍ se versiona,
│                           #   ver "Base de datos de pólizas" más abajo
├── data/siniestros.json    # Siniestros abiertos por Lucy (fixture de ejemplo) — SÍ se versiona,
│                           #   ver "Gestión de siniestros" más abajo
├── data/corredores.json    # Cuentas del portal de corredores (fixture de ejemplo) — SÍ se
│                           #   versiona, ver "Portal de corredores" más abajo
├── data/emisiones.json     # Solicitudes de emisión enviadas desde el portal — se crea solo;
│                           #   no versionar (contiene datos reales de clientes una vez usado)
├── data/gaps-conocimiento.json          # Preguntas que Lucy no respondió bien — se crea solo, no versionar
├── data/notificaciones-programadas.json # Último recordatorio enviado por póliza (evita spam) — se
│                                         #   crea solo, no versionar
├── config/
│   └── scheduler.config.js # Horarios/umbrales de las tareas programadas (node-cron) — ver
│                           #   "Tareas programadas" más abajo
├── services/
│   ├── polizas.service.js     # Consulta de pólizas (por cédula/número, vigencia, coberturas) —
│   │                           #   aislado del resto para poder apuntar a una API real (ver abajo)
│   ├── siniestros.service.js  # Abrir/consultar siniestros, documentos, ajustador — mismo criterio
│   │                           #   de aislamiento que polizas.service.js
│   └── corredores.service.js  # Portal de corredores: auth, cartera, comisiones, cotizador
│                               #   profesional (PDF), documentos, emisiones
├── quoter-config.json      # Configuración del cotizador (tarifas, tasas, textos) — editable
│                           #   desde /admin sin tocar código
├── server.js             # Backend Express: API de Anthropic + API del panel admin +
│                           #   API del cotizador automático + API de adjuntos +
│                           #   webhook de WhatsApp (/webhook/whatsapp)
├── package.json           # Dependencias del proyecto
├── .env.example            # Variables de entorno requeridas
├── WHATSAPP_SETUP.md       # Cómo conectar Lucy a WhatsApp Business (Twilio)
└── README.md              # Este archivo
```

### Sobre `lucy-avatar.png`

Es la foto oficial de Lucy recortada en formato cuadrado (320×320) con el fondo
eliminado (transparencia real), usada como avatar circular en el encabezado del chat,
en cada mensaje de Lucy, en el indicador de "escribiendo…" y en el botón flotante.
`chatbot.js` resuelve su ruta automáticamente a partir de la ubicación de `chatbot.js`
(para que funcione aunque el widget se incruste desde otro dominio); si por algún
motivo no carga, el widget muestra un ícono de respaldo en su lugar. Puedes
sobreescribir la ruta con `avatarUrl` en `window.LO_CHATBOT_CONFIG`.

`Avatar Lucy.png` es el archivo original tal como fue provisto (1122×1402, con un
fondo simulando transparencia); se conserva solo como referencia y no lo carga la
aplicación — puedes eliminarlo del repositorio si no lo necesitas.

## Requisitos previos

- [Node.js](https://nodejs.org/) 18 o superior
- Una clave de API de Anthropic (`ANTHROPIC_API_KEY`), obtenida en
  [console.anthropic.com](https://console.anthropic.com/settings/keys)

## Instalación

1. **Clona o copia este proyecto** y entra en la carpeta:

   ```bash
   cd "Nueva LUCY Septiembre"
   ```

2. **Instala las dependencias:**

   ```bash
   npm install
   ```

3. **Configura las variables de entorno.** Copia el archivo de ejemplo y edítalo:

   ```bash
   cp .env.example .env
   ```

   Abre `.env` y coloca tu clave real de la API de Anthropic:

   ```
   ANTHROPIC_API_KEY=sk-ant-tu-clave-aqui
   ```

   Revisa también `ALLOWED_ORIGINS` si vas a incrustar el widget en un dominio
   distinto a `http://localhost:3000` (por ejemplo, el dominio de producción de
   La Occidental).

4. **Inicia el servidor:**

   ```bash
   npm start
   ```

   Para desarrollo con recarga automática (usa `nodemon`):

   ```bash
   npm run dev
   ```

5. **Abre la demo** en tu navegador:

   ```
   http://localhost:3000
   ```

   Haz clic en el botón flotante verde de la esquina inferior derecha para abrir el
   chat y comenzar a conversar con el asistente.

## Variables de entorno (`.env`)

| Variable                   | Descripción                                                                 | Valor por defecto        |
| --------------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| `ANTHROPIC_API_KEY`         | Clave de API de Anthropic (requerida)                                        | —                           |
| `CLAUDE_MODEL`              | Modelo de Claude a utilizar                                                   | `claude-opus-5`             |
| `CLAUDE_FAST_MODEL`         | Modelo rápido para el [clasificador de intención/emoción](#clasificador-de-intención-y-emoción) | `claude-haiku-4-5-20251001` |
| `PORT`                      | Puerto del servidor Express                                                   | `3000`                     |
| `ALLOWED_ORIGINS`           | Orígenes permitidos por CORS, separados por coma                              | `http://localhost:3000`    |
| `RATE_LIMIT_WINDOW_MS`      | Ventana de tiempo (ms) para el límite de peticiones                           | `60000`                    |
| `RATE_LIMIT_MAX_REQUESTS`   | Máximo de mensajes por IP dentro de la ventana                                | `20`                       |
| `COMPANY_NAME`              | Nombre de la compañía usado en el prompt del sistema                          | `La Occidental C.A. de Seguros` |
| `SUPPORT_EMAIL`             | Correo de soporte que el asistente ofrece al usuario                          | `info@laoccidental.com`    |
| `SUPPORT_PHONE`             | Teléfono de soporte que el asistente ofrece al usuario                        | (vacío)                    |
| `CLAIMS_PHONE`              | Línea de siniestros/emergencias que Lucy da ante casos urgentes               | `0212-6204444`              |
| `ADMIN_PASSWORD`            | Contraseña del panel `/admin` (usuario fijo: `admin`) — **requerida** para poder iniciar sesión | — |
| `ADMIN_SESSION_TTL_MS`      | Duración de la sesión del panel, en milisegundos                              | `28800000` (8 h)           |
| `CONVERSATIONS_FILE`        | Ruta del archivo JSON donde se guardan las conversaciones                     | `conversations.json`        |
| `QUOTER_CONFIG_FILE`        | Ruta del archivo JSON de configuración del cotizador                          | `quoter-config.json`        |
| `CLIENTES_FILE`             | Ruta del archivo JSON de memoria persistente de clientes (por cédula)         | `data/clientes.json`        |
| `SMTP_HOST`                 | Host del servidor SMTP usado para enviar códigos OTP (ver [Verificación de identidad por código OTP](#verificación-de-identidad-por-código-otp)) — sin esto, los códigos solo se imprimen en el log (modo desarrollo) | (vacío) |
| `SMTP_PORT`                 | Puerto del servidor SMTP                                                       | `587`                        |
| `SMTP_SECURE`               | `"true"` si el proveedor usa TLS implícito (típicamente puerto 465); con STARTTLS (587) déjalo en `"false"` | `false` |
| `SMTP_USER`                 | Usuario para autenticar con el servidor SMTP                                   | (vacío)                      |
| `SMTP_PASS`                 | Contraseña para autenticar con el servidor SMTP                                | (vacío)                      |
| `SMTP_FROM`                 | Remitente que verá el cliente en el correo con el código OTP                   | `"La Occidental C.A. de Seguros" <no-responder@laoccidental.com>` |
| `POLIZAS_FILE`              | Ruta del archivo JSON con los datos de pólizas (fixture, mientras no exista un sistema externo) | `data/polizas.json` |
| `POLIZAS_API_URL`           | URL base de una API REST real de pólizas — si se define, `services/polizas.service.js` deja de leer `POLIZAS_FILE` y consulta esta API (ver [Base de datos de pólizas](#base-de-datos-de-pólizas)) | (vacío, usa el archivo local) |
| `SINIESTROS_FILE`           | Ruta del archivo JSON con los siniestros (fixture, mientras no exista un sistema externo) | `data/siniestros.json` |
| `SINIESTROS_API_URL`        | URL base de una API REST real de siniestros — si se define, `services/siniestros.service.js` deja de leer/escribir `SINIESTROS_FILE` y consulta/actualiza esta API (ver [Gestión de siniestros](#gestión-de-siniestros)) | (vacío, usa el archivo local) |
| `JWT_SECRET`                | Clave para firmar los tokens JWT del [portal de corredores](#portal-de-corredores-corredor) — **requerida** para que `/corredor` funcione | — |
| `CORREDOR_SESSION_TTL_MS`   | Duración del token JWT del portal de corredores, en milisegundos              | `28800000` (8 h)            |
| `CORREDOR_CHEQUEO_VENCIMIENTOS_MS` | Cada cuánto se revisan las pólizas de cada corredor conectado por notificaciones de "vence en 7 días" | `600000` (10 min) |
| `CORREDORES_FILE`           | Ruta del archivo JSON con las cuentas de corredor (fixture, contraseñas de demo) | `data/corredores.json`   |
| `EMISIONES_FILE`            | Ruta del archivo JSON con las solicitudes de emisión del portal de corredores | `data/emisiones.json`       |
| `NOTIFICACIONES_PROGRAMADAS_FILE` | Ruta del archivo JSON con la última fecha de recordatorio de cada póliza (evita spam — ver [Tareas programadas](#tareas-programadas-configschedulerconfigjs)) | `data/notificaciones-programadas.json` |
| `GAPS_CONOCIMIENTO_FILE`    | Ruta del archivo JSON con las preguntas que Lucy no respondió bien             | `data/gaps-conocimiento.json` |
| `UPLOADS_DIR`               | Carpeta donde se guardan las fotos/documentos/notas de voz adjuntos           | `uploads`                   |
| `MAX_UPLOAD_SIZE_MB`        | Tamaño máximo por archivo adjunto, en MB                                      | `5`                         |
| `OPENAI_API_KEY`            | Clave de OpenAI para transcribir notas de voz (Whisper) y, como respaldo, para que Lucy responda en audio (OpenAI TTS) | — |
| `ELEVENLABS_API_KEY`        | Clave de ElevenLabs — proveedor PREFERIDO para que Lucy responda en audio     | —                            |
| `ELEVENLABS_VOICE_ID`       | ID de la voz de ElevenLabs a usar (junto con `ELEVENLABS_API_KEY`)            | —                            |
| `TWILIO_ACCOUNT_SID`        | Account SID de Twilio — **requerido** para WhatsApp                           | —                            |
| `TWILIO_AUTH_TOKEN`         | Auth Token de Twilio — **requerido** para WhatsApp                            | —                            |
| `TWILIO_WHATSAPP_NUMBER`    | Número de WhatsApp de Twilio, con el prefijo `whatsapp:` incluido             | —                            |
| `PUBLIC_BASE_URL`           | URL pública HTTPS de este servidor (para validar la firma de Twilio)          | (deducida de la petición)   |

Ver [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md) para instrucciones detalladas de las
variables de Twilio.

## Cómo integrar el widget en otro sitio web

Solo necesitas incluir dos archivos (`chatbot.css` y `chatbot.js`) justo antes del
cierre de `</body>`, apuntando `apiUrl` al backend donde corre `server.js`:

```html
<link rel="stylesheet" href="https://tu-dominio.com/chatbot.css" />

<script>
  window.LO_CHATBOT_CONFIG = {
    apiUrl: "https://tu-dominio.com/api/chat",
    companyName: "La Occidental",
    headerSubtitle: "Asistente virtual · Seguros",
    quickReplies: [
      "Quiero cotizar un seguro",
      "Cómo reporto un siniestro",
      "Ver tipos de pólizas",
    ],
  };
</script>
<script src="https://tu-dominio.com/chatbot.js"></script>
```

El widget se inyecta automáticamente como un botón flotante en la esquina inferior
derecha de la página; no requiere ningún contenedor HTML adicional.

## Personalización del asistente

El comportamiento y "personalidad" del asistente se define en el **prompt del
sistema** dentro de `server.js` (constante `SYSTEM_PROMPT`). Ahí puedes ajustar:

- El tono y estilo de las respuestas
- Las reglas de negocio (qué puede y no puede hacer el asistente)
- Los canales de contacto que ofrece cuando el usuario pide hablar con una persona

## Cotizador automático (Automóviles RCV · HCM · Patrimoniales)

Cuando alguien escribe algo como "quiero cotizar" (o hace clic en el quick-reply
"Quiero cotizar un seguro"), el widget activa un flujo estructurado dentro del mismo
chat, con formularios reales (listas desplegables, checkboxes) en vez de dejar que
Lucy recopile los datos por texto libre:

1. **Elige el ramo**: Automóviles (RCV), HCM, o Patrimoniales.
2. **Completa el formulario** correspondiente:
   - **Automóviles (RCV)** — marca, modelo, año, tipo de vehículo, origen de placa
     (nacional/extranjera), uso, y recargos opcionales (materias peligrosas,
     vehículo oficial, remolque ocasional). El cálculo sigue la tarifa oficial de la
     Providencia Administrativa N° SAA-01-0512-2024 (SUDEASEG) — solo RCV, no casco.
   - **HCM** — edad del titular, suma asegurada deseada (10k/20k/50k/100k USD) y
     cantidad de beneficiarios con sus edades (campos dinámicos). La tarifa es por
     rango de edad, según la tabla configurada.
   - **Patrimoniales** — tipo de bien (vivienda/comercio), valor asegurado en USD y
     correo electrónico; no se calcula un monto (no hay tarifa pública para este
     ramo) — se informa que la cotización se envía al equipo comercial.
3. **Resumen visual** con tabla de coberturas/primas y el aviso legal
   correspondiente.
4. **Botón "📄 Solicitar póliza formal"** — abre un mini formulario (nombre,
   cédula, correo) que registra el interés formal del cliente.

Cada cotización (calculada o solicitud formal) se guarda automáticamente en
`conversations.json`, asociada a la conversación — visible en el panel `/admin`
(columna "Cotización" en la tabla, y sección "📋 Cotizaciones generadas" en el
detalle de cada conversación).

**Todos los cálculos ocurren en el navegador (`chatbot.js`), no en el modelo de
Claude** — el prompt de Lucy le indica explícitamente que nunca debe inventar
montos para estos tres ramos y que debe dejar que el formulario automático se
encargue. Esto es intencional: los precios de seguros deben ser deterministas y
verificables, no generados por un LLM.

### No-code / low-code: todo editable desde el panel

Las tarifas, tasas, textos y palabras clave que activan el cotizador viven en
`quoter-config.json` — **no en el código**. Desde `/admin` → pestaña "⚙️ Cotizador",
los equipos de TI, técnico o comercial pueden, sin escribir una línea de código:

- Editar/agregar/eliminar tipos de vehículo y sus montos de la tarifa RCV
  (suma asegurada y prima, nacional y extranjera)
- Editar/agregar/eliminar los recargos por agravación de riesgo y su porcentaje
- Editar la lista de marcas comunes del desplegable
- Editar/agregar/eliminar las sumas aseguradas y los rangos de edad (y sus tasas)
  de HCM
- Editar/agregar/eliminar los tipos de bien de Patrimoniales
- Editar el mensaje de bienvenida del cotizador, el aviso legal (disclaimer) y las
  palabras clave que lo activan
- Activar/desactivar cada ramo del cotizador de forma independiente

Los cambios se guardan con el botón "💾 Guardar todos los cambios" y quedan
disponibles en el chat de inmediato (sin reiniciar el servidor).

## Memoria persistente de clientes

Lucy puede recordar a un cliente **entre conversaciones y entre canales** (web y
WhatsApp) — no solo dentro de una misma sesión. El perfil vive en `data/clientes.json`
(`Record<cédula, perfil>`, mismo patrón de caché + escritura serializada que
`conversations.json`), separado de cualquier conversación individual.

**Identificación (al inicio de la conversación):** un paso guionado y determinista —
Lucy pregunta la cédula o el número de póliza *antes* de involucrar a Claude (igual
criterio que el menú de WhatsApp o el mensaje de bienvenida: nunca se deja en manos
del modelo). Si el dato coincide con un cliente ya conocido, saluda con
"¡Hola de nuevo, [nombre]!"; si es nuevo, crea el perfil y pide el nombre. El usuario
puede decir "prefiero no decir" (o fallar el formato dos veces) para seguir sin
identificarse — nunca queda atrapado en el flujo.

**Qué recuerda** (según el ejemplo del perfil que compartiste, con nombres de campo en
`camelCase` para ser consistente con el resto del código):

```json
{
  "cedula": "V-12345678",
  "nombre": "Carlos Pérez",
  "telefono": "+584141234567",
  "email": "carlos@email.com",
  "polizas": ["AUTO-2024-001", "HCM-2023-045"],
  "canalPreferido": "whatsapp",
  "idiomaPreferido": "español",
  "historialTemas": ["cotizacion_autos", "siniestro"],
  "clienteDesde": "2024-03-10T14:30:00.000Z",
  "ultimaInteraccion": "2026-09-01T14:30:00.000Z",
  "preferenciaAudio": true,
  "vip": false,
  "casoAbiertoSiniestro": false,
  "proximaRenovacion": "",
  "notasInternas": "Cliente VIP, renovación pendiente en octubre"
}
```

**Personalización activa:**

- **Preferencia de audio** — si `preferenciaAudio` es `true`, Lucy responde con nota
  de voz por defecto (se suma a las reglas ya existentes de
  [Respuestas de Lucy en audio](#respuestas-de-lucy-en-audio-texto-a-voz)).
- **Cliente VIP** — el system prompt le indica a Lucy que le dé un tono
  especialmente cálido y prioritario (se activa desde `/admin`, ver más abajo).
- **Caso de siniestro abierto** — se marca solo cuando el catálogo de video/imagen
  detecta un tema de siniestro (`recordClientTopic`); Lucy le pregunta al cliente
  cómo quedó. El staff lo cierra manualmente desde `/admin` una vez resuelto — no hay
  integración real con un sistema de siniestros, es una inferencia de la propia
  conversación.
- **Seguimiento del ramo de interés** — cada cotización guardada (`POST /api/quote`)
  agrega un tema (`cotizacion_<ramo>`) a `historialTemas`; el system prompt le pide a
  Lucy retomarlo de forma natural en la siguiente conversación.
- **Próxima renovación** — campo editable manualmente desde `/admin`, para casos que
  no estén cubiertos por el sistema de pólizas (p. ej. un ramo que aún no está
  cargado ahí). Si tiene un valor, Lucy lo menciona de forma proactiva. Desde que
  existe la [base de datos de pólizas](#base-de-datos-de-pólizas), las alertas de
  vencimiento *reales* (¿vence pronto? ¿ya venció?) se calculan automáticamente a
  partir de `data/polizas.json` — este campo es un complemento manual, no la única
  fuente de esas alertas.

**Contexto en cada mensaje:** una vez identificado el cliente, su perfil se resume y
se antepone al `system` prompt de Claude en cada turno (`buildClientContextAddendum`)
— nombre, antigüedad como cliente, pólizas, último tema, VIP, caso abierto, próxima
renovación y notas internas (marcadas explícitamente como "nunca reveles esto
textualmente al cliente").

> **Nota de diseño:** el pedido original pedía preguntar la cédula "al inicio del
> chat" — se implementó como un paso guionado por palabras clave (regex para cédula
> venezolana `V-12345678` / póliza `RAMO-AAAA-NNN`), el mismo mecanismo determinista
> que ya usan el cotizador, el menú de WhatsApp y los catálogos de video/imagen —
> nunca depende de que el modelo decida cuándo preguntar o qué extraer.

Desde la pestaña **"👤 Clientes"** del panel `/admin` se puede: buscar por cédula,
nombre o teléfono; ver y editar el perfil completo (nombre, teléfono, correo, pólizas,
próxima renovación, notas internas); marcar/desmarcar VIP, preferencia de audio y caso
de siniestro abierto; ver — con un clic — el historial completo de conversaciones de
ese cliente (abre el mismo modal de detalle que la pestaña "Conversaciones", con un
enlace de vuelta al perfil del cliente desde ahí); y consultar sus **pólizas reales**,
tal como las tiene registradas el [sistema de pólizas](#base-de-datos-de-pólizas)
(vigencia calculada al momento, prima, suma asegurada, corredor, siniestros activos).

## Verificación de identidad por código OTP

Saber la cédula (o el número de póliza) de alguien **no es prueba suficiente de que
esa persona es el titular** — cualquiera que la conozca o la adivine podría, si no,
hacerse pasar por un cliente y ver sus datos reales (pólizas, siniestros, notas
internas). Antes de tratar a quien escribe como ese cliente, Lucy le pide que
confirme su identidad con un código de un solo uso enviado a su correo.

**Cuándo se pide y cuándo no (bypass de canal confiable):** si el mensaje llega por
WhatsApp desde un número que ya coincide con el `telefono` guardado en el perfil del
cliente, Lucy confía en ese canal (el propio WhatsApp ya es un segundo factor: solo el
dueño del número puede escribir desde ahí) y **no pide OTP** — solo el saludo
"¡Hola de nuevo, [nombre]!". En cualquier otro caso — widget web, un número de
WhatsApp que no coincide con ninguno registrado, o un cliente nuevo con correo ya
conocido — sí se exige el código.

**Flujo (`iniciarVerificacionIdentidad` / `continuarVerificacionIdentidad` en
`server.js`):**

1. Lucy identifica al cliente por cédula o póliza (igual que antes).
2. Si el canal no es de confianza, pide o confirma su correo (`correo@ejemplo.com`,
   validado con una regex simple; dos intentos fallidos y se puede seguir sin
   identificarse, igual que en el flujo original).
3. Genera un código de 6 dígitos, lo guarda con expiración (`OTP_EXPIRY_MS`, 10
   minutos) en `record.pendingVerification` — nunca en el perfil del cliente — y lo
   envía por correo con [nodemailer](https://nodemailer.com/). El cliente ve el correo
   enmascarado ("ca\*\*\*\*@example.com") para confirmar que es el suyo sin revelarlo
   completo.
4. El cliente escribe el código. Hasta `OTP_MAX_ATTEMPTS` (3) intentos fallidos por
   envío; al agotarlos, la verificación queda "skipped" (igual salida que declinar
   identificarse) y se le indica llamar a un asesor. Escribir "reenviar código" pide
   uno nuevo, con un enfriamiento de `OTP_RESEND_COOLDOWN_MS` (60 s) para evitar abuso.
5. Con el código correcto, la conversación continúa exactamente donde se había
   quedado — incluida la apertura de un siniestro en curso (`handleSiniestroFlowGate`
   delega en el mismo mecanismo antes de dejar avanzar el caso a nombre de alguien).

**Sin SMTP configurado:** el código se imprime en el log del servidor en vez de
enviarse por correo (`[MODO DESARROLLO — SMTP no configurado] Código OTP para
correo@ejemplo.com: 123456`) — útil para desarrollo local, **nunca debe quedar así en
producción**. Configura `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` (ver
[Variables de entorno](#variables-de-entorno-env)) para que salgan correos reales.

> El código OTP vigente vive únicamente en memoria/`conversations.json`
> (`record.pendingVerification`) y nunca se expone por la API — `GET
> /api/admin/conversations/:id` lo excluye explícitamente de la respuesta antes de
> enviarla al panel.

## Base de datos de pólizas

Lucy puede consultar **datos reales de pólizas** (no inventados) para responder
preguntas como "¿cuándo vence mi póliza?", "¿qué cubre mi seguro?", "¿cuánto pagué de
prima?", "¿cuál es mi suma asegurada?", "¿quién es mi corredor?" o "mis pólizas" (lista
completa). El servidor consulta siempre `services/polizas.service.js` **antes** de
armar el contexto que se le envía a Claude — Lucy nunca calcula ni inventa estos datos
por su cuenta, solo los redacta en lenguaje natural a partir de lo que el servicio le
entrega.

**Fuente de datos:** por defecto, `data/polizas.json` — un archivo de ejemplo con 5
pólizas ficticias de distintos ramos (automóviles, HCM, patrimoniales, fianzas), pensado
para desarrollo y demostraciones. Cada póliza sigue esta forma:

```json
{
  "numero": "AUTO-2024-001",
  "ramo": "automoviles",
  "titular": "Carlos Pérez",
  "cedula": "V-12345678",
  "vehiculo": { "marca": "Toyota", "modelo": "Corolla", "año": 2020, "placa": "ABC123" },
  "vigencia_inicio": "2025-09-20",
  "vigencia_fin": "2026-09-20",
  "prima_anual": 850.0,
  "moneda": "USD",
  "ultimo_pago": "2025-09-18",
  "estado": "vigente",
  "coberturas": ["casco", "rc", "asistencia_vial"],
  "suma_asegurada": 25000,
  "corredor": "José Martínez",
  "siniestros_activos": 1
}
```

`services/polizas.service.js` expone `buscarPorCedula()`, `buscarPorNumero()`,
`obtenerCoberturas()` y `verificarVigencia()`. Este último es deliberadamente
**desconfiado del campo `estado` del propio registro** (puede quedar desactualizado
administrativamente): calcula la vigencia real comparando `vigencia_fin` con la fecha
actual, y devuelve `{ vigente, porVencer, vencida, diasRestantes }` — el criterio que
usa todo lo demás (contexto de Claude, alertas automáticas, badges del panel admin).

**Alertas automáticas:** al reconocer a un cliente que regresa (misma cédula, mismo
flujo de [memoria persistente](#memoria-persistente-de-clientes)), Lucy revisa sus
pólizas y, si aplica, agrega al saludo:

- ⏰ una póliza vence en 30 días o menos,
- ⚠️ una póliza ya venció (y le ofrece ayudar con la renovación de inmediato),
- 🚨 tiene un siniestro activo (y le pregunta si quiere que le cuente cómo va).

**Lista para reemplazar por una API real:** el servicio se autoconfigura desde
`.env` y no depende de que `server.js` le pase nada. Mientras `POLIZAS_API_URL` esté
vacío, lee `data/polizas.json` (variable `POLIZAS_FILE`). En cuanto se defina
`POLIZAS_API_URL`, el servicio deja de leer el archivo local y en su lugar hace
`fetch()` contra:

```
GET {POLIZAS_API_URL}/polizas?cedula=<cedula>   (pólizas de un cliente)
GET {POLIZAS_API_URL}/polizas/<numero>          (una póliza puntual)
```

Ajusta `services/polizas.service.js` si el contrato de la API real de La Occidental
es distinto — está aislado del resto del código precisamente para que ese cambio no
toque `server.js` ni el system prompt de Claude.

> **Nota:** `data/polizas.json` contiene datos de ejemplo/fixture (no información de
> clientes reales), por eso sí está versionado en git — a diferencia de
> `data/clientes.json`, que si contiene datos reales y está excluido.

## Gestión de siniestros

Lucy puede **abrir, consultar y dar seguimiento a siniestros reales** desde el propio
chat (web o WhatsApp) — sin necesidad de llamar o llenar un formulario aparte.

**Apertura (flujo conversacional guionado):** cuando el usuario dice algo como "tuve un
accidente", "quiero reportar un siniestro", "me robaron" o "tuve que hospitalizarme",
el sistema detecta la intención (`detectSiniestroTrigger` en `server.js`, por palabras
clave — mismo criterio determinista que el resto del proyecto) y toma el control de la
conversación con un paso a paso guionado, **antes** de involucrar a Claude:

1. **Primeros auxilios emocionales** — un mensaje empático inmediato ("Lamento lo
   ocurrido...") y la pregunta de si hay heridos. Esto ocurre incluso si es el primer
   mensaje de la conversación, antes que cualquier otra cosa (incluida la
   identificación del cliente).
2. **Identificación** — si el cliente no está identificado todavía, se le pide la
   cédula o el número de póliza (reutiliza el mismo reconocimiento que la
   [memoria persistente de clientes](#memoria-persistente-de-clientes)); si ya está
   identificado de antes, este paso se salta.
3. **Datos del siniestro** — tipo (menú numerado: accidente / robo / incendio /
   hospitalización), fecha/hora, descripción breve y ubicación. En el paso de
   ubicación, el widget web muestra un botón "📍 Compartir mi ubicación" que usa la
   Geolocation API del navegador (el usuario puede seguir escribiendo la dirección a
   mano si prefiere, o si la deniega); por WhatsApp, si el usuario comparte su
   ubicación nativamente, Twilio la entrega como coordenadas y se usa igual.
4. **Documentos** — al terminar el paso 3, el sistema abre el siniestro de inmediato
   (con un número ya asignado) y le indica al usuario qué documentos necesita según el
   tipo (p. ej. fotos del daño + denuncia + croquis + presupuesto para un accidente).
   El usuario puede adjuntarlos ahí mismo en el chat, en ese momento o más adelante:
   cada vez que envía una foto/PDF y tiene un siniestro con documentos pendientes, el
   sistema lo asocia automáticamente y se lo confirma.
5. **Confirmación** — Lucy responde con el número de siniestro generado
   (`SIN-AAAA-NNNN`), el ajustador asignado (reparto rotativo simple) y la fecha
   estimada de resolución.

> **Nota de diseño — clasificación de documentos:** el sistema NO analiza el contenido
> de la foto/PDF para saber a cuál documento pendiente corresponde (eso requeriría
> visión por computadora dedicada, fuera del alcance de este pedido) — usa una
> heurística determinista simple: cada adjunto nuevo se marca contra el **primer**
> documento que siga pendiente en la lista. Funciona bien para el caso típico (el
> usuario envía los documentos en el orden que se le pidieron); un asesor puede
> corregir la asociación manualmente desde `/admin` si hace falta.

**Consulta de estado ("¿cómo va mi siniestro?", "¿qué documentos me faltan?", "¿cuándo
me pagan?"):** a diferencia de la apertura, esto NO es un flujo guionado — los
siniestros reales del cliente (`services/siniestros.service.js`) se anteponen al
`system` prompt de Claude (mismo criterio que las pólizas, ver
`buildSiniestrosContextAddendum` en `server.js`), con instrucciones explícitas de
nunca inventar números, estados, montos ni fechas, y de usar el encuadre regulatorio
pedido ("La Occidental busca en todo momento cumplir con la normativa de la SUDEASEG…")
cuando preguntan por el pago de un siniestro ya aprobado.

**Escalamiento automático ("siniestro mayor"):** si el monto reclamado al abrir supera
$3.000, el siniestro se marca `siniestro_mayor: true` y queda resaltado en `/admin`
(insignia roja "🚨 Mayor", filtro dedicado). No existe todavía un canal real de
notificación a gerencia (correo, Slack, etc.) — mientras tanto, se deja constancia
clara en el log del servidor (`🚨 SINIESTRO MAYOR: ...`) además de la visibilidad en
el panel.

**Servicio (`services/siniestros.service.js`):** expone `abrirSiniestro()`,
`consultarEstado()`, `actualizarDocumentos()` y `asignarAjustador()` (las cuatro
funciones pedidas), más `listarPorCedula()`, `buscarPorNumero()`, `listarTodos()` y
`actualizarSiniestro()` (usadas por `/admin`). Por defecto lee/escribe
`data/siniestros.json`, con el mismo patrón de caché en memoria + cola de escritura
serializada que `data/clientes.json`. Si se define `SINIESTROS_API_URL` en el `.env`,
deja de usar el archivo local y en su lugar consulta/escribe contra esa API real:

```
GET   {SINIESTROS_API_URL}/siniestros                  (todos, para /admin)
GET   {SINIESTROS_API_URL}/siniestros?cedula=<cedula>   (los de un cliente)
GET   {SINIESTROS_API_URL}/siniestros/<numero>          (uno puntual)
POST  {SINIESTROS_API_URL}/siniestros                   (abrir uno nuevo)
PATCH {SINIESTROS_API_URL}/siniestros/<numero>          (actualizar uno existente)
```

Ajusta `services/siniestros.service.js` si el contrato de la API real de La Occidental
es distinto — aislado del resto del código por el mismo motivo que
`polizas.service.js`.

Desde la pestaña **"🚨 Siniestros"** del panel `/admin` se puede: ver todos los
siniestros (con filtros por estado y por "solo mayores"), buscar por número/cédula/
titular, y en el detalle de cada uno editar el estado, el ajustador asignado, el monto
aprobado, la fecha estimada de resolución, marcar/desmarcar documentos recibidos, y
agregar comentarios de seguimiento.

> **Nota:** `data/siniestros.json` contiene datos de ejemplo/fixture (no casos reales),
> por eso sí está versionado en git — mismo criterio que `data/polizas.json`.

## Portal de corredores (`/corredor`)

Una segunda aplicación web (independiente del chat y del panel `/admin`) para que los
corredores de La Occidental gestionen su cartera: pólizas por vencer, siniestros
abiertos, comisiones, un cotizador profesional con PDF formal, solicitudes de emisión
de póliza, documentos descargables, y notificaciones en tiempo real.

```
http://localhost:3000/corredor
```

**Cuentas de demostración** (`data/corredores.json` — contraseña de desarrollo, cámbiala
antes de usar datos reales):

| Correo | Contraseña | Corredor |
| --- | --- | --- |
| `jose.martinez@laoccidental.com` | `corredor123` | José Martínez |
| `ana.torres@laoccidental.com` | `corredor123` | Ana Torres |

### Autenticación (JWT)

A diferencia de `/admin` (cookie de sesión en memoria), el portal usa **JSON Web
Tokens** (`jsonwebtoken`): al iniciar sesión (`POST /api/corredor/login`) el servidor
firma un token con `JWT_SECRET` (variable de entorno **obligatoria** — sin ella, todo
`/corredor` y `/api/corredor/*` responden error de configuración, igual criterio que
`ADMIN_PASSWORD`); el navegador lo guarda en `localStorage` y lo manda en cada petición
como `Authorization: Bearer <token>` (ver `apiFetch` en `public/corredor.js`). El
middleware `requireCorredorAuth` (`server.js`) verifica el token en cada endpoint
`/api/corredor/*`. Única excepción: el stream de notificaciones en tiempo real (ver más
abajo) recibe el token por `?token=` en la URL, porque `EventSource` del navegador no
permite mandar headers personalizados.

### Cartera y "quién es el dueño de una póliza"

No hay una lista aparte de "clientes de cada corredor" que mantener sincronizada: la
cartera se calcula en el momento filtrando `data/polizas.json` por su campo `corredor`
(el mismo nombre que ya usan las pólizas de ejemplo, "José Martínez" / "Ana Torres") —
ver `corredoresService.listarCartera()`. Esto también es lo que conecta un siniestro
nuevo con el corredor a notificar (ver más abajo).

### Rutas de página y ruteo del lado del cliente

Cuatro rutas reales en el servidor (`/corredor`, `/corredor/clientes`,
`/corredor/cotizar`, `/corredor/siniestros`) sirven siempre el mismo `corredor.html` —
la navegación entre ellas ocurre en el navegador con la History API (sin recargar la
página), y al entrar directamente a cualquiera de las 4 (o recargar) el servidor
también responde correctamente, así que se pueden compartir como enlaces. La protección
real de los datos vive en los endpoints `/api/corredor/*`, no en estas rutas de
página — servir el HTML no expone ningún dato.

### Qué puede hacer un corredor

- **Dashboard** — tarjetas con el tamaño de su cartera, pólizas por vencer, siniestros
  abiertos y comisión acumulada; tabla de pólizas por vencer este mes; sus solicitudes
  de emisión recientes; y la lista de documentos descargables.
- **"👤 Clientes"** — su cartera completa (buscable por cédula o nombre), con las
  pólizas de cada cliente y su vigencia real.
- **"🧮 Cotizar"** — el cotizador profesional (ver abajo) y el formulario de solicitud
  de emisión.
- **"🚨 Siniestros"** — todos los siniestros de los clientes de su cartera, con estado
  y ajustador asignado.
- **Recordatorios de renovación** — un botón en el dashboard envía un WhatsApp a cada
  cliente único con una póliza por vencer que tenga teléfono registrado (memoria
  persistente de clientes) — a los que no tienen teléfono se les excluye y reporta
  aparte, nunca se inventa un contacto. Requiere Twilio configurado (ver
  [WhatsApp Business](#whatsapp-business-vía-twilio)); si no, el botón funciona pero no
  envía nada realmente (mismo criterio que el resto del proyecto).

### Cotizador profesional (PDF formal)

A diferencia del cotizador del chat (que calcula en el navegador), este cotizador
calcula el estimado **en el servidor** — con las mismas tarifas de
`quoter-config.json`, reimplementadas en `corredoresService.cotizarRcv()` /
`cotizarHcm()` — porque genera un PDF formal (`POST /api/corredor/cotizar`, con
[`pdfkit`](https://pdfkit.org/)) que no puede basarse en un monto que mande el propio
cliente. Cubre Automóviles (RCV) y HCM (los dos ramos con fórmula real, igual que el
cotizador del chat); Patrimoniales sigue sin cálculo automático.

> **Nota de mantenimiento:** si cambias una tarifa o fórmula, actualízala en los DOS
> lugares — `public/chatbot.js` (cotizador del cliente) y
> `services/corredores.service.js` (cotizador profesional) — no comparten código
> porque uno corre en el navegador y el otro en el servidor.

### Solicitudes de emisión

`POST /api/corredor/emisiones` guarda la solicitud en `data/emisiones.json` con estado
`"pendiente_aprobacion"`. Gerencia la aprueba o rechaza desde la pestaña
**"📝 Emisiones"** del panel `/admin` (`GET`/`PATCH /api/admin/emisiones`), lo que
dispara la notificación en tiempo real `emision-resuelta` al corredor que la envió.

### Notificaciones en tiempo real (toasts)

Un stream SSE (`GET /api/corredor/events`, mismo mecanismo que `/api/chat`, pero de
larga duración) por cada pestaña del portal que el corredor tenga abierta. Tres eventos:

- **`siniestro-abierto`** — un cliente de su cartera abrió un siniestro con Lucy (ver
  `finalizeSiniestroFlow` en `server.js`, que ubica al corredor por el campo `corredor`
  de la póliza asociada).
- **`poliza-por-vencer`** — una póliza de su cartera cruzó el umbral de 7 días para
  vencer. Revisado por un `setInterval` en memoria cada
  `CORREDOR_CHEQUEO_VENCIMIENTOS_MS` (10 minutos por defecto) — ver
  `iniciarChequeoVencimientosCorredores()`. **Nota:** sin scheduler/cron real, este
  chequeo vive en memoria del proceso — se reinicia (y puede repetir un aviso una vez)
  si el servidor se reinicia; aceptable para una alerta informativa, no crítica.
- **`emision-resuelta`** — gerencia aprobó o rechazó una de sus solicitudes de emisión.

### Documentos descargables

`GET /api/corredor/documentos` (catálogo) y `GET /api/corredor/documentos/:key` (PDF) —
condicionados generales por ramo, tarifario y formulario de declaración de siniestro.
Son **placeholders generados al vuelo** con `pdfkit` (`DOCUMENTOS_CATALOGO` en
`services/corredores.service.js`), sin depender de archivos binarios versionados —
sustitúyelos por los documentos reales de la compañía cuando estén disponibles.

### Servicio (`services/corredores.service.js`)

Autenticación (`autenticar`, con `bcryptjs` sobre `data/corredores.json`), cartera
(`listarCartera`, `polizasPorVencer`, `siniestrosDeCartera` — todos derivados de
`polizasService`/`siniestrosService`), comisiones (`calcularComision`, desglose
mensual por `ultimo_pago` de cada póliza — **simplificación ilustrativa**: no hay un
sistema real de liquidación de comisiones), cotizador (`cotizarRcv`, `cotizarHcm`,
`generarCotizacionPdf`), documentos (`listarDocumentos`, `generarDocumentoPdf`) y
emisiones (`crearEmision`, `listarEmisionesPorCorredor`, `actualizarEmision`, con el
mismo patrón de caché en memoria + cola de escritura serializada que
`data/siniestros.json`).

> **Nota:** `data/corredores.json` contiene cuentas de ejemplo/fixture (contraseñas de
> DEMO documentadas arriba, no reales), por eso sí está versionado en git.
> `data/emisiones.json` acumula datos reales de clientes una vez que se usa —
> excluido de git, mismo criterio que `data/clientes.json`.

## Motor de inteligencia

Un conjunto de mecanismos que se suman al resto del chatbot para hacerlo más proactivo
y fácil de mejorar con el tiempo: clasificación de intención/emoción, valoración de
calidad, tareas programadas, aprendizaje de preguntas sin respuesta, y un modo
supervisor para que el equipo intervenga en vivo.

### Clasificador de intención y emoción

Antes de generar cada respuesta "normal" (es decir, cuando el mensaje no cayó en
ninguno de los flujos guionados deterministas — identificación, siniestros, valoración),
`classifyIntentAndEmotion()` (`server.js`) hace una llamada RÁPIDA y aparte a Claude
(modelo `CLAUDE_FAST_MODEL`, por defecto `claude-haiku-4-5-20251001`) pidiéndole un JSON
compacto con:

- **Intención**: `cotizar`, `consultar_poliza`, `reportar_siniestro`,
  `consultar_siniestro`, `quejar`, `cancelar_poliza`, `renovar`, `hablar_humano`,
  `saludo`, `despedida`, `otra`.
- **Emoción**: `urgente`, `molesto`, `confundido`, `satisfecho`, `neutral`.

Según el resultado, se agrega un bloque de instrucciones al `system` prompt (ver
`INTENT_GUIDANCE`/`EMOTION_GUIDANCE`) — nunca reemplaza los datos reales ya inyectados
(pólizas, siniestros): solo ajusta el TONO y el encuadre de la respuesta. Por ejemplo,
`emocion=molesto` hace que Lucy reconozca la frustración antes que cualquier otra cosa y
marca la conversación como `escalado` (visible en `/admin`); `emocion=confundido` le pide
a Lucy usar lenguaje más simple.

> **Nota de diseño:** esta llamada nunca bloquea la respuesta real — tiene un timeout de
> 3 segundos y, si falla o tarda demasiado, se usa `{intencion: "otra", emocion: "neutral"}`
> y la conversación sigue con normalidad. Los intents `reportar_siniestro`,
> `consultar_poliza`/`consultar_siniestro` y `hablar_humano` YA tienen su propio manejo
> determinista en otras partes del proyecto (flujo de siniestros, contexto real de
> pólizas/siniestros, detección de solicitud de asesor) — el clasificador no los duplica,
> solo cubre los casos que antes no tenían ningún tratamiento especial (queja, cancelación,
> renovación) y ajusta el tono según la emoción detectada.

### Valoración de calidad

Al detectar una señal de cierre satisfactorio (el usuario dice "gracias", se despide, o
el clasificador detecta `emocion=satisfecho`), Lucy agrega al final de su respuesta:
*"¿Pude ayudarte con algo más? Califica tu experiencia del 1 al 5 ⭐"* — y
`record.ratingState` pasa a `"asked"`. El siguiente mensaje del usuario se interpreta
como la valoración (`handleRatingGate` en `server.js`, acepta un dígito 1-5, el número
en palabras, o una cadena de estrellas ⭐/★); si no se puede interpretar como valoración,
no bloquea la conversación — simplemente sigue su curso normal.

La valoración se guarda en la conversación (`record.rating`) y en el perfil persistente
del cliente (`cliente.ultimaValoracion` / `historialValoraciones`, últimas 20). Una
valoración de 1 o 2 marca `requiereRevision: true`, visible en la pestaña
"💬 Conversaciones" del panel `/admin` (columna "Valoración" + filtro dedicado).

Por WhatsApp, además, si una conversación queda inactiva 10 minutos después de que Lucy
respondió por última vez (y todavía no se le preguntó la valoración), un chequeo
periódico se la pregunta proactivamente — ver "Tareas programadas" más abajo. El widget
web no tiene ese chequeo por inactividad (no hay una conexión abierta fuera de una
petición activa para empujarle un mensaje sin que el usuario escriba algo — ver "Modo
supervisor" para el mecanismo que sí lo permite).

### Tareas programadas (`config/scheduler.config.js`)

Tres tareas con [`node-cron`](https://www.npmjs.com/package/node-cron), configurables
sin tocar código en `config/scheduler.config.js`:

| Tarea | Horario por defecto | Qué hace |
| --- | --- | --- |
| `recordatoriosPolizas` | 9:00 AM diario | WhatsApp al cliente y a su corredor por cada póliza que vence dentro de 30 días |
| `seguimientoCotizaciones` | 3:00 PM diario | Lucy manda un WhatsApp de seguimiento por cada cotización sin cerrar con más de 48 horas |
| `valoracionInactividad` | Cada 2 minutos | Pregunta la valoración de calidad en conversaciones de WhatsApp inactivas 10+ minutos |

**"No lo puede hacer a diario como SPAM" (pedido explícito) — cómo se evita:**

- `recordatoriosPolizas` respeta un enfriamiento mínimo (`diasMinimosEntreRecordatorios`,
  7 días por defecto) entre recordatorios de una MISMA póliza — se registra en
  `data/notificaciones-programadas.json` (no es un archivo de ejemplo, se genera solo).
- `seguimientoCotizaciones` marca cada cotización como contactada
  (`quote.seguimientoEnviado = true`) la primera vez — nunca se reintenta esa misma
  cotización, haya o no teléfono disponible.
- `valoracionInactividad` solo pregunta una vez por conversación (`record.ratingState`).

Si no hay teléfono disponible para un destinatario (cliente sin `telefono` en su perfil,
por ejemplo), simplemente se omite — nunca se inventa un contacto. Con Twilio sin
configurar, las tareas corren igual (se registran en el log del servidor) pero no
envían nada realmente, mismo criterio que el resto del proyecto.

### Aprendizaje de preguntas frecuentes

Cuando el usuario le dice a Lucy que no respondió bien ("eso no es lo que pregunté", "no
me entendiste", etc. — ver `DISSATISFACTION_TRIGGER_PHRASES`) o pide hablar con un
asesor humano, se registra automáticamente un "gap de conocimiento" en
`data/gaps-conocimiento.json`: la pregunta original del usuario, la respuesta de Lucy que
no sirvió, y qué disparó el registro — usando el par pregunta/respuesta ya presente en el
historial de esa misma conversación (`registrarGapConocimiento` en `server.js`).

Desde la pestaña **"❓ Preguntas sin respuesta"** del panel `/admin` el equipo puede
revisarlas, dejar notas, y marcarlas como resueltas una vez que se mejora el
`SYSTEM_PROMPT` para cubrir ese caso.

### Modo supervisor

Desde el detalle de una conversación en `/admin`, un supervisor puede:

- **Ver en vivo** — un stream SSE (`GET /api/admin/conversations/:id/live`) muestra cada
  mensaje nuevo (de cualquier rol) a medida que ocurre, sin refrescar el modal.
- **Enviar un mensaje como Lucy** ("shadow messaging") — se guarda y se le entrega al
  usuario exactamente como cualquier otro mensaje de Lucy (sin ninguna marca visible para
  él); en el panel se distingue con una etiqueta "· equipo" solo para uso interno.
- **Tomar control total** — mientras está activo, `/api/chat` y el webhook de WhatsApp
  dejan de llamar a Claude o a cualquier flujo automático para esa conversación: el
  usuario recibe un mensaje corto de espera y el supervisor le responde manualmente
  (con "shadow messaging", arriba) hasta que suelta el control.
- **Dejar notas internas** — texto visible solo en `/admin`, nunca se le muestra al
  usuario ni se le envía a Claude (independiente de las notas del perfil del cliente).

**Cómo llega un mensaje "en vivo" al widget web sin que el usuario haya escrito nada**
(algo que el modelo normal de petición/respuesta de `/api/chat` no permite por sí solo):
el widget abre, al cargar, una conexión SSE persistente propia (`GET /api/chat/live`,
ver `connectLiveStream()` en `chatbot.js`) que se mantiene mientras la página esté
abierta — a diferencia de `POST /api/chat`, que es una petición corta por cada mensaje.
Por WhatsApp no hace falta nada de esto: un mensaje del supervisor se envía directo por
la API de Twilio, igual que cualquier respuesta de Lucy.

## Panel de administración (`/admin`)

Con el servidor corriendo, entra a:

```
http://localhost:3000/admin
```

- **Usuario:** `admin`
- **Contraseña:** la que hayas puesto en `ADMIN_PASSWORD` en tu `.env`

Si `ADMIN_PASSWORD` no está configurada, el login siempre devuelve error — es
intencional, para que el panel nunca quede accesible con una contraseña vacía.

### Qué incluye

- **Lista de conversaciones** — fecha de inicio, duración, cantidad de mensajes,
  ramos mencionados (Personas / Automóviles / Patrimoniales / Fianzas) y si el
  usuario pidió hablar con un asesor humano.
- **Detalle de conversación** — al hacer clic en una fila se abre el chat completo,
  con las mismas burbujas y avatar de Lucy que ve el usuario en el widget.
- **Búsqueda y filtros** — por texto (ID de sesión o el primer mensaje), por rango
  de fechas, por ramo mencionado y por si se solicitó un asesor. Los filtros se
  combinan entre sí y se aplican en el navegador sobre la lista ya cargada.
- **Exportar CSV** — botón "⬇ Exportar CSV" que descarga todas las conversaciones
  guardadas (fecha, duración, mensajes, ramos, cotizaciones, si pidió asesor y una
  vista previa).
- **Pestaña "👤 Clientes"** — memoria persistente de clientes identificados (ver
  sección [Memoria persistente de clientes](#memoria-persistente-de-clientes) más
  abajo): lista, perfil editable (VIP, notas internas, próxima renovación, etc.) y
  el historial completo de conversaciones de cada uno, sin importar el canal.
- **Pestaña "🚨 Siniestros"** — todos los siniestros abiertos por Lucy (ver sección
  [Gestión de siniestros](#gestión-de-siniestros) más arriba): lista con filtros por
  estado y por "solo mayores", y detalle editable (estado, ajustador, monto aprobado,
  documentos, comentarios).
- **Pestaña "📝 Emisiones"** — solicitudes de emisión de póliza enviadas desde el
  [portal de corredores](#portal-de-corredores-corredor): aprobarlas o rechazarlas
  dispara una notificación en tiempo real al corredor que las envió.
- **Pestaña "❓ Preguntas sin respuesta"** — gaps de conocimiento registrados solos por
  el [motor de inteligencia](#motor-de-inteligencia): revisar, dejar notas, marcar
  como resueltas.
- **Modo supervisor** — desde el detalle de cualquier conversación: verla en vivo,
  tomar control total, mandar un mensaje como si lo hubiera escrito Lucy ("shadow
  messaging") y dejar notas internas — ver [Modo supervisor](#modo-supervisor).
  También se ve la valoración de calidad (⭐ 1-5) y si quedó escalada (tono molesto
  detectado) — columna "Valoración" y filtro dedicado en la tabla de conversaciones.
- **Pestaña "⚙️ Cotizador"** — editor no-code de las tarifas, tasas y textos del
  cotizador automático (ver sección anterior).
- **Pestaña "📊 Reportes"** — dashboard de métricas y gráficos (ver sección
  siguiente).
- **Canal de la conversación** — columna "Canal" en la tabla (con filtro
  Web/WhatsApp) y una insignia verde de WhatsApp para distinguir de un vistazo las
  conversaciones que llegaron por WhatsApp de las del chat web. El detalle de la
  conversación muestra el número de teléfono del usuario en ese caso.

### Pestaña "📊 Reportes"

Todas las métricas se calculan en el servidor a partir de `conversations.json`
(endpoint `GET /api/admin/reports`) cada vez que se abre la pestaña.

**Tarjetas numéricas:**

- Conversaciones hoy / esta semana (últimos 7 días) / este mes
- Promedio de mensajes por conversación
- % de conversaciones donde se solicitó un asesor humano
- % de conversaciones donde se generó una cotización
- Ramo más consultado (el que aparece en más conversaciones)

**Gráficos** (con [Chart.js](https://www.chartjs.org/) desde CDN, en los colores
de marca de La Occidental):

1. **Barras** — conversaciones iniciadas por día, últimos 30 días (con ceros en
   los días sin actividad).
2. **Dona** — distribución de conversaciones por ramo (Personas / Automóviles /
   Patrimoniales / Fianzas).
3. **Línea** — cantidad de mensajes enviados por hora del día (0h a 23h), en
   horario de Venezuela (UTC-4) independientemente de en qué zona horaria corra
   el servidor.

**Tabla de cotizaciones** — todas las cotizaciones generadas (de cualquier
conversación), con fecha, ramo, valor estimado (prima anual para RCV/HCM, valor
asegurado para Patrimoniales) y los datos del solicitante (nombre, cédula, correo)
cuando pidió la póliza formal. Botón "⬇ Exportar CSV" (`GET
/api/admin/quotes-export.csv`) para descargarla completa.

### Cómo se detectan los "ramos" y la "solicitud de asesor"

Es una heurística simple por palabras clave sobre el texto de la conversación
(ver `RAMO_KEYWORDS` y `ADVISOR_KEYWORDS` en `server.js`), no una clasificación
garantizada al 100%. La solicitud de asesor también se marca automáticamente
cuando Lucy responde ofreciendo el correo de soporte (`SUPPORT_EMAIL`), que es lo
que hace según su prompt cuando deriva a un humano. Ajusta esas listas de palabras
si necesitas mayor precisión.

### Cómo se guardan las conversaciones

Cada conversación del widget genera un `sessionId` en el navegador (guardado en
`sessionStorage`, dura mientras la pestaña está abierta) y se envía junto con cada
mensaje a `/api/chat`. El servidor guarda/actualiza esa conversación completa en
`conversations.json` después de cada intercambio.

**Es un almacenamiento simple pensado para empezar ("por ahora"):**

- Un solo archivo JSON local — sin índices, sin control de concurrencia real más
  allá de una cola de escritura en memoria. Para un volumen alto de conversaciones,
  migra a una base de datos (PostgreSQL, MongoDB, etc.).
- Las sesiones de administrador viven en memoria del proceso — si reinicias el
  servidor, todos los administradores conectados deberán volver a iniciar sesión
  (las conversaciones guardadas en `conversations.json` no se pierden).
- `conversations.json` contiene el texto completo de lo que los usuarios escriben
  (que puede incluir nombre, cédula, etc. si están cotizando). Ya está excluido en
  `.gitignore` — no lo subas a un repositorio ni lo compartas sin anonimizar.

## Adjuntos (fotos, documentos y notas de voz en el chat)

El botón 📎, junto al campo de texto, permite adjuntar **JPG, PNG o PDF** (máx. 5 MB,
configurable con `MAX_UPLOAD_SIZE_MB`). Casos de uso:

- **Siniestros** — el usuario envía fotos del accidente/daño; Lucy las analiza con
  Claude Vision y da observaciones preliminares (nunca confirma cobertura ni montos
  de indemnización — ver el prompt del sistema, sección "Fotos y documentos
  adjuntos").
- **Documentos** — foto o PDF de cédula/póliza; Lucy usa el texto legible como
  contexto de la conversación.
- **Vehículos** — foto del vehículo como referencia conversacional para una
  cotización (la tarifa formal la sigue calculando el formulario del cotizador).

**Cómo funciona:**

1. El archivo se sube a `POST /api/upload`; el servidor valida su tipo real por la
   firma de sus bytes (no confía en el Content-Type que declara el navegador),
   lo guarda en `uploads/<fileId>.<ext>` con un nombre aleatorio e impredecible
   (nunca el nombre original; las notas de voz van en `uploads/audio/`), y — si es
   un PDF — extrae su texto con `pdf-parse`, o — si es una nota de voz — la
   transcribe con Whisper (ver más abajo).
2. El widget muestra un thumbnail del adjunto en el campo de mensaje y, al enviarlo,
   dentro de la burbuja del chat.
3. En el siguiente mensaje a `/api/chat`, el servidor resuelve el adjunto por su
   `fileId` contra su propio índice (`uploads/uploads-index.json`) — nunca confía en
   los metadatos que el cliente reenvíe — y arma el mensaje para Claude: una imagen
   se envía como bloque de visión (bytes reales en base64); el texto de un PDF se
   antepone como contexto; la transcripción de una nota de voz se envía tal cual,
   como si fuera el texto que escribió el usuario.
4. Para no re-enviar (ni re-cobrar) la misma imagen en cada turno de una
   conversación larga, **solo el adjunto de imagen más reciente** viaja con sus
   bytes completos a Claude; los adjuntos de imagen más antiguos en el historial
   quedan como una referencia de texto. El texto de los PDFs y las transcripciones
   de audio, al ser livianos, sí se conservan completos en todo el historial.

En el panel `/admin`, las conversaciones con adjuntos muestran un ícono 📎 en la
tabla, y el detalle de la conversación reproduce el thumbnail/chip del archivo (o el
reproductor + transcripción, para notas de voz) tal como lo vio el usuario en el chat.

**Nota:** los archivos subidos no se eliminan automáticamente (no hay una tarea de
limpieza en esta versión); si necesitas gestionar espacio en disco a largo plazo,
implementa un borrado periódico de `uploads/` según tu política de retención.

### Notas de voz (grabación + transcripción con Whisper)

Junto al botón de enviar hay un botón de micrófono 🎤 (estilo WhatsApp): mantenerlo
presionado graba audio (`MediaRecorder`, con el formato que soporte el navegador —
WebM/Opus en Chrome/Firefox/Edge, MP4/AAC en Safari), soltarlo lo envía, y deslizar
el dedo/mouse hacia la izquierda mientras se graba lo cancela. Grabación máxima: 2
minutos (se envía automáticamente al llegar al límite).

Al recibirse en el servidor, la nota de voz se transcribe a español con la API de
**Whisper de OpenAI** (`whisper-1`, `POST /v1/audio/transcriptions`) — un proveedor
independiente de Anthropic, ya que Claude no transcribe audio. Esto requiere
`OPENAI_API_KEY` en tu `.env` (ver la tabla de variables de entorno más arriba); sin
ella, las notas de voz se siguen guardando pero no se transcriben, y el usuario recibe
un aviso en su lugar. La transcripción ocurre **siempre en el servidor**, nunca en el
navegador del usuario.

En el chat, la burbuja de la nota de voz muestra un reproductor compacto (▶/⏸ + un
waveform simple que se va pintando de verde a medida que avanza la reproducción) y,
debajo, la transcripción en texto pequeño gris ("📝 Transcripción: ..."). Esa misma
transcripción es lo que Lucy recibe como si fuera un mensaje de texto normal — el
usuario nunca tiene que repetir por escrito lo que ya dijo por voz.

## Respuestas de Lucy en audio (texto-a-voz)

Además de transcribir lo que el usuario dice, Lucy puede **responder** con su propia
voz — en el chat web y por WhatsApp.

**¿Cuándo responde con audio?**

1. Si el usuario le envió una nota de voz, Lucy responde en el mismo formato.
2. Si el usuario lo pide explícitamente ("respóndeme por audio", "mándame un audio",
   etc.) o se está despidiendo ("adiós", "hasta luego", "nos vemos"...).
3. En el mensaje de bienvenida, siempre — tanto el saludo del widget web como el
   mensaje de bienvenida de WhatsApp.

En todos los casos, el audio es un **envío aparte** del texto — nunca lo reemplaza; si
la generación de audio falla (o no hay ningún proveedor de TTS configurado), el chat
sigue funcionando normalmente, solo con texto.

**Proveedor de voz:** [ElevenLabs](https://elevenlabs.io) es el preferido (voz más
natural, español latinoamericano — configura `ELEVENLABS_API_KEY` y
`ELEVENLABS_VOICE_ID` con el ID de una voz femenina en español, p. ej. "Rachel" o
"Valentina" desde tu [voice library](https://elevenlabs.io/app/voice-library)). Si no
está configurado, o falla en tiempo real, Lucy cae automáticamente a la API de
texto-a-voz de OpenAI (`tts-1`, voz `nova`), reutilizando la misma `OPENAI_API_KEY` de
la transcripción de notas de voz.

**Canal web:** la respuesta en audio aparece como una burbuja especial (con el avatar
de Lucy) que incluye una waveform animada mientras reproduce
([wavesurfer.js](https://wavesurfer.xyz), cargada perezosamente desde CDN la primera
vez que hace falta — si no llega a cargar, cae a una waveform estática igual a la de
las notas de voz del usuario, sin romper el reproductor), la transcripción completa
colapsable ("Ver transcripción ▼") y un botón de descarga (⬇️).

**Canal WhatsApp:** el audio generado (MP3) se convierte a **OGG/Opus** con `ffmpeg`
(vía `fluent-ffmpeg` + `ffmpeg-static`, que trae su propio binario — no hace falta
instalar ffmpeg aparte en el sistema), el único formato que WhatsApp reconoce como nota
de voz nativa (con su propio reproductor y waveform); si se enviara en MP3, llegaría
como un archivo adjunto genérico en vez de una nota de voz. Se envía vía Twilio Media
(`mediaUrl`), así que el usuario la recibe exactamente igual que una nota de voz
grabada por cualquier otro contacto.

**Todos** los audios que Lucy genera se guardan en `uploads/audio/luci/` y quedan
registrados en el índice de adjuntos — el panel `/admin` los muestra en el transcript
de cada conversación con una insignia "Generado por Lucy · [proveedor]" para
distinguirlos de las notas de voz que grabó el usuario.

## Videos explicativos de Lucy

Lucy puede enviar videos cortos tutoriales cuando detecta ciertas preguntas frecuentes.
El catálogo vive en `server.js` (`VIDEO_CATALOG`) y hoy cubre:

| Pregunta del usuario (ejemplos)         | Video                              | Archivo                              |
| ---------------------------------------- | ----------------------------------- | ------------------------------------- |
| "¿Cómo reporto un siniestro?"            | Cómo reportar un siniestro          | `como-reportar-siniestro.mp4`         |
| "¿Cómo renuevo mi póliza?"               | Cómo renovar tu póliza              | `como-renovar-poliza.mp4`             |
| "¿Qué cubre el HCM?"                     | Coberturas del HCM explicadas       | `coberturas-hcm-explicadas.mp4`       |
| *(sin frase específica en el pedido original — agregada por consistencia)* | Cómo usar el portal del cliente | `app-cliente-tutorial.mp4` |

Los archivos van en **`public/assets/luci-videos/`**, con esos nombres exactos — hoy
son **placeholders** generados con ffmpeg (un fondo de color con el título superpuesto,
~4 segundos, ~13 KB cada uno) para que la función completa se pueda probar de punta a
punta; reemplázalos por los videos reales cuando estén listos, **sin tocar código**
(mismo nombre de archivo = mismo disparador). Para agregar un video nuevo al catálogo,
o cambiar las frases que lo activan, edita el arreglo `VIDEO_CATALOG` en `server.js`.

La detección de intención es por palabras clave sobre lo que escribió el usuario (o su
nota de voz ya transcrita) — determinista, igual que el cotizador y el menú de
WhatsApp, nunca depende de que el modelo "decida" enviar un video.

**Canal web:** Lucy envía primero un mensaje de texto ("Te envío este video explicativo
👇") y, debajo, el video en un reproductor `<video>` HTML5 con controles nativos del
navegador, poster (el primer frame del video, extraído automáticamente con ffmpeg al
iniciar el servidor) mientras carga, y tamaño máximo 280×200px.

**Canal WhatsApp:** se envía el archivo directamente por Twilio Media
(`mediaUrl`, con `Content-Type: video/mp4` — Express lo determina automáticamente por
la extensión) solo si pesa menos de 16 MB (el límite de WhatsApp para adjuntos de
video). Si pesa más, se comprime al vuelo con ffmpeg (resolución reducida, `crf 30`) y
la versión comprimida se **cachea en disco** (`uploads/video-cache/`) para no volver a
comprimir el mismo video en cada envío; si aun comprimido sigue pesando demasiado (o la
compresión falla), se envía un enlace en su lugar — el de YouTube configurado para ese
video (`youtubeUrl` en `VIDEO_CATALOG`, vacío por defecto) o, si no hay ninguno, el
link directo al archivo.

## Imágenes e infografías de Lucy

Además de video, Lucy puede adjuntar imágenes/infografías de un catálogo cuando la
pregunta del usuario lo amerita — mismo mecanismo determinista por palabras clave que
los videos (`MEDIA_CATALOG` en `server.js`), **no** depende de que el modelo decida
incluir la imagen. Cubre hoy:

| Pregunta del usuario (ejemplos)              | Imagen                              | Archivo                                    |
| ---------------------------------------------- | ------------------------------------ | -------------------------------------------- |
| "¿Qué cubre el seguro de auto?"                | Coberturas de Automóviles            | `coberturas/autos.png`                       |
| "¿Qué hago en un accidente?"                   | Pasos en un accidente de tránsito    | `siniestros/pasos-accidente.png`             |
| "¿Qué documentos necesito para un siniestro?"  | Documentos requeridos                | `siniestros/documentos-requeridos.png`       |
| "¿Dónde están sus oficinas?"                   | Oficinas en Maracaibo                | `contacto/oficinas-mapa.png`                 |
| *(sin frase específica — agregadas por consistencia)* | Coberturas de HCM / Patrimoniales / Fianzas | `coberturas/hcm.png`, `patrimoniales.png`, `fianzas.png` |
| Mensaje de bienvenida (siempre)                | Bienvenida a La Occidental           | `general/bienvenida.png`                     |

Los archivos van en **`public/assets/lucy-media/`**, con esas rutas exactas — hoy son
**placeholders** generados con `sharp` (fondo de color de marca, con el título
renderizado como SVG); reemplázalos por las imágenes reales cuando estén listas, sin
tocar código. Nota: la pregunta por coberturas de HCM coincide **a la vez** con un video
Y una infografía (`VIDEO_CATALOG` y `MEDIA_CATALOG` se solapan a propósito ahí) — Lucy
puede enviar ambos en el mismo turno; edita los triggers si prefieres que no se solapen.

> **Nota de diseño:** el pedido original sugería que Lucy decidiera el adjunto emitiendo
> JSON con una clave `"media"` en su propia respuesta, parseado por el servidor. Se optó
> por el mismo mecanismo determinista por palabras clave que ya usan el cotizador y los
> videos, en vez de pedirle al modelo que devuelva JSON: así no se rompe el streaming de
> texto en tiempo real (una respuesta a medio formatear como JSON no se puede mostrar
> progresivamente), y se evita el riesgo de que el modelo devuelva un JSON mal formado.
> El servidor sí usa internamente un campo `media` con esa forma — solo que lo decide
> él mismo, no lo extrae del texto de Claude.

**Canal web:** la imagen aparece como una burbuja con bordes redondeados (máx. 280px de
ancho) en el mismo mensaje que la respuesta de texto de Lucy. Un clic la abre en un
**lightbox** (overlay de pantalla completa, con animación, cierre con clic afuera, el
botón ✕, o la tecla Escape) y tiene un botón de descarga (⬇️) en la esquina.

**Canal WhatsApp:** se envía la imagen primero (vía Twilio Media), **antes** del
mensaje de texto. Si pesa más de 5 MB, se redimensiona al vuelo con **sharp**
(ancho máx. 1600px, cachea el resultado en `uploads/media-cache/` para no reprocesar
la misma imagen en cada envío); si sigue pesando demasiado, no se envía el archivo (el
texto de la respuesta ya describe lo que la imagen mostraba).

## WhatsApp Business (vía Twilio)

Lucy también responde por WhatsApp, usando [Twilio](https://www.twilio.com/whatsapp)
como proveedor de la API de WhatsApp Business. La integración vive en el endpoint
`POST /webhook/whatsapp` de `server.js` y reutiliza toda la lógica ya existente del
chat web:

- **Mismo cerebro, mismo system prompt.** Las respuestas de WhatsApp usan el mismo
  `SYSTEM_PROMPT` que el chat web (ramos, tono, cotización, siniestros, derivación a
  un asesor humano, prohibición de inventar precios/condiciones), con un pequeño
  añadido exclusivo de WhatsApp que le aclara al modelo que no existe un formulario
  interactivo en este canal y que debe mantener las respuestas breves.
- **Historial por número de teléfono.** Cada conversación de WhatsApp se guarda en el
  mismo `conversations.json` que el chat web, mas con `channel: "whatsapp"` y como
  clave el número de teléfono del usuario (formato `whatsapp:+58...`), de modo que
  Lucy recuerda el contexto entre mensajes de una misma persona.
- **Fotos, documentos y notas de voz.** Las imágenes, PDFs y notas de voz enviados por
  WhatsApp se descargan de los servidores de Twilio y se procesan con el mismo
  pipeline de adjuntos que el chat web (Claude Vision para imágenes, `pdf-parse` para
  PDFs, Whisper para audio) — ver la sección
  [Adjuntos](#adjuntos-fotos-documentos-y-notas-de-voz-en-el-chat) arriba. Cuando
  Whisper transcribe la nota de voz con éxito, Lucy responde primero con
  "🎤 Escuché: [transcripción]" y a continuación su respuesta real; si no logra
  transcribirla (o `OPENAI_API_KEY` no está configurada), responde
  "No pude entender el audio. ¿Podrías escribirlo?" y no llama a Claude con un
  adjunto que no pudo interpretar.
- **Respuestas en audio.** Lucy también puede responder por WhatsApp con notas de voz
  nativas (convertidas a OGG/Opus con ffmpeg) — ver la sección
  [Respuestas de Lucy en audio](#respuestas-de-lucy-en-audio-texto-a-voz) arriba para
  las reglas de cuándo se activa.
- **Videos explicativos.** Cuando la pregunta del usuario coincide con el catálogo de
  videos (ver [Videos explicativos de Lucy](#videos-explicativos-de-lucy) arriba), se
  envían igual que en el chat web — como archivo si pesa menos de 16 MB, o comprimido
  con ffmpeg, o como enlace si no cabe de ninguna forma.
- **Imágenes e infografías.** Cuando la pregunta coincide con el catálogo de imágenes
  (ver [Imágenes e infografías de Lucy](#imágenes-e-infografías-de-lucy) arriba), se
  envían **antes** del mensaje de texto, redimensionadas con sharp si pesan más de 5 MB.
- **Bienvenida y menú.** Al primer mensaje de un número nuevo, Lucy envía la imagen de
  bienvenida y un saludo de texto. Si el usuario escribe "hola" o "menú" (o elige una
  opción numerada del 1 al 4), se muestra/atiende un menú rápido: 1️⃣ Cotizar seguro,
  2️⃣ Reportar siniestro, 3️⃣ Consultar póliza, 4️⃣ Hablar con un asesor.
- **Firma de Twilio verificada.** Cada petición entrante a `/webhook/whatsapp` se
  valida contra la firma `X-Twilio-Signature` antes de procesarse, para asegurar que
  proviene realmente de Twilio.
- **Límite de mensajes por número**, no por IP (todas las peticiones de Twilio llegan
  desde las IPs de Twilio, así que limitar por IP afectaría a todos los usuarios de
  WhatsApp por igual).

Para dar de alta la integración necesitas configurar `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` y `PUBLIC_BASE_URL` (ver
`.env.example`). La guía completa, paso a paso —desde crear la cuenta de Twilio y
activar el sandbox de pruebas, hasta solicitar el número de WhatsApp Business en
producción— está en **[WHATSAPP_SETUP.md](WHATSAPP_SETUP.md)**.

## Seguridad

- La clave de API **nunca** se expone al navegador; todas las llamadas a Anthropic
  ocurren en `server.js`, en el servidor.
- **El servidor solo expone `public/` como archivos estáticos** — nunca la raíz del
  proyecto. Esto es intencional: servir todo `__dirname` (como haría
  `express.static(__dirname)`) dejaría `server.js`, `package.json`,
  `conversations.json` (PII de usuarios), `quoter-config.json` y
  `uploads/uploads-index.json` descargables por cualquiera en URLs como
  `/conversations.json`. Si mueves o agregas archivos a la raíz del proyecto,
  **no los pongas dentro de `public/`** a menos que deban ser públicos.
- Los archivos adjuntos se sirven por un `fileId` aleatorio e impredecible vía
  `GET /uploads/:fileId` (nunca por listado de directorio ni por su nombre
  original), y su tipo real se valida por la firma de sus bytes antes de guardarlos.
- Se aplica un límite de peticiones (`express-rate-limit`) para mitigar abuso.
- El backend valida y recorta el historial de mensajes recibido del cliente antes de
  reenviarlo a la API.
- Configura `ALLOWED_ORIGINS` en producción para restringir qué dominios pueden
  llamar a `/api/chat`.
- El panel `/admin` usa una cookie de sesión `HttpOnly` (no accesible desde
  JavaScript) con expiración; los intentos de login están limitados por IP
  (`express-rate-limit`) y la contraseña se compara en tiempo constante para
  evitar ataques de temporización. Igual, usa siempre HTTPS en producción — sin
  eso, la cookie de sesión viaja sin cifrar.
- Cada petición a `POST /webhook/whatsapp` se valida contra la firma
  `X-Twilio-Signature` (HMAC-SHA1 con tu Auth Token) antes de procesarse, para
  descartar peticiones que no vengan realmente de Twilio — ver
  [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md).

## Despliegue en producción

1. Define `ANTHROPIC_API_KEY`, `ADMIN_PASSWORD`, `ALLOWED_ORIGINS` y el resto de
   variables como variables de entorno reales en tu proveedor de hosting (no
   subas `.env` al repositorio). Usa una contraseña robusta para `ADMIN_PASSWORD`.
2. Ejecuta `npm install --omit=dev && npm start`, o usa un gestor de procesos como
   [PM2](https://pm2.keymetrics.io/) para mantener el servidor activo.
3. Sirve el sitio detrás de HTTPS (requerido para producción y recomendado para que
   `fetch` con streaming funcione de forma óptima).

## Licencia

Uso interno de La Occidental C.A. de Seguros.
