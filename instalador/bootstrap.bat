@echo off
setlocal EnableDelayedExpansion
title Instalador de Lucy - C.A. de Seguros La Occidental

echo ==================================================================
echo   Instalador de Lucy - C.A. de Seguros La Occidental
echo ==================================================================
echo.
echo Este instalador va a copiar el proyecto a una carpeta de tu equipo
echo e instalar todo lo necesario para correrlo.
echo.

set "DEFAULT_DEST=%USERPROFILE%\Lucy-CA-Seguros-La-Occidental"
set /p "DEST=Carpeta de destino [%DEFAULT_DEST%]: "
if "%DEST%"=="" set "DEST=%DEFAULT_DEST%"

if exist "%DEST%\package.json" (
  echo.
  echo [AVISO] Ya existe un proyecto en "%DEST%".
  set /p "CONTINUAR=Sobreescribir los archivos del proyecto ahi? El .env existente NO se toca. (s/n): "
  if /i not "!CONTINUAR!"=="s" (
    echo Instalacion cancelada.
    pause
    exit /b 1
  )
)

echo.
echo Extrayendo el proyecto a "%DEST%" ...
if not exist "%DEST%" mkdir "%DEST%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%~dp0lucy-source.zip' -DestinationPath '%DEST%' -Force"
if errorlevel 1 (
  echo [ERROR] No se pudo extraer el proyecto.
  pause
  exit /b 1
)
echo [OK] Proyecto extraido.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\instalador\instalar.ps1" -InstallPath "%DEST%"

exit /b 0
