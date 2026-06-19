import { describe, expect, it } from 'vitest'
import { defaultModeForField, isModeValidForField } from './field-modes.js'
import type { FieldName, NormalisationName } from './settings.js'

const FIELDS: FieldName[] = ['escape-time', 'distance-estimate']
const MODES: NormalisationName[] = [
  'cycled',
  'histogram',
  'linear',
  'sqrt',
  'logarithmic',
  'clamped',
]
const UNIVERSAL: NormalisationName[] = ['histogram', 'linear', 'sqrt', 'logarithmic']

describe('isModeValidForField', () => {
  it('Cycled is Escape-Time only', () => {
    expect(isModeValidForField('escape-time', 'cycled')).toBe(true)
    expect(isModeValidForField('distance-estimate', 'cycled')).toBe(false)
  })

  it('Clamped is Distance-Estimate only', () => {
    expect(isModeValidForField('distance-estimate', 'clamped')).toBe(true)
    expect(isModeValidForField('escape-time', 'clamped')).toBe(false)
  })

  it('Histogram / Linear / SquareRoot / Logarithmic apply to any Field', () => {
    for (const field of FIELDS) {
      for (const mode of UNIVERSAL) {
        expect(isModeValidForField(field, mode)).toBe(true)
      }
    }
  })

  it('each Field admits at least one valid mode', () => {
    for (const field of FIELDS) {
      expect(MODES.some((mode) => isModeValidForField(field, mode))).toBe(true)
    }
  })
})

describe('defaultModeForField', () => {
  it('Escape Time defaults to Cycled', () => {
    expect(defaultModeForField('escape-time')).toBe('cycled')
  })

  it('Distance Estimate defaults to Clamped', () => {
    expect(defaultModeForField('distance-estimate')).toBe('clamped')
  })

  it("each Field's default is itself valid for that Field", () => {
    // The substitution invariant: switching to a Field and adopting its
    // default never lands on an invalid pair.
    for (const field of FIELDS) {
      expect(isModeValidForField(field, defaultModeForField(field))).toBe(true)
    }
  })
})
