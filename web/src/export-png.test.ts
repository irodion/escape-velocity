import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFilename, computeExportDims, EXPORT_MAX_PIXELS, renderOnce } from './export-png.js'
import { FakeWorker } from './testing/fake-worker.js'
import type { ViewState } from './view-state.js'
import { serialize } from './view-state.js'
import type { RenderRequest } from './worker/protocol.js'

const SAMPLE: ViewState = {
  re: -0.743,
  im: 0.1314,
  zoom: 200,
  maxIter: 256,
  palette: 'viridis',
  normalisation: 'cycled',
  mode: 'mandelbrot',
  field: 'escape-time',
  cRe: -0.7,
  cIm: 0.27015,
  orbit: false,
}

describe('buildFilename', () => {
  it('embeds the permalink params with a .png extension and prefix', () => {
    const name = buildFilename(SAMPLE)
    expect(name.startsWith('escape-velocity-')).toBe(true)
    expect(name.endsWith('.png')).toBe(true)
  })

  it('swaps permalink separators for filename-safe characters', () => {
    const name = buildFilename(SAMPLE)
    // `=` → `-` and `&` → `,`, so neither URL separator survives in the name.
    expect(name).not.toContain('=')
    expect(name).not.toContain('&')
    // The leading hash from `serialize` is stripped.
    expect(name).not.toContain('#')
  })

  it('carries every permalink key into the filename', () => {
    const name = buildFilename(SAMPLE)
    // Each `key-value` pair from the (separator-swapped) permalink appears.
    const expected = serialize(SAMPLE).slice(1).replace(/=/g, '-').replace(/&/g, ',')
    expect(name).toBe(`escape-velocity-${expected}.png`)
  })

  it('preserves the negative sign in coordinate values', () => {
    const name = buildFilename(SAMPLE)
    // re=-0.743 → `re--0.743`: the value's own minus is untouched.
    expect(name).toContain('re--0.743')
  })
})

describe('computeExportDims', () => {
  // Ordinary desktop windows (logical CSS px) that the old shared 2.5M on-screen
  // budget clamped (#157): at 2560×1440 both buttons saved the same 0.82× image.
  it.each([
    [1512, 982],
    [1920, 1080],
    [2560, 1440],
  ])('saves a %i×%i window at exactly 1× and 2× the logical size', (w, h) => {
    expect(computeExportDims(w, h, 1)).toEqual({ width: w, height: h, scale: 1 })
    expect(computeExportDims(w, h, 2)).toEqual({ width: w * 2, height: h * 2, scale: 2 })
  })

  it('clamps to the export budget, preserving the aspect ratio', () => {
    // 3440×1440 ultrawide at 2× = 6880×2880 ≈ 19.8M px > budget.
    const dims = computeExportDims(3440, 1440, 2)
    expect(dims.width * dims.height).toBeLessThanOrEqual(EXPORT_MAX_PIXELS)
    expect(dims.width * dims.height).toBeGreaterThan(EXPORT_MAX_PIXELS * 0.999)
    expect(dims.scale).toBeLessThan(2)
    expect(dims.width / dims.height).toBeCloseTo(3440 / 1440, 2)
  })

  it.each([
    [3440, 1440],
    [3840, 2160],
    [7680, 4320],
  ])('keeps a %i×%i 2× export under the iOS Safari 4096² canvas-area limit', (w, h) => {
    const dims = computeExportDims(w, h, 2)
    expect(dims.width * dims.height).toBeLessThanOrEqual(4096 * 4096)
  })
})

// The boot handshake and the stall watchdog are the connection's, tested in
// `worker/connection.test.ts` (#160). These cover what export does with it.
describe('renderOnce', () => {
  const REQUEST = { kind: 'render', epoch: 0 } as RenderRequest

  function start() {
    const worker = new FakeWorker()
    const result = renderOnce(REQUEST, () => worker.asWorker())
    return { worker, result }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the request once the worker is ready, resolves with the frame, and terminates it', async () => {
    const { worker, result } = start()
    worker.send({ kind: 'boot', stage: 'wasm' })
    expect(worker.posted).toHaveLength(0)
    worker.send({ kind: 'ready' })
    expect(worker.posted).toEqual([REQUEST])

    const frame = {
      kind: 'response',
      epoch: 0,
      rgba: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }
    worker.send({ kind: 'progress', epoch: 0, rowsDone: 1, rowsTotal: 1 })
    worker.send(frame)
    await expect(result).resolves.toBe(frame)
    expect(worker.terminated).toBe(true)
  })

  it.each([
    ['a render error', { kind: 'error', epoch: 0, message: 'boom' }, 'export render failed: boom'],
    ['an abort', { kind: 'aborted', epoch: 0 }, 'export render was aborted'],
  ])('rejects on %s and terminates the worker', async (_, reply, message) => {
    const { worker, result } = start()
    worker.send({ kind: 'ready' })
    worker.send(reply)
    await expect(result).rejects.toThrow(message)
    expect(worker.terminated).toBe(true)
  })

  it('rejects on a boot failure without waiting out the watchdog', async () => {
    const { worker, result } = start()
    worker.send({ kind: 'boot-error', stage: 'init', message: 'CompileError' })
    await expect(result).rejects.toThrow('CompileError')
    expect(worker.terminated).toBe(true)
  })

  it('rejects once the worker goes silent for a minute', async () => {
    const { worker, result } = start()
    worker.send({ kind: 'ready' })
    vi.advanceTimersByTime(59_999)
    worker.send({ kind: 'progress', epoch: 0, rowsDone: 1, rowsTotal: 12 })
    vi.advanceTimersByTime(59_999)
    expect(worker.terminated).toBe(false)
    vi.advanceTimersByTime(1)
    await expect(result).rejects.toThrow('stopped responding')
    expect(worker.terminated).toBe(true)
  })
})
