// Fail the build if the built JavaScript references a hashed file that isn't
// in dist/.
//
// Vite can delete a chunk that is still referenced: with the main bundle
// importing the WASM glue only for its enums, it treated the glue's reference
// to the rayon pool's helper worker as dead and removed that chunk, though the
// render worker needed it (#189). The build passed, and the deployed renderer
// would never have started. `pnpm build` (and so `pnpm deploy`) runs this, so
// a build like that fails here instead, whatever caused it.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not `.pathname`: that keeps `%20` for a space and gives
// `/C:/...` on Windows.
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const files = readdirSync(dist, { recursive: true }).map(String)
// Looked up by name anywhere in dist/: Vite's chunks land in dist/assets, but
// files copied from public/ keep their own folders.
const present = new Set(files.map((file) => basename(file)))

// Vite's hashed output names: `name-<8 hash chars>.js` or `.wasm`.
const HASHED = /[\w.-]+-[\w-]{8}\.(?:js|wasm)\b/g

const missing = new Map()
const scripts = files.filter((file) => file.endsWith('.js'))
for (const file of scripts) {
  const code = readFileSync(join(dist, file), 'utf8')
  for (const name of new Set(code.match(HASHED) ?? [])) {
    if (!present.has(name)) missing.set(name, [...(missing.get(name) ?? []), file])
  }
}

if (missing.size > 0) {
  console.error('check-dist: the build references files that are not in dist/:')
  for (const [name, files] of missing)
    console.error(`  ${name} (referenced by ${files.join(', ')})`)
  process.exit(1)
}
console.log(`check-dist: all hashed files referenced by ${scripts.length} scripts are present.`)
