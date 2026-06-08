/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0f1117',
          secondary: '#161922',
          card: '#1c1f2a',
          hover: '#24283a',
        },
        accent: {
          DEFAULT: '#7c3aed',
          hover: '#6d28d9',
          light: '#a78bfa',
        },
        text: {
          primary: '#f1f5f9',
          secondary: '#94a3b8',
          muted: '#64748b',
        },
        success: '#22c55e',
        warning: '#eab308',
        danger: '#ef4444',
      }
    },
  },
  plugins: [],
}
