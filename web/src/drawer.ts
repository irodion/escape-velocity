/**
 * Collapsible control-panel drawer (Slice 4).
 *
 * The controls live in a panel that slides in over the full-bleed canvas.
 * A persistently visible crosshair button toggles it; the drawer is closed
 * by default. Because the drawer is fixed-positioned (out of the flex flow —
 * see index.html), opening it overlays the controls *without* changing the
 * canvas's CSS box, so the fit-to-window ResizeObserver in `main.ts` never
 * fires and the render buffer is untouched (Slice 2 / ADR-0011).
 *
 * The open/closed state is expressed three ways, all driven from here:
 *   - the `.open` class on the drawer drives the CSS slide transform;
 *   - `aria-expanded` on the toggle announces the state to assistive tech;
 *   - `inert` on the drawer removes the off-screen form controls from the
 *     tab order and the accessibility tree while closed, so a keyboard or
 *     screen-reader user can't land on a control they can't see.
 *
 * Pure view glue (like `pwa-ui`), but with enough branching — Escape to
 * close, focus handoff, click-away to dismiss — to warrant the focused
 * test in `drawer.test.ts`.
 */

// A deliberate *click* on the fractal travels less than this many CSS pixels
// between press and release. Past it, the gesture is a pan-drag — which must
// leave the drawer open so the user can reframe the view while tuning a
// control. A wheel-zoom fires no mouse press at all, so it never reaches the
// dismiss path. ~4px tolerates the hand-jitter of a "stationary" click
// without swallowing a real drag.
const CLICK_SLOP_PX = 4

// The toggle's glyph is *drawn*, not an emoji: a crosshair that echoes the
// canvas's `crosshair` cursor (the affordance points at what it controls),
// morphing to an ✕ once the panel slides over it. SVG strings rather than
// font glyphs so the mark renders identically on every platform and inherits
// the button's `currentColor`. `aria-hidden` because the button's
// `aria-label` (set in `setOpen`) already names the action for assistive tech.
const CROSSHAIR_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="6.2" stroke="currentColor" stroke-width="1.3"/>' +
  '<path d="M12 1.5V6.5M12 17.5V22.5M1.5 12H6.5M17.5 12H22.5" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
const CLOSE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M5.5 5.5L18.5 18.5M18.5 5.5L5.5 18.5" ' +
  'stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'

export function mountDrawer(
  toggle: HTMLButtonElement,
  drawer: HTMLElement,
  // The fractal surface (the canvas). A deliberate click on it dismisses an
  // open drawer — the light-dismiss gesture users expect from an overlay.
  // Optional so the focused `drawer.test.ts` setups (and any caller that
  // doesn't want click-away) can omit it.
  dismissSurface?: HTMLElement,
): void {
  // The single in-memory source of truth for open/closed. `setOpen` is the
  // only writer, so this can't drift from the DOM it drives — and the
  // handlers below read this boolean rather than matching the `.open` class
  // string back out of the element.
  let isOpen = false

  const setOpen = (open: boolean): void => {
    isOpen = open
    drawer.classList.toggle('open', open)
    toggle.setAttribute('aria-expanded', String(open))
    // Swap the glyph + label so the open-state button reads as "close"
    // rather than blending into the panel as another crosshair. The glyph
    // is the visible affordance; the label keeps assistive tech in step.
    toggle.innerHTML = open ? CLOSE_GLYPH : CROSSHAIR_GLYPH
    toggle.setAttribute('aria-label', open ? 'Close controls' : 'Open controls')
    // `inert` is the load-bearing a11y bit: a closed drawer is only
    // translated off-screen, so without it the (invisible) selects stay
    // tabbable and screen-reader-visible.
    drawer.inert = !open
  }

  // Move focus to follow the panel: into the first control on open so
  // keyboard users land in the drawer, back to the toggle on close so focus
  // is never stranded on an inert element.
  const handoffFocus = (): void => {
    if (isOpen) {
      drawer.querySelector<HTMLElement>('select, input, button')?.focus()
    } else {
      toggle.focus()
    }
  }

  // Land in the closed state regardless of the markup's initial attributes,
  // so the DOM and the ARIA state can never disagree at boot.
  setOpen(false)

  toggle.addEventListener('click', () => {
    setOpen(!isOpen)
    handoffFocus()
  })

  // Escape closes from anywhere — the conventional dismiss for an overlay.
  // Bound on `document` because focus sits inside the drawer (or on the
  // toggle) while it's open, so a narrower scope would miss the key.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) {
      setOpen(false)
      handoffFocus()
    }
  })

  // Click-away: a deliberate click on the fractal dismisses an open drawer.
  // We can't use a plain `click` listener — the canvas's pan also fires
  // `click` after a drag returns near its origin, and the browser's own
  // click-distance tolerance isn't tunable. So we arm on `mousedown` and
  // only dismiss if the pointer barely moved by `mouseup` (a pan travels
  // farther; a wheel-zoom fires no mouse press), giving an explicit,
  // testable click-vs-drag split. Mouse events (not pointer) match the
  // canvas's existing pan wiring in `input.ts` — touch taps synthesise the
  // same mousedown/mouseup pair. The drawer's own controls and the toggle
  // sit in higher z-index layers, so clicks on them never reach here.
  //
  // Both this listener and `input.ts`'s pan see the same press: a true
  // click closes the drawer here and commits a zero-delta (no-op) pan
  // there; a drag leaves the drawer open and pans. They stay decoupled —
  // the drawer never learns about the viewport, the input layer never
  // learns about the drawer.
  if (dismissSurface !== undefined) {
    let downX = 0
    let downY = 0
    // Only a press that began on the fractal *while the drawer was open*
    // can dismiss it. Re-checked on every press, so a release left dangling
    // by a drag off-canvas (no `mouseup` on the surface) can't later fire a
    // stray dismiss — the next press re-arms from the live state.
    let armed = false
    dismissSurface.addEventListener('mousedown', (event) => {
      // Primary button only; a right/middle press belongs to the browser
      // and shouldn't double as a dismiss.
      armed = isOpen && event.button === 0
      downX = event.clientX
      downY = event.clientY
    })
    dismissSurface.addEventListener('mouseup', (event) => {
      if (!armed) return
      armed = false
      const movedFar =
        Math.abs(event.clientX - downX) > CLICK_SLOP_PX ||
        Math.abs(event.clientY - downY) > CLICK_SLOP_PX
      if (movedFar) return
      setOpen(false)
      // Hand focus back to the toggle: closing makes the drawer `inert`, so
      // a keyboard focus that was sitting on a control inside it can't be
      // stranded there.
      handoffFocus()
    })
  }
}
