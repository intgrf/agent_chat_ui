// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  publicDir: 'static',
  server: {
    port: 5173,
    // Прокси к вашему бэкенду (раскомментируйте и настройте при необходимости):
    proxy: {
      '/chat': { target: 'ws://localhost:5000', ws: true },
      '/log':  { target: 'ws://localhost:5000', ws: true },
    //   '/api':  { target: 'http://localhost:5000' },
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    manifest: true,
  }
})