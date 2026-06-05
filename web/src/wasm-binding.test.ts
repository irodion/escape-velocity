import { describe, expect, it } from 'vitest'

// Import the *real* generated glue (not the vi.mock double the worker
// tests use) to assert the binding surface the worker depends on.
import * as wasm from '../wasm/fractal_wasm.js'

// Slice 7B binding smoke: the WASM crate re-exports `init_thread_pool`,
// so the generated glue must surface it as the async JS function
// `initThreadPool`. Slice 7C's worker awaits this to stand up the rayon
// thread pool before announcing readiness; if the re-export is ever
// dropped or the atomics build stops emitting it, the worker would fail
// to boot — this test catches that at `pnpm test` rather than at runtime
// in the browser. (A build/surface assertion, not a behaviour test: it
// deliberately does not call `init()` or spawn the pool.)
describe('wasm binding (Slice 7B)', () => {
  it('exposes initThreadPool for the worker to stand up the rayon pool', () => {
    expect(typeof wasm.initThreadPool).toBe('function')
  })

  it('still exposes the Slice 6 compute/colorize surface unchanged', () => {
    expect(typeof wasm.compute).toBe('function')
    expect(typeof wasm.colorize).toBe('function')
    expect(typeof wasm.compute_len).toBe('function')
    expect(typeof wasm.colorize_len).toBe('function')
    expect(typeof wasm.Viewport).toBe('function')
  })
})
