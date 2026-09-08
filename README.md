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
│   ├── assets/luci-videos/  #   Catálogo de videos explicativos de Lucy — ver
│   │                        #     "Videos explicativos de Lucy" más abajo
│   └── assets/lucy-media/   #   Catálogo de imágenes/infografías de Lucy — ver
│                            #     "Imágenes e infografías de Lucy" más abajo
├── Avatar Lucy.png         # Imagen original subida (no se usa en producción, solo referencia)
├── uploads/                # Fotos/documentos/notas de voz que suben los usuarios, audios que
│                           #   genera Lucy, videos comprimidos y THUMBS para WhatsApp — se crea
│                           #   solo (ver "Adjuntos", "Videos" e "Imágenes" más abajo); no versionar
├── conversations.json      # Conversaciones y cotizaciones guardadas (se crea solo; no versionar)
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
