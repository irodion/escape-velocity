import type { PwaLifecycle, PwaLifecycleState } from './pwa-lifecycle.js'

/**
 * Thin DOM presenter (Slice 8B) over the `pwa-lifecycle` controller: an
 * "Install" button shown only while the app is installable, and a toast that
 * surfaces a waiting service-worker update ("New version available — Reload")
 * or the first-time offline-ready notice. All decisions live in the controller;
 * this is glue that reflects its state into the DOM and forwards clicks back —
 * deliberately not unit-tested (consistent with how boot wiring is treated).
 */

// How long the transient "ready to work offline" notice lingers before it
// auto-dismisses. `ReturnType<typeof setTimeout>` so the timer type is correct
// under both DOM and Node lib typings.
const OFFLINE_NOTICE_MS = 5000

export function mountPwaUi(lifecycle: PwaLifecycle, container: HTMLElement): void {
  const installButton = document.createElement('button')
  installButton.id = 'pwa-install'
  installButton.type = 'button'
  installButton.textContent = 'Install'
  installButton.hidden = true
  installButton.addEventListener('click', () => {
    void lifecycle.promptInstall()
  })

  const toast = document.createElement('div')
  toast.className = 'pwa-toast'
  // role="status" (implicit aria-live="polite") so the update prompt and the
  // transient offline-ready notice are announced to assistive tech — a bare
  // div toggled from `hidden` is otherwise silent.
  toast.setAttribute('role', 'status')
  toast.hidden = true
  const message = document.createElement('span')
  const reloadButton = document.createElement('button')
  reloadButton.type = 'button'
  reloadButton.textContent = 'Reload'
  reloadButton.addEventListener('click', () => lifecycle.applyUpdate())
  const dismissButton = document.createElement('button')
  dismissButton.type = 'button'
  dismissButton.textContent = 'Dismiss'
  dismissButton.addEventListener('click', () => lifecycle.dismiss())
  toast.append(message, reloadButton, dismissButton)

  container.append(installButton, toast)

  let offlineNoticeTimer: ReturnType<typeof setTimeout> | undefined

  const clearOfflineNoticeTimer = (): void => {
    if (offlineNoticeTimer !== undefined) {
      clearTimeout(offlineNoticeTimer)
      offlineNoticeTimer = undefined
    }
  }

  const renderState = (state: PwaLifecycleState): void => {
    installButton.hidden = !state.installable

    if (state.needRefresh) {
      // A waiting update takes precedence over the offline notice: it needs an
      // explicit Reload to activate the new build. Cancel any pending
      // offline-ready auto-dismiss timer first — its callback calls the
      // controller's `dismiss()`, which clears BOTH notices, so left running
      // it would silently wipe this update prompt a few seconds after it
      // appeared.
      clearOfflineNoticeTimer()
      // The build identifier (O2, #92) names which build is *currently running*
      // — so when the toast appears, the developer can tell what is being
      // replaced. The waiting build's own identifier is unknown until it
      // activates and logs its own boot line.
      message.textContent = `New version available · build ${__APP_VERSION__}`
      reloadButton.hidden = false
      toast.hidden = false
    } else if (state.offlineReady) {
      message.textContent = 'Ready to work offline.'
      reloadButton.hidden = true
      toast.hidden = false
      // Transient: auto-dismiss so the confirmation doesn't linger forever.
      if (offlineNoticeTimer === undefined) {
        offlineNoticeTimer = setTimeout(() => {
          offlineNoticeTimer = undefined
          lifecycle.dismiss()
        }, OFFLINE_NOTICE_MS)
      }
    } else {
      // Notices gone (e.g. user dismissed) — drop any pending timer so it
      // can't fire a stale `dismiss()` later.
      clearOfflineNoticeTimer()
      toast.hidden = true
    }
  }

  lifecycle.subscribe(renderState)
  renderState(lifecycle.getState())
}
