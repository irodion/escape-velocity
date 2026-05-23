import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Controls, type NormalisationName, type PaletteName, type Settings } from './controls.js'

const INITIAL: Settings = {
  maxIter: 256,
  width: 800,
  height: 600,
  palette: 'viridis',
  normalisation: 'cycled',
}

// Build the same form layout the production index.html ships. Slices
// 3 and 4 pin the option lists in their PRDs (max-iter: 64..8192
// doubling; resolution: four 4:3 presets; palette: five matplotlib-
// derived names; normalisation: cycled or histogram). The defaults
// selected here match the `selected` attributes on the HTML so the
// construction-time `value` assignment is a no-op against a clean
// form.
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

  it('populates all four selects from `initial` and fires nothing during construction', () => {
    new Controls(form, INITIAL, onChange)
    expect(selectByName(form, 'max-iter').value).toBe('256')
    expect(selectByName(form, 'resolution').value).toBe('800x600')
    expect(selectByName(form, 'palette').value).toBe('viridis')
    expect(selectByName(form, 'normalisation').value).toBe('cycled')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('fires onChange once with the new maxIter when max-iter changes', () => {
    new Controls(form, INITIAL, onChange)
    const maxIterSelect = selectByName(form, 'max-iter')
    maxIterSelect.value = '4096'
    maxIterSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({
      maxIter: 4096,
      width: 800,
      height: 600,
      palette: 'viridis',
      normalisation: 'cycled',
    })
  })

  it('fires onChange once with the parsed width/height when resolution changes', () => {
    new Controls(form, INITIAL, onChange)
    const resolutionSelect = selectByName(form, 'resolution')
    resolutionSelect.value = '1600x1200'
    resolutionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({
      maxIter: 256,
      width: 1600,
      height: 1200,
      palette: 'viridis',
      normalisation: 'cycled',
    })
  })

  it('fires onChange once with the new palette when palette changes', () => {
    new Controls(form, INITIAL, onChange)
    const paletteSelect = selectByName(form, 'palette')
    paletteSelect.value = 'magma'
    paletteSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({
      maxIter: 256,
      width: 800,
      height: 600,
      palette: 'magma',
      normalisation: 'cycled',
    })
  })

  it('fires onChange once with the new normalisation when normalisation changes', () => {
    new Controls(form, INITIAL, onChange)
    const normalisationSelect = selectByName(form, 'normalisation')
    normalisationSelect.value = 'histogram'
    normalisationSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({
      maxIter: 256,
      width: 800,
      height: 600,
      palette: 'viridis',
      normalisation: 'histogram',
    })
  })

  it('ignores the `input` event on every select', () => {
    new Controls(form, INITIAL, onChange)
    for (const name of ['max-iter', 'resolution', 'palette', 'normalisation']) {
      const sel = selectByName(form, name)
      // Pick any non-default value so the assignment actually changes
      // something — the test is about event semantics, not deltas.
      sel.value = sel.options[sel.options.length - 1]?.value ?? sel.value
      sel.dispatchEvent(new Event('input', { bubbles: true }))
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reads the live DOM on each emit so callbacks see cumulative state', () => {
    new Controls(form, INITIAL, onChange)
    const maxIterSelect = selectByName(form, 'max-iter')
    const paletteSelect = selectByName(form, 'palette')

    maxIterSelect.value = '1024'
    maxIterSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenLastCalledWith({
      maxIter: 1024,
      width: 800,
      height: 600,
      palette: 'viridis',
      normalisation: 'cycled',
    })

    // The second emit must reflect the first change's `max-iter`
    // value, not the initial `256` — that's what proves the class
    // doesn't cache state in instance fields.
    paletteSelect.value = 'inferno'
    paletteSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith({
      maxIter: 1024,
      width: 800,
      height: 600,
      palette: 'inferno',
      normalisation: 'cycled',
    })
  })
})
