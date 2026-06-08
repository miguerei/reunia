import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { format } from 'date-fns'
import type { Session, AppSettings, RecordingState, LiveQA, RecordingMode } from './types'
import { transcribeAudioBlob, askAboutRecentTranscript } from './lib/ai'
import { loadMemoryIndex, indexStarredFromSession, retrieveRelevantAsync, entriesToPromptSnippets, getMemoryCount, clearMemory as clearMemoryFromLib } from './lib/memory'

/**
 * Fast, zero-LLM heuristic to tag a live QA for filtering + self-improvement.
 * Enables "filter by contains action/decision/risk" without extra latency/cost.
 */
function inferLiveQATags(question: string, answer: string): string[] {
  const text = `${question} ${answer}`.toLowerCase()
  const tags: string[] = []
  if (/decid|acord|acuerdo|resolu|aprob|cerramos|decisión/.test(text)) tags.push('decision')
  if (/acci|paso|próxim|hacer|responsable|asign|todo|acción|acciones/.test(text)) tags.push('action')
  if (/riesgo|preocup|problema|peligr|fallo|issue|bloque|obstacul/.test(text)) tags.push('risk')
  if (/presup|coste|dinero|euro|€|budget|precio|costos|gasto/.test(text)) tags.push('budget')
  if (/dijo|persona|nombre|particip|asist|quién|habló/.test(text)) tags.push('person')
  return Array.from(new Set(tags))
}

interface ReunIAStore {
  // Library
  sessions: Session[]
  selectedSessionId: string | null
  isLoadingLibrary: boolean

  // Recording
  recording: RecordingState

  // Settings
  settings: AppSettings
  isSettingsOpen: boolean

  // UI
  activeView: 'library' | 'detail' | 'settings'
  isProcessing: boolean
  processingSessionId: string | null

  // Compact / focus / stealth recording mode (persisted preference for premium low-distraction during meetings)
  recordingMode: RecordingMode
  setRecordingMode: (mode: RecordingMode) => void

  // Live assistant UI chrome state (drives pill vs full panel vs hidden; not persisted across launches — resets to sensible per mode on record start)
  livePanelExpanded: boolean
  assistantHidden: boolean
  setLivePanelExpanded: (expanded: boolean) => void
  setAssistantHidden: (hidden: boolean) => void

  // Actions - Library
  loadSessions: () => Promise<void>
  addOrUpdateSession: (session: Session) => void
  selectSession: (id: string | null) => void
  deleteSession: (id: string) => Promise<void>
  updateSession: (id: string, updates: Partial<Session>) => void

  // Recording
  setRecordingState: (partial: Partial<RecordingState>) => void
  startRecording: (deviceId: string | null) => Promise<boolean>
  stopRecording: () => Promise<Session | null>
  updateElapsed: () => void

  // Live assistant during recording (what was said in the last minutes)
  askLiveQuestion: (question: string) => Promise<void>

  // Settings
  setSettings: (s: Partial<AppSettings>) => void
  setSettingsOpen: (open: boolean) => void
  loadSettings: () => Promise<void>
  saveSettings: (s: Partial<AppSettings>) => Promise<void>

  // AI / Processing
  setProcessing: (processing: boolean, sessionId?: string | null) => void

  // Helpers
  getSelectedSession: () => Session | null

  // Self-improvement memory (lightweight, local)
  memoryCount: number
  loadMemory: () => Promise<void>
  getMemoryCount: () => number
  clearMemory: () => Promise<void>
}

const defaultSettings: AppSettings = {
  storagePath: '',
  openaiApiKey: '',
  language: 'es',
  hotkey: 'CommandOrControl+Shift+R',
  autoProcess: true,
  preferredModel: 'gpt-4o-mini',

  // Local / Ollama defaults
  aiProvider: 'openai',
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',

  transcriptionMode: 'openai',
  transcriptionEndpoint: 'http://localhost:8000/v1',

  // Voice input toggle (Web Speech). Default true for brilliant hands-busy meetings.
  enableVoiceInput: true,
}

const defaultRecording: RecordingState = {
  isRecording: false,
  startTime: null,
  elapsed: '00:00',
  audioChunks: [],
  recentAudioChunks: [],
  mediaRecorder: null,
  selectedDeviceId: null,
  sessionId: null,
  tempFolder: null,
  liveTranscript: '',
  liveQA: [],
  isAskingLive: false,
  isTranscribingRecent: false,
  isThinkingLLM: false,
  lastTranscribedChunkCount: 0,
  contextFocus: null,
}

export const useStore = create<ReunIAStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      selectedSessionId: null,
      isLoadingLibrary: false,

      recording: defaultRecording,

      settings: defaultSettings,
      isSettingsOpen: false,

      activeView: 'library',
      isProcessing: false,
      processingSessionId: null,

      // Compact / focus / stealth mode (user preference; last chosen via cycle (Cmd/Ctrl+M / Shift+M / pill / rail / PiP / tray) becomes the auto-start mode for next recording.
      // Supports toggle + auto low-distraction start. 'normal' default; users typically cycle to 'compact' (focus) once for real meetings (Google Meet/Zoom, screen share, hands-busy).
      recordingMode: 'normal' as RecordingMode,
      // UI chrome for live (sane defaults; overridden intelligently on startRecording based on mode)
      livePanelExpanded: true,
      assistantHidden: false,

      // Self-improvement memory (populated from local index)
      memoryCount: 0,

      // Library
      loadSessions: async () => {
        set({ isLoadingLibrary: true })
        try {
          // Prefer disk scan via IPC for full round-trip: liveQAs (with starred, tags, focusUsed)
          // written in metadata.json by save-full now come back reliably after restarts.
          const api = (window as any).electron
          let fromDisk: Session[] = []
          if (api?.listSessions) {
            fromDisk = (await api.listSessions()) || []
          }
          const current = get().sessions || []
          let next = fromDisk.length > 0 ? fromDisk : current

          // Merge any in-memory-only sessions (no folderPath yet, just-stopped) so we don't lose
          // recent liveQAs before user hits "Guardar en carpeta" or process.
          if (fromDisk.length > 0) {
            const diskIds = new Set(fromDisk.map((s) => s.id))
            const pending = current.filter((s) => !diskIds.has(s.id) && !s.folderPath)
            if (pending.length) next = [...pending, ...next]
          }

          set({ sessions: next, isLoadingLibrary: false })

          // Also ensure memory index is warm (for live injections)
          get().loadMemory()

          // Proactively index any starred from loaded disk sessions (idempotent via memory layer).
          // This ensures pre-Phase2 starred items + any direct metadata edits get into the memory index.
          // Strengthened: also ready for future indexReportInsights(s) from metadata + report.json (see main sessions:list comment). (optional reindexAllMemory could be exposed here later for "deepen memory" phase)
          setTimeout(() => {
            const sSettings = get().settings
            next.forEach((s) => {
              if (s.liveQAs && s.liveQAs.some((qa) => qa.starred)) {
                indexStarredFromSession(s, sSettings).then((added) => {
                  if (added > 0) set({ memoryCount: getMemoryCount() })
                }).catch(() => {})
              }
            })
          }, 50)
        } catch (e) {
          console.error('Error loading sessions', e)
          // Fallback to persisted zustand
          const persisted = get().sessions || []
          set({ sessions: persisted, isLoadingLibrary: false })
        }
      },

      addOrUpdateSession: (session) => {
        const existing = get().sessions
        const idx = existing.findIndex((s) => s.id === session.id)
        let next: Session[]
        if (idx >= 0) {
          next = [...existing]
          next[idx] = { ...next[idx], ...session }
        } else {
          next = [session, ...existing]
        }
        set({ sessions: next })

        // === AUTO-INDEX FOR SELF-IMPROVEMENT ===
        // Non-blocking: starred liveQAs (and their focus/tags) become available for future
        // live Q&A and report injections immediately (even before disk save).
        // Happens in background after stopRecording -> add.
        if (session.liveQAs && session.liveQAs.some((qa) => qa.starred)) {
          // fire-and-forget
          indexStarredFromSession(session, get().settings).then((added) => {
            if (added > 0) {
              const newCount = getMemoryCount()
              set({ memoryCount: newCount })
              console.log(`[memory] indexed ${added} new starred excerpt(s) from ${session.id}`)
            }
          }).catch(() => {})
        }
      },

      selectSession: (id) => {
        set({ selectedSessionId: id, activeView: id ? 'detail' : 'library' })
      },

      deleteSession: async (id) => {
        // Note: actual file deletion can be added later with IPC
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== id),
          selectedSessionId: state.selectedSessionId === id ? null : state.selectedSessionId,
        }))
      },

      updateSession: (id, updates) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        }))
        // If liveQAs stars were updated (e.g. from detail view), (re)index so future injections see the change immediately
        if (updates.liveQAs && Array.isArray(updates.liveQAs) && updates.liveQAs.some((qa: any) => qa.starred)) {
          const patched = get().sessions.find((s) => s.id === id)
          if (patched) {
            indexStarredFromSession(patched, get().settings).then((added) => {
              if (added > 0) set({ memoryCount: getMemoryCount() })
            }).catch(() => {})
          }
        }
      },

      // Recording
      setRecordingState: (partial) =>
        set((state) => ({ recording: { ...state.recording, ...partial } })),

      startRecording: async (deviceId) => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: deviceId ? { deviceId: { exact: deviceId } } : true,
          })

          const mediaRecorder = new MediaRecorder(stream, {
            mimeType: 'audio/webm;codecs=opus',
          })

          const fullChunks: Blob[] = []
          const recentChunks: Blob[] = []

          // Rolling buffer: keep roughly last 5 minutes (300 chunks @ 1s interval)
          const MAX_RECENT_CHUNKS = 300

          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              fullChunks.push(e.data)
              recentChunks.push(e.data)

              // Trim recent buffer to last ~5 minutes
              if (recentChunks.length > MAX_RECENT_CHUNKS) {
                recentChunks.splice(0, recentChunks.length - MAX_RECENT_CHUNKS)
              }
            }
          }

          const sessionId = 'rec_' + Date.now().toString(36)
          const startTime = Date.now()

          mediaRecorder.start(1000)

          // Notify main
          ;(window as any).electron?.updateTrayRecording?.(true, '00:00')

          // Use the persisted recordingMode exactly as the user's chosen preference (set via Cmd/Ctrl+M / Shift+M cycle, pill/rail/PiP/banner switcher, or tray).
          // This makes "auto compact(focus)/stealth on record start" fully user-controlled: cycle to your preferred low-distraction mode even before hitting record (or via global while in Meet),
          // and it will be used on start with correct sidebar collapse / pill / hidden state. (No forced override from 'normal' — last chosen sticks and is the "auto". Brilliant for meeting prefs.)
          const mode = get().recordingMode
          const startExpanded = mode === 'normal'
          const startHidden = mode === 'stealth'
          set({
            recording: {
              ...defaultRecording,
              isRecording: true,
              startTime,
              elapsed: '00:00',
              audioChunks: fullChunks,
              recentAudioChunks: recentChunks,
              mediaRecorder,
              selectedDeviceId: deviceId,
              sessionId,
              liveTranscript: '',
              liveQA: [],
              contextFocus: null,
            },
            activeView: 'library',
            recordingMode: mode,
            livePanelExpanded: startExpanded,
            assistantHidden: startHidden,
          })

          // Elapsed timer
          const interval = setInterval(() => {
            const st = get().recording.startTime
            if (!st || !get().recording.isRecording) {
              clearInterval(interval)
              return
            }
            const secs = Math.floor((Date.now() - st) / 1000)
            const mm = String(Math.floor(secs / 60)).padStart(2, '0')
            const ss = String(secs % 60).padStart(2, '0')
            const elapsed = `${mm}:${ss}`
            get().setRecordingState({ elapsed })
            ;(window as any).electron?.updateTrayRecording?.(true, elapsed)
          }, 1000)

          ;(mediaRecorder as any)._elapsedInterval = interval

          return true
        } catch (err: any) {
          console.error('Error starting recording', err)
          alert('No se pudo acceder al micrófono / dispositivo de audio.\n\n' + (err?.message || ''))
          return false
        }
      },

      stopRecording: async () => {
        const rec = get().recording
        if (!rec.mediaRecorder || !rec.isRecording) return null

        return new Promise<Session | null>((resolve) => {
          const mr = rec.mediaRecorder!
          const chunks = rec.audioChunks

          mr.onstop = async () => {
            // Stop tracks
            mr.stream.getTracks().forEach((t) => t.stop())

            // Clear timer
            if ((mr as any)._elapsedInterval) clearInterval((mr as any)._elapsedInterval)

            const blob = new Blob(chunks, { type: 'audio/webm' })
            const durationSec = rec.startTime
              ? Math.floor((Date.now() - rec.startTime) / 1000)
              : 0

            const now = new Date()
            const dateStr = format(now, "yyyy-MM-dd'T'HH-mm")
            const id = rec.sessionId || 'rec_' + now.getTime().toString(36)
            const title = `Reunión ${format(now, 'dd/MM/yyyy HH:mm')}`

            // Expose last blob globally so the final full report + player still work exactly as before
            // @ts-ignore
            ;(window as any).__lastRecordingBlob = blob
            // @ts-ignore
            ;(window as any).__lastRecordingSessionId = id

            const currentLiveQAs = get().recording.liveQA || []

            const session: Session = {
              id,
              folderPath: '',
              title,
              date: now.toISOString(),
              durationSec,
              audioFileName: `${dateStr}.webm`,
              audioPath: '',
              hasTranscript: false,
              hasReport: false,
              liveQAs: currentLiveQAs.length > 0 ? currentLiveQAs : undefined,
            }

            ;(window as any).electron?.updateTrayRecording?.(false)

            // Fully reset recording state + live UI chrome for next time. liveQAs ... preserved in session.
            set({ recording: defaultRecording, livePanelExpanded: true, assistantHidden: false })

            resolve(session)
          }

          mr.stop()
        })
      },

      updateElapsed: () => {
        // handled inside startRecording timer for simplicity
      },

      // Settings
      setSettings: (s) => set((state) => ({ settings: { ...state.settings, ...s } })),

      setSettingsOpen: (open) => set({ isSettingsOpen: open }),

      loadSettings: async () => {
        try {
          const api = (window as any).electron
          if (api?.getSettings) {
            const s = await api.getSettings()
            if (s) set({ settings: { ...defaultSettings, ...s } })
          }
        } catch (e) {
          console.warn('Could not load settings from main', e)
        }
      },

      saveSettings: async (s) => {
        const next = { ...get().settings, ...s }
        set({ settings: next })
        try {
          const api = (window as any).electron
          if (api?.setSettings) await api.setSettings(next)
        } catch (e) {
          console.warn('Failed to persist settings in main', e)
        }
      },

      setProcessing: (processing, sessionId = null) =>
        set({ isProcessing: processing, processingSessionId: sessionId }),

      // Recording mode (compact/stealth for meetings)
      setRecordingMode: (mode) => set({ recordingMode: mode }),

      setLivePanelExpanded: (expanded) => set({ livePanelExpanded: expanded }),
      setAssistantHidden: (hidden) => set({ assistantHidden: hidden }),

      getSelectedSession: () => {
        const id = get().selectedSessionId
        return get().sessions.find((s) => s.id === id) || null
      },

      // ===================== SELF-IMPROVEMENT MEMORY (Phase 2) =====================
      loadMemory: async () => {
        try {
          await loadMemoryIndex()
          const count = getMemoryCount()
          set({ memoryCount: count })
        } catch (e) {
          console.warn('loadMemory failed', e)
        }
      },
      getMemoryCount: () => get().memoryCount,

      clearMemory: async () => {
        try {
          await clearMemoryFromLib()
          set({ memoryCount: 0 })
          console.log('[memory] cleared all local memory entries')
        } catch (e) {
          console.warn('clearMemory failed', e)
          // still reflect in-memory clear
          set({ memoryCount: 0 })
        }
      },

      // ===================== LIVE Q&A WHILE RECORDING (polished, incremental, phased) =====================
      askLiveQuestion: async (question: string) => {
        const rec = get().recording
        if (!rec.isRecording) return

        const settings = get().settings
        const recentChunks = rec.recentAudioChunks || []
        let recentTranscript = rec.liveTranscript || ''
        const previousChunkCount = rec.lastTranscribedChunkCount || 0
        const activeFocus = rec.contextFocus || null   // captured at ask time for QA + prompt

        // Phase 1: Transcribing (only new chunks for efficiency & low latency)
        set((state) => ({
          recording: {
            ...state.recording,
            isTranscribingRecent: true,
            isThinkingLLM: false,
          },
        }))

        try {
          // Incremental: only transcribe chunks added since last time
          const newChunks = recentChunks.slice(previousChunkCount)
          let newlyTranscribed = ''

          if (newChunks.length > 0) {
            const newAudioBlob = new Blob(newChunks, { type: 'audio/webm' })
            newlyTranscribed = await transcribeAudioBlob(settings, newAudioBlob)
          }

          if (newlyTranscribed && newlyTranscribed.length > 2) {
            const combined = (recentTranscript + ' ' + newlyTranscribed).trim()
            recentTranscript = combined.length > 22000 ? combined.slice(-19000) : combined
          }

          const newChunkCount = recentChunks.length

          // Phase 2: Thinking (LLM)
          set((state) => ({
            recording: {
              ...state.recording,
              isTranscribingRecent: false,
              isThinkingLLM: true,
              liveTranscript: recentTranscript,
              lastTranscribedChunkCount: newChunkCount,
            },
          }))

          // === LEARNED CONTEXT INJECTION (core of self-improvement) ===
          // Retrieve 1-3 high-value past starred excerpts (boosted by star + recency + keyword/focus match).
          // When Ollama available we also get semantic cosine boost for better matches (hybrid RAG).
          // Injected into askAboutRecentTranscript as few-shot style examples.
          let learnedSnippets: string[] = []
          let usedMemoryForThis = false
          try {
            // Ensure memory warm (fast after first load)
            if (get().memoryCount === 0) {
              await get().loadMemory()
            }
            const relevant = await retrieveRelevantAsync(question, activeFocus, 3, settings)
            if (relevant.length > 0) {
              learnedSnippets = entriesToPromptSnippets(relevant)
              usedMemoryForThis = true
            }
          } catch (memErr) {
            console.warn('memory retrieve skipped', memErr)
          }

          // Ask LLM with context + learned style if available (self-improvement hook ready)
          // Pass focus so the prompt can prioritize/filter the rolling buffer semantically for this question.
          const answer = await askAboutRecentTranscript(settings, recentTranscript, question, activeFocus, learnedSnippets.length ? learnedSnippets : undefined)

          const tags = inferLiveQATags(question, answer)
          const newQA: LiveQA = {
            id: 'qa_' + Date.now().toString(36),
            question: question.trim(),
            answer: answer.trim(),
            timestamp: new Date().toISOString(),
            tags: tags.length ? tags : undefined,
            starred: false,
            focusUsed: activeFocus || undefined,
            memoryUsed: usedMemoryForThis || undefined,
          }

          set((state) => {
            const current = state.recording
            return {
              recording: {
                ...current,
                liveTranscript: recentTranscript,
                liveQA: [...current.liveQA, newQA],
                isTranscribingRecent: false,
                isThinkingLLM: false,
                lastTranscribedChunkCount: newChunkCount,
              },
            }
          })
        } catch (err: any) {
          console.error('Live question error', err)
          const errorAnswer = 'Error consultando a la IA: ' + (err?.message || 'intenta de nuevo en unos segundos')

          set((state) => {
            const current = state.recording
            return {
              recording: {
                ...current,
                liveQA: [
                  ...current.liveQA,
                  {
                    id: 'qa_err_' + Date.now(),
                    question,
                    answer: errorAnswer,
                    timestamp: new Date().toISOString(),
                    starred: false,
                    focusUsed: activeFocus || undefined,
                    memoryUsed: false,  // memoryUsed not applicable on error path
                  },
                ],
                isTranscribingRecent: false,
                isThinkingLLM: false,
              },
            }
          })
        }
      },
    }),
    {
      name: 'reunia-store',
      partialize: (state) => ({
        sessions: state.sessions,
        settings: state.settings,
        recordingMode: state.recordingMode,
        // livePanelExpanded / assistantHidden are transient UI and intentionally NOT persisted (fresh per launch / per recording)
      }),
    }
  )
)
