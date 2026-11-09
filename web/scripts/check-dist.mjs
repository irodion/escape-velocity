// Fail the build if the built JavaScript references a hashed file that isn't
// in dist/assets.
//
// Vite can delete a chunk that is still referenced: with the main bundle
// importing the WASM glue only for its enums, it treated the glue's reference
// to the rayon pool's helper worker as dead and removed that chunk, though the
// render worker needed it (#189). The build passed, and the deployed renderer
// would never have started. `pnpm build` (and so `pnpm deploy`) runs this, so
// a build like that fails here instead, whatever caused it.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = new URL('../dist/', import.meta.url).pathname
const assets = new Set(readdirSync(join(dist, 'assets')))

// Vite's hashed output names: `name-<8 hash chars>.js` or `.wasm`.
const HASHED = /[\w.-]+-[\w-]{8}\.(?:js|wasm)\b/g

const missing = new Map()
const scripts = readdirSync(dist, { recursive: true })
  .filter((file) => String(file).endsWith('.js'))
  .map(String)
for (const file of scripts) {
  const code = readFileSync(join(dist, file), 'utf8')
  for (const name of new Set(code.match(HASHED) ?? [])) {
    if (!assets.has(name)) missing.set(name, [...(missing.get(name) ?? []), file])
  }
}

if (missing.size > 0) {
  console.error('check-dist: the build references files that are not in dist/assets:')
  for (const [name, files] of missing)
    console.error(`  ${name} (referenced by ${files.join(', ')})`)
  process.exit(1)
}
console.log(`check-dist: all hashed files referenced by ${scripts.length} scripts are present.`)
