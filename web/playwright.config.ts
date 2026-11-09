import { defineConfig, devices } from '@playwright/test'

// End-to-end tests (#93): the production build in real Chromium, where the
// jsdom unit tests can't reach (the worker, WASM threads, SharedArrayBuffer,
// pixels). They run against `vite preview` on 127.0.0.1: a secure origin, so
// the cross-origin isolation headers take effect (plain http on any other host
// would leave the page un-isolated). `pnpm e2e` builds first; `pnpm e2e:only`
// tests the existing `dist/`, as CI does after its build step.
const PORT = 4173
const BASE_URL = `http://127.0.0.1:${PORT}`
const CI = process.env.CI !== undefined

export default defineConfig({
  testDir: 'e2e',
  // One worker: each page runs the renderer's own thread pool, and the boxes
  // this runs on (CI, devbox) have two cores.
  workers: 1,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !CI,
    timeout: 60_000,
  },
})
