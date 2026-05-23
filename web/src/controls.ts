/**
 * Wires the `<select>` inputs in the controls form to a single
 * `onChange` callback that emits the current settings snapshot.
 *
 * State lives entirely in the DOM — each select's `value` is the
 * source of truth. The class itself holds only the listener wiring;
 * `onChange` reads all selects on every fire so a callback always
 * sees the cumulative state, not a stale cached copy.
 *
 * Only the `change` event triggers callbacks (commit-not-live
 * semantics): a recompute at 8192 iterations during dropdown scrub
 * would jank the page. `<select>` natively fires `change` only when
 * the user commits a selection, which matches the desired UX.
 *
 * Resolution `<select>` values are encoded `"<width>x<height>"`
 * (no spaces) so the parser is a single `split('x').map(Number)`.
 *
 * `palette` and `normalisation` values are tag strings — `main.ts`
 * maps them to the wasm-bindgen enum discriminants at the WASM seam.
 * Keeping the form-side type as a string union (not a number) means
 * the construction-time guards below catch a drifted HTML option list
 * exactly the same way they catch a bad numeric `maxIter`.
 */
export type PaletteName = 'grayscale' | 'viridis' | 'magma' | 'inferno' | 'twilight'
export type NormalisationName = 'cycled' | 'histogram'

export interface Settings {
  readonly maxIter: number
  readonly width: number
  readonly height: number
  readonly palette: PaletteName
  readonly normalisation: NormalisationName
}

export class Controls {
  constructor(form: HTMLFormElement, initial: Settings, onChange: (settings: Settings) => void) {
    const maxIterSelect = form.elements.namedItem('max-iter')
    const resolutionSelect = form.elements.namedItem('resolution')
    const paletteSelect = form.elements.namedItem('palette')
    const normalisationSelect = form.elements.namedItem('normalisation')
    if (!(maxIterSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="max-iter">')
    }
    if (!(resolutionSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="resolution">')
    }
    if (!(paletteSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="palette">')
    }
    if (!(normalisationSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="normalisation">')
    }

    // HTMLSelectElement.value silently becomes '' when assigned a
    // string that matches no <option>. Fail fast here so the bug
    // surfaces at boot (caller's `initial` is out of sync with the
    // option list) rather than emitting `Number('')`=0 and tripping
    // the wasm boundary inside an event handler.
    maxIterSelect.value = String(initial.maxIter)
    if (maxIterSelect.value === '') {
      throw new Error(`Controls: initial.maxIter=${initial.maxIter} has no matching <option>`)
    }
    const initialResolution = `${initial.width}x${initial.height}`
    resolutionSelect.value = initialResolution
    if (resolutionSelect.value === '') {
      throw new Error(
        `Controls: initial resolution "${initialResolution}" has no matching <option>`,
      )
    }
    paletteSelect.value = initial.palette
    if (paletteSelect.value === '') {
      throw new Error(`Controls: initial.palette="${initial.palette}" has no matching <option>`)
    }
    normalisationSelect.value = initial.normalisation
    if (normalisationSelect.value === '') {
      throw new Error(
        `Controls: initial.normalisation="${initial.normalisation}" has no matching <option>`,
      )
    }

    // The select's value is constrained to its option set at runtime
    // — the browser only sets it to a listed <option value> on
    // user interaction. Combined with the construction-time guard
    // above, every parser/cast below sees a well-formed string.
    const emit = (): void => {
      const maxIter = Number(maxIterSelect.value)
      const [width, height] = resolutionSelect.value.split('x').map(Number)
      onChange({
        maxIter,
        width,
        height,
        palette: paletteSelect.value as PaletteName,
        normalisation: normalisationSelect.value as NormalisationName,
      })
    }

    // `change` only — not `input`. `<select>` fires `change` on commit
    // (mouse: option click; keyboard: Enter on a focused option), which
    // is the boundary where we want a recompute (or, for the two new
    // selects, a fast re-colorize).
    maxIterSelect.addEventListener('change', emit)
    resolutionSelect.addEventListener('change', emit)
    paletteSelect.addEventListener('change', emit)
    normalisationSelect.addEventListener('change', emit)
  }
}
