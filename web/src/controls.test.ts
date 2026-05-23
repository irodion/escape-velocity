import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Controls, type Settings } from './controls.js'

const INITIAL: Settings = { maxIter: 256, width: 800, height: 600 }

// Build the same form layout the production index.html ships. Slice 3
// pins the option lists in the PRD (max-iter: 64..8192 doubling;
// resolution: four 4:3 presets). The defaults selected here match the
// `selected` attributes on the HTML so the construction-time `value`
// assignment is a no-op against a clean form.
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
      new Controls(form, { maxIter: 999, width: 800, height: 600 }, onChange)
    }).toThrow(/initial\.maxIter=999/)
  })

  it('throws when initial resolution does not match any <option>', () => {
    expect(() => {
      new Controls(form, { maxIter: 256, width: 1000, height: 1000 }, onChange)
    }).toThrow(/initial resolution "1000x1000"/)
  })

  it('populates both selects from `initial` and fires nothing during construction', () => {
    new Controls(form, INITIAL, onChange)
    expect(selectByName(form, 'max-iter').value).toBe('256')
    expect(selectByName(form, 'resolution').value).toBe('800x600')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('fires onChange once with the new maxIter when max-iter changes', () => {
    new Controls(form, INITIAL, onChange)
    const maxIterSelect = selectByName(form, 'max-iter')
    maxIterSelect.value = '4096'
    maxIterSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ maxIter: 4096, width: 800, height: 600 })
  })

  it('fires onChange once with the parsed width/height when resolution changes', () => {
    new Controls(form, INITIAL, onChange)
    const resolutionSelect = selectByName(form, 'resolution')
    resolutionSelect.value = '1600x1200'
    resolutionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ maxIter: 256, width: 1600, height: 1200 })
  })

  it('ignores the `input` event on either select', () => {
    new Controls(form, INITIAL, onChange)
    const maxIterSelect = selectByName(form, 'max-iter')
    const resolutionSelect = selectByName(form, 'resolution')
    maxIterSelect.value = '512'
    maxIterSelect.dispatchEvent(new Event('input', { bubbles: true }))
    resolutionSelect.value = '400x300'
    resolutionSelect.dispatchEvent(new Event('input', { bubbles: true }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reads the live DOM on each emit so callbacks see cumulative state', () => {
    new Controls(form, INITIAL, onChange)
    const maxIterSelect = selectByName(form, 'max-iter')
    const resolutionSelect = selectByName(form, 'resolution')

    maxIterSelect.value = '1024'
    maxIterSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenLastCalledWith({ maxIter: 1024, width: 800, height: 600 })

    // The second emit must reflect the first change's `max-iter`
    // value, not the initial `256` — that's what proves the class
    // doesn't cache state in instance fields.
    resolutionSelect.value = '1200x900'
    resolutionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith({ maxIter: 1024, width: 1200, height: 900 })
  })
})
