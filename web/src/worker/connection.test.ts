import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeWorker } from '../testing/fake-worker.js'
import { type ConnectionOptions, connectWorker } from './connection.js'
import type { RenderRequest } from './protocol.js'

function connect(options?: ConnectionOptions) {
  const worker = new FakeWorker()
  const handlers = { onReady: vi.fn(), onMessage: vi.fn(), onFatal: vi.fn() }
  const connection = connectWorker(() => worker.asWorker(), handlers, options)
  return { worker, connection, ...handlers }
}

const BOOT = { kind: 'boot', stage: 'wasm' }
const READY = { kind: 'ready' }
const PROGRESS = { kind: 'progress', epoch: 1, rowsDone: 1, rowsTotal: 12 }
const REQUEST = { kind: 'render', epoch: 1 } as RenderRequest

describe('connectWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds the worker once and posts requests to it', () => {
    let built = 0
    const worker = new FakeWorker()
    const connection = connectWorker(
      () => {
        built += 1
        return worker.asWorker()
      },
      { onReady: () => {}, onMessage: () => {}, onFatal: () => {} },
    )
    connection.post(REQUEST)
    expect(built).toBe(1)
    expect(worker.posted).toEqual([REQUEST])
  })

  it('reports ready, and hands every reply after boot to onMessage', () => {
    const { worker, onReady, onMessage } = connect()
    worker.send(BOOT)
    expect(onReady).not.toHaveBeenCalled()
    worker.send(READY)
    expect(onReady).toHaveBeenCalledTimes(1)

    const response = {
      kind: 'response',
      epoch: 1,
      rgba: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    }
    worker.send(PROGRESS)
    worker.send(response)
    expect(onMessage.mock.calls).toEqual([[PROGRESS], [response]])
  })

  it.each([
    ['init', 'CompileError: bad SIMD opcode', ['WebAssembly', 'CompileError: bad SIMD opcode']],
    ['thread-pool', 'RangeError', ['worker pool', 'RangeError']],
    ['isolation', '', ['cross-origin isolation']],
  ])('turns a %s boot-error into a readable fatal (#83)', (stage, message, expected) => {
    const { worker, onFatal } = connect()
    worker.send({ kind: 'boot-error', stage, message })
    expect(onFatal).toHaveBeenCalledTimes(1)
    for (const text of expected) {
      expect(onFatal.mock.calls[0][0]).toContain(text)
    }
  })

  it('reports a top-level worker throw (onerror), suppressing the browser report', () => {
    const { worker, onFatal } = connect()
    const event = worker.fail('LinkError: shared memory unavailable')
    expect(onFatal).toHaveBeenCalledWith('LinkError: shared memory unavailable')
    expect(event.defaultPrevented).toBe(true)

    const bare = connect()
    bare.worker.fail('')
    expect(bare.onFatal).toHaveBeenCalledWith(expect.stringContaining('cross-origin isolated'))
  })

  it('reports a fatal once and delivers nothing after it', () => {
    const { worker, connection, onReady, onMessage, onFatal } = connect({ timeoutMs: 5000 })
    worker.send({ kind: 'boot-error', stage: 'isolation', message: '' })
    worker.fail('late')
    vi.advanceTimersByTime(5000) // the watchdog is stopped, not fired
    worker.send(READY)
    worker.send(PROGRESS)
    connection.post(REQUEST)

    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onReady).not.toHaveBeenCalled()
    expect(onMessage).not.toHaveBeenCalled()
    expect(worker.posted).toHaveLength(0)
  })

  describe("the 'boot' watchdog", () => {
    it('blames instantiation when WASM never loads', () => {
      const { onFatal } = connect({ timeoutMs: 5000 })
      vi.advanceTimersByTime(4999)
      expect(onFatal).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(onFatal).toHaveBeenCalledTimes(1)
      expect(onFatal.mock.calls[0][0]).toContain('did not start within 5s')
      expect(onFatal.mock.calls[0][0]).toContain('WebAssembly module did not finish loading')
    })

    it('blames the thread pool once WASM has instantiated (#83)', () => {
      const { worker, onFatal } = connect({ timeoutMs: 5000 })
      worker.send(BOOT) // doesn't re-arm: the boot as a whole gets 5 s
      vi.advanceTimersByTime(5000)
      expect(onFatal.mock.calls[0][0]).toContain('worker pool did not come up')
    })

    it('stops at ready: an idle booted worker is fine', () => {
      const { worker, onFatal } = connect({ timeoutMs: 5000 })
      worker.send(READY)
      vi.advanceTimersByTime(60_000)
      expect(onFatal).not.toHaveBeenCalled()
    })

    it('does not run without a timeout', () => {
      connect()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe("the 'stall' watchdog", () => {
    it('is re-armed by every message, so a slow render that reports progress lives on', () => {
      const { worker, onFatal } = connect({ timeoutMs: 1000, watch: 'stall' })
      for (const msg of [BOOT, READY, PROGRESS, PROGRESS, PROGRESS]) {
        vi.advanceTimersByTime(900)
        worker.send(msg)
      }
      expect(onFatal).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(onFatal).toHaveBeenCalledTimes(1)
      expect(onFatal.mock.calls[0][0]).toContain('stopped responding')
    })

    it('names the boot stage when it fires before ready', () => {
      const { worker, onFatal } = connect({ timeoutMs: 1000, watch: 'stall' })
      worker.send(BOOT)
      vi.advanceTimersByTime(1000)
      expect(onFatal.mock.calls[0][0]).toContain('worker pool did not come up')
    })
  })

  it('close stops the watchdog, terminates the worker, and ends delivery', () => {
    const { worker, connection, onMessage, onFatal } = connect({ timeoutMs: 1000, watch: 'stall' })
    worker.send(READY)
    connection.close()
    expect(worker.terminated).toBe(true)
    vi.advanceTimersByTime(5000)
    worker.send(PROGRESS)
    expect(onFatal).not.toHaveBeenCalled()
    expect(onMessage).not.toHaveBeenCalled()
  })
})
