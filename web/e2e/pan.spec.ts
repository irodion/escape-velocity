import { expect, type Page, test } from '@playwright/test'
import { boot, START_HASH, settledRgba, waitForSettledFrame } from './app.js'

/** A real mouse drag across the canvas, through the points given. */
async function drag(page: Page, ...points: Array<[number, number]>): Promise<void> {
  const [start, ...rest] = points
  await page.mouse.move(...start)
  await page.mouse.down()
  for (const point of rest) await page.mouse.move(...point)
  await page.mouse.up()
}

test.describe('a pan', () => {
  // Small, so comparing raw pixels stays cheap.
  test.use({ viewport: { width: 480, height: 320 } })

  test('matches a fresh render of the view it landed on (#170)', async ({ page, context }) => {
    await boot(page, START_HASH)
    await waitForSettledFrame(page)
    const before = page.url()

    // Left and down by an odd number of pixels.
    await drag(page, [240, 160], [200, 180], [143, 197])
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
    // Carried pixels keep the value sampled at the old frame's coordinate,
    // ~1 ULP from a fresh sample's (fractal_core's frame_shift module): a few
    // boundary pixels may differ, nothing more.
    expect(differing / (panned.length / 4)).toBeLessThan(0.001)
  })
})

// A deep view at a high `max_iter`: a full frame takes seconds, so reusing
// most of it shows plainly in the time a pan takes.
const DEEP =
  '#re=-0.743643887037151&im=0.131825904205330&z=2e8&it=4096&pal=viridis&norm=histogram&kind=mandelbrot&field=escape-time'

test('a pan computes only the strip it exposed, not the whole frame (#170)', async ({ page }) => {
  test.setTimeout(120_000)
  // Log when the stage's `inert` (the boot) and `aria-busy` (a render in
  // flight) change, from the page's first script on.
  await page.addInitScript(() => {
    const log: Array<{ at: number; inert: boolean; busy: boolean }> = []
    Object.assign(window, { stageLog: log })
    new MutationObserver(() => {
      const stage = document.querySelector('.stage')
      if (stage === null) return
      const entry = { inert: stage.hasAttribute('inert'), busy: stage.hasAttribute('aria-busy') }
      const last = log.at(-1)
      if (last?.inert !== entry.inert || last?.busy !== entry.busy) {
        log.push({ at: performance.now(), ...entry })
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ['inert', 'aria-busy'],
    })
  })
  const stageLog = (): Promise<Array<{ at: number; inert: boolean; busy: boolean }>> =>
    page.evaluate(() => (window as unknown as { stageLog: [] }).stageLog)
  // The time from `since` to the next render finishing (`aria-busy` cleared).
  const renderDone = async (since: number): Promise<number> => {
    await expect
      .poll(async () => (await stageLog()).some((e) => e.at > since && !e.busy), {
        timeout: 60_000,
      })
      .toBe(true)
    const done = (await stageLog()).find((e) => e.at > since && !e.busy)
    return (done?.at ?? Number.NaN) - since
  }

  await boot(page, DEEP)
  // The first frame is a full compute: from the worker's ready (the stage
  // stops being inert) to the frame done.
  const ready = (await stageLog()).find((e) => !e.inert)?.at ?? Number.NaN
  const full = await renderDone(ready)
  await waitForSettledFrame(page)

  // A 20% pan to the left: only a 256 px strip is new.
  const g = await page.locator('#fractal').boundingBox()
  if (g === null) throw new Error('canvas#fractal has no box')
  const [x, y] = [g.x + g.width / 2, g.y + g.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x - 32 * step, y)
  const released = await page.evaluate(() => performance.now())
  await page.mouse.up()
  const pan = await renderDone(released)

  console.log(`full frame ${Math.round(full)} ms, pan ${Math.round(pan)} ms`)
  // Locally the pan takes ~25–35% of the full frame; computing the whole frame
  // again would take about 100%.
  expect(pan).toBeLessThan(0.6 * full)
})
