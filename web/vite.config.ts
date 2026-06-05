import { defineConfig } from 'vite'

// Cross-origin isolation headers (ADR-0008). Required for SharedArrayBuffer,
// which backs the Slice 7 WASM thread pool. Applied to BOTH the dev server
// and the preview server so the production build can be exercised
// cross-origin-isolated locally (`pnpm preview`); production itself sets them
// via Cloudflare's `_headers`.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// wasm-bindgen-rayon's `workerHelpers` *dynamically* imports the wasm glue
// (each spawned thread worker re-instantiates the module against the shared
// memory), while the main thread and the render worker import that same glue
// *statically*. Rollup can't hoist it into its own split chunk and emits
// INEFFECTIVE_DYNAMIC_IMPORT. This is expected and harmless: the glue still
// lands in a shared chunk that every importer — main thread, render worker,
// and the rayon thread workers — resolves to. Silence only this one warning
// for the glue (matched by code *and* module) so any genuinely new warning
// still surfaces. The check is applied to both the app bundle and the worker
// bundle, which Vite builds in separate Rollup passes.
const isExpectedGlueDynamicImportWarning = (code: string | undefined, message: string): boolean =>
  code === 'INEFFECTIVE_DYNAMIC_IMPORT' && message.includes('fractal_wasm.js')

export default defineConfig({
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  // Emit workers as ES modules. The render worker (Slice 6) is constructed
  // with `{ type: 'module' }` and uses top-level `await`; the rayon thread
  // workers (Slice 7) likewise self-spawn as module workers. The default
  // `iife` worker format rejects both, so the module format is required.
  worker: {
    format: 'es',
    rollupOptions: {
      onwarn(warning, warn) {
        if (isExpectedGlueDynamicImportWarning(warning.code, warning.message)) return
        warn(warning)
      },
    },
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
