import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom does not ship `ImageData`. `render` constructs one to hand to
// `putImageData`; both calls are observably side-effect-free in these
// tests (we stub `putImageData` away), so a minimal class double is
// enough to keep the constructor from throwing.
if (typeof globalThis.ImageData === 'undefined') {
  class ImageDataDouble {
    readonly data: Uint8ClampedArray
    readonly width: number
    readonly height: number
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  Object.defineProperty(globalThis, 'ImageData', {
    value: ImageDataDouble,
    configurable: true,
    writable: true,
  })
}

// Mock the WASM module before any code that touches it loads. The
// factory runs once per resetModules() cycle, so call-count
// assertions need to start from a freshly-rebuilt module — that's
// what `vi.resetModules()` plus a dynamic re-import buys.
vi.mock('../wasm/fractal_wasm.js', () => {
  return {
    compute: vi.fn((_viewport: unknown, _maxIter: number) => 0x1000),
    compute_len: vi.fn(() => 4),
    colorize: vi.fn(
      (_iterPtr: number, _len: number, _palette: number, _mode: number, _maxIter: number) => 0x2000,
    ),
    colorize_len: vi.fn(() => 16),
    Palette: { Grayscale: 0, Viridis: 1, Magma: 2, Inferno: 3, Twilight: 4 },
    NormalizationMode: { Cycled: 0, Histogram: 1 },
  }
})

interface MockedWasm {
  compute: ReturnType<typeof vi.fn>
  compute_len: ReturnType<typeof vi.fn>
  colorize: ReturnType<typeof vi.fn>
  colorize_len: ReturnType<typeof vi.fn>
  Palette: { Viridis: number; Magma: number }
  NormalizationMode: { Cycled: number; Histogram: number }
}

interface RenderModule {
  render: (
    viewport: unknown,
    ctx: CanvasRenderingContext2D,
    wasm: unknown,
    maxIter: number,
    palette: number,
    mode: number,
  ) => void
  recolorize: (ctx: CanvasRenderingContext2D, wasm: unknown, palette: number, mode: number) => void
}

// Each test reloads `./render.js` so its module-level
// `cachedIterPtr / cachedIterLen / cachedMaxIter` start at the
// "no cached buffer yet" state. Without this, a `render` in test N
// would still be cached when test N+1 starts and the
// "recolorize-before-render throws" assertion would falsely pass.
async function loadFresh(): Promise<{ wasm: MockedWasm; render: RenderModule }> {
  vi.resetModules()
  const wasm = (await import('../wasm/fractal_wasm.js')) as unknown as MockedWasm
  const render = (await import('./render.js')) as unknown as RenderModule
  // Reset call counts so this test starts from a clean slate even
  // though the underlying mock vi.fns persist across resetModules.
  wasm.compute.mockClear()
  wasm.compute_len.mockClear()
  wasm.colorize.mockClear()
  wasm.colorize_len.mockClear()
  return { wasm, render }
}

function makeCanvasContext(): CanvasRenderingContext2D {
  // jsdom's getContext('2d') returns null (no canvas backend); the
  // render functions only ever read `ctx.canvas.{width,height}` and
  // call `ctx.putImageData`, so a structural double satisfies the
  // surface without pulling in the optional `canvas` npm package.
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const stub = {
    canvas,
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D
  return stub
}

function fakeWasmInitOutput(): { memory: WebAssembly.Memory } {
  // ImageData needs a real ArrayBuffer; allocate enough for a 2×2
  // canvas (16 bytes) plus headroom.
  return { memory: new WebAssembly.Memory({ initial: 1 }) }
}

describe('render / recolorize', () => {
  const VIEWPORT = {} as unknown
  const PALETTE_VIRIDIS = 1
  const PALETTE_MAGMA = 2
  const MODE_CYCLED = 0
  const MODE_HISTOGRAM = 1
  let ctx: CanvasRenderingContext2D
  let wasmInit: { memory: WebAssembly.Memory }

  beforeEach(() => {
    ctx = makeCanvasContext()
    wasmInit = fakeWasmInitOutput()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('render calls compute once and colorize once, in that order', async () => {
    const { wasm, render } = await loadFresh()
    render.render(VIEWPORT, ctx, wasmInit, 256, PALETTE_VIRIDIS, MODE_CYCLED)
    expect(wasm.compute).toHaveBeenCalledTimes(1)
    expect(wasm.colorize).toHaveBeenCalledTimes(1)
    const computeOrder = wasm.compute.mock.invocationCallOrder[0]
    const colorizeOrder = wasm.colorize.mock.invocationCallOrder[0]
    expect(computeOrder).toBeLessThan(colorizeOrder)
  })

  it('recolorize after a render runs colorize again with the cached (ptr, len) and skips compute', async () => {
    const { wasm, render } = await loadFresh()
    render.render(VIEWPORT, ctx, wasmInit, 256, PALETTE_VIRIDIS, MODE_CYCLED)
    const [iterPtr, iterLen] = wasm.colorize.mock.calls[0] as [number, number, ...unknown[]]

    render.recolorize(ctx, wasmInit, PALETTE_MAGMA, MODE_HISTOGRAM)

    expect(wasm.compute).toHaveBeenCalledTimes(1) // unchanged from the render
    expect(wasm.colorize).toHaveBeenCalledTimes(2)
    const secondCall = wasm.colorize.mock.calls[1] as [number, number, number, number, number]
    expect(secondCall[0]).toBe(iterPtr)
    expect(secondCall[1]).toBe(iterLen)
    expect(secondCall[2]).toBe(PALETTE_MAGMA)
    expect(secondCall[3]).toBe(MODE_HISTOGRAM)
  })

  it('recolorize before any render throws a programmer-error', async () => {
    const { render } = await loadFresh()
    expect(() => render.recolorize(ctx, wasmInit, PALETTE_VIRIDIS, MODE_CYCLED)).toThrow(
      /recolorize: no cached iteration buffer/,
    )
  })

  it('a render after a recolorize triggers a fresh compute (cache does not become permanent)', async () => {
    const { wasm, render } = await loadFresh()
    render.render(VIEWPORT, ctx, wasmInit, 256, PALETTE_VIRIDIS, MODE_CYCLED)
    render.recolorize(ctx, wasmInit, PALETTE_MAGMA, MODE_HISTOGRAM)
    render.render(VIEWPORT, ctx, wasmInit, 256, PALETTE_VIRIDIS, MODE_CYCLED)
    expect(wasm.compute).toHaveBeenCalledTimes(2)
    // 1 render + 1 recolorize + 1 render = 3 colorize calls total.
    expect(wasm.colorize).toHaveBeenCalledTimes(3)
  })
})
