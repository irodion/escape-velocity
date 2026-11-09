import { expect, test } from '@playwright/test'
import { boot, canvasGeometry, hashParam, pickedC, renderedSampleAt } from './app.js'

// A point well inside the boot frame, away from its edges and the drawer.
const AT = { x: 517.3, y: 263.8 }

test.describe('boot', () => {
  test('boots cross-origin isolated, loads WASM only in the worker, and paints', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('favicon')) {
        errors.push(message.text())
      }
    })
    await boot(page)

    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
    await expect(page.locator('.fatal')).toHaveCount(0)
    // ADR-0015: the main thread fetches no .wasm; only the render worker does
    // (its fetches go in the worker's own resource timeline, not this one).
    const mainThreadWasm = await page.evaluate(
      () =>
        performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith('.wasm'))
          .length,
    )
    expect(mainThreadWasm).toBe(0)
    // A painted frame: the boot view is coloured, not the canvas's blank black.
    const centre = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#fractal')
      const pixel = canvas?.getContext('2d')?.getImageData(200, 200, 1, 1).data
      return pixel === undefined ? [] : Array.from(pixel)
    })
    expect(centre.slice(0, 3).some((channel) => channel > 0)).toBe(true)
    expect(errors).toEqual([])
  })

  test('stays cross-origin isolated when the service worker serves a reload', async ({ page }) => {
    // The isolation headers have to survive the service worker's cache too
    // (ADR-0008): a reload it serves must still be isolated, or the renderer
    // fails to boot for every returning visitor.
    await boot(page)
    await page.evaluate(() => navigator.serviceWorker.ready)
    await page.reload()
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true)
    await boot(page)
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
    await expect(page.locator('.fatal')).toHaveCount(0)
  })

  test('repairs an out-of-range permalink zoom in the URL', async ({ page }) => {
    await boot(page, '#z=1e-310')
    await expect.poll(() => hashParam(page, 'z')).toBe('0.25')
  })
})

test.describe('picking the Julia constant', () => {
  test('Alt-click picks the exact c of the pixel under the cursor', async ({ page }) => {
    await boot(page)
    const g = await canvasGeometry(page)
    const expected = await renderedSampleAt(page, AT.x, AT.y)

    await page.keyboard.down('Alt')
    await page.mouse.click(g.left + AT.x, g.top + AT.y)
    await page.keyboard.up('Alt')

    expect(await pickedC(page)).toEqual(expected)
  })

  test('Alt-click after a pan picks the painted pixel the drag moved under the cursor', async ({
    page,
  }) => {
    await boot(page)
    const g = await canvasGeometry(page)
    const pan = { dx: 137, dy: -64 }
    const expected = await renderedSampleAt(page, AT.x, AT.y, {
      dx: (pan.dx * g.bufferWidth) / g.width,
      dy: (pan.dy * g.bufferHeight) / g.height,
    })
    // Synthetic events in one task, so the pan's own frame can't paint
    // between the drag and the click: the click must land on the old frame,
    // still shifted by the drag. (Real input takes a round trip per event.)
    await page.evaluate(
      ({ pan, at }) => {
        const canvas = document.querySelector<HTMLCanvasElement>('#fractal')
        if (canvas === null) throw new Error('canvas#fractal not found')
        const r = canvas.getBoundingClientRect()
        const fire = (type: string, x: number, y: number, altKey = false): void => {
          canvas.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerId: 1,
              isPrimary: true,
              pointerType: 'mouse',
              button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
              clientX: r.left + x,
              clientY: r.top + y,
              altKey,
            }),
          )
        }
        fire('pointerdown', 400, 300)
        fire('pointermove', 400 + pan.dx / 2, 300 + pan.dy / 2)
        fire('pointermove', 400 + pan.dx, 300 + pan.dy)
        fire('pointerup', 400 + pan.dx, 300 + pan.dy)
        fire('pointerdown', at.x, at.y, true)
        fire('pointerup', at.x, at.y, true)
      },
      { pan, at: AT },
    )

    expect(await pickedC(page)).toEqual(expected)
  })

  test.describe('on touch', () => {
    test.use({ hasTouch: true })

    test('a long-press picks c at the finger; a short tap does not', async ({ page }) => {
      await boot(page)
      const g = await canvasGeometry(page)
      const expected = await renderedSampleAt(page, AT.x, AT.y)
      // Real touch input, through the DevTools protocol: Playwright's own
      // touchscreen API only taps.
      const cdp = await page.context().newCDPSession(page)
      const touch = async (type: 'touchStart' | 'touchEnd'): Promise<void> => {
        await cdp.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x: g.left + AT.x, y: g.top + AT.y }],
        })
      }

      // A short tap in Mandelbrot mode picks nothing.
      await touch('touchStart')
      await page.waitForTimeout(100)
      await touch('touchEnd')
      await page.waitForTimeout(700)
      expect(await hashParam(page, 'kind')).toBe('mandelbrot')

      // Held past the long-press delay (500 ms): picks c at the finger.
      await touch('touchStart')
      await page.waitForTimeout(650)
      await touch('touchEnd')
      expect(await pickedC(page)).toEqual(expected)
    })
  })
})
