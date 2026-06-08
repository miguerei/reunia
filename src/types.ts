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

  // Local AI support (Ollama etc.)
  aiProvider: 'openai' | 'ollama'
  ollamaBaseUrl: string
  ollamaModel: string

  // Transcription can be OpenAI or any OpenAI-compatible local server (e.g. faster-whisper, whisper-asr-webservice)
  transcriptionMode: 'openai' | 'local'
  transcriptionEndpoint: string   // e.g. http://localhost:8000/v1  (must be OpenAI compatible)

  // Voice input (Web Speech API) toggle for live ask during recordings. Default on for hands-busy meeting UX.
  enableVoiceInput?: boolean
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
}

/**
 * Clean state for recording UX modes (compact/focus/stealth for low-distraction meetings).
 * - normal: full sidebar + prominent live assistant panel + history
 * - compact (aka focus): collapsed sidebar to thin icon rail, live panel as small always-visible docked pill/bar (timer + focus chips + last summary + quick mic/ask/input + copy/star + PiP/expand/hide). Low distraction for hands-busy.
 * - stealth: softer non-alarming colors (violet/rose), hide full history + sidebar by default, minimal UI + placeholder, optional full panel hide while tray/global stay active. Ultra low profile.
 * Persisted (user's last choice via cycle/M/pill/rail/PiP/tray/global is the "auto" start mode for next rec). Companion PiP (~340px frameless alwaysOnTop) forwards to primary for full features.
 */
export type RecordingMode = 'normal' | 'compact' | 'stealth'
