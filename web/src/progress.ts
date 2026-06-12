import type { ProgressReporter } from './render-client.js'

/**
 * Determinate render-progress indicator (P2, #78). A small, unobtrusive
 * status pill that reads "Rendering NN%" while a slow deep render streams its
 * band heartbeats, then disappears when the frame lands.
 *
 * It implements the {@link ProgressReporter} contract the render-client
 * drives (`begin` / `report` / `end`) and owns the one piece of policy the
 * client deliberately doesn't: a **reveal debounce**. `begin` only *arms* a
 * timer; the pill appears only if the render is still running when the timer
 * fires. So the overwhelmingly common fast frame — pan, shallow zoom — never
 * flashes an indicator, while a multi-second render surfaces a real,
 * advancing percentage.
 *
 * Accessibility: the element is a `role="status"` `aria-live="polite"` region
 * so a screen reader announces that a render is in progress without stealing
 * focus; the percentage updates are polite, not assertive, so they don't
 * spam. Hidden via the `hidden` attribute (so it's removed from the a11y tree
 * and layout entirely when idle).
 */

// Delay before an in-flight render reveals the indicator. Below a typical
// fast frame's wall time, so quick renders complete (and `end()`) before the
// timer fires and never show; comfortably under the threshold where a user
// starts to wonder whether anything is happening.
const REVEAL_DELAY_MS = 150

/**
 * Build the indicator, append it to `parent`, and return the reporter the
 * render-client drives. Mirrors `fatal.ts`: all DOM is constructed here so
 * `index.html` only supplies the `.progress` styling.
 */
export function mountProgress(parent: HTMLElement = document.body): ProgressReporter {
  const el = document.createElement('div')
  el.className = 'progress'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.hidden = true

  const label = document.createElement('span')
  label.className = 'progress__label'
  el.appendChild(label)
  parent.appendChild(el)

  let timer: ReturnType<typeof setTimeout> | undefined
  let fraction = 0
  let reported = false
  let visible = false

  // Until the first band heartbeat lands there is no percentage to show, so
  // read an indeterminate ellipsis; afterwards, the rounded percentage.
  const text = (): string => (reported ? `Rendering ${Math.round(fraction * 100)}%` : 'Rendering…')

  const reveal = (): void => {
    timer = undefined
    visible = true
    label.textContent = text()
    el.hidden = false
  }

  return {
    begin: () => {
      fraction = 0
      reported = false
      // Already armed or showing (a superseding render reusing the live
      // indicator): keep the existing timer/visibility rather than resetting.
      if (visible || timer !== undefined) {
        return
      }
      timer = setTimeout(reveal, REVEAL_DELAY_MS)
    },
    report: (next: number) => {
      fraction = next
      reported = true
      if (visible) {
        label.textContent = text()
      }
    },
    end: () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      visible = false
      el.hidden = true
      label.textContent = ''
    },
  }
}
