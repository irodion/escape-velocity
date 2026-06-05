import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the WASM module before the handler imports it. Unlike
// `render.test.ts`, the handler threads its cache through explicit
// `WorkerState` arguments rather than module-level mutable state, so no
// `resetModules()` dance is needed — a `mockClear()` per test is enough
// to reset call counts. The factory adds a `Viewport` class double
// (the handler constructs one from the flat primitives) on top of the
// surface `render.test.ts` mocks.
vi.mock('../../wasm/fractal_wasm.js', () => {
  return {
    compute: vi.fn(
      (_viewport: unknown, _maxIter: number, _kind: number, _cRe: number, _cIm: number) => 0x1000,
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
    },
    NormalizationMode: { Cycled: 0, Histogram: 1 },
    FractalKind: { Mandelbrot: 0, Julia: 1 },
  }
})

import * as wasmModule from '../../wasm/fractal_wasm.js'
import {
  FractalKind,
  type InitOutput,
  NormalizationMode,
  Palette,
} from '../../wasm/fractal_wasm.js'
import { createWorkerState, handleMessage } from './handler.js'
import type { RecolorizeRequest, RenderRequest } from './protocol.js'

interface MockedWasm {
  compute: ReturnType<typeof vi.fn>
  compute_len: ReturnType<typeof vi.fn>
  colorize: ReturnType<typeof vi.fn>
  colorize_len: ReturnType<typeof vi.fn>
}

// Shape the mock `Viewport` class records its constructor inputs under,
// so a test can read them back off the value handed to `compute`.
interface MockViewport {
  re: number
  im: number
  zoom: number
  width: number
  height: number
}

const wasm = wasmModule as unknown as MockedWasm

// Enum discriminants come from the (mocked) WASM module's own exports
// rather than re-declared literals, so request construction and the
// matching assertions read from one source — a drift between the two
// can't hide behind duplicated magic numbers. Importing them as values
// also carries the real enum types, which removes the per-field
// `as RenderRequest['palette']` casts below.
//
// `cRe` / `cIm` stay pinned literals: the handler module defines no
// shared default for them (it is pure compute), and the only runtime
// source is `main.ts`'s boot constants — importing that into a worker
// unit test would invert the dependency and drag in DOM bootstrap. The
// pinned pair mirrors `render.test.ts` and still flags a divergence in
// the Slice 5C UI defaults as a failure here.
const C_RE_DEFAULT = -0.7
const C_IM_DEFAULT = 0.27015

// The mock's `colorize` returns ptr 0x2000 and `colorize_len` returns
// 16, so `paint` reads 16 bytes at offset 0x2000. One WASM page (64KiB)
// is plenty of headroom for that view.
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

describe('handleMessage', () => {
  beforeEach(() => {
    wasm.compute.mockClear()
    wasm.compute_len.mockClear()
    wasm.colorize.mockClear()
    wasm.colorize_len.mockClear()
    wasmInit = makeWasmInit()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a render request calls compute once and colorize once, in that order', () => {
    const { response } = handleMessage(createWorkerState(), renderRequest({ epoch: 7 }), wasmInit)
    expect(wasm.compute).toHaveBeenCalledTimes(1)
    expect(wasm.colorize).toHaveBeenCalledTimes(1)
    const computeOrder = wasm.compute.mock.invocationCallOrder[0]
    const colorizeOrder = wasm.colorize.mock.invocationCallOrder[0]
    expect(computeOrder).toBeLessThan(colorizeOrder)
    expect(response.epoch).toBe(7)
    expect(response.rgba).toHaveLength(16)
    expect(response.width).toBe(2)
    expect(response.height).toBe(2)
  })

  it('reconstructs the Viewport and forwards (kind, cRe, cIm) into the compute call positionally', () => {
    handleMessage(createWorkerState(), renderRequest({ fractalKind: FractalKind.Julia }), wasmInit)
    expect(wasm.compute).toHaveBeenCalledTimes(1)
    const args = wasm.compute.mock.calls[0] as [MockViewport, number, number, number, number]
    // arg 0 is the freshly reconstructed Viewport — assert the flat
    // primitives landed in the constructor in the right order so a
    // regression in `new Viewport(centerRe, centerIm, zoom, width,
    // height)` fails loudly here rather than silently rendering the
    // wrong frame.
    const viewport = args[0]
    expect(viewport.re).toBe(-0.5)
    expect(viewport.im).toBe(0)
    expect(viewport.zoom).toBe(1)
    expect(viewport.width).toBe(2)
    expect(viewport.height).toBe(2)
    expect(args[1]).toBe(256)
    expect(args[2]).toBe(FractalKind.Julia)
    expect(args[3]).toBe(C_RE_DEFAULT)
    expect(args[4]).toBe(C_IM_DEFAULT)
  })

  it('a recolorize after a render reuses the cached (ptr, len) and skips compute', () => {
    const { state } = handleMessage(createWorkerState(), renderRequest(), wasmInit)
    const [iterPtr, iterLen] = wasm.colorize.mock.calls[0] as [number, number, ...unknown[]]

    const { response } = handleMessage(state, recolorizeRequest(), wasmInit)

    expect(wasm.compute).toHaveBeenCalledTimes(1) // unchanged from the render
    expect(wasm.colorize).toHaveBeenCalledTimes(2)
    const secondCall = wasm.colorize.mock.calls[1] as [number, number, number, number, number]
    expect(secondCall[0]).toBe(iterPtr)
    expect(secondCall[1]).toBe(iterLen)
    expect(secondCall[2]).toBe(Palette.Magma)
    expect(secondCall[3]).toBe(NormalizationMode.Histogram)
    // Recolorize echoes the cached render's dimensions.
    expect(response.width).toBe(2)
    expect(response.height).toBe(2)
    expect(response.epoch).toBe(2)
  })

  it('a recolorize before any render throws a programmer-error', () => {
    expect(() => handleMessage(createWorkerState(), recolorizeRequest(), wasmInit)).toThrow(
      /recolorize: no cached iteration buffer/,
    )
  })

  it('a render after a recolorize triggers a fresh compute (cache does not become permanent)', () => {
    const first = handleMessage(createWorkerState(), renderRequest(), wasmInit)
    const second = handleMessage(first.state, recolorizeRequest(), wasmInit)
    handleMessage(second.state, renderRequest(), wasmInit)
    expect(wasm.compute).toHaveBeenCalledTimes(2)
    // 1 render + 1 recolorize + 1 render = 3 colorize calls total.
    expect(wasm.colorize).toHaveBeenCalledTimes(3)
  })

  it('two renders with different `fractalKind` trigger two distinct computes', () => {
    // Locks in that a mode change is NOT a fast-path candidate: a
    // Mandelbrot iteration buffer cannot be re-coloured as if it were
    // Julia, so each render must call `compute` again.
    const first = handleMessage(
      createWorkerState(),
      renderRequest({ fractalKind: FractalKind.Mandelbrot }),
      wasmInit,
    )
    handleMessage(first.state, renderRequest({ fractalKind: FractalKind.Julia }), wasmInit)
    expect(wasm.compute).toHaveBeenCalledTimes(2)
    expect((wasm.compute.mock.calls[0] as unknown[])[2]).toBe(FractalKind.Mandelbrot)
    expect((wasm.compute.mock.calls[1] as unknown[])[2]).toBe(FractalKind.Julia)
  })

  it('two renders in Julia mode with different (cRe, cIm) trigger two distinct computes', () => {
    // Changing the Julia parameter is a compute-class change, not a
    // recolorize-class change — the iteration buffer is a different
    // function of position when c differs.
    const first = handleMessage(
      createWorkerState(),
      renderRequest({
        fractalKind: FractalKind.Julia,
        cRe: -0.7,
        cIm: 0.27015,
      }),
      wasmInit,
    )
    handleMessage(
      first.state,
      renderRequest({
        fractalKind: FractalKind.Julia,
        cRe: -0.123,
        cIm: 0.745,
      }),
      wasmInit,
    )
    expect(wasm.compute).toHaveBeenCalledTimes(2)
    const a = wasm.compute.mock.calls[0] as unknown[]
    const b = wasm.compute.mock.calls[1] as unknown[]
    expect([a[3], a[4]]).toEqual([-0.7, 0.27015])
    expect([b[3], b[4]]).toEqual([-0.123, 0.745])
  })

  it('the response RGBA is copied out of WASM memory and listed as transferable', () => {
    // Seed recognisable bytes in WASM memory at the colorize pointer so
    // we can prove the response holds an independent copy, not a live
    // view.
    const seed = new Uint8ClampedArray(wasmInit.memory.buffer, 0x2000, 16)
    seed.fill(0xab)

    const { response, transfer } = handleMessage(createWorkerState(), renderRequest(), wasmInit)

    // The buffer is transferred (zero-copy on the receive side), not
    // structured-cloned.
    expect(transfer).toContain(response.rgba.buffer)
    // The response holds its own backing buffer, distinct from WASM
    // linear memory — transferring it cannot detach the WASM heap.
    expect(response.rgba.buffer).not.toBe(wasmInit.memory.buffer)
    expect(Array.from(response.rgba)).toEqual(new Array(16).fill(0xab))

    // Mutating WASM memory after the call must not bleed into the
    // already-copied response.
    seed.fill(0x00)
    expect(Array.from(response.rgba)).toEqual(new Array(16).fill(0xab))
  })
})
