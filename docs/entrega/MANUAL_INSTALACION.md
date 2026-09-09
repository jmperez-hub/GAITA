# Manual de instalación — Lucy, C.A. de Seguros La Occidental

Dos caminos para instalar el sistema: el **instalador automático** (recomendado para una
primera instalación en Windows) o los **pasos manuales** (para Linux/macOS, servidores sin
interfaz gráfica, o si prefieres controlar cada paso). Ambos terminan en el mismo lugar: un
proyecto con las dependencias instaladas y un archivo `.env` configurado.

Para las variables de entorno completas y el detalle de cada integración externa, ver
`MANUAL_INFRAESTRUCTURA.md`. Para cómo usar el sistema una vez instalado, `MANUAL_USUARIO.md`.

---

## Opción A — Instalador automático (Windows)

### A.1 Con el ejecutable

1. Descomprime el `.zip` de entrega en cualquier carpeta.
2. Ejecuta **`Instalador-Lucy.exe`** (está en la raíz del `.zip`) — doble clic.
3. Windows puede mostrar una advertencia de "Editor desconocido" (SmartScreen) porque el
   ejecutable no está firmado digitalmente — es normal en software interno sin firma de código
   comercial. Haz clic en **"Más información" → "Ejecutar de todas formas"**.
4. El instalador te va a pedir:
   - **Carpeta de destino** donde instalar el proyecto.
   - **Clave de API de Anthropic** (`ANTHROPIC_API_KEY`) — puedes dejarla en blanco y
     completarla después editando `.env` a mano.
   - **Contraseña del panel de administración** (`ADMIN_PASSWORD`).
   - **Puerto del servidor** (Enter para usar el valor por defecto, `3000`).
   - Si querés que Lucy corra en segundo plano con reinicio automático ante fallos (PM2).
5. Al terminar, verás las instrucciones para arrancar el servidor (`npm start`) y las URLs
   locales (`http://localhost:3000`, `/admin`, `/corredor`).

### A.2 Con el script de PowerShell (sin el .exe)

Si preferís no usar el `.exe` (por ejemplo, en un servidor donde las políticas de ejecución de
scripts lo permiten), podés correr directamente:

```powershell
cd "<carpeta del proyecto ya descomprimido>"
powershell -ExecutionPolicy Bypass -File instalador\instalar.ps1
```

El script hace exactamente lo mismo que el `.exe` (que internamente solo extrae los archivos y
llama a este mismo script) — verifica Node.js, corre `npm install`, crea y configura `.env`, y
te ofrece instalar PM2.

**Requisito previo:** Node.js 18 o superior. Si no lo tenés instalado, el script te lo indica y
te ofrece abrir la página de descarga (https://nodejs.org/, elegí la versión "LTS").

---

## Opción B — Instalación manual (Windows, Linux o macOS)

### B.1 Requisitos previos

- **Node.js 18+** (recomendado 20 LTS) — https://nodejs.org/
- Una **clave de API de Anthropic** — https://console.anthropic.com/settings/keys
- (Opcional, según lo que quieras activar) cuentas de Twilio, OpenAI, ElevenLabs, y un servidor
  SMTP — ver `MANUAL_INFRAESTRUCTURA.md` §4.

### B.2 Pasos

```bash
# 1. Entra a la carpeta del proyecto ya descomprimido
cd lucy-c-a-seguros-la-occidental

# 2. Instala las dependencias (no instala paquetes de desarrollo, más liviano)
npm install --omit=dev

# 3. Crea tu archivo de variables de entorno a partir de la plantilla
cp .env.example .env          # Windows (PowerShell): Copy-Item .env.example .env

# 4. Edita .env con un editor de texto y completa, como mínimo:
#      ANTHROPIC_API_KEY=...
#      ADMIN_PASSWORD=...
#      JWT_SECRET=...          (una cadena larga y aleatoria — ver el comando sugerido
#                                dentro del propio .env.example)

# 5. Arranca el servidor
npm start
```

Al arrancar, la consola debe mostrar:

```
✅ C.A. de Seguros La Occidental · Chatbot backend escuchando en http://localhost:3000
   Modelo configurado: claude-opus-5
   Panel de administración: http://localhost:3000/admin
   Portal de corredores: http://localhost:3000/corredor
```

Si en vez de eso ves un error, la causa más común es una variable de entorno obligatoria
faltante (`ANTHROPIC_API_KEY`) — revisá la sección "Solución de problemas" más abajo.

### B.3 Verificación rápida de que todo quedó bien

```bash
curl http://localhost:3000/api/health
# debe responder 200 OK
```

Abrí `http://localhost:3000` en el navegador — debería verse la página de demo del widget de
chat. Hacé clic en el botón verde de la esquina para abrir el chat y probar un mensaje.

---

## Configuración opcional después de la instalación base

Estos pasos activan funcionalidades adicionales — el sistema funciona sin ellos (con esa
funcionalidad puntual desactivada, ver `MANUAL_INFRAESTRUCTURA.md` §3.2).

### WhatsApp Business (Twilio)

Ver **`WHATSAPP_SETUP.md`** en la raíz del proyecto — paso a paso completo: crear cuenta de
Twilio, configurar el número de WhatsApp (Sandbox para pruebas o número verificado en
producción), y apuntar el webhook a `https://<tu-dominio>/webhook/whatsapp`.

### Verificación de identidad por correo (OTP)

Sin `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` configurados, los códigos de verificación se imprimen en
el log del servidor en vez de enviarse por correo — **esto es solo para desarrollo**. Para
producción, completá las variables `SMTP_*` en `.env` con los datos de tu proveedor de correo
(Gmail con contraseña de aplicación, SendGrid, Amazon SES, el propio servidor corporativo, etc.)

### Voz — notas de voz y respuestas en audio

- `OPENAI_API_KEY` habilita la transcripción de notas de voz que envían los usuarios.
- `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` habilitan que Lucy responda con su propia voz
  (más natural); si no están, cae automáticamente a la voz de respaldo de OpenAI (reutiliza la
  misma `OPENAI_API_KEY`).

### Panel de administración y portal de corredores

Ya quedan activos con `ADMIN_PASSWORD` y `JWT_SECRET` respectivamente (parte de la instalación
base). Las cuentas de corredores de **demostración** están en `data/corredores.json`
(credenciales documentadas en el `README.md`, sección "Portal de corredores") — reemplazalas por
cuentas reales antes de salir a producción.

---

## Despliegue en producción

1. Definí todas las variables de entorno como variables reales del sistema/proveedor de hosting
   — **nunca subas el archivo `.env` a un repositorio** (ya está en `.gitignore`). Usá una
   contraseña robusta para `ADMIN_PASSWORD` y una clave larga y aleatoria para `JWT_SECRET`.
2. Instalá dependencias en modo producción: `npm install --omit=dev`.
3. Usá un gestor de procesos (PM2 recomendado — el instalador te ofrece instalarlo) para
   mantener el servidor activo y con reinicio automático:
   ```bash
   pm2 start server.js --name lucy
   pm2 save
   pm2 startup      # deja instrucciones para que arranque solo con el sistema operativo
   ```
4. Serví el sitio detrás de **HTTPS** — necesario para producción, y recomendado para que el
   `fetch` con streaming (SSE) del widget funcione de forma óptima. Un proxy inverso (Nginx,
   Caddy) o el balanceador de tu proveedor cloud se encarga de terminar TLS.
5. Configurá `PUBLIC_BASE_URL` con el dominio público real (necesario para que la validación de
   firma de los webhooks de Twilio funcione de forma confiable).
6. Ver `MANUAL_INFRAESTRUCTURA.md` para topología recomendada, respaldo, monitoreo y seguridad
   de red.

---

## Solución de problemas frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| El servidor no arranca, error sobre `ANTHROPIC_API_KEY` | Falta o está vacía en `.env` | Completala con una clave válida de console.anthropic.com |
| `/admin` responde "no está configurado" | Falta `ADMIN_PASSWORD` en `.env` | Definila y reiniciá el servidor |
| `/corredor` no carga / da error | Falta `JWT_SECRET` en `.env` | Definila (una cadena larga aleatoria) y reiniciá |
| Los mensajes de WhatsApp no llegan a Lucy | Webhook de Twilio mal configurado, o `PUBLIC_BASE_URL` no coincide con la URL pública real | Revisá `WHATSAPP_SETUP.md` y que `PUBLIC_BASE_URL` sea exactamente la URL pública (con `https://`, sin barra final) |
| El código OTP nunca llega por correo | Falta configuración `SMTP_*` | Revisá el log del servidor — sin SMTP, el código se imprime ahí (modo desarrollo); configurá SMTP para producción |
| Lucy no responde con audio | Faltan `OPENAI_API_KEY` y/o `ELEVENLABS_*` | Son opcionales — sin ellas, Lucy responde solo con texto (comportamiento esperado) |
| `npm install` falla | Versión de Node.js muy vieja, o sin conexión a internet | Verificá `node --version` (≥ 18) y la conexión de red |
| El instalador `.exe` no arranca / Windows lo bloquea | SmartScreen (el ejecutable no está firmado) | "Más información" → "Ejecutar de todas formas" — o usá la Opción A.2 (script `.ps1` directo) |
