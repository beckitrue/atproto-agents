import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev-time proxy to the game engine — same-origin polling, no CORS.
    proxy: {
      '/api': {
        target: process.env.ENGINE_URL ?? 'http://localhost:8091',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
