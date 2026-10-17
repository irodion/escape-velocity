import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIELDS, FRACTAL_MODES, NORMALISATIONS, PALETTES } from './settings.js'

// The production markup, parsed once. Anchored on `process.cwd()` (vitest's
// root, i.e. `web/`) because under jsdom `import.meta.url` is not a file URL —
// the same approach as pwa-config.test.ts.
const doc = new DOMParser().parseFromString(
  readFileSync(resolve(process.cwd(), 'index.html'), 'utf8'),
  'text/html',
)

const optionValues = (selectName: string): string[] =>
  Array.from(doc.querySelectorAll<HTMLOptionElement>(`select[name="${selectName}"] option`)).map(
    (option) => option.value,
  )

// Each axis's names are written once, in settings.ts (#162); the `<option>`
// lists in index.html are the one copy the type system can't see. This guard
// fails if the two drift — a name added to an array but not the markup (it
// could never be picked), or an `<option>` with no array entry (`Controls`
// would cast an unknown string into a typed setting). Order is compared too,
// so the arrays stay the canonical display order.
describe('index.html <option> lists match the settings vocabulary', () => {
  it.each([
    ['palette', PALETTES],
    ['normalisation', NORMALISATIONS],
    ['mode', FRACTAL_MODES],
    ['field', FIELDS],
  ] as const)('<select name="%s">', (selectName, names) => {
    expect(optionValues(selectName)).toEqual([...names])
  })
})
