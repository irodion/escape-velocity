import { defineConfig } from 'vitest/config'

// jsdom provides DOM globals (document, MouseEvent, WheelEvent, ...)
// for the InputController unit tests. Tests use synthetic events on a
// canvas element they construct themselves; no real WASM is loaded.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
