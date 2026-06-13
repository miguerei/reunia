export interface Session {
  id: string
  folderPath: string
  title: string
  date: string // ISO string
  durationSec: number
  audioFileName: string // relative to folderPath
  audioPath: string // full for convenience in renderer (when possible)
  transcriptFileName?: string
  reportFileName?: string
  hasTranscript: boolean
  hasReport: boolean
  topic?: string
  language?: string
  liveQAs?: LiveQA[]   // captured during recording for self-improvement and post-meeting review
}

export interface Report {
  title?: string   // título corto descriptivo generado por la IA
  summary: string
  keyInsights: string[]
  attendees: string[]
  speakers: string[] // quienes intervinieron
  recommendations: string[]
  advice: string[]
  todoList: Array<{ id: string; task: string; done: boolean }>
  raw?: string // optional full LLM output
}

export interface SessionWithReport extends Session {
  report?: Report
  transcript?: string
}

export interface AppSettings {
  storagePath: string
  openaiApiKey: string
  language: string
  hotkey: string
  autoProcess: boolean
  preferredModel: string

  // AI provider: OpenAI (de pago), Gemini (gratis con clave gratuita) u Ollama (100% local).
  aiProvider: 'openai' | 'ollama' | 'gemini'
  ollamaBaseUrl: string
  ollamaModel: string

  // Google Gemini (free tier, no requiere tarjeta). Clave desde Google AI Studio.
  geminiApiKey?: string
  geminiModel?: string   // ej. 'gemini-2.0-flash'

  // Modo de Gemini:
  //  - 'team': usa el proxy compartido del equipo (no requiere clave; la clave vive en Vercel).
  //  - 'own':  usa la clave personal (geminiApiKey).
  geminiMode?: 'team' | 'own'
  geminiProxyUrl?: string   // URL del proxy del equipo (no es secreta). Default al desplegado.

  // Transcription can be OpenAI or any OpenAI-compatible local server (e.g. faster-whisper, whisper-asr-webservice)
  transcriptionMode: 'openai' | 'local'
  transcriptionEndpoint: string   // e.g. http://localhost:8000/v1  (must be OpenAI compatible)

  // Voice input (Web Speech API) toggle for live ask during recordings. Default on for hands-busy meeting UX.
  enableVoiceInput?: boolean

  // Second audio input (BlackHole / VB-Cable / loopback) mixed with the mic so video-call
  // audio from the other participants is captured in the same recording.
  systemAudioDeviceId?: string
}

/**
 * Live Coach: on-demand analysis of the last minutes of conversation while recording.
 * Everything is derived from the rolling transcript via the configured AI provider.
 */
export interface LiveCoachResult {
  summary: string            // resumen de los últimos minutos
  tone: string               // tono detectado de la conversación (ej. "tenso", "colaborativo")
  suggestions: string[]      // qué se podría mejorar en la conversación ahora mismo
  psychProfile: string       // perfil psicológico/comunicativo estimado del interlocutor principal
  detectedNames: string[]    // nombres de personas detectados en la conversación
  timestamp: string          // ISO
}

export interface LiveQA {
  id: string
  question: string
  answer: string
  timestamp: string
  // Self-improvement + filter seeds
  tags?: string[]          // e.g. 'decision' | 'action' | 'risk' | 'budget' | 'person'
  starred?: boolean        // user marked for memory / future RAG
  focusUsed?: string       // context focus active when this QA was asked (for replay & analysis)
  memoryUsed?: boolean     // set when learned context from past starred liveQAs was injected into the prompt for this answer
}

export interface MemoryEntry {
  id: string                 // unique `${sessionId}:${qaId}` or `${sessionId}:insight:N`
  text: string               // high-signal excerpt: "Q: ... | A: ..." or insight/recommendation text
  sessionId: string
  date: string
  tags?: string[]
  starred?: boolean
  focusUsed?: string
  embedding?: number[]       // optional Ollama embedding for semantic retrieval (local only)
}

export interface RecordingState {
  isRecording: boolean
  startTime: number | null
  elapsed: string
  audioChunks: Blob[]           // full recording for final report
  recentAudioChunks: Blob[]     // rolling buffer for live questions (last ~few minutes)
  mediaRecorder: MediaRecorder | null
  selectedDeviceId: string | null
  sessionId: string | null
  tempFolder: string | null

  // Live assistant during recording
  liveTranscript: string
  liveQA: LiveQA[]
  isAskingLive: boolean

  // Granular loading for brilliant UX (phased feedback)
  isTranscribingRecent: boolean
  isThinkingLLM: boolean

  // Track progress for incremental transcription (self-improving efficiency)
  lastTranscribedChunkCount: number

  // Smart context focus filter: influences what the live LLM "sees" / prioritizes for next questions
  contextFocus: string | null   // e.g. 'decisions' | 'actions' | 'risks' | 'budget' | 'people' | custom

  // Live Coach (resumen/tono/sugerencias/perfil/nombres de los últimos minutos)
  liveCoach: LiveCoachResult | null
  isCoachRunning: boolean
}

/**
 * Clean state for recording UX modes (compact/focus/stealth for low-distraction meetings).
 * - normal: full sidebar + prominent live assistant panel + history
 * - compact (aka focus): collapsed sidebar to thin icon rail, live panel as small always-visible docked pill/bar (timer + focus chips + last summary + quick mic/ask/input + copy/star + PiP/expand/hide). Low distraction for hands-busy.
 * - stealth: softer non-alarming colors (violet/rose), hide full history + sidebar by default, minimal UI + placeholder, optional full panel hide while tray/global stay active. Ultra low profile.
 * Persisted (user's last choice via cycle/M/pill/rail/PiP/tray/global is the "auto" start mode for next rec). Companion PiP (~340px frameless alwaysOnTop) forwards to primary for full features.
 */
export type RecordingMode = 'normal' | 'compact' | 'stealth'
