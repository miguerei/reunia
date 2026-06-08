import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Simple Vite + React config.
// For the full desktop app:
//   1. npm run dev          (or npm run build)
//   2. npx electron dist-electron/main.js   (after compiling main with tsc)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
  clearScreen: false,
})
