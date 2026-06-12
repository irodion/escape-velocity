/**
 * Full-screen fatal-error surface (B4 / U2). Shown when the renderer cannot
 * run at all: the WASM module failed to instantiate, the page is not
 * cross-origin isolated (no `SharedArrayBuffer` for the rayon thread pool —
 * ADR-0007/0008), or the worker never reached `ready`. These are
 * unrecoverable for the session, so rather than leave the user staring at a
 * black `.stage` wondering what broke, this replaces it with a legible
 * message and a Reload button.
 *
 * Styling lives in `index.html` under `.fatal*` (reusing the `--panel` /
 * `--ink` tokens), consistent with how the PWA UI is styled — the inline
 * `<style>` in the document head is always present, even when every script
 * path has failed.
 *
 * Idempotent: only the first call builds the panel. A boot watchdog firing
 * after a `worker.onerror` (or vice versa) must not stack two overlays, and
 * the first, most-specific message wins.
 */
let shown = false

export function showFatal(title: string, detail: string): void {
  if (shown) return
  shown = true

  const overlay = document.createElement('div')
  overlay.className = 'fatal'
  // `alertdialog` + `aria-modal` so assistive tech announces it as a modal
  // error rather than inert decoration; the heading/body are wired as its
  // accessible name/description.
  overlay.setAttribute('role', 'alertdialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-labelledby', 'fatal-title')
  overlay.setAttribute('aria-describedby', 'fatal-detail')

  const panel = document.createElement('div')
  panel.className = 'fatal__panel'

  const heading = document.createElement('h1')
  heading.id = 'fatal-title'
  heading.className = 'fatal__title'
  heading.textContent = title

  const body = document.createElement('p')
  body.id = 'fatal-detail'
  body.className = 'fatal__detail'
  body.textContent = detail

  const reload = document.createElement('button')
  reload.type = 'button'
  reload.className = 'fatal__reload'
  reload.textContent = 'Reload'
  reload.addEventListener('click', () => {
    window.location.reload()
  })

  panel.append(heading, body, reload)
  overlay.append(panel)
  document.body.append(overlay)
  reload.focus()
}
