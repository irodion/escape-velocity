import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createRenderClient, type ProgressReporter } from './render-client.js'
import type {
  Aborted,
  CancelRequest,
  ProgressResponse,
  RenderError,
  RenderRequest,
  RenderResponse,
} from './worker/protocol.js'

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
// worker → client messages synchronously. `createRenderClient` calls the
// injected factory once, so each `makeClient()` gets its own fresh instance —
// no global `Worker` patching or module resets needed (A3, #86).
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly posted: unknown[] = []
  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.posted.push(message)
  }
  terminate(): void {}
}

// The factory returns enum-typed `render`/`recolorize` params (`Palette` etc.);
// the tests drive them with plain numeric constants, so they exercise the
// client through this loosely-typed view rather than the branded interface.
interface TestRenderClient {
  render: (
    viewport: { centerRe: number; centerIm: number; zoom: number; width: number; height: number },
    ctx: CanvasRenderingContext2D,
    maxIter: number,
    palette: number,
    mode: number,
    kind: number,
    cRe: number,
    cIm: number,
    field: number,
  ) => void
  recolorize: (ctx: CanvasRenderingContext2D, palette: number, mode: number) => void
  discardInFlight: () => void
}

// Construct a client over a fresh FakeWorker, injecting the optional fatal /
// progress collaborators at construction (mirrors how `main.ts` wires them).
// Supplying `onFatal` also arms the boot watchdog, matching production.
function makeClient(deps?: { onFatal?: (message: string) => void; progress?: ProgressReporter }): {
  client: TestRenderClient
  worker: FakeWorker
} {
  const worker = new FakeWorker()
  const client = createRenderClient({
    workerFactory: () => worker as unknown as Worker,
    ...deps,
  }) as unknown as TestRenderClient
  return { client, worker }
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
const FIELD_ESCAPE_TIME = 0

function makeCtx(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  return { canvas, putImageData: vi.fn() } as unknown as CanvasRenderingContext2D
}

function deliver(
  worker: FakeWorker,
  data: RenderResponse | RenderError | ProgressResponse | Aborted | { kind: 'ready' },
): void {
  worker.onmessage?.({ data } as MessageEvent)
}

function deliverError(worker: FakeWorker, epoch: number, message: string): void {
  worker.onmessage?.({ data: { kind: 'error', epoch, message } } as MessageEvent)
}

function deliverProgress(
  worker: FakeWorker,
  epoch: number,
  rowsDone: number,
  rowsTotal: number,
): void {
  worker.onmessage?.({ data: { kind: 'progress', epoch, rowsDone, rowsTotal } } as MessageEvent)
}

function deliverAborted(worker: FakeWorker, epoch: number): void {
  worker.onmessage?.({ data: { kind: 'aborted', epoch } } as MessageEvent)
}

// Fire the worker's `onerror` (a top-level worker throw). `preventDefault` is
// a no-op spy since the client calls it.
function fireWorkerError(worker: FakeWorker, message: string): void {
  worker.onerror?.({ message, preventDefault: () => {} } as ErrorEvent)
}

function readyMsg(): { kind: 'ready' } {
  return { kind: 'ready' }
}

function response(epoch: number): RenderResponse {
  return { kind: 'response', epoch, rgba: new Uint8ClampedArray(16), width: 2, height: 2 }
}

function doRender(client: TestRenderClient, ctx: CanvasRenderingContext2D): void {
  client.render(
    VIEWPORT,
    ctx,
    256,
    PALETTE_VIRIDIS,
    MODE_CYCLED,
    KIND_MANDELBROT,
    -0.7,
    0.27015,
    FIELD_ESCAPE_TIME,
  )
}

// Only render / recolorize messages are "work" the worker dispatches; a
// `cancel` is a side-channel supersede signal (P2) that the client also posts
// while a render is in flight. Tests that assert on dispatched work filter it
// out via these helpers so a cancel can't masquerade as a dispatched frame.
function isWork(m: unknown): boolean {
  const kind = (m as { kind: string }).kind
  return kind === 'render' || kind === 'recolorize'
}

function postedWork(worker: FakeWorker): unknown[] {
  return worker.posted.filter(isWork)
}

function postedEpochs(worker: FakeWorker): number[] {
  return postedWork(worker).map((m) => (m as RenderRequest).epoch)
}

function postedCancels(worker: FakeWorker): CancelRequest[] {
  return worker.posted.filter((m) => (m as { kind: string }).kind === 'cancel') as CancelRequest[]
}

describe('render-client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('invokes the worker factory exactly once at construction', () => {
    let calls = 0
    const worker = new FakeWorker()
    createRenderClient({
      workerFactory: () => {
        calls += 1
        return worker as unknown as Worker
      },
    })
    // The factory is the seam a future side-by-side view reuses; the client
    // must build exactly one worker, eagerly, so its handlers are wired before
    // any message arrives. (The `{ type: 'module' }` contract now lives at the
    // call site in `main.ts`, not here.)
    expect(calls).toBe(1)
  })

  it('stamps successive requests with strictly increasing epochs', () => {
    const { client, worker } = makeClient()
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

  it('paints a response whose epoch is still the latest', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx)
    deliver(worker, response(1))

    expect(ctx.putImageData).toHaveBeenCalledTimes(1)
    const image = (ctx.putImageData as ReturnType<typeof vi.fn>).mock.calls[0][0] as ImageData
    expect(image.data).toHaveLength(16)
  })

  it('clears a Preview transform before painting the frame (atomic swap, ADR-0012)', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    // A wheel-zoom Preview transform is on the canvas when the fresh frame
    // arrives (the input layer set it; this layer owns clearing it).
    ctx.canvas.style.transform = 'translate(40px, 30px) scale(0.8)'
    expect(ctx.canvas.style.transform).not.toBe('') // sanity: jsdom stored it

    let transformAtPaint: string | null = null
    ;(ctx.putImageData as ReturnType<typeof vi.fn>).mockImplementation(() => {
      transformAtPaint = ctx.canvas.style.transform
    })
    deliver(worker, readyMsg())
    doRender(client, ctx)
    deliver(worker, response(1))

    expect(ctx.putImageData).toHaveBeenCalledTimes(1)
    // The transform was already identity by the time putImageData ran —
    // the clear and the paint happen in the same tick, so the swap from
    // Preview to true frame is atomic (no snap-back).
    expect(transformAtPaint).toBe('')
    expect(ctx.canvas.style.transform).toBe('')
  })

  it('keeps the Preview transform on a recolorize paint (B2: palette change mid-scrub)', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    // A render completes first so the worker holds a cached buffer — the
    // precondition for a standalone recolorize to dispatch at all.
    doRender(client, ctx)
    deliver(worker, response(1))

    // A wheel-zoom Preview transform is on the canvas (the input layer set
    // it). A palette change within the settle window issues a recolorize,
    // which re-tints the cached pre-scrub buffer without changing geometry.
    ctx.canvas.style.transform = 'translate(40px, 30px) scale(0.8)'
    client.recolorize(ctx, PALETTE_MAGMA, MODE_HISTOGRAM)
    deliver(worker, response(2))

    // The recolorize painted (new colours) but must NOT clear the transform:
    // the Preview scale still applies to the same image, so clearing it would
    // snap the frame to identity at the wrong scale until the Settle render
    // lands. Only a render ends the scrub.
    expect(ctx.putImageData).toHaveBeenCalledTimes(2)
    expect(ctx.canvas.style.transform).toBe('translate(40px, 30px) scale(0.8)')
  })

  it('drops a stale response (epoch behind the latest issued)', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, posted, in flight
    doRender(client, ctx) // epoch 2, queued — latestEpoch is now 2

    deliver(worker, response(1)) // response for the superseded epoch 1

    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('discardInFlight drops the in-flight render so its response does not paint', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, posted, in flight
    client.discardInFlight() // bump the epoch past it (e.g. a resumed scrub)
    deliver(worker, response(1)) // the now-stale response must be dropped

    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('discardInFlight also drops queued work so it never dispatches', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, posted, in flight
    doRender(client, ctx) // epoch 2, queued in the pending slot
    client.discardInFlight() // bump the epoch AND clear the pending slot

    deliver(worker, response(1)) // A returns, frees the worker → flush

    // The queued epoch-2 render must never dispatch (no wasted compute),
    // and the stale epoch-1 response must not paint.
    expect(postedEpochs(worker)).toEqual([1])
    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('coalesces to a single pending slot: newest queued wins, older dropped', () => {
    const { client, worker } = makeClient()
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

  it('queues a recolorize issued while a render is in flight and dispatches it on response', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1 → posted, in flight
    client.recolorize(ctx, PALETTE_VIRIDIS, MODE_CYCLED) // epoch 2 → queued

    expect(postedWork(worker)).toHaveLength(1)

    deliver(worker, response(1))

    expect(postedWork(worker)).toHaveLength(2)
    expect((postedWork(worker)[1] as { kind: string }).kind).toBe('recolorize')
    expect((postedWork(worker)[1] as RenderRequest).epoch).toBe(2)
  })

  it('folds a recolorize into a pending render instead of replacing it', () => {
    // P1 regression: render A in flight, render B queued (newer
    // viewport), then a palette change. The recolorize must not evict
    // B — otherwise B's viewport is never computed and the worker
    // re-tints A's stale buffer. Instead B's compute is kept and the
    // new colours are folded in.
    const { client, worker } = makeClient()
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
      FIELD_ESCAPE_TIME,
    ) // render B → epoch 2, queued
    client.recolorize(ctx, PALETTE_MAGMA, MODE_HISTOGRAM) // epoch 3 → folds into B

    expect(postedWork(worker)).toHaveLength(1) // worker still busy with A

    deliver(worker, response(1)) // A returns → flush the merged request

    expect(postedWork(worker)).toHaveLength(2)
    const dispatched = postedWork(worker)[1] as RenderRequest
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

  it('folds a recolorize into a render still buffered before `ready` (no empty-cache wedge)', () => {
    // A recolorize issued before the boot render has completed must not
    // replace that render — sending a standalone recolorize to a worker
    // with no cached buffer throws there and wedges the client.
    const { client, worker } = makeClient()
    const ctx = makeCtx()

    doRender(client, ctx) // boot render → buffered (not ready yet)
    client.recolorize(ctx, PALETTE_MAGMA, MODE_HISTOGRAM) // folds into the buffered render

    deliver(worker, readyMsg())

    expect(postedWork(worker)).toHaveLength(1)
    const dispatched = postedWork(worker)[0] as RenderRequest
    expect(dispatched.kind).toBe('render')
    expect(dispatched.palette).toBe(PALETTE_MAGMA)
    expect(dispatched.mode).toBe(MODE_HISTOGRAM)
  })

  it('buffers a render issued before `ready` and posts it once ready arrives', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()

    doRender(client, ctx) // before ready → buffered, not posted
    expect(worker.posted).toHaveLength(0)

    deliver(worker, readyMsg())

    expect(worker.posted).toHaveLength(1)
    expect((worker.posted[0] as { kind: string }).kind).toBe('render')
  })

  it('does not paint a response that arrives before `ready`', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()

    doRender(client, ctx) // buffered; nothing in flight yet
    deliver(worker, response(1)) // spurious pre-ready response

    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('frees the slot and dispatches the next request when a render errors (B4)', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, in flight
    doRender(client, ctx) // epoch 2, queued
    expect(postedWork(worker)).toHaveLength(1)

    // Worker throws on epoch 1 instead of responding. Without an error arm
    // `inFlight` would stay true forever and epoch 2 would never dispatch.
    deliverError(worker, 1, 'compute: invalid viewport')

    // The queued epoch-2 render is dispatched, proving the slot was freed.
    expect(postedWork(worker)).toHaveLength(2)
    expect((postedWork(worker)[1] as RenderRequest).epoch).toBe(2)
    // An error never paints.
    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('surfaces a fatal handler when the worker throws at the top level (B4)', () => {
    const fatal = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { worker } = makeClient({ onFatal: fatal })

    fireWorkerError(worker, 'LinkError: shared memory unavailable')

    expect(fatal).toHaveBeenCalledTimes(1)
    expect(fatal).toHaveBeenCalledWith('LinkError: shared memory unavailable')
  })

  it('a dead worker (onerror) stops dispatching further requests (B4)', () => {
    const { client, worker } = makeClient()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deliver(worker, readyMsg())
    fireWorkerError(worker, 'worker died')

    const ctx = makeCtx()
    doRender(client, ctx)

    // Nothing posted after death — a dead worker can't drain the slot, so we
    // don't park requests in it.
    expect(worker.posted).toHaveLength(0)
  })

  it('fires the fatal handler if `ready` never arrives within the boot timeout (B4)', () => {
    vi.useFakeTimers()
    try {
      const fatal = vi.fn()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      // Injecting the handler arms the watchdog at construction. No `ready` is
      // delivered, so it must fire.
      makeClient({ onFatal: fatal })

      vi.advanceTimersByTime(5000)

      expect(fatal).toHaveBeenCalledTimes(1)
      expect(fatal).toHaveBeenCalledWith(expect.stringContaining('did not start'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire the boot watchdog once `ready` has arrived (B4)', () => {
    vi.useFakeTimers()
    try {
      const fatal = vi.fn()
      const { worker } = makeClient({ onFatal: fatal })
      deliver(worker, readyMsg()) // boot succeeds, cancelling the watchdog

      vi.advanceTimersByTime(5000)

      expect(fatal).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // --- P2 (#78): band cancellation + progress ------------------------------

  it('posts a cancel carrying the new epoch when a render supersedes one in flight', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1 → posted, in flight
    doRender(client, ctx) // epoch 2 → supersedes 1 while it is on the worker

    // The second issue tells the worker to abandon the doomed epoch-1 render.
    const cancels = postedCancels(worker)
    expect(cancels).toHaveLength(1)
    expect(cancels[0].epoch).toBe(2)
    // The superseding render itself is queued, not yet dispatched.
    expect(postedEpochs(worker)).toEqual([1])
  })

  it('does not cancel an in-flight render when a recolorize supersedes it', () => {
    // A recolorize re-tints whatever the in-flight render is computing, so it
    // must let that render finish rather than abort it — aborting would leave a
    // partial iteration buffer for the recolorize to read. The render runs to
    // completion; the recolorize then dispatches against its whole buffer.
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1 → posted, in flight
    client.recolorize(ctx, PALETTE_MAGMA, MODE_HISTOGRAM) // epoch 2 → queued

    expect(postedCancels(worker)).toHaveLength(0)

    deliver(worker, response(1)) // render completes → flush the queued recolorize
    expect((postedWork(worker)[1] as { kind: string }).kind).toBe('recolorize')
  })

  it('does not post a cancel for the first render (nothing in flight to cancel)', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1 → dispatched immediately, nothing to cancel

    expect(postedCancels(worker)).toHaveLength(0)
  })

  it('discardInFlight posts a cancel so the worker abandons the in-flight render', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, in flight
    client.discardInFlight() // bumps to epoch 2 and cancels the worker's work

    const cancels = postedCancels(worker)
    expect(cancels).toHaveLength(1)
    expect(cancels[0].epoch).toBe(2)
  })

  it('an aborted reply frees the slot and dispatches the queued request (no paint)', () => {
    const { client, worker } = makeClient()
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, in flight
    doRender(client, ctx) // epoch 2, queued (and a cancel posted)
    expect(postedEpochs(worker)).toEqual([1])

    // The worker abandoned epoch 1 mid-flight; without freeing the slot the
    // queued epoch 2 would never dispatch (the freeze the aborted arm guards).
    deliverAborted(worker, 1)

    expect(postedEpochs(worker)).toEqual([1, 2])
    // An abort carries no frame, so nothing paints.
    expect(ctx.putImageData).not.toHaveBeenCalled()
  })

  it('drives the progress reporter across a render lifecycle', () => {
    const reporter = { begin: vi.fn(), report: vi.fn(), end: vi.fn() }
    const { client, worker } = makeClient({ progress: reporter })
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // dispatched → begin()
    expect(reporter.begin).toHaveBeenCalledTimes(1)

    deliverProgress(worker, 1, 3, 12) // a band heartbeat → report(0.25)
    deliverProgress(worker, 1, 9, 12) // → report(0.75)
    expect(reporter.report.mock.calls).toEqual([[0.25], [0.75]])

    deliver(worker, response(1)) // frame lands → end()
    expect(reporter.end).toHaveBeenCalledTimes(1)
  })

  it('ignores progress for an already-superseded render (a doomed frame never moves the bar)', () => {
    const reporter = { begin: vi.fn(), report: vi.fn(), end: vi.fn() }
    const { client, worker } = makeClient({ progress: reporter })
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // epoch 1, in flight
    doRender(client, ctx) // epoch 2 supersedes it (latestEpoch is now 2)

    // A late heartbeat for the doomed epoch-1 render must not advance the
    // indicator the user is now waiting on for epoch 2.
    deliverProgress(worker, 1, 6, 12)
    expect(reporter.report).not.toHaveBeenCalled()
  })

  it('ends progress when the in-flight render is aborted', () => {
    const reporter = { begin: vi.fn(), report: vi.fn(), end: vi.fn() }
    const { client, worker } = makeClient({ progress: reporter })
    const ctx = makeCtx()
    deliver(worker, readyMsg())

    doRender(client, ctx) // begin()
    deliverAborted(worker, 1) // terminal → end()

    expect(reporter.end).toHaveBeenCalledTimes(1)
  })
})
