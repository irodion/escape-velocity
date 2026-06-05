import { beforeEach, describe, expect, it } from 'vitest'
import { mountDrawer } from './drawer.js'

function setup(): {
  toggle: HTMLButtonElement
  drawer: HTMLElement
  firstSelect: HTMLSelectElement
} {
  document.body.innerHTML = `
    <button id="controls-toggle" type="button" aria-expanded="true">☰</button>
    <form id="controls">
      <select name="max-iter"><option value="256">256</option></select>
    </form>
  `
  const toggle = document.getElementById('controls-toggle') as HTMLButtonElement
  const drawer = document.getElementById('controls') as HTMLElement
  const firstSelect = drawer.querySelector('select') as HTMLSelectElement
  mountDrawer(toggle, drawer)
  return { toggle, drawer, firstSelect }
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
    expect(toggle.textContent).toBe('☰')
    expect(toggle.getAttribute('aria-label')).toBe('Open controls')
    expect(drawer.inert).toBe(true)
  })

  it('opens on click — slide class, aria, glyph, interactivity, and focus handoff', () => {
    const { toggle, drawer, firstSelect } = setup()
    toggle.click()
    expect(drawer.classList.contains('open')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('✕')
    expect(toggle.getAttribute('aria-label')).toBe('Close controls')
    expect(drawer.inert).toBe(false)
    expect(document.activeElement).toBe(firstSelect)
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
})
