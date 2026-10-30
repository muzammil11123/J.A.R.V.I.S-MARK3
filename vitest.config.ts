import { defineConfig } from 'vitest/config'

// The page's own tests. The bridge keeps node:test (npm test); these cover the
// browser modules, which need Vite's import.meta.env and module mocking. No
// browser and no devices: camera, microphone and models are faked per test.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
