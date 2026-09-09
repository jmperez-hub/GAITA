# Manual de infraestructura — Lucy, C.A. de Seguros La Occidental

Dirigido al equipo de TI/infraestructura responsable de alojar, operar y monitorear el sistema
en producción. Para la instalación paso a paso, ver `MANUAL_INSTALACION.md`; para el detalle de
cada archivo de datos, `DICCIONARIO_DATOS.md`; para la arquitectura completa, `BLUEPRINT.md`.

---

## 1. Requisitos del servidor

| Recurso | Mínimo | Recomendado |
|---|---|---|
| Node.js | 18.x | 20.x LTS o superior |
| CPU | 1 vCPU | 2 vCPU |
| RAM | 512 MB | 1-2 GB |
| Disco | 2 GB libres | 10 GB (adjuntos de usuarios crecen con el tiempo) |
| Sistema operativo | Cualquiera con Node.js (Linux, Windows Server, macOS) | Linux (Ubuntu 22.04/24.04 LTS o similar) |
| Red saliente (HTTPS 443) | Hacia `api.anthropic.com`, `api.openai.com`, `api.elevenlabs.io`, `api.twilio.com`, y el servidor SMTP configurado | — |
| Red entrante | Puerto configurado en `PORT` (por defecto 3000), detrás de un proxy HTTPS | — |

Es un **proceso Node.js único** (no hay clúster ni balanceo interno) — para más capacidad, se
escala horizontalmente poniendo varias instancias detrás de un balanceador (ver §6, "Limitación
importante: estado en memoria").

---

## 2. Topología recomendada

```
Internet
   │
   ▼
┌─────────────────────┐        HTTPS (443)
│  Proxy inverso        │  ◄──────────────────  navegadores / Twilio (webhook)
│  (Nginx / Caddy / ALB)│
└─────────┬────────────┘
          │ HTTP (interno, puerto PORT=3000)
          ▼
┌─────────────────────┐
│  Node.js (server.js) │  ── PM2 (o systemd) para mantenerlo activo y reiniciar ante fallos
│  proceso único        │
└─────────┬────────────┘
          │
          ▼
   Disco local: conversations.json, data/*.json, quoter-config.json, uploads/
```

- El **proxy inverso** (Nginx, Caddy, un Application Load Balancer, etc.) es quien termina TLS y
  reenvía a Node por HTTP en la red interna — Node mismo no sirve HTTPS directamente.
- **PM2** (o un servicio `systemd` equivalente) mantiene el proceso vivo, lo reinicia si crashea,
  y centraliza logs (`pm2 logs`).
- No hay base de datos externa que aprovisionar — la persistencia es el propio disco del
  servidor (ver §5, respaldo).

---

## 3. Variables de entorno — referencia completa

Todas se definen en un archivo `.env` en la raíz del proyecto (nunca se sube a git — está en
`.gitignore`). La plantilla completa, con comentarios, está en `.env.example`.

### 3.1 Obligatorias para que el sistema arranque útilmente

| Variable | Para qué | Sin ella... |
|---|---|---|
| `ANTHROPIC_API_KEY` | Motor conversacional (Claude) | Lucy no puede responder ningún mensaje |
| `ADMIN_PASSWORD` | Acceso al panel `/admin` | `/admin` queda deshabilitado |
| `JWT_SECRET` | Firma de sesiones del portal `/corredor` | `/corredor` y `/api/corredor/*` quedan deshabilitados |

### 3.2 Opcionales — cada una activa una funcionalidad independiente

| Grupo | Variables | Si faltan |
|---|---|---|
| WhatsApp (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `PUBLIC_BASE_URL` | No hay canal de WhatsApp; el widget web sigue funcionando |
| Verificación OTP por correo | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | El código OTP se imprime en el log del servidor en vez de enviarse por correo — **modo desarrollo, no dejar así en producción** |
| Notas de voz (transcripción) | `OPENAI_API_KEY` | Las notas de voz se guardan pero no se transcriben |
| Respuestas en audio (TTS) | `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` (preferido), o solo `OPENAI_API_KEY` (respaldo) | Lucy solo responde con texto |

### 3.3 Configuración general (todas tienen un valor por defecto razonable)

| Variable | Por defecto | Descripción |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5` | Modelo principal de conversación |
| `CLAUDE_FAST_MODEL` | `claude-haiku-4-5-20251001` | Modelo económico del clasificador de intención/emoción |
| `PORT` | `3000` | Puerto interno del backend Express |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Orígenes permitidos por CORS, separados por coma — **ajustar al dominio real en producción** |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` | `60000` / `20` | Límite de peticiones por IP |
| `COMPANY_NAME` | `C.A. de Seguros La Occidental` | Usado en el prompt del sistema y en el remitente de correos OTP |
| `ASSISTANT_NAME` | `Lucy` | Nombre de la asistente |
| `SUPPORT_EMAIL` / `SUPPORT_PHONE` | `info@laoccidental.com` / — | Canal de contacto que ofrece Lucy al derivar a un asesor |
| `CLAIMS_PHONE` | `0212-6204444` | Línea de siniestros/emergencias 24/7 |
| `ADMIN_SESSION_TTL_MS` | `28800000` (8 h) | Duración de sesión de `/admin` (en memoria — se cierran todas si el servidor se reinicia) |
| `CORREDOR_SESSION_TTL_MS` | `28800000` (8 h) | Duración del token JWT del portal de corredores |
| `CORREDOR_CHEQUEO_VENCIMIENTOS_MS` | `600000` (10 min) | Frecuencia de revisión de pólizas por vencer para notificaciones en tiempo real a corredores |
| `UPLOADS_DIR` | `uploads` | Carpeta de adjuntos |
| `MAX_UPLOAD_SIZE_MB` | `5` | Tamaño máximo por archivo adjunto |

### 3.4 Rutas de archivos de datos (todas editables si se quiere mover la ubicación de disco)

`CONVERSATIONS_FILE`, `CLIENTES_FILE`, `POLIZAS_FILE`, `SINIESTROS_FILE`, `CORREDORES_FILE`,
`EMISIONES_FILE`, `NOTIFICACIONES_PROGRAMADAS_FILE`, `GAPS_CONOCIMIENTO_FILE`,
`QUOTER_CONFIG_FILE` — ver el detalle de cada uno en `DICCIONARIO_DATOS.md`.

### 3.5 Integración con sistemas externos de pólizas/siniestros (opcional)

`POLIZAS_API_URL` y `SINIESTROS_API_URL` — si se definen, el backend deja de usar los archivos
JSON locales y consulta una API REST real con el contrato documentado en `.env.example` (líneas
79-100). Mientras el cliente no tenga un sistema de core de pólizas expuesto por API, se deja
vacío y se usan los archivos JSON.

---

## 4. Servicios externos — checklist de aprovisionamiento

| Servicio | Qué se necesita | Dónde se obtiene |
|---|---|---|
| Anthropic | Cuenta + API key con crédito | console.anthropic.com |
| Twilio | Cuenta, número de WhatsApp Business verificado (o Sandbox para pruebas), Account SID + Auth Token | console.twilio.com — ver `WHATSAPP_SETUP.md` para el paso a paso completo |
| OpenAI | Cuenta + API key con crédito | platform.openai.com |
| ElevenLabs (opcional) | Cuenta + API key + una voz femenina en español | elevenlabs.io |
| SMTP | Cualquier proveedor (Gmail con contraseña de aplicación, SendGrid, Amazon SES, el propio servidor de correo corporativo, etc.) | — |

**Costo variable:** Anthropic, OpenAI y ElevenLabs cobran por uso (tokens/caracteres/minutos).
Twilio cobra por mensaje de WhatsApp enviado. No hay costos fijos de licencia del propio
software (es código propio, sin dependencias comerciales).

---

## 5. Respaldo y recuperación

Como la persistencia es el sistema de archivos, el respaldo se reduce a **copiar estos
directorios/archivos regularmente** (cron diario recomendado):

```
conversations.json
data/
quoter-config.json
uploads/
.env          (guardar en un gestor de secretos, NO en el mismo backup que el resto)
```

No hay un procedimiento de "restore" especial: se detiene el proceso, se restituyen los
archivos, se reinicia. No hay migraciones de esquema que ejecutar (no hay esquema formal — son
JSON).

**Recomendación:** dado el volumen de datos sensibles (`conversations.json`,
`data/clientes.json`, `data/emisiones.json` contienen PII de clientes reales), cifrar los
backups en reposo y restringir el acceso al servidor.

---

## 6. Limitación importante: estado en memoria

Varias piezas del sistema viven **en memoria del proceso**, no en disco:

- Caché de conversaciones (`conversationsCache`) — se recarga de `conversations.json` al
  arrancar, pero las escrituras nuevas quedan en memoria hasta que la cola de escritura las
  persiste (son fracciones de segundo, no debería perderse nada en un reinicio limpio).
- Sesiones de `/admin` (cookies) — se cierran todas si el proceso se reinicia.
- Conexiones SSE activas (`/api/chat/live`, `/api/admin/conversations/:id/live`,
  `/api/corredor/events`) — se cortan si el proceso se reinicia; el cliente debe reconectar
  (los widgets ya lo hacen automáticamente).

**Esto significa que correr más de una instancia detrás de un balanceador sin "sticky
sessions"** (afinidad de sesión por IP/cookie) causaría inconsistencias — un usuario podría
"perder" su sesión SSE o de admin si el balanceador lo manda a otra instancia. Para escalar
horizontalmente de forma correcta, hace falta:

1. Sticky sessions en el balanceador, **o**
2. Migrar la persistencia de `conversationsCache`/sesiones a un almacén compartido (Redis, por
   ejemplo) — cambio de arquitectura no incluido en esta entrega.

Para el volumen actual, **una sola instancia con PM2 en modo "cluster" de 1 proceso** (o modo
"fork") es suficiente y evita este problema por completo.

---

## 7. Logs y monitoreo

- El proceso escribe a `stdout`/`stderr` — con PM2: `pm2 logs lucy` (o el nombre que se le dé al
  proceso). Sin PM2, redirigir la salida a un archivo o a un colector de logs (journald, etc.).
- No hay un sistema de métricas/APM integrado — para monitoreo de disponibilidad, usar
  `GET /api/health` como endpoint de *healthcheck* (devuelve 200 si el proceso está vivo).
- Errores de integraciones externas (Anthropic, Twilio, OpenAI, ElevenLabs, SMTP) se registran
  como `console.warn`/`console.error` con el prefijo `[aviso]` o `Error al...` — son el primer
  lugar a revisar ante un reporte de "Lucy no respondió" o "no llegó el WhatsApp/correo".

---

## 8. Seguridad de red

- Exponer **solo** el proxy inverso (443) a internet; el puerto de Node (`PORT`) debe quedar en
  la red interna, no accesible directamente desde afuera.
- El webhook de Twilio (`POST /webhook/whatsapp`) valida la firma HMAC de cada petición
  (`validateTwilioSignature`) — si `PUBLIC_BASE_URL` no coincide exactamente con la URL pública
  real (incluyendo `https://` y sin barra final), la validación falla y Twilio no podrá
  entregar mensajes. Configurarla explícitamente en producción (no depender de la inferencia
  automática, pensada para desarrollo).
- `ALLOWED_ORIGINS` debe listar exactamente los dominios donde se embebe el widget web — un
  valor demasiado permisivo (`*`) no está soportado por diseño.
- Ninguna de las claves de `.env` debe llegar al repositorio de git ni a logs — están todas
  fuera de `git diff`/`git log` por convención en este proyecto (el archivo `.env` real está en
  `.gitignore`; solo `.env.example`, sin valores reales, se versiona).

---

## 9. Crecimiento futuro — cuándo migrar de archivos JSON a una base de datos real

Señales de que conviene migrar `conversations.json`/`data/*.json` a Postgres (u otro motor):

- Más de unos pocos miles de conversaciones activas simultáneas (el archivo completo se
  reescribe en cada cambio — el costo crece con el tamaño total, no con el cambio individual).
- Necesidad de consultas complejas/reportes que hoy se resuelven iterando el archivo completo en
  memoria.
- Necesidad real de escalar horizontalmente (ver §6).

Mientras el volumen se mantenga en el rango actual (una aseguradora regional, no un banco
nacional), el diseño de archivos JSON es deliberadamente simple y suficiente — no se recomienda
migrar preventivamente sin una necesidad concreta.
