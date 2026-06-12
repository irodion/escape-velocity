import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the WASM module before the handler imports it. The handler threads its
// cache through explicit `WorkerState` arguments rather than module-level
// mutable state, so a `mockClear()` per test is enough to reset call counts.
// The render path now computes in bands via `compute_band` (P2, #78); the
// double records each band's args so a test can read the row ranges back.
vi.mock('../../wasm/fractal_wasm.js', () => {
  return {
    compute_band: vi.fn(
      (
        _viewport: unknown,
        _maxIter: number,
        _kind: number,
        _cRe: number,
        _cIm: number,
        _field: number,
        _y0: number,
        _y1: number,
      ) => 0x1000,
    ),
    compute_len: vi.fn(() => 4),
    colorize: vi.fn(
      (_iterPtr: number, _len: number, _palette: number, _mode: number, _maxIter: number) => 0x2000,
    ),
    colorize_len: vi.fn(() => 16),
    Viewport: class {
      constructor(
        public readonly re: number,
        public readonly im: number,
        public readonly zoom: number,
        public readonly width: number,
        public readonly height: number,
      ) {}
    },
    Palette: {
      Grayscale: 0,
      Viridis: 1,
      Magma: 2,
      Inferno: 3,
      Twilight: 4,
      Plasma: 5,
      Turbo: 6,
      Cubehelix: 7,
      EarthAndSky: 8,
      Rainbow: 9,
      Ocean: 10,
      KaholLavan: 11,
      Solar: 12,
      Spectral: 13,
      Cosmic: 14,
    },
    NormalizationMode: {
      Cycled: 0,
      Histogram: 1,
      Linear: 2,
      SquareRoot: 3,
      Logarithmic: 4,
      Clamped: 5,
    },
    FractalKind: { Mandelbrot: 0, Julia: 1 },
    Field: { EscapeTime: 0, DistanceEstimate: 1 },
  }
})

import * as wasmModule from '../../wasm/fractal_wasm.js'
import {
  Field,
  FractalKind,
  type InitOutput,
  NormalizationMode,
  Palette,
} from '../../wasm/fractal_wasm.js'
import {
  createWorkerState,
  handleRecolorize,
  handleRender,
  planBands,
  type RenderHooks,
} from './handler.js'
import type { RecolorizeRequest, RenderRequest } from './protocol.js'

interface MockedWasm {
  compute_band: ReturnType<typeof vi.fn>
  compute_len: ReturnType<typeof vi.fn>
  colorize: ReturnType<typeof vi.fn>
  colorize_len: ReturnType<typeof vi.fn>
}

// Shape the mock `Viewport` class records its constructor inputs under,
// so a test can read them back off the value handed to `compute_band`.
interface MockViewport {
  re: number
  im: number
  zoom: number
  width: number
  height: number
}

const wasm = wasmModule as unknown as MockedWasm

// Enum discriminants come from the (mocked) WASM module's own exports rather
// than re-declared literals, so request construction and the matching
// assertions read from one source. `cRe` / `cIm` stay pinned literals (the
// handler defines no shared default; the only runtime source is main.ts's
// boot constants, importing which would drag DOM bootstrap into a worker unit
// test) — mirroring the pre-banding test.
const C_RE_DEFAULT = -0.7
const C_IM_DEFAULT = 0.27015

// The mock's `colorize` returns ptr 0x2000 and `colorize_len` returns 16, so
// `paint` reads 16 bytes at offset 0x2000. One WASM page (64KiB) is plenty.
let wasmInit: InitOutput

function makeWasmInit(): InitOutput {
  return { memory: new WebAssembly.Memory({ initial: 1 }) } as unknown as InitOutput
}

function renderRequest(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    kind: 'render',
    epoch: 1,
    width: 2,
    height: 2,
    centerRe: -0.5,
    centerIm: 0,
    zoom: 1,
    maxIter: 256,
    palette: Palette.Viridis,
    mode: NormalizationMode.Cycled,
    fractalKind: FractalKind.Mandelbrot,
    cRe: C_RE_DEFAULT,
    cIm: C_IM_DEFAULT,
    field: Field.EscapeTime,
    ...overrides,
  }
}

function recolorizeRequest(overrides: Partial<RecolorizeRequest> = {}): RecolorizeRequest {
  return {
    kind: 'recolorize',
    epoch: 2,
    palette: Palette.Magma,
    mode: NormalizationMode.Histogram,
    ...overrides,
  }
}

// Default hooks: never abort, instant yield, progress recorded. A test
// overrides individual hooks (notably `shouldAbort`) as needed.
function makeHooks(overrides: Partial<RenderHooks> = {}): {
  hooks: RenderHooks
  yieldSpy: ReturnType<typeof vi.fn>
  abortSpy: ReturnType<typeof vi.fn>
  progressSpy: ReturnType<typeof vi.fn>
} {
  const yieldSpy = vi.fn(() => Promise.resolve())
  const abortSpy = vi.fn(() => false)
  const progressSpy = vi.fn()
  const hooks: RenderHooks = {
    yieldToEventLoop: yieldSpy,
    shouldAbort: abortSpy,
    onProgress: progressSpy,
    ...overrides,
  }
  return { hooks, yieldSpy, abortSpy, progressSpy }
}

// Narrow a non-aborted render result; throws (failing the test) on an abort.
function expectRendered(
  result: Awaited<ReturnType<typeof handleRender>>,
): Extract<typeof result, { response: unknown }> {
  if ('aborted' in result) {
    throw new Error('expected a render result, got aborted')
  }
  return result
}

describe('planBands', () => {
  it('splits a frame into a contiguous partition ending at height', () => {
    for (const height of [1, 2, 5, 13, 100, 601]) {
      const bands = planBands(height)
      expect(bands[0][0]).toBe(0)
      expect(bands[bands.length - 1][1]).toBe(height)
      // Contiguous, strictly forward, no gaps or overlaps.
      for (let i = 1; i < bands.length; i += 1) {
        expect(bands[i][0]).toBe(bands[i - 1][1])
      }
      // Never empty; at most TARGET_BANDS (12) bands.
      for (const [y0, y1] of bands) {
        expect(y1).toBeGreaterThan(y0)
      }
      expect(bands.length).toBeLessThanOrEqual(12)
      expect(bands.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('makes one band per row for a short frame, never an empty band', () => {
    expect(planBands(1)).toEqual([[0, 1]])
    expect(planBands(2)).toEqual([
      [0, 1],
      [1, 2],
    ])
  })
})

describe('handleRender', () => {
  beforeEach(() => {
    wasm.compute_band.mockClear()
    wasm.compute_len.mockClear()
    wasm.colorize.mockClear()
    wasm.colorize_len.mockClear()
    wasmInit = makeWasmInit()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('computes every band then colorizes once, in that order', async () => {
    const { hooks } = makeHooks()
    // height 2 → two bands [0,1], [1,2] (planBands).
    const result = expectRendered(
      await handleRender(createWorkerState(), renderRequest({ epoch: 7 }), wasmInit, hooks),
    )

    expect(wasm.compute_band).toHaveBeenCalledTimes(2)
    expect(wasm.colorize).toHaveBeenCalledTimes(1)
    // Both bands compute before the single colorize.
    const lastBandOrder = wasm.compute_band.mock.invocationCallOrder[1]
    const colorizeOrder = wasm.colorize.mock.invocationCallOrder[0]
    expect(lastBandOrder).toBeLessThan(colorizeOrder)

    expect(result.response.epoch).toBe(7)
    expect(result.response.rgba).toHaveLength(16)
    expect(result.response.width).toBe(2)
    expect(result.response.height).toBe(2)
  })

  it('reconstructs the Viewport and forwards (kind, cRe, cIm, field, band range) to each band', async () => {
    const { hooks } = makeHooks()
    await handleRender(
      createWorkerState(),
      renderRequest({ fractalKind: FractalKind.Julia }),
      wasmInit,
      hooks,
    )

    expect(wasm.compute_band).toHaveBeenCalledTimes(2)
    const first = wasm.compute_band.mock.calls[0] as [
      MockViewport,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    // arg 0 is the freshly reconstructed Viewport — assert the flat primitives
    // landed in the constructor in the right order.
    const viewport = first[0]
    expect(viewport.re).toBe(-0.5)
    expect(viewport.im).toBe(0)
    expect(viewport.zoom).toBe(1)
    expect(viewport.width).toBe(2)
    expect(viewport.height).toBe(2)
    expect(first[1]).toBe(256)
    expect(first[2]).toBe(FractalKind.Julia)
    expect(first[3]).toBe(C_RE_DEFAULT)
    expect(first[4]).toBe(C_IM_DEFAULT)
    expect(first[5]).toBe(Field.EscapeTime)
    // The band ranges partition [0, height): [0,1) then [1,2).
    const ranges = wasm.compute_band.mock.calls.map((c) => [c[6], c[7]])
    expect(ranges).toEqual([
      [0, 1],
      [1, 2],
    ])
  })

  it('reports progress after each band as rows-done / rows-total', async () => {
    const { hooks, progressSpy } = makeHooks()
    await handleRender(createWorkerState(), renderRequest(), wasmInit, hooks)
    // Two bands of one row each over a 2-row frame: 1/2 then 2/2.
    expect(progressSpy.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ])
  })

  it('yields between bands but not after the last (one yield for two bands)', async () => {
    const { hooks, yieldSpy } = makeHooks()
    await handleRender(createWorkerState(), renderRequest(), wasmInit, hooks)
    expect(yieldSpy).toHaveBeenCalledTimes(1)
  })

  it('abandons the remaining bands and skips colorize when superseded mid-flight', async () => {
    // shouldAbort flips true after the first band's yield, so the second band
    // never computes and no frame is produced.
    const abort = vi.fn(() => true)
    const { hooks } = makeHooks({ shouldAbort: abort })
    const result = await handleRender(createWorkerState(), renderRequest(), wasmInit, hooks)

    expect('aborted' in result && result.aborted).toBe(true)
    expect(wasm.compute_band).toHaveBeenCalledTimes(1) // only the first band ran
    expect(wasm.colorize).not.toHaveBeenCalled() // no wasted colorize
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('a recolorize after a render reuses the cached (ptr, len) and skips compute', async () => {
    const { hooks } = makeHooks()
    const { state } = expectRendered(
      await handleRender(createWorkerState(), renderRequest(), wasmInit, hooks),
    )
    const [iterPtr, iterLen] = wasm.colorize.mock.calls[0] as [number, number, ...unknown[]]

    const { response } = handleRecolorize(state, recolorizeRequest(), wasmInit)

    expect(wasm.compute_band).toHaveBeenCalledTimes(2) // unchanged from the render
    expect(wasm.colorize).toHaveBeenCalledTimes(2)
    const secondCall = wasm.colorize.mock.calls[1] as [number, number, number, number, number]
    expect(secondCall[0]).toBe(iterPtr)
    expect(secondCall[1]).toBe(iterLen)
    expect(secondCall[2]).toBe(Palette.Magma)
    expect(secondCall[3]).toBe(NormalizationMode.Histogram)
    // Recolorize echoes the cached render's dimensions and the new epoch.
    expect(response.width).toBe(2)
    expect(response.height).toBe(2)
    expect(response.epoch).toBe(2)
  })

  it('a recolorize before any render throws a programmer-error', () => {
    expect(() => handleRecolorize(createWorkerState(), recolorizeRequest(), wasmInit)).toThrow(
      /recolorize: no cached iteration buffer/,
    )
  })

  it('two renders with different `fractalKind` both recompute (every band, both times)', async () => {
    const { hooks } = makeHooks()
    const first = expectRendered(
      await handleRender(
        createWorkerState(),
        renderRequest({ fractalKind: FractalKind.Mandelbrot }),
        wasmInit,
        hooks,
      ),
    )
    await handleRender(
      first.state,
      renderRequest({ fractalKind: FractalKind.Julia }),
      wasmInit,
      hooks,
    )
    // 2 bands × 2 renders.
    expect(wasm.compute_band).toHaveBeenCalledTimes(4)
    expect((wasm.compute_band.mock.calls[0] as unknown[])[2]).toBe(FractalKind.Mandelbrot)
    expect((wasm.compute_band.mock.calls[2] as unknown[])[2]).toBe(FractalKind.Julia)
  })

  it('two renders with different `field` both recompute', async () => {
    const { hooks } = makeHooks()
    const first = expectRendered(
      await handleRender(
        createWorkerState(),
        renderRequest({ field: Field.EscapeTime }),
        wasmInit,
        hooks,
      ),
    )
    await handleRender(
      first.state,
      renderRequest({ field: Field.DistanceEstimate }),
      wasmInit,
      hooks,
    )
    expect(wasm.compute_band).toHaveBeenCalledTimes(4)
    expect((wasm.compute_band.mock.calls[0] as unknown[])[5]).toBe(Field.EscapeTime)
    expect((wasm.compute_band.mock.calls[2] as unknown[])[5]).toBe(Field.DistanceEstimate)
  })

  it('the response RGBA is copied out of WASM memory and listed as transferable', async () => {
    // Seed recognisable bytes in WASM memory at the colorize pointer so we can
    // prove the response holds an independent copy, not a live view.
    const seed = new Uint8ClampedArray(wasmInit.memory.buffer, 0x2000, 16)
    seed.fill(0xab)

    const { hooks } = makeHooks()
    const { response, transfer } = expectRendered(
      await handleRender(createWorkerState(), renderRequest(), wasmInit, hooks),
    )

    expect(transfer).toContain(response.rgba.buffer)
    expect(response.rgba.buffer).not.toBe(wasmInit.memory.buffer)
    expect(Array.from(response.rgba)).toEqual(new Array(16).fill(0xab))

    // Mutating WASM memory after the call must not bleed into the copy.
    seed.fill(0x00)
    expect(Array.from(response.rgba)).toEqual(new Array(16).fill(0xab))
  })
})
