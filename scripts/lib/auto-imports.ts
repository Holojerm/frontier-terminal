// The auto-import lists Nuxt writes into .nuxt/ (postinstall's `nuxt prepare`, dev and build),
// read back so tools outside Nuxt see the names Nitro and the app see: vitest.config.ts injects
// them into tests and the code under test, and globals:check follows calls into them.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** One auto-imported value, in unimport's `Import` shape. */
export interface AutoImport {
  name: string
  as: string
  /** A package specifier, or an absolute path without extension. */
  from: string
}

const LISTS = {
  server: '.nuxt/types/nitro-imports.d.ts',
  app: '.nuxt/imports.d.ts',
} as const

export function generatedImports(root: string, side: keyof typeof LISTS): AutoImport[] {
  const file = join(root, LISTS[side])
  if (!existsSync(file)) {
    throw new Error(`${LISTS[side]} is missing: run \`bunx nuxt prepare\` first`)
  }
  const out: AutoImport[] = []
  const lines = readFileSync(file, 'utf8').matchAll(/^export \{ ([^}]*) \} from '([^']+)';?$/gm)
  for (const [, names, spec] of lines) {
    const from = spec!.startsWith('.') ? resolve(dirname(file), spec!) : spec!
    for (const part of names!.split(',')) {
      const [name, as = name] = part.trim().split(/\s+as\s+/)
      if (name) out.push({ name, as: as!, from })
    }
  }
  return out
}
