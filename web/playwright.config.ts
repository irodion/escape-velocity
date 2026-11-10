import { defineConfig, devices } from '@playwright/test'

// End-to-end tests (#93): the production build in real Chromium, where the
// jsdom unit tests can't reach (the worker, WASM threads, SharedArrayBuffer,
// pixels). They run against `vite preview` on 127.0.0.1: a secure origin, so
// the cross-origin isolation headers take effect (plain http on any other host
// would leave the page un-isolated). `pnpm e2e` builds first; `pnpm e2e:only`
// tests the existing `dist/`, as CI does after its build step.
// Not 4173, `vite preview`'s default: a preview left running from another
// checkout must not be the server these tests hit.
const PORT = 4179
const BASE_URL = `http://127.0.0.1:${PORT}`
const CI = process.env.CI === 'true' || process.env.CI === '1'

export default defineConfig({
  testDir: 'e2e',
  // `toMatchSnapshot` references are the canvas's own pixels (settledCanvasPng
  // in e2e/app.ts), the same on every OS, so their names carry no platform.
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFileName}/{arg}{-projectName}{ext}',
  // One worker: each page runs the renderer's own thread pool, and the boxes
  // this runs on (CI, devbox) have two cores.
  workers: 1,
  // Booting alone may take up to 30 s on a small runner (BOOT_TIMEOUT_MS in
  // e2e/app.ts), and the reload test boots twice.
  timeout: 60_000,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [['github'], ['list']] : 'list',
  // Page screenshots do depend on the OS (fonts, antialiasing): keep
  // Playwright's platform-specific names for any `toHaveScreenshot`.
  expect: {
    toHaveScreenshot: {
      pathTemplate:
        '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}',
    },
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
