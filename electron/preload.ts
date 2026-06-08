import { contextBridge, ipcRenderer } from 'electron'

export type ElectronAPI = {
  // Settings & storage
  getSettings: () => Promise<any>
  setSettings: (settings: any) => Promise<any>
  selectDirectory: () => Promise<string | null>

  // Recording control (for future native recording improvements)
  startNativeRecording: (options: { deviceId?: string; outputPath: string }) => Promise<{ success: boolean; error?: string }>
  stopNativeRecording: () => Promise<{ success: boolean; filePath?: string }>

  // App controls
  openPath: (path: string) => Promise<void>
  showItemInFolder: (fullPath: string) => void
  getAppVersion: () => Promise<string>

  // Tray / recording state sync
  updateTrayRecording: (isRecording: boolean, elapsed?: string) => void

  // Full session save (audio + reports)
  saveFullSession: (payload: {
    folderName: string
    session: any
    transcript?: string
    report?: any
    audioBuffer: ArrayBuffer
  }) => Promise<{ success: boolean; folderPath?: string; error?: string }>

  // Sessions from disk (ensures liveQAs with starred / focusUsed / tags survive restarts via metadata.json round-trip)
  listSessions: () => Promise<any[]>,

  // Lightweight local memory index for self-improvement (stays 100% on device, never sent anywhere)
  loadMemory: () => Promise<any[]>,
  saveMemory: (entries: any[]) => Promise<void>,
  indexMemoryEntries: (entries: any[]) => Promise<number>,
  clearMemory: () => Promise<boolean>,

  // Listeners
  onRecordingToggle: (callback: (action: 'start' | 'stop') => void) => () => void,

  // === Compact / Stealth / Companion for low-distraction live during meetings ===
  // Open a narrow (~340px), frameless, alwaysOnTop secondary window (PiP companion) sharing live state via IPC.
  // Minimal UI (status, focus chips, ask input, mini voice); asks/focus/star/mode forwarded to primary (full features: voice, memory RAG, phases, etc preserved).
  openCompanion: () => void,
  closeCompanion: () => void,
  // From companion (or main controls) -> forward ask/focus to primary window's live assistant (preserves all features)
  sendCompanionAsk: (question: string, focus?: string | null) => void,
  sendCompanionFocus: (focus: string | null) => void,
  // High-impact for PiP: allow starring the *last* live QA from the narrow companion (so memory/RAG/self-improvement works without switching windows).
  // Minimal forward; primary handles the toggle on current last item.
  sendCompanionStarLast: () => void,
  // Push live state updates from primary renderer -> companion (timer, focus, last answers, phased loading)
  sendLiveUpdate: (data: any) => void,

  // Minimal one-click support: minimize primary (clear main UI from screen share / reduce distraction) when launching companion PiP.
  // Called from renderer pill/banner during active recording. Restore via tray/dock/global hotkeys. Uses existing IPC patterns.
  minimizeMain: () => void,

  // Listeners used by companion (or main)
  onCompanionAsk: (callback: (payload: { question: string; focus?: string | null }) => void) => () => void,
  onCompanionFocus: (callback: (focus: string | null) => void) => () => void,
  onLiveUpdate: (callback: (data: any) => void) => () => void,
  // Listener (in primary) for star-last forwarded from companion PiP.
  onCompanionStarLast: (callback: () => void) => () => void,

  // Minimal IPC for tray "open PiP" action (high-impact discoverability): tells primary to hide live chrome + minimize (so PiP is the surface).
  // Re-uses the same hide+minimizeMain behavior as banner/PiP button. No new state.
  onCompanionTriggerHideAndMinimize: (callback: () => void) => () => void,

  // (internal for tray PiP trigger; exposed via the on* above)

  // Voice input global hotkey support (hands-busy during meetings: Cmd/Ctrl+Shift+V even if window not frontmost).
  // Complements the local renderer shortcut + tray. Delivered via IPC to the appropriate window (main or companion).
  onVoiceToggle: (callback: () => void) => () => void,

  // === Recording mode (compact/stealth) cross-process sync ===
  // Get/set preferred mode (used for auto on record start, tray, global Shift+M cycle).
  // Renderer calls set when user cycles in UI; main pushes updates via onRecordingMode.
  getPreferredRecordingMode: () => Promise<'normal' | 'compact' | 'stealth'>,
  setPreferredRecordingMode: (mode: 'normal' | 'compact' | 'stealth') => void,
  // Notify main (for tray/global consistency) when renderer changes mode (activates 'recording:mode-changed' path + belt/suspenders with setPreferred).
  notifyRecordingModeChanged: (mode: 'normal' | 'compact' | 'stealth') => void,
  // Listener for pushes from main (global hotkey / tray changes / background sync)
  onRecordingMode: (callback: (mode: 'normal' | 'compact' | 'stealth') => void) => () => void,

  // === Secure auto-updates (implemented entirely in main process for security) ===
  // Renderer only receives status events and can trigger check/download/install via IPC.
  // This prevents any updater logic or network calls from the more exposed renderer.
  checkForUpdates: () => Promise<any>,
  downloadUpdate: () => Promise<any>,
  quitAndInstallUpdate: () => void,
  onUpdateStatus: (callback: (status: any) => void) => () => void,
}

const electronAPI: ElectronAPI = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),

  startNativeRecording: (options) => ipcRenderer.invoke('recording:start-native', options),
  stopNativeRecording: () => ipcRenderer.invoke('recording:stop-native'),

  openPath: (path) => ipcRenderer.invoke('shell:open-path', path),
  showItemInFolder: (fullPath) => ipcRenderer.send('shell:show-item-in-folder', fullPath),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  updateTrayRecording: (isRecording, elapsed) =>
    ipcRenderer.send('tray:update-recording', { isRecording, elapsed }),

  saveFullSession: (payload) => ipcRenderer.invoke('session:save-full', payload),

  // Sessions from disk (ensures liveQAs with starred / focusUsed / tags survive restarts via metadata.json round-trip)
  listSessions: () => ipcRenderer.invoke('sessions:list'),

  // Lightweight local memory index for self-improvement (stays 100% on device, never sent anywhere)
  // clearMemory: full end-to-end for clearing local reunia-memory.json (renderer->preload->main->fs)
  loadMemory: () => ipcRenderer.invoke('memory:load'),
  saveMemory: (entries) => ipcRenderer.invoke('memory:save', entries),
  indexMemoryEntries: (entries) => ipcRenderer.invoke('memory:index-entries', entries),
  clearMemory: () => ipcRenderer.invoke('memory:clear'),

  onRecordingToggle: (callback) => {
    const handler = (_: any, action: 'start' | 'stop') => callback(action)
    ipcRenderer.on('recording:toggle', handler)
    return () => ipcRenderer.removeListener('recording:toggle', handler)
  },

  // Companion + live sync (for compact/stealth PiP companion window)
  openCompanion: () => ipcRenderer.send('companion:open'),
  closeCompanion: () => ipcRenderer.send('companion:close'),
  sendCompanionAsk: (question, focus) => ipcRenderer.send('companion:ask', { question, focus }),
  sendCompanionFocus: (focus) => ipcRenderer.send('companion:focus', focus),
  sendCompanionStarLast: () => ipcRenderer.send('companion:star-last'),
  sendLiveUpdate: (data) => ipcRenderer.send('live:update', data),

  // One-click companion + minimize primary (for screen-share safety + ultra-low distraction in compact/stealth flows)
  minimizeMain: () => ipcRenderer.send('main:minimize'),

  onCompanionAsk: (callback) => {
    const handler = (_: any, payload: { question: string; focus?: string | null }) => callback(payload)
    ipcRenderer.on('companion:ask', handler)
    return () => ipcRenderer.removeListener('companion:ask', handler)
  },
  onCompanionFocus: (callback) => {
    const handler = (_: any, focus: string | null) => callback(focus)
    ipcRenderer.on('companion:focus', handler)
    return () => ipcRenderer.removeListener('companion:focus', handler)
  },
  onLiveUpdate: (callback) => {
    const handler = (_: any, data: any) => callback(data)
    ipcRenderer.on('live:update', handler)
    return () => ipcRenderer.removeListener('live:update', handler)
  },
  onCompanionStarLast: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('companion:star-last', handler)
    return () => ipcRenderer.removeListener('companion:star-last', handler)
  },

  // Tray PiP trigger (minimal, forwards to primary renderer logic for hide+minimize)
  onCompanionTriggerHideAndMinimize: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('companion:trigger-hide-and-minimize', handler)
    return () => ipcRenderer.removeListener('companion:trigger-hide-and-minimize', handler)
  },

  // Voice toggle (global hotkey from main process)
  onVoiceToggle: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('voice:toggle', handler)
    return () => ipcRenderer.removeListener('voice:toggle', handler)
  },

  // Recording mode pref sync (for compact/stealth low-distraction)
  getPreferredRecordingMode: () => ipcRenderer.invoke('recording-mode:get'),
  setPreferredRecordingMode: (mode) => ipcRenderer.send('recording-mode:set', mode),
  notifyRecordingModeChanged: (mode) => ipcRenderer.send('recording:mode-changed', mode),
  onRecordingMode: (callback) => {
    const handler = (_: any, mode: 'normal' | 'compact' | 'stealth') => callback(mode)
    ipcRenderer.on('recording:mode', handler)
    return () => ipcRenderer.removeListener('recording:mode', handler)
  },

  // Secure update controls (calls are forwarded; status comes from main only)
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const handler = (_: any, status: any) => callback(status)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  },
}

contextBridge.exposeInMainWorld('electron', electronAPI)

// Also expose a small util for audio device enumeration (renderer side is fine but we can help)
contextBridge.exposeInMainWorld('reunia', {
  platform: process.platform,
})
