import { expect, type Page } from '@playwright/test'
import { Viewport } from '../src/viewport.js'

// The view every pick test starts from: the boot seahorse, Mandelbrot,
// render scale 1, so the painted buffer is the window's own size.
export const START = { re: -0.7435, im: 0.1314, zoom: 200 }
export const START_HASH = `#re=${START.re}&im=${START.im}&z=${START.zoom}&it=256&kind=mandelbrot`

// Booting instantiates the threaded WASM module and starts its pool in the
// worker: seconds on a small CI runner, past `expect`'s default 5 s.
const BOOT_TIMEOUT_MS = 30_000

/** Load the app at `hash` and wait for its first frame. */
export async function boot(page: Page, hash = START_HASH): Promise<void> {
  await page.goto(`/${hash}`)
  await waitForFirstFrame(page)
}

/**
 * Wait for the loaded page's first frame: the worker has booted (the canvas is
 * no longer inert) and the frame has painted (the canvas buffer has taken the
 * window's size; it starts at the HTML's 800×600). That second signal needs
 * render scale 1 and a window that isn't 800 px wide: true of the Desktop
 * Chrome project (1280×720) and the reference-image tests (480×320).
 */
export async function waitForFirstFrame(page: Page): Promise<void> {
  await expect(page.locator('.stage')).not.toHaveAttribute('inert', { timeout: BOOT_TIMEOUT_MS })
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector<HTMLCanvasElement>('#fractal')
      if (canvas === null) return false
      return canvas.width === Math.round(canvas.getBoundingClientRect().width)
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  )
}

/** The canvas's box in page coordinates and its buffer size. */
export async function canvasGeometry(page: Page): Promise<{
  left: number
  top: number
  width: number
  height: number
  bufferWidth: number
  bufferHeight: number
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#fractal')
    if (canvas === null) throw new Error('canvas#fractal not found')
    const rect = canvas.getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
    }
  })
}

/**
 * The sample the kernel rendered for the buffer pixel under CSS point
 * `(x, y)` of the canvas, `shift` buffer pixels after a pan's blit: what a
 * pick there must name. Projected through the app's own `Viewport`.
 */
export async function renderedSampleAt(
  page: Page,
  x: number,
  y: number,
  shift = { dx: 0, dy: 0 },
): Promise<{ re: number; im: number }> {
  const g = await canvasGeometry(page)
  const rendered = new Viewport(START.re, START.im, START.zoom, g.bufferWidth, g.bufferHeight)
  return rendered.pixelToComplex(
    Math.floor((x / g.width) * g.bufferWidth - shift.dx),
    Math.floor((y / g.height) * g.bufferHeight - shift.dy),
  )
}

/** The Julia constant the URL holds once a pick has switched to Julia. */
export async function pickedC(page: Page): Promise<{ re: number; im: number }> {
  // The URL write is debounced (400 ms), so wait for the switch to land.
  await expect.poll(() => hashParam(page, 'kind')).toBe('julia')
  return { re: Number(await hashParam(page, 'cre')), im: Number(await hashParam(page, 'cim')) }
}

export async function hashParam(page: Page, name: string): Promise<string | null> {
  return new URLSearchParams(new URL(page.url()).hash.slice(1)).get(name)
}

// How long a final frame holds still: past the resize refit's 150 ms debounce.
const QUIET_MS = 400

/**
 * Wait until the canvas's frame is final: no render is on the worker (the
 * stage isn't `aria-busy`) and the pixels have held still for longer than the
 * resize refit's 150 ms debounce, which can start one more render after the
 * first frame.
 */
export async function waitForSettledFrame(page: Page): Promise<void> {
  await page.locator('#fractal').evaluate(
    (element: HTMLCanvasElement, { quietMs, timeoutMs }) =>
      new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + timeoutMs
        const stage = element.parentElement ?? element
        const context = element.getContext('2d')
        if (context === null) throw new Error('the canvas has no 2d context')
        // A cheap hash of the pixels: comparing frames, not encoding them.
        const hash = (): number => {
          const { data } = context.getImageData(0, 0, element.width, element.height)
          let h = 0
          for (let i = 0; i < data.length; i += 1) h = (Math.imul(h, 31) + data[i]) | 0
          return h
        }
        let last = hash()
        let stillSince = performance.now()
        const poll = (): void => {
          const now = hash()
          const busy = stage.hasAttribute('aria-busy')
          if (performance.now() > deadline) {
            const why = busy ? 'still aria-busy' : 'pixels still changing'
            reject(new Error(`the canvas never settled: ${why}`))
            return
          }
          if (now !== last || busy) {
            last = now
            stillSince = performance.now()
          } else if (performance.now() - stillSince >= quietMs) {
            resolve()
            return
          }
          setTimeout(poll, 50)
        }
        poll()
      }),
    // A slow runner's render can take as long as booting.
    { quietMs: QUIET_MS, timeoutMs: BOOT_TIMEOUT_MS },
  )
}

/**
 * The canvas buffer as a PNG once its frame is final (`waitForSettledFrame`).
 * These are the kernel's own pixels, without the drawer, HUD or fonts a page
 * screenshot would pick up, so they are the same image on any OS.
 */
export async function settledCanvasPng(page: Page): Promise<Buffer> {
  await waitForSettledFrame(page)
  const url = await page
    .locator('#fractal')
    .evaluate((element: HTMLCanvasElement) => element.toDataURL('image/png'))
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
}

/** The canvas buffer's raw RGBA bytes once its frame is final. */
export async function settledRgba(page: Page): Promise<Buffer> {
  await waitForSettledFrame(page)
  const base64 = await page.locator('#fractal').evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')
    if (context === null) throw new Error('the canvas has no 2d context')
    const { data } = context.getImageData(0, 0, element.width, element.height)
    let binary = ''
    for (let i = 0; i < data.length; i += 0x8000) {
      binary += String.fromCharCode(...data.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  })
  return Buffer.from(base64, 'base64')
}
