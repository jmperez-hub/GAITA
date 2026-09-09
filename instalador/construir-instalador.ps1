<#
.SINOPSIS
  Construye Instalador-Lucy.exe a partir del código fuente del proyecto.

.DESCRIPCION
  Empaqueta una copia limpia del proyecto (sin node_modules, .git, uploads/, ni
  archivos locales como .env o conversations.json) junto con instalar.ps1 en un
  único ejecutable auto-extraíble para Windows, usando IExpress (herramienta
  incluida en Windows, sin dependencias externas).

  El .exe resultante NO se versiona en git (ver .gitignore) — se reconstruye con
  este script cada vez que haga falta, a partir del código fuente versionado, y se
  distribuye por fuera del repositorio (por ejemplo, en el .zip de entrega).

.USO
  Ejecutar desde PowerShell, desde cualquier carpeta:
    powershell -ExecutionPolicy Bypass -File instalador\construir-instalador.ps1

  Genera instalador\Instalador-Lucy.exe.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $scriptDir
# IMPORTANTE: la carpeta de construcción va FUERA del árbol del proyecto (en el
# directorio temporal del sistema) — nunca dentro de $projectRoot. Si quedara
# anidada dentro (p. ej. instalador\_build), robocopy /E la encontraría al copiar
# el proyecto y terminaría copiándola recursivamente dentro de sí misma sin fin.
$buildDir = Join-Path $env:TEMP ("lucy-installer-build-" + [Guid]::NewGuid().ToString("N"))

Write-Host "==> Preparando carpeta de construcción temporal en $buildDir ..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null

$cleanCopy = Join-Path $buildDir "lucy-source"
New-Item -ItemType Directory -Path $cleanCopy -Force | Out-Null

Write-Host "==> Copiando el proyecto (sin node_modules, .git, uploads/, archivos locales)..." -ForegroundColor Cyan
robocopy $projectRoot $cleanCopy /E /XD node_modules .git .claude uploads /XF conversations.json .env "*.log" | Out-Null
# robocopy devuelve códigos 0-7 para éxito — no tratarlo como fallo de PowerShell.
if ($LASTEXITCODE -ge 8) {
  throw "robocopy falló copiando el proyecto (código $LASTEXITCODE)."
}
# La carpeta instalador/ solo debe llevar instalar.ps1 dentro del paquete — no este
# mismo script de construcción, ni un .exe viejo si ya existiera.
Get-ChildItem (Join-Path $cleanCopy "instalador") -File |
  Where-Object { $_.Name -ne "instalar.ps1" } |
  Remove-Item -Force
New-Item -ItemType Directory -Path (Join-Path $cleanCopy "uploads") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $cleanCopy "uploads\.gitkeep") -Force | Out-Null
Write-Host "    Copia lista." -ForegroundColor Green

Write-Host "==> Comprimiendo en lucy-source.zip..." -ForegroundColor Cyan
$zipPath = Join-Path $buildDir "lucy-source.zip"
Compress-Archive -Path (Join-Path $cleanCopy "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
Write-Host "    $([Math]::Round((Get-Item $zipPath).Length / 1MB, 2)) MB" -ForegroundColor Green

Write-Host "==> Copiando el bootstrap..." -ForegroundColor Cyan
Copy-Item (Join-Path $scriptDir "bootstrap.bat") (Join-Path $buildDir "bootstrap.bat") -Force

Write-Host "==> Generando el .SED para IExpress..." -ForegroundColor Cyan
$sedContent = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles

[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$buildDir\Instalador-Lucy.exe
FriendlyName=Instalador de Lucy - C.A. de Seguros La Occidental
AppLaunched=cmd /c bootstrap.bat
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="bootstrap.bat"
FILE1="lucy-source.zip"

[SourceFiles]
SourceFiles0=$buildDir\

[SourceFiles0]
%FILE0%=
%FILE1%=
"@
$sedPath = Join-Path $buildDir "lucy-installer.sed"
[System.IO.File]::WriteAllText($sedPath, $sedContent, [System.Text.UTF8Encoding]::new($false))

Write-Host "==> Construyendo el ejecutable con IExpress..." -ForegroundColor Cyan
& "$env:WINDIR\System32\iexpress.exe" /N $sedPath

# IExpress no bloquea hasta terminar la construcción real (el proceso /N devuelve
# el control casi de inmediato mientras sigue empaquetando en segundo plano) — hay
# que esperar a que el archivo aparezca, con un margen razonable, en vez de
# comprobarlo apenas retorna la llamada de arriba.
$builtExe = Join-Path $buildDir "Instalador-Lucy.exe"
$timeoutSeconds = 120
$elapsed = 0
while (-not (Test-Path $builtExe) -and $elapsed -lt $timeoutSeconds) {
  Start-Sleep -Seconds 2
  $elapsed += 2
}
if (-not (Test-Path $builtExe)) {
  throw "IExpress no generó el ejecutable esperado en $builtExe tras esperar $timeoutSeconds segundos."
}
# Puede seguir escribiéndose un instante más (el .exe recién visible) — una pausa
# corta adicional evita copiar un archivo a medio escribir.
Start-Sleep -Seconds 2

$finalExe = Join-Path $scriptDir "Instalador-Lucy.exe"
Copy-Item $builtExe $finalExe -Force
Write-Host ""
Write-Host "==> Listo: $finalExe ($([Math]::Round((Get-Item $finalExe).Length / 1MB, 2)) MB)" -ForegroundColor Green

Write-Host "==> Limpiando la carpeta de construcción temporal..." -ForegroundColor Cyan
Remove-Item $buildDir -Recurse -Force
Write-Host "    Listo." -ForegroundColor Green
