import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PwaLifecycle, PwaLifecycleState } from './pwa-lifecycle.js'
import { mountPwaUi } from './pwa-ui.js'

// The presenter is mostly thin glue (reflect state → DOM, forward clicks), but
// the transient offline-ready timer is real logic worth pinning — a stale
// timer must not auto-dismiss a subsequently-shown update prompt (the P2
// regression below). A controllable fake lifecycle lets a test push state
// transitions and observe `dismiss` / `applyUpdate`.
function fakeLifecycle() {
  let state: PwaLifecycleState = { installable: false, needRefresh: false, offlineReady: false }
  const listeners = new Set<(s: PwaLifecycleState) => void>()
  const emit = (): void => {
    for (const listener of listeners) listener({ ...state })
  }
  const dismiss = vi.fn(() => {
    state = { ...state, needRefresh: false, offlineReady: false }
    emit()
  })
  const promptInstall = vi.fn(() => Promise.resolve('dismissed' as const))
  const applyUpdate = vi.fn()
  const lifecycle: PwaLifecycle = {
    getState: () => ({ ...state }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    promptInstall,
    applyUpdate,
    dismiss,
  }
  return {
    lifecycle,
    set: (patch: Partial<PwaLifecycleState>) => {
      state = { ...state, ...patch }
      emit()
    },
    dismiss,
    applyUpdate,
    promptInstall,
  }
}

const toastEl = () => document.querySelector('.pwa-toast') as HTMLElement
const installEl = () => document.querySelector('#pwa-install') as HTMLButtonElement
const buttonByText = (root: HTMLElement, text: string): HTMLButtonElement =>
  Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement

// Past the (private) 5s auto-dismiss window, with margin.
const PAST_OFFLINE_NOTICE_MS = 10_000

describe('pwa-ui presenter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('shows the Install button only while installable, forwarding clicks', () => {
    const fake = fakeLifecycle()
    mountPwaUi(fake.lifecycle, document.body)
    expect(installEl().hidden).toBe(true)

    fake.set({ installable: true })
    expect(installEl().hidden).toBe(false)
    installEl().click()
    expect(fake.promptInstall).toHaveBeenCalledOnce()

    fake.set({ installable: false })
    expect(installEl().hidden).toBe(true)
  })

  it('surfaces a waiting update with a Reload that applies it', () => {
    const fake = fakeLifecycle()
    mountPwaUi(fake.lifecycle, document.body)
    expect(toastEl().hidden).toBe(true)

    fake.set({ needRefresh: true })
    expect(toastEl().hidden).toBe(false)
    expect(toastEl().textContent).toContain('New version available')
    buttonByText(toastEl(), 'Reload').click()
    expect(fake.applyUpdate).toHaveBeenCalledOnce()
  })

  it('auto-dismisses the transient offline-ready notice after the timeout', () => {
    const fake = fakeLifecycle()
    mountPwaUi(fake.lifecycle, document.body)

    fake.set({ offlineReady: true })
    expect(toastEl().textContent).toContain('Ready to work offline')
    expect(fake.dismiss).not.toHaveBeenCalled()

    vi.advanceTimersByTime(PAST_OFFLINE_NOTICE_MS)
    expect(fake.dismiss).toHaveBeenCalledOnce()
  })

  it('does not let a pending offline-ready timer dismiss a later update prompt (P2 regression)', () => {
    const fake = fakeLifecycle()
    mountPwaUi(fake.lifecycle, document.body)

    // Offline notice appears and schedules its auto-dismiss...
    fake.set({ offlineReady: true })
    // ...then an update arrives before the timeout fires.
    fake.set({ needRefresh: true })
    expect(toastEl().textContent).toContain('New version available')

    // Let the original offline timeout elapse: the update prompt must survive.
    vi.advanceTimersByTime(PAST_OFFLINE_NOTICE_MS)
    expect(fake.dismiss).not.toHaveBeenCalled()
    expect(toastEl().hidden).toBe(false)
    expect(toastEl().textContent).toContain('New version available')
  })
})
