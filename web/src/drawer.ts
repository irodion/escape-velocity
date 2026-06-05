/**
 * Collapsible control-panel drawer (Slice 4).
 *
 * The controls live in a panel that slides in over the full-bleed canvas.
 * A persistently visible ☰ button toggles it; the drawer is closed by
 * default. Because the drawer is fixed-positioned (out of the flex flow —
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
 * close, focus handoff — to warrant the focused test in `drawer.test.ts`.
 */
export function mountDrawer(toggle: HTMLButtonElement, drawer: HTMLElement): void {
  const setOpen = (open: boolean): void => {
    drawer.classList.toggle('open', open)
    toggle.setAttribute('aria-expanded', String(open))
    // `inert` is the load-bearing a11y bit: a closed drawer is only
    // translated off-screen, so without it the (invisible) selects stay
    // tabbable and screen-reader-visible.
    drawer.inert = !open
  }

  // Land in the closed state regardless of the markup's initial attributes,
  // so the DOM and the ARIA state can never disagree at boot.
  setOpen(false)

  toggle.addEventListener('click', () => {
    const willOpen = !drawer.classList.contains('open')
    setOpen(willOpen)
    // Hand focus into the panel on open so keyboard users reach the
    // controls immediately; return it to the toggle on close so focus is
    // never stranded on an inert element.
    if (willOpen) {
      const firstControl = drawer.querySelector<HTMLElement>('select, input, button')
      firstControl?.focus()
    } else {
      toggle.focus()
    }
  })

  // Escape closes from anywhere — the conventional dismiss for an overlay.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer.classList.contains('open')) {
      setOpen(false)
      toggle.focus()
    }
  })
}
