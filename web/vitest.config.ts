import { defineConfig } from 'vitest/config'

// jsdom provides DOM globals (document, MouseEvent, WheelEvent, ...)
// for the InputController unit tests. Tests use synthetic events on a
// canvas element they construct themselves. Some suites import the real
// generated glue (viewport-parity, wasm-enums, wasm-binding, pwa-config and
// the worker handler), so they need `pnpm wasm:build` first; `pnpm test`
// does that.
export default defineConfig({
  // `__APP_VERSION__` is injected by vite.config.ts's `define` for real builds
  // (O2, #92); this config doesn't extend it, so stub the build identifier for
  // the unit tests — pwa-ui reads it when rendering the update toast.
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
