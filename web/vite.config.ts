import { defineConfig } from 'vite'

// COOP/COEP headers mirror the production Cloudflare config (ADR-0008) and
// will unlock SharedArrayBuffer when the rayon slice lands (ADR-0007).
// Setting them from slice 0 keeps dev aligned with production and immediately
// rejects cross-origin assets — enforcing "self-host everything" from day 1
// rather than letting a third-party CDN sneak in and ambush slice 7.
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Emit the render worker (Slice 6) as an ES module. It is constructed
  // with `{ type: 'module' }` and uses top-level `await init()` to boot
  // its WASM instance; the default `iife` worker format rejects
  // top-level await, so the module format is required, not cosmetic.
  worker: {
    format: 'es',
  },
})
