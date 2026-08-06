import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // No inline scripts: keep the module-preload polyfill out so a strict CSP with
  // no 'unsafe-inline' can serve the build (the polyfill would emit an inline script).
  // The @/ alias the design system's shadcn components import through
  // (docs/design/ANDPAYMENTS-DESIGN-SYSTEM.md section 1 aliases block).
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { modulePreload: { polyfill: false } },
})
