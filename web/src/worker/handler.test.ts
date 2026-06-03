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
    Palette: { Grayscale: 0, Viridis: 1, Magma: 2, Inferno: 3, Twilight: 4 },
    NormalizationMode: { Cycled: 0, Histogram: 1 },
    FractalKind: { Mandelbrot: 0, Julia: 1 },
  }
})

import type { InitOutput } from '../../wasm/fractal_wasm.js'
import * as wasmModule from '../../wasm/fractal_wasm.js'
import { createWorkerState, handleMessage } from './handler.js'
import type { RecolorizeRequest, RenderRequest } from './protocol.js'

interface MockedWasm {
  compute: ReturnType<typeof vi.fn>
  compute_len: ReturnType<typeof vi.fn>
  colorize: ReturnType<typeof vi.fn>
  colorize_len: ReturnType<typeof vi.fn>
}

const wasm = wasmModule as unknown as MockedWasm

const PALETTE_VIRIDIS = 1
const PALETTE_MAGMA = 2
const MODE_CYCLED = 0
const MODE_HISTOGRAM = 1
const KIND_MANDELBROT = 0
const KIND_JULIA = 1
// Pinned to the Slice 5C UI defaults so a divergence in the production
// constants surfaces as a test failure here rather than silently
// passing through the WASM seam.
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
    palette: PALETTE_VIRIDIS as RenderRequest['palette'],
    mode: MODE_CYCLED as RenderRequest['mode'],
    fractalKind: KIND_MANDELBROT as RenderRequest['fractalKind'],
    cRe: C_RE_DEFAULT,
    cIm: C_IM_DEFAULT,
    ...overrides,
  }
}

function recolorizeRequest(overrides: Partial<RecolorizeRequest> = {}): RecolorizeRequest {
  return {
    kind: 'recolorize',
    epoch: 2,
    palette: PALETTE_MAGMA as RecolorizeRequest['palette'],
    mode: MODE_HISTOGRAM as RecolorizeRequest['mode'],
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

  it('forwards (kind, cRe, cIm) into the compute call positionally', () => {
    handleMessage(
      createWorkerState(),
      renderRequest({ fractalKind: KIND_JULIA as RenderRequest['fractalKind'] }),
      wasmInit,
    )
    expect(wasm.compute).toHaveBeenCalledTimes(1)
    const args = wasm.compute.mock.calls[0] as [unknown, number, number, number, number]
    expect(args[1]).toBe(256)
    expect(args[2]).toBe(KIND_JULIA)
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
    expect(secondCall[2]).toBe(PALETTE_MAGMA)
    expect(secondCall[3]).toBe(MODE_HISTOGRAM)
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
      renderRequest({ fractalKind: KIND_MANDELBROT as RenderRequest['fractalKind'] }),
      wasmInit,
    )
    handleMessage(
      first.state,
      renderRequest({ fractalKind: KIND_JULIA as RenderRequest['fractalKind'] }),
      wasmInit,
    )
    expect(wasm.compute).toHaveBeenCalledTimes(2)
    expect((wasm.compute.mock.calls[0] as unknown[])[2]).toBe(KIND_MANDELBROT)
    expect((wasm.compute.mock.calls[1] as unknown[])[2]).toBe(KIND_JULIA)
  })

  it('two renders in Julia mode with different (cRe, cIm) trigger two distinct computes', () => {
    // Changing the Julia parameter is a compute-class change, not a
    // recolorize-class change — the iteration buffer is a different
    // function of position when c differs.
    const first = handleMessage(
      createWorkerState(),
      renderRequest({
        fractalKind: KIND_JULIA as RenderRequest['fractalKind'],
        cRe: -0.7,
        cIm: 0.27015,
      }),
      wasmInit,
    )
    handleMessage(
      first.state,
      renderRequest({
        fractalKind: KIND_JULIA as RenderRequest['fractalKind'],
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
