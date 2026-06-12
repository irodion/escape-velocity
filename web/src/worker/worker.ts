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
 * Deliberately logic-free: it bootstraps WASM + the thread pool,
 * announces `ready`, and forwards every message to `handleMessage` (the
 * deep module from #29), threading the cache state across calls and
 * echoing back the transfer list so the RGBA buffer moves zero-copy to
 * the client.
 */
import init, { initThreadPool } from '../../wasm/fractal_wasm.js'
import { createWorkerState, handleMessage, type WorkerState } from './handler.js'
import type { Ready, RecolorizeRequest, RenderError, RenderRequest } from './protocol.js'

// `self` is the DedicatedWorkerGlobalScope inside a module worker.
const ctx = self as unknown as DedicatedWorkerGlobalScope

// Cross-origin isolation gate (ADR-0008). The Slice 7B artifact links a
// *shared* WebAssembly memory, which the browser only backs with a
// `SharedArrayBuffer` when the document is cross-origin isolated (COOP:
// same-origin + COEP: require-corp). Without it, `init()` cannot even
// instantiate the module and the thread pool cannot spawn. Fail fast
// here with a legible message at worker boot, rather than letting a
// cryptic WebAssembly LinkError surface later — `ready` is never posted,
// so no render is ever attempted against a pool that does not exist.
if (!ctx.crossOriginIsolated) {
  throw new Error(
    'Render worker: the page is not cross-origin isolated, so ' +
      'SharedArrayBuffer (required for WASM threads, ADR-0007) is ' +
      'unavailable. Serve with Cross-Origin-Opener-Policy: same-origin ' +
      'and Cross-Origin-Embedder-Policy: require-corp (ADR-0008).',
  )
}

const wasm = await init()
// Stand up the rayon thread pool before announcing readiness, so the
// first `compute` already runs multicore. `navigator.hardwareConcurrency`
// is the logical-core count; on a single-core device this yields a pool
// of one and rendering still works.
await initThreadPool(navigator.hardwareConcurrency)

let state: WorkerState = createWorkerState()

const ready: Ready = { kind: 'ready' }
ctx.postMessage(ready)

ctx.onmessage = (event: MessageEvent<RenderRequest | RecolorizeRequest>): void => {
  // `handleMessage` can throw — the `recolorize: no cached buffer` guard, or
  // a `JsError` from the WASM `Viewport` / `compute` boundary validation.
  // Catch it and post an `error` arm (echoing the request's epoch) instead of
  // letting the throw post nothing: a silent no-response wedges the client's
  // single-slot pipeline permanently (see `RenderError`). The worker stays
  // alive and ready for the next request; only the failed frame is lost.
  try {
    const result = handleMessage(state, event.data, wasm)
    state = result.state
    ctx.postMessage(result.response, result.transfer)
  } catch (err) {
    const error: RenderError = {
      kind: 'error',
      epoch: event.data.epoch,
      message: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(error)
  }
}
