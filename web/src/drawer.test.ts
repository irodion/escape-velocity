import { beforeEach, describe, expect, it } from 'vitest'
import { mountDrawer } from './drawer.js'

function setup(): {
  toggle: HTMLButtonElement
  drawer: HTMLElement
  firstSelect: HTMLSelectElement
  surface: HTMLCanvasElement
} {
  document.body.innerHTML = `
    <button id="controls-toggle" type="button" aria-expanded="true">☰</button>
    <form id="controls">
      <select name="max-iter"><option value="256">256</option></select>
    </form>
    <canvas id="fractal"></canvas>
  `
  const toggle = document.getElementById('controls-toggle') as HTMLButtonElement
  const drawer = document.getElementById('controls') as HTMLElement
  const firstSelect = drawer.querySelector('select') as HTMLSelectElement
  const surface = document.getElementById('fractal') as HTMLCanvasElement
  mountDrawer(toggle, drawer, surface)
  return { toggle, drawer, firstSelect, surface }
}

// Press-then-release on the surface, separated by a CSS-pixel distance. A
// small distance reads as a click/tap; a large one as a pan-drag. The drawer
// arms on `pointerdown` and dismisses on `pointerup` (U1, #88), so a touch tap
// dismisses it exactly like a mouse click.
function clickSurface(
  surface: HTMLElement,
  opts: { fromX?: number; fromY?: number; toX?: number; toY?: number; button?: number } = {},
): void {
  const { fromX = 100, fromY = 100, toX = fromX, toY = fromY, button = 0 } = opts
  surface.dispatchEvent(
    new PointerEvent('pointerdown', { clientX: fromX, clientY: fromY, button, bubbles: true }),
  )
  surface.dispatchEvent(
    new PointerEvent('pointerup', { clientX: toX, clientY: toY, button, bubbles: true }),
  )
}

describe('mountDrawer', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('lands closed regardless of the markup, normalising aria + inert + glyph', () => {
    const { toggle, drawer } = setup()
    // Markup said aria-expanded="true"; mount forces the real closed state.
    expect(drawer.classList.contains('open')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Closed shows the crosshair glyph — distinguished from the ✕ by its
    // <circle>; the ✕ is paths only.
    expect(toggle.querySelector('svg circle')).not.toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('Open controls')
    expect(drawer.inert).toBe(true)
  })

  it('opens on click — slide class, aria, glyph, interactivity, and focus handoff', () => {
    const { toggle, drawer, firstSelect } = setup()
    toggle.click()
    expect(drawer.classList.contains('open')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // Open swaps to the ✕ glyph: an SVG with no <circle>.
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle.querySelector('svg circle')).toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('Close controls')
    expect(drawer.inert).toBe(false)
    expect(document.activeElement).toBe(firstSelect)
  })

  it('autofocuses the first control row, skipping a leading readout input', () => {
    // Mirrors index.html: the coordinate readout (with an editable, often
    // `disabled` `c` input) precedes the first `.field` control row. Open must
    // land focus in a real control, not the disabled readout input (which
    // would silently no-op and strand the keyboard user outside the drawer).
    document.body.innerHTML = `
      <button id="controls-toggle" type="button" aria-expanded="true">☰</button>
      <form id="controls">
        <section class="coords">
          <input name="c-re" type="number" disabled />
        </section>
        <label class="field"><input type="range" name="max-iter" /></label>
      </form>
      <canvas id="fractal"></canvas>
    `
    const toggle = document.getElementById('controls-toggle') as HTMLButtonElement
    const drawer = document.getElementById('controls') as HTMLElement
    const surface = document.getElementById('fractal') as HTMLCanvasElement
    mountDrawer(toggle, drawer, surface)
    toggle.click()
    expect(document.activeElement).toBe(drawer.querySelector('input[type="range"]'))
  })

  it('toggles closed on a second click and returns focus to the toggle', () => {
    const { toggle, drawer } = setup()
    toggle.click()
    toggle.click()
    expect(drawer.classList.contains('open')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(drawer.inert).toBe(true)
    expect(document.activeElement).toBe(toggle)
  })

  it('closes on Escape when open, and is a no-op when already closed', () => {
    const { toggle, drawer } = setup()
    toggle.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(drawer.classList.contains('open')).toBe(false)
    expect(document.activeElement).toBe(toggle)

    // Escape while closed must not flip any state.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(drawer.classList.contains('open')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes on a deliberate click on the fractal and returns focus to the toggle', () => {
    const { toggle, drawer, surface } = setup()
    toggle.click()
    expect(drawer.classList.contains('open')).toBe(true)

    clickSurface(surface)
    expect(drawer.classList.contains('open')).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(drawer.inert).toBe(true)
    expect(document.activeElement).toBe(toggle)
  })

  it('stays open on a pan-drag across the fractal (moved past the click slop)', () => {
    const { drawer, toggle, surface } = setup()
    toggle.click()
    // Press and release far apart: a pan, not a click — the drawer must
    // stay open so the user can reframe the view while tuning.
    clickSurface(surface, { fromX: 100, fromY: 100, toX: 260, toY: 140 })
    expect(drawer.classList.contains('open')).toBe(true)
  })

  it('is a no-op when the fractal is clicked while the drawer is already closed', () => {
    const { drawer, surface } = setup()
    // Drawer starts closed; a canvas click must not toggle it open or
    // otherwise touch its state.
    clickSurface(surface)
    expect(drawer.classList.contains('open')).toBe(false)
  })

  it('ignores a non-primary (e.g. right-button) press on the fractal', () => {
    const { drawer, toggle, surface } = setup()
    toggle.click()
    clickSurface(surface, { button: 2 })
    expect(drawer.classList.contains('open')).toBe(true)
  })

  it('does not dismiss on pointercancel (an aborted gesture is not a tap)', () => {
    // `pointercancel` means the browser/OS stole or aborted the gesture, not
    // that the user completed a tap — so even a cancelled in-slop press must
    // leave the drawer open.
    const { drawer, toggle, surface } = setup()
    toggle.click()
    expect(drawer.classList.contains('open')).toBe(true)

    surface.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, bubbles: true }),
    )
    surface.dispatchEvent(
      new PointerEvent('pointercancel', {
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    )
    expect(drawer.classList.contains('open')).toBe(true)
  })

  it('stays open on a two-finger pinch even if a finger lifts near where it landed', () => {
    // A pinch-zoom (U1, #88) is a multi-touch gesture, not a tap: the second
    // finger landing cancels the armed dismiss, so lifting either finger close
    // to its start point must NOT close the drawer.
    const { drawer, toggle, surface } = setup()
    toggle.click()
    expect(drawer.classList.contains('open')).toBe(true)

    surface.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, bubbles: true }),
    )
    surface.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 2, clientX: 200, clientY: 100, bubbles: true }),
    )
    // Both fingers lift roughly where they landed (a pinch that barely moved).
    surface.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 2, clientX: 201, clientY: 101, bubbles: true }),
    )
    surface.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 1, clientX: 101, clientY: 99, bubbles: true }),
    )
    expect(drawer.classList.contains('open')).toBe(true)
  })
})
