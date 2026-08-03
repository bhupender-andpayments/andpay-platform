import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  // No inline scripts: keep the module-preload polyfill out so a strict CSP with
  // no 'unsafe-inline' can serve the build (the polyfill would emit an inline script).
  build: { modulePreload: { polyfill: false } },
})
