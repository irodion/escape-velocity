import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_FILE_SIZE_BYTES, pwaManifest, pwaWorkbox } from './pwa-config.js'

// Resolve repo files from the `web/` package root. The test runs under jsdom,
// where `import.meta.url` is an http:// document URL (not file://), so paths
// are anchored on `process.cwd()` — vitest's root, i.e. `web/`.
const fromWeb = (rel: string): string => resolve(process.cwd(), rel)

// These two suites are the Slice 8A *guards*: they fail the build if a future
// config edit could (1) let the service worker strip cross-origin isolation or
// drop the WASM from the offline precache, or (2) quietly break installability.
// Both failure modes are otherwise SILENT — the app still loads, it just
// either renders single-threaded (or not at all) offline, or stops being
// installable — so they need a test rather than a human noticing.

// Parse a Cloudflare `_headers` file into { scope: { Header: value } }. A
// non-indented line is a path scope (`/*`); the indented `Key: Value` lines
// below it are that scope's headers. Comment (`#`) and blank lines are skipped.
function parseHeaders(text: string): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {}
  let scope: string | null = null
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      scope = line.trim()
      rules[scope] = {}
    } else if (scope !== null) {
      const colon = line.indexOf(':')
      if (colon !== -1) {
        rules[scope][line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
      }
    }
  }
  return rules
}

describe('isolation-survival guard', () => {
  const headers = parseHeaders(readFileSync(fromWeb('public/_headers'), 'utf8'))

  it('serves COOP/COEP (and CORP) on every path so the SW-precached document stays cross-origin isolated', () => {
    // Workbox precaches the full network response, headers included; as long
    // as `/*` carries these, the SW-served cached index.html/.wasm keep
    // `SharedArrayBuffer` alive offline and the render worker boots (ADR-0008).
    const root = headers['/*']
    expect(root).toBeDefined()
    expect(root['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(root['Cross-Origin-Embedder-Policy']).toBe('require-corp')
    expect(root['Cross-Origin-Resource-Policy']).toBe('same-origin')
  })

  it('precaches the .wasm (globs include wasm) so an offline deep render does not 404', () => {
    expect(pwaWorkbox.globPatterns?.some((p) => p.includes('wasm'))).toBe(true)
  })

  it('precaches the self-hosted fonts (globs include woff2) so offline keeps the console typography', () => {
    expect(pwaWorkbox.globPatterns?.some((p) => p.includes('woff2'))).toBe(true)
  })

  it('keeps the precache size cap above the built .wasm so it is never silently dropped', () => {
    // Read the real artifact (built by `wasm:build` before vitest runs). If a
    // future binary grows past the cap, Workbox would drop it with only a
    // warning — this fails loudly instead.
    const wasmBytes = statSync(fromWeb('wasm/fractal_wasm_bg.wasm')).size
    expect(pwaWorkbox.maximumFileSizeToCacheInBytes).toBe(MAX_FILE_SIZE_BYTES)
    expect(MAX_FILE_SIZE_BYTES).toBeGreaterThan(wasmBytes)
  })
})

describe('manifest validity', () => {
  it('declares the installability-required fields', () => {
    expect(pwaManifest.name).toBeTruthy()
    expect(pwaManifest.short_name).toBeTruthy()
    expect(pwaManifest.description).toBeTruthy()
    expect(pwaManifest.start_url).toBe('/')
    expect(pwaManifest.display).toBe('standalone')
    expect(pwaManifest.theme_color).toBeTruthy()
    expect(pwaManifest.background_color).toBeTruthy()
  })

  it('ships the required icon sizes including a maskable 512', () => {
    const icons = pwaManifest.icons ?? []
    expect(icons.some((i) => i.sizes === '192x192' && i.type === 'image/png')).toBe(true)
    expect(icons.some((i) => i.sizes === '512x512' && i.type === 'image/png')).toBe(true)
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true)
  })

  it('points every icon at a file that exists in public/', () => {
    for (const icon of pwaManifest.icons ?? []) {
      expect(() => statSync(fromWeb(`public/${icon.src}`))).not.toThrow()
    }
  })
})
