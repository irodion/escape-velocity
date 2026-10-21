/**
 * The main thread's end of a render worker, up to and around its boot (#160).
 *
 * The live render client and PNG export each run their own worker, and both
 * have to get it booted: the worker instantiates WASM, posts a `boot`
 * heartbeat, stands up its thread pool, then posts `ready` — or reports a
 * `boot-error`, or dies at the top level (`worker.onerror`), or hangs. This
 * module owns that handshake once, so the two clients can't drift apart (they
 * did: export kept waiting out its timeout on a `boot-error` the live client
 * already surfaced). A client gets `onReady`, the traffic after boot through
 * `onMessage`, and every way the worker can turn out unusable as one
 * `onFatal` with a message fit for a person to read. The worker is terminated
 * then: nothing more can come of it, and a hung one would otherwise keep its
 * WASM memory and pool threads for the life of the page.
 *
 * The watchdog has two modes. `'boot'` covers the boot only, and `ready`
 * stops it: the live client's worker idles for long stretches once booted.
 * `'stall'` is re-armed by every message until `close()`: an export render
 * can legitimately run for minutes, and its per-band `progress` shows it is
 * alive, so only a silent gap means it's stuck.
 */
import type { BootError, MainToWorker, WorkerToMain } from './protocol.js'

/** A message the worker posts once it has booted: a reply to a request. */
export type WorkerReply = Exclude<WorkerToMain, { kind: 'boot' | 'boot-error' | 'ready' }>

export interface ConnectionHandlers {
  /** The worker has booted (WASM and its thread pool); requests can go out. */
  readonly onReady: () => void
  /** A reply: a response, error, abort, progress heartbeat or probe result. */
  readonly onMessage: (msg: WorkerReply) => void
  /**
   * The worker is unusable: its boot failed or hung, it threw at the top
   * level, or (`'stall'` mode) it went silent. Called at most once, after the
   * worker is terminated; nothing is delivered after it, not even a reply to
   * a request still in flight.
   */
  readonly onFatal: (message: string) => void
}

export interface ConnectionOptions {
  /** Declare the worker unusable after this long without a sign of life. No watchdog when omitted. */
  readonly timeoutMs?: number
  /** What the watchdog covers (see the module doc). Defaults to `'boot'`. */
  readonly watch?: 'boot' | 'stall'
}

export interface WorkerConnection {
  /**
   * Post a request. Throws before `onReady`: the worker attaches its handler
   * only once booted, so an earlier message would be lost without a word. A
   * no-op once the connection is fatal or closed, which the caller was told.
   */
  readonly post: (msg: MainToWorker) => void
  /** Stop the watchdog and terminate the worker. Nothing is delivered after it. */
  readonly close: () => void
}

export function connectWorker(
  workerFactory: () => Worker,
  handlers: ConnectionHandlers,
  options: ConnectionOptions = {},
): WorkerConnection {
  const { timeoutMs, watch = 'boot' } = options
  const worker = workerFactory()
  let ready = false
  // How far the worker's two-step boot got (#83): set by the `boot` heartbeat
  // once WASM has instantiated. A watchdog firing before `ready` uses it to
  // blame the thread pool or the instantiation (see `bootTimeoutMessage`).
  let wasmInstantiated = false
  // Set by a fatal or by `close()`: the connection is over.
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const stopWatchdog = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const armWatchdog = (): void => {
    if (timeoutMs === undefined) {
      return
    }
    stopWatchdog()
    timer = setTimeout(() => {
      timer = undefined
      const stage = ready ? null : bootStage(wasmInstantiated)
      fail(
        watch === 'boot' && stage !== null
          ? bootTimeoutMessage(timeoutMs, stage)
          : stalledMessage(timeoutMs, stage),
      )
    }, timeoutMs)
  }
  const fail = (message: string): void => {
    if (ended) {
      return
    }
    ended = true
    stopWatchdog()
    worker.terminate()
    handlers.onFatal(message)
  }

  worker.onmessage = (event: MessageEvent<WorkerToMain>): void => {
    if (ended) {
      return
    }
    const msg = event.data
    if (watch === 'stall') {
      armWatchdog()
    }
    switch (msg.kind) {
      case 'boot':
        wasmInstantiated = true
        return
      case 'boot-error':
        // A boot step threw and the worker caught it: a rejection in a module
        // worker's top-level async path never reaches `worker.onerror`
        // reliably, so this is the only way the real cause gets out (#83).
        fail(bootErrorMessage(msg))
        return
      case 'ready':
        ready = true
        if (watch === 'boot') {
          stopWatchdog()
        }
        handlers.onReady()
        return
      default:
        handlers.onMessage(msg)
    }
  }

  // A top-level throw in the worker (WASM instantiation, or the cross-origin
  // isolation gate in worker.ts) fires here, not `onmessage`. No reply will
  // ever come. `preventDefault` suppresses the browser's own console report;
  // the client logs the fatal more legibly. Once the connection has ended
  // there is no fatal left to report it as, so the browser keeps its report.
  worker.onerror = (event: ErrorEvent): void => {
    if (ended) {
      return
    }
    event.preventDefault()
    fail(
      event.message ||
        'The render worker failed to start. The page may not be cross-origin ' +
          'isolated, which the multithreaded renderer requires (SharedArrayBuffer).',
    )
  }

  armWatchdog()

  return {
    post: (msg) => {
      if (ended) {
        return
      }
      if (!ready) {
        throw new Error(`posted a '${msg.kind}' to the render worker before it was ready`)
      }
      worker.postMessage(msg)
    },
    close: () => {
      ended = true
      stopWatchdog()
      worker.terminate()
    },
  }
}

/**
 * Compose a human, on-screen message for a worker {@link BootError} (#83). The
 * fatal panel is the only diagnostic a phone user can read without a console,
 * so each stage names what it means in plain terms and appends the raw error
 * text, which usually pins the exact cause (an unsupported WASM feature, a
 * `SharedArrayBuffer` RangeError, a stripped isolation header).
 */
function bootErrorMessage(err: BootError): string {
  const detail = err.message ? ` (${err.message})` : ''
  switch (err.stage) {
    case 'isolation':
      return (
        'The renderer needs cross-origin isolation (SharedArrayBuffer), which ' +
        `this page is not serving${detail}.`
      )
    case 'init':
      return (
        'The WebAssembly renderer failed to load. This browser may be missing a ' +
        'feature the build requires (for example WebAssembly threads on an older ' +
        `browser), or an isolation header was stripped${detail}.`
      )
    case 'thread-pool':
      return (
        'The renderer loaded but its multithreaded worker pool failed to start ' +
        `on this browser${detail}.`
      )
  }
}

// Where a boot that went quiet stalled. A timeout, not a thrown error: the
// worker hung rather than rejecting (a rejection would have arrived as
// `boot-error`). The boot-stage heartbeat localises it: if WASM instantiated,
// the thread pool is what never came up; if not, instantiation itself stalled.
function bootStage(wasmInstantiated: boolean): string {
  return wasmInstantiated
    ? 'its multithreaded worker pool did not come up'
    : 'the WebAssembly module did not finish loading'
}

// The `'boot'` watchdog: the boot as a whole overran its time.
function bootTimeoutMessage(timeoutMs: number, stage: string): string {
  return (
    `The renderer did not start within ${timeoutMs / 1000}s: ${stage}. ` +
    'This can be an unsupported browser, lost cross-origin isolation ' +
    '(SharedArrayBuffer), or a stale cached build — try fully closing the ' +
    'tab and reopening, or reload in a private window.'
  )
}

// The `'stall'` watchdog: the worker went silent, stuck or dead without a
// terminal message. Every message re-armed it, so name the gap, not a total;
// `stage` says where, if it hadn't finished booting.
function stalledMessage(timeoutMs: number, stage: string | null): string {
  const where = stage === null ? '' : ` (while starting: ${stage})`
  return `The renderer stopped responding: nothing from it for ${timeoutMs / 1000}s${where}.`
}
