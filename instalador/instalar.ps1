<#
.SINOPSIS
  Instalador de Lucy — asistente virtual de C.A. de Seguros La Occidental.

.DESCRIPCION
  Script de instalación para Windows. Verifica requisitos (Node.js), instala las
  dependencias del proyecto, crea el archivo .env a partir de la plantilla (si no
  existe) y deja todo listo para arrancar el servidor con "npm start".

  No requiere conexión a internet más allá de "npm install" (descarga de paquetes
  de npm) y, si se elige, la instalación de Node.js.

.NOTAS
  Este script está pensado para ejecutarse DESDE la carpeta raíz del proyecto ya
  descomprimido (junto a package.json). El instalador empaquetado como .exe
  (Instalador-Lucy.exe, ver docs/entrega/MANUAL_INSTALACION.md) llama a este mismo
  script tras extraer el proyecto en la carpeta que elija el usuario.
#>

[CmdletBinding()]
param(
  [string]$InstallPath = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Write-Paso($texto) {
  Write-Host ""
  Write-Host "==> $texto" -ForegroundColor Cyan
}

function Write-Ok($texto) {
  Write-Host "    [OK] $texto" -ForegroundColor Green
}

function Write-Aviso($texto) {
  Write-Host "    [AVISO] $texto" -ForegroundColor Yellow
}

function Write-ErrorFatal($texto) {
  Write-Host "    [ERROR] $texto" -ForegroundColor Red
}

Write-Host "==================================================================" -ForegroundColor DarkCyan
Write-Host "  Instalador de Lucy - C.A. de Seguros La Occidental" -ForegroundColor DarkCyan
Write-Host "==================================================================" -ForegroundColor DarkCyan

# Si el script se está ejecutando desde dentro de la carpeta "instalador/" (caso
# típico al correrlo directamente desde el .zip de entrega), la raíz del proyecto
# es un nivel arriba.
$projectRoot = $InstallPath
if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
  $parent = Split-Path -Parent $projectRoot
  if (Test-Path (Join-Path $parent "package.json")) {
    $projectRoot = $parent
  }
}

if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
  Write-ErrorFatal "No se encontró package.json. Ejecuta este script desde la carpeta del proyecto Lucy (la que contiene package.json), o desde su subcarpeta 'instalador/'."
  exit 1
}

Set-Location $projectRoot
Write-Ok "Carpeta del proyecto: $projectRoot"

# --------------------------------------------------------------------------
# 1. Verificar Node.js
# --------------------------------------------------------------------------
Write-Paso "Verificando Node.js..."

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-ErrorFatal "No se encontró Node.js en este equipo."
  Write-Host ""
  Write-Host "    Lucy necesita Node.js 18 o superior (recomendado: 20 LTS)." -ForegroundColor Yellow
  Write-Host "    Descárgalo desde https://nodejs.org/ (elige la version 'LTS')," -ForegroundColor Yellow
  Write-Host "    instálalo, y vuelve a ejecutar este instalador." -ForegroundColor Yellow
  Write-Host ""
  $abrir = Read-Host "¿Abrir la página de descarga de Node.js ahora? (s/n)"
  if ($abrir -eq "s") {
    Start-Process "https://nodejs.org/"
  }
  exit 1
}

$nodeVersionRaw = (& node --version) 2>$null
$nodeVersion = $nodeVersionRaw.TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 18) {
  Write-ErrorFatal "Se encontró Node.js $nodeVersionRaw, pero Lucy necesita la version 18 o superior."
  Write-Host "    Actualiza Node.js desde https://nodejs.org/ y vuelve a ejecutar este instalador." -ForegroundColor Yellow
  exit 1
}
Write-Ok "Node.js $nodeVersionRaw detectado."

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
  Write-ErrorFatal "Se encontró Node.js pero no npm (deberían venir juntos). Reinstala Node.js desde https://nodejs.org/."
  exit 1
}
Write-Ok "npm $((& npm --version)) detectado."

# --------------------------------------------------------------------------
# 2. Instalar dependencias
# --------------------------------------------------------------------------
Write-Paso "Instalando dependencias del proyecto (npm install)... esto puede tardar unos minutos."

& npm install --omit=dev
if ($LASTEXITCODE -ne 0) {
  Write-ErrorFatal "npm install terminó con errores (código $LASTEXITCODE). Revisa el mensaje de arriba."
  exit 1
}
Write-Ok "Dependencias instaladas."

# --------------------------------------------------------------------------
# 3. Crear .env si no existe
# --------------------------------------------------------------------------
Write-Paso "Configurando variables de entorno (.env)..."

$envPath = Join-Path $projectRoot ".env"
$envExamplePath = Join-Path $projectRoot ".env.example"

if (Test-Path $envPath) {
  Write-Ok "Ya existe un archivo .env — no se modifica (borra el archivo si quieres reconfigurar desde cero)."
} else {
  if (-not (Test-Path $envExamplePath)) {
    Write-ErrorFatal "No se encontró .env.example — no se pudo crear .env."
    exit 1
  }
  Copy-Item $envExamplePath $envPath
  Write-Ok "Se creó .env a partir de la plantilla."
  Write-Host ""
  Write-Host "    A continuación se pedirán los datos mínimos para arrancar." -ForegroundColor Yellow
  Write-Host "    Puedes dejar cualquiera en blanco y completarla después editando .env a mano" -ForegroundColor Yellow
  Write-Host "    (ver docs/entrega/MANUAL_INSTALACION.md y MANUAL_INFRAESTRUCTURA.md para el resto de variables)." -ForegroundColor Yellow
  Write-Host ""

  function Set-EnvValue($archivo, $clave, $valor) {
    if ([string]::IsNullOrWhiteSpace($valor)) { return }
    $contenido = Get-Content $archivo -Raw
    $patron = "(?m)^$clave=.*$"
    $nuevaLinea = "$clave=$valor"
    if ($contenido -match $patron) {
      $contenido = [regex]::Replace($contenido, $patron, { param($m) $nuevaLinea })
    } else {
      $contenido += "`r`n$nuevaLinea`r`n"
    }
    Set-Content -Path $archivo -Value $contenido -NoNewline
  }

  $anthropicKey = Read-Host "Clave de API de Anthropic (ANTHROPIC_API_KEY) — obtenla en console.anthropic.com"
  Set-EnvValue $envPath "ANTHROPIC_API_KEY" $anthropicKey

  $adminPass = Read-Host "Contraseña para el panel de administración /admin (ADMIN_PASSWORD)"
  Set-EnvValue $envPath "ADMIN_PASSWORD" $adminPass

  Write-Host "    Generando una clave aleatoria segura para JWT_SECRET (sesiones del portal de corredores)..."
  $hexChars = [char[]]"0123456789abcdef"
  $jwtSecret = -join (1..64 | ForEach-Object { $hexChars | Get-Random })
  Set-EnvValue $envPath "JWT_SECRET" $jwtSecret
  Write-Ok "JWT_SECRET generado automáticamente."

  $puerto = Read-Host "Puerto del servidor (Enter para dejar el valor por defecto, 3000)"
  if (-not [string]::IsNullOrWhiteSpace($puerto)) {
    Set-EnvValue $envPath "PORT" $puerto
  }

  Write-Ok "Archivo .env configurado con los datos mínimos."
}

# --------------------------------------------------------------------------
# 4. Verificar sintaxis del servidor (smoke test rápido, no arranca el puerto)
# --------------------------------------------------------------------------
Write-Paso "Verificando la instalación..."
& node -c (Join-Path $projectRoot "server.js")
if ($LASTEXITCODE -ne 0) {
  Write-ErrorFatal "server.js no pasó la verificación de sintaxis. La instalación de dependencias pudo haber fallado parcialmente."
  exit 1
}
Write-Ok "server.js verificado correctamente."

# --------------------------------------------------------------------------
# 5. PM2 opcional (mantener el servidor activo en segundo plano)
# --------------------------------------------------------------------------
Write-Paso "¿Instalar PM2 para mantener a Lucy corriendo en segundo plano y reiniciar sola ante fallos?"
$usarPm2 = Read-Host "(recomendado en un servidor de producción) (s/n)"
if ($usarPm2 -eq "s") {
  $pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
  if (-not $pm2Cmd) {
    Write-Host "    Instalando PM2 globalmente (npm install -g pm2)..."
    & npm install -g pm2
  }
  Write-Ok "Para arrancar Lucy con PM2, ejecuta: pm2 start server.js --name lucy"
  Write-Ok "Para que arranque solo al reiniciar Windows: pm2 save, luego pm2-startup install (paquete pm2-windows-startup de npm)."
}

# --------------------------------------------------------------------------
# Resumen final
# --------------------------------------------------------------------------
Write-Host ""
Write-Host "==================================================================" -ForegroundColor DarkCyan
Write-Host "  Instalación completa" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "  Para arrancar el servidor manualmente:" -ForegroundColor White
Write-Host ("      cd " + $projectRoot) -ForegroundColor Gray
Write-Host "      npm start" -ForegroundColor Gray
Write-Host ""
Write-Host "  Luego abre: http://localhost:3000  (o el puerto que hayas configurado)" -ForegroundColor White
Write-Host "  Panel de administración: http://localhost:3000/admin" -ForegroundColor White
Write-Host "  Portal de corredores:    http://localhost:3000/corredor" -ForegroundColor White
Write-Host ""
Write-Host "  Revisa docs/entrega/MANUAL_INSTALACION.md para el resto de la" -ForegroundColor White
Write-Host "  configuración (WhatsApp, correo OTP, audio, despliegue en producción)." -ForegroundColor White
Write-Host ""
Read-Host "Presiona Enter para salir"
