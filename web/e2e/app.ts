import { expect, type Page } from '@playwright/test'
import { Viewport } from '../src/viewport.js'

// The view every pick test starts from: the boot seahorse, Mandelbrot,
// render scale 1, so the painted buffer is the window's own size.
export const START = { re: -0.7435, im: 0.1314, zoom: 200 }
export const START_HASH = `#re=${START.re}&im=${START.im}&z=${START.zoom}&it=256&kind=mandelbrot`

// Booting instantiates the threaded WASM module and starts its pool in the
// worker: seconds on a small CI runner, past `expect`'s default 5 s.
const BOOT_TIMEOUT_MS = 30_000

/**
 * Load the app at `hash` and wait for its first frame: the worker has booted
 * (the canvas is no longer inert) and the frame has painted (the canvas buffer
 * has taken the window's size; it starts at the HTML's 800×600).
 */
export async function boot(page: Page, hash = START_HASH): Promise<void> {
  await page.goto(`/${hash}`)
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
