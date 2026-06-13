#!/bin/bash
# ReunIA - instalador de un comando para macOS
#   curl -fsSL https://raw.githubusercontent.com/miguerei/reunia/main/install.sh | bash
# Descarga el último release desde GitHub, instala en /Aplicaciones y abre la app.
set -euo pipefail

REPO="miguerei/reunia"
APP_NAME="ReunIA"

# Banner / logo en la terminal
printf '\033[35m'
cat <<'BANNER'
   ____            ___    _
  |  _ \ ___ _   _|_ _|  / \
  | |_) / _ \ | | || |  / _ \
  |  _ <  __/ |_| || | / ___ \
  |_| \_\___|\__,_|___/_/   \_\
BANNER
printf '\033[0m'
echo "  Grabador de reuniones con IA · by Miguel Reina"
echo ""

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

# Audio del sistema (opcional): ofrecer instalar BlackHole automáticamente con Homebrew.
# Tu MICRÓFONO funciona sin esto; BlackHole solo hace falta para capturar también
# la voz de los DEMÁS en una videollamada (Meet/Zoom).
if ! system_profiler SPAudioDataType 2>/dev/null | grep -qi "BlackHole"; then
  if command -v brew >/dev/null 2>&1; then
    printf "\n¿Instalar BlackHole para capturar el audio de las videollamadas (voz de los demás)? [s/N] "
    read -r REPLY </dev/tty 2>/dev/null || REPLY="n"
    if [ "$REPLY" = "s" ] || [ "$REPLY" = "S" ]; then
      echo "📦 Instalando BlackHole vía Homebrew..."
      brew install blackhole-2ch || echo "⚠️  No se pudo instalar automáticamente; descárgalo de https://existential.audio/blackhole/"
    fi
  fi
fi

echo "🚀 Abriendo ${APP_NAME}..."
open -a "${APP_NAME}"

echo ""
echo "✅ ${APP_NAME} instalada. Primer uso:"
echo "   1. En Ajustes (se abre sola): elige Gemini (GRATIS, clave en 30s) u Ollama (local), o pega tu clave de OpenAI."
echo "   2. Tu micrófono ya graba. Para capturar también a los demás en videollamadas, usa BlackHole como 'audio del sistema'."
echo "   3. Pulsa grabar (o Cmd+Shift+R). Durante la reunión, prueba el botón 'Resumen últimos minutos' (Coach IA)."
