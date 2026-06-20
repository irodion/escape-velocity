import type { ManifestOptions, VitePWAOptions } from 'vite-plugin-pwa'

// The Workbox option shape, derived through vite-plugin-pwa's own types
// (`Partial<GenerateSWOptions>`) rather than importing `workbox-build`
// directly — it's a transitive dependency our package can't resolve by name.
type WorkboxOptions = VitePWAOptions['workbox']

/**
 * PWA configuration (Slice 8A), extracted from `vite.config.ts` so the
 * manifest and Workbox settings are *plain data* a unit test can import and
 * assert on without booting Vite. Two guarantees ride on these values and are
 * pinned by `pwa-config.test.ts`:
 *
 *   1. Cross-origin isolation survives the service worker. The SW must never
 *      serve a precached document/WASM stripped of COOP/COEP, or the page
 *      loses `SharedArrayBuffer`, the render worker throws at boot
 *      (`!crossOriginIsolated`), and Slice 7's multicore silently dies. The
 *      headers themselves live in `public/_headers` (ADR-0008); the part that
 *      lives *here* is keeping the WASM genuinely in the precache (below).
 *   2. Offline-completeness for the multicore render path. The render worker
 *      chunk, the `wasm-bindgen-rayon` helper-worker chunk(s), the `.wasm`,
 *      and the glue must all be precached, or the first offline deep render
 *      404s against the dead network.
 */

// Workbox's default precache cap is 2 MiB; the threaded WASM artifact is
// comfortably smaller today (~116 KiB) but the cap is raised — and tested
// against the real artifact size — so a future binary that grows past 2 MiB
// can't be silently dropped from the precache (Workbox only *warns*), turning
// "offline-ready" into a lie. The guard test fails if this ever drops below
// the built `.wasm`.
export const MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024

export const pwaManifest: Partial<ManifestOptions> = {
  name: 'Escape Velocity',
  short_name: 'Escape Velocity',
  description:
    'An educational, open-source Mandelbrot & Julia fractal explorer — ' +
    'Rust + WebAssembly, multicore in the browser.',
  // Match the page ground (#05070b, index.html) and the in-page <meta
  // name="theme-color"> so an installed launch shows no near-black splash flash.
  theme_color: '#05070b',
  background_color: '#05070b',
  display: 'standalone',
  start_url: '/',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    {
      src: 'icons/icon-512-maskable.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
}

export const pwaWorkbox: WorkboxOptions = {
  // `wasm` and `woff2` are the load-bearing additions: vite-plugin-pwa's
  // default `globPatterns` includes neither. Without `wasm` the `.wasm` is
  // left out of the precache and offline rendering fails; without `woff2` the
  // self-hosted UI fonts (Slice 4 redesign) aren't precached, so an offline
  // launch silently falls back to the system monospace stack. The render
  // worker and `wasm-bindgen-rayon` helper-worker chunks are `.js`, covered.
  globPatterns: ['**/*.{js,css,html,wasm,woff2,svg,png,ico,webmanifest}'],
  maximumFileSizeToCacheInBytes: MAX_FILE_SIZE_BYTES,
  // Single-page app: any navigation offline falls back to the precached
  // index.html — which retains COOP/COEP because Workbox captured the full
  // network response (headers included) at install time.
  navigateFallback: 'index.html',
}
