import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Controls,
  type FractalMode,
  type NormalisationName,
  type PaletteName,
  type Settings,
} from './controls.js'

const INITIAL: Settings = {
  maxIter: 256,
  width: 800,
  height: 600,
  palette: 'viridis',
  normalisation: 'cycled',
  mode: 'mandelbrot',
  cRe: -0.7,
  cIm: 0.27015,
}

// Build the same form layout the production index.html ships. Slices
// 3 and 4 pin the option lists in their PRDs (max-iter: 64..8192
// doubling; resolution: four 4:3 presets; palette: five matplotlib-
// derived names; normalisation: cycled or histogram). Slice 5C adds
// the `mode <select>` and the two `c.re` / `c.im` number inputs; the
// numeric inputs ship `disabled` because the default mode is
// Mandelbrot (which ignores `c`). The defaults selected here match
// the `selected` attributes on the HTML so the construction-time
// `value` assignment is a no-op against a clean form.
function buildForm(): HTMLFormElement {
  const form = document.createElement('form')
  form.id = 'controls'
  form.innerHTML = `
    <label>
      Iterations:
      <select name="max-iter">
        <option value="64">64</option>
        <option value="128">128</option>
        <option value="256" selected>256</option>
        <option value="512">512</option>
        <option value="1024">1024</option>
        <option value="2048">2048</option>
        <option value="4096">4096</option>
        <option value="8192">8192</option>
      </select>
    </label>
    <label>
      Resolution:
      <select name="resolution">
        <option value="400x300">400 × 300</option>
        <option value="800x600" selected>800 × 600</option>
        <option value="1200x900">1200 × 900</option>
        <option value="1600x1200">1600 × 1200</option>
      </select>
    </label>
    <label>
      Palette:
      <select name="palette">
        <option value="grayscale">Grayscale</option>
        <option value="viridis" selected>Viridis</option>
        <option value="magma">Magma</option>
        <option value="inferno">Inferno</option>
        <option value="twilight">Twilight</option>
      </select>
    </label>
    <label>
      Coloring:
      <select name="normalisation">
        <option value="cycled" selected>Cycled</option>
        <option value="histogram">Match palette to image</option>
      </select>
    </label>
    <label>
      Fractal:
      <select name="mode">
        <option value="mandelbrot" selected>Mandelbrot</option>
        <option value="julia">Julia</option>
      </select>
    </label>
    <label>
      c.re:
      <input type="number" name="c-re" step="0.0001" value="-0.7" disabled />
    </label>
    <label>
      c.im:
      <input type="number" name="c-im" step="0.0001" value="0.27015" disabled />
    </label>
  `
  document.body.appendChild(form)
  return form
}

function selectByName(form: HTMLFormElement, name: string): HTMLSelectElement {
  const el = form.elements.namedItem(name)
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`expected <select name="${name}"> in test form`)
  }
  return el
}

function inputByName(form: HTMLFormElement, name: string): HTMLInputElement {
  const el = form.elements.namedItem(name)
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`expected <input name="${name}"> in test form`)
  }
  return el
}

describe('Controls', () => {
  let form: HTMLFormElement
  let onChange: ReturnType<typeof vi.fn<(settings: Settings) => void>>

  beforeEach(() => {
    form = buildForm()
    onChange = vi.fn<(settings: Settings) => void>()
  })

  afterEach(() => {
    document.body.removeChild(form)
  })

  it('throws when initial.maxIter does not match any <option>', () => {
    // Programmer error: caller's INITIAL_MAX_ITER constant drifted
    // from the HTML option list. Without the construction-time guard,
    // maxIterSelect.value silently becomes '' and the first emit
    // would push maxIter=0 through to the WASM boundary.
    expect(() => {
      new Controls(form, { ...INITIAL, maxIter: 999 }, onChange)
    }).toThrow(/initial\.maxIter=999/)
  })

  it('throws when initial resolution does not match any <option>', () => {
    expect(() => {
      new Controls(form, { ...INITIAL, width: 1000, height: 1000 }, onChange)
    }).toThrow(/initial resolution "1000x1000"/)
  })

  it('throws when initial.palette does not match any <option>', () => {
    // Cast through `unknown` rather than `any` so the test exercises
    // the runtime guard without weakening the surrounding type checks
    // — `as any` would silently disable noise from any other typo in
    // the spread literal.
    const bad = { ...INITIAL, palette: 'cobalt' as unknown as PaletteName }
    expect(() => new Controls(form, bad, onChange)).toThrow(/initial\.palette="cobalt"/)
  })

  it('throws when initial.normalisation does not match any <option>', () => {
    const bad = {
      ...INITIAL,
      normalisation: 'rainbow' as unknown as NormalisationName,
    }
    expect(() => new Controls(form, bad, onChange)).toThrow(/initial\.normalisation="rainbow"/)
  })

  it('throws when initial.mode does not match any <option>', () => {
    const bad = { ...INITIAL, mode: 'newton' as unknown as FractalMode }
    expect(() => new Controls(form, bad, onChange)).toThrow(/initial\.mode="newton"/)
  })

  it('throws when initial.cRe is NaN', () => {
    expect(() => new Controls(form, { ...INITIAL, cRe: Number.NaN }, onChange)).toThrow(
      /initial\.cRe=NaN/,
    )
  })

  it('throws when initial.cIm is NaN', () => {
    expect(() => new Controls(form, { ...INITIAL, cIm: Number.NaN }, onChange)).toThrow(
      /initial\.cIm=NaN/,
    )
  })

  it('populates all seven controls from `initial` and fires nothing during construction', () => {
    new Controls(form, INITIAL, onChange)
    expect(selectByName(form, 'max-iter').value).toBe('256')
    expect(selectByName(form, 'resolution').value).toBe('800x600')
    expect(selectByName(form, 'palette').value).toBe('viridis')
    expect(selectByName(form, 'normalisation').value).toBe('cycled')
    expect(selectByName(form, 'mode').value).toBe('mandelbrot')
    expect(inputByName(form, 'c-re').valueAsNumber).toBe(-0.7)
    expect(inputByName(form, 'c-im').valueAsNumber).toBe(0.27015)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables the two c inputs when initial.mode is mandelbrot', () => {
    new Controls(form, INITIAL, onChange)
    expect(inputByName(form, 'c-re').disabled).toBe(true)
    expect(inputByName(form, 'c-im').disabled).toBe(true)
  })

  it('enables the two c inputs when initial.mode is julia', () => {
    new Controls(form, { ...INITIAL, mode: 'julia' }, onChange)
    expect(inputByName(form, 'c-re').disabled).toBe(false)
    expect(inputByName(form, 'c-im').disabled).toBe(false)
  })

  it('fires onChange once with the new maxIter when max-iter changes', () => {
    new Controls(form, INITIAL, onChange)
    const maxIterSelect = selectByName(form, 'max-iter')
    maxIterSelect.value = '4096'
    maxIterSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL, maxIter: 4096 })
  })

  it('fires onChange once with the parsed width/height when resolution changes', () => {
    new Controls(form, INITIAL, onChange)
    const resolutionSelect = selectByName(form, 'resolution')
    resolutionSelect.value = '1600x1200'
    resolutionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL, width: 1600, height: 1200 })
  })

  it('fires onChange once with the new palette when palette changes', () => {
    new Controls(form, INITIAL, onChange)
    const paletteSelect = selectByName(form, 'palette')
    paletteSelect.value = 'magma'
    paletteSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL, palette: 'magma' })
  })

  it('fires onChange once with the new normalisation when normalisation changes', () => {
    new Controls(form, INITIAL, onChange)
    const normalisationSelect = selectByName(form, 'normalisation')
    normalisationSelect.value = 'histogram'
    normalisationSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL, normalisation: 'histogram' })
  })

  it('fires onChange once with the new mode when mode changes', () => {
    new Controls(form, INITIAL, onChange)
    const modeSelect = selectByName(form, 'mode')
    modeSelect.value = 'julia'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL, mode: 'julia' })
  })

  it('un-disables both c inputs when mode flips mandelbrot → julia', () => {
    new Controls(form, INITIAL, onChange)
    const modeSelect = selectByName(form, 'mode')
    modeSelect.value = 'julia'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(inputByName(form, 'c-re').disabled).toBe(false)
    expect(inputByName(form, 'c-im').disabled).toBe(false)
  })

  it('disables both c inputs when mode flips julia → mandelbrot', () => {
    new Controls(form, { ...INITIAL, mode: 'julia' }, onChange)
    const modeSelect = selectByName(form, 'mode')
    modeSelect.value = 'mandelbrot'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(inputByName(form, 'c-re').disabled).toBe(true)
    expect(inputByName(form, 'c-im').disabled).toBe(true)
  })

  it('fires onChange once with the new cRe when c-re changes', () => {
    // Start in Julia mode so the inputs are enabled and the user can
    // actually commit a value through the form.
    new Controls(form, { ...INITIAL, mode: 'julia' }, onChange)
    const cReInput = inputByName(form, 'c-re')
    cReInput.valueAsNumber = -0.5
    cReInput.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL, mode: 'julia', cRe: -0.5 })
  })

  it('fires onChange once with the new cIm when c-im changes', () => {
    new Controls(form, { ...INITIAL, mode: 'julia' }, onChange)
    const cImInput = inputByName(form, 'c-im')
    cImInput.valueAsNumber = 0.5
    cImInput.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ ...INITIAL, mode: 'julia', cIm: 0.5 })
  })

  it('emits NaN for cRe when the input is cleared mid-edit (dispatcher filters and back-writes)', () => {
    // Clearing an `<input type="number">` puts it in an empty state;
    // `valueAsNumber` then reads back NaN. The Controls class does
    // NOT filter this — it passes the raw snapshot through so the
    // dispatcher (main.ts) can decide what to do, then calls
    // `setCValues` to back-write its substituted fallback.
    new Controls(form, { ...INITIAL, mode: 'julia' }, onChange)
    const cReInput = inputByName(form, 'c-re')
    cReInput.value = ''
    cReInput.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const snapshot = onChange.mock.calls[0]?.[0]
    expect(snapshot).toBeDefined()
    expect(Number.isNaN(snapshot?.cRe)).toBe(true)
  })

  it('setCValues writes both inputs and does not fire onChange', () => {
    // Back-write contract: the dispatcher calls this to keep the
    // DOM aligned with the rendered parameter after sanitising a
    // mid-edit NaN. The write MUST NOT re-enter the dispatcher —
    // setting `valueAsNumber` does not dispatch `change`, but pin
    // that assumption with a test so a future refactor that switches
    // to `setAttribute('value', ...)` (which also wouldn't fire
    // `change` — same outcome) or `dispatchEvent(...)` (which would)
    // is caught here.
    const controls = new Controls(form, { ...INITIAL, mode: 'julia' }, onChange)
    controls.setCValues(-0.123, 0.745)
    expect(inputByName(form, 'c-re').valueAsNumber).toBe(-0.123)
    expect(inputByName(form, 'c-im').valueAsNumber).toBe(0.745)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ignores the `input` event on every control', () => {
    // `<input type="number">` fires `input` on every keystroke; the
    // PRD's commit-not-live contract is that ONLY blur/Enter (which
    // emit `change`) triggers a render. Same contract for the four
    // <select>s, where `input` would fire on dropdown scrub.
    new Controls(form, INITIAL, onChange)
    for (const name of ['max-iter', 'resolution', 'palette', 'normalisation', 'mode']) {
      const sel = selectByName(form, name)
      sel.value = sel.options[sel.options.length - 1]?.value ?? sel.value
      sel.dispatchEvent(new Event('input', { bubbles: true }))
    }
    for (const name of ['c-re', 'c-im']) {
      const inp = inputByName(form, name)
      inp.valueAsNumber = 1.5
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reads the live DOM on each emit so callbacks see cumulative state', () => {
    new Controls(form, INITIAL, onChange)
    const maxIterSelect = selectByName(form, 'max-iter')
    const paletteSelect = selectByName(form, 'palette')

    maxIterSelect.value = '1024'
    maxIterSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenLastCalledWith({ ...INITIAL, maxIter: 1024 })

    // The second emit must reflect the first change's `max-iter`
    // value, not the initial `256` — that's what proves the class
    // doesn't cache state in instance fields.
    paletteSelect.value = 'inferno'
    paletteSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith({ ...INITIAL, maxIter: 1024, palette: 'inferno' })
  })
})
