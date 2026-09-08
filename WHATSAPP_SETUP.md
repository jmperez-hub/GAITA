# Configuración de WhatsApp Business para Lucy (vía Twilio)

Esta guía explica, paso a paso, cómo conectar Lucy a WhatsApp usando Twilio como
proveedor de WhatsApp Business API. Cubre dos caminos:

- **Sandbox de Twilio** — listo en minutos, ideal para probar el flujo completo
  antes de comprometerte con nada. Limitado a números que se "unan" manualmente.
- **Producción** — un número de WhatsApp Business real, con el nombre y logo de
  La Occidental, verificado ante Meta. Toma más tiempo (días) por la revisión de
  Meta, pero es el camino final para atender clientes reales.

## Cómo funciona (resumen técnico)

```
Usuario en WhatsApp
      │  escribe un mensaje
      ▼
Twilio (WhatsApp Business API)
      │  POST /webhook/whatsapp  (con la firma X-Twilio-Signature)
      ▼
server.js
      │  1. Valida la firma de Twilio
      │  2. Responde 200 de inmediato (TwiML vacío) — no bloquea a Twilio
      │  3. Procesa el mensaje en segundo plano:
      │     - primer contacto → bienvenida + menú
      │     - "menú"/"hola" → menú numerado
      │     - opción 1-4 → se traduce a una frase natural para Claude
      │     - si hay foto/documento → se descarga, valida y guarda (mismo
      │       sistema de adjuntos que el chat web) y se envía a Claude Vision
      │     - si no → se llama a Claude con el mismo prompt de Lucy
      │  4. Envía la respuesta como un mensaje de WhatsApp aparte, vía la
      │     API REST de Twilio (client.messages.create)
      ▼
Usuario recibe la respuesta de Lucy en WhatsApp
```

La conversación se guarda en `conversations.json`, igual que el chat web, con el
**número de teléfono como clave** (sin el prefijo `whatsapp:`) y `channel: "whatsapp"`
para distinguirla en el panel `/admin`.

## Requisitos previos

- El chatbot ya funcionando localmente o desplegado (ver el [README](README.md)
  principal para la instalación base).
- Una cuenta de Twilio (el paso siguiente explica cómo crearla).
- Para producción: una cuenta de **Meta Business Manager** verificada y un número
  de teléfono dedicado (no puede estar ya registrado en WhatsApp personal ni en
  otra cuenta de WhatsApp Business).

---

## Parte A — Sandbox de Twilio (pruebas rápidas)

### 1. Crea tu cuenta de Twilio

1. Entra a [twilio.com/try-twilio](https://www.twilio.com/try-twilio) y crea una
   cuenta (el plan de prueba/trial es suficiente para el sandbox).
2. Verifica tu correo y tu número de teléfono cuando te lo pida.

### 2. Obtén tu Account SID y Auth Token

1. Entra a la [consola de Twilio](https://console.twilio.com).
2. En el panel principal ("Account Info"), copia:
   - **Account SID** (empieza con `AC...`)
   - **Auth Token** (haz clic en "Show" para verlo — trátalo como una contraseña,
     nunca lo compartas ni lo subas a un repositorio)

### 3. Activa el Sandbox de WhatsApp

1. En el menú lateral, ve a **Messaging → Try it out → Send a WhatsApp message**
   (o busca "WhatsApp sandbox" en el buscador de la consola).
2. Verás un número de Twilio (normalmente `+1 415 523 8886`) y un código de unión
   único, algo como `join palabra-clave`.
3. Desde el WhatsApp de un celular de prueba, envía ese mensaje (`join
   palabra-clave`) al número indicado. Twilio confirmará que tu número quedó
   conectado al sandbox — así podrás probar el flujo sin esperar la aprobación de
   Meta.

> **Nota:** cada número que quiera probar el bot debe unirse al sandbox de esta
> forma. Es una limitación solo del sandbox — en producción, cualquiera puede
> escribirle a tu número de WhatsApp Business sin pasos previos.

### 4. Expón tu servidor local a internet (solo para desarrollo)

Twilio necesita poder llamar a tu servidor por HTTPS público — en desarrollo local
usa [ngrok](https://ngrok.com/):

```bash
# Instala ngrok (https://ngrok.com/download) y luego:
ngrok http 3000
```

Copia la URL HTTPS que te da ngrok (algo como `https://a1b2c3d4.ngrok-free.app`) —
la necesitas en el siguiente paso y para la variable `PUBLIC_BASE_URL`.

> En producción, usa el dominio real de tu servidor (con HTTPS) en su lugar — no
> necesitas ngrok.

### 5. Configura el webhook del sandbox

1. En la misma página del Sandbox de WhatsApp, busca el campo **"When a message
   comes in"**.
2. Pega tu URL pública + `/webhook/whatsapp`, por ejemplo:
   ```
   https://a1b2c3d4.ngrok-free.app/webhook/whatsapp
   ```
3. Método: **HTTP POST**.
4. Guarda los cambios ("Save").

### 6. Configura las variables de entorno

En tu `.env` (ver [.env.example](.env.example)):

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=tu-auth-token-real
TWILIO_WHATSAPP_NUMBER="whatsapp:+14155238886"   # el número del sandbox, con el prefijo whatsapp:
PUBLIC_BASE_URL=https://a1b2c3d4.ngrok-free.app   # la URL de ngrok (sin barra final)
```

Reinicia el servidor (`npm start` o `npm run dev`) para que tome las variables
nuevas. En la consola deberías ver que **ya no** aparece el aviso de "Twilio
(WhatsApp) no está configurado".

### 7. Pruébalo

Desde el WhatsApp que uniste al sandbox, escríbele cualquier cosa (p. ej. "hola")
al número del sandbox. Deberías recibir el mensaje de bienvenida de Lucy con el
menú numerado. Prueba también:

- Enviar `menú` en cualquier momento → vuelve a mostrar el menú.
- Responder `1`, `2`, `3` o `4` → Lucy continúa la conversación según esa opción.
- Enviar una foto → Lucy la analiza con Claude Vision.
- Enviar un PDF → Lucy usa su texto como contexto.

Revisa el panel `/admin` → pestaña "Conversaciones": la conversación debe
aparecer con la insignia verde de WhatsApp y el número de teléfono.

---

## Parte B — Producción: WhatsApp Business API real

El sandbox es solo para pruebas — para atender clientes reales necesitas un
número de WhatsApp Business propio, con el nombre "La Occidental" verificado.

### 1. Crea (o usa) una cuenta de Meta Business Manager

1. Ve a [business.facebook.com](https://business.facebook.com) y crea una cuenta
   de negocio para La Occidental, si no existe una.
2. Completa la verificación del negocio (Meta puede pedir documentos legales de
   la empresa — RIF, registro mercantil, etc.). Este paso puede tardar varios
   días hábiles.

### 2. Conecta Meta Business Manager con Twilio

1. En la consola de Twilio, ve a **Messaging → Senders → WhatsApp senders**.
2. Sigue el asistente "Register a WhatsApp Sender" — te pedirá:
   - El número de teléfono que usarás para WhatsApp Business (debe poder recibir
     un código de verificación por SMS o llamada, y **no puede estar ya activo**
     en la app de WhatsApp normal ni en WhatsApp Business App).
   - Vincular con tu cuenta de Meta Business Manager (Twilio te guía a un flujo
     de Meta llamado "Embedded Signup").
3. Completa el perfil de WhatsApp Business: nombre visible ("La Occidental"),
   descripción, categoría del negocio (Seguros/Finanzas), logo, sitio web.

### 3. Espera la aprobación de Meta

Meta revisa el negocio y el número — puede tomar de horas a varios días. Twilio
te notifica por correo cuando el número queda aprobado y activo.

### 4. Solicita plantillas de mensaje (para conversaciones fuera de 24h)

WhatsApp solo permite responder **libremente** (como hace este bot) dentro de las
**24 horas** siguientes al último mensaje del usuario. Para iniciar tú una
conversación fuera de esa ventana (p. ej. un recordatorio de renovación de
póliza), necesitas una **plantilla de mensaje pre-aprobada** por Meta.

- Esto **no** afecta el flujo que ya implementamos (responder a mensajes
  entrantes) — funciona igual con el sandbox o en producción.
- Si más adelante quieres enviar mensajes proactivos (recordatorios, promociones),
  crea las plantillas en **Messaging → Content Editor** de Twilio y solicita su
  aprobación a Meta antes de usarlas.

### 5. Actualiza la configuración del webhook y del `.env`

1. En Twilio, en la configuración del **WhatsApp sender** de producción (no del
   sandbox), define el webhook de mensajes entrantes a:
   ```
   https://tu-dominio-real.com/webhook/whatsapp
   ```
2. Actualiza tu `.env` de producción:
   ```bash
   TWILIO_WHATSAPP_NUMBER="whatsapp:+58412xxxxxxx"   # tu número de WhatsApp Business real
   PUBLIC_BASE_URL=https://tu-dominio-real.com
   ```
3. Reinicia el servidor con la nueva configuración.

---

## Seguridad

- **Cada petición al webhook se valida** contra la firma `X-Twilio-Signature`
  (HMAC con tu Auth Token) — una petición que no venga realmente de Twilio se
  rechaza con `403` y nunca llega a procesarse ni a llamar a Claude. Por eso
  `PUBLIC_BASE_URL` debe coincidir **exactamente** con la URL pública que Twilio
  usa para llamarte (protocolo + dominio, sin barra final) — si la validación
  falla constantemente en un entorno con proxy/balanceador, revisa primero que
  esta variable esté bien configurada.
- El `TWILIO_AUTH_TOKEN` nunca debe subirse a un repositorio — ya está cubierto
  por `.env` en `.gitignore`.
- Las fotos/documentos que llegan por WhatsApp pasan por el mismo sistema de
  adjuntos del chat web: se valida su tipo real por la firma de sus bytes (no por
  lo que declare el remitente) antes de guardarlos.

## Límites y cosas a tener en cuenta

- **Ventana de 24 horas:** WhatsApp solo permite respuestas de texto libre dentro
  de las 24 horas posteriores al último mensaje del usuario. Como este bot
  siempre responde a un mensaje entrante, está dentro de esa ventana — no
  necesitas plantillas para el uso normal descrito aquí.
- **1600 caracteres por mensaje:** si la respuesta de Lucy es más larga, el
  servidor la divide automáticamente en varios mensajes consecutivos.
- **Tipos de adjunto soportados:** igual que el chat web — JPG, PNG y PDF, hasta
  `MAX_UPLOAD_SIZE_MB` (5 MB por defecto). Otros tipos (audio, video, stickers) se
  reciben pero no se procesan con IA; Lucy no verá ningún adjunto en ese caso.
- **Costo:** Twilio cobra por mensaje de WhatsApp enviado/recibido (y Meta cobra
  aparte por conversación en algunos países) — revisa la
  [tabla de precios de Twilio](https://www.twilio.com/en-us/whatsapp/pricing)
  antes de un lanzamiento con volumen alto.
- **Sesiones en memoria vs. producción real:** al igual que el resto del proyecto,
  esta es una integración pensada para empezar — para un volumen alto de mensajes
  de WhatsApp, considera migrar `conversations.json` a una base de datos real (ver
  el README principal).

## Solución de problemas

| Síntoma | Causa probable |
| --- | --- |
| El bot nunca responde | Revisa que el webhook en Twilio apunte a la URL correcta con `/webhook/whatsapp`, y que el servidor esté corriendo y sea alcanzable públicamente (ngrok activo, o el dominio de producción responde). |
| El servidor imprime "firma de Twilio inválida" | `PUBLIC_BASE_URL` no coincide con la URL real que usó Twilio, o el `TWILIO_AUTH_TOKEN` es incorrecto. Verifica ambos. |
| El servidor imprime "Twilio (WhatsApp) no está configurado" | Faltan `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` o `TWILIO_WHATSAPP_NUMBER` en tu `.env`. |
| "Authentication Error - invalid username" al enviar | El `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` no son válidos — revisa que los copiaste bien de la consola de Twilio (sin espacios extra). |
| El bot responde en el sandbox pero un número nuevo no recibe nada | Ese número no se unió al sandbox (`join palabra-clave`) — solo aplica en modo sandbox, no en producción. |
| Las fotos no se analizan | Verifica que `ANTHROPIC_API_KEY` esté configurada y sea válida — sin eso, Lucy tampoco responde en el chat web. |

## Recursos

- [Consola de Twilio](https://console.twilio.com)
- [Documentación de Twilio para WhatsApp](https://www.twilio.com/docs/whatsapp)
- [Meta Business Manager](https://business.facebook.com)
- [Precios de WhatsApp en Twilio](https://www.twilio.com/en-us/whatsapp/pricing)
