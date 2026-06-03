/// <reference lib="webworker" />
/**
 * Render-worker entry point. Owns its own WASM instance — separate from
 * the main thread's — so the heavy `compute` → `colorize` cycle runs off
 * the UI thread and never freezes input (ADR-0007's first slice).
 *
 * Deliberately logic-free: it bootstraps WASM, announces `ready`, and
 * forwards every message to `handleMessage` (the deep module from #29),
 * threading the cache state across calls and echoing back the transfer
 * list so the RGBA buffer moves zero-copy to the client.
 */
import init from '../../wasm/fractal_wasm.js'
import { createWorkerState, handleMessage, type WorkerState } from './handler.js'
import type { Ready, RecolorizeRequest, RenderRequest } from './protocol.js'

// `self` is the DedicatedWorkerGlobalScope inside a module worker.
const ctx = self as unknown as DedicatedWorkerGlobalScope

const wasm = await init()
let state: WorkerState = createWorkerState()

const ready: Ready = { kind: 'ready' }
ctx.postMessage(ready)

ctx.onmessage = (event: MessageEvent<RenderRequest | RecolorizeRequest>): void => {
  const result = handleMessage(state, event.data, wasm)
  state = result.state
  ctx.postMessage(result.response, result.transfer)
}
