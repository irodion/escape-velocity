/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Build identifier injected by Vite's `define` (O2, #92) — the git short SHA,
// with a `-dirty` suffix for an uncommitted working tree. See `vite.config.ts`.
declare const __APP_VERSION__: string
