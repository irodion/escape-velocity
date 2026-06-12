import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mountProgress } from './progress.js'

// The reveal debounce is timer-driven, so the suite runs on fake timers.
describe('mountProgress', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const el = (): HTMLElement => document.querySelector('.progress') as HTMLElement
  const label = (): HTMLElement => document.querySelector('.progress__label') as HTMLElement

  it('renders an accessible status region, hidden until revealed', () => {
    mountProgress(document.body)
    expect(el()).not.toBeNull()
    expect(el().getAttribute('role')).toBe('status')
    expect(el().getAttribute('aria-live')).toBe('polite')
    expect(el().hidden).toBe(true)
  })

  it('stays hidden for a fast render that ends before the reveal delay', () => {
    const reporter = mountProgress(document.body)
    reporter.begin()
    reporter.report(0.3)
    vi.advanceTimersByTime(100) // < 150ms reveal delay
    reporter.end()
    vi.advanceTimersByTime(1000) // the armed timer must have been cancelled
    expect(el().hidden).toBe(true)
  })

  it('reveals after the delay, indeterminate until the first heartbeat, then a percentage', () => {
    const reporter = mountProgress(document.body)
    reporter.begin()
    vi.advanceTimersByTime(150)
    // Revealed, but no band heartbeat yet → indeterminate ellipsis.
    expect(el().hidden).toBe(false)
    expect(label().textContent).toBe('Rendering…')
    reporter.report(0.42)
    expect(label().textContent).toBe('Rendering 42%')
  })

  it('reflects a heartbeat that arrived before the reveal when the timer fires', () => {
    const reporter = mountProgress(document.body)
    reporter.begin()
    reporter.report(0.6) // arrives during the debounce window
    vi.advanceTimersByTime(150)
    expect(el().hidden).toBe(false)
    expect(label().textContent).toBe('Rendering 60%')
  })

  it('hides and clears its label on end', () => {
    const reporter = mountProgress(document.body)
    reporter.begin()
    vi.advanceTimersByTime(150)
    reporter.report(0.5)
    expect(el().hidden).toBe(false)

    reporter.end()
    expect(el().hidden).toBe(true)
    expect(label().textContent).toBe('')
  })
})
