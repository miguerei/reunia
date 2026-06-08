import React, { useEffect, useState, useRef, useMemo } from 'react'
import { 
  Mic, MicOff, Square, Play, Pause, Download, FolderOpen, Trash2, RefreshCw, 
  Settings, Clock, Users, CheckSquare, Lightbulb, Target, 
  MessageSquare, FileText, Search, X, Star, Filter, AlertTriangle, DollarSign, CheckCircle, Copy
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'
import { Toaster, toast } from 'sonner'
import WaveSurfer from 'wavesurfer.js'

import { useStore } from './store'
import type { Session, Report, RecordingMode } from './types'
import { generateReport, getFocusLabel } from './lib/ai'
import { saveSessionToDisk, createSessionFolderName } from './lib/storage'
import * as fileSaver from 'file-saver'
import { retrieveRelevantAsync, entriesToPromptSnippets, indexStarredFromSession, indexReportInsights, getCachedMemory } from './lib/memory'

// Simple audio device picker (populated at runtime)
function useAudioDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    setLoading(true)
    try {
      // Must request permission first to get device labels
      await navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop()))
      const all = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = all.filter(d => d.kind === 'audioinput')
      setDevices(audioInputs)
    } catch (e) {
      console.warn('Could not enumerate audio devices', e)
      setDevices([])
    }
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])
  return { devices, refresh, loading }
}

// ===================== REUSABLE VOICE INPUT (Web Speech API hook + button) =====================
// Clean, zero-dep, Spanish-first (es-ES), meeting-optimized: interim live preview in input, auto-final submit (or after ~2.3s silence pause for natural hands-busy flow),
// safety timeout, explicit mic perm prime on tap (re-prompt friendly), graceful errors + toasts, Esc cancel.
// Native audio-level viz (Web Audio analyser) for reactive mic button (volume "breathes" + glow) + glanceable confirmation during real meetings.
// Reusable VoiceMicButton (size variants) + new VoiceWave (level-reactive dancing bars) for full panel / pill / companion / banner.
// Used across normal, compact, stealth, companion PiP. All existing live features (contextFocus, memory RAG from stars, phased loading, dual providers, stars) preserved 100% because submits route through handleAskLive / askLiveQuestion.
// Keyboard: Cmd/Ctrl+Shift+V (renderer local + global via main process + IPC, works even from background / screen share).
// Settings toggle (enableVoiceInput) respected; no-support shows disabled affordance or hides. Global hotkey implemented for true hands-busy "tap key + speak naturally".
// Autonomous polish applied: stronger auto-focus + caret-at-end on voice start (all surfaces), fully reactive waveforms (volume drives heights + color pop).
function useVoiceInput(opts?: {
  onInterim?: (text: string) => void
  onFinal?: (text: string) => void
  onStop?: () => void
  onError?: (err: string) => void
  lang?: string
}) {
  const lang = opts?.lang || 'es-ES'
  const speechSupported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)

  const [isListening, setIsListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [audioLevel, setAudioLevel] = useState(0) // 0-1 reactive volume for brilliant visual feedback (native Web Audio, no deps)

  const recognitionRef = useRef<any>(null)
  const silenceTimerRef = useRef<number | null>(null)
  const pendingInterimRef = useRef<string>('')  // tracks latest heard for silence-finalize (hands-busy auto-submit after pause)

  // Viz refs for audio-reactive level (drives mic scale/glow + glanceable "hearing you" during meetings)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const vizStreamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)

  function clearSilenceTimer() {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }

  // Stop viz stream + analyser + raf (native, optional for visual delight; silent fail keeps static waveform)
  function stopViz() {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (analyserRef.current) { analyserRef.current = null }
    if (audioContextRef.current) {
      try { audioContextRef.current.close() } catch {}
      audioContextRef.current = null
    }
    if (vizStreamRef.current) {
      vizStreamRef.current.getTracks().forEach((t) => t.stop())
      vizStreamRef.current = null
    }
    setAudioLevel(0)
  }

  function stopVoice(silent = false) {
    clearSilenceTimer()
    stopViz()
    const rec = recognitionRef.current
    if (rec) {
      try { rec.onresult = null; rec.onend = null; rec.onerror = null; rec.stop() } catch {}
      recognitionRef.current = null
    }
    setIsListening(false)
    setInterim('')
    pendingInterimRef.current = ''
    if (!silent) opts?.onStop?.()
  }

  async function startVoice() {
    if (!speechSupported || isListening) return

    stopVoice(true)

    // Prime microphone permission on tap (reliable prompt + graceful re-request after denial).
    // Uses a transient stream (stopped immediately) so SpeechRecognition can start without extra user friction.
    // This makes first-use and retry "brillante y fácil" during meetings (one tap on mic).
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
    } catch (permErr: any) {
      console.warn('Mic permission prime failed before voice start', permErr)
      opts?.onError?.('not-allowed')
      return
    }

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const rec = new SpeechRec()
    recognitionRef.current = rec

    rec.lang = lang
    rec.interimResults = true
    rec.continuous = false   // one natural question burst at a time (tap-to-speak UX)
    rec.maxAlternatives = 1

    rec.onresult = (event: any) => {
      clearSilenceTimer()

      let finalTranscript = ''
      let currentInterim = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i]
        if (res.isFinal) {
          finalTranscript += res[0].transcript
        } else {
          currentInterim += res[0].transcript
        }
      }

      if (currentInterim) {
        setInterim(currentInterim)
        pendingInterimRef.current = currentInterim
        opts?.onInterim?.(currentInterim)
      }

      if (finalTranscript && finalTranscript.trim()) {
        const final = finalTranscript.trim()
        setInterim('')
        pendingInterimRef.current = ''
        opts?.onFinal?.(final)
        // stop immediately; caller may auto-submit or leave in input for confirm
        stopVoice(true)
      }

      // Auto-stop after ~2.2s silence (reset on any speech).
      // If we have heard interim but engine didn't emit "final" (natural pause), treat last heard as final
      // and auto-submit via onFinal for true hands-busy "speak naturally then pause" UX.
      silenceTimerRef.current = window.setTimeout(() => {
        if (recognitionRef.current) {
          const toFinalize = pendingInterimRef.current.trim()
          if (toFinalize) {
            opts?.onFinal?.(toFinalize)
            pendingInterimRef.current = ''
            setInterim('')
          }
          stopVoice(true)
        }
      }, 2350) as unknown as number
    }

    rec.onerror = (event: any) => {
      console.warn('SpeechRecognition error', event)
      const err = event?.error || 'unknown'
      opts?.onError?.(err)
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        // caller will toast; user can tap mic again (will re-prime + re-prompt)
      }
      pendingInterimRef.current = ''
      stopVoice(true)
    }

    rec.onend = () => {
      clearSilenceTimer()
      setIsListening(false)
      setInterim('')
      pendingInterimRef.current = ''
      recognitionRef.current = null
      opts?.onStop?.()
    }

    try {
      rec.start()
      setIsListening(true)
      setInterim('')
      pendingInterimRef.current = ''
      // Safety timeout (long utterance or stuck) — do NOT auto-finalize here (user may still be speaking)
      silenceTimerRef.current = window.setTimeout(() => {
        if (recognitionRef.current) stopVoice(true)
      }, 8500) as unknown as number

      // Start reactive audio level viz (high-impact brilliant feedback: mic button + wave respond to your actual voice volume)
      // Uses parallel lightweight getUserMedia + Analyser (native Web Audio). Permission already primed above; fails silently -> static CSS wave.
      startViz()
    } catch (e: any) {
      console.error('Failed to start SpeechRecognition', e)
      stopVoice(true)
    }
  }

  // Lightweight native audio level capture for visual delight (volume-reactive mic pulse + future wave).
  // Runs only while actively listening (short bursts). Keeps UX "brillante" for hands-busy meetings without any deps or perf cost.
  async function startViz() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      vizStreamRef.current = stream
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
      const audioCtx = new AudioCtx()
      audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 32
      analyser.smoothingTimeConstant = 0.65
      source.connect(analyser)
      analyserRef.current = analyser
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i]
        const avg = (sum / data.length) / 255
        // Boost a touch for visible response on normal speech; clamp
        setAudioLevel(Math.min(1, avg * 1.75))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      // Viz is pure polish; static CSS waveform remains perfect fallback. No user impact.
      console.warn('voice viz level (analyser) unavailable, using static wave', e)
      setAudioLevel(0)
    }
  }

  function toggleVoice() {
    if (isListening) {
      stopVoice()
    } else {
      startVoice()
    }
  }

  // Cleanup on unmount of hook user
  useEffect(() => {
    return () => {
      stopVoice(true)
    }
  }, [])

  return {
    speechSupported,
    isListening,
    interim,
    audioLevel, // 0-1 live speaking volume for reactive UI (mic scale, glanceable confirmation it's hearing)
    startVoice,
    stopVoice,
    toggleVoice,
  }
}

// Reusable prominent but non-intrusive mic button. Supports size variants for normal pill, compact bar, small, companion.
// Consistent dark/violet theme, pulsing red ring + icon flip when listening, large tap target (7x7 in compact), a11y labels/titles.
// level prop (from hook) adds delightful volume-reactive scale transform on the button itself (actual speech drives it).
// Disabled prop used for loading phases (prevents overlap) and no-support affordances. Also renders consistent dim mic-off in pill when voice pref disabled.
function VoiceMicButton({
  isListening,
  onClick,
  disabled,
  size = 'normal',
  title,
  'aria-label': ariaLabel,
  className = '',
  level = 0,
  disabledTitle,
}: {
  isListening: boolean
  onClick: () => void
  disabled?: boolean
  size?: 'normal' | 'compact' | 'small'
  title?: string
  'aria-label'?: string
  className?: string
  level?: number // 0-1 from hook for reactive scale/glow (brilliant hands-busy visual confirmation)
  disabledTitle?: string // contextual reason e.g. "esperando respuesta IA" (high-impact for hands-busy users wondering why dimmed)
}) {
  const sizeClasses = size === 'compact'
    ? '!w-7 !h-7'
    : size === 'small'
      ? 'w-5 h-5'
      : 'w-10 h-10'
  const iconSize = size === 'compact' || size === 'small' ? 'w-3.5 h-3.5' : 'w-4 h-4'

  const base = `voice-mic shrink-0 ${sizeClasses} ${isListening ? 'listening' : ''} ${className}`.trim()

  // Reactive transform + dynamic glow for actual speech volume (high-impact polish: mic "breathes" + bright ring with your voice, instant glanceable confirmation during real meetings)
  const reactStyle = (isListening && level > 0.015)
    ? {
        transform: `scale(${1 + Math.min(0.18, level * 0.22)})` as const,
        boxShadow: `0 0 0 ${Math.round(4 + level * 9)}px rgba(239, 68, 68, ${0.12 + Math.min(0.18, level * 0.22)})`,
        borderColor: `rgba(239, 68, 68, ${0.7 + Math.min(0.3, level * 0.3)})`,
      }
    : undefined

  // Extra icon color pop driven by level (brilliant: the mic glyph itself "lights up" with your voice volume)
  const iconStyle = (isListening && level > 0.02)
    ? { color: `rgba(252, 165, 165, ${0.85 + Math.min(0.15, level * 0.2)})` as const }
    : undefined

  if (disabled) {
    return (
      <div
        className={`${base} opacity-40 cursor-not-allowed`}
        title={disabledTitle || title || 'Entrada por voz no disponible (fase de carga o ajuste)'}
        aria-hidden
      >
        <Mic className={iconSize} />
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={base}
      style={reactStyle}
      aria-label={ariaLabel || (isListening ? 'Detener entrada por voz' : 'Iniciar entrada por voz (habla en español)')}
      title={title || (isListening ? 'Detener escucha (o pulsa Esc)' : 'Hablar pregunta (español) — un toque + habla naturalmente. Se envía al final.')}
    >
      {isListening ? (
        <MicOff className={`${iconSize} mic-icon`} style={iconStyle} />
      ) : (
        <Mic className={`${iconSize} mic-icon`} />
      )}
    </button>
  )
}

// ===================== REACTIVE VOICE WAVEFORM (brilliant hands-busy visual feedback) =====================
// Small reusable component (no new files). Uses live audioLevel (0-1) from useVoiceInput to modulate bar heights
// in real-time. Makes "Escuchando" glanceable and delightful: bars dance with speech volume/silence.
// Replaces all static CSS-wave instances during listening. Falls back gracefully (level=0 -> classic pulsing via CSS).
// Consistent with existing .voice-wave / .voice-bar classes + Tailwind dark violet design.
function VoiceWave({ level = 0, mini = false, className = '' }: { level?: number; mini?: boolean; className?: string }) {
  // Always drive height via level for reactivity (high-impact UX). Low level -> base size (subtle "ready" state).
  // 'dynamic' class disables conflicting CSS loop anim so our live height+transition wins.
  // Slight organic phase + volume pop makes it feel alive and "brillante" precisely when you speak in meetings.
  const bars = [0, 1, 2, 3].map((i) => {
    const phase = [0.4, 1.0, 1.2, 0.6][i] || 0.8
    const base = mini ? 2.5 : 4.5
    const extra = mini ? 7.5 : 11
    const h = Math.max(base, Math.round(base + level * extra * phase))
    const isSpeaking = level > 0.02
    // Slight organic randomness in color pop for "alive" feel without perf cost
    const sat = isSpeaking ? (0.78 + Math.min(0.22, level * 0.5) + (i % 2 === 0 ? 0.03 : 0)) : 0.9
    return (
      <div
        key={i}
        className={`voice-bar ${mini ? 'voice-bar-mini' : ''} dynamic`}
        style={{
          height: `${h}px`,
          transition: 'height 65ms ease-out',
          backgroundColor: isSpeaking ? `rgba(248, 113, 113, ${sat})` : 'rgba(248, 113, 113, 0.9)',
        }}
        aria-hidden
      />
    )
  })
  return (
    <div
      className={`voice-wave ${mini ? 'mini' : ''} ${level > 0.02 ? 'voice-wave-active' : ''} ${className}`}
      style={{ height: mini ? 11 : 15 }}
      aria-hidden
    >
      {bars}
    </div>
  )
}

// ===================== COMPANION LIVE UI (for ?companion=1 narrow alwaysOnTop window) =====================
// Basic but thoughtful: timer, current focus, last answer or summary, quick focus chips, text+send ask (voice possible by extending).
// State comes from primary via onLiveUpdate listener. Asks go back via IPC so every feature (phased loading, memory stars, dual provider, contextFocus injection...) is executed in the main window.
function CompanionLiveUI({ onAsk, onClose }: {
  onAsk: (question: string, focus?: string | null) => void
  onClose?: () => void
}) {
  const [liveData, setLiveData] = useState<any>(null)
  const [q, setQ] = useState('')
  const [localFocus, setLocalFocus] = useState<string | null>(null)
  // Ref for auto-focus the PiP ask field on voice start (consistent brilliant UX with main/compact; caret at end for interim edit/confirm)
  const companionInputRef = useRef<HTMLInputElement>(null)
  // Local flash for copy feedback (high-impact in narrow PiP: no Toaster mounted in companion branch, so inline non-intrusive confirmation for "grab value" from pill without main)
  const [copiedFlash, setCopiedFlash] = useState<string | null>(null)

  // When primary stops recording, liveData will carry {ended:true} as final push (from handleStopRecording).
  const isEnded = !!liveData?.ended

  // Auto-clear flash on live data changes (new answer arrives) or end (keeps PiP clean/low-distraction)
  useEffect(() => {
    if (copiedFlash) {
      const t = setTimeout(() => setCopiedFlash(null), 1200)
      return () => clearTimeout(t)
    }
  }, [copiedFlash, liveData?.lastQA, isEnded])

  // Listen for pushed live state (from primary renderer)
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onLiveUpdate) return
    const unsub = api.onLiveUpdate((data: any) => setLiveData(data))
    return () => unsub?.()
  }, [])

  const elapsed = liveData?.elapsed || '00:00'
  const focus = liveData?.contextFocus ?? localFocus
  const focusLabel = liveData?.currentFocusLabel || (focus ? getFocusLabel(focus) : 'Todo')
  const last = liveData?.lastQA
  const loading = liveData?.isTranscribingRecent || liveData?.isThinkingLLM
  const snippet = liveData?.liveTranscriptSnippet
  const primaryMode = liveData?.recordingMode || 'normal'

  // Voice input integrated into companion PiP (one-tap speak, interim updates the field, final auto-sends via onAsk -> primary preserves ALL live features)
  const voice = useVoiceInput({
    onInterim: (text) => setQ(text),
    onFinal: (finalText) => {
      const trimmed = finalText.trim()
      if (!trimmed) return
      setQ(trimmed)
      // Auto-submit for brilliant hands-busy PiP experience. Uses current local focus.
      setTimeout(() => {
        if (!loading) {
          onAsk(trimmed, focus)
          setQ('')
        }
      }, 130)
    },
    onError: (err) => {
      // Companion is narrow PiP; log + rely on primary window toasts for permission UX. Keeps bundle simple.
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        console.warn('Companion PiP: permiso de micrófono requerido (otórgalo en la ventana principal si es necesario)')
      }
    },
  })
  const voiceSupported = voice.speechSupported && (liveData?.voiceEnabled !== false)

  const submit = () => {
    const qq = q.trim()
    if (!qq) return
    // Stop any active voice before manual text submit
    if (voice.isListening) voice.stopVoice(true)
    onAsk(qq, focus)
    setQ('')
  }

  // If loading phases start, stop voice listening to avoid overlap
  useEffect(() => {
    if (loading && voice.isListening) voice.stopVoice(true)
  }, [loading, voice.isListening])

  // Respect voice toggle from primary settings (synced via live updates). Stop gracefully if user disables while companion listening.
  useEffect(() => {
    if (liveData?.voiceEnabled === false && voice.isListening) voice.stopVoice(true)
  }, [liveData?.voiceEnabled, voice.isListening])

  // Support global voice hotkey in companion PiP too (delivered via main process IPC).
  // Allows Cmd/Ctrl+Shift+V to work when the narrow always-on-top is the focused/visible surface during screen sharing.
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onVoiceToggle) return
    const unsub = api.onVoiceToggle(() => {
      if (!isEnded && voice.speechSupported && (liveData?.voiceEnabled !== false) && !loading) {
        voice.toggleVoice()
      }
    })
    return unsub
  }, [isEnded, voice.speechSupported, liveData?.voiceEnabled, loading])

  // Autonomous polish: auto-focus companion's ask input (and caret at end) on voice start.
  // Makes interim preview immediately actionable in the narrow PiP (hands-busy + screen share flow). Matches main/compact behavior exactly.
  useEffect(() => {
    if (!voice.isListening) return
    const t = setTimeout(() => {
      const el = companionInputRef.current
      if (el) {
        if (document.activeElement !== el) el.focus()
        const len = el.value?.length || 0
        if (typeof el.selectionStart === 'number') {
          el.selectionStart = len
          el.selectionEnd = len
        }
      }
    }, 42)
    return () => clearTimeout(t)
  }, [voice.isListening])

  // High-impact: support Cmd/Ctrl+F (and [ / ]) for focus cycle directly in the narrow always-on-top PiP companion.
  // Mirrors main kb behavior; forwards via onAsk('' , nextFocus) which primary treats as focus-only set (see onCompanionFocus + onCompanionAsk).
  // Preserves low profile of companion (no full state). Works great for screen-share + hands-busy where PiP is the visible surface.
  useEffect(() => {
    const handleCompKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      if (e.key.toLowerCase() === 'f' || e.key === '[' || e.key === ']') {
        // Never hijack if focused on the ask input (natural typing flow)
        if (document.activeElement === companionInputRef.current) return
        e.preventDefault()
        const keys: Array<string | null> = [null, 'decisions', 'actions', 'risks', 'budget', 'people']
        const idx = keys.indexOf(focus)
        const dir = (e.key === '[') ? -1 : 1
        const next = keys[(idx + dir + keys.length) % keys.length]
        setLocalFocus(next)
        // Forward as focus-only (empty q tells primary "just set focus")
        onAsk('', next)
      }
    }
    window.addEventListener('keydown', handleCompKey)
    return () => window.removeEventListener('keydown', handleCompKey)
  }, [focus, onAsk])

  return (
    <div className={`h-screen w-full flex flex-col overflow-hidden border border-white/10 rounded-xl shadow-2xl ${primaryMode === 'stealth' ? 'bg-violet-950/95 text-violet-100 border-violet-500/20' : primaryMode === 'compact' ? 'bg-bg text-text-primary border-rose-500/20' : 'bg-bg text-text-primary'}`} style={{ fontSize: '12px' }}>
      {/* Title bar (frameless window, draggable via css if wanted) */}
      <div className="h-8 bg-bg-secondary/90 flex items-center justify-between px-2 text-[10px] border-b border-white/10 drag">
        <div className="flex items-center gap-1.5 font-medium">
          <img src="/reunia-logo.png" alt="ReunIA" className="w-4 h-4 rounded object-contain" onError={(e) => { (e.target as HTMLImageElement).src = '/reunia-logo.svg'; }} />
          <span>ReunIA <span className="text-text-muted">compañero</span></span>
          {primaryMode !== 'normal' && <span className="text-[8px] px-1 py-px rounded bg-white/10 text-text-muted/70">{primaryMode}</span>}
          {/* Cycle mode directly from PiP (high-impact autonomous enhancement).
              Uses existing setPreferredRecordingMode IPC (no new channels). Forwards to primary for full state + tray/global sync.
              Primary onRecordingMode listener will push updated liveData back here (recordingMode in payload). Minimal + consistent. */}
          <button
            onClick={() => {
              const api = (window as any).electron
              const modes: RecordingMode[] = ['normal', 'compact', 'stealth']
              const idx = modes.indexOf((primaryMode as RecordingMode) || 'normal')
              const next = modes[(idx + 1) % modes.length]
              api?.setPreferredRecordingMode?.(next)
            }}
            className="ml-1 text-[8px] px-1 py-px rounded bg-white/10 hover:bg-white/20 border border-white/10 text-text-muted/80"
            title="Ciclar modo preferido (normal/compact/stealth). Afecta auto-inicio y estado primario. O usa Shift+M global."
          >
            { (primaryMode || 'N')[0].toUpperCase() }↻
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onClose} className="px-1.5 hover:bg-white/10 rounded" title="Cerrar PiP">×</button>
        </div>
      </div>

      {/* Status bar - adapts for ended recording (low profile after stop) */}
      <div className="px-2 py-1.5 bg-bg/80 flex items-center gap-2 border-b border-white/5">
        <span className="font-mono tabular-nums text-base text-emerald-400">{elapsed}</span>
        {isEnded ? (
          <span className="text-[9px] px-1.5 py-0.5 bg-white/5 rounded border border-white/10 text-text-muted">FINALIZADA</span>
        ) : (
          <span className="text-[9px] px-1.5 py-0.5 bg-white/5 rounded border border-white/10">EN VIVO</span>
        )}
        {focus && !isEnded && <span className="text-[9px] px-1 py-px bg-accent/15 text-accent rounded border border-accent/20">{focusLabel.split(' ')[0]}</span>}
        {liveData?.qaCount > 0 && !isEnded && <span className="text-[9px] text-text-muted">+{liveData.qaCount}</span>}
        {loading && !isEnded && <span className="text-[9px] text-amber-400 animate-pulse">pensando…</span>}
        {voice.isListening && !isEnded && <span className="text-[9px] text-red-400 animate-pulse">🎤 escuchando{focus ? ` (${focusLabel.split(' ')[0]})` : ''}</span>}
        {copiedFlash && <span className="text-[8px] px-1 py-px bg-emerald-500/20 text-emerald-300 rounded border border-emerald-500/30">{copiedFlash}</span>}
      </div>

      {/* Last insight / summary (stealth friendly, minimal text) + copy/star from PiP (high-impact: grab value without main window) */}
      <div className="p-2 text-xs border-b border-white/5 bg-bg-secondary/40 min-h-[52px]">
        {isEnded ? (
          <div className="text-text-muted italic">Grabación detenida. Ventana principal tiene el historial completo y opciones para procesar con IA.</div>
        ) : last ? (
          <div className="group">
            <div className="text-[9px] text-accent mb-0.5 flex items-center justify-between">
              <span>Última respuesta:</span>
              <div className="flex gap-1 opacity-60 group-hover:opacity-100">
                <button onClick={() => { 
                  navigator.clipboard.writeText(last.answer).then(() => { setCopiedFlash('copiado'); setTimeout(()=>setCopiedFlash(null), 900) }).catch(()=>{}) 
                }} className="p-0.5 hover:text-accent" title="Copiar respuesta (se sincroniza)"> <Copy className="w-2.5 h-2.5" /> </button>
                <button onClick={() => { 
                  const api = (window as any).electron
                  api?.sendCompanionStarLast?.()
                }} className={`p-0.5 ${last.starred ? 'text-amber-400' : 'hover:text-emerald-400'}`} title="Marcar última respuesta para memoria / RAG (se sincroniza a primaria)"> <Star className={`w-2.5 h-2.5 ${last.starred ? 'fill-current' : ''}`} /> </button>
              </div>
            </div>
            <div className="text-text-secondary leading-snug line-clamp-3 cursor-pointer" onClick={() => { 
              navigator.clipboard.writeText(last.answer).then(() => { setCopiedFlash('copiado'); setTimeout(()=>setCopiedFlash(null), 900) }).catch(()=>{}) 
            }}>{last.answer}</div>
            {last.starred && <span className="text-amber-400 text-[9px]">★</span>}
          </div>
        ) : snippet ? (
          <div className="text-text-secondary/80 italic line-clamp-3 cursor-pointer" onClick={() => { 
            navigator.clipboard.writeText(snippet).then(() => { setCopiedFlash('copiado'); setTimeout(()=>setCopiedFlash(null), 900) }).catch(()=>{}) 
          }}>“{snippet}”</div>
        ) : (
          <div className="text-text-muted italic">Pregunta por texto o voz aquí (se procesa en ventana principal).</div>
        )}
      </div>

      {/* Mini focus (stealth: quick set) — hidden when ended for ultra-low profile. Uses same labels as main for consistency.
          Kb support (Cmd/Ctrl+F / [ / ]) added for PiP users who keep main minimized or backgrounded. */}
      {!isEnded && (
        <div className="px-2 py-1.5 flex flex-wrap gap-1 border-b border-white/5" title="Cmd/Ctrl+F o [ / ]: cicla foco (incluso sin ratón)">
          {[
            {key:null, l:'Todo'}, {key:'decisions',l:'Dec'}, {key:'actions',l:'Acc'}, {key:'risks',l:'Ries'}, {key:'budget',l:'Pres'}, {key:'people',l:'Pers'}
          ].map(o => {
            const a = focus === o.key || (o.key===null && !focus)
            return <button key={String(o.key)} onClick={() => { setLocalFocus(o.key); onAsk('', o.key) /* just set focus via primary */ }} className={`text-[9px] px-1.5 py-px rounded-full border ${a ? 'bg-accent text-white border-accent' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>{o.l}</button>
          })}
          <button onClick={() => (window as any).electron?.openCompanion?.()} className="ml-auto text-[9px] text-text-muted hover:text-accent" title="Reabrir PiP si se cerró">Reabrir</button>
        </div>
      )}

      {/* Voice status mini (non-intrusive for PiP) */}
      {voice.isListening && (
        <div className="mx-2 mt-1 px-2 py-1 text-[10px] rounded bg-red-500/10 border border-red-500/20 text-red-400 flex items-center gap-1.5" role="status" aria-live="polite">
          <VoiceWave level={voice.audioLevel} mini={false} />
          <span className="font-medium">Escuchando…{focus ? ` (${focusLabel.split(' ')[0]})` : ''}</span>
          {!voice.interim && <span className="text-[9px] opacity-60 ml-1">pausa ~2s envía</span>}
          {voice.interim && <span className="voice-interim text-[10px] max-w-[160px]">«{voice.interim}»</span>}
          {voice.interim && (
            <button
              onClick={() => {
                const toSend = voice.interim.trim()
                voice.stopVoice(true)
                if (toSend) { setQ(toSend); setTimeout(() => { onAsk(toSend, focus); setQ('') }, 80) }
              }}
              className="ml-1 text-[9px] px-1.5 py-px min-h-[20px] rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 flex items-center gap-0.5"
              title="Enviar voz ahora"
              aria-label="Enviar lo escuchado ahora"
            >
              <span>➤</span> Enviar
            </button>
          )}
          <button onClick={() => voice.stopVoice()} className="ml-auto text-[9px] px-1.5 py-px min-h-[20px] rounded bg-red-500/20 border border-red-500/30 flex items-center gap-0.5" aria-label="Detener escucha de voz" title="Detener voz">
            <X className="w-3 h-3" /> Detener
          </button>
        </div>
      )}

      {/* Ask row with prominent easy-tap voice mic (integrated for compact/PiP too) — disabled gracefully after end */}
      {!isEnded && (
        <div className="p-2 flex gap-1.5 items-center bg-bg">
          {voiceSupported && (
            <VoiceMicButton
              isListening={voice.isListening}
              onClick={voice.toggleVoice}
              disabled={loading}
              size="compact"
              level={voice.audioLevel}
              title={voice.isListening ? 'Detener voz (compañero)' : 'Hablar en español (se envía solo)'}
              disabledTitle={loading ? 'Voz pausada: procesando en ventana principal' : undefined}
            />
          )}
          {/* (companion uses its local voice hook; no separate wave here as status above covers + mic itself reacts via level) */}
          <input
            ref={companionInputRef}
            className={`input text-xs py-1.5 flex-1 ${voice.isListening ? 'voice-input-active ring-1 ring-red-400/50 border-red-400/40' : ''}`}
            placeholder={voice.isListening ? 'Hablando…' : "Pregunta (o 🎤 voz)"}
            value={q}
            onChange={e=>setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key==='Enter') submit()
              if (e.key==='Escape' && voice.isListening) { e.preventDefault(); voice.stopVoice() }
            }}
            disabled={loading}
          />
          <button onClick={submit} disabled={!q.trim() || loading} className="btn btn-primary text-xs px-3 py-1.5">Enviar</button>
        </div>
      )}

      <div className="px-2 py-1 text-[9px] text-text-muted border-t border-white/5 flex justify-between">
        {isEnded ? (
          <span>Puedes cerrar esta ventana. Usa la principal para informe / memoria / reabrir PiP.</span>
        ) : (
          <span>🎤 Voz disponible aquí • respeta enfoque • full features en primaria</span>
        )}
        <button onClick={onClose} className="hover:text-text-primary">ocultar</button>
      </div>
    </div>
  )
}

export default function ReunIA() {
  const {
    sessions,
    selectedSessionId,
    recording,
    settings,
    isSettingsOpen,
    isProcessing,
    processingSessionId,
    loadSessions,
    selectSession,
    addOrUpdateSession,
    updateSession,
    deleteSession,
    startRecording,
    stopRecording,
    setRecordingState,
    setSettingsOpen,
    loadSettings,
    saveSettings,
    setProcessing,
    askLiveQuestion,
    memoryCount,
    loadMemory,
    clearMemory,
    // recordingMode + live UI chrome (compact/stealth pill/expanded/hidden) for low-distraction meeting modes (clean central state)
    recordingMode,
    setRecordingMode,
    livePanelExpanded,
    setLivePanelExpanded,
    assistantHidden,
    setAssistantHidden,
  } = useStore()

  const { devices, refresh: refreshDevices } = useAudioDevices()
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const [showDevicePicker, setShowDevicePicker] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [currentAudioUrl, _setCurrentAudioUrl] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [waveSurfer, _setWaveSurfer] = useState<WaveSurfer | null>(null)
  const [currentSessionData, setCurrentSessionData] = useState<{ transcript?: string; report?: Report }>({})
  const [ollamaTestStatus, setOllamaTestStatus] = useState<{ loading: boolean; message: string }>({ loading: false, message: '' })
  const [liveQuestion, setLiveQuestion] = useState('')

  // Memory browser (deep self-improvement management inside settings modal)
  const [showMemoryBrowser, setShowMemoryBrowser] = useState(false)
  const [memorySearch, setMemorySearch] = useState('')
  const [memoryFilter, setMemoryFilter] = useState<'all' | 'starred'>('all')

  // One-time first-run onboarding flag (per app session). Opens Ajustes automatically
  // for new team members so they can paste their OpenAI key or switch to Ollama immediately.
  const [didFirstRunCheck, setDidFirstRunCheck] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)

  // Secure update status (events come only from main process via IPC)
  const [updateStatus, setUpdateStatus] = useState<any>(null)

  // Proper ref + effect for auto-scrolling live Q&A history (replaces previous render-mutation hack)
  const liveHistoryRef = useRef<HTMLDivElement>(null)

  // Live history filters (ephemeral per recording session, low-friction instant apply)
  const [liveHistorySearch, setLiveHistorySearch] = useState('')
  const [liveHistoryTagFilter, setLiveHistoryTagFilter] = useState<string | null>(null) // null = all; 'decision' | 'action' | 'risk' | 'budget' | 'person' | 'starred'

  // Local flash for pill copy feedback (high-impact autonomous UX: "copiado" confirmation inline in the compact/stealth bar itself during meetings, without global Toaster noise or leaving the minimal surface).
  const [pillCopiedFlash, setPillCopiedFlash] = useState<string | null>(null)
  // Stealth placeholder inline flash (autonomous enhancement): same low-distraction "copiado" without any toast popup, even in ultra-minimal hidden-stealth.
  const [stealthCopiedFlash, setStealthCopiedFlash] = useState<string | null>(null)
  // Voice auto-submit confirmation flash (high-impact for hands-busy: glanceable "✓ enviado" inline in the Escuchando bar, no toast popup during meetings).
  const [voiceSentFlash, setVoiceSentFlash] = useState<string | null>(null)

  // ===================== VOICE INPUT (powered by reusable hook for main + compact + companion) =====================
  const liveInputRef = useRef<HTMLInputElement>(null)
  // Separate ref for the pill input (visible in compact/stealth minimized mode) so voice start can auto-focus the *visible* field
  // for edit/confirm fallback + low cognitive load (interim appears, cursor ready if user wants to tweak before auto-send).
  const pillInputRef = useRef<HTMLInputElement>(null)

  // Gate by user setting (bonus toggle) + browser support. All live features (focus, memory, phases, stars) preserved downstream.
  const voiceEnabled = settings.enableVoiceInput !== false
  const voice = useVoiceInput({
    onInterim: (text) => {
      setLiveQuestion(text)
    },
    onFinal: (finalText) => {
      const trimmed = finalText.trim()
      if (!trimmed) return
      setLiveQuestion(trimmed)
      // Auto-submit (brilliant one-tap natural speak). Tiny delay so user sees text land. Pass value to avoid any stale liveQuestion closure.
      setTimeout(() => {
        if (!recording.isTranscribingRecent && !recording.isThinkingLLM) {
          // Use the shared handler (stops voice, clears, calls askLiveQuestion which does contextFocus + memory RAG + phases etc.)
          handleAskLive(trimmed)
          // Non-intrusive confirmation flash (high-impact for meetings: user knows the spoken Q was accepted without looking away or hearing a toast).
          setVoiceSentFlash('✓ enviado')
        }
      }, 140)
    },
    onError: (err) => {
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        toast.error('Permiso de micrófono denegado', {
          description: 'Concede permiso de micrófono al navegador para usar entrada por voz.'
        })
      } else if (err !== 'no-speech' && err !== 'aborted') {
        toast.info('Entrada de voz interrumpida')
      }
    },
  })
  const speechSupported = voice.speechSupported && voiceEnabled
  const isVoiceListening = voice.isListening
  const voiceInterim = voice.interim
  const voiceLevel = voice.audioLevel || 0

  // Helper to stop (used in many places: focus changes, suggestions, filters, manual Esc etc)
  function stopVoiceListening(silent = false) {
    voice.stopVoice(silent)
    // Clear any pending sent flash when user explicitly stops (avoids stale "enviado" after cancel)
    if (voiceSentFlash) setVoiceSentFlash(null)
  }
  // For toggle from old call sites. Now with mode-aware focus so it targets the visible ask field
  // (full panel vs compact pill input) — critical for compact/stealth hands-busy UX where full panel may be collapsed.
  function toggleVoiceInput() {
    if (!speechSupported || recording.isTranscribingRecent || recording.isThinkingLLM) return
    const wasListening = voice.isListening
    // High-impact UX fix for stealth/compact + hidden: if user triggers voice (mic or global/kb hotkey) while pill is hidden,
    // instantly reveal the minimal bar so they get "Escuchando…", interim preview, Detener, and the input. Zero extra taps.
    // Keeps stealth low-distraction until voice is actually used (then shows just enough chrome, non-alarming).
    if (!wasListening && recording.isRecording && (recordingMode === 'compact' || recordingMode === 'stealth') && assistantHidden) {
      setAssistantHidden(false)
      setLivePanelExpanded(false)
    }
    if (!wasListening) {
      // Autonomous high-impact polish for voice-first hands-busy flow:
      // Clear any prior typed text in the ask field (main or pill) so the spoken interim starts on a clean slate.
      // "One tap mic + speak naturally" without leftover typed remnants mixing into the preview.
      // Input will be auto-focused (below) with caret at end ready for any quick edit before silence auto-submit.
      setLiveQuestion('')
    }
    voice.toggleVoice()
    // Auto-focus the *visible* input on start (interim will populate it live). This enables quick edit/confirm if user
    // wants to tweak before auto-submit on final/silence, while keeping pure voice flow zero-friction.
    if (!wasListening) {
      setTimeout(() => {
        const inCompactPill = recordingMode !== 'normal' && !livePanelExpanded
        const target = inCompactPill ? pillInputRef.current : liveInputRef.current
        target?.focus()
      }, 55)
    }
  }

  // If voice gets disabled in settings while actively listening, stop gracefully (low friction)
  useEffect(() => {
    if (!voiceEnabled && isVoiceListening) {
      stopVoiceListening(true)
    }
  }, [voiceEnabled, isVoiceListening])

  // High-impact autonomous UX polish for voice-first / hands-busy meetings:
  // Robust auto-focus of the *visible* ask input (full panel or compact pill) whenever voice listening starts.
  // Complements the one in toggleVoiceInput (which covers hotkey paths). Ensures cursor + interim preview are immediately
  // glanceable/editable for confirm flow, even if reveal-from-hidden or global hotkey races. Low cognitive: user speaks, sees live text with caret ready.
  useEffect(() => {
    if (!isVoiceListening) return
    const t = setTimeout(() => {
      const inCompactPill = recordingMode !== 'normal' && !livePanelExpanded
      const target = inCompactPill ? pillInputRef.current : liveInputRef.current
      if (target) {
        // Only focus if not already (prevents fighting user or other inputs)
        if (document.activeElement !== target) {
          target.focus()
        }
        // Position caret at end so interim text is easy to append/edit before auto-submit or silence
        const len = (target as HTMLInputElement).value?.length || 0
        if (typeof (target as HTMLInputElement).selectionStart === 'number') {
          ;(target as HTMLInputElement).selectionStart = len
          ;(target as HTMLInputElement).selectionEnd = len
        }
      }
    }, 38)
    return () => clearTimeout(t)
  }, [isVoiceListening, recordingMode, livePanelExpanded])

  const selectedSession = sessions.find(s => s.id === selectedSessionId) || null

  // ===================== LIVE FILTER FEATURE: definitions (premium, dynamic, low-friction) =====================
  // Context Focus options: clicking instantly sets recording.contextFocus which flows to askAboutRecentTranscript prompt
  const FOCUS_OPTIONS: Array<{ key: string | null; label: string; icon: React.ReactNode }> = [
    { key: null, label: 'Todo', icon: <Filter className="w-3 h-3" /> },
    { key: 'decisions', label: 'Decisiones', icon: <Target className="w-3 h-3" /> },
    { key: 'actions', label: 'Acciones', icon: <CheckCircle className="w-3 h-3" /> },
    { key: 'risks', label: 'Riesgos', icon: <AlertTriangle className="w-3 h-3" /> },
    { key: 'budget', label: 'Presupuesto', icon: <DollarSign className="w-3 h-3" /> },
    { key: 'people', label: 'Personas', icon: <Users className="w-3 h-3" /> },
  ]

  const currentFocus = recording.contextFocus
  const currentFocusLabel = getFocusLabel(currentFocus)

  // Dynamic suggestions: evolve with focus for "smart context focus filter" feel
  const getDynamicSuggestions = (focus: string | null): string[] => {
    if (focus === 'decisions') {
      return [
        "¿Qué decisiones hemos tomado hasta ahora?",
        "Resume los acuerdos clave de la reunión",
        "¿Quién impulsó la última decisión importante?",
      ]
    }
    if (focus === 'actions') {
      return [
        "¿Cuáles son las acciones y próximos pasos?",
        "¿Quién es responsable de cada tarea mencionada?",
        "Lista las acciones pendientes identificadas",
      ]
    }
    if (focus === 'risks') {
      return [
        "¿Qué riesgos o preocupaciones se han mencionado?",
        "Resume los posibles bloqueos o problemas",
        "¿Hay algo que pueda salir mal según lo hablado?",
      ]
    }
    if (focus === 'budget') {
      return [
        "¿Qué se ha dicho sobre presupuesto o costes?",
        "Resume números, precios o recursos financieros",
        "¿Hay impacto presupuestario en las decisiones?",
      ]
    }
    if (focus === 'people') {
      return [
        "¿Qué dijo cada persona sobre el tema principal?",
        "¿Quiénes han intervenido más activamente?",
        "Resume opiniones o posiciones de los asistentes",
      ]
    }
    // Default / no focus - original magic chips + one extra
    return [
      "¿Qué decisiones hemos tomado?",
      "¿Cuáles son las acciones pendientes?",
      "¿Qué dijo [última persona] sobre el tema principal?",
      "¿Hay algún riesgo o preocupación mencionada?",
    ]
  }
  const dynamicSuggestions = getDynamicSuggestions(currentFocus)

  // Companion window detection (loads same bundle with ?companion=1 -> renders only minimal always-on-top live pill, state via IPC sync)
  const isCompanion = typeof window !== 'undefined' &&
    (window.location.search.includes('companion=1') || window.location.search.includes('companion'))

  // Filtered live QAs for history (keyword + tag filter, instant, client-side)
  const filteredLiveQAs = useMemo(() => {
    const qas = recording.liveQA || []
    if (!liveHistorySearch.trim() && !liveHistoryTagFilter) return qas

    const s = liveHistorySearch.trim().toLowerCase()
    return qas.filter((qa) => {
      const haystack = `${qa.question} ${qa.answer}`.toLowerCase()
      const matchesSearch = !s || haystack.includes(s)

      let matchesTag = true
      if (liveHistoryTagFilter) {
        if (liveHistoryTagFilter === 'starred') {
          matchesTag = !!qa.starred
        } else {
          matchesTag = (qa.tags || []).includes(liveHistoryTagFilter)
        }
      }
      return matchesSearch && matchesTag
    })
  }, [recording.liveQA, liveHistorySearch, liveHistoryTagFilter])

  // Load on mount
  useEffect(() => {
    loadSessions()
    loadSettings()
    loadMemory()
    // Sync preferred recordingMode (compact/stealth) from main process (may have been changed via tray or global Cmd+Shift+M while app was closed/hidden).
    // Ensures the pre-record indicator + auto-start on record always reflect the system-wide pref.
    const api = (window as any).electron
    if (api?.getPreferredRecordingMode) {
      api.getPreferredRecordingMode().then((m: RecordingMode) => {
        if (m && (m === 'normal' || m === 'compact' || m === 'stealth') && m !== recordingMode) {
          setRecordingMode(m)
        }
      }).catch(() => {})
    }
  }, [])

  // Reset Ollama test status when settings modal opens or provider changes
  useEffect(() => {
    if (!isSettingsOpen) {
      setOllamaTestStatus({ loading: false, message: '' })
    }
  }, [isSettingsOpen, settings.aiProvider])

  // Listen for secure update status events (pushed from main process only)
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onUpdateStatus) return
    const unsub = api.onUpdateStatus((status: any) => {
      setUpdateStatus(status)
    })
    return unsub
  }, [])

  // First-run / team onboarding UX:
  // When a new person installs and launches ReunIA for the first time on their PC,
  // automatically open the Settings modal if they have no OpenAI key configured.
  // This makes "cada uno con su cuenta" dead simple: launch → configure your key/Ollama → ready.
  // Only happens once per app launch session (settings are persisted per user via electron-store).
  useEffect(() => {
    if (!didFirstRunCheck && settings) {
      const isOpenAIWithoutKey = settings.aiProvider === 'openai' && !settings.openaiApiKey?.trim();
      if (isOpenAIWithoutKey) {
        const t = setTimeout(() => {
          setSettingsOpen(true);
          toast.info('Bienvenido a ReunIA', {
            description: 'Configura tu clave de OpenAI o cambia a Ollama (local) en Ajustes para empezar. Cada miembro del equipo usa su propia cuenta y sus grabaciones quedan en su PC.',
            duration: 7000,
          });
        }, 450);
        setDidFirstRunCheck(true);
        return () => clearTimeout(t);
      }
      setDidFirstRunCheck(true);
    }
  }, [settings, didFirstRunCheck, setSettingsOpen]);

  // Show friendly onboarding modal the very first time (when there are no sessions yet)
  useEffect(() => {
    if (sessions.length === 0 && !showOnboarding && didFirstRunCheck) {
      // Small delay so the UI settles
      const t = setTimeout(() => setShowOnboarding(true), 1200);
      return () => clearTimeout(t);
    }
  }, [sessions.length, showOnboarding, didFirstRunCheck]);

  // Listen to global hotkey / tray toggles from main
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onRecordingToggle) return

    const unsub = api.onRecordingToggle((action: 'start' | 'stop') => {
      if (action === 'start' && !recording.isRecording) {
        handleStartRecording()
      } else if (action === 'stop' && recording.isRecording) {
        handleStopRecording()
      }
    })
    return unsub
  }, [recording.isRecording])

  // Listen for global voice hotkey (main process). Complements local Cmd/Ctrl+Shift+V.
  // Only acts during active recording (voice only relevant then). toggleVoiceInput handles hidden->pill reveal.
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onVoiceToggle) return
    const unsub = api.onVoiceToggle(() => {
      if (recording.isRecording && speechSupported && !recording.isTranscribingRecent && !recording.isThinkingLLM) {
        toggleVoiceInput()
      }
    })
    return unsub
  }, [recording.isRecording, speechSupported, recording.isTranscribingRecent, recording.isThinkingLLM])

  // Auto-scroll live history when new QAs arrive (brilliant + reliable)
  useEffect(() => {
    if (liveHistoryRef.current) {
      liveHistoryRef.current.scrollTop = liveHistoryRef.current.scrollHeight
    }
  }, [recording.liveQA])

  // Reset ephemeral live filters when a fresh recording session begins
  useEffect(() => {
    if (recording.isRecording && recording.liveQA.length === 0) {
      setLiveHistorySearch('')
      setLiveHistoryTagFilter(null)
    }
  }, [recording.isRecording, recording.liveQA.length])

  // Auto-focus the live ask input when recording starts (low-friction for voice or type immediately)
  useEffect(() => {
    if (recording.isRecording) {
      const t = setTimeout(() => {
        liveInputRef.current?.focus()
      }, 180)
      return () => clearTimeout(t)
    }
  }, [recording.isRecording])

  // Cleanup voice recognition + timers when recording stops or component unmounts
  useEffect(() => {
    if (!recording.isRecording) {
      stopVoiceListening(true)
    }
    return () => {
      stopVoiceListening(true)
    }
  }, [recording.isRecording])

  // ===================== KEYBOARD SHORTCUTS for meeting UX (low distraction, hands-busy friendly) =====================
  // M cycles modes *always* (lets user set preferred default before starting a recording)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      // Cycle recording modes: Cmd/Ctrl + M  (thoughtful for real meetings; works pre-record to set pref)
      // Also global Cmd/Ctrl+Shift+M works even when ReunIA not focused (main process delivers via IPC).
      if (meta && (e.key.toLowerCase() === 'm')) {
        // High-impact friction fix for meetings: do NOT cycle mode while user is actively typing a question
        // in the live panel input or compact pill input (prevents hijacking Cmd/Ctrl+M during natural flow).
        // Cycle still works pre-rec, from banner/pill/rail explicit buttons, global Shift+M, and tray.
        const active = document.activeElement as HTMLElement | null
        const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
        if (isTyping) return
        e.preventDefault()
        const modes: RecordingMode[] = ['normal', 'compact', 'stealth']
        const idx = modes.indexOf(recordingMode)
        const next = modes[(idx + 1) % modes.length]
        setAndPersistRecordingMode(next)
        // When going stealth, also collapse panel for max minimalism (only meaningful during rec)
        if (next === 'stealth') {
          if (recording.isRecording) setAssistantHidden(true)
        } else if (recording.isRecording) {
          setAssistantHidden(false)
        }
      }
      // High-impact focus cycle kb (Cmd/Ctrl + F or [ / ] ): cycle context focus even from compact pill / stealth / rail / banner.
      // Works pre-rec too (sets for next). Guarded when typing in ask/pill inputs. Low-conflict, brilliant for hands-busy meetings.
      // [ = prev focus, ] = next, F = next (mnemonic Focus). Only during/around recording for relevance.
      if (meta && (e.key.toLowerCase() === 'f' || e.key === '[' || e.key === ']')) {
        const active = document.activeElement as HTMLElement | null
        const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
        if (isTyping) return
        e.preventDefault()
        const dir = (e.key === '[') ? -1 : 1
        cycleFocus(dir as 1 | -1)
      }
      // Below only make sense while actively recording
      if (!recording.isRecording) return
      // Toggle live panel expand/collapse (or hide in stealth)
      if (meta && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        // Fixed: use current closed-over values (store setters take direct boolean, not updater fns like useState).
        // Reliable collapse/expand hotkey even with voice active (low distraction during meetings).
        if (recordingMode === 'stealth') {
          setAssistantHidden(!assistantHidden)
        } else {
          setLivePanelExpanded(!livePanelExpanded)
        }
      }
      // Quick hide assistant (stealth escape) - Esc in certain cases
      if (e.key === 'Escape') {
        // High-impact hands-busy polish: Esc ALWAYS cancels active voice listening first (natural "stop" during meetings, no need to hunt the small Detener button or target the mic).
        // Then apply hide logic only for compact/stealth if not actively typing (prevents fighting input Esc handlers which already stop voice).
        if (isVoiceListening) {
          e.preventDefault()
          stopVoiceListening()
          // do not return; allow hide to also fire if applicable (user may want to hide after cancelling voice)
        }
        if ((recordingMode === 'compact' || recordingMode === 'stealth')) {
          const active = document.activeElement as HTMLElement
          if (!active || !['INPUT', 'TEXTAREA'].includes(active.tagName)) {
            e.preventDefault()
            setAssistantHidden(true)
          }
        }
      }
      // Autonomous high-impact kb for meetings: 'h' (or Cmd/Ctrl+H) to hide pill/assistant instantly (complements J toggle + Esc).
      // Low-conflict (only acts in rec + compact/stealth; guarded vs typing). 'H' for Hide. Works from pill or full.
      if (recording.isRecording && (recordingMode === 'compact' || recordingMode === 'stealth')) {
        const isH = e.key.toLowerCase() === 'h'
        const metaH = (e.metaKey || e.ctrlKey) && isH
        if (isH || metaH) {
          const active = document.activeElement as HTMLElement | null
          const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
          if (!isTyping) {
            e.preventDefault()
            if (isVoiceListening) stopVoiceListening(true)
            setAssistantHidden(true)
          }
        }
      }
      // Voice toggle hotkey (hands-busy friendly): Cmd/Ctrl + Shift + V  (local when window focused).
      // Global version (works from Meet/Zoom or background) registered in main process + IPC delivered here (and to companion).
      // toggleVoiceInput() handles stealth-hidden case by revealing the pill bar for visual feedback + controls.
      if (meta && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        if (speechSupported && !recording.isTranscribingRecent && !recording.isThinkingLLM) {
          toggleVoiceInput()
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [recording.isRecording, recordingMode, setRecordingMode, setLivePanelExpanded, setAssistantHidden, speechSupported, recording, livePanelExpanded, assistantHidden, recording.isTranscribingRecent, recording.isThinkingLLM, isVoiceListening, stopVoiceListening, currentFocus])

  // Reset compact UI prefs when recording ends (fresh for next). Store now owns the state (set on stop + on start per-mode).
  useEffect(() => {
    if (!recording.isRecording) {
      setLivePanelExpanded(true)
      setAssistantHidden(false)
    }
  }, [recording.isRecording, setLivePanelExpanded, setAssistantHidden])

  // Auto-clear pill copy flash (glanceable confirmation in bar; low-distraction, matches companion PiP pattern).
  useEffect(() => {
    if (pillCopiedFlash) {
      const t = setTimeout(() => setPillCopiedFlash(null), 900)
      return () => clearTimeout(t)
    }
  }, [pillCopiedFlash])

  // Auto-clear stealth placeholder inline copy flash (consistent zero-distraction UX in hidden ultra-low mode).
  useEffect(() => {
    if (stealthCopiedFlash) {
      const t = setTimeout(() => setStealthCopiedFlash(null), 1100)
      return () => clearTimeout(t)
    }
  }, [stealthCopiedFlash])

  // Auto-clear voice sent flash (brilliant low-cog confirmation that the spoken question was auto-submitted).
  useEffect(() => {
    if (voiceSentFlash) {
      const t = setTimeout(() => setVoiceSentFlash(null), 950)
      return () => clearTimeout(t)
    }
  }, [voiceSentFlash])

  // ===================== LIVE STATE SYNC TO COMPANION (primary -> secondary narrow PiP) =====================
  // Only when primary is recording; pushes minimal data needed for pill (preserves zero extra cost)
  useEffect(() => {
    if (!recording.isRecording) return
    const api = (window as any).electron
    if (!api?.sendLiveUpdate) return

    const lastQA = recording.liveQA.length > 0 ? recording.liveQA[recording.liveQA.length - 1] : null
    const payload = {
      elapsed: recording.elapsed,
      contextFocus: recording.contextFocus,
      currentFocusLabel: getFocusLabel(recording.contextFocus),
      liveTranscriptSnippet: (recording.liveTranscript || '').slice(-220),
      lastQA: lastQA ? { question: lastQA.question, answer: lastQA.answer.slice(0, 260), starred: !!lastQA.starred, tags: lastQA.tags } : null,
      isTranscribingRecent: recording.isTranscribingRecent,
      isThinkingLLM: recording.isThinkingLLM,
      qaCount: recording.liveQA.length,
      // Propagate voice pref so companion PiP respects the setting (high-impact consistency for users who disable voice)
      voiceEnabled: settings.enableVoiceInput !== false,
      // Propagate current mode for subtle status in the narrow PiP (e.g. "compañero • stealth")
      recordingMode,
    }
    api.sendLiveUpdate(payload)
  }, [
    recording.isRecording,
    recording.elapsed,
    recording.contextFocus,
    recording.liveTranscript,
    recording.liveQA.length,
    // Include liveQA array ref (changes on append OR star toggle) so starred status in lastQA payload propagates to PiP companion instantly.
    // Critical for "star from PiP" roundtrip visibility + any pill star feedback in future syncs. Low cost (early return if not rec).
    recording.liveQA,
    recording.isTranscribingRecent,
    recording.isThinkingLLM,
    settings.enableVoiceInput, // ensure companion sees voice toggle changes mid-recording
    recordingMode, // ensure companion pill/badge reflects live mode cycles (high-impact sync fix for PiP users)
  ])

  // Listen for companion-originated asks/focus (forwarded by main process). Calls the exact same askLiveQuestion path -> full features preserved.
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onCompanionAsk && !api?.onCompanionFocus) return

    const unsubAsk = api.onCompanionAsk?.((payload: { question: string; focus?: string | null }) => {
      if (payload.focus !== undefined) {
        setRecordingState({ contextFocus: payload.focus })
      }
      if (payload.question && payload.question.trim()) {
        // Directly use the store action (bypasses local liveQuestion input state)
        askLiveQuestion(payload.question.trim())
      }
    })

    const unsubFocus = api.onCompanionFocus?.((focus: string | null) => {
      setRecordingState({ contextFocus: focus })
    })

    return () => {
      unsubAsk?.()
      unsubFocus?.()
    }
  }, [askLiveQuestion, setRecordingState])

  // Listen for companion-originated "star last QA" (from PiP star button). Toggles starred on the most recent liveQA so it participates in memory RAG immediately (and persists on stop).
  // High-impact autonomous improvement: makes "Marcar para memoria" from the narrow always-on-top companion actually work (previously was a no-op hack).
  // Uses same update pattern as pill and history star buttons.
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onCompanionStarLast) return

    const unsub = api.onCompanionStarLast?.(() => {
      const currentQAs = recording.liveQA || []
      if (currentQAs.length === 0) return
      const last = currentQAs[currentQAs.length - 1]
      const updated = currentQAs.map(item =>
        item.id === last.id ? { ...item, starred: !item.starred } : item
      )
      setRecordingState({ liveQA: updated } as any)
    })

    return () => { unsub?.() }
  }, [recording.liveQA, setRecordingState])

  // Listen for tray-initiated "open PiP" (high-impact discoverability from tray menu even with main hidden/background).
  // Triggers exact same low-profile behavior as the in-app banner/PiP button: hide assistant/pill chrome + minimize main (PiP becomes the visible always-on-top surface).
  // Uses existing minimizeMain IPC + state setter. Minimal new listener; preserves all.
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onCompanionTriggerHideAndMinimize) return
    const unsub = api.onCompanionTriggerHideAndMinimize?.(() => {
      if (recording.isRecording) {
        setAssistantHidden(true)
        // also stop voice if active to avoid "invisible listening"
        if (isVoiceListening) stopVoiceListening(true)
        api?.minimizeMain?.()
      }
    })
    return () => { unsub?.() }
  }, [recording.isRecording, setAssistantHidden, isVoiceListening, stopVoiceListening])

  // Listen for preferred mode changes pushed from main (global hotkey Cmd/Ctrl+Shift+M, tray mode menu clicks).
  // Updates local zustand immediately so pre-record "modo" indicator and next startRecording use the new pref.
  // High-impact fix: use ref for latest isRecording to avoid stale closure when global/tray cycle happens mid-meeting (main may be hidden/background during Zoom/Meet share).
  const isRecordingRef = useRef(recording.isRecording)
  useEffect(() => { isRecordingRef.current = recording.isRecording }, [recording.isRecording])
  useEffect(() => {
    const api = (window as any).electron
    if (!api?.onRecordingMode) return
    const unsub = api.onRecordingMode((mode: RecordingMode) => {
      if (mode === 'normal' || mode === 'compact' || mode === 'stealth') {
        setRecordingMode(mode)
        // If currently recording, optionally auto-adjust chrome like the kb cycle does (for instant feedback).
        // Uses ref so even if listener closure is from before rec started, we act on live state (reliable during real meetings).
        if (isRecordingRef.current) {
          if (mode === 'stealth') {
            setAssistantHidden(true)
            setLivePanelExpanded(false)
          } else if (mode === 'compact') {
            setAssistantHidden(false)
            setLivePanelExpanded(false)
          } else {
            setAssistantHidden(false)
            setLivePanelExpanded(true)
          }
        }
      }
    })
    return unsub
  }, [setRecordingMode, setAssistantHidden, setLivePanelExpanded])

  // Cleanup audio urls
  useEffect(() => {
    return () => {
      if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl)
    }
  }, [currentAudioUrl])

  // Initialize wavesurfer once (secure container, no direct FS)
  useEffect(() => {
    if (waveSurfer) return
    const container = document.getElementById('waveform')
    if (!container) return
    const ws = WaveSurfer.create({
      container: container as HTMLElement,
      waveColor: '#6366f1',
      progressColor: '#a5b4fc',
      height: 80,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
    })
    _setWaveSurfer(ws)
    // sync play state
    ws.on('play', () => setIsPlaying(true))
    ws.on('pause', () => setIsPlaying(false))
    ws.on('finish', () => setIsPlaying(false))
    return () => {
      ws.destroy()
    }
  }, [waveSurfer])

  // Load audio + full report/transcript for selected saved session securely via main process.
  // This is the key piece that makes past meetings deliver the complete visual report the user asked for.
  useEffect(() => {
    if (!selectedSession) return
    const api = (window as any).electron

    // 1. Load audio for wavesurfer (secure)
    if (waveSurfer) {
      if (selectedSession.folderPath && selectedSession.audioFileName && api?.loadAudio) {
        api.loadAudio(selectedSession.folderPath, selectedSession.audioFileName).then((ab: ArrayBuffer | null) => {
          if (ab && waveSurfer) {
            const blob = new Blob([ab], { type: 'audio/webm' })
            const url = URL.createObjectURL(blob)
            if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl)
            // @ts-ignore
            ;(window as any).__lastDiskAudioUrl = url
            waveSurfer.load(url)
          }
        }).catch(() => {})
      } else {
        // Fallback to in-memory last recording
        // @ts-ignore
        const lastBlob: Blob | undefined = (window as any).__lastRecordingBlob
        // @ts-ignore
        const lastId = (window as any).__lastRecordingSessionId
        if (lastBlob && lastId === selectedSession.id) {
          const url = URL.createObjectURL(lastBlob)
          if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl)
          waveSurfer.load(url)
        }
      }
    }

    // 2. Load full report + transcript from disk for rich detail view (critical for past meetings)
    const loadSavedData = async () => {
      if (!selectedSession.folderPath || (!selectedSession.hasReport && !selectedSession.hasTranscript)) {
        // Not a saved session with files, or it's the just-processed one (data already in currentSessionData)
        return
      }
      try {
        const [loadedReport, loadedTranscript] = await Promise.all([
          selectedSession.hasReport && api?.loadReport ? api.loadReport(selectedSession.folderPath) : null,
          selectedSession.hasTranscript && api?.loadTranscript ? api.loadTranscript(selectedSession.folderPath) : null,
        ])
        if (loadedReport || loadedTranscript) {
          setCurrentSessionData({
            transcript: loadedTranscript || undefined,
            report: loadedReport || undefined,
          })
        }
      } catch (e) {
        console.warn('Failed to load saved report/transcript', e)
      }
    }
    loadSavedData()
  }, [selectedSession, waveSurfer])

  const filteredSessions = sessions
    .filter(s => 
      s.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (s.topic && s.topic.toLowerCase().includes(searchTerm.toLowerCase()))
    )
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  // ===================== RECORDING =====================
  async function handleStartRecording() {
    if (recording.isRecording) return

    // Show device picker the first time or if user wants
    if (!selectedDeviceId && devices.length > 1) {
      setShowDevicePicker(true)
      return
    }

    const ok = await startRecording(selectedDeviceId || null)
    if (ok) {
      toast.success('Grabación iniciada', { description: 'Habla normalmente. Pulsa detener cuando termines.' })
      setShowDevicePicker(false)
      // High-impact autonomous UX: non-intrusive one-time hint when auto-starting in low-distraction mode.
      // Helps first-time meeting users discover pill/rail/J/M/Esc/PiP without modal or persistent noise.
      // Only for compact/stealth; auto-dismisses; respects the "brillante, fácil" goal.
      // Note: Cmd/Ctrl+M (global + local) now cycles pref from anywhere (background/Meet/Zoom).
      if (recordingMode !== 'normal') {
        const modeHint = recordingMode === 'stealth' ? 'Stealth: pill oculta por defecto (J/Esc mostrar, M ciclo, F foco, PiP). Global Cmd/Ctrl+M también.' : 'Compacto: barra pill visible (M ciclo, J toggle, Esc ocultar, F/[ ciclo foco, PiP). Cmd/Ctrl+M global.'
        setTimeout(() => {
          toast.info(`Modo ${recordingMode}`, { description: modeHint, duration: 1600 })
        }, 420)
      }
    }
  }

  async function handleStopRecording() {
    if (!recording.isRecording) return

    const elapsedAtStop = recording.elapsed
    const newSession = await stopRecording()
    if (!newSession) return

    // Keep the last audio blob around temporarily for playback + AI
    // (recState access removed as unused; blob is attached to window in stopRecording)
    // The chunks are inside the store but we need the blob. We can reconstruct from last stop.
    // Simpler: store lastBlob on window for this session.
    // We will improve this.

    // For now create a downloadable blob from the chunks that were accumulated
    // (the store resets them on stop, so we use a small trick - re-record the last chunks if needed)
    // Actually the stopRecording promise resolves before full cleanup. Let's capture via closure in store later.

    // TEMP: create object url from last chunks if accessible (we will attach to window in a better version)
    // For this first working version we will ask user to save immediately.

    // Notify companion (PiP) of end so it can show low-profile "finalizado" state (preserves zero ongoing cost).
    // This is minimal enhancement to the existing IPC live sync for better UX when using narrow always-on-top during meetings.
    const api = (window as any).electron
    if (api?.sendLiveUpdate) {
      api.sendLiveUpdate({ ended: true, elapsed: elapsedAtStop || newSession.durationSec ? `${Math.floor((newSession.durationSec||0)/60)}:${String((newSession.durationSec||0)%60).padStart(2,'0')}` : '00:00' })
    }

    addOrUpdateSession(newSession)
    selectSession(newSession.id)

    toast.success('Grabación finalizada', {
      description: `${Math.floor(newSession.durationSec / 60)} min guardados. Ahora puedes procesar con IA o guardar el audio.`,
    })

    // Auto open device refresh for next time
    setTimeout(() => refreshDevices(), 800)
  }

  // ===================== AI PROCESSING =====================
  async function processWithAI(session: Session) {
    if (!settings.openaiApiKey) {
      toast.error('Falta la API Key de OpenAI', {
        description: 'Ve a Ajustes y pega tu clave de OpenAI para usar Whisper + GPT.',
      })
      setSettingsOpen(true)
      return
    }

    setProcessing(true, session.id)

    try {
      // We need actual audio. For the MVP we will use a stored lastBlob if the user just recorded.
      // This is the weakest part of current MVP.
      // Strategy: If this is the just-recorded session, we attached a blob to the window.
      // @ts-ignore
      const lastBlob: Blob | undefined = (window as any).__lastRecordingBlob

      if (!lastBlob) {
        toast.error('No hay audio disponible para transcribir', {
          description: 'Graba una reunión nueva o implementaremos carga de archivos en la siguiente iteración.',
        })
        setProcessing(false, null)
        return
      }

      const fileName = session.audioFileName || 'audio.webm'
      const audioFile = new File([lastBlob], fileName, { type: lastBlob.type || 'audio/webm' })

      // === LEARNED CONTEXT INJECTION for full report (self-improvement) ===
      // Retrieve relevant starred past QAs (keyword/recency/star + semantic cosine when Ollama embeddings available).
      // Stronger for final reports: use title + a bit of context, pull up to 4 high-value snippets.
      // Injected as "Estilo y preferencias aprendidas..." into the report prompt (see ai.ts generateStructuredReport).
      let learnedForReport: string[] = []
      let reportUsedMemory = false
      try {
        if ((memoryCount || 0) === 0) {
          await loadMemory()
        }
        const q = `${session.title || 'reunión'} ${session.topic || ''}`.trim() || 'reunión informe resumen'
        const relevant = await retrieveRelevantAsync(q, null, 4, settings)
        if (relevant.length > 0) {
          learnedForReport = entriesToPromptSnippets(relevant)
          reportUsedMemory = true
        }
      } catch (e) {
        console.warn('report memory retrieve skipped', e)
      }

      const { transcript, report } = await generateReport(
        {
          settings,
          audioFile,
          sessionTitle: session.title,
        },
        learnedForReport.length ? learnedForReport : undefined
      )

      // Update session
      const updated: Session = {
        ...session,
        hasTranscript: true,
        hasReport: true,
      }
      updateSession(session.id, updated)

      setCurrentSessionData({ transcript, report, memoryUsedForReport: reportUsedMemory } as any)

      // Index report insights into memory for stronger future self-improvement (in addition to starred liveQAs)
      try {
        const added = await indexReportInsights(session, report, settings)
        if (added > 0) {
          await loadMemory()
          console.log(`[memory] indexed ${added} report-derived entries from ${session.id}`)
        }
      } catch (e) {
        console.warn('indexReportInsights skipped', e)
      }

      // Save files to disk if possible (best effort)
      try {
        await saveSessionToDisk(session, transcript, report, lastBlob)
      } catch (e) {
        console.warn('Could not persist files to disk yet', e)
      }

      toast.success('Informe generado con IA', {
        description: 'Resumen, insights, participantes, to-do list y recomendaciones listos.',
      })
    } catch (err: any) {
      console.error(err)
      toast.error('Error procesando con IA', {
        description: err?.message || 'Revisa tu API key y conexión.',
      })
    } finally {
      setProcessing(false, null)
    }
  }

  // ===================== AUDIO PLAYBACK (wavesurfer for saved sessions + secure disk load) =====================
  function togglePlayback() {
    if (waveSurfer) {
      // Preferred: use wavesurfer for visualization + playback (works for both lastBlob and disk-loaded)
      waveSurfer.playPause()
      return
    }
    // Fallback (should rarely hit now)
    // @ts-ignore
    const lastBlob: Blob | undefined = (window as any).__lastRecordingBlob
    if (lastBlob) {
      if (isPlaying) {
        setIsPlaying(false)
        return
      }
      const url = URL.createObjectURL(lastBlob)
      const audio = new Audio(url)
      audio.play()
      setIsPlaying(true)
      audio.onended = () => {
        setIsPlaying(false)
        URL.revokeObjectURL(url)
      }
      return
    }
    if (!selectedSession) return
    toast.info('No hay audio cargado para esta sesión.')
  }

  // ===================== SAVE / EXPORT =====================
  async function handleSaveCurrentSession() {
    const session = selectedSession
    if (!session) return

    // @ts-ignore
    const blob: Blob | undefined = (window as any).__lastRecordingBlob
    if (!blob) {
      toast('No hay audio en memoria para esta sesión')
      return
    }

    const folderName = createSessionFolderName(session)
    const success = await saveSessionToDisk(session, currentSessionData.transcript, currentSessionData.report, blob, folderName)
    
    if (success) {
      toast.success('Sesión guardada', { description: `Carpeta: ${folderName}` })
      // Update folderPath in store
      updateSession(session.id, { folderPath: success as any })
    }
  }

  async function exportReport(session: Session) {
    // Simple: download a markdown version
    const report = currentSessionData.report
    if (!report) {
      toast('Primero genera el informe con IA')
      return
    }
    const md = `# ${session.title}\n\n**Fecha:** ${format(new Date(session.date), 'PPP p', { locale: es })}\n**Duración:** ${Math.floor(session.durationSec/60)} minutos\n\n## Resumen\n\n${report.summary}\n\n## Insights clave\n\n${report.keyInsights.map(i => `- ${i}`).join('\n')}\n\n## Personas asistentes / que intervinieron\n\n${[...report.attendees, ...report.speakers].map(p => `- ${p}`).join('\n')}\n\n## Recomendaciones\n\n${report.recommendations.map(r => `- ${r}`).join('\n')}\n\n## Consejos\n\n${report.advice.map(a => `- ${a}`).join('\n')}\n\n## To-Do\n\n${report.todoList.map(t => `- [${t.done ? 'x' : ' '}] ${t.task}`).join('\n')}\n`

    const blob = new Blob([md], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${session.title.replace(/\s+/g, '_')}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Secure export helpers (sanitization to strip control chars / null bytes that could affect document parsers or trigger AV heuristics)
  function sanitizeText(text: string | undefined | null): string {
    if (!text) return ''
    // Remove control characters (including null bytes) and cap length for safety
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 50000)
  }
  function safeFileName(name: string): string {
    return sanitizeText(name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'reunia-export'
  }

  // DOCX export using trusted 'docx' lib (structured builder, no template injection risk)
  async function exportDocx(session: Session) {
    const report = currentSessionData.report
    if (!report) {
      toast('Primero genera el informe con IA')
      return
    }
    try {
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx')
      const children: any[] = [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(sanitizeText(session.title))] }),
        new Paragraph({ children: [new TextRun(`Fecha: ${format(new Date(session.date), 'PPP p', { locale: es })} • Duración: ${Math.floor(session.durationSec / 60)} min`)] }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Resumen')] }),
        new Paragraph({ children: [new TextRun(sanitizeText(report.summary))] }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Insights clave')] }),
        ...report.keyInsights.map((i: string) => new Paragraph({ children: [new TextRun('• ' + sanitizeText(i))] })),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Personas asistentes')] }),
        ... (report.attendees.length ? report.attendees.map((p: string) => new Paragraph({ children: [new TextRun('• ' + sanitizeText(p))]})) : [new Paragraph({ children: [new TextRun('_No detectadas_') ] })] ),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Recomendaciones')] }),
        ...report.recommendations.map((r: string) => new Paragraph({ children: [new TextRun('• ' + sanitizeText(r))] })),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Consejos')] }),
        ...report.advice.map((a: string) => new Paragraph({ children: [new TextRun('• ' + sanitizeText(a))] })),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('To-Do')] }),
        ...report.todoList.map((t: any) => new Paragraph({ children: [new TextRun(`[${t.done ? 'x' : ' '}] ${sanitizeText(t.task)}`)] })),
      ]
      const doc = new Document({ sections: [{ children }] })
      const blob = await Packer.toBlob(doc)
      fileSaver.saveAs(blob, `${safeFileName(session.title)}.docx`)
      toast.success('DOCX exportado de forma segura')
    } catch (e) {
      console.error(e)
      toast.error('Error generando DOCX (¿instalaste las dependencias?)')
    }
  }

  // PDF export using jspdf (light, safe text addition, no code exec)
  async function exportPdf(session: Session) {
    const report = currentSessionData.report
    if (!report) {
      toast('Primero genera el informe con IA')
      return
    }
    try {
      const jsPDF = (await import('jspdf')).default
      const doc = new jsPDF()
      let y = 20
      const addText = (text: string, size = 12) => {
        doc.setFontSize(size)
        const lines = doc.splitTextToSize(sanitizeText(text), 180)
        lines.forEach((line: string) => {
          if (y > 280) { doc.addPage(); y = 20 }
          doc.text(line, 10, y)
          y += size * 0.5 + 2
        })
        y += 4
      }
      addText(session.title, 18)
      addText(`Fecha: ${format(new Date(session.date), 'PPP p', { locale: es })} • ${Math.floor(session.durationSec/60)} min`, 10)
      addText('Resumen', 14); addText(report.summary)
      addText('Insights clave', 14); report.keyInsights.forEach((i: string) => addText('• ' + i, 11))
      addText('Recomendaciones', 14); report.recommendations.forEach((r: string) => addText('• ' + r, 11))
      addText('Consejos', 14); report.advice.forEach((a: string) => addText('• ' + a, 11))
      addText('To-Do', 14); report.todoList.forEach((t: any) => addText(`[${t.done?'x':' '}] ${t.task}`, 11))
      doc.save(`${safeFileName(session.title)}.pdf`)
      toast.success('PDF exportado de forma segura')
    } catch (e) {
      console.error(e)
      toast.error('Error generando PDF (¿npm install jspdf docx?)')
    }
  }

  // Test Ollama connection (for option 3 - local mode)
  async function testOllama() {
    setOllamaTestStatus({ loading: true, message: '' })
    try {
      const base = (settings.ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '')
      const res = await fetch(`${base}/api/tags`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const models = (data.models || []).map((m: any) => m.name).slice(0, 5).join(', ')
      const msg = models ? `Conectado. Modelos: ${models}` : 'Conectado a Ollama (sin modelos listados)'
      setOllamaTestStatus({ loading: false, message: msg })
      toast.success('Ollama conectado', { description: msg })
    } catch (err: any) {
      const msg = `No se pudo conectar a ${settings.ollamaBaseUrl}. ¿Ollama está corriendo? (ollama serve)`
      setOllamaTestStatus({ loading: false, message: msg })
      toast.error('Ollama no responde', { description: msg })
    }
  }

  async function testTranscriptionEndpoint() {
    if (settings.transcriptionMode !== 'local') return
    const base = (settings.transcriptionEndpoint || '').replace(/\/$/, '')
    try {
      // Just check if the /models or root responds (many compatible servers have /v1/models or similar)
      const res = await fetch(`${base}/models`, { method: 'GET' }).catch(() => null)
      if (res && res.ok) {
        toast.success('Endpoint de transcripción responde')
      } else {
        toast.info('Endpoint configurado. Prueba generando un informe para validar.')
      }
    } catch {
      toast.info('No se pudo verificar el endpoint automáticamente. Úsalo al procesar.')
    }
  }

  // Secure update handlers (all logic and verification happens in main process via electron-updater)
  // This is important for security: renderer cannot directly download or install unsigned/unverified updates.
  async function handleCheckForUpdates() {
    const api = (window as any).electron
    if (!api?.checkForUpdates) return
    setUpdateStatus({ type: 'checking' })
    try {
      await api.checkForUpdates()
    } catch (e: any) {
      setUpdateStatus({ type: 'error', message: e?.message || 'Error' })
    }
  }

  async function handleDownloadUpdate() {
    const api = (window as any).electron
    if (api?.downloadUpdate) {
      await api.downloadUpdate()
    }
  }

  function handleInstallUpdate() {
    const api = (window as any).electron
    if (api?.quitAndInstallUpdate) {
      api.quitAndInstallUpdate()
    }
  }

  // ===================== MEMORY BROWSER HELPERS (profundizar memoria) =====================
  async function handleClearAllMemory() {
    if (!confirm('¿Borrar TODA la memoria de auto-mejora? Esto elimina los extractos marcados para RAG en futuras reuniones. No se puede deshacer.')) return
    await clearMemory()  // store action: clears + sets count=0 reactively
    setShowMemoryBrowser(false)
    setMemorySearch('')
    toast.success('Memoria borrada', { description: 'La auto-mejora empezará de cero en la próxima grabación.' })
  }

  async function handleDeleteMemoryEntry(id: string) {
    const all = getCachedMemory()
    const next = all.filter((e) => e.id !== id)
    try {
      // Persist directly (main will merge/save); then sync count
      const api = (window as any).electron
      if (api?.saveMemory) {
        await api.saveMemory(next)
      } else {
        // fallback path inside memory layer
        await (await import('./lib/memory')).saveMemoryIndex(next)
      }
      await loadMemory()
      toast('Entrada eliminada de memoria')
    } catch (e) {
      console.warn('delete memory entry failed', e)
      toast.error('No se pudo eliminar')
    }
  }

  function getFilteredMemoryEntries() {
    let list = getCachedMemory()
    if (memorySearch.trim()) {
      const s = memorySearch.trim().toLowerCase()
      list = list.filter((e) => e.text.toLowerCase().includes(s) || (e.tags || []).some((t) => t.toLowerCase().includes(s)))
    }
    if (memoryFilter === 'starred') {
      list = list.filter((e) => e.starred)
    }
    return list
  }

  // Live question during recording (the new feature)
  // Accepts optional overrideQ to avoid stale closure on async voice final path (high-reliability for auto-submit)
  async function handleAskLive(overrideQ?: string) {
    const q = (overrideQ || liveQuestion).trim()
    if (!q || recording.isTranscribingRecent || recording.isThinkingLLM) return
    // If voice was active, cleanly stop it before submit (delegates to hook)
    if (isVoiceListening) stopVoiceListening(true)
    setLiveQuestion('')
    // voiceInterim cleared by stopVoiceListening / hook
    await askLiveQuestion(q)
  }

  // (Voice logic is now in reusable useVoiceInput hook + toggleVoiceInput wrapper above.
  // All behaviors preserved: es-ES, interim live preview in input, auto-final + auto-submit, silence 2.2s + safety, errors toasts, Esc, etc.
  // Old refs/states removed to avoid dupe; hook owns the recognition lifecycle.)

  // ===================== COMPACT / STEALTH HELPERS =====================
  // Copy last live insight/summary (high-impact for meetings: grab the answer without selecting text)
  // Optional flashSetter: when provided (pill / stealth contexts), shows inline flash instead of (or in addition to) global toast for lower distraction.
  function copyLastSummary(flashSetter?: (msg: string | null) => void) {
    const lastQA = recording.liveQA.length > 0 ? recording.liveQA[recording.liveQA.length - 1] : null
    const text = lastQA ? lastQA.answer : (recording.liveTranscript || '').slice(-400)
    if (!text?.trim()) return
    navigator.clipboard.writeText(text.trim()).then(() => {
      if (flashSetter) {
        flashSetter('copiado')
      } else {
        toast.success('Copiado', { description: 'Última respuesta o contexto copiado al portapapeles' })
      }
    }).catch(() => {
      // silent fallback
    })
  }

  // Cycle modes directly from pill/stealth (high-impact: change distraction level with one click while minimized, no need to expand or remember kb).
  // Re-uses same logic as Cmd/Ctrl+M for consistency. Auto-adjusts chrome (panel/hidden) for the target mode.
  function cycleRecordingMode() {
    const modes: RecordingMode[] = ['normal', 'compact', 'stealth']
    const idx = modes.indexOf(recordingMode)
    const next = modes[(idx + 1) % modes.length]
    if (isVoiceListening) stopVoiceListening(true) // deliberate mode change while listening: stop to avoid "invisible" state in stealth/hidden
    setAndPersistRecordingMode(next)
    if (recording.isRecording) {
      if (next === 'stealth') {
        setAssistantHidden(true)
        setLivePanelExpanded(false)
      } else if (next === 'compact') {
        setAssistantHidden(false)
        setLivePanelExpanded(false)
      } else {
        setAssistantHidden(false)
        setLivePanelExpanded(true)
      }
    } else {
      // Low-distraction confirmation for pre-record use (user sees their choice "sticks" for the big record button / global hotkey).
      // Uses sonner (already in app); non-modal, auto-dismisses, perfect during prep for Meet/Zoom.
      const label = next === 'stealth' ? 'Stealth (colores suaves + oculto)' : next === 'compact' ? 'Compacto / Focus (barra pill + rail colapsado)' : 'Normal (panel completo)'
      toast.success(`Modo ${next}`, { description: `${label} • se usará al empezar a grabar (Shift+M global también funciona)` })
    }
  }

  // High-impact autonomous enhancement for during-meeting focus control (hands-busy / trackpad imprecise):
  // Cycle context focus (Todo -> Decisiones -> Acciones -> Riesgos -> Presupuesto -> Personas) with keyboard.
  // Works from pill/stealth/rail even when panel collapsed; updates instantly (affects next live Qs + memory retrieve + chips).
  // Guarded vs typing inputs. Complements mouse chips + rail. Cmd/Ctrl+F (F=Focus) or Cmd/Ctrl+[ / ] for prev/next.
  function cycleFocus(direction: 1 | -1 = 1) {
    const keys: Array<string | null> = [null, 'decisions', 'actions', 'risks', 'budget', 'people']
    const idx = keys.indexOf(currentFocus)
    const nextIdx = (idx + direction + keys.length) % keys.length
    const next = keys[nextIdx]
    setRecordingState({ contextFocus: next })
    // Optional: subtle non-intrusive confirmation only in minimal modes (no toast noise)
    if (recording.isRecording && (recordingMode !== 'normal' || !livePanelExpanded)) {
      // pill or stealth will reflect via re-render of chips; keep zero extra UI
    }
  }

  // Centralized setter used by pre-record selector + in-panel + rail: updates zustand + persists to main process immediately.
  // This guarantees tray, global Shift+M, and background record starts all see the user's latest choice.
  // Now also notifies via the mode-changed channel (minimal IPC addition) so main's 'recording:mode-changed' listener keeps tray in perfect sync (belt-and-suspenders with setPreferred path).
  function setAndPersistRecordingMode(mode: RecordingMode) {
    setRecordingMode(mode)
    const api = (window as any).electron
    api?.setPreferredRecordingMode?.(mode)
    api?.notifyRecordingModeChanged?.(mode)
  }

  // ===================== RENDER =====================
  // Early return for companion window: ultra-minimal, narrow, always-on-top friendly live UI.
  // Receives state via IPC 'live:update', sends asks via IPC (primary does the heavy lifting + all preserved features).
  // No sidebar, no full history, no library, tiny footprint perfect for PiP during Google Meet/Zoom screen share.
  if (isCompanion) {
    return <CompanionLiveUI
      // pass through what the synced listener will populate; component manages its local mirror
      onAsk={(q, f) => { const api=(window as any).electron; if (f!==undefined) api?.sendCompanionFocus?.(f); api?.sendCompanionAsk?.(q, f) }}
      onClose={() => (window as any).electron?.closeCompanion?.() }
    />
  }

  return (
    <div className="flex h-screen flex-col bg-bg text-text-primary overflow-hidden">
      <Toaster position="top-center" richColors closeButton />

      {/* Top bar */}
      <div className="h-14 border-b border-white/10 bg-bg-secondary/80 backdrop-blur flex items-center justify-between px-4 drag">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <img 
              src="/reunia-logo.png" 
              alt="ReunIA" 
              className="w-8 h-8 rounded-xl object-contain ring-1 ring-white/10" 
              onError={(e) => { (e.target as HTMLImageElement).src = '/reunia-logo.svg'; }}
            />
            <div>
              <div className="font-semibold tracking-tight text-lg leading-none">ReunIA</div>
              <div className="text-[10px] text-text-muted -mt-0.5">Reuniones con inteligencia</div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Global Record / Stop button - always prominent */}
          {!recording.isRecording ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleStartRecording}
                className="btn btn-primary px-5 py-1.5 text-sm flex items-center gap-2 shadow-xl"
              >
                <Mic className="w-4 h-4" /> Grabar ahora
              </button>
              {/* Pre-rec mode preference indicator + cycle (high-impact: sets the auto-start compact/stealth/normal without needing to remember Cmd+M first time.
                  Persisted + synced to tray/global Shift+M. Click to cycle before record — next start (any entry point: UI, tray, global hotkey, even during screen share) uses it with sensible panel/hidden/pill defaults.
                  This *is* the "toggle or auto compact on record start". Visual: colored per mode for instant glance (violet=stealth low alarm, rose=compact focused, default=full). */}
              <button
                onClick={cycleRecordingMode}
                className={`text-[10px] pl-2 pr-2.5 py-1 rounded-full border flex items-center gap-1.5 tabular-nums transition active:scale-[0.985] ${
                  recordingMode === 'stealth'
                    ? 'border-violet-500/40 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 hover:text-violet-200'
                    : recordingMode === 'compact'
                      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 hover:text-rose-200'
                      : 'border-white/15 text-text-muted hover:text-text-primary hover:bg-white/5'
                }`}
                title={`Modo de inicio preferido: ${recordingMode.toUpperCase()} (compact=focus mode) — clic o Cmd/Ctrl+M (global incluso en Meet/Zoom) o Shift+M para ciclar. Se aplica automáticamente al pulsar Grabar (UI/tray/atajo/global).`}
              >
                <span className="opacity-70">inicio</span>
                <span className="font-medium tracking-[0.5px]">
                  {recordingMode === 'stealth' ? 'STEALTH' : recordingMode === 'compact' ? 'COMPACTO (FOCUS)' : 'NORMAL'}
                </span>
                <span className="text-[8px] opacity-50">↻</span>
              </button>
            </div>
          ) : (
            <button
              onClick={handleStopRecording}
              className="btn btn-danger px-5 py-1.5 text-sm flex items-center gap-2 animate-pulse"
            >
              <Square className="w-4 h-4" /> DETENER — {recording.elapsed}
            </button>
          )}

          <button onClick={() => setSettingsOpen(true)} className="btn btn-ghost px-3 flex items-center gap-2">
            <Settings className="w-4 h-4" />
            <span className="text-xs text-text-muted hidden sm:inline">
              {settings.aiProvider === 'ollama' ? 'Ollama' : 'OpenAI'}
            </span>
          </button>
        </div>
      </div>

      {/* Recording banner - adapts to recordingMode for low-alarm meeting use (stealth uses softer violet, compact softer rose) */}
      <AnimatePresence>
        {recording.isRecording && !isCompanion && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }} 
            animate={{ height: recordingMode === 'stealth' ? 28 : 38, opacity: 1 }}
            exit={{ height: 0 }}
            className={`text-white text-xs flex items-center justify-between px-4 font-medium transition-colors ${
              recordingMode === 'stealth'
                ? 'bg-violet-600/75 border-b border-violet-500/30'
                : recordingMode === 'compact'
                  ? 'bg-rose-500/85'
                  : 'bg-red-600/95'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className={recordingMode === 'stealth' ? 'text-sm' : 'text-base'}>{recordingMode === 'stealth' ? '●' : '🔴'}</span>
                <span className="font-semibold tracking-wide">{recordingMode === 'stealth' ? 'Grabando' : 'GRABANDO'}</span>
                <span className="font-mono tabular-nums">{recording.elapsed}</span>
                {recordingMode !== 'normal' && (
                  <span className="ml-1 text-[10px] px-1.5 py-px rounded bg-white/15">{recordingMode}</span>
                )}
                {/* Always-visible (in banner chrome) voice state indicator. Critical for hands-busy: even in stealth/collapsed pill, user sees at a glance "Escuchando" + pulsing affordance.
                    Low-distraction, adapts to mode tint, uses same waveform primitives. Clickable to stop (extra large target). */}
                {isVoiceListening && (
                  <button
                    onClick={() => stopVoiceListening()}
                    className="banner-voice-indicator ml-1 flex items-center gap-1 text-[10px] px-1.5 py-px rounded bg-red-500/20 border border-red-500/30 text-red-300 hover:bg-red-500/30 active:scale-[0.985] transition"
                    title="Detener escucha de voz (o pulsa Esc / Cmd+Shift+V)"
                    aria-label="Detener voz desde banner"
                  >
                    <VoiceWave level={voiceLevel} mini={true} />
                    <span className="font-medium">escuchando{currentFocus ? ` (${currentFocusLabel.split(' ')[0]})` : ''}</span>
                    {!voiceInterim && <span className="opacity-70 text-[8px] ml-0.5">pausa envía</span>}
                    {voiceSentFlash && <span className="text-[8px] ml-0.5 text-emerald-300">{voiceSentFlash}</span>}
                  </button>
                )}
              </div>
              {recordingMode === 'normal' && (
                <div className="text-xs opacity-80 hidden md:block">• Pregunta a la IA qué se ha dicho en los últimos minutos</div>
              )}
            </div>
            <div className="flex items-center gap-2 text-[10px] opacity-75">
              {/* Always-visible mode cycle from banner (high-impact: change distraction level instantly from the always-on recording strip, no need to hunt pill/rail) */}
              <button
                onClick={cycleRecordingMode}
                className="px-1.5 py-px rounded bg-white/10 hover:bg-white/20 border border-white/10 text-[9px] flex items-center gap-1"
                title="Ciclar modo grabación (normal/compact(focus)/stealth) — Cmd/Ctrl+M (global) o Shift+M también"
              >
                {recordingMode[0].toUpperCase()}
              </button>
              {recordingMode !== 'normal' && <span className="hidden sm:inline">M: ciclo • J: panel • pill: clic ●</span>}
              {/* Always-visible low-profile restore + PiP affordances in banner (even when assistantHidden or stealth sidebar gone).
                  Provides mouse-accessible "small restore" without forcing full UI or remembering only keys. */}
              {recording.isRecording && recordingMode !== 'normal' && assistantHidden && (
                <button
                  onClick={() => { setAssistantHidden(false); setLivePanelExpanded(recordingMode !== 'stealth') }}
                  className="px-1.5 py-px rounded bg-white/10 hover:bg-white/20 border border-white/10 text-[9px]"
                  title="Mostrar panel del asistente (o pulsa J)"
                >
                  mostrar
                </button>
              )}
              {recording.isRecording && (
                <button
                  onClick={() => {
                    const api = (window as any).electron
                    api?.openCompanion?.()
                    if (recording.isRecording) {
                      setAssistantHidden(true)
                      api?.minimizeMain?.() // one-click: companion PiP becomes the low-profile always-on-top surface; main minimized (restore via tray/global hotkey)
                    }
                  }}
                  className="px-1 py-px rounded bg-white/10 hover:bg-accent/30 border border-white/10 text-[9px]"
                  title="Abrir PiP compañero always-on-top (ideal para compartir pantalla). Minimiza principal automáticamente."
                >
                  PiP
                </button>
              )}
              {/* High-impact autonomous UX: always-visible "hide pill / low profile" from banner strip (for compact/stealth). 
                  One-click from the persistent recording banner (no hunting the small X in pill). Perfect for screen-share hands-busy: instant ultra-minimal while keeping tray/globals/stop active. */}
              {recording.isRecording && recordingMode !== 'normal' && !assistantHidden && (
                <button
                  onClick={() => { if (isVoiceListening) stopVoiceListening(true); setAssistantHidden(true) }}
                  className="px-1.5 py-px rounded bg-white/10 hover:bg-white/20 border border-white/10 text-[9px]"
                  title="Ocultar barra pill / asistente (modo ultra-bajo perfil). Restaurar con J, banner 'mostrar', o atajos. Tray y globales siguen activos."
                >
                  ocultar
                </button>
              )}
              <span>Cmd/Ctrl+Shift+R</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - Library: collapses to thin icon rail in compact, completely hidden in stealth (for focus during meetings) */}
        {!(recording.isRecording && recordingMode === 'stealth') && (
          <div className={`border-r border-white/10 flex flex-col bg-bg-secondary/50 transition-all duration-200 overflow-hidden ${
            recording.isRecording && (recordingMode === 'compact' || recordingMode === 'stealth')
              ? 'w-14'   // thin icon rail
              : 'w-72'
          }`}>
            {/* Full library header + search */}
            {!(recording.isRecording && (recordingMode === 'compact' || recordingMode === 'stealth')) && (
              <>
                <div className="p-4 border-b border-white/10">
                  <div className="flex items-center justify-between mb-3">
                    <div className="section-title">Biblioteca</div>
                    <button onClick={() => loadSessions()} className="btn btn-ghost p-1.5"><RefreshCw className="w-3.5 h-3.5" /></button>
                  </div>
                  <input
                    type="text"
                    placeholder="Buscar reuniones..."
                    className="input text-sm py-1.5"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>

                <div className="flex-1 overflow-auto p-2 space-y-1">
                  {filteredSessions.length === 0 && (
                    <div className="px-4 py-8 text-center text-text-muted text-sm">
                      Aún no hay grabaciones.<br />Pulsa "Grabar ahora".
                    </div>
                  )}
                  {filteredSessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => selectSession(s.id)}
                      className={`w-full text-left p-3 rounded-xl transition flex flex-col gap-0.5 ${selectedSessionId === s.id ? 'bg-accent/10 border border-accent/30' : 'hover:bg-white/5 border border-transparent'}`}
                    >
                      <div className="font-medium text-sm line-clamp-1">{s.title}</div>
                      <div className="flex items-center gap-2 text-xs text-text-muted">
                        <span>{format(new Date(s.date), 'dd MMM', { locale: es })}</span>
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {Math.floor(s.durationSec / 60)} min</span>
                        {s.hasReport && <span className="tag text-[10px] py-0">IA</span>}
                      </div>
                    </button>
                  ))}
                </div>

                <div className="p-3 border-t border-white/10 text-xs text-text-muted">
                  {sessions.length} reuniones • {settings.storagePath ? 'Almacenamiento configurado' : 'Usando almacenamiento local'}
                  {memoryCount > 0 && (
                    <div className="mt-1 text-[10px] text-accent/80">Memoria: {memoryCount} extractos de reuniones pasadas (auto-mejora)</div>
                  )}
                </div>
              </>
            )}

            {/* Thin icon rail for compact/stealth (minimal distraction, still allows quick library access if needed) */}
            {(recording.isRecording && (recordingMode === 'compact' || recordingMode === 'stealth')) && (
              <div className="flex flex-col items-center py-3 gap-2 text-text-muted text-center">
                {/* Glanceable status in rail (high-impact for when pill is temporarily hidden or stealth ultra-low): timer + mode badge always visible in sidebar area */}
                <div className="font-mono tabular-nums text-[10px] text-text-primary/80 tracking-tighter" title="Tiempo transcurrido">
                  {recording.elapsed}
                </div>
                <button
                  onClick={() => setAndPersistRecordingMode('normal')}
                  className="p-2 rounded-lg hover:bg-white/10 hover:text-text-primary transition"
                  title="Expandir biblioteca (volver a normal)"
                >
                  <FolderOpen className="w-4 h-4" />
                </button>
                <div className="h-px w-6 bg-white/10" />
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="p-2 rounded-lg hover:bg-white/10 hover:text-text-primary transition"
                  title="Ajustes"
                >
                  <Settings className="w-4 h-4" />
                </button>
                {/* Quick pill reveal from rail (low friction return to compact controls) */}
                <button
                  onClick={() => { setLivePanelExpanded(false); setAssistantHidden(false) }}
                  className="p-2 rounded-lg hover:bg-white/10 hover:text-text-primary transition"
                  title="Mostrar barra pill (timer + foco + voz)"
                >
                  <Target className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { setLivePanelExpanded(true); setAssistantHidden(false) }}
                  className="p-2 rounded-lg hover:bg-white/10 hover:text-text-primary transition mt-auto"
                  title="Mostrar asistente completo"
                >
                  <MessageSquare className="w-4 h-4" />
                </button>
                {/* Current focus + mode in rail — clickable to cycle focus or mode (meeting-powerful, zero-distraction) */}
                {currentFocus && (
                  <div onClick={() => setRecordingState({ contextFocus: null })} className="text-[8px] px-1 py-px rounded bg-accent/10 text-accent border border-accent/20 cursor-pointer" title="Quitar foco actual (clic)">
                    {currentFocusLabel.split(' ')[0].slice(0,4)}
                  </div>
                )}
                {/* High-impact autonomous: quick focus cycle buttons directly in thin rail (no need to open pill or remember F). Abbrev for space; works in compact/stealth rail. */}
                <div className="flex flex-col gap-0.5 mt-1">
                  {[null, 'decisions', 'actions'].map((k, i) => {
                    const lab = k ? (k==='decisions'?'D':k==='actions'?'A':'?') : 'T'
                    const act = (k===null && !currentFocus) || k===currentFocus
                    return (
                      <button key={i} onClick={() => { stopVoiceListening(true); setRecordingState({ contextFocus: k }) }} className={`text-[7px] px-0.5 py-px leading-none rounded border ${act ? 'bg-accent/20 border-accent text-accent' : 'border-white/10 text-text-muted/70 hover:text-text-primary hover:border-white/30'}`} title={k ? (k[0].toUpperCase()+k.slice(1)) : 'Todo (sin foco)'}>
                        {lab}
                      </button>
                    )
                  })}
                </div>
                <button
                  onClick={cycleRecordingMode}
                  className="mt-auto text-[9px] text-center leading-none opacity-60 hover:opacity-100 px-1 py-0.5 rounded hover:bg-white/10 font-mono"
                  title={`Modo ${recordingMode} (compact=focus) — clic para ciclar (o Cmd/Ctrl+M global / Shift+M)`}
                >
                  {recordingMode[0].toUpperCase()}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Main content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* ========== LIVE RECORDING ASSISTANT (full original preserved; compact adds pill + hides sidebar) ========== */}
          {/* Show the rich original panel only when normal or explicitly expanded. In compact/stealth the sidebar is collapsed and we render a small pill bar below this (or instead via expand state). */}
          {(recordingMode === 'normal' || livePanelExpanded) && recording.isRecording && !isCompanion && !assistantHidden && (
            <div className="border-b border-white/10 bg-bg-secondary/80 backdrop-blur p-3">
              <div className="max-w-4xl mx-auto">
                <div className="flex items-center justify-between mb-2 px-1">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">🎙️</span>
                    <div>
                      <span className="font-semibold">Asistente en vivo</span>
                      <span className={`ml-2 text-xs px-2 py-0.5 rounded-full border ${recordingMode === 'stealth' ? 'bg-violet-500/15 text-violet-400 border-violet-500/20' : 'bg-red-500/15 text-red-400 border-red-500/20'}`}>EN TIEMPO REAL</span>
                      {speechSupported && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-px rounded-full bg-white/5 text-text-muted border border-white/10" title="Entrada por voz disponible (Web Speech). Atajo local/global: Cmd/Ctrl+Shift+V (funciona desde cualquier ventana)">
                          🎤 voz
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-muted">• usando {settings.aiProvider === 'ollama' ? 'Ollama local' : 'OpenAI'}</div>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-text-muted tabular-nums">
                    Contexto: ~{Math.floor((recording.recentAudioChunks?.length || 0) / 60)} min
                    {/* Mode switcher (high-impact addition) + collapse + PiP */}
                    <div className="flex items-center gap-0.5 ml-2 text-[10px] border border-white/10 rounded-full p-0.5 bg-bg/60">
                      {(['normal','compact','stealth'] as RecordingMode[]).map(m => (
                        <button key={m} onClick={() => { if (isVoiceListening) stopVoiceListening(true); setAndPersistRecordingMode(m); setLivePanelExpanded(m === 'normal'); if (m==='stealth') setAssistantHidden(true) }} className={`px-2 py-0.5 rounded-full transition ${recordingMode === m ? 'bg-accent text-white' : 'hover:bg-white/10'}`}>{m}</button>
                      ))}
                    </div>
                    {recordingMode !== 'normal' && (
                      <button onClick={() => { if (isVoiceListening) stopVoiceListening(true); setLivePanelExpanded(false) }} className="ml-1 text-[10px] px-1.5 py-px hover:bg-white/10 rounded border border-white/10" title="Minimizar a barra (Cmd/Ctrl + J)">−</button>
                    )}
                    <button onClick={() => {
                      const api = (window as any).electron
                      api?.openCompanion?.()
                      if (recording.isRecording) {
                        setAssistantHidden(true)
                        api?.minimizeMain?.()
                      }
                    }} className="text-[10px] px-1.5 py-px bg-white/5 hover:bg-accent/20 rounded border border-white/10" title="Abrir ventana compañera always-on-top (PiP para reuniones). Minimiza principal para foco + no capturar en pantalla compartida.">PiP</button>
                  </div>
                </div>

                <div className="card p-3.5">
                  {/* Context Summary Strip (proactive value) + Focus indicator */}
                  {recording.liveTranscript && (
                    <div className="mb-3 px-1 py-1.5 bg-bg/60 rounded-xl text-xs text-text-secondary border border-white/5 flex items-center gap-2">
                      <span className="font-medium text-accent-light mr-1">Resumen reciente:</span>
                      <span className="flex-1 truncate">{recording.liveTranscript.slice(-380)}</span>
                      {currentFocus && (
                        <span className="ml-auto shrink-0 text-[10px] px-1.5 py-px rounded bg-accent/15 text-accent border border-accent/30">
                          enfoque: {currentFocusLabel}
                        </span>
                      )}
                    </div>
                  )}

                  {/* ========== SMART CONTEXT FOCUS FILTER (the core high-value feature) ========== */}
                  {/* Instant-apply premium chips. Sets contextFocus → influences prompt sent to LLM for live Qs */}
                  {/* Dynamic, visual feedback, non-intrusive during meeting */}
                  <div className="mb-2.5">
                    <div className="flex items-center gap-1.5 text-[10px] text-text-muted mb-1 px-0.5">
                      <Filter className="w-3 h-3" />
                      <span className="font-medium tracking-wide">ENFOQUE DE CONTEXTO</span>
                      <span className="text-[9px] opacity-60">(filtra lo que ve la IA en las próximas preguntas)</span>
                      {currentFocus && (
                        <button
                          onClick={() => setRecordingState({ contextFocus: null })}
                          className="ml-1 inline-flex items-center gap-0.5 text-accent hover:text-accent-light"
                          title="Quitar enfoque (volver a contexto completo)"
                        >
                          <X className="w-3 h-3" /> <span className="text-[9px]">limpiar</span>
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {FOCUS_OPTIONS.map((opt) => {
                        const isActive = (opt.key === null && !currentFocus) || opt.key === currentFocus
                        return (
                          <button
                            key={opt.key ?? 'all'}
                            onClick={() => {
                              stopVoiceListening(true)
                              setRecordingState({ contextFocus: opt.key })
                            }}
                            className={`text-[11px] px-2.5 py-1 rounded-full flex items-center gap-1 border transition-all active:scale-[0.985] ${
                              isActive
                                ? 'bg-accent/15 border-accent text-accent shadow-sm'
                                : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20 text-text-secondary'
                            }`}
                          >
                            {opt.icon}
                            <span>{opt.label}</span>
                            {isActive && opt.key && <span className="text-[9px] opacity-70">• activo</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Dynamic Smart Suggestion Chips (evolve with focus for brilliant UX) */}
                  {/* Dimmed during voice listening for lower cognitive load (hands-busy speak flow); clicks still interrupt+submit as before. */}
                  <div className={`flex flex-wrap gap-1.5 mb-2.5 ${isVoiceListening ? 'suggestions-voice-dim' : ''}`}>
                    {dynamicSuggestions.map((suggestion, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          stopVoiceListening(true)
                          setLiveQuestion(suggestion)
                          // auto-submit after short delay for natural feel (pass to avoid stale)
                          setTimeout(() => handleAskLive(suggestion), 80)
                        }}
                        className="text-xs px-3 py-1 rounded-full bg-white/5 hover:bg-accent/10 border border-white/10 hover:border-accent/30 transition-colors"
                        disabled={recording.isTranscribingRecent || recording.isThinkingLLM}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>

                  {/* Ask input + prominent voice mic (the voice-first upgrade for hands-busy meetings) */}
                  {/* One-tap mic (or Cmd/Ctrl+Shift+V): speak naturally in Spanish ("ReunIA, ¿qué decidimos del presupuesto?"), interim live preview (also in input), auto-submit on final *or* after short silence pause (brilliant hands-free), or edit+confirm via visible input before send. */}
                  {/* Fully respects current contextFocus (voice questions use same focus-injected prompt path + memory injection + phased loading + stars). Esc to cancel. */}
                  {/* Works with OpenAI + Ollama unchanged. Toggleable in Ajustes. Graceful no-support + disabled-during-load. Permission re-request on retry taps. */}
                  {isVoiceListening && (voiceInterim || true) && (
                    <div className="voice-status" role="status" aria-live="polite">
                      <VoiceWave level={voiceLevel} mini={false} />
                      <span className="font-medium">Escuchando…{currentFocus ? ` (${currentFocusLabel.split(' ')[0]})` : ''}</span>
                      {!voiceInterim && <span className="text-[9px] opacity-60 ml-1">— pausa ~2s envía</span>}
                      {voiceInterim && <span className="voice-interim">«{voiceInterim}»</span>}
                      {voiceSentFlash && <span className="text-[9px] px-1.5 py-px ml-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">{voiceSentFlash}</span>}
                      {/* High-impact: explicit confirm button fulfills "or allow user to confirm" while default remains brilliant auto-on-final/silence.
                          One extra tap for control freaks or noisy meetings; non-intrusive, only appears in listening state. */}
                      {voiceInterim && (
                        <button
                          onClick={() => {
                            const toSend = voiceInterim.trim()
                            stopVoiceListening(true)
                            if (toSend) {
                              handleAskLive(toSend)
                              setVoiceSentFlash('✓ enviado')
                            }
                          }}
                          className="ml-2 text-[10px] px-2.5 py-0.5 min-h-[26px] rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 text-emerald-300 active:scale-[0.985] transition flex items-center gap-1"
                          aria-label="Enviar lo escuchado ahora mismo"
                          title="Enviar esta transcripción de voz inmediatamente (sin esperar silencio o final)"
                        >
                          <span>➤</span> Enviar ahora
                        </button>
                      )}
                      <button
                        onClick={() => stopVoiceListening()}
                        className="ml-auto text-[10px] px-2.5 py-0.5 min-h-[26px] rounded bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 flex items-center gap-1"
                        aria-label="Detener escucha de voz"
                        title="Detener voz (o pulsa Esc)"
                      >
                        <X className="w-3.5 h-3.5" /> Detener
                      </button>
                    </div>
                  )}

                  <div className="flex gap-2 items-center">
                    {/* Prominent easy-to-tap mic button — now using reusable component for consistency across normal/compact/companion */}
                    {speechSupported ? (
                      <VoiceMicButton
                        isListening={isVoiceListening}
                        onClick={toggleVoiceInput}
                        disabled={recording.isTranscribingRecent || recording.isThinkingLLM}
                        size="normal"
                        level={voiceLevel}
                        disabledTitle={recording.isTranscribingRecent || recording.isThinkingLLM ? 'Voz pausada: esperando respuesta de la IA (phased loading)' : undefined}
                      />
                    ) : voiceEnabled ? (
                      // Browser/env does not support Web Speech (or running outside Chromium/Electron renderer) — show disabled affordance
                      // Clickable for helpful feedback (high-impact for confused users during meetings).
                      <button
                        type="button"
                        onClick={() => toast.info('Entrada por voz no disponible', { description: 'Web Speech API (SpeechRecognition) requiere Chromium/Electron. Funciona nativo en la app de escritorio.' })}
                        className="voice-mic shrink-0 opacity-40 cursor-not-allowed hover:opacity-60 active:scale-[0.96] transition"
                        title="Entrada por voz no disponible (SpeechRecognition no soportado en este entorno / navegador). Toca para más info."
                        aria-label="Entrada por voz no soportada"
                      >
                        <Mic className="w-4 h-4" />
                      </button>
                    ) : (
                      // Explicitly disabled via Ajustes — no mic UI at all (keeps UI clean for users who don't want voice)
                      // But provide a tiny tappable hint in case they want to re-enable quickly (opens settings conceptually).
                      <button
                        type="button"
                        onClick={() => {
                          toast('Entrada por voz desactivada en Ajustes', {
                            description: 'Actívala en el panel de configuración para usar el micrófono o Cmd/Ctrl+Shift+V.',
                          })
                        }}
                        className="voice-mic shrink-0 opacity-30 cursor-help hover:opacity-50 active:scale-[0.96] transition"
                        title="Entrada por voz desactivada (ver Ajustes). Toca para recordatorio."
                        aria-label="Entrada por voz desactivada en ajustes"
                      >
                        <MicOff className="w-4 h-4" />
                      </button>
                    )}

                    <input
                      ref={liveInputRef}
                      className={`input flex-1 text-sm py-2.5 ${isVoiceListening ? 'voice-input-active ring-1 ring-red-400/50 border-red-400/40' : ''}`}
                      placeholder={
                        currentFocus
                          ? `Pregunta enfocada en ${currentFocusLabel.toLowerCase()}... (o usa el micrófono)`
                          : "Pregunta sobre lo último (ej: presupuesto, decisiones...) o pulsa 🎤 y habla"
                      }
                      value={liveQuestion}
                      onChange={(e) => {
                        setLiveQuestion(e.target.value)
                        // If user types while listening (hands-free to manual), stop voice cleanly so preview doesn't fight typing
                        if (isVoiceListening) {
                          stopVoiceListening(true)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          handleAskLive()
                        }
                        // Bonus: Esc while listening stops voice without submitting
                        if (e.key === 'Escape' && isVoiceListening) {
                          e.preventDefault()
                          stopVoiceListening()
                        }
                      }}
                      disabled={recording.isTranscribingRecent || recording.isThinkingLLM}
                      aria-label="Campo para preguntar al asistente en vivo"
                    />
                    <button
                      onClick={() => handleAskLive()}
                      disabled={!liveQuestion.trim() || recording.isTranscribingRecent || recording.isThinkingLLM}
                      className="btn btn-primary text-sm px-5 py-2.5"
                      aria-label="Enviar pregunta al asistente en vivo"
                    >
                      {recording.isTranscribingRecent
                        ? 'Transcribiendo audio reciente...'
                        : recording.isThinkingLLM
                          ? 'Consultando IA...'
                          : currentFocus
                            ? `Preguntar (${currentFocusLabel.split(' ')[0]})`
                            : 'Preguntar'}
                    </button>
                  </div>

                  {/* Subtle voice hint (low cognitive load, only when idle) — now mentions keyboard fallback */}
                  {!isVoiceListening && speechSupported && !recording.isTranscribingRecent && !recording.isThinkingLLM && (
                    <div className="text-[10px] text-text-muted/70 mt-1.5 px-0.5 flex items-center gap-1">
                      <span>💡 Toque el micrófono (o Cmd/Ctrl+Shift+V — funciona global) y habla naturalmente en español. Resultado final se envía solo. Esc para cancelar.</span>
                    </div>
                  )}

                  {/* ========== LIVE Q&A HISTORY + FILTERS (keyword search + "contains action/decision/risk" etc) ========== */}
                  {/* Premium low-friction: search input + instant tag chips. Uses derived filteredLiveQAs. */}
                  {/* Stars provide real self-improvement signal (starred QAs saved in session.liveQAs for future memory/RAG). */}
                  {recording.liveQA.length > 0 && (
                    <div className="mt-3 border-t border-white/10 pt-3">
                      {/* History filter bar - compact, always visible when history exists, instant feedback */}
                      <div className="flex items-center gap-2 mb-2 px-0.5">
                        <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-text-muted">
                          <Search className="w-3 h-3" /> Historial
                        </div>

                        {/* Keyword search (debounced feel via controlled input + filter) */}
                        <div className="flex-1 relative">
                          <input
                            type="text"
                            value={liveHistorySearch}
                            onChange={(e) => setLiveHistorySearch(e.target.value)}
                            placeholder="Buscar en preguntas y respuestas..."
                            className="input text-xs py-1 pl-7 w-full"
                          />
                          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -mt-1.5 text-text-muted pointer-events-none" />
                          {liveHistorySearch && (
                            <button onClick={() => setLiveHistorySearch('')} className="absolute right-1.5 top-1/2 -mt-1.5 text-text-muted hover:text-text-primary">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>

                        {/* Quick tag filters for "contains action/decision/risk" etc. + starred. Instant apply. */}
                        <div className="flex gap-1 flex-wrap">
                          {[
                            { key: null, label: 'Todas' },
                            { key: 'decision', label: 'Decisiones' },
                            { key: 'action', label: 'Acciones' },
                            { key: 'risk', label: 'Riesgos' },
                            { key: 'budget', label: 'Presup.' },
                            { key: 'person', label: 'Personas' },
                            { key: 'starred', label: '★ Marcadas' },
                          ].map((f) => {
                            const active = liveHistoryTagFilter === f.key || (f.key === null && !liveHistoryTagFilter)
                            return (
                              <button
                                key={String(f.key)}
                                onClick={() => setLiveHistoryTagFilter(f.key)}
                                className={`text-[10px] px-2 py-0.5 rounded-full border transition ${active
                                  ? 'bg-accent/15 border-accent text-accent'
                                  : 'bg-white/5 border-white/10 hover:border-white/30 text-text-secondary'}`}
                              >
                                {f.label}
                              </button>
                            )
                          })}
                          {(liveHistorySearch || liveHistoryTagFilter) && (
                            <button
                              onClick={() => { setLiveHistorySearch(''); setLiveHistoryTagFilter(null); stopVoiceListening(true) }}
                              className="text-[10px] px-1.5 py-0.5 text-text-muted hover:text-text-primary flex items-center gap-0.5"
                              title="Limpiar filtros del historial"
                            >
                              <X className="w-3 h-3" /> reset
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Results count + visual feedback */}
                      { (liveHistorySearch || liveHistoryTagFilter) && (
                        <div className="text-[10px] text-text-muted mb-1.5 px-0.5">
                          Mostrando {filteredLiveQAs.length} de {recording.liveQA.length}
                          {liveHistoryTagFilter && ` • filtrado por ${liveHistoryTagFilter === 'starred' ? 'marcadas' : liveHistoryTagFilter}`}
                        </div>
                      )}

                      {/* The scrollable history list (now filtered + properly auto-scrolled) */}
                      <div
                        ref={liveHistoryRef}
                        className="max-h-[220px] overflow-auto space-y-3 pr-1 text-sm"
                      >
                        {filteredLiveQAs.length === 0 && (
                          <div className="text-xs text-text-muted py-2 px-1 italic">Sin resultados para los filtros actuales.</div>
                        )}
                        {filteredLiveQAs.map((qa) => {
                          const time = new Date(qa.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
                          const tagBadges = (qa.tags || []).map(t => (
                            <span key={t} className="text-[9px] px-1 py-px rounded bg-white/10 text-text-muted border border-white/10">{t}</span>
                          ))
                          return (
                            <div key={qa.id} className="group">
                              <div className="flex items-center gap-2 text-xs text-text-muted mb-0.5">
                                <span className="font-medium text-accent-light">Tú</span>
                                <span>•</span>
                                <span>{time}</span>
                                {qa.focusUsed && (
                                  <span className="text-[9px] px-1 rounded bg-accent/10 text-accent/80 border border-accent/20">foco:{getFocusLabel(qa.focusUsed).split(' ')[0]}</span>
                                )}
                                {tagBadges.length > 0 && <span className="flex gap-1 ml-1">{tagBadges}</span>}
                                {qa.starred && <Star className="w-3 h-3 text-amber-400 fill-amber-400" />}
                                {qa.memoryUsed && (
                                  <span className="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" title="Respuesta mejorada con contexto aprendido de reuniones anteriores (memoria)">✨ memoria</span>
                                )}
                              </div>
                              <div className="pl-1 text-text-primary/90">{qa.question}</div>

                              <div className="mt-1 pl-4 border-l-2 border-accent/30 text-text-secondary">
                                {qa.answer}
                              </div>

                              {/* Improved actions: real star for memory/self-improvement + copy. Always-premium hover reveal. */}
                              <div className="flex gap-2 pl-4 mt-1 opacity-0 group-hover:opacity-100 transition-opacity text-[10px]">
                                <button
                                  onClick={() => navigator.clipboard.writeText(qa.answer)}
                                  className="text-text-muted hover:text-text-primary"
                                >
                                  Copiar
                                </button>
                                <button
                                  onClick={() => {
                                    // Real starred toggle (persisted into session.liveQAs on stop → foundation for RAG/memory)
                                    const updated = recording.liveQA.map(item =>
                                      item.id === qa.id ? { ...item, starred: !item.starred } : item
                                    )
                                    setRecordingState({ liveQA: updated } as any)
                                  }}
                                  className={`flex items-center gap-0.5 ${qa.starred ? 'text-amber-400' : 'text-emerald-400/70 hover:text-emerald-400'}`}
                                  title={qa.starred ? 'Quitar de marcadas para memoria' : 'Marcar para memoria / auto-mejora futura'}
                                >
                                  <Star className={`w-3 h-3 ${qa.starred ? 'fill-current' : ''}`} />
                                  {qa.starred ? 'Marcada' : 'Marcar ★'}
                                </button>
                                {/* Quick "set focus from this QA" for delightful flow */}
                                {(qa.tags && qa.tags.length > 0) && (
                                  <button
                                    onClick={() => {
                                      // Use first tag as focus key (maps decision→decisions etc for our options)
                                      const first = qa.tags![0]
                                      const focusKey = first === 'decision' ? 'decisions' : first === 'action' ? 'actions' : first === 'risk' ? 'risks' : first === 'budget' ? 'budget' : first === 'person' ? 'people' : first
                                      setRecordingState({ contextFocus: focusKey })
                                    }}
                                    className="text-text-muted hover:text-accent"
                                    title="Usar tags de esta respuesta como enfoque de contexto para próximas preguntas"
                                  >
                                    Usar como foco
                                  </button>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <div className="mt-2 text-[10px] text-text-muted px-0.5 flex justify-between items-center">
                    <span>El contexto se actualiza incrementalmente. El informe completo se genera al finalizar.</span>
                    {recording.liveQA.length > 2 && (
                      <button
                        onClick={() => {
                          setRecordingState({ liveQA: [] } as any)
                          setLiveHistorySearch('')
                          setLiveHistoryTagFilter(null)
                          setLiveQuestion('')
                          stopVoiceListening(true)
                        }}
                        className="hover:text-text-primary"
                      >
                        Limpiar historial de esta grabación
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Compact/Stealth docked pill (rendered independently when minimized; always visible bar with timer/focus/last-summary/quick controls. Complements the collapsed sidebar.)
              High-impact autonomous polish: smooth enter/exit via framer (no pop/jank when user collapses with J or − during real meeting). */}
          <AnimatePresence>
            {recording.isRecording && !isCompanion && !assistantHidden && recordingMode !== 'normal' && !livePanelExpanded && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className={`live-pill ${recordingMode === 'stealth' ? 'stealth' : 'compact'}`}
              >
                <div className="pill-inner">
                  <div className="pill-bar">
                  <div className="pill-section pl-1 shrink-0">
                    {/* Clickable mode badge for instant cycle from pill (brilliant low-distraction control during meetings) */}
                    <button
                      onClick={cycleRecordingMode}
                      className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 border transition hover:bg-white/10 active:scale-[0.985] ${recordingMode === 'stealth' ? 'border-violet-500/30 text-violet-300 hover:text-violet-100' : 'border-rose-500/30 text-rose-300 hover:text-rose-200'}`}
                      title="Ciclo modo (normal/compact(focus)/stealth) — o usa Cmd/Ctrl+M (global) o Shift+M"
                      aria-label={`Modo actual: ${recordingMode}. Clic para cambiar.`}
                    >
                      <span className={recordingMode === 'stealth' ? 'text-violet-400' : 'text-rose-400'}>●</span>
                      <span className="font-mono tabular-nums text-[10px]">{recordingMode[0].toUpperCase()}</span>
                    </button>
                    <span className="font-mono tabular-nums font-semibold text-[12px] tracking-tight text-text-primary/90">{recording.elapsed}</span>
                    {currentFocus && <span className="text-[9px] px-1 py-px rounded-full bg-accent/10 text-accent border border-accent/20">{currentFocusLabel.split(' ')[0]}</span>}
                    {/* Mini voice state (non-intrusive but clear for compact/stealth pill during meetings) */}
                    {isVoiceListening && (
                      <div className="flex items-center gap-1 text-[9px] text-red-400" aria-live="polite">
                        <VoiceWave level={voiceLevel} mini={true} />
                        <span className="font-medium tabular-nums">Escuchando…{currentFocus ? ` (${currentFocusLabel.split(' ')[0]})` : ''}</span>
                        {!voiceInterim && <span className="opacity-60 text-[8px] ml-0.5">pausa envía</span>}
                      </div>
                    )}
                    {/* High-impact enhancement: phased loading visible directly in the docked pill (compact/stealth).
                        Users in minimal mode (hands-busy, screen share) now see exactly why the assistant is "slow" (transcribe vs LLM) without needing to expand.
                        Matches the "granular loading for brilliant UX" + "phased feedback" core of live. Subtle amber, non-alarming, disappears on done.
                        Preserves all prior pill layout / voice / summary flow. */}
                    {(recording.isTranscribingRecent || recording.isThinkingLLM) && !isVoiceListening && (
                      <span
                        className="text-[9px] px-1.5 py-px rounded bg-amber-500/10 text-amber-300/90 border border-amber-500/20 font-medium tabular-nums shrink-0"
                        aria-live="polite"
                        title={recording.isTranscribingRecent ? 'Transcribiendo audio reciente (fase 1 de 2)' : 'LLM pensando en respuesta con contexto + memoria (fase 2 de 2)'}
                      >
                        {recording.isTranscribingRecent ? 'transcribiendo…' : 'pensando…'}
                      </span>
                    )}
                  </div>

                  {isVoiceListening ? (
                    // When listening in pill: show live interim preview here (replaces last-summary temporarily) + easy stop + confirm affordance.
                    // Keeps the bar compact, low-distraction, but gives the "what is being heard" + "Detener" + "Enviar" required for polished voice UX in compact/stealth.
                    <div className="flex-1 min-w-0 truncate text-red-300/90 border-l border-red-500/20 pl-2 flex items-center gap-1 text-[10px]">
                      {voiceInterim ? (
                        <span className="voice-interim !max-w-[210px] !text-[10px]">«{voiceInterim}»</span>
                      ) : (
                        <span className="opacity-70 flex items-center gap-1">
                          <VoiceWave level={voiceLevel} mini={true} className="scale-90" />
                          habla naturalmente{currentFocus ? ` (foco ${currentFocusLabel.split(' ')[0]})` : ''}… (pausa ~2s)
                        </span>
                      )}
                      {voiceSentFlash && <span className="text-[8px] px-1 py-px rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">{voiceSentFlash}</span>}
                      {voiceInterim && (
                        <button
                          onClick={() => {
                            const toSend = voiceInterim.trim()
                            stopVoiceListening(true)
                            if (toSend) {
                              handleAskLive(toSend)
                              setVoiceSentFlash('✓')
                            }
                          }}
                          className="ml-1 text-[9px] px-2 py-px min-h-[22px] rounded bg-emerald-500/20 border border-emerald-500/30 hover:bg-emerald-500/30 active:scale-[0.98] text-emerald-300 flex items-center gap-0.5"
                          aria-label="Enviar lo escuchado ahora"
                          title="Enviar voz ahora (toque generoso para manos ocupadas)"
                        >
                          <span>➤</span> Enviar
                        </button>
                      )}
                      <button
                        onClick={() => stopVoiceListening()}
                        className="ml-1 text-[9px] px-2 py-px min-h-[22px] rounded bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 active:scale-[0.98] flex items-center gap-0.5"
                        aria-label="Detener escucha de voz"
                        title="Detener voz (o pulsa Esc)"
                      >
                        <X className="w-3 h-3" /> Detener
                      </button>
                    </div>
                  ) : recording.liveQA.length > 0 ? (
                    /* Larger tap target for copy + quick star (memory boost): click area copies; ★ instantly stars last for RAG/self-improvement without expanding full panel. 
                       High-impact for during-meeting: capture value to memory from the minimal pill, zero context switch. 
                       Uses pillCopiedFlash for inline confirmation (brillante glanceable, no Toaster). */
                    <div
                      onClick={() => copyLastSummary(setPillCopiedFlash)}
                      className="summary-tap group"
                      title="Clic para copiar última respuesta (o usa los iconos). ★ marca para memoria (RAG futuro)."
                    >
                      <span className="text-[10px] text-text-muted/60 mr-0.5 shrink-0">últ:</span>
                      {(recording.isTranscribingRecent || recording.isThinkingLLM) && (
                        <span className="text-amber-300/80 mr-1 text-[9px] font-medium shrink-0">({recording.isTranscribingRecent ? 'transcribiendo' : 'pensando'})</span>
                      )}
                      <span className={`flex-1 truncate ${recording.isTranscribingRecent || recording.isThinkingLLM ? 'opacity-60' : ''}`}>{recording.liveQA.at(-1)!.answer.slice(0, 95)}…</span>
                      {pillCopiedFlash && <span className="text-[8px] px-1 py-px bg-emerald-500/20 text-emerald-300 rounded border border-emerald-500/30 ml-1">{pillCopiedFlash}</span>}
                      <span className="copy-star shrink-0" onClick={(e) => { e.stopPropagation(); copyLastSummary(setPillCopiedFlash) }} title="Copiar última respuesta (área generosa para manos ocupadas)">
                        <Copy className="w-3 h-3 text-text-muted hover:text-accent opacity-70 group-hover:opacity-100 transition" aria-label="Copiar última respuesta" />
                      </span>
                      <span className="text-[8px] text-text-muted/50 ml-0.5 hidden group-hover:inline">copiar</span>
                      <span
                        className="copy-star shrink-0"
                        onClick={(e) => {
                          e.stopPropagation()
                          const last = recording.liveQA.at(-1)!
                          if (!last) return
                          const updated = recording.liveQA.map(item =>
                            item.id === last.id ? { ...item, starred: !item.starred } : item
                          )
                          setRecordingState({ liveQA: updated } as any)
                          // Note: memory index will pick it up on stop (or via addOrUpdate later); live already uses retrieveRelevant which scores stars.
                        }}
                        title={recording.liveQA.at(-1)!.starred ? 'Quitar de memoria' : 'Marcar ★ para memoria / auto-mejora (RAG en futuras preguntas)'}
                      >
                        <Star className={`w-3 h-3 ${recording.liveQA.at(-1)!.starred ? 'fill-current text-amber-400' : 'text-emerald-400/70 hover:text-emerald-400 opacity-70 group-hover:opacity-100 transition'}`} aria-label="Marcar última para memoria" />
                      </span>
                    </div>
                  ) : recording.liveTranscript ? (
                    <div
                      onClick={() => copyLastSummary(setPillCopiedFlash)}
                      className="summary-tap group"
                      title="Clic para copiar contexto reciente"
                    >
                      <span className="text-[10px] text-text-muted/60 mr-0.5">ctx:</span>
                      {(recording.isTranscribingRecent || recording.isThinkingLLM) && (
                        <span className="text-amber-300/80 mr-1 text-[9px] font-medium shrink-0">({recording.isTranscribingRecent ? 'transcribiendo' : 'pensando'})</span>
                      )}
                      <span className={`flex-1 truncate ${recording.isTranscribingRecent || recording.isThinkingLLM ? 'opacity-60' : ''}`}>{recording.liveTranscript.slice(-80)}…</span>
                      {pillCopiedFlash && <span className="text-[8px] px-1 py-px bg-emerald-500/20 text-emerald-300 rounded border border-emerald-500/30 ml-1">{pillCopiedFlash}</span>}
                      <span className="text-[8px] text-text-muted/50 ml-0.5 hidden group-hover:inline">copiar</span>
                    </div>
                  ) : <div className="flex-1 text-text-muted text-[10px] pl-2 border-l border-white/10">Esperando contexto…</div>}

                  {/* Expanded quick focus chips in pill (5 options, abbreviated for minimal width; high power for context filter without expanding) */}
                  <div className="flex gap-0.5 shrink-0">
                    {FOCUS_OPTIONS.map(opt => {
                      const act = (opt.key === null && !currentFocus) || opt.key === currentFocus
                      return (
                        <button
                          key={String(opt.key)}
                          onClick={() => { stopVoiceListening(true); setRecordingState({ contextFocus: opt.key }) }}
                          className={`focus-chip ${act ? 'active' : 'inactive'}`}
                          title={opt.label}
                        >
                          {opt.label.slice(0, 3)}
                        </button>
                      )
                    })}
                  </div>

                  {speechSupported ? (
                    <VoiceMicButton
                      isListening={isVoiceListening}
                      onClick={toggleVoiceInput}
                      disabled={recording.isTranscribingRecent || recording.isThinkingLLM}
                      size="compact"
                      level={voiceLevel}
                      aria-label={isVoiceListening ? 'Detener voz (barra compacta)' : 'Voz en barra compacta'}
                      disabledTitle={recording.isTranscribingRecent || recording.isThinkingLLM ? 'Voz pausada: IA pensando (phases)' : undefined}
                    />
                  ) : voiceEnabled ? (
                    // Consistent disabled affordance with main panel (for non-Chromium or no browser support) — now tappable for info.
                    <button
                      type="button"
                      onClick={() => toast.info('Voz no disponible aquí', { description: 'Requiere soporte Web Speech en Chromium/Electron.' })}
                      className="voice-mic !w-7 !h-7 shrink-0 opacity-40 cursor-not-allowed hover:opacity-60 active:scale-[0.96] transition"
                      title="Entrada por voz no disponible (SpeechRecognition no soportado). Toca para info."
                      aria-label="Entrada por voz no soportada en compacto"
                    >
                      <Mic className="w-3.5 h-3.5" />
                    </button>
                  ) : (
                    // Voice explicitly off in Ajustes: still render tiny dim affordance in pill for glanceable consistency + quick reminder (tap opens hint).
                    // Keeps pill layout stable; high-impact for users who toggle pref mid-meeting flow.
                    <button
                      type="button"
                      onClick={() => toast('Entrada por voz desactivada en Ajustes', { description: 'Actívala para usar el mic o Cmd/Ctrl+Shift+V.' })}
                      className="voice-mic !w-7 !h-7 shrink-0 opacity-25 cursor-help hover:opacity-45 active:scale-[0.96] transition"
                      title="Entrada por voz desactivada (ver Ajustes). Toca para recordatorio."
                      aria-label="Entrada por voz desactivada en ajustes (compacto)"
                    >
                      <MicOff className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <input
                    ref={pillInputRef}
                    className={`input !text-xs !py-1 flex-1 max-w-[220px] min-w-[110px] ${isVoiceListening ? 'voice-input-active ring-1 ring-red-400/50 border-red-400/40' : ''}`}
                    placeholder={isVoiceListening ? 'Escuchando…' : "Preguntar (o 🎤)"}
                    value={liveQuestion}
                    onChange={e => {
                      setLiveQuestion(e.target.value)
                      if (isVoiceListening) stopVoiceListening(true)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); handleAskLive() }
                      if (e.key === 'Escape' && isVoiceListening) { e.preventDefault(); stopVoiceListening() }
                    }}
                    disabled={recording.isTranscribingRecent || recording.isThinkingLLM}
                  />
                  <button onClick={() => handleAskLive()} disabled={!liveQuestion.trim() || recording.isTranscribingRecent || recording.isThinkingLLM} className="btn btn-primary text-[10px] px-2 py-1 shrink-0" title="Enviar pregunta (o usa pausa en voz)">OK</button>

                  <button onClick={() => setLivePanelExpanded(true)} className="pill-control" title="Expandir panel">↗</button>
                  <button onClick={() => { if (isVoiceListening) stopVoiceListening(true); setAssistantHidden(true) }} className="pill-control px-1" title="Ocultar barra (tray + globales siguen activos)">×</button>
                  <button onClick={() => {
                    const api = (window as any).electron
                    api?.openCompanion?.()
                    if (recording.isRecording) {
                      setAssistantHidden(true)
                      api?.minimizeMain?.()
                    }
                  }} className="text-[9px] px-1 bg-white/5 rounded shrink-0 border border-white/10" title="PiP always-on-top (compañero flotante). Minimiza ventana principal automáticamente para foco y para que no aparezca en pantalla compartida.">PiP</button>
                </div>
              </div>
            </motion.div>
          )}
          </AnimatePresence>

          {/* Stealth focus placeholder (high-impact for real meetings): when stealth + hidden (default on stealth start / via J/Esc/M),
              suppress the full welcome screen or prior session detail/report (which would be visually noisy + leak context on screen share).
              Ultra lower profile, zero distraction: compact centered low-footprint card (not full-area takeover) + soft violet, quick actions only.
              Banner + top stop button remain for control. Pill can be revealed with J without leaving stealth.
              For compact pill-minimized (and stealth hidden): we ALSO suppress the main content area (detail/welcome/library view below)
              so the pill + banner + thin rail become the ONLY live UI chrome. Prevents leaking prior session report/context during
              Google Meet/Zoom screen share or when hands-busy with minimal distraction goal. Full detail restored on expand or end-of-rec.
              Preserves 100% of library/detail behavior outside active minimized rec modes. */}
          {recording.isRecording && recordingMode === 'stealth' && assistantHidden ? (
            <div className="flex-1 flex items-center justify-center bg-bg/30 p-4">
              <div className="text-center max-w-[260px] rounded-2xl border border-violet-500/10 bg-violet-950/10 px-4 py-3">
                <div className="inline-flex items-center gap-1.5 text-violet-400 mb-1.5">
                  <span className="text-sm">●</span>
                  <span className="font-medium tracking-[1px] text-[10px] uppercase">STEALTH</span>
                </div>
                <div className="font-mono text-xl text-violet-200/90 tabular-nums mb-1.5 flex items-center justify-center gap-2">
                  {recording.elapsed}
                  {(recording.isTranscribingRecent || recording.isThinkingLLM) && (
                    <span className="text-[9px] px-1.5 py-px rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-medium">{recording.isTranscribingRecent ? 'transcribiendo' : 'pensando'}</span>
                  )}
                </div>
                <div className="text-[10px] text-violet-300/70 mb-3">Mínima distracción. Enfoque total.</div>

                {/* Stealth-friendly mini last summary (high-impact autonomous add): shows truncated last answer or ctx snippet + copy.
                    Zero noise by default (only if value exists), soft violet, click copies without leaving stealth placeholder.
                    Gives "grab value" from ultra-low mode without expanding pill or showing full history. Consistent with pill copy UX.
                    Uses stealthCopiedFlash for inline "copiado" (no toast at all — brilliant for real meetings where any popup is distraction). */}
                {(recording.liveQA.length > 0 || recording.liveTranscript) && (
                  <div
                    onClick={() => {
                      const lastQA = recording.liveQA.at(-1)
                      const txt = lastQA ? lastQA.answer : (recording.liveTranscript || '').slice(-220)
                      if (txt?.trim()) {
                        navigator.clipboard.writeText(txt.trim()).then(() => {
                          setStealthCopiedFlash('copiado')
                        }).catch(() => {})
                      }
                    }}
                    className="stealth-mini-summary mx-auto mb-3 max-w-[220px] text-[10px] px-2.5 py-1 rounded border border-violet-500/20 bg-violet-950/30 text-violet-200/80 cursor-pointer hover:bg-violet-950/50 active:bg-violet-950/60 transition line-clamp-2 relative"
                    title="Clic para copiar último contexto o respuesta (no sale del modo stealth)"
                  >
                    {(recording.isTranscribingRecent || recording.isThinkingLLM) && (
                      <span className="text-violet-300/70 mr-1">({recording.isTranscribingRecent ? 'transcribiendo' : 'pensando'}) </span>
                    )}
                    {recording.liveQA.length > 0
                      ? `últ: ${recording.liveQA.at(-1)!.answer.slice(0, 110)}…`
                      : `ctx: ${recording.liveTranscript.slice(-90)}…`}
                    {stealthCopiedFlash && (
                      <span className="absolute -top-1 -right-1 text-[8px] px-1 py-px bg-emerald-500/30 text-emerald-300 rounded border border-emerald-500/40">{stealthCopiedFlash}</span>
                    )}
                  </div>
                )}

                {/* Actionable minimal controls (one-tap reveal pill / PiP / cycle) — brilliant for hands-busy without full UI noise */}
                <div className="flex flex-wrap justify-center gap-2 mb-4">
                  <button
                    onClick={() => { setAssistantHidden(false); setLivePanelExpanded(false) }}
                    className="text-[10px] px-3 py-1 rounded-full border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 active:scale-[0.985]"
                    title="Mostrar barra pill compacta (timer + foco + voz + input)"
                  >
                    Mostrar pill
                  </button>
                  {/* Direct voice in ultra-stealth placeholder (high-impact): tap mic here speaks immediately.
                      toggleVoiceInput() auto-reveals the pill bar (existing stealth-hidden logic) for interim + controls.
                      Reuses the small variant + level reactivity. Zero extra friction for pure voice flow. */}
                  {speechSupported && (
                    <VoiceMicButton
                      isListening={isVoiceListening}
                      onClick={toggleVoiceInput}
                      disabled={recording.isTranscribingRecent || recording.isThinkingLLM}
                      size="small"
                      title={isVoiceListening ? 'Detener voz' : 'Hablar ahora (Cmd/Ctrl+Shift+V; revela pill mínimamente)'}
                      aria-label="Voz directa en stealth"
                      className="border-violet-500/40 text-violet-300 hover:bg-violet-500/10"
                      disabledTitle={recording.isTranscribingRecent || recording.isThinkingLLM ? 'Voz pausada: IA en fases (stealth)' : undefined}
                    />
                  )}
                  <button
                    onClick={() => {
                      const api = (window as any).electron
                      api?.openCompanion?.()
                      if (recording.isRecording) {
                        api?.minimizeMain?.()
                      }
                    }}
                    className="text-[10px] px-3 py-1 rounded-full border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 active:scale-[0.985]"
                    title="Abrir PiP always-on-top (compañero estrecho). Minimiza principal."
                  >
                    Abrir PiP
                  </button>
                  <button
                    onClick={cycleRecordingMode}
                    className="text-[10px] px-3 py-1 rounded-full border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 active:scale-[0.985]"
                    title="Ciclar a compacto o normal (Cmd/Ctrl+M también)"
                  >
                    Ciclar modo
                  </button>
                </div>

                <div className="text-[11px] text-text-muted/70 space-y-1">
                  <div>J: mostrar pill • M: ciclo modo • Esc: ocultar • F / [ / ]: ciclo foco</div>
                  <div>Cmd/Ctrl+M (global): ciclo modo • Cmd/Ctrl+Shift+V: voz • Cmd/Ctrl+F: foco</div>
                  <div className="pt-1">Banner + DETENER siempre visibles arriba. Tray + atajos globales activos (incluso oculto).</div>
                </div>
                <button
                  onClick={() => { setAssistantHidden(false); setLivePanelExpanded(true) }}
                  className="mt-3 text-[9px] px-2 py-0.5 rounded border border-violet-500/20 text-violet-400/80 hover:text-violet-200"
                >
                  Expandir asistente completo
                </button>
              </div>
            </div>
          ) : recording.isRecording && recordingMode !== 'normal' && !livePanelExpanded && !assistantHidden ? (
            /* Ultra-low-distraction spacer for compact/stealth pill-minimized: no welcome, no prior detail/report visible.
               Pill (above in this flex col) + banner + rail (if compact) + stop button are the complete surface.
               Critical for meeting focus + prevents accidental screen-share of old session UI or noise.
               User can still J to expand, M cycle, Esc hide, PiP, or use voice chips in pill. */
            <div className="flex-1 flex items-center justify-center bg-bg/20">
              {/* Ultra-low profile spacer: invisible-ish text only for a11y / dev; no visual noise, no prior content. Pill + banner + (rail) = entire live surface. */}
              <div className="text-center text-[9px] text-text-muted/30 select-none pointer-events-none" aria-hidden>
                {recordingMode} • pill arriba
              </div>
            </div>
          ) : !selectedSession ? (
            // Welcome / empty state
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md text-center">
                <div className="mx-auto w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mb-6 overflow-hidden ring-1 ring-white/10">
                  <img src="/reunia-logo.png" alt="ReunIA" className="w-12 h-12 object-contain" onError={(e) => { (e.target as HTMLImageElement).src = '/reunia-logo.svg'; }} />
                </div>
                <h1 className="text-3xl font-semibold tracking-tight mb-2">Bienvenido a ReunIA</h1>
                <p className="text-text-secondary mb-8">
                  Graba cualquier reunión o llamada (Google Meet, Zoom, en persona...) con un clic. 
                  La IA genera informes completos automáticamente.
                </p>

                <div className="grid grid-cols-2 gap-3 text-left">
                  <div className="card p-4 text-sm">
                    <div className="font-medium mb-1 flex items-center gap-2"><Target className="w-4 h-4 text-accent"/> Un clic para grabar</div>
                    <div className="text-text-muted text-xs">Botón grande, atajo global o desde la bandeja del sistema. Funciona aunque Meet esté en primer plano.</div>
                  </div>
                  <div className="card p-4 text-sm">
                    <div className="font-medium mb-1 flex items-center gap-2"><FileText className="w-4 h-4 text-accent"/> Informe inteligente</div>
                    <div className="text-text-muted text-xs">Resumen, insights clave, asistentes, intervinientes, recomendaciones, consejos y to-do list accionable.</div>
                  </div>
                </div>

                <button onClick={handleStartRecording} className="btn btn-primary mt-8 px-8 py-3 text-base">
                  <Mic className="w-5 h-5" /> Empezar primera grabación
                </button>
                <div className="mt-3 text-xs text-text-muted">Atajo recomendado: <span className="font-mono bg-white/5 px-1.5 py-px rounded">Cmd/Ctrl + Shift + R</span></div>
              </div>
            </div>
          ) : (
            // Detail view
            <div className="flex-1 overflow-auto p-6 space-y-6">
              {/* Session header */}
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-semibold tracking-tight">{selectedSession.title}</h1>
                    {selectedSession.hasReport && <span className="tag">Procesado con IA</span>}
                  </div>
                  <div className="text-text-secondary flex items-center gap-4 text-sm mt-1">
                    <span>{format(new Date(selectedSession.date), "EEEE, d 'de' MMMM yyyy • HH:mm", { locale: es })}</span>
                    <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {Math.floor(selectedSession.durationSec / 60)} minutos</span>
                  </div>
                </div>

                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => processWithAI(selectedSession)} disabled={isProcessing} className="btn btn-primary">
                    {isProcessing && processingSessionId === selectedSession.id ? (
                      <><RefreshCw className="w-4 h-4 animate-spin" /> Procesando...</>
                    ) : (
                      <><Lightbulb className="w-4 h-4" /> Generar / Re-generar informe
                    )}
                  </button>

                  <button onClick={handleSaveCurrentSession} className="btn btn-secondary" title="Guarda el audio + informe en la carpeta elegida (subcarpeta por fecha)">
                    <FolderOpen className="w-4 h-4" /> Guardar en carpeta
                  </button>

                  <button onClick={async () => {
                    if (selectedSession.folderPath) {
                      const api = (window as any).electron
                      if (api?.openPath) await api.openPath(selectedSession.folderPath)
                    } else {
                      handleSaveCurrentSession()
                    }
                  }} className="btn btn-secondary" title="Abre la carpeta donde está guardada esta sesión">
                    <FolderOpen className="w-4 h-4" /> Abrir carpeta
                  </button>

                  <div className="flex gap-1">
                    <button onClick={() => exportReport(selectedSession)} className="btn btn-secondary text-xs" title="Exportar Markdown">MD</button>
                    <button onClick={() => exportDocx(selectedSession)} className="btn btn-secondary text-xs" title="Exportar Word">DOCX</button>
                    <button onClick={() => exportPdf(selectedSession)} className="btn btn-secondary text-xs" title="Exportar PDF">PDF</button>
                  </div>

                  <button onClick={() => { if (confirm('¿Eliminar esta sesión?')) deleteSession(selectedSession.id) }} className="btn btn-ghost text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Audio player area */}
              <div className="card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-medium flex items-center gap-2"><Play className="w-4 h-4" /> Audio de la reunión</div>
                  <button onClick={togglePlayback} className="btn btn-secondary text-sm py-1 px-3">
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />} Reproducir
                  </button>
                </div>
                <div className="text-xs text-text-muted mb-2">
                  Para capturar el audio que sale de Google Meet / Zoom, selecciona BlackHole (mac) o un cable virtual como VB-Cable (Windows) en el selector de dispositivos.
                </div>

                {/* Real wavesurfer waveform - securely loads from disk for saved sessions via main IPC (ArrayBuffer) */}
                <div id="waveform" className="h-20 bg-bg/60 rounded-xl border border-white/10 overflow-hidden" />
                <div className="text-[10px] text-text-muted mt-1 text-center">
                  {recording.isRecording ? 'Grabando...' : 'Reproducción con visualización de onda para sesiones guardadas (carga segura desde disco)'}
                </div>
              </div>

              {/* Report sections - beautiful and structured */}
              {currentSessionData.report ? (
                <div>
                  <div className="section-title mb-4 flex items-center gap-2">
                    <FileText className="w-4 h-4" /> Informe generado por IA
                    {(currentSessionData as any).memoryUsedForReport && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" title="Este informe incorporó contexto y estilo de tus reuniones anteriores marcadas (memoria local)">
                        ✨ Mejorado con tu memoria de reuniones anteriores
                      </span>
                    )}
                  </div>

                  {/* Summary */}
                  <div className="report-section">
                    <h3><MessageSquare className="w-4 h-4" /> Resumen</h3>
                    <p className="text-[15px] leading-relaxed text-text-secondary">{currentSessionData.report.summary}</p>
                  </div>

                  {/* Key insights */}
                  <div className="report-section">
                    <h3><Lightbulb className="w-4 h-4" /> Insights clave</h3>
                    <ul className="space-y-2">
                      {currentSessionData.report.keyInsights.map((insight, i) => (
                        <li key={i} className="flex gap-2 text-sm"><span className="text-accent mt-1">→</span> {insight}</li>
                      ))}
                    </ul>
                  </div>

                  {/* People */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="report-section">
                      <h3><Users className="w-4 h-4" /> Personas asistentes</h3>
                      {currentSessionData.report.attendees.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {currentSessionData.report.attendees.map((p, i) => <span key={i} className="tag">{p}</span>)}
                        </div>
                      ) : <p className="text-sm text-text-muted">No se detectaron nombres explícitos. Añade contexto antes de grabar para mejores resultados.</p>}
                    </div>
                    <div className="report-section">
                      <h3><Users className="w-4 h-4" /> Quiénes intervinieron</h3>
                      {currentSessionData.report.speakers.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {currentSessionData.report.speakers.map((p, i) => <span key={i} className="tag">{p}</span>)}
                        </div>
                      ) : <p className="text-sm text-text-muted">No se identificaron intervenciones concretas.</p>}
                    </div>
                  </div>

                  {/* Recommendations + Advice */}
                  <div className="report-section">
                    <h3><Target className="w-4 h-4" /> Recomendaciones</h3>
                    <ul className="space-y-1.5 text-sm">
                      {currentSessionData.report.recommendations.map((r, i) => <li key={i}>• {r}</li>)}
                    </ul>
                  </div>

                  <div className="report-section">
                    <h3><Lightbulb className="w-4 h-4" /> Consejos</h3>
                    <ul className="space-y-1.5 text-sm">
                      {currentSessionData.report.advice.map((a, i) => <li key={i}>• {a}</li>)}
                    </ul>
                  </div>

                  {/* To-do list */}
                  <div className="report-section">
                    <h3><CheckSquare className="w-4 h-4" /> Lista de acciones (To-Do)</h3>
                    {currentSessionData.report.todoList.length > 0 ? (
                      <div className="space-y-2">
                        {currentSessionData.report.todoList.map((item, idx) => (
                          <label key={idx} className="flex items-start gap-3 text-sm cursor-pointer">
                            <input 
                              type="checkbox" 
                              checked={item.done} 
                              onChange={() => {
                                // mutate local report for quick edits (not persisted yet)
                                const next = { ...currentSessionData }
                                next.report!.todoList[idx].done = !item.done
                                setCurrentSessionData(next)
                              }}
                              className="mt-1 accent-accent" 
                            />
                            <span className={item.done ? 'line-through text-text-muted' : ''}>{item.task}</span>
                          </label>
                        ))}
                      </div>
                    ) : <p className="text-sm text-text-muted">No se extrajeron acciones pendientes.</p>}
                  </div>
                </div>
              ) : (
                <div className="card p-8 text-center border-dashed border-white/20">
                  <div className="text-text-muted mb-4">
                    Aún no se ha generado el informe con IA para esta reunión.
                  </div>
                  <button onClick={() => processWithAI(selectedSession)} className="btn btn-primary">
                    <Lightbulb className="w-4 h-4" /> Generar informe con IA ahora
                  </button>
                  <div className="text-xs text-text-muted mt-3 max-w-xs mx-auto">
                    Se usará Whisper para transcribir (español excelente) y un modelo GPT para extraer estructura.
                  </div>
                </div>
              )}

              {/* Transcript (if present) */}
              {currentSessionData.transcript && (
                <div className="report-section">
                  <h3><FileText className="w-4 h-4" /> Transcripción completa</h3>
                  <div className="text-sm whitespace-pre-wrap text-text-secondary max-h-72 overflow-auto leading-relaxed bg-black/20 p-4 rounded-xl border border-white/5">
                    {currentSessionData.transcript}
                  </div>
                </div>
              )}

              {/* Live Q&A captures from the recording session (self-improvement data + post-meeting review) */}
              {/* This surfaces the liveQAs saved on stopRecording without altering report generation behavior or the full report flow. */}
              {selectedSession?.liveQAs && selectedSession.liveQAs.length > 0 && (
                <div className="report-section border border-white/10">
                  <h3 className="flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Preguntas al asistente durante la grabación <span className="text-[10px] font-normal text-text-muted">({selectedSession.liveQAs.length})</span></h3>
                  <div className="space-y-3 text-sm max-h-64 overflow-auto pr-1">
                    {selectedSession.liveQAs.map((qa: any) => (
                      <div key={qa.id} className="pl-1 border-l border-accent/20 group">
                        <div className="flex items-center gap-2 text-xs text-text-muted">
                          <span>{new Date(qa.timestamp).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span>
                          {qa.focusUsed && <span className="tag text-[9px] py-0">foco: {getFocusLabel(qa.focusUsed)}</span>}
                          {qa.starred && <Star className="w-3 h-3 text-amber-400 fill-amber-400" />}
                          {qa.memoryUsed && (
                            <span className="text-[9px] px-1 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" title="Esta respuesta usó contexto aprendido de reuniones pasadas">✨ memoria</span>
                          )}
                          {/* Allow managing memory/star even on historical items */}
                          <button
                            onClick={() => {
                              const currentQAs = selectedSession.liveQAs || []
                              const updatedQAs = currentQAs.map((item: any) =>
                                item.id === qa.id ? { ...item, starred: !item.starred } : item
                              )
                              updateSession(selectedSession.id, { liveQAs: updatedQAs })
                              // If now starred, make immediately available to memory for future injections
                              const becameStarred = !qa.starred
                              if (becameStarred) {
                                const patched = { ...selectedSession, liveQAs: updatedQAs }
                                indexStarredFromSession(patched, settings).then((added) => {
                                  if (added) {
                                    // refresh count in store (and UI badge)
                                    loadMemory()
                                  }
                                }).catch(() => {})
                              }
                            }}
                            className={`ml-auto text-[10px] flex items-center gap-0.5 transition ${qa.starred ? 'text-amber-400' : 'text-emerald-400/60 hover:text-emerald-400 opacity-0 group-hover:opacity-100'}`}
                            title={qa.starred ? 'Quitar de memoria (ya no se usará en futuras inyecciones)' : 'Marcar ★ para memoria / auto-mejora futura'}
                          >
                            <Star className={`w-3 h-3 ${qa.starred ? 'fill-current' : ''}`} />
                            {qa.starred ? '' : '★'}
                          </button>
                        </div>
                        <div className="font-medium text-text-primary/90 mt-0.5">{qa.question}</div>
                        <div className="text-text-secondary mt-0.5 text-xs leading-snug">{qa.answer}</div>
                        {qa.tags && qa.tags.length > 0 && (
                          <div className="flex gap-1 mt-1">{qa.tags.map((t: string) => <span key={t} className="text-[9px] px-1 bg-white/5 rounded border border-white/10">{t}</span>)}</div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-text-muted mt-2">Estas capturas se guardan con la sesión para revisión y como semilla para futuras mejoras (RAG / memoria).</div>
                </div>
              )}
            </div>
          )}
          {/* close inner !selected ternary + stealth guard ternary (the original detail branch is still present in source after welcome content) */}
        </div>
      </div>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6" onClick={() => setSettingsOpen(false)}>
            <motion.div 
              initial={{ opacity: 0, scale: 0.96, y: 10 }} 
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              className="card w-full max-w-lg p-6" 
              onClick={e => e.stopPropagation()}
            >
              <div className="text-xl font-semibold mb-1">Ajustes de ReunIA</div>
              <p className="text-sm text-text-muted mb-6">La configuración se guarda automáticamente. <span className="text-emerald-400/80">Todo (audio, informes y memoria) se queda solo en este equipo.</span></p>

              <div className="space-y-5">
                {/* AI Provider */}
                <div>
                  <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Proveedor de IA (para el informe)</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveSettings({ aiProvider: 'openai' })}
                      className={`btn flex-1 text-sm py-2 ${settings.aiProvider === 'openai' ? 'btn-primary' : 'btn-secondary'}`}
                    >
                      OpenAI (GPT)
                    </button>
                    <button
                      onClick={() => saveSettings({ aiProvider: 'ollama' })}
                      className={`btn flex-1 text-sm py-2 ${settings.aiProvider === 'ollama' ? 'btn-primary' : 'btn-secondary'}`}
                    >
                      Ollama (Local)
                    </button>
                  </div>
                  <div className="text-[11px] text-text-muted mt-1">
                    {settings.aiProvider === 'ollama'
                      ? 'Usa tu modelo local (llama3.2, gemma2, mistral, etc.). Requiere Ollama corriendo.'
                      : 'Usa OpenAI (recomendado para mejor calidad de informes).'}
                  </div>
                </div>

                {/* OpenAI Key (only when needed) */}
                {settings.aiProvider === 'openai' && (
                  <div>
                    <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Clave API de OpenAI</label>
                    <input 
                      type="password" 
                      className="input font-mono text-sm" 
                      placeholder="sk-..." 
                      value={settings.openaiApiKey} 
                      onChange={(e) => saveSettings({ openaiApiKey: e.target.value })}
                    />
                  </div>
                )}

                {/* Ollama settings */}
                {settings.aiProvider === 'ollama' && (
                  <div className="space-y-3 rounded-xl bg-bg/60 p-4 border border-white/10">
                    <div>
                      <label className="text-xs uppercase tracking-widest text-text-muted block mb-1">URL de Ollama</label>
                      <input 
                        className="input text-sm" 
                        value={settings.ollamaBaseUrl} 
                        onChange={e => saveSettings({ ollamaBaseUrl: e.target.value })}
                        placeholder="http://localhost:11434"
                      />
                    </div>
                    <div>
                      <label className="text-xs uppercase tracking-widest text-text-muted block mb-1">Modelo Ollama</label>
                      <input 
                        className="input text-sm" 
                        value={settings.ollamaModel} 
                        onChange={e => saveSettings({ ollamaModel: e.target.value })}
                        placeholder="llama3.2"
                      />
                      <div className="text-[11px] text-text-muted mt-1">Ejemplos: llama3.2, gemma2:9b, mistral, qwen2.5, phi3</div>
                    </div>

                    <button 
                      onClick={testOllama} 
                      disabled={ollamaTestStatus.loading}
                      className="btn btn-secondary text-sm w-full mt-1"
                    >
                      {ollamaTestStatus.loading ? 'Probando...' : 'Probar conexión a Ollama'}
                    </button>
                    {ollamaTestStatus.message && (
                      <div className="text-xs text-text-muted mt-1 break-all">{ollamaTestStatus.message}</div>
                    )}
                  </div>
                )}

                {/* Transcription source */}
                <div>
                  <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Transcripción (Whisper)</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => saveSettings({ transcriptionMode: 'openai' })}
                      className={`btn flex-1 text-sm py-2 ${settings.transcriptionMode === 'openai' ? 'btn-primary' : 'btn-secondary'}`}
                    >
                      OpenAI Whisper
                    </button>
                    <button
                      onClick={() => saveSettings({ transcriptionMode: 'local' })}
                      className={`btn flex-1 text-sm py-2 ${settings.transcriptionMode === 'local' ? 'btn-primary' : 'btn-secondary'}`}
                    >
                      Local (compatible OpenAI)
                    </button>
                  </div>
                  {settings.transcriptionMode === 'local' && (
                    <div className="mt-2">
                      <div className="flex gap-2">
                        <input 
                          className="input text-sm flex-1" 
                          value={settings.transcriptionEndpoint} 
                          onChange={e => saveSettings({ transcriptionEndpoint: e.target.value })}
                          placeholder="http://localhost:8000/v1"
                        />
                        <button onClick={testTranscriptionEndpoint} className="btn btn-secondary text-sm px-3">Probar</button>
                      </div>
                      <div className="text-[11px] text-text-muted mt-1">
                        Endpoint compatible con OpenAI (ej: whisper-asr-webservice, faster-whisper-server, etc.)
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Ruta de almacenamiento</label>
                  <div className="flex gap-2">
                    <input className="input flex-1 text-sm" value={settings.storagePath} readOnly placeholder="~/Documents/ReunIA" />
                    <button 
                      className="btn btn-secondary text-sm" 
                      onClick={async () => {
                        const api = (window as any).electron
                        if (api?.selectDirectory) {
                          const dir = await api.selectDirectory()
                          if (dir) saveSettings({ storagePath: dir })
                        } else {
                          toast.info('En desarrollo: selección de carpeta vía diálogo nativo')
                        }
                      }}
                    >
                      Elegir...
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Modelo OpenAI (cuando uses OpenAI)</label>
                    <select className="input" value={settings.preferredModel} onChange={e => saveSettings({ preferredModel: e.target.value })}>
                      <option value="gpt-4o-mini">gpt-4o-mini (rápido y barato)</option>
                      <option value="gpt-4o">gpt-4o (mejor calidad)</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Idioma</label>
                    <select className="input" value={settings.language} onChange={e => saveSettings({ language: e.target.value })}>
                      <option value="es">Español</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Atajo global</label>
                  <input className="input" value={settings.hotkey} onChange={e => saveSettings({ hotkey: e.target.value })} />
                  <div className="text-xs text-text-muted mt-1">Ejemplo: CommandOrControl+Shift+R</div>
                </div>

                {/* Voice input toggle (high-impact for meeting users who prefer pure keyboard or have mic concerns) */}
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    checked={settings.enableVoiceInput !== false}
                    onChange={e => saveSettings({ enableVoiceInput: e.target.checked })}
                    id="voice"
                  />
                  <label htmlFor="voice" className="text-sm">Habilitar micrófono para entrada por voz en Asistente en vivo (Cmd/Ctrl+Shift+V)</label>
                </div>
                <div className="text-[10px] text-text-muted -mt-1 pl-5">Un toque al 🎤 (o atajo global Cmd/Ctrl+Shift+V incluso con ReunIA en background) + habla en español. Soporta interim, auto-envío por silencio, focus, memoria y todo lo demás. Nativo Web Speech (sin deps). Se respeta en PiP compañero.</div>

                {/* Recording modes (compact/stealth) are a persisted user pref + auto-applied on record start (your last cycle choice is the start mode) for low-distraction meetings. */}
                <div className="text-[10px] text-text-muted pl-5 -mt-1">
                  Modos (normal/compact/stealth): el último elegido (clic "inicio ...", pill/rail, Cmd/Ctrl+M local+global incluso en Meet/Zoom sin ventana, o Shift+M) se usa automáticamente al empezar (UI/tray/atajo/global). Stealth: colores suaves + oculta por defecto + placeholder. Ideal para Meet/Zoom manos ocupadas.
                  <br />Atajos foco contexto (durante grabación, incluso en pill/stealth): Cmd/Ctrl + F (o [ / ]) cicla enfoque (Todo/Dec/Acc/Ries/Pres/Pers) — sin ratón.
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <input type="checkbox" checked={settings.autoProcess} onChange={e => saveSettings({ autoProcess: e.target.checked })} id="auto" />
                  <label htmlFor="auto" className="text-sm">Procesar automáticamente al terminar (próximamente)</label>
                </div>

                {/* Secure auto-updates section (powered by electron-updater from main process) */}
                <div className="pt-2 border-t border-white/10">
                  <label className="text-xs uppercase tracking-widest text-text-muted block mb-1.5">Actualizaciones seguras</label>
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={handleCheckForUpdates} className="btn btn-secondary text-sm" disabled={updateStatus?.type === 'checking'}>
                      {updateStatus?.type === 'checking' ? 'Buscando...' : 'Buscar actualizaciones'}
                    </button>
                    {updateStatus?.type === 'available' && (
                      <button onClick={handleDownloadUpdate} className="btn btn-primary text-sm">
                        Descargar v{updateStatus.version}
                      </button>
                    )}
                    {updateStatus?.type === 'downloaded' && (
                      <button onClick={handleInstallUpdate} className="btn btn-primary text-sm">
                        Instalar v{updateStatus.version} y reiniciar
                      </button>
                    )}
                  </div>
                  {updateStatus && (
                    <div className="text-[10px] text-text-muted mt-1">
                      {updateStatus.type === 'available' && 'Actualización disponible. Descarga para instalar.'}
                      {updateStatus.type === 'downloading' && `Descargando: ${updateStatus.percent || 0}%`}
                      {updateStatus.type === 'downloaded' && 'Lista para instalar. La app se reiniciará.'}
                      {updateStatus.type === 'not-available' && 'Estás en la versión más reciente.'}
                      {updateStatus.type === 'error' && `Error: ${updateStatus.message}`}
                      {updateStatus.type === 'checking' && 'Verificando releases oficiales en GitHub...'}
                    </div>
                  )}
                  <div className="text-[10px] text-text-muted mt-1">
                    Las actualizaciones se verifican y descargan solo desde los releases oficiales de GitHub. Requiere que la app esté firmada para máxima seguridad y compatibilidad con antivirus.
                  </div>
                </div>

                {/* Deep memory / self-improvement management (profundizar la memoria) */}
                <div className="pt-2 border-t border-white/10">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs uppercase tracking-widest text-text-muted">Memoria de auto-mejora (RAG local)</label>
                    <span className="text-[11px] font-mono text-accent/80">{memoryCount} extractos</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setShowMemoryBrowser(!showMemoryBrowser); if (!showMemoryBrowser) { setMemorySearch(''); setMemoryFilter('all') } }}
                      className="btn btn-secondary text-xs flex-1"
                    >
                      {showMemoryBrowser ? 'Ocultar lista' : 'Explorar / gestionar memoria'}
                    </button>
                    <button
                      onClick={handleClearAllMemory}
                      className="btn btn-ghost text-xs text-red-400 border-red-500/30 hover:bg-red-500/10"
                      disabled={memoryCount === 0}
                    >
                      Borrar toda
                    </button>
                  </div>
                  <div className="text-[10px] text-text-muted mt-1">Los extractos (Q/A marcados ★ + insights de informes) se inyectan en prompts futuros para que la IA "recuerde" tu estilo y preferencias. 100% en tu dispositivo.</div>

                  {showMemoryBrowser && (
                    <div className="mt-3 rounded-xl border border-white/10 bg-bg/60 p-3 max-h-64 overflow-auto">
                      <div className="flex gap-2 mb-2">
                        <input
                          className="input text-xs flex-1"
                          placeholder="Buscar en memoria..."
                          value={memorySearch}
                          onChange={(e) => setMemorySearch(e.target.value)}
                        />
                        <button onClick={() => setMemoryFilter('all')} className={`text-[10px] px-2 rounded border ${memoryFilter==='all' ? 'bg-white/10 border-white/20' : 'border-white/10 hover:bg-white/5'}`}>Todas</button>
                        <button onClick={() => setMemoryFilter('starred')} className={`text-[10px] px-2 rounded border ${memoryFilter==='starred' ? 'bg-amber-500/10 border-amber-500/30' : 'border-white/10 hover:bg-white/5'}`}>★ Marcadas</button>
                      </div>
                      {getFilteredMemoryEntries().length === 0 && (
                        <div className="text-xs text-text-muted py-2">Sin entradas que coincidan.</div>
                      )}
                      <div className="space-y-2">
                        {getFilteredMemoryEntries().slice(0, 30).map((entry) => (
                          <div key={entry.id} className="text-[11px] bg-bg/80 rounded p-2 border border-white/5 flex gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="text-text-secondary line-clamp-2">{entry.text}</div>
                              <div className="mt-0.5 flex flex-wrap gap-1 text-[9px] text-text-muted">
                                <span>{new Date(entry.date).toLocaleDateString('es-ES')}</span>
                                {entry.focusUsed && <span className="tag text-[8px] py-0">foco:{entry.focusUsed}</span>}
                                {(entry.tags || []).map((t: string) => <span key={t} className="tag text-[8px] py-0">{t}</span>)}
                                {entry.starred && <span className="text-amber-400">★</span>}
                              </div>
                            </div>
                            <button onClick={() => handleDeleteMemoryEntry(entry.id)} className="text-red-400/70 hover:text-red-400 text-[10px] self-start mt-0.5" title="Eliminar de memoria">×</button>
                          </div>
                        ))}
                      </div>
                      {getFilteredMemoryEntries().length > 30 && <div className="text-[9px] text-text-muted mt-1">Mostrando 30 de {getFilteredMemoryEntries().length}.</div>}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-6 pt-4 border-t border-white/10 flex justify-between text-sm">
                <button onClick={() => setSettingsOpen(false)} className="btn btn-ghost">Cerrar</button>
                <div className="flex gap-2 items-center">
                  <button onClick={async () => {
                    const api = (window as any).electron
                    if (api?.checkForUpdates) {
                      toast('Buscando actualizaciones...')
                      await api.checkForUpdates()
                    }
                  }} className="btn btn-secondary text-xs">Buscar actualizaciones</button>
                  <button onClick={() => { refreshDevices(); toast('Dispositivos actualizados') }} className="btn btn-secondary text-xs">Actualizar micrófonos</button>
                  <span className="text-[10px] text-text-muted ml-2">v{ (window as any).electron?.getAppVersion ? 'cargando...' : '0.1.0' }</span>
                </div>
              </div>

              <div className="mt-4 p-3 bg-bg/60 rounded-xl text-xs text-text-muted leading-snug">
                <strong>Audio del sistema (Google Meet / Zoom):</strong> macOS → BlackHole + dispositivo agregado/multi-salida. Windows → VB-Cable u otro cable virtual. Selecciona el dispositivo correcto antes de grabar. Detalles completos en el README del repositorio.
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Device picker for first record */}
      <AnimatePresence>
        {showDevicePicker && (
          <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-6" onClick={() => setShowDevicePicker(false)}>
            <div className="card w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
              <div className="font-semibold mb-3">Elige dispositivo de entrada de audio</div>
              <div className="text-sm text-text-muted mb-4">Para capturar el audio de Google Meet/Zoom, elige BlackHole (macOS) o un cable virtual de audio (Windows) + micrófono/salida del sistema.</div>
              
              <div className="space-y-1 max-h-64 overflow-auto mb-4">
                {devices.length === 0 && <div className="text-sm text-text-muted py-3">No se detectaron dispositivos. Concede permiso de micrófono.</div>}
                {devices.map((d) => (
                  <button 
                    key={d.deviceId} 
                    onClick={() => { setSelectedDeviceId(d.deviceId); setShowDevicePicker(false); handleStartRecording() }}
                    className="w-full text-left px-4 py-3 rounded-xl hover:bg-white/5 flex justify-between items-center text-sm border border-white/5"
                  >
                    {d.label || 'Dispositivo sin nombre'}
                    {d.deviceId === selectedDeviceId && <span className="text-accent text-xs">Seleccionado</span>}
                  </button>
                ))}
              </div>

              <div className="flex gap-2">
                <button className="btn btn-secondary flex-1" onClick={() => { setShowDevicePicker(false); handleStartRecording() }}>Usar dispositivo por defecto</button>
                <button className="btn btn-ghost" onClick={() => setShowDevicePicker(false)}>Cancelar</button>
              </div>
            </div>
          </div>
        )}
      </AnimatePresence>

      {/* Simple first-time onboarding modal - visual and easy to understand */}
      <AnimatePresence>
        {showOnboarding && (
          <div className="fixed inset-0 bg-black/80 z-[70] flex items-center justify-center p-6" onClick={() => setShowOnboarding(false)}>
            <div className="card max-w-lg w-full p-8" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-start mb-6">
                <div>
                  <div className="font-semibold text-2xl tracking-tight">¡Bienvenido a ReunIA!</div>
                  <div className="text-text-muted text-sm">3 pasos para empezar a grabar reuniones con IA</div>
                </div>
                <button onClick={() => setShowOnboarding(false)} className="text-text-muted hover:text-white">✕</button>
              </div>

              <div className="space-y-5 text-sm">
                <div className="flex gap-4">
                  <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center flex-shrink-0 text-accent font-semibold">1</div>
                  <div>
                    <div className="font-medium">Graba con un clic</div>
                    <div className="text-text-muted">Pulsa el botón grande o usa <span className="font-mono">Cmd/Ctrl + Shift + R</span>. Captura micrófono + audio del sistema (elige BlackHole o VB-Cable en Ajustes la primera vez).</div>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center flex-shrink-0 text-accent font-semibold">2</div>
                  <div>
                    <div className="font-medium">Pregunta en vivo mientras grabas</div>
                    <div className="text-text-muted">En la caja "Asistente en vivo" escribe o usa voz (Cmd/Ctrl+Shift+V). La IA te responde con lo dicho en los últimos minutos. Usa los chips de foco y marca ★ las respuestas importantes.</div>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center flex-shrink-0 text-accent font-semibold">3</div>
                  <div>
                    <div className="font-medium">Obtén el informe completo</div>
                    <div className="text-text-muted">Al terminar genera el informe. Tendrás resumen, insights, asistentes, recomendaciones y to-do. Exporta a PDF/DOCX o abre la carpeta. Todo se organiza solo.</div>
                  </div>
                </div>
              </div>

              <div className="mt-8 flex gap-3">
                <button onClick={() => { setShowOnboarding(false); setSettingsOpen(true); }} className="btn btn-primary flex-1">Abrir Ajustes ahora</button>
                <button onClick={() => setShowOnboarding(false)} className="btn btn-secondary flex-1">Empezar a grabar</button>
              </div>

              <div className="text-[10px] text-center text-text-muted mt-4">Todo queda en tu equipo. 100% privado y seguro.</div>
            </div>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
}
