import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
// The real generated glue and module, not a double: this suite exists to pin
// the TypeScript port to the Rust it mirrors (#169, ADR-0015).
import init, { Viewport as WasmViewport } from '../wasm/fractal_wasm.js'
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

function rs(v: WasmViewport): Fields {
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

beforeAll(async () => {
  // Vitest runs from `web/`, as `pwa-config.test.ts` relies on too.
  const bytes = readFileSync(resolve(process.cwd(), 'wasm/fractal_wasm_bg.wasm'))
  await init({ module_or_path: bytes })
})

describe('the TypeScript Viewport against the Rust one', () => {
  it('agrees bit for bit on pans, zooms, resizes and wheel scrubs over random views', () => {
    const between = generator(0x5eed169)
    const mismatches: string[] = []
    const compare = (what: string, a: Fields, b: Fields): void => {
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
