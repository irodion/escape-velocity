/**
 * PNG export (O2, #92).
 *
 * Both export buttons (`1×` at the on-screen resolution, `2×` supersampled)
 * render the *requested* state off-screen via `exportRenderedFrame` rather than
 * grabbing the on-screen canvas bitmap. Grabbing the canvas looked cheaper, but
 * it is only correct when the canvas is already showing the latest committed
 * view: during an in-flight render or recolorize the canvas still holds the
 * *previous* frame while the live settings/viewport (and so the permalink the
 * filename embeds) have already advanced — saving then would download stale
 * pixels under a filename naming a different view. Rendering the requested state
 * makes the pixels and the filename describe the same frame, always.
 *
 * It deliberately does NOT reuse the live `render-client` singleton: that client
 * has a global epoch + a single in-flight slot (see its module doc; the factory
 * refactor is #86), so dispatching an export render through it would supersede —
 * and visually clobber — the frame the user is looking at. Instead a dedicated
 * one-shot worker boots, renders exactly one request, and is terminated. The
 * cost is a brief second WASM boot per export, which is fine for an explicit,
 * infrequent action and keeps the live pipeline untouched.
 *
 * The caller builds the `RenderRequest` (it owns the viewport + the form→wasm
 * enum mapping), reusing `computeBufferDims` so the export buffer rides the same
 * render-scale machinery — including the pixel-budget clamp — as every
 * on-screen render.
 */

import type { ViewState } from './view-state.js'
import { serialize } from './view-state.js'
import type {
  Aborted,
  BootError,
  BootProgress,
  Ready,
  RenderError,
  RenderRequest,
  RenderResponse,
} from './worker/protocol.js'

// Hard ceiling on a single export render before we give up and free the UI.
// Generous: the export boots a fresh WASM instance + thread pool and then runs
// one full (possibly deep, 2× supersampled) frame — far slower than the warm
// on-screen pipeline. The point is not to bound a slow-but-progressing render
// but to recover from a worker that never settles (a stuck boot — the same
// failure the live client guards with its own boot watchdog — or a worker that
// dies without posting a terminal message), which would otherwise leave the
// export buttons disabled forever with no way to retry.
const EXPORT_TIMEOUT_MS = 60_000

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
  return canvasToPngBlob(canvas)
}

/**
 * Render `request` on a dedicated one-shot worker and save the result as a PNG.
 * The worker boots its own WASM + thread pool, renders exactly one frame, and
 * is terminated in `finally` whether the render succeeds or fails.
 */
export async function exportRenderedFrame(request: RenderRequest, filename: string): Promise<void> {
  // Same worker entry as the live pipeline — Vite bundles it as its own chunk.
  const worker = new Worker(new URL('./worker/worker.ts', import.meta.url), { type: 'module' })
  try {
    const response = await new Promise<RenderResponse>((resolve, reject) => {
      // Every terminal path clears this so the timer never outlives the Promise;
      // the timeout itself rejects, which (via the `finally` below) terminates
      // the worker and lets `runExport` re-enable the buttons.
      const timer = setTimeout(() => {
        reject(new Error(`export render timed out after ${EXPORT_TIMEOUT_MS / 1000}s`))
      }, EXPORT_TIMEOUT_MS)
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
          Ready | RenderResponse | RenderError | Aborted | BootProgress | BootError
        >,
      ): void => {
        const msg = event.data
        switch (msg.kind) {
          case 'boot':
            // Non-terminal boot heartbeat (#83): WASM instantiated, the pool is
            // next. Nothing to do on a one-shot export — wait for `ready`.
            return
          case 'boot-error':
            // The worker bootstrap failed and reported it via postMessage (a
            // module-worker top-level rejection does NOT reliably fire
            // `worker.onerror`, #83), so without this arm the export would sit
            // disabled until the 60s timeout. Reject now with the real cause.
            settleReject(
              new Error(`export render worker failed to boot (${msg.stage}): ${msg.message}`),
            )
            return
          case 'ready':
            // The worker buffers nothing of its own; dispatch the single render
            // only once it has booted its WASM instance and thread pool.
            worker.postMessage(request)
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
          // `progress` heartbeats are ignored — a one-shot export shows no bar.
        }
      }
      worker.onerror = (event: ErrorEvent): void => {
        event.preventDefault()
        settleReject(new Error(event.message || 'export render worker failed to start'))
      }
    })
    const blob = await rgbaToPngBlob(response.rgba, response.width, response.height)
    downloadBlob(blob, filename)
  } finally {
    worker.terminate()
  }
}
