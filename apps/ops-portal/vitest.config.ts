import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Isolated from the root node vitest project (see ../../vitest.config.ts): this
// app needs jsdom + the react-jsx transform, which must not leak into the
// node/NestJS suites. Kept as its own project so it resolves independently of
// apps/ops-portal/vite.config.ts (Vitest does not auto-merge a sibling
// vite.config.ts when a vitest.config.ts is present).
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    name: 'ops-portal',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
