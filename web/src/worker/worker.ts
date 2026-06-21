/// <reference lib="webworker" />
/**
 * Render-worker entry point. Owns its own WASM instance — separate from
 * the main thread's — so the heavy `compute` → `colorize` cycle runs off
 * the UI thread and never freezes input (ADR-0007's first slice).
 *
 * Slice 7C makes that instance *multicore*: before announcing `ready`,
 * the worker stands up a `wasm-bindgen-rayon` thread pool sized to the
 * device's cores, which backs `fractal-core::compute`'s parallel
 * iterator. The render-client buffers every request until `ready`
 * (Slice 6), so gating `ready` on the pool means the first render — and
 * every render after — runs in parallel with no client-side change.
 *
 * Bootstraps WASM + the thread pool, announces `ready`, then routes each
 * message to the deep handler module (#29): a `render` runs as a cancellable
 * band sequence via `handleRender`, a `recolorize` takes the synchronous
 * fast path via `handleRecolorize`, and a `cancel` just advances the
 * "latest epoch seen" so an in-flight banded render can abandon itself (P2,
 * #78). It threads the cache state across calls and echoes back the transfer
 * list so the RGBA buffer moves zero-copy to the client.
 */
import init, { initThreadPool } from '../../wasm/fractal_wasm.js'
import {
  createWorkerState,
  handleProbe,
  handleRecolorize,
  handleRender,
  type WorkerState,
} from './handler.js'
import type {
  Aborted,
  BootError,
  BootProgress,
  CancelRequest,
  ProbeRequest,
  ProgressResponse,
  Ready,
  RecolorizeRequest,
  RenderError,
  RenderRequest,
} from './protocol.js'

// `self` is the DedicatedWorkerGlobalScope inside a module worker.
const ctx = self as unknown as DedicatedWorkerGlobalScope

// The WASM instance, assigned by `boot()` before any message is routed. The
// message handler is only wired after boot succeeds, so every read sees it set.
let wasm: Awaited<ReturnType<typeof init>>

let state: WorkerState = createWorkerState()

// The highest epoch this worker has *seen* on any incoming message. A banded
// render compares its own epoch against this between bands: once a newer
// request has arrived (a `cancel`, the client's supersede signal), the render
// abandons its remaining bands rather than grinding a doomed frame to
// completion (P2, #78). Monotonic.
let latestSeen = 0

// A MessageChannel-backed macrotask yield. A `setTimeout(0)` is clamped to
// ~4ms once nested a few deep; a channel ping is a true macrotask with no
// clamp, so yielding between a frame's ~12 bands adds negligible latency
// while still returning control to the event loop so a queued `cancel` is
// delivered (and `latestSeen` updated) before the next band. Only one render
// runs at a time, so at most one yield is ever outstanding — a single pending
// resolver suffices.
const yieldChannel = new MessageChannel()
let resumeYield: (() => void) | undefined
yieldChannel.port1.onmessage = (): void => {
  const resolve = resumeYield
  resumeYield = undefined
  resolve?.()
}
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    resumeYield = resolve
    yieldChannel.port2.postMessage(null)
  })
}

// Two-step bootstrap, instrumented so a failure or hang is legible rather than
// a silent 5 s watchdog (#83). Each step runs in this module worker's top-level
// async path, where a rejection does NOT reliably reach the main thread's
// `worker.onerror` — so every failure is caught here and posted as a
// {@link BootError} carrying the real error text and the stage that failed. On
// the happy path the worker posts `{ kind: 'boot', stage: 'wasm' }` the moment
// the module instantiates (so the client can localise a *hang* to the pool
// step), wires the message handler, then announces `ready`.
async function boot(): Promise<void> {
  // Cross-origin isolation gate (ADR-0008). The Slice 7B artifact links a
  // *shared* WebAssembly memory, which the browser only backs with a
  // `SharedArrayBuffer` when the document is cross-origin isolated (COOP:
  // same-origin + COEP: require-corp). Without it `init()` cannot instantiate
  // and the pool cannot spawn. Fail fast with a legible message.
  if (!ctx.crossOriginIsolated) {
    postBootError(
      'isolation',
      'The page is not cross-origin isolated, so SharedArrayBuffer (required ' +
        'for WASM threads, ADR-0007) is unavailable. Serve with ' +
        'Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp (ADR-0008).',
    )
    return
  }

  try {
    wasm = await init()
  } catch (err) {
    // The binary failed to instantiate — most often an unsupported required
    // WASM feature on this browser (e.g. a SIMD-built binary on a browser below
    // the SIMD floor), or a LinkError from a stripped isolation header.
    postBootError('init', err)
    return
  }
  // WASM is up. Tell the client, so if the next step hangs the watchdog can say
  // so specifically rather than blaming instantiation.
  const wasmUp: BootProgress = { kind: 'boot', stage: 'wasm' }
  ctx.postMessage(wasmUp)

  try {
    // Stand up the rayon thread pool before announcing readiness, so the first
    // `compute` already runs multicore. Size it to one *fewer* than the
    // logical-core count: the pool runs alongside this coordinating worker and
    // the main thread, so claiming every core oversubscribes and can starve the
    // compositor the wheel Preview is composited on (P7, #83). `hardwareConcurrency`
    // can be `undefined` on some mobile/privacy browsers; `|| 1` floors it so the
    // arithmetic never yields `NaN` (which would spawn a broken pool), and
    // `Math.max(1, …)` keeps a single-core device at a pool of one.
    await initThreadPool(Math.max(1, (navigator.hardwareConcurrency || 1) - 1))
  } catch (err) {
    postBootError('thread-pool', err)
    return
  }

  ctx.onmessage = handleMessage
  const ready: Ready = { kind: 'ready' }
  ctx.postMessage(ready)
}

// Post a boot failure for the client to surface (see {@link BootError}). The
// worker is unusable after this, so no `ready` follows and the handler stays
// unwired.
function postBootError(stage: BootError['stage'], err: unknown): void {
  const error: BootError = {
    kind: 'boot-error',
    stage,
    message: err instanceof Error ? err.message : String(err),
  }
  ctx.postMessage(error)
}

function handleMessage(
  event: MessageEvent<RenderRequest | RecolorizeRequest | CancelRequest | ProbeRequest>,
): void {
  const msg = event.data

  if (msg.kind === 'probe') {
    // A read-only side query (E2, #95). It carries a `seq`, not an `epoch`, so
    // it neither bumps `latestSeen` nor supersedes a render; it just reads the
    // current cache and replies. The client only issues one when the cache is
    // stable (not mid-render, no active Preview), so the buffer it reads is whole.
    ctx.postMessage(handleProbe(state, msg))
    return
  }

  // Record the newest epoch across ALL message kinds first, so an in-flight
  // banded render can detect supersession even by a bare `cancel`.
  if (msg.epoch > latestSeen) {
    latestSeen = msg.epoch
  }

  if (msg.kind === 'cancel') {
    // The signal's entire job is the `latestSeen` bump above; the in-flight
    // render observes it between bands. Nothing to post.
    return
  }

  if (msg.kind === 'recolorize') {
    // Fast path (ADR-0002): no per-band work to cancel, run it straight
    // through. Per the client's single-in-flight contract a recolorize never
    // races a render, so the cached buffer it reads is whole.
    try {
      const result = handleRecolorize(state, msg, wasm)
      ctx.postMessage(result.response, result.transfer)
    } catch (err) {
      postError(msg.epoch, err)
    }
    return
  }

  // A render is async (banded). Fire and forget; the client's single-in-flight
  // contract guarantees no second render arrives until this one replies, so
  // the band sequence owns the shared iteration buffer uncontended.
  void runRender(msg)
}

async function runRender(msg: RenderRequest): Promise<void> {
  try {
    const result = await handleRender(msg, wasm, {
      yieldToEventLoop,
      shouldAbort: () => latestSeen > msg.epoch,
      onProgress: (rowsDone, rowsTotal) => {
        const progress: ProgressResponse = {
          kind: 'progress',
          epoch: msg.epoch,
          rowsDone,
          rowsTotal,
        }
        ctx.postMessage(progress)
      },
    })
    if ('aborted' in result) {
      // Superseded mid-flight. The abandoned render already clobbered the
      // shared iteration buffer with partial bands, so the cached (ptr, len)
      // no longer describes a complete frame — drop it so a later recolorize
      // can't re-tint partial data (it will hit the no-cache guard and surface
      // a recoverable error instead). The superseding render, the usual next
      // request, rebuilds the buffer regardless.
      state = createWorkerState()
      // Post `aborted` (not a response) so the client frees its in-flight slot
      // and dispatches the request that overtook us.
      const aborted: Aborted = { kind: 'aborted', epoch: msg.epoch }
      ctx.postMessage(aborted)
      return
    }
    state = result.state
    ctx.postMessage(result.response, result.transfer)
  } catch (err) {
    // A throw inside the band loop (a `JsError` from the WASM `Viewport` /
    // `compute_band` boundary validation). Post an `error` arm echoing the
    // epoch instead of letting the throw post nothing — a silent no-response
    // wedges the client's single-slot pipeline permanently (see `RenderError`).
    postError(msg.epoch, err)
  }
}

// Post a `RenderError` echoing the failed request's epoch. The worker stays
// alive and ready for the next request; only the failed frame is lost.
function postError(epoch: number, err: unknown): void {
  const error: RenderError = {
    kind: 'error',
    epoch,
    message: err instanceof Error ? err.message : String(err),
  }
  ctx.postMessage(error)
}

// Kick off the bootstrap. Fire-and-forget: `boot()` owns its own error
// surfacing (every failure posts a `boot-error`), so there is nothing to await
// or catch here.
void boot()
