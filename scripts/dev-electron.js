#!/usr/bin/env node
// Simple dev launcher for Electron + Vite
const { spawn } = require('child_process')
const { join } = require('path')
const electron = require('electron')

const rendererUrl = 'http://localhost:5173'

console.log('[ReunIA] Waiting for Vite dev server...')
// In real usage you would use wait-on, but for simplicity we just launch after a delay
// User should run `npm run dev` in one terminal and this in another, or use concurrently.

setTimeout(() => {
  console.log('[ReunIA] Launching Electron pointing at Vite...')
  const child = spawn(
    electron,
    [join(__dirname, '..', 'electron', 'dev-entry.js')],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: rendererUrl,
        NODE_ENV: 'development',
      },
    }
  )

  child.on('close', (code) => process.exit(code))
}, 2500)
