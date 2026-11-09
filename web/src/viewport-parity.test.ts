import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
// The real generated glue and module, not a double: this suite exists to pin
// the TypeScript port to the Rust it mirrors (#169, ADR-0015). Type-only here;
// the glue itself is imported in `beforeAll`, after the build check below.
import type { Viewport as RustViewport } from '../wasm/fractal_wasm.js'
import { Viewport } from './viewport.js'

// The worker builds a WASM `Viewport` from the main thread's fields for every
// render, so a drift between the two would put a zoom's Settle frame somewhere
// other than its Preview, and a pick somewhere other than the pixel clicked.
// Both sides are binary64 with the same operation order, so they must agree
// bit for bit: `toEqual` compares numbers with `Object.is`.
//
// The `Viewport` class needs no thread pool, so the threaded build
// instantiates here without a browser; only `compute_band` and `colorize`
// would need one.

type Fields = [number, number, number, number, number]

const ts = (v: Viewport): Fields => [v.centerRe, v.centerIm, v.zoom, v.width, v.height]

function rs(v: RustViewport): Fields {
  const fields: Fields = [v.center_re(), v.center_im(), v.zoom(), v.width(), v.height()]
  v.free()
  return fields
}

// mulberry32: deterministic, so a failure reproduces from its case number.
function generator(seed: number): (lo: number, hi: number) => number {
  let state = seed
  return (lo, hi) => {
    state = (state + 0x6d2b79f5) | 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return lo + (hi - lo) * (((t ^ (t >>> 14)) >>> 0) / 4294967296)
  }
}

// The generated `Viewport` class, bound once the module is instantiated.
let WasmViewport: typeof RustViewport

beforeAll(async () => {
  // Resolved against this file, not the working directory, so the suite runs
  // the same from `web/`, the repo root or an editor's runner.
  // (Not `new URL(…, import.meta.url)`: Vite rewrites that into an asset URL.)
  const wasmDir = resolve(import.meta.dirname, '../wasm')
  const modulePath = resolve(wasmDir, 'fractal_wasm_bg.wasm')
  if (!existsSync(modulePath)) {
    throw new Error(
      `the WASM module is not built (${modulePath}): run \`pnpm wasm:build\` in web/, ` +
        'or `pnpm test`, which builds it first',
    )
  }
  // A computed specifier, so Vite doesn't resolve it while transforming this
  // file and fail it before the check above can explain what is missing.
  const gluePath = pathToFileURL(resolve(wasmDir, 'fractal_wasm.js')).href
  const glue: typeof import('../wasm/fractal_wasm.js') = await import(/* @vite-ignore */ gluePath)
  await glue.default({ module_or_path: readFileSync(modulePath) })
  WasmViewport = glue.Viewport
})

describe('the TypeScript Viewport against the Rust one', () => {
  it('agrees bit for bit on projections, pans, zooms, resizes and wheel scrubs over random views', () => {
    const between = generator(0x5eed169)
    const mismatches: string[] = []
    const compare = (what: string, a: readonly number[], b: readonly number[]): void => {
      if (mismatches.length < 5 && !a.every((x, i) => Object.is(x, b[i]))) {
        mismatches.push(`${what}: ts ${a.join(', ')} / rust ${b.join(', ')}`)
      }
    }
    for (let i = 0; i < 2000; i++) {
      const re = between(-2.5, 1)
      const im = between(-1.5, 1.5)
      // Mostly ordinary depths, now and then right at a clamp.
      const pick = between(0, 1)
      const zoom = pick < 0.03 ? 0.25 : pick < 0.06 ? 1e13 : 10 ** between(-0.6, 13)
      const width = 1 + Math.floor(between(0, 4000))
      const height = 1 + Math.floor(between(0, 4000))
      const view = new Viewport(re, im, zoom, width, height)
      const wasm = new WasmViewport(re, im, zoom, width, height)

      // The kernel's per-pixel projection, which the cursor picks reproduce
      // through the port (`cssToComplex`): any pixel of the grid.
      const cx = Math.floor(between(0, width))
      const cy = Math.floor(between(0, height))
      const point = view.pixelToComplex(cx, cy)
      compare(`project #${i}`, [point.re, point.im], [...wasm.pixel_to_complex(cx, cy)])

      const px = between(-100, width + 100)
      const py = between(-100, height + 100)
      const factor = 1.25 ** between(-6, 6) * (between(0, 1) < 0.02 ? 1e6 : 1)
      compare(
        `zoom #${i}`,
        ts(view.zoomAround(px, py, factor)),
        rs(wasm.zoom_around(px, py, factor)),
      )

      const dx = between(-3000, 3000)
      const dy = between(-3000, 3000)
      compare(`pan #${i}`, ts(view.panByPixels(dx, dy)), rs(wasm.pan_by_pixels(dx, dy)))

      const w2 = 1 + Math.floor(between(0, 4000))
      const h2 = 1 + Math.floor(between(0, 4000))
      compare(`resize #${i}`, ts(view.withResolution(w2, h2)), rs(wasm.with_resolution(w2, h2)))

      // A scrub chains notches, so a difference would compound.
      let tsScrub = view
      let rsScrub = wasm
      for (let n = 0; n < 8; n++) {
        const f = between(0, 1) < 0.5 ? 1.25 : 0.8
        const x = between(0, width)
        const y = between(0, height)
        tsScrub = tsScrub.zoomAround(x, y, f)
        const next = rsScrub.zoom_around(x, y, f)
        rsScrub.free()
        rsScrub = next
      }
      compare(`scrub #${i}`, ts(tsScrub), rs(rsScrub))
    }
    expect(mismatches).toEqual([])
  })

  it('rejects the inputs the binding rejects', () => {
    expect(() => new WasmViewport(0, 0, 0, 800, 600)).toThrow('zoom')
    expect(() => new Viewport(0, 0, 0, 800, 600)).toThrow('zoom')
    const wasm = new WasmViewport(0, 0, 1, 800, 600)
    expect(() => wasm.zoom_around(0, 0, -2)).toThrow('factor')
    expect(() => new Viewport(0, 0, 1, 800, 600).zoomAround(0, 0, -2)).toThrow('factor')
    wasm.free()
  })
})
