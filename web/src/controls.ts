import { defaultModeForField, isModeValidForField } from './field-modes.js'

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
 * semantics): a recompute at 8192 iterations mid-scrub would jank the
 * page, and likewise we don't want a recompute on every keystroke inside
 * the `c.re` / `c.im` fields. `<select>` natively fires `change` only when
 * the user commits a selection; `<input type="number">` fires `change` on
 * blur or Enter; the iterations `<input type="range">` fires `change` when
 * the drag is released (and per keyboard step) while streaming `input`
 * throughout the drag — so the slider's numeric readout tracks live while
 * the single recompute still waits for the commit. All match the UX.
 *
 * The render-scale `<select>` values are plain multipliers (`"0.5"`,
 * `"1"`, `"2"`) parsed with a single `Number(...)`. The multiplier is a
 * pure quality knob: it scales the render buffer relative to the display
 * size without changing the framing (ADR-0011 / Slice 3).
 *
 * `palette`, `normalisation`, and `mode` values are tag strings —
 * `main.ts` maps them to the wasm-bindgen enum discriminants at the
 * WASM seam. Keeping the form-side type as a string union (not a
 * number) means the construction-time guards below catch a drifted
 * HTML option list exactly the same way they catch a `maxIter` that
 * isn't one of the slider's `MAX_ITER_STOPS`.
 *
 * The numeric `c.re` / `c.im` inputs are different: their domain is
 * the real line, so the runtime "did this value parse?" check is
 * `Number.isNaN(valueAsNumber)` rather than an option-list lookup.
 * Mid-edit empty / dash-only states produce `NaN` snapshots — the
 * dispatcher in `main.ts` filters those.
 *
 * The Field control additionally enforces the (Field × Normalisation
 * mode) validity rule from ADR-0013 (the pure policy lives in
 * `field-modes.ts`): on a Field change the invalid Normalisation options
 * are hidden, and if the current mode becomes invalid it is replaced with
 * the Field's default before the snapshot is emitted. Same shape as the
 * mode → c-inputs coupling already in this class.
 */
export type PaletteName =
  | 'grayscale'
  | 'viridis'
  | 'magma'
  | 'inferno'
  | 'plasma'
  | 'turbo'
  | 'cubehelix'
  | 'twilight'
  | 'earth-and-sky'
  | 'rainbow'
  | 'kahol-lavan'
  | 'ocean'
  | 'solar'
  | 'spectral'
  | 'cosmic'
export type NormalisationName =
  | 'cycled'
  | 'histogram'
  | 'linear'
  | 'sqrt'
  | 'logarithmic'
  | 'clamped'
export type FractalMode = 'mandelbrot' | 'julia'
/**
 * The Field axis (ADR-0013): the per-pixel scalar `compute` emits. Only
 * `escape-time` is selectable in this slice; `distance-estimate` is
 * reserved in the union and ships as a disabled `<option>` until its
 * kernel lands (#61). `main.ts` maps these tag strings to the
 * wasm-bindgen `Field` discriminants at the WASM seam.
 */
export type FieldName = 'escape-time' | 'distance-estimate'

/**
 * Iteration-count stops for the log slider, low → high.
 *
 * The old `<select>` sampled only the octave boundaries (64, 128, 256, …
 * 8192), so the smallest step *doubled* the iteration count — too coarse.
 * This is a quarter-octave geometric grid instead: each octave `2^k` is
 * subdivided into `2^k × {1, 1.25, 1.5, 1.75}` (so 64, 80, 96, 112, then
 * 128, 160, …), capped by the 8192 endpoint. ~29 clean integer stops give
 * fine control, and because the spacing is geometric every step is the same
 * ~19–25% change — the slider feels uniform across its whole travel rather
 * than crawling at the low end and leaping at the high end.
 *
 * The slider's `value` is an INDEX into this array — a plain linear `0..N-1`
 * range — so equal pixel travel maps to equal ratio with no log maths in the
 * event handler. The table lives here, not in the markup, because it's a
 * computed sequence the constructor uses to drive the input's `min`/`max`/
 * `value` and to map an index back to its iteration count; keeping it in one
 * place is what stops the two from drifting.
 */
export const MAX_ITER_STOPS: readonly number[] = [
  64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 640, 768, 896, 1024, 1280, 1536,
  1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 7168, 8192,
]

/**
 * Snap an arbitrary iteration count to the nearest `MAX_ITER_STOPS` member.
 *
 * The `Controls` constructor *throws* on a `maxIter` that isn't exactly a stop
 * (the slider is index-addressed). That fail-fast is right for an in-code
 * programmer constant, but fatal for *external* input — a persisted or shared
 * URL (O1, #91) can carry a stale `1000` from before the slider existed, or a
 * value from a future stop table. Hydration runs the foreign number through
 * here first so the form always boots on a real stop instead of killing every
 * control. Lives beside the table it depends on so the two can't drift.
 */
export function nearestMaxIterStop(value: number): number {
  return MAX_ITER_STOPS.reduce((best, stop) =>
    Math.abs(stop - value) < Math.abs(best - value) ? stop : best,
  )
}

export interface Settings {
  readonly maxIter: number
  /**
   * Render-buffer multiplier relative to the display size (a quality /
   * sharpness knob, not a framing knob). `1` renders one buffer pixel
   * per display pixel; `2` supersamples; `0.5` subsamples for speed.
   */
  readonly renderScale: number
  readonly palette: PaletteName
  readonly normalisation: NormalisationName
  /** The Field axis (ADR-0013) — what scalar each pixel carries. */
  readonly field: FieldName
  readonly mode: FractalMode
  readonly cRe: number
  readonly cIm: number
}

export class Controls {
  private readonly maxIterRange: HTMLInputElement
  private readonly maxIterReadout: HTMLOutputElement
  private readonly renderScaleSelect: HTMLSelectElement
  private readonly paletteSelect: HTMLSelectElement
  private readonly normalisationSelect: HTMLSelectElement
  private readonly fieldSelect: HTMLSelectElement
  private readonly modeSelect: HTMLSelectElement
  private readonly cReInput: HTMLInputElement
  private readonly cImInput: HTMLInputElement
  private readonly onChange: (settings: Settings) => void

  constructor(form: HTMLFormElement, initial: Settings, onChange: (settings: Settings) => void) {
    const maxIterRange = form.elements.namedItem('max-iter')
    const renderScaleSelect = form.elements.namedItem('render-scale')
    const paletteSelect = form.elements.namedItem('palette')
    const normalisationSelect = form.elements.namedItem('normalisation')
    const fieldSelect = form.elements.namedItem('field')
    const modeSelect = form.elements.namedItem('mode')
    const cReInput = form.elements.namedItem('c-re')
    const cImInput = form.elements.namedItem('c-im')
    if (!(maxIterRange instanceof HTMLInputElement) || maxIterRange.type !== 'range') {
      throw new Error('Controls: form is missing an <input type="range" name="max-iter">')
    }
    const maxIterReadout = form.querySelector('output[data-for="max-iter"]')
    if (!(maxIterReadout instanceof HTMLOutputElement)) {
      throw new Error('Controls: form is missing an <output data-for="max-iter">')
    }
    if (!(renderScaleSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="render-scale">')
    }
    if (!(paletteSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="palette">')
    }
    if (!(normalisationSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="normalisation">')
    }
    if (!(fieldSelect instanceof HTMLSelectElement)) {
      throw new Error('Controls: form is missing a <select name="field">')
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

    // The slider is index-addressed: its value is a position in
    // MAX_ITER_STOPS, not the iteration count itself. Drive its range from
    // the table (so markup and table can't drift) and translate the initial
    // count to its index. A count that isn't a stop is the same drifted-
    // constant programmer error the <select> guards caught — fail fast at
    // boot rather than letting an out-of-range index read `undefined` and
    // push NaN through the wasm boundary inside an event handler.
    maxIterRange.min = '0'
    maxIterRange.max = String(MAX_ITER_STOPS.length - 1)
    maxIterRange.step = '1'
    const initialIndex = MAX_ITER_STOPS.indexOf(initial.maxIter)
    if (initialIndex === -1) {
      throw new Error(`Controls: initial.maxIter=${initial.maxIter} is not one of MAX_ITER_STOPS`)
    }
    maxIterRange.value = String(initialIndex)
    const initialRenderScale = String(initial.renderScale)
    renderScaleSelect.value = initialRenderScale
    if (renderScaleSelect.value === '') {
      throw new Error(
        `Controls: initial render scale "${initialRenderScale}" has no matching <option>`,
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
    fieldSelect.value = initial.field
    if (fieldSelect.value === '') {
      throw new Error(`Controls: initial.field="${initial.field}" has no matching <option>`)
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

    this.maxIterRange = maxIterRange
    this.maxIterReadout = maxIterReadout
    this.renderScaleSelect = renderScaleSelect
    this.paletteSelect = paletteSelect
    this.normalisationSelect = normalisationSelect
    this.fieldSelect = fieldSelect
    this.modeSelect = modeSelect
    this.cReInput = cReInput
    this.cImInput = cImInput
    this.onChange = onChange
    // The c inputs are visual-state only — they always hold their last
    // committed value even in Mandelbrot mode (which simply ignores
    // them) so a Julia → Mandelbrot → Julia round-trip preserves the
    // user's c. The `disabled` attribute drives just the rendered
    // dimness via the CSS rule in index.html.
    this.setCInputsEnabled(initial.mode === 'julia')

    // Enforce the initial (Field × Normalisation) validity (ADR-0013) before
    // any snapshot is emitted; the method below is re-run on every Field
    // change and on `applySettings`.
    this.applyFieldValidity()

    // The select's value is constrained to its option set at runtime
    // — the browser only sets it to a listed <option value> on
    // user interaction. Combined with the construction-time guard
    // above, every parser/cast below sees a well-formed string.
    this.syncMaxIterReadout()

    // The recompute is `change`-gated everywhere — not `input`. `<select>`
    // fires `change` on commit (mouse: option click; keyboard: Enter on a
    // focused option); `<input type="number">` fires `change` on blur or
    // Enter. Both are the boundary where we want a recompute (or, for the
    // visual-only selects, a fast re-colorize). The iterations slider is the
    // one control that also listens to `input` — but only to stream its
    // readout text during the drag, never to recompute; its recompute still
    // waits for `change` (drag release, or a keyboard step).
    maxIterRange.addEventListener('input', () => this.syncMaxIterReadout())
    maxIterRange.addEventListener('change', () => this.emit())
    renderScaleSelect.addEventListener('change', () => this.emit())
    paletteSelect.addEventListener('change', () => this.emit())
    normalisationSelect.addEventListener('change', () => this.emit())
    fieldSelect.addEventListener('change', () => {
      // Re-derive the valid Normalisation options (and substitute the
      // default if the current mode is now invalid) before emitting, so
      // the snapshot carries a coherent (field, normalisation) pair.
      this.applyFieldValidity()
      this.emit()
    })
    modeSelect.addEventListener('change', () => {
      // Re-derive the enabled state from the select's live value
      // rather than a closed-over flag — the select itself is the
      // source of truth, so even a programmatic value change can
      // synchronise the inputs by dispatching `change`.
      this.setCInputsEnabled(modeSelect.value === 'julia')
      this.emit()
    })
    cReInput.addEventListener('change', () => this.emit())
    cImInput.addEventListener('change', () => this.emit())
  }

  // Translate the slider index back to the iteration count it stands for.
  // The construction guard pinned the initial index in range, and a range
  // input clamps user interaction to [min, max], so the lookup is always
  // defined.
  private maxIterFromSlider(): number {
    return MAX_ITER_STOPS[Number(this.maxIterRange.value)]
  }

  // Mirror the live slider value into the readout text — on `input` (every
  // step of a drag) for instant feedback, separate from the `change`-gated
  // recompute.
  private syncMaxIterReadout(): void {
    this.maxIterReadout.textContent = String(this.maxIterFromSlider())
  }

  // Enforce the (Field × Normalisation mode) validity rule (ADR-0013): hide
  // the modes that don't apply to the active Field, and if the current mode is
  // invalid for it, substitute the Field's default. The pure policy lives in
  // `field-modes.ts`; this is its DOM enforcement.
  private applyFieldValidity(): void {
    const field = this.fieldSelect.value as FieldName
    for (const option of Array.from(this.normalisationSelect.options)) {
      const valid = isModeValidForField(field, option.value as NormalisationName)
      // `hidden` keeps it out of the dropdown; `disabled` stops keyboard
      // selection from reaching it — belt and braces.
      option.hidden = !valid
      option.disabled = !valid
    }
    if (!isModeValidForField(field, this.normalisationSelect.value as NormalisationName)) {
      this.normalisationSelect.value = defaultModeForField(field)
    }
  }

  private emit(): void {
    this.onChange({
      maxIter: this.maxIterFromSlider(),
      renderScale: Number(this.renderScaleSelect.value),
      palette: this.paletteSelect.value as PaletteName,
      normalisation: this.normalisationSelect.value as NormalisationName,
      field: this.fieldSelect.value as FieldName,
      mode: this.modeSelect.value as FractalMode,
      // valueAsNumber returns NaN for mid-edit states ("", "-",
      // "1.5e"). The dispatcher in main.ts substitutes a finite
      // fallback and calls `setCValues` to back-write the
      // substitution into the DOM so the visible field always
      // matches the rendered parameter.
      cRe: this.cReInput.valueAsNumber,
      cIm: this.cImInput.valueAsNumber,
    })
  }

  private setCInputsEnabled(enabled: boolean): void {
    this.cReInput.disabled = !enabled
    this.cImInput.disabled = !enabled
  }

  /**
   * Push a full settings snapshot into the form **without emitting** — used by
   * `main.ts` when an external view write (a pasted/edited permalink applied
   * live via `hashchange`, O1 #91) must be mirrored into the controls so the
   * form and the rendered frame never disagree. Setting `.value` /
   * `valueAsNumber` / `textContent` programmatically fires no `change`, so
   * this is a one-way sync that never re-enters the dispatcher (same contract
   * as `setCValues`).
   *
   * The caller guarantees the snapshot is form-valid: `maxIter` pre-snapped to
   * a stop (`nearestMaxIterStop`) and the (field, normalisation) pair coherent.
   * A `maxIter` that still isn't a stop is ignored (the slider holds its prior
   * position) rather than throwing — external state must never crash the form.
   */
  public applySettings(settings: Settings): void {
    const index = MAX_ITER_STOPS.indexOf(settings.maxIter)
    if (index !== -1) {
      this.maxIterRange.value = String(index)
    }
    this.syncMaxIterReadout()
    this.renderScaleSelect.value = String(settings.renderScale)
    this.paletteSelect.value = settings.palette
    this.fieldSelect.value = settings.field
    // Re-derive valid Normalisation options for the new Field first, then set
    // the (coherent) normalisation explicitly so it overrides any default the
    // validity pass would substitute.
    this.applyFieldValidity()
    this.normalisationSelect.value = settings.normalisation
    this.modeSelect.value = settings.mode
    this.setCInputsEnabled(settings.mode === 'julia')
    this.setCValues(settings.cRe, settings.cIm)
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
