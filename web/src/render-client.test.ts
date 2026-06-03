import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RenderRequest, RenderResponse } from './worker/protocol.js'

// jsdom ships no `ImageData`; the client constructs one before
// `putImageData`. A minimal double that records its data is enough to
// assert the painted buffer's length.
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

// Stand-in for the module Worker. Records every posted message and
// exposes the `onmessage` the client installs so a test can drive
// worker → client messages synchronously. The client constructs the
// worker at module-eval time, so each fresh import pushes a new
// instance here.
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly posted: unknown[] = []
  constructor(
    readonly url: string | URL,
    readonly options?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this)
  }
  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.posted.push(message)
  }
  terminate(): void {}
}

interface RenderClient {
  render: (
    viewport: { centerRe: number; centerIm: number; zoom: number; width: number; height: number },
    ctx: CanvasRenderingContext2D,
    maxIter: number,
    palette: number,
    mode: number,
    kind: number,
    cRe: number,
    cIm: number,
  ) => void
  recolorize: (ctx: CanvasRenderingContext2D, palette: number, mode: number) => void
}

const VIEWPORT = { centerRe: -0.5, centerIm: 0, zoom: 1, width: 2, height: 2 }
// A distinct viewport (different centre + zoom) so a fold test can prove
// the queued render's compute survives — i.e. the dispatched request
// still carries THIS viewport, not the earlier one.
const VIEWPORT_B = { centerRe: 0.25, centerIm: 0.5, zoom: 4, width: 2, height: 2 }
const PALETTE_VIRIDIS = 1
const PALETTE_MAGMA = 2
const MODE_CYCLED = 0
const MODE_HISTOGRAM = 1
const KIND_MANDELBROT = 0

// A fresh module per test resets the client's module-level coalescing
// state (latestEpoch / inFlight / pending / ready) and yields a brand
// new worker instance with empty `posted`.
async function loadClient(): Promise<{ client: RenderClient; worker: FakeWorker }> {
  vi.resetModules()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  const client = (await import('./render-client.js')) as unknown as RenderClient
  const worker = FakeWorker.instances[0]
  return { client, worker }
}

function makeCtx(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  return { canvas, putImageData: vi.fn() } as unknown as CanvasRenderingContext2D
}

function deliver(worker: FakeWorker, data: RenderResponse | { kind: 'ready' }): void {
  worker.onmessage?.({ data } as MessageEvent)
}

function readyMsg(): { kind: 'ready' } {
  return { kind: 'ready' }
}

function response(epoch: number): RenderResponse {
  return { kind: 'response', epoch, rgba: new Uint8ClampedArray(16), width: 2, height: 2 }
}

function doRender(client: RenderClient, ctx: CanvasRenderingContext2D): void {
  client.render(VIEWPORT, ctx, 256, PALETTE_VIRIDIS, MODE_CYCLED, KIND_MANDELBROT, -0.7, 0.27015)
}

function postedEpochs(worker: FakeWorker): number[] {
  return worker.posted.map((m) => (m as RenderRequest).epoch)
}

describe('render-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('constructs a module worker at load', async () => {
    const { worker } = await loadClient()
    expect(worker).toBeDefined()
    expect(worker.options?.type).toBe('module')
  })

  it('stamps successive requests with strictly increasing epochs', async () => {
    const { client, worker } = await loadClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    // Drain each render with its response so the next one dispatches
    // rather than coalescing into the pending slot.
    doRender(client, ctx)
    deliver(worker, response(1))
    doRender(client, ctx)
    deliver(worker, response(2))
    doRender(client, ctx)

    expect(postedEpochs(worker)).toEqual([1, 2, 3])
  })

  it('paints a response whose epoch is still the latest', async () => {
    const { client, worker } = await loadClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx)
    deliver(worker, response(1))

    expect(ctx.putImageData).toHaveBeenCalledTimes(1)
    const image = (ctx.putImageData as ReturnType<typeof vi.fn>).mock.calls[0][0] as ImageData
    expect(image.data).toHaveLength(16)
  })

  it('drops a stale response (epoch behind the latest issued)', async () => {
    const { client, worker } = await loadClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, posted, in flight
    doRender(client, ctx) // epoch 2, queued — latestEpoch is now 2

    deliver(worker, response(1)) // response for the superseded epoch 1

    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('coalesces to a single pending slot: newest queued wins, older dropped', async () => {
    const { client, worker } = await loadClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1 → posted, in flight
    doRender(client, ctx) // epoch 2 → queued
    doRender(client, ctx) // epoch 3 → overwrites the queued epoch 2

    // Only the first request has gone out while the worker is busy.
    expect(postedEpochs(worker)).toEqual([1])

    deliver(worker, response(1)) // worker frees up → flush the pending slot

    // The third request is dispatched; epoch 2 was silently dropped.
    expect(postedEpochs(worker)).toEqual([1, 3])
  })

  it('queues a recolorize issued while a render is in flight and dispatches it on response', async () => {
    const { client, worker } = await loadClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1 → posted, in flight
    client.recolorize(ctx, PALETTE_VIRIDIS, MODE_CYCLED) // epoch 2 → queued

    expect(worker.posted).toHaveLength(1)

    deliver(worker, response(1))

    expect(worker.posted).toHaveLength(2)
    expect((worker.posted[1] as { kind: string }).kind).toBe('recolorize')
    expect((worker.posted[1] as RenderRequest).epoch).toBe(2)
  })

  it('folds a recolorize into a pending render instead of replacing it', async () => {
    // P1 regression: render A in flight, render B queued (newer
    // viewport), then a palette change. The recolorize must not evict
    // B — otherwise B's viewport is never computed and the worker
    // re-tints A's stale buffer. Instead B's compute is kept and the
    // new colours are folded in.
    const { client, worker } = await loadClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // render A → epoch 1, posted, in flight
    client.render(
      VIEWPORT_B,
      ctx,
      256,
      PALETTE_VIRIDIS,
      MODE_CYCLED,
      KIND_MANDELBROT,
      -0.7,
      0.27015,
    ) // render B → epoch 2, queued
    client.recolorize(ctx, PALETTE_MAGMA, MODE_HISTOGRAM) // epoch 3 → folds into B

    expect(worker.posted).toHaveLength(1) // worker still busy with A

    deliver(worker, response(1)) // A returns → flush the merged request

    expect(worker.posted).toHaveLength(2)
    const dispatched = worker.posted[1] as RenderRequest
    // The compute survives: it is still a render carrying B's viewport.
    expect(dispatched.kind).toBe('render')
    expect(dispatched.centerRe).toBe(VIEWPORT_B.centerRe)
    expect(dispatched.centerIm).toBe(VIEWPORT_B.centerIm)
    expect(dispatched.zoom).toBe(VIEWPORT_B.zoom)
    // The colours are the recolorize's, folded in.
    expect(dispatched.palette).toBe(PALETTE_MAGMA)
    expect(dispatched.mode).toBe(MODE_HISTOGRAM)
    // Epoch bumped onto the merged render so its response still paints.
    expect(dispatched.epoch).toBe(3)
  })

  it('folds a recolorize into a render still buffered before `ready` (no empty-cache wedge)', async () => {
    // A recolorize issued before the boot render has completed must not
    // replace that render — sending a standalone recolorize to a worker
    // with no cached buffer throws there and wedges the client.
    const { client, worker } = await loadClient()
    const ctx = makeCtx()

    doRender(client, ctx) // boot render → buffered (not ready yet)
    client.recolorize(ctx, PALETTE_MAGMA, MODE_HISTOGRAM) // folds into the buffered render

    deliver(worker, readyMsg())

    expect(worker.posted).toHaveLength(1)
    const dispatched = worker.posted[0] as RenderRequest
    expect(dispatched.kind).toBe('render')
    expect(dispatched.palette).toBe(PALETTE_MAGMA)
    expect(dispatched.mode).toBe(MODE_HISTOGRAM)
  })

  it('buffers a render issued before `ready` and posts it once ready arrives', async () => {
    const { client, worker } = await loadClient()
    const ctx = makeCtx()

    doRender(client, ctx) // before ready → buffered, not posted
    expect(worker.posted).toHaveLength(0)

    deliver(worker, readyMsg())

    expect(worker.posted).toHaveLength(1)
    expect((worker.posted[0] as { kind: string }).kind).toBe('render')
  })

  it('does not paint a response that arrives before `ready`', async () => {
    const { client, worker } = await loadClient()
    const ctx = makeCtx()

    doRender(client, ctx) // buffered; nothing in flight yet
    deliver(worker, response(1)) // spurious pre-ready response

    expect(ctx.putImageData).not.toHaveBeenCalled()
  })
})
