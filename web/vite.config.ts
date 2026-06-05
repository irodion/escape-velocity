import { defineConfig, type Plugin } from 'vite'

// wasm-bindgen-rayon's `workerHelpers` stores its spawned thread workers in a
// module-level `let _workers = await Promise.all(...)`. That variable is
// written but never read — its sole purpose (per the upstream comment) is to
// *root* the Worker instances so Firefox doesn't garbage-collect workers that
// share WebAssembly memory with their parent but aren't otherwise referenced
// (https://bugzilla.mozilla.org/show_bug.cgi?id=1702191). A production
// minifier sees a write-only variable and eliminates the store, un-rooting the
// pool — so after boot Firefox can collect the workers and rendering stalls.
// Dev is unaffected (unminified), so this only bites the built bundle.
//
// Re-root the workers on a global property instead: a write to `globalThis`
// is an observable side effect that no minifier drops, and it keeps the pool
// alive for the worker's lifetime exactly as the original did. Build-only —
// dev keeps the upstream code verbatim. Fails loudly if the upstream snippet
// shape changes, so the GC protection can't silently regress.
function preserveRayonWorkerRefs(): Plugin {
  const retention = '_workers = await Promise.all('
  const rooted = 'globalThis.__wasmBindgenRayonWorkers = await Promise.all('
  return {
    name: 'preserve-rayon-worker-refs',
    apply: 'build',
    transform(code, id) {
      if (!id.includes('wasm-bindgen-rayon') || !id.endsWith('workerHelpers.js')) return null
      if (!code.includes(retention)) {
        this.warn(
          'preserve-rayon-worker-refs: the wasm-bindgen-rayon worker-retention ' +
            'assignment was not found — the snippet may have changed shape. The ' +
            'Firefox GC protection (bugzilla 1702191) is no longer applied; ' +
            'update this plugin.',
        )
        return null
      }
      return { code: code.replace(retention, rooted), map: null }
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
  // The render worker is the context that actually calls `startWorkers`
  // (worker.ts → initThreadPool), so the retention fix must apply to the
  // worker build; the main build carries a copy of the snippet too, so apply
  // it there as well for consistency.
  plugins: [preserveRayonWorkerRefs()],
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
    plugins: () => [preserveRayonWorkerRefs()],
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
