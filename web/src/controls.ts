/**
 * Wires the `<select>` inputs in the controls form to a single
 * `onChange` callback that emits the current settings snapshot.
 *
 * State lives entirely in the DOM — each select's `value` is the
 * source of truth. The class itself holds only the listener wiring;
 * `onChange` reads both selects on every fire so a callback always
 * sees the cumulative state, not a stale cached copy.
 *
 * Only the `change` event triggers callbacks (commit-not-live
 * semantics): a recompute at 8192 iterations during dropdown scrub
 * would jank the page. `<select>` natively fires `change` only when
 * the user commits a selection, which matches the desired UX.
 *
 * Resolution `<select>` values are encoded `"<width>x<height>"`
 * (no spaces) so the parser is a single `split('x').map(Number)`.
 */
export interface Settings {
  readonly maxIter: number
  readonly width: number
  readonly height: number
}

export class Controls {
  constructor(form: HTMLFormElement, initial: Settings, onChange: (settings: Settings) => void) {
    const maxIterSelect = form.elements.namedItem('max-iter')
    const resolutionSelect = form.elements.namedItem('resolution')
    if (!(maxIterSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="max-iter">')
    }
    if (!(resolutionSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="resolution">')
    }

    maxIterSelect.value = String(initial.maxIter)
    resolutionSelect.value = `${initial.width}x${initial.height}`

    const emit = (): void => {
      const maxIter = Number(maxIterSelect.value)
      const [width, height] = resolutionSelect.value.split('x').map(Number)
      onChange({ maxIter, width, height })
    }

    // `change` only — not `input`. `<select>` fires `change` on commit
    // (mouse: option click; keyboard: Enter on a focused option), which
    // is the boundary where we want a recompute.
    maxIterSelect.addEventListener('change', emit)
    resolutionSelect.addEventListener('change', emit)
  }
}
