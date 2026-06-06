/**
 * (Field × Normalisation mode) validity — the pure rule from ADR-0013.
 *
 * `colorize` is Field-blind (it only ever sees a scalar), so the core
 * cannot reject a meaningless pairing such as Distance Estimate + Cycled.
 * The constraint is real all the same — Cycled divides by an iteration
 * period, which a distance has none of; Clamped ramps over the first `k`
 * pixels of *distance*, meaningless for an iteration count. So validity is
 * enforced at the UI layer: the controls never offer an invalid pair and
 * substitute the Field's default mode when a Field switch invalidates the
 * current one.
 *
 * This module is that rule as a pure function — no DOM, so it is unit-
 * testable in isolation, and there is exactly one place the policy lives.
 */
import type { FieldName, NormalisationName } from './controls.js'

/**
 * Is `mode` a meaningful normalisation for `field`?
 *
 * - **Cycled** is Escape-Time only (it assumes iteration units).
 * - **Clamped** is Distance-Estimate only (it ramps over pixels of
 *   distance).
 * - **Histogram / Linear / SquareRoot / Logarithmic** apply to any Field —
 *   they are pure functions of the scalar's distribution or magnitude.
 */
export function isModeValidForField(field: FieldName, mode: NormalisationName): boolean {
  switch (mode) {
    case 'cycled':
      return field === 'escape-time'
    case 'clamped':
      return field === 'distance-estimate'
    case 'histogram':
    case 'linear':
    case 'sqrt':
    case 'logarithmic':
      return true
  }
}

/**
 * The Field's default normalisation — the mode selected when a Field
 * switch invalidates the current one. Escape Time keeps the banded
 * `cycled` look it has always defaulted to; Distance Estimate defaults to
 * `clamped`, which renders the boundary as hairline filaments.
 *
 * The returned mode is, by construction, valid for the Field
 * (`isModeValidForField(field, defaultModeForField(field))` is always
 * true) — a property the tests pin.
 */
export function defaultModeForField(field: FieldName): NormalisationName {
  switch (field) {
    case 'escape-time':
      return 'cycled'
    case 'distance-estimate':
      return 'clamped'
  }
}
