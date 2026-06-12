import { afterEach, describe, expect, it, vi } from 'vitest'

// `showFatal` keeps module-level "already shown" state (idempotency), so each
// test imports a fresh module instance to reset it.
async function loadFatal(): Promise<{ showFatal: (title: string, detail: string) => void }> {
  vi.resetModules()
  return (await import('./fatal.js')) as { showFatal: (title: string, detail: string) => void }
}

describe('showFatal', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders an accessible alertdialog with the title, detail, and a Reload button', async () => {
    const { showFatal } = await loadFatal()

    showFatal('Renderer unavailable', 'SharedArrayBuffer is required.')

    const overlay = document.querySelector('.fatal')
    expect(overlay).not.toBeNull()
    expect(overlay?.getAttribute('role')).toBe('alertdialog')
    expect(overlay?.getAttribute('aria-modal')).toBe('true')
    expect(document.querySelector('.fatal__title')?.textContent).toBe('Renderer unavailable')
    expect(document.querySelector('.fatal__detail')?.textContent).toBe(
      'SharedArrayBuffer is required.',
    )
    const reload = document.querySelector('.fatal__reload')
    expect(reload?.textContent).toBe('Reload')
    // The dialog names/describes itself via the heading and body ids.
    expect(overlay?.getAttribute('aria-labelledby')).toBe(
      document.querySelector('.fatal__title')?.id,
    )
    expect(overlay?.getAttribute('aria-describedby')).toBe(
      document.querySelector('.fatal__detail')?.id,
    )
  })

  it('is idempotent: a second call does not stack a second panel', async () => {
    const { showFatal } = await loadFatal()

    showFatal('First failure', 'detail one')
    showFatal('Second failure', 'detail two')

    expect(document.querySelectorAll('.fatal')).toHaveLength(1)
    // The first, most-specific message wins.
    expect(document.querySelector('.fatal__title')?.textContent).toBe('First failure')
  })

  it('reloads the page when Reload is clicked', async () => {
    const { showFatal } = await loadFatal()
    const reload = vi.fn()
    // jsdom's location.reload throws "Not implemented"; replace it with a spy.
    Object.defineProperty(window, 'location', {
      value: { ...window.location, reload },
      configurable: true,
    })

    showFatal('Renderer unavailable', 'detail')
    document.querySelector<HTMLButtonElement>('.fatal__reload')?.click()

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
