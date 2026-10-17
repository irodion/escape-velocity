/**
 * PNG export (O2, #92).
 *
 * Both export buttons (`1×` at the window size, `2×` at twice it)
 * render the *requested* state off-screen via `exportRenderedFrame` rather than
 * grabbing the on-screen canvas bitmap. Grabbing the canvas looked cheaper, but
 * it is only correct when the canvas is already showing the latest committed
 * view: during an in-flight render or recolorize the canvas still holds the
 * *previous* frame while the live settings/viewport (and so the permalink the
 * filename embeds) have already advanced — saving then would download stale
 * pixels under a filename naming a different view. Rendering the requested state
 * makes the pixels and the filename describe the same frame, always.
 *
 * It deliberately does NOT reuse the live render client: that client has one
 * epoch counter + a single in-flight slot and caches the worker's iteration
 * buffer (see `createRenderClient`), so dispatching an export render through it
 * would supersede — and visually clobber — the frame the user is looking at, and
 * evict the cache a recolorize depends on. Instead a dedicated
 * one-shot worker boots, renders exactly one request, and is terminated. The
 * cost is a brief second WASM boot per export, which is fine for an explicit,
 * infrequent action and keeps the live pipeline untouched.
 *
 * The caller builds the `RenderRequest` (it owns the viewport + the form→wasm
 * enum mapping), sizing the buffer with `computeExportDims` — the same
 * scale-and-budget machinery as every on-screen render, but independent of the
 * Resolution knob and against the export's own pixel budget
 * (`EXPORT_MAX_PIXELS`).
 */

import type { BufferDims } from './render-buffer.js'
import { computeBufferDims } from './render-buffer.js'
import type { ViewState } from './view-state.js'
import { serialize } from './view-state.js'
import type {
  Aborted,
  BootError,
  BootProgress,
  ProgressResponse,
  Ready,
  RenderError,
  RenderRequest,
  RenderResponse,
} from './worker/protocol.js'

// Inactivity watchdog for an export render: give up and free the UI once the
// worker has gone this long without posting anything. Every message (boot
// heartbeat, `ready`, each band's `progress`) re-arms it, so it never bounds a
// slow-but-progressing render — a deep, 16M px frame can legitimately run well
// past a minute in total (#157). What it catches is a worker that never settles
// (a stuck boot — the same failure the live client guards with its own boot
// watchdog — or a worker that dies without posting a terminal message), which
// would otherwise leave the export buttons disabled forever with no way to retry.
const EXPORT_STALL_TIMEOUT_MS = 60_000

// Pixel budget for an export buffer (#157). Deliberately separate from the
// on-screen `MAX_RENDER_PIXELS` (2.5M): that cap keeps interactive frames
// responsive, and sharing it clamped ordinary desktop windows — a 2560×1440
// window saved the same sub-window-size image from both buttons. An export runs
// once on its own worker, so it can afford far more: 16M covers a 2560×1440
// window at 2× (14.7M) and stays under iOS Safari's 4096² (16,777,216 px)
// canvas-area limit, past which `rgbaToPngBlob` could not encode. At the cap the
// worker holds ~128 MB (f32 iterations + RGBA in WASM memory), freed by
// terminating it before the encode; the main thread then holds ~128 MB (the
// transferred RGBA + the detached canvas) until the PNG is built.
export const EXPORT_MAX_PIXELS = 16_000_000

/**
 * Size an export buffer: the logical (CSS) window size × `multiplier` (1 or 2
 * for the two buttons), bounded by `EXPORT_MAX_PIXELS`. Independent of the
 * on-screen Resolution knob (a speed/sharpness trade-off for interaction), so
 * the two buttons always mean "the window size" and "twice it" — stacking the
 * knob let Resolution 2× push both past the budget onto the same clamped size.
 * The returned `scale` is the effective multiplier the caller applies to `zoom`
 * (see `computeBufferDims`).
 */
export function computeExportDims(
  logicalWidth: number,
  logicalHeight: number,
  multiplier: number,
): BufferDims {
  return computeBufferDims(logicalWidth, logicalHeight, multiplier, EXPORT_MAX_PIXELS)
}

/**
 * Build a download filename embedding the shareable permalink (O1, #91), so a
 * saved PNG carries the exact view that produced it. The permalink's `=`/`&`
 * separators are swapped for filename-safe `-`/`,` (both are legal in
 * filenames, but `&` reads as a shell metacharacter and some tools mangle it).
 */
export function buildFilename(state: ViewState): string {
  const params = serialize(state).slice(1) // drop the leading '#'
  const safe = params.replace(/=/g, '-').replace(/&/g, ',')
  return `escape-velocity-${safe}.png`
}

/**
 * Trigger a browser download of `blob` as `filename` via a transient anchor.
 * The object URL is revoked immediately after the synchronous `click()`; the
 * browser has already captured the blob by then.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Promise-wrap `canvas.toBlob`, rejecting on the null-blob failure case. */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('canvas.toBlob returned null (PNG encoding failed)'))
      } else {
        resolve(blob)
      }
    }, 'image/png')
  })
}

/** Paint an RGBA frame into a detached canvas and encode it as a PNG blob. */
function rgbaToPngBlob(
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) {
    return Promise.reject(new Error('failed to acquire 2d context for PNG export'))
  }
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
  // Zero the backing store once encoded rather than waiting for GC: WebKit
  // counts live canvases against a per-page memory cap, and at the export
  // budget each one is ~64 MB, so a few quick exports could exhaust it.
  return canvasToPngBlob(canvas).finally(() => {
    canvas.width = 0
    canvas.height = 0
  })
}

/**
 * Render `request` on a dedicated one-shot worker and save the result as a PNG.
 * The worker boots its own WASM + thread pool, renders exactly one frame, and
 * is terminated as soon as the frame (or a failure) arrives — before the PNG
 * encode, so its WASM memory and pool threads are not held through it.
 */
export async function exportRenderedFrame(request: RenderRequest, filename: string): Promise<void> {
  // Same worker entry as the live pipeline — Vite bundles it as its own chunk.
  const worker = new Worker(new URL('./worker/worker.ts', import.meta.url), { type: 'module' })
  let response: RenderResponse
  try {
    response = await new Promise<RenderResponse>((resolve, reject) => {
      // The stall watchdog: re-armed by every non-terminal message, cleared by
      // every terminal path so the timer never outlives the Promise. Firing
      // rejects, which (via the `finally` below) terminates the worker and lets
      // `runExport` re-enable the buttons.
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          reject(
            new Error(`export render stalled: no progress for ${EXPORT_STALL_TIMEOUT_MS / 1000}s`),
          )
        }, EXPORT_STALL_TIMEOUT_MS)
      }
      arm()
      const settleResolve = (value: RenderResponse): void => {
        clearTimeout(timer)
        resolve(value)
      }
      const settleReject = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      worker.onmessage = (
        event: MessageEvent<
          | Ready
          | RenderResponse
          | RenderError
          | Aborted
          | BootProgress
          | BootError
          | ProgressResponse
        >,
      ): void => {
        const msg = event.data
        switch (msg.kind) {
          case 'boot':
            // Non-terminal boot heartbeat (#83): WASM instantiated, the pool is
            // next. Nothing to do on a one-shot export — wait for `ready`.
            arm()
            return
          case 'boot-error':
            // The worker bootstrap failed and reported it via postMessage (a
            // module-worker top-level rejection does NOT reliably fire
            // `worker.onerror`, #83), so without this arm the export would sit
            // disabled until the stall watchdog fired. Reject now with the real
            // cause.
            settleReject(
              new Error(`export render worker failed to boot (${msg.stage}): ${msg.message}`),
            )
            return
          case 'ready':
            // The worker buffers nothing of its own; dispatch the single render
            // only once it has booted its WASM instance and thread pool.
            arm()
            worker.postMessage(request)
            return
          case 'progress':
            // A band finished: the render is alive, so push the watchdog out.
            // A one-shot export shows no progress bar.
            arm()
            return
          case 'response':
            settleResolve(msg)
            return
          case 'error':
            settleReject(new Error(`export render failed: ${msg.message}`))
            return
          case 'aborted':
            // No newer request exists on a one-shot worker, so this is
            // unexpected — surface it rather than hanging.
            settleReject(new Error('export render was aborted'))
            return
        }
      }
      worker.onerror = (event: ErrorEvent): void => {
        event.preventDefault()
        settleReject(new Error(event.message || 'export render worker failed to start'))
      }
    })
  } finally {
    worker.terminate()
  }
  const blob = await rgbaToPngBlob(response.rgba, response.width, response.height)
  downloadBlob(blob, filename)
}
