import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { pwaManifest, pwaWorkbox } from './src/pwa-config'

// Build identifier for the version signal (O2, #92): the git short SHA, with a
// `-dirty` suffix when the working tree has uncommitted changes. Inlined into
// the bundle via `define` below so a deployed build can name itself (boot log +
// update toast) — practical for a continuously-deployed PWA where neither user
// nor developer can otherwise tell which build is live. Wrapped in try/catch so
// a git-less or shallow checkout (some CI) still builds, falling back to
// 'unknown' rather than failing the build.
function resolveBuildVersion(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

// Patch wasm-bindgen-rayon's generated `workerHelpers` snippet for two
// Vite-specific problems. Runs in BOTH dev and build (fix #1 is a dev-only
// failure; fix #2 a build-only one), and warns loudly if either upstream
// pattern disappears so a snippet change can't silently drop a fix.
//
// Fix #1 — dev import resolution. Each spawned thread worker re-imports the
// glue via a bare *directory* specifier, `import('../../..')` (the wasm-pack
// package root). Rollup resolves that through package.json at build time, but
// Vite's dev import-analysis cannot resolve a relative directory import and
// fails the dev server with "Failed to resolve import '../../..'". Rewrite it
// to the explicit glue file (`../../../fractal_wasm.js`), which resolves in
// both dev and build.
//
// Fix #2 — build worker retention (Firefox GC, bugzilla 1702191). The snippet
// keeps its spawned workers alive via a module-level `_workers = await
// Promise.all(...)` — a variable written but never read, whose sole job is to
// root the Worker instances so Firefox doesn't collect workers that share
// WebAssembly memory with their parent. A production minifier eliminates that
// write-only store, un-rooting the pool so rendering stalls after boot. Re-root
// on a `globalThis` property instead: a global write is an observable side
// effect no minifier drops, retaining the pool for the worker's lifetime
// exactly as the original did. (Harmless in dev, where nothing is minified.)
function patchRayonWorkerHelper(): Plugin {
  const dirImport = "import('../../..')"
  const fileImport = "import('../../../fractal_wasm.js')"
  const retention = '_workers = await Promise.all('
  const rooted = 'globalThis.__wasmBindgenRayonWorkers = await Promise.all('
  return {
    name: 'patch-rayon-worker-helper',
    transform(code, id) {
      if (!id.includes('wasm-bindgen-rayon') || !id.endsWith('workerHelpers.js')) return null
      let out = code
      if (out.includes(dirImport)) {
        out = out.replace(dirImport, fileImport)
      } else {
        this.warn(
          'patch-rayon-worker-helper: the glue directory import was not found — ' +
            'the snippet may have changed shape; the Vite dev server may fail to ' +
            'resolve it. Update this plugin.',
        )
      }
      if (out.includes(retention)) {
        out = out.replace(retention, rooted)
      } else {
        this.warn(
          'patch-rayon-worker-helper: the worker-retention assignment was not ' +
            'found — the snippet may have changed shape; the Firefox GC ' +
            'protection (bugzilla 1702191) is no longer applied. Update this plugin.',
        )
      }
      return out === code ? null : { code: out, map: null }
    },
  }
}

// Cross-origin isolation headers (ADR-0008). Required for SharedArrayBuffer,
// which backs the Slice 7 WASM thread pool. Applied to BOTH the dev server
// and the preview server so the production build can be exercised
// cross-origin-isolated locally (`pnpm preview`); production itself sets them
// via Cloudflare's `_headers`.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// Strict CSP + hardening headers, mirroring production's `public/_headers` so
// `pnpm preview` exercises the exact policy the deployed site enforces. Kept
// OFF the dev server below: Vite HMR injects inline scripts and uses `eval`,
// which this policy forbids — dev would break. `style-src` keeps
// `'unsafe-inline'` for the inline UI stylesheet (ADR-0003); script-src stays
// strict. Keep this CSP string identical to the one in `public/_headers` (the
// guard test asserts the production copy).
const securityHardeningHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

// wasm-bindgen-rayon's `workerHelpers` *dynamically* imports the wasm glue
// (each spawned thread worker re-instantiates the module against the shared
// memory), while the main thread and the render worker import that same glue
// *statically*. Rollup can't hoist it into its own split chunk and emits
// INEFFECTIVE_DYNAMIC_IMPORT. This is expected and harmless: the glue still
// lands in a shared chunk that every importer — main thread, render worker,
// and the rayon thread workers — resolves to. Silence only this one warning
// for the glue (matched by code *and* module) so any genuinely new warning
// still surfaces. One `build.rollupOptions.onwarn` handler covers both the app
// and worker bundles: under Vite 8 (Rolldown) the worker-bundle warnings
// funnel through the top-level build handler, and `worker.rollupOptions`
// deliberately omits `onwarn` anyway.
const isExpectedGlueDynamicImportWarning = (code: string | undefined, message: string): boolean =>
  code === 'INEFFECTIVE_DYNAMIC_IMPORT' && message.includes('fractal_wasm.js')

export default defineConfig({
  // Inline the build identifier (O2, #92) as a compile-time constant. `define`
  // does a literal text substitution, so the value must be JSON-stringified;
  // `src/vite-env.d.ts` declares the global so TypeScript sees it.
  define: {
    __APP_VERSION__: JSON.stringify(resolveBuildVersion()),
  },
  // The render worker is the context that actually calls `startWorkers`
  // (worker.ts → initThreadPool), so the patch must apply to the worker build
  // and to dev (where the top-level plugins transform worker modules); the
  // main build carries a copy of the snippet too, so apply it there as well.
  // PWA (Slice 8A). `generateSW` (Workbox) precaches the build for offline
  // use; the manifest makes the app installable. `registerType: 'prompt'`
  // means a freshly built SW *waits* rather than auto-reloading, so a deploy
  // never yanks assets out from under an in-progress render — the user-facing
  // update prompt + install button are Slice 8B's job. `injectRegister: false`
  // because the SW is registered explicitly from `main.ts` via the
  // `virtual:pwa-register` module (so 8B can route that registration through
  // the pwa-lifecycle controller). `devOptions.enabled: false` keeps the SW
  // out of `pnpm dev` entirely — ADR-0009's whole reason for deferring PWA to
  // last: an active dev loop must not fight a caching service worker. The
  // cross-origin-isolation headers the SW must preserve are served in dev/
  // preview below and emitted for production in `public/_headers`.
  plugins: [
    patchRayonWorkerHelper(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      devOptions: { enabled: false },
      manifest: pwaManifest,
      workbox: pwaWorkbox,
    }),
  ],
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: { ...crossOriginIsolationHeaders, ...securityHardeningHeaders },
  },
  // Emit workers as ES modules. The render worker (Slice 6) is constructed
  // with `{ type: 'module' }` and uses top-level `await`; the rayon thread
  // workers (Slice 7) likewise self-spawn as module workers. The default
  // `iife` worker format rejects both, so the module format is required.
  worker: {
    format: 'es',
    plugins: () => [patchRayonWorkerHelper()],
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (isExpectedGlueDynamicImportWarning(warning.code, warning.message)) return
        warn(warning)
      },
    },
  },
})
