/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg:       '#0d0f12',
          surface:  '#0f1117',
          elevated: '#1a1d24',
          border:   '#2a2d35',
          muted:    '#6b7280',
        },
        accent: {
          blue:  '#3b82f6',
          green: '#22c55e',
          red:   '#ef4444',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}