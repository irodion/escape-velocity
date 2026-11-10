import { expect, test } from '@playwright/test'
import { boot, settledCanvasPng } from './app.js'

// Reference images of the rendered canvas (#93): a change to the kernel,
// colouring or normalisation that alters what a view looks like fails here.
// Each view is a complete permalink, so changing the app's defaults doesn't
// change these. After an intended change, regenerate with `pnpm e2e:update`
// and look at the new images before committing them.
const VIEWS = {
  'mandelbrot-escape-time':
    're=-0.7435&im=0.1314&z=200&it=256&pal=viridis&norm=cycled&kind=mandelbrot&field=escape-time',
  'julia-histogram':
    're=0&im=0&z=1&it=256&pal=twilight&norm=histogram&kind=julia&field=escape-time&cre=-0.7&cim=0.27015',
  'mandelbrot-distance-estimate':
    're=-0.7435&im=0.1314&z=200&it=1024&pal=magma&norm=clamped&kind=mandelbrot&field=distance-estimate',
}

// Small, so the reference PNGs stay small. Render scale 1, so the buffer is
// the window's size.
test.use({ viewport: { width: 480, height: 320 } })

for (const [name, params] of Object.entries(VIEWS)) {
  test(`renders ${name} as its reference image`, async ({ page }) => {
    await boot(page, `#${params}`)
    expect(await settledCanvasPng(page)).toMatchSnapshot(`${name}.png`, {
      maxDiffPixelRatio: 0.001,
    })
  })
}
