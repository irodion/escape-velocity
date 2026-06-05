/**
 * PWA install + update lifecycle (Slice 8B) — a small, framework-agnostic
 * state machine over the two browser lifecycle concerns the UI cares about:
 *
 *   - installability: the browser fired `beforeinstallprompt`, so we can offer
 *     a custom "Install" affordance and replay the deferred prompt on click.
 *   - service-worker updates: a freshly built SW is waiting (`onNeedRefresh`),
 *     or the app has just been cached for offline use (`onOfflineReady`).
 *
 * Its two side-effecting dependencies — the SW registrar (vite-plugin-pwa's
 * `registerSW`) and the install-event source (`window`'s `beforeinstallprompt`
 * / `appinstalled`) — are *injected*, so the transitions are unit-tested with
 * fakes, no real browser, service worker, or install event required. The DOM
 * presenter (`pwa-ui.ts`) is thin glue over this module; `main.ts` wires the
 * real adapters. This keeps the logic a deep module behind a tiny interface,
 * mirroring how `controls.ts` / `input.ts` keep logic separable from the DOM.
 */

// `BeforeInstallPromptEvent` is not in the standard DOM lib. Declare the
// minimal surface we use: `preventDefault` (suppress the browser's default
// mini-infobar so our own button drives install), `prompt()` (show the native
// dialog), and `userChoice` (the user's accept/dismiss decision).
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

// `updateSW(true)` activates the waiting service worker and reloads the page.
export type UpdateServiceWorker = (reloadPage?: boolean) => Promise<void>

// The SW-registrar adapter: register the service worker, wiring the two update
// callbacks, and hand back the `updateSW` activator. Shaped to be satisfied by
// `(cb) => registerSW({ immediate: true, ...cb })` in production.
export type ServiceWorkerRegistrar = (callbacks: {
  onNeedRefresh: () => void
  onOfflineReady: () => void
}) => UpdateServiceWorker

// The install-event adapter: subscribe to the two `window` events. Kept as an
// injected port so tests can fire them synchronously.
export interface InstallPromptSource {
  onBeforeInstallPrompt(handler: (event: BeforeInstallPromptEvent) => void): void
  onAppInstalled(handler: () => void): void
}

export interface PwaLifecycleState {
  /** A `beforeinstallprompt` was captured and not yet consumed. */
  installable: boolean
  /** A new service worker is waiting to activate. */
  needRefresh: boolean
  /** The app has just been precached for offline use. */
  offlineReady: boolean
}

export interface PwaLifecycle {
  getState(): PwaLifecycleState
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: (state: PwaLifecycleState) => void): () => void
  /**
   * Replay the deferred install prompt and resolve with the user's choice.
   * A no-op resolving `'dismissed'` if no prompt is currently available.
   */
  promptInstall(): Promise<'accepted' | 'dismissed'>
  /** Activate the waiting service worker and reload (via `updateSW(true)`). */
  applyUpdate(): void
  /** Clear the `needRefresh` / `offlineReady` notices. */
  dismiss(): void
}

export function createPwaLifecycle(deps: {
  registerServiceWorker: ServiceWorkerRegistrar
  installPrompt: InstallPromptSource
}): PwaLifecycle {
  const state: PwaLifecycleState = {
    installable: false,
    needRefresh: false,
    offlineReady: false,
  }
  const listeners = new Set<(state: PwaLifecycleState) => void>()

  // A snapshot is handed to listeners so they can't mutate internal state.
  const notify = (): void => {
    const snapshot = { ...state }
    for (const listener of listeners) listener(snapshot)
  }

  // Stashed deferred prompt; non-null exactly while `installable` is true.
  let deferredPrompt: BeforeInstallPromptEvent | null = null

  const updateServiceWorker = deps.registerServiceWorker({
    onNeedRefresh: () => {
      state.needRefresh = true
      notify()
    },
    onOfflineReady: () => {
      state.offlineReady = true
      notify()
    },
  })

  deps.installPrompt.onBeforeInstallPrompt((event) => {
    // Suppress the browser's default infobar so our own button is the single
    // install affordance, and stash the event to replay on click.
    event.preventDefault()
    deferredPrompt = event
    state.installable = true
    notify()
  })

  deps.installPrompt.onAppInstalled(() => {
    deferredPrompt = null
    state.installable = false
    notify()
  })

  return {
    getState: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async promptInstall() {
      const prompt = deferredPrompt
      if (prompt === null) return 'dismissed'
      // A deferred prompt is single-use: clear it and drop `installable`
      // before awaiting, so a double-click can't replay a consumed event.
      deferredPrompt = null
      state.installable = false
      notify()
      await prompt.prompt()
      const { outcome } = await prompt.userChoice
      return outcome
    },
    applyUpdate() {
      // Fire-and-forget: `updateSW(true)` reloads the page, so there is no
      // post-call state to settle.
      void updateServiceWorker(true)
    },
    dismiss() {
      state.needRefresh = false
      state.offlineReady = false
      notify()
    },
  }
}
