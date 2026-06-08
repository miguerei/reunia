import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, dialog, shell, powerSaveBlocker } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import Store from 'electron-store'

// Types
interface AppSettings {
  storagePath: string
  openaiApiKey: string
  language: string
  hotkey: string
  autoProcess: boolean
  preferredModel: string

  // Voice input toggle (Web Speech API in renderer). Persisted for settings consistency.
  enableVoiceInput?: boolean
}

const DEFAULT_SETTINGS: AppSettings = {
  storagePath: '',
  openaiApiKey: '',
  language: 'es',
  hotkey: 'CommandOrControl+Shift+R',
  autoProcess: true,
  preferredModel: 'gpt-4o-mini',

  // Default voice on (renderer only feature)
  enableVoiceInput: true,
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let store: Store<AppSettings>
let powerBlockerId: number | null = null
let isRecording = false

// Companion: narrow always-on-top frameless window for stealth/compact PiP during screen share or second monitor
let companionWindow: BrowserWindow | null = null

// Mirrored preferred recording mode (for global hotkeys, tray cycling, and starting rec from background without relying solely on renderer zustand init).
// Synced with renderer on changes. Persisted in electron-store under 'preferredRecordingMode'.
let preferredRecordingMode: 'normal' | 'compact' | 'stealth' = 'normal'

const isDev = !app.isPackaged

function getResourcePath(...paths: string[]) {
  if (isDev) {
    return join(process.cwd(), ...paths)
  }
  return join(process.resourcesPath, ...paths)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 620,
    title: 'ReunIA',
    backgroundColor: '#0f1117',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Prevent close on red button, just hide (common for tray apps)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

function createCompanionWindow() {
  if (companionWindow && !companionWindow.isDestroyed()) {
    companionWindow.focus()
    companionWindow.show()
    return
  }

  // Narrow ~340px always-on-top frameless PiP for compact/stealth during meetings (Google Meet/Zoom screen share).
  // Exact spec width (~340px) for minimal always-on-top companion with status/focus chips/ask/voice (forwards to primary for memory/phases/full features).
  // Squatter default height for lower screen profile + easy one-click from pill/banner.
  // Resizable so user can tune; position prefers top-right (non-intrusive).
  // Autonomous enhancement: persist last user-chosen position/size across sessions (critical for PiP muscle-memory
  // during recurring meetings on multi-monitor or specific screen-share setups). Falls back to sensible default.
  const { screen } = require('electron')
  const primary = screen.getPrimaryDisplay()
  const { width: workW, height: workH } = primary.workAreaSize
  const cW = 340
  const cH = 380 // lower profile than 460 for "pill" companion feel while still usable
  const defaultX = Math.max(40, workW - cW - 40)
  const defaultY = 60

  // Load persisted bounds (if valid within current work area)
  const savedBounds = (store.get('companionBounds') as any) || null
  let useX = defaultX, useY = defaultY, useW = cW, useH = cH
  if (savedBounds && typeof savedBounds.x === 'number' && typeof savedBounds.y === 'number' &&
      typeof savedBounds.width === 'number' && typeof savedBounds.height === 'number') {
    // Basic sanity: keep within reasonable screen bounds (don't restore off-screen)
    useW = Math.max(300, Math.min(380, savedBounds.width))
    useH = Math.max(280, Math.min(520, savedBounds.height))
    useX = Math.max(0, Math.min(workW - 100, savedBounds.x))
    useY = Math.max(0, Math.min(workH - 100, savedBounds.y))
  }

  companionWindow = new BrowserWindow({
    width: useW,
    height: useH,
    x: useX,
    y: useY,
    minWidth: 300,
    maxWidth: 380,
    minHeight: 280,
    frame: false,
    transparent: false,
    backgroundColor: '#0f1117',
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const url = isDev
    ? 'http://localhost:5173?companion=1'
    : `file://${join(__dirname, '../dist/index.html')}?companion=1`

  companionWindow.loadURL(url)

  companionWindow.on('closed', () => {
    companionWindow = null
  })

  // Persist bounds on move/resize (debounce lightly via setTimeout to avoid spam; also save on close)
  let boundsSaveTimer: NodeJS.Timeout | null = null
  const saveCompanionBounds = () => {
    if (!companionWindow || companionWindow.isDestroyed()) return
    const b = companionWindow.getBounds()
    store.set('companionBounds', { x: b.x, y: b.y, width: b.width, height: b.height })
  }
  const scheduleSave = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
    boundsSaveTimer = setTimeout(saveCompanionBounds, 400)
  }
  companionWindow.on('moved', scheduleSave)
  companionWindow.on('resized', scheduleSave)
  // Use 'close' (before destroy) for reliable last bounds capture; 'closed' already clears ref.
  companionWindow.on('close', () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer)
    saveCompanionBounds()
  })

  // High-impact for real meetings / screen sharing (Zoom/Meet fullscreen/presentation):
  // Use 'floating' level (above most windows) + visible on all workspaces/fullscreen.
  // ~340px narrow PiP stays reliably on top without stealing focus or being captured.
  // (Preserves existing IPC sync/forward for asks/focus/voice — primary still does all heavy lifting + memory/phases/etc.)
  companionWindow.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') {
    companionWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
}

function createTray() {
  // Use a simple template icon (we can improve later with real asset)
  const iconPath = getResourcePath('public', 'favicon.svg')
  let trayIcon: Electron.NativeImage

  if (existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
  } else {
    trayIcon = nativeImage.createEmpty()
  }

  tray = new Tray(trayIcon)
  tray.setToolTip('ReunIA - Grabador de reuniones')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir ReunIA',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        } else {
          createWindow()
        }
      },
    },
    { type: 'separator' },
    {
      id: 'record',
      label: '●  Empezar a grabar',
      accelerator: 'CommandOrControl+Shift+R',
      click: () => {
        mainWindow?.webContents.send('recording:toggle', 'start')
      },
    },
    {
      id: 'stop',
      label: '■  Detener grabación',
      enabled: false,
      click: () => {
        mainWindow?.webContents.send('recording:toggle', 'stop')
      },
    },
    { type: 'separator' },
    {
      label: `Modo grabación: ${preferredRecordingMode} (Cmd/Ctrl+M o Shift+M o tray)`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Abrir carpeta de grabaciones',
      click: async () => {
        const settings = await store.get('settings', DEFAULT_SETTINGS) as AppSettings
        const path = settings.storagePath || app.getPath('documents') + '/ReunIA'
        shell.openPath(path)
      },
    },
    { type: 'separator' },
    {
      label: 'Salir de ReunIA',
      click: () => {
        app.isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide()
      else mainWindow.show()
    } else createWindow()
  })
}

function updateTrayMenu(recording: boolean, elapsed?: string) {
  if (!tray) return
  isRecording = recording

  const currentMode = preferredRecordingMode
  const modeLabel = currentMode === 'stealth' ? 'Stealth (bajo perfil)' : currentMode === 'compact' ? 'Compacto (pill)' : 'Normal (completo)'
  const nextMode = currentMode === 'normal' ? 'compact' : currentMode === 'compact' ? 'stealth' : 'normal'

  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir ReunIA',
      click: () => mainWindow?.show(),
    },
    { type: 'separator' },
    recording
      ? {
          id: 'stop',
          label: `■  Detener (${elapsed || ''})`,
          click: () => mainWindow?.webContents.send('recording:toggle', 'stop'),
        }
      : {
          id: 'record',
          label: '●  Empezar a grabar (Cmd/Ctrl+Shift+R)',
          click: () => mainWindow?.webContents.send('recording:toggle', 'start'),
        },
    { type: 'separator' },
    // High-impact: choose or cycle preferred recording mode directly from tray (no need to open window or remember hotkeys).
    // Last choice is auto-used on any record start (global hotkey, tray, or UI). Brilliant for meeting users who live in compact/stealth.
    {
      label: `Modo preferido: ${modeLabel}`,
      enabled: false,
    },
    {
      label: `  Ciclar a ${nextMode === 'normal' ? 'Normal' : nextMode === 'compact' ? 'Compacto' : 'Stealth'} (Cmd/Ctrl+M o Shift+M)`,
      click: () => {
        const modes: Array<'normal' | 'compact' | 'stealth'> = ['normal', 'compact', 'stealth']
        const idx = modes.indexOf(preferredRecordingMode)
        const next = modes[(idx + 1) % modes.length]
        preferredRecordingMode = next
        store.set('preferredRecordingMode', next)
        updateTrayMenu(isRecording)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('recording:mode', next)
        }
      },
    },
    {
      label: '  Usar Normal al grabar',
      type: 'checkbox',
      checked: currentMode === 'normal',
      click: () => {
        preferredRecordingMode = 'normal'
        store.set('preferredRecordingMode', 'normal')
        updateTrayMenu(isRecording)
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording:mode', 'normal')
      },
    },
    {
      label: '  Usar Compacto (pill) al grabar',
      type: 'checkbox',
      checked: currentMode === 'compact',
      click: () => {
        preferredRecordingMode = 'compact'
        store.set('preferredRecordingMode', 'compact')
        updateTrayMenu(isRecording)
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording:mode', 'compact')
      },
    },
    {
      label: '  Usar Stealth (mínimo) al grabar',
      type: 'checkbox',
      checked: currentMode === 'stealth',
      click: () => {
        preferredRecordingMode = 'stealth'
        store.set('preferredRecordingMode', 'stealth')
        updateTrayMenu(isRecording)
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('recording:mode', 'stealth')
      },
    },
    { type: 'separator' },
    // High-impact autonomous addition: one-click open narrow always-on-top PiP companion directly from tray (even when main hidden).
    // Perfect for screen-share flows or when using global hotkeys only. Uses existing companion creation + signals renderer via known channel to hide + minimize (keeps IPC minimal, forwards to primary for full features).
    recording ? {
      label: '📍 Abrir PiP compañero (always-on-top)',
      click: () => {
        createCompanionWindow()
        if (mainWindow && !mainWindow.isDestroyed()) {
          // High-impact: signal renderer (using a dedicated minimal channel we expose) to hide + minimize (exactly as the in-app PiP button does).
          // Keeps IPC surface tiny + consistent with existing companion/minimize patterns. Primary still owns all state/features.
          mainWindow.webContents.send('companion:trigger-hide-and-minimize')
        }
      },
    } : null,
    {
      label: 'Abrir carpeta de grabaciones',
      click: async () => {
        const s = (await store.get('settings')) as AppSettings
        const p = s?.storagePath || join(app.getPath('documents'), 'ReunIA')
        shell.openPath(p)
      },
    },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit() } },
  ] as any)
  tray.setContextMenu(menu)
  tray.setToolTip(recording ? `ReunIA • Grabando ${elapsed || ''} • ${currentMode}` : `ReunIA • Listo • modo ${currentMode}`)
}

function registerGlobalShortcut() {
  const key = (store.get('settings') as any)?.hotkey || DEFAULT_SETTINGS.hotkey
  globalShortcut.register(key, () => {
    if (mainWindow) {
      mainWindow.webContents.send('recording:toggle', isRecording ? 'stop' : 'start')
    } else {
      createWindow()
      // delay a bit so window is ready
      setTimeout(() => {
        mainWindow?.webContents.send('recording:toggle', 'start')
      }, 600)
    }
  })
}

// Fixed complementary global hotkey for voice input (brilliant hands-busy UX during meetings).
// Independent of the (configurable) record hotkey. Works even if main window is hidden/backgrounded.
// Prefers companion PiP (if open) for screen-share / minimal-distraction flows; falls back to main (shows+focuses it).
function registerGlobalVoiceShortcut() {
  const VOICE_HOTKEY = 'CommandOrControl+Shift+V'
  try {
    globalShortcut.register(VOICE_HOTKEY, () => {
      const hasCompanion = companionWindow && !companionWindow.isDestroyed()
      if (hasCompanion) {
        // PiP users: target the always-on-top companion for voice (low distraction)
        companionWindow!.webContents.send('voice:toggle')
        if (!companionWindow!.isVisible()) companionWindow!.show()
        companionWindow!.focus()
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('voice:toggle')
      } else {
        createWindow()
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.focus()
            mainWindow.webContents.send('voice:toggle')
          }
        }, 650)
      }
    })
  } catch (e) {
    console.warn('Could not register global voice hotkey', e)
  }
}

// Global hotkey to cycle preferred recording mode (normal/compact/stealth) for next recording.
// High-impact for meeting prep: Cmd/Ctrl+M (and Shift+M) sets your low-distraction pref from anywhere (even without ReunIA visible / during screen share in Meet/Zoom).
// Matches local Cmd/Ctrl+M in window + example in UX spec. Updates tray, persists, and syncs to open renderer window so pre-record indicator + auto-start use it immediately.
function registerGlobalModeCycleShortcut() {
  const modes: Array<'normal' | 'compact' | 'stealth'> = ['normal', 'compact', 'stealth']
  const doCycle = () => {
    const idx = modes.indexOf(preferredRecordingMode)
    const next = modes[(idx + 1) % modes.length]
    preferredRecordingMode = next
    store.set('preferredRecordingMode', next)

    // Sync to open main window (updates zustand + UI indicators + next auto-start behavior)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording:mode', next)
    }
    // If companion open, it can stay minimal (no full mode state needed there)
    updateTrayMenu(isRecording) // refresh labels if tray shows mode info
  }
  try {
    // Primary: plain Cmd/Ctrl+M (high-impact per spec for cycle; non-conflicting with record Shift+R)
    globalShortcut.register('CommandOrControl+M', doCycle)
    // Also support Shift variant for discoverability / muscle memory from prior versions
    globalShortcut.register('CommandOrControl+Shift+M', doCycle)
  } catch (e) {
    console.warn('Could not register global mode cycle hotkey(s)', e)
  }
}

function setupIpc() {
  // Settings
  ipcMain.handle('settings:get', async () => {
    let s = store.get('settings') as AppSettings | undefined
    if (!s) {
      const defaultPath = join(app.getPath('documents'), 'ReunIA')
      if (!existsSync(defaultPath)) mkdirSync(defaultPath, { recursive: true })
      s = { ...DEFAULT_SETTINGS, storagePath: defaultPath }
      store.set('settings', s)
    }
    return s
  })

  ipcMain.handle('settings:set', async (_e, newSettings: Partial<AppSettings>) => {
    const current = (store.get('settings') || {}) as AppSettings
    const merged = { ...current, ...newSettings }
    store.set('settings', merged)

    // Re-register hotkey if changed. Also re-register companion voice + mode cycle globals (Cmd/Ctrl+M, Shift+V etc) since unregisterAll clears everything.
    // High-impact: ensures global mode cycle (Cmd/Ctrl+M for compact/stealth pref) and voice hotkey remain reliable even after changing record hotkey in Ajustes.
    if (newSettings.hotkey) {
      globalShortcut.unregisterAll()
      registerGlobalShortcut()
      registerGlobalVoiceShortcut()
      registerGlobalModeCycleShortcut()
    }
    return merged
  })

  ipcMain.handle('dialog:select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Shell
  ipcMain.handle('shell:open-path', async (_e, p: string) => {
    return shell.openPath(p)
  })
  ipcMain.on('shell:show-item-in-folder', (_e, fullPath: string) => {
    shell.showItemInFolder(fullPath)
  })

  ipcMain.handle('app:get-version', () => app.getVersion())

  // Recording state from renderer
  ipcMain.on('tray:update-recording', (_e, { isRecording, elapsed }) => {
    updateTrayMenu(isRecording, elapsed)
    if (isRecording && !powerBlockerId) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (!isRecording && powerBlockerId) {
      powerSaveBlocker.stop(powerBlockerId)
      powerBlockerId = null
    }
  })

  // Placeholder for future native recording (ffmpeg sidecar etc.)
  ipcMain.handle('recording:start-native', async () => ({ success: false, error: 'Usando grabación en navegador por ahora' }))
  ipcMain.handle('recording:stop-native', async () => ({ success: false }))

  // Save complete session (audio + json + md) to the storage folder
  ipcMain.handle('session:save-full', async (_event, payload: { folderName: string; session: any; transcript?: string; report?: any; audioBuffer: ArrayBuffer }) => {
    try {
      const settings = (store.get('settings') || {}) as any
      const base = settings.storagePath || join(app.getPath('documents'), 'ReunIA')
      const folderPath = join(base, payload.folderName)

      if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true })

      const { writeFileSync } = await import('fs')

      // Audio
      const audioExt = 'webm'
      writeFileSync(join(folderPath, `audio.${audioExt}`), Buffer.from(payload.audioBuffer))

      // Metadata: always write full payload.session (carries liveQAs, hasReport etc). If report present in payload, force hasReport:true in the persisted session for reliable reconstruction.
      const sessToWrite = payload.report ? { ...payload.session, hasReport: true } : payload.session
      writeFileSync(join(folderPath, 'metadata.json'), JSON.stringify(sessToWrite, null, 2))

      if (payload.transcript) {
        writeFileSync(join(folderPath, 'transcript.txt'), payload.transcript)
      }
      if (payload.report) {
        writeFileSync(join(folderPath, 'report.json'), JSON.stringify(payload.report, null, 2))
        // Also nice markdown
        const md = generateReportMarkdown(payload.session, payload.report)
        writeFileSync(join(folderPath, 'informe.md'), md)
      }

      console.log(`[memory] session:save-full folder:${payload.folderName} liveQAs:${payload.session?.liveQAs?.length || 0} hasReport:${!!payload.report}`)
      return { success: true, folderPath }
    } catch (err: any) {
      console.error('Failed to save session:', err)
      return { success: false, error: err?.message }
    }
  })

  // List sessions by scanning storage folder's metadata.json (robust persistence for liveQAs + starred data)
  ipcMain.handle('sessions:list', async () => {
    try {
      const settings = (store.get('settings') || {}) as any
      const base = settings.storagePath || join(app.getPath('documents'), 'ReunIA')
      if (!existsSync(base)) return []
      const dirents = readdirSync(base, { withFileTypes: true })
      const results: any[] = []
      for (const ent of dirents) {
        if (!ent.isDirectory()) continue
        const metaPath = join(base, ent.name, 'metadata.json')
        if (existsSync(metaPath)) {
          try {
            const raw = readFileSync(metaPath, 'utf8')
            const sess = JSON.parse(raw)
            sess.folderPath = join(base, ent.name)
            // Harden: ensure hasReport reflects presence of report.json on disk (in case metadata flag lagged or save used stale session obj).
            // This makes list carry accurate hasReport for UI badges and detail views (App also uses currentSessionData for full report obj).
            const reportPath = join(base, ent.name, 'report.json')
            if (existsSync(reportPath)) {
              sess.hasReport = true
            }
            // Minor helper comment: future "index report insights" could read report.json here and feed high-signal summary/insights to memory index (beyond just starred liveQAs).
            // For now only liveQAs stars are indexed (via indexStarredFromSession on load/add).
            results.push(sess)
          } catch (e) {
            console.warn('Skipping bad metadata.json in', ent.name)
          }
        }
      }
      results.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
      return results
    } catch (e) {
      console.error('sessions:list error', e)
      return []
    }
  })

  // Memory index (local-only JSON in userData for self-improvement seeds)
  function getMemoryPath() {
    return join(app.getPath('userData'), 'reunia-memory.json')
  }

  // === Companion window + live state sync (supports compact/stealth always-on-top PiP) ===
  ipcMain.on('companion:open', () => {
    createCompanionWindow()
  })
  ipcMain.on('companion:close', () => {
    if (companionWindow && !companionWindow.isDestroyed()) companionWindow.close()
  })

  // Forward asks and focus changes from companion -> primary window (so full features, voice, memory injection, stars etc remain in primary logic)
  ipcMain.on('companion:ask', (_e, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('companion:ask', payload)
    }
  })
  ipcMain.on('companion:focus', (_e, focus) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('companion:focus', focus)
    }
  })
  // Forward star-last from companion PiP (minimal IPC; primary toggles starred on its current last liveQA so memory index picks it up on stop).
  ipcMain.on('companion:star-last', (_e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('companion:star-last')
    }
  })

  // Live state pushed from primary -> companion renderer (elapsed, focus, last QA, loading phases, transcript snippet)
  ipcMain.on('live:update', (_e, data) => {
    if (companionWindow && !companionWindow.isDestroyed()) {
      companionWindow.webContents.send('live:update', data)
    }
  })

  // Minimal IPC for "one-click companion + low profile main" (high-impact during screen share / hands-busy meetings).
  // Renderer calls this after openCompanion() when recording: minimizes primary so main chrome/history isn't on shared screen or adding visual noise.
  // Easy restore via tray / dock / global hotkey. Consistent with stealth/compact philosophy. No new windows or complexity.
  ipcMain.on('main:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize()
    }
  })

  // === Preferred recording mode (compact/stealth) sync for tray, global hotkeys, and background starts ===
  ipcMain.handle('recording-mode:get', () => preferredRecordingMode)
  ipcMain.on('recording-mode:set', (_e, mode: 'normal' | 'compact' | 'stealth') => {
    if (mode === 'normal' || mode === 'compact' || mode === 'stealth') {
      preferredRecordingMode = mode
      store.set('preferredRecordingMode', mode)
      // Keep tray in sync
      updateTrayMenu(isRecording)
      // Push to renderer if open (so live pre-record indicator + store update)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording:mode', mode)
      }
    }
  })

  // Renderer notifies main when it cycles (for consistency with global/tray)
  ipcMain.on('recording:mode-changed', (_e, mode: 'normal' | 'compact' | 'stealth') => {
    if (mode === 'normal' || mode === 'compact' || mode === 'stealth') {
      preferredRecordingMode = mode
      store.set('preferredRecordingMode', mode)
      updateTrayMenu(isRecording)
    }
  })

  ipcMain.handle('memory:load', async () => {
    try {
      const p = getMemoryPath()
      if (!existsSync(p)) return []
      const raw = readFileSync(p, 'utf8')
      const arr = JSON.parse(raw)
      const result = Array.isArray(arr) ? arr : []
      console.log(`[memory] load count:${result.length}`)
      return result
    } catch {
      console.log(`[memory] load count:0 (error/empty)`)
      return []
    }
  })

  ipcMain.handle('memory:save', async (_e, entries: any[]) => {
    try {
      const p = getMemoryPath()
      const dir = join(app.getPath('userData'))
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, JSON.stringify(entries || [], null, 2))
      console.log(`[memory] save count:${(entries || []).length}`)
      return true
    } catch (e) {
      console.error('memory:save failed', e)
      return false
    }
  })

  ipcMain.handle('memory:index-entries', async (_e, newEntries: any[]) => {
    try {
      const p = getMemoryPath()
      let existing: any[] = []
      if (existsSync(p)) {
        try {
          const raw = readFileSync(p, 'utf8')
          existing = JSON.parse(raw) || []
          if (!Array.isArray(existing)) existing = []
        } catch {}
      }
      const byId = new Map<string, any>(existing.map((e: any) => [e.id, e]))
      let added = 0
      for (const ne of (newEntries || [])) {
        if (!ne || !ne.id) continue
        if (!byId.has(ne.id)) {
          byId.set(ne.id, ne)
          added++
        } else {
          byId.set(ne.id, { ...byId.get(ne.id), ...ne })
        }
      }
      const merged = Array.from(byId.values())
      const dir = app.getPath('userData')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, JSON.stringify(merged, null, 2))
      console.log(`[memory] index-entries added:${added} total:${merged.length}`)
      return added
    } catch (e) {
      console.error('memory:index-entries failed', e)
      return 0
    }
  })

  ipcMain.handle('memory:clear', async () => {
    try {
      const p = getMemoryPath()
      if (existsSync(p)) {
        unlinkSync(p)
      } else {
        // Write empty array to ensure file exists as []
        const dir = join(app.getPath('userData'))
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(p, '[]')
      }
      console.log(`[memory] clear -> []`)
      return true
    } catch (e) {
      console.error('memory:clear failed', e)
      return false
    }
  })

  // === Secure Auto-Updates (electron-updater) ===
  // All update logic stays in main process (key security: no updater code or network in renderer).
  // Events are forwarded safely to renderer for UI only.
  ipcMain.handle('update:check', async () => {
    if (isDev) return { type: 'dev-mode' }
    try {
      const result = await autoUpdater.checkForUpdates()
      return { type: 'checking', result: result?.updateInfo?.version || null }
    } catch (e: any) {
      return { type: 'error', message: e?.message || 'Error al buscar actualizaciones' }
    }
  })

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { type: 'downloading' }
    } catch (e: any) {
      return { type: 'error', message: e?.message || 'Error al descargar' }
    }
  })

  ipcMain.handle('update:install', () => {
    // false = no silent, true = force restart
    autoUpdater.quitAndInstall(false, true)
  })
}

function ensureStorage() {
  const userData = app.getPath('userData')
  const recordingsDir = join(app.getPath('documents'), 'ReunIA')
  if (!existsSync(recordingsDir)) {
    mkdirSync(recordingsDir, { recursive: true })
  }
  return recordingsDir
}

// Secure auto-updater setup (using electron-updater + GitHub releases)
// Security notes as cybersecurity expert:
// - Only updates from official GitHub repo releases (tamper-proof via GitHub + code signing verification when signed).
// - autoDownload = false gives user control (privacy, avoid unwanted bandwidth).
// - All events forwarded safely via IPC (no direct renderer access to updater).
// - In production packaged app only. Dev mode disabled.
// - For full security: app must be code-signed + notarized (mac) / signed (win). Unsigned updates can be MITM'd or flagged by AV.
// - electron-updater verifies signatures on supported platforms when certs are configured in electron-builder.
// - No extra data sent beyond what's needed for GitHub release check (version, platform). Respects local-first philosophy.
function sendToRenderer(channel: string, ...args: any[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function setupAutoUpdater() {
  if (isDev) {
    console.log('[updater] Auto-updates disabled in development mode')
    return
  }

  autoUpdater.autoDownload = false // User explicitly triggers download (better privacy & control)

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer('update:status', { type: 'checking' })
  })

  autoUpdater.on('update-available', (info: any) => {
    sendToRenderer('update:status', {
      type: 'available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  autoUpdater.on('update-not-available', () => {
    sendToRenderer('update:status', { type: 'not-available' })
  })

  autoUpdater.on('error', (err: any) => {
    console.error('[updater] Error:', err)
    sendToRenderer('update:status', { type: 'error', message: err.message || 'Error desconocido' })
  })

  autoUpdater.on('download-progress', (progressObj: any) => {
    sendToRenderer('update:status', {
      type: 'downloading',
      percent: Math.round(progressObj.percent),
      bytesPerSecond: progressObj.bytesPerSecond,
      transferred: progressObj.transferred,
      total: progressObj.total
    })
  })

  autoUpdater.on('update-downloaded', (info: any) => {
    sendToRenderer('update:status', {
      type: 'downloaded',
      version: info.version
    })
  })
}

app.whenReady().then(() => {
  // Init store with encryption for the OpenAI key and other settings (protects against casual inspection of the JSON file in userData).
  // Note (cybersecurity): This is symmetric encryption with a fixed key (obfuscation, not HSM-level). A local attacker with debugger or the key can still read it.
  // For higher security, consider keytar (OS keychain) in a future version. The app remains local-first with no telemetry.
  store = new Store<AppSettings>({
    name: 'reunia-settings',
    encryptionKey: 'reunia-secure-local-v1' // Fixed per-app key for at-rest protection of API keys
  })

  // Load persisted preferred recording mode (compact/stealth support for low-distraction)
  const storedMode = store.get('preferredRecordingMode') as any
  if (storedMode === 'compact' || storedMode === 'stealth' || storedMode === 'normal') {
    preferredRecordingMode = storedMode
  }

  ensureStorage()
  setupIpc()
  setupAutoUpdater()
  createWindow()
  createTray()
  registerGlobalShortcut()
  registerGlobalVoiceShortcut()
  registerGlobalModeCycleShortcut()
  updateTrayMenu(false) // ensure tray reflects persisted preferred mode on launch

  // Silent check for updates shortly after launch (production only, respects privacy as user can ignore)
  if (!isDev) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {
        // Silent fail - user can manually check in settings
      })
    }, 8000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (powerBlockerId) powerSaveBlocker.stop(powerBlockerId)
})

// For electron-builder
app.setAsDefaultProtocolClient('reunia')

// Mark for close handling
declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean
    }
  }
}
app.isQuitting = false

function generateReportMarkdown(session: any, report: any): string {
  return `# ${session.title}

**Fecha:** ${new Date(session.date).toLocaleString('es-ES')}
**Duración:** ${Math.floor((session.durationSec || 0) / 60)} minutos

## Resumen

${report.summary || ''}

## Insights clave

${(report.keyInsights || []).map((i: string) => `- ${i}`).join('\n')}

## Personas asistentes

${(report.attendees || []).map((p: string) => `- ${p}`).join('\n') || '_No detectadas_'}

## Personas que intervinieron

${(report.speakers || []).map((p: string) => `- ${p}`).join('\n') || '_No detectadas_'}

## Recomendaciones

${(report.recommendations || []).map((r: string) => `- ${r}`).join('\n')}

## Consejos

${(report.advice || []).map((a: string) => `- ${a}`).join('\n')}

## Lista de acciones (To-Do)

${(report.todoList || []).map((t: any) => `- [${t.done ? 'x' : ' '}] ${t.task || t}`).join('\n')}

---
*Generado por ReunIA • ${new Date().toISOString()}*
`
}
