import { expect, type Page, test } from '@playwright/test'
import { boot, START_HASH, settledCanvasPng } from './app.js'

// Small, so comparing raw pixels stays cheap.
test.use({ viewport: { width: 480, height: 320 } })

/** The settled canvas's raw RGBA bytes (settledCanvasPng waits for the frame). */
async function settledRgba(page: Page): Promise<Buffer> {
  await settledCanvasPng(page)
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

test('a panned frame matches a fresh render of the view the pan landed on (#170)', async ({
  page,
  context,
}) => {
  await boot(page, START_HASH)
  await settledCanvasPng(page)
  const before = page.url()

  // A real drag, left and down by an odd number of pixels.
  await page.mouse.move(240, 160)
  await page.mouse.down()
  await page.mouse.move(200, 180)
  await page.mouse.move(143, 197)
  await page.mouse.up()
  await expect.poll(() => page.url()).not.toBe(before)
  const panned = await settledRgba(page)

  // The same view, rendered from scratch in a page of its own.
  const fresh = await context.newPage()
  await boot(fresh, new URL(page.url()).hash)
  const expected = await settledRgba(fresh)

  expect(panned.length).toBe(expected.length)
  let differing = 0
  for (let i = 0; i < panned.length; i += 4) {
    if (
      panned[i] !== expected[i] ||
      panned[i + 1] !== expected[i + 1] ||
      panned[i + 2] !== expected[i + 2]
    ) {
      differing += 1
    }
  }
  // Carried pixels keep the value sampled at the old frame's coordinate, ~1
  // ULP from a fresh sample's (fractal_core's frame_shift module): a few
  // boundary pixels may differ, nothing more.
  console.log(`pan: ${differing} of ${panned.length / 4} pixels differ`)
  expect(differing / (panned.length / 4)).toBeLessThan(0.001)
})
