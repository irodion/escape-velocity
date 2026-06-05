import { describe, expect, it, vi } from 'vitest'
import {
  type BeforeInstallPromptEvent,
  createPwaLifecycle,
  type InstallPromptSource,
  type ServiceWorkerRegistrar,
} from './pwa-lifecycle.js'

// A fake SW registrar that captures the lifecycle callbacks so a test can fire
// them synchronously, and exposes a spy for the returned `updateSW`.
function fakeRegistrar() {
  const updateSW = vi.fn(() => Promise.resolve())
  let captured: { onNeedRefresh: () => void; onOfflineReady: () => void } | null = null
  const registrar: ServiceWorkerRegistrar = (callbacks) => {
    captured = callbacks
    return updateSW
  }
  return {
    registrar,
    updateSW,
    fireNeedRefresh: () => captured?.onNeedRefresh(),
    fireOfflineReady: () => captured?.onOfflineReady(),
  }
}

// A fake install-event source that lets a test fire `beforeinstallprompt` /
// `appinstalled` on demand.
function fakeInstallSource() {
  let bip: ((event: BeforeInstallPromptEvent) => void) | null = null
  let installed: (() => void) | null = null
  const source: InstallPromptSource = {
    onBeforeInstallPrompt: (handler) => {
      bip = handler
    },
    onAppInstalled: (handler) => {
      installed = handler
    },
  }
  return {
    source,
    fireBeforeInstallPrompt: (event: BeforeInstallPromptEvent) => bip?.(event),
    fireAppInstalled: () => installed?.(),
  }
}

// A fake `BeforeInstallPromptEvent` resolving to a fixed outcome.
function fakePrompt(outcome: 'accepted' | 'dismissed') {
  const preventDefault = vi.fn()
  const prompt = vi.fn(() => Promise.resolve())
  return {
    event: {
      preventDefault,
      prompt,
      userChoice: Promise.resolve({ outcome, platform: 'web' }),
    } as unknown as BeforeInstallPromptEvent,
    preventDefault,
    prompt,
  }
}

function setup() {
  const registrar = fakeRegistrar()
  const install = fakeInstallSource()
  const lifecycle = createPwaLifecycle({
    registerServiceWorker: registrar.registrar,
    installPrompt: install.source,
  })
  return { lifecycle, registrar, install }
}

describe('pwa-lifecycle', () => {
  it('starts with nothing installable, no update, not offline-ready', () => {
    const { lifecycle } = setup()
    expect(lifecycle.getState()).toEqual({
      installable: false,
      needRefresh: false,
      offlineReady: false,
    })
  })

  it('becomes installable and suppresses the default infobar on beforeinstallprompt', () => {
    const { lifecycle, install } = setup()
    const { event, preventDefault } = fakePrompt('accepted')
    install.fireBeforeInstallPrompt(event)
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(lifecycle.getState().installable).toBe(true)
  })

  it('notifies subscribers on every transition and stops after unsubscribe', () => {
    const { lifecycle, install, registrar } = setup()
    const listener = vi.fn()
    const unsubscribe = lifecycle.subscribe(listener)

    install.fireBeforeInstallPrompt(fakePrompt('accepted').event)
    registrar.fireNeedRefresh()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({
      installable: true,
      needRefresh: true,
      offlineReady: false,
    })

    unsubscribe()
    registrar.fireOfflineReady()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('replays the deferred prompt and returns "accepted", clearing installable', async () => {
    const { lifecycle, install } = setup()
    const { event, prompt } = fakePrompt('accepted')
    install.fireBeforeInstallPrompt(event)

    const outcome = await lifecycle.promptInstall()
    expect(prompt).toHaveBeenCalledOnce()
    expect(outcome).toBe('accepted')
    expect(lifecycle.getState().installable).toBe(false)
  })

  it('returns "dismissed" when the user declines the prompt', async () => {
    const { lifecycle, install } = setup()
    install.fireBeforeInstallPrompt(fakePrompt('dismissed').event)
    expect(await lifecycle.promptInstall()).toBe('dismissed')
    expect(lifecycle.getState().installable).toBe(false)
  })

  it('is a no-op resolving "dismissed" when there is no deferred prompt', async () => {
    const { lifecycle } = setup()
    expect(await lifecycle.promptInstall()).toBe('dismissed')
  })

  it('consumes the deferred prompt so a second promptInstall is a no-op', async () => {
    const { lifecycle, install } = setup()
    const { event, prompt } = fakePrompt('accepted')
    install.fireBeforeInstallPrompt(event)

    await lifecycle.promptInstall()
    expect(await lifecycle.promptInstall()).toBe('dismissed')
    expect(prompt).toHaveBeenCalledOnce()
  })

  it('clears installable once the app reports it was installed', () => {
    const { lifecycle, install } = setup()
    install.fireBeforeInstallPrompt(fakePrompt('accepted').event)
    install.fireAppInstalled()
    expect(lifecycle.getState().installable).toBe(false)
  })

  it('flags needRefresh when a new service worker is waiting', () => {
    const { lifecycle, registrar } = setup()
    registrar.fireNeedRefresh()
    expect(lifecycle.getState().needRefresh).toBe(true)
  })

  it('applyUpdate activates the waiting worker via updateSW(true)', () => {
    const { lifecycle, registrar } = setup()
    lifecycle.applyUpdate()
    expect(registrar.updateSW).toHaveBeenCalledWith(true)
  })

  it('flags offlineReady on first service-worker activation', () => {
    const { lifecycle, registrar } = setup()
    registrar.fireOfflineReady()
    expect(lifecycle.getState().offlineReady).toBe(true)
  })

  it('dismiss clears the needRefresh and offlineReady notices', () => {
    const { lifecycle, registrar } = setup()
    registrar.fireNeedRefresh()
    registrar.fireOfflineReady()
    lifecycle.dismiss()
    expect(lifecycle.getState()).toMatchObject({ needRefresh: false, offlineReady: false })
  })
})
