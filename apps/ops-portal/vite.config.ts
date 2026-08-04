import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Demo dev server (branch demo/ops-portal-skin). The SPA is served same-origin
// on :5173 and the two edges are reached through a proxy, so the refresh
// cookie (Secure; SameSite=Strict; Path=/session) is a same-origin cookie and
// works in the browser. /session and /probe proxy to auth-edge (:3000); /ops
// proxies to ops-edge (:3001). The VITE_AUTH_BASE / VITE_OPS_BASE env vars are
// set to '' in .env.local so the spine's AuthContext builds same-origin
// relative URLs. This is dev-server config only; it changes no spine behavior.
export default defineConfig({
  plugins: [react()],
  // No inline scripts: keep the module-preload polyfill out so a strict CSP with
  // no 'unsafe-inline' can serve the build (the polyfill would emit an inline script).
  build: { modulePreload: { polyfill: false } },
  server: {
    port: 5173,
    proxy: {
      '/session': { target: 'http://localhost:3000', changeOrigin: false },
      '/probe': { target: 'http://localhost:3000', changeOrigin: false },
      '/ops': { target: 'http://localhost:3001', changeOrigin: false },
    },
  },
})
