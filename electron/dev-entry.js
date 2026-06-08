// Dev entry for Electron.
// Run after: npm run dev   (Vite server)
// Then: npx electron electron/dev-entry.js

const { app, BrowserWindow, Tray, Menu } = require('electron')
const path = require('path')

const isDev = !app.isPackaged
const devServerUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'

let mainWindow = null
let tray = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0f1117',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      // Use the compiled preload from tsc
      preload: path.join(__dirname, '../dist-electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })

  // Hide instead of close (tray app behavior)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

function createTray() {
  tray = new Tray(path.join(__dirname, '../public/favicon.svg')) // may be empty icon, ok for dev
  const menu = Menu.buildFromTemplate([
    { label: 'Abrir ReunIA', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Salir', click: () => { app.isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => mainWindow?.show())
}

app.whenReady().then(() => {
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.isQuitting = false
