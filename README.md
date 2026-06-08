# ReunIA

**Grabador de reuniones con inteligencia artificial.** Un clic y graba. La IA genera informes profesionales con resúmenes, insights clave, personas, recomendaciones, consejos y to-do list accionable.

Funciona excelente con **Google Meet**, Zoom, llamadas, reuniones presenciales, etc.

## Características (MVP actual)

- Botón grande + atajo global (Cmd/Ctrl + Shift + R) para empezar/parar grabación al instante.
- Captura de audio del sistema + micrófono (recomendado: BlackHole en macOS).
- Reproducción inmediata del audio grabado.
- Procesamiento con **OpenAI Whisper** (transcripción en español de alta calidad) + GPT para informe estructurado.
- Informe visual bonito con:
  - Resumen ejecutivo
  - Insights clave
  - Personas asistentes
  - Quiénes intervinieron
  - Recomendaciones
  - Consejos
  - To-Do list editable (checkboxes)
- Guardado organizado en subcarpetas por fecha + tema.
- Exportación fácil (Markdown + JSON + audio + ZIP).
- Bandeja del sistema + persistencia de configuración.

## Requisitos

- macOS (probado en Apple Silicon) o Windows.
- Node.js 20+ (ya instalado en tu máquina).
- Una clave de API de OpenAI (Whisper + GPT). Barato: ~0.5-2 centavos de dólar por reunión de 30 min.

**Para mejor experiencia capturando audio de Google Meet (recomendadísimo):**

1. Instala **BlackHole** (gratuito): https://github.com/ExistentialAudio/BlackHole
2. Abre "Utilidad de configuración de Audio MIDI".
3. Crea un "Dispositivo multi-salida" (altavoces + BlackHole) y/o un "Dispositivo agregado" (micrófono + BlackHole).
4. En ReunIA selecciona el dispositivo BlackHole o el agregado antes de grabar.

## Desarrollo rápido (UI + grabación + IA)

```bash
cd reunia
npm install

# 1. Arranca el frontend (Vite)
npm run dev

# 2. En otra terminal, lanza la shell de Electron (usa el main compilado)
npx electron dist-electron/main.js
```

O usa el script combinado (requiere concurrently instalado):

```bash
npm run dev:electron
```

Durante el desarrollo la grabación funciona (usa MediaRecorder del navegador). El audio se mantiene en memoria para reproducción e IA inmediata.

## Generar instalador

```bash
# macOS (Apple Silicon + Intel)
npm run dist:mac

# Windows
npm run dist:win
```

Los instaladores aparecerán en `release/`.

## Estructura de una sesión guardada

```
~/Documents/ReunIA/
  2025-06-08_14-30_Reunion-Equipo-Producto/
    audio.webm
    metadata.json
    transcript.txt
    report.json
    informe.md
```

## Soporte local (Ollama) - ¡Ya disponible!

En Ajustes puedes cambiar el "Proveedor de IA":

- **OpenAI** (por defecto): Mejor calidad. Usa tu clave.
- **Ollama (Local)**: 100% privado. Requiere tener Ollama instalado y corriendo.

**Cómo usar Ollama:**

1. Instala Ollama: https://ollama.com
2. Descarga un modelo bueno para español: `ollama pull llama3.2` o `ollama pull gemma2:9b`
3. En ReunIA → Ajustes → elige "Ollama (Local)" y pon la URL (normalmente `http://localhost:11434`) y el nombre del modelo.

**Transcripción local (Whisper sin enviar audio a OpenAI):**

Elige "Local (compatible OpenAI)" en la sección de Transcripción e indica un endpoint.

Ejemplos de servidores locales fáciles:
- `whisper-asr-webservice` (Docker fácil)
- faster-whisper con servidor OpenAI-compatible
- Cualquier servidor que exponga `/v1/audio/transcriptions`

Esto te permite un flujo **completamente local** (transcripción + informe).

## Próximos pasos / ideas

- Soporte nativo de ffmpeg para grabación de sistema más robusta (multi-track).
- Diarización de hablantes (quién dijo qué).
- Exportar a DOCX / PDF bonito (usando las skills que ya tienes).
- Integración con Google Drive / Notion / tu flujo actual de CONSULTORIA y CRACKS ACADEMY.
- Búsqueda semántica sobre todas las transcripciones.

## Notas técnicas

- Electron + React + TypeScript + Tailwind.
- Grabación vía Web MediaRecorder (fácil y multiplataforma).
- Soporte dual: OpenAI o Ollama (fetch directo a `/api/chat` con `format: json`).
- Transcripción puede usar OpenAI Whisper o cualquier servidor compatible con la API de OpenAI (recomendado para modo local).
- Almacenamiento local primero.

---

Creado para Miguel. Si quieres que siga puliendo (mejor guardado en disco, waveform real con wavesurfer funcionando siempre, atajos, empaquetado firmado, etc.) solo dime el siguiente paso.
