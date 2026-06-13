import { describe, expect, it, vi } from 'vitest'
import type { Viewport } from '../wasm/fractal_wasm.js'
import { createViewportStore } from './viewport-store.js'

// Sentinel viewports — the store never inspects them, it only stores and
// hands them back, so opaque tokens suffice.
const vp = (tag: string): Viewport => ({ tag }) as unknown as Viewport

describe('createViewportStore', () => {
  it('returns the seeded viewport from get() until the first set()', () => {
    const boot = vp('boot')
    const store = createViewportStore(boot)
    expect(store.get()).toBe(boot)
  })

  it('get() reflects the most recent set()', () => {
    const store = createViewportStore(vp('boot'))
    const next = vp('next')
    store.set(next, 'gesture')
    expect(store.get()).toBe(next)
  })

  it('notifies every subscriber with the viewport and source on each set()', () => {
    const store = createViewportStore(vp('boot'))
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe(a)
    store.subscribe(b)

    const refit = vp('refit')
    store.set(refit, 'refit')

    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(refit, 'refit')
    expect(b).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith(refit, 'refit')
  })

  it('does not notify on subscribe — only on subsequent set()', () => {
    const store = createViewportStore(vp('boot'))
    const listener = vi.fn()
    store.subscribe(listener)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe()', () => {
    const store = createViewportStore(vp('boot'))
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.set(vp('one'), 'gesture')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.set(vp('two'), 'gesture')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('sees the new viewport via get() from inside a subscriber (set commits before notifying)', () => {
    const store = createViewportStore(vp('boot'))
    const next = vp('next')
    let seen: Viewport | undefined
    store.subscribe(() => {
      seen = store.get()
    })
    store.set(next, 'mode-reset')
    expect(seen).toBe(next)
  })

  it('unsubscribing during dispatch does not skip another listener (iterates a snapshot)', () => {
    const store = createViewportStore(vp('boot'))
    const order: string[] = []
    // The first listener removes itself mid-dispatch; the second must still
    // run for this same set() — the store iterates a copy of the listener set.
    const unsubscribe = store.subscribe(() => {
      order.push('first')
      unsubscribe()
    })
    store.subscribe(() => {
      order.push('second')
    })
    store.set(vp('one'), 'gesture')
    expect(order).toEqual(['first', 'second'])

    // The self-removal took effect for the next set().
    order.length = 0
    store.set(vp('two'), 'gesture')
    expect(order).toEqual(['second'])
  })
})
