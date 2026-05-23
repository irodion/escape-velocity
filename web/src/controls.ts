/**
 * Wires the controls form's `<select>`s and `<input type="number">`s
 * to a single `onChange` callback that emits the current settings
 * snapshot.
 *
 * State lives entirely in the DOM — each control's `value` /
 * `valueAsNumber` is the source of truth. The class itself holds only
 * the listener wiring plus pointers to the two number inputs (so the
 * mode-change handler can flip their `disabled` attribute), and
 * reads the live DOM on every emit so callbacks always see cumulative
 * state, not a stale cached copy.
 *
 * Only the `change` event triggers callbacks (commit-not-live
 * semantics): a recompute at 8192 iterations during dropdown scrub
 * would jank the page, and likewise we don't want a recompute on every
 * keystroke inside the `c.re` / `c.im` fields. `<select>` natively
 * fires `change` only when the user commits a selection;
 * `<input type="number">` fires `change` on blur or Enter — both match
 * the desired UX.
 *
 * Resolution `<select>` values are encoded `"<width>x<height>"`
 * (no spaces) so the parser is a single `split('x').map(Number)`.
 *
 * `palette`, `normalisation`, and `mode` values are tag strings —
 * `main.ts` maps them to the wasm-bindgen enum discriminants at the
 * WASM seam. Keeping the form-side type as a string union (not a
 * number) means the construction-time guards below catch a drifted
 * HTML option list exactly the same way they catch a bad numeric
 * `maxIter`.
 *
 * The numeric `c.re` / `c.im` inputs are different: their domain is
 * the real line, so the runtime "did this value parse?" check is
 * `Number.isNaN(valueAsNumber)` rather than an option-list lookup.
 * Mid-edit empty / dash-only states produce `NaN` snapshots — the
 * dispatcher in `main.ts` filters those.
 */
export type PaletteName = 'grayscale' | 'viridis' | 'magma' | 'inferno' | 'twilight'
export type NormalisationName = 'cycled' | 'histogram'
export type FractalMode = 'mandelbrot' | 'julia'

export interface Settings {
  readonly maxIter: number
  readonly width: number
  readonly height: number
  readonly palette: PaletteName
  readonly normalisation: NormalisationName
  readonly mode: FractalMode
  readonly cRe: number
  readonly cIm: number
}

export class Controls {
  private readonly cReInput: HTMLInputElement
  private readonly cImInput: HTMLInputElement

  constructor(form: HTMLFormElement, initial: Settings, onChange: (settings: Settings) => void) {
    const maxIterSelect = form.elements.namedItem('max-iter')
    const resolutionSelect = form.elements.namedItem('resolution')
    const paletteSelect = form.elements.namedItem('palette')
    const normalisationSelect = form.elements.namedItem('normalisation')
    const modeSelect = form.elements.namedItem('mode')
    const cReInput = form.elements.namedItem('c-re')
    const cImInput = form.elements.namedItem('c-im')
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
    if (!(modeSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="mode">')
    }
    if (!(cReInput instanceof HTMLInputElement)) {
      throw new Error('Controls: form is missing an <input name="c-re">')
    }
    if (!(cImInput instanceof HTMLInputElement)) {
      throw new Error('Controls: form is missing an <input name="c-im">')
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
    modeSelect.value = initial.mode
    if (modeSelect.value === '') {
      throw new Error(`Controls: initial.mode="${initial.mode}" has no matching <option>`)
    }

    // `valueAsNumber` parses the input's `value` string as a JS number,
    // emitting NaN on assignment of NaN as well as on read of "" / "-".
    // A NaN at construction means the caller's `initial.cRe` / `cIm`
    // was already NaN — same shape of programmer-error as a drifted
    // <option> list, so fail fast at the same boundary.
    cReInput.valueAsNumber = initial.cRe
    if (Number.isNaN(cReInput.valueAsNumber)) {
      throw new Error(`Controls: initial.cRe=${initial.cRe} is not a finite number`)
    }
    cImInput.valueAsNumber = initial.cIm
    if (Number.isNaN(cImInput.valueAsNumber)) {
      throw new Error(`Controls: initial.cIm=${initial.cIm} is not a finite number`)
    }

    this.cReInput = cReInput
    this.cImInput = cImInput
    // The c inputs are visual-state only — they always hold their last
    // committed value even in Mandelbrot mode (which simply ignores
    // them) so a Julia → Mandelbrot → Julia round-trip preserves the
    // user's c. The `disabled` attribute drives just the rendered
    // dimness via the CSS rule in index.html.
    this.setCInputsEnabled(initial.mode === 'julia')

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
        mode: modeSelect.value as FractalMode,
        // valueAsNumber returns NaN for mid-edit states ("", "-",
        // "1.5e"). The dispatcher in main.ts substitutes a finite
        // fallback and calls `setCValues` to back-write the
        // substitution into the DOM so the visible field always
        // matches the rendered parameter.
        cRe: cReInput.valueAsNumber,
        cIm: cImInput.valueAsNumber,
      })
    }

    // `change` only — not `input`. `<select>` fires `change` on commit
    // (mouse: option click; keyboard: Enter on a focused option);
    // `<input type="number">` fires `change` on blur or Enter. Both
    // are the boundary where we want a recompute (or, for the visual-
    // only selects, a fast re-colorize).
    maxIterSelect.addEventListener('change', emit)
    resolutionSelect.addEventListener('change', emit)
    paletteSelect.addEventListener('change', emit)
    normalisationSelect.addEventListener('change', emit)
    modeSelect.addEventListener('change', () => {
      // Re-derive the enabled state from the select's live value
      // rather than a closed-over flag — the select itself is the
      // source of truth, so even a programmatic value change can
      // synchronise the inputs by dispatching `change`.
      this.setCInputsEnabled(modeSelect.value === 'julia')
      emit()
    })
    cReInput.addEventListener('change', emit)
    cImInput.addEventListener('change', emit)
  }

  private setCInputsEnabled(enabled: boolean): void {
    this.cReInput.disabled = !enabled
    this.cImInput.disabled = !enabled
  }

  /**
   * Write `(cRe, cIm)` back into the two c inputs. Called by the
   * dispatcher in main.ts after sanitising a non-finite snapshot, so
   * the visible field and the rendered parameter stay in lockstep
   * (e.g., after a user clears `c.re` and the dispatcher falls back
   * to the previous finite value, the input shows that fallback
   * instead of staying blank).
   *
   * Setting `valueAsNumber` does NOT fire `change` — the form's
   * `change` listeners only run on direct user interaction or an
   * explicit `dispatchEvent`. So the back-write is a safe one-way
   * sync that never re-enters the dispatcher.
   */
  public setCValues(cRe: number, cIm: number): void {
    this.cReInput.valueAsNumber = cRe
    this.cImInput.valueAsNumber = cIm
  }
}
