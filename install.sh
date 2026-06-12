#!/bin/bash
# ReunIA - instalador de un comando para macOS
#   curl -fsSL https://reunia-pied.vercel.app/install.sh | bash
# Descarga el último release desde GitHub, instala en /Aplicaciones y abre la app.
set -euo pipefail

REPO="miguerei/reunia"
APP_NAME="ReunIA"

echo "🎙️  Instalando ${APP_NAME}..."

if [ "$(uname)" != "Darwin" ]; then
  echo "❌ Este instalador es para macOS. En Windows usa (PowerShell):"
  echo "   irm https://reunia-pied.vercel.app/install.ps1 | iex"
  exit 1
fi

ARCH="$(uname -m)"
API_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"

# Pick the right DMG for the CPU (arm64 = Apple Silicon, x64 = Intel)
if [ "$ARCH" = "arm64" ]; then
  DMG_URL="$(echo "$API_JSON" | grep -o 'https://[^"]*-arm64\.dmg' | head -1)"
else
  DMG_URL="$(echo "$API_JSON" | grep -o 'https://[^"]*\.dmg' | grep -v arm64 | head -1)"
fi

if [ -z "$DMG_URL" ]; then
  echo "❌ No se encontró el instalador en el último release. Descarga manual:"
  echo "   https://github.com/${REPO}/releases/latest"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
DMG_PATH="${TMP_DIR}/${APP_NAME}.dmg"

echo "⬇️  Descargando $(basename "$DMG_URL")..."
curl -fL --progress-bar "$DMG_URL" -o "$DMG_PATH"

echo "📦 Montando e instalando en /Applications..."
MOUNT_DIR="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly | grep -o '/Volumes/.*' | head -1)"
if [ -z "$MOUNT_DIR" ]; then
  echo "❌ No se pudo montar el DMG."
  exit 1
fi

# Close a running copy before replacing it
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
rm -rf "/Applications/${APP_NAME}.app"
cp -R "${MOUNT_DIR}/${APP_NAME}.app" /Applications/
hdiutil detach "$MOUNT_DIR" -quiet || true

# Remove the quarantine flag (the build is not yet notarized by Apple)
xattr -cr "/Applications/${APP_NAME}.app" || true

echo "🚀 Abriendo ${APP_NAME}..."
open -a "${APP_NAME}"

echo ""
echo "✅ ${APP_NAME} instalada. Primer uso:"
echo "   1. En Ajustes (se abre sola): pega tu clave de OpenAI o elige Ollama (local)."
echo "   2. Para grabar Meet/Zoom completo instala BlackHole: https://github.com/ExistentialAudio/BlackHole"
echo "   3. Pulsa grabar (o Cmd+Shift+R) y al terminar tendrás el informe con IA."
