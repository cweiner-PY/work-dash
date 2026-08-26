// collect/plans.js
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { extractKey } from '../util/key.js'

export async function collectPlans(config, _opts = {}) {
  const plans = []
  const errors = []
  const subdirs = [...new Set(Object.values(config.repos).map((r) => r.docsSubdir).filter(Boolean))]

  for (const sub of subdirs) {
    const base = join(config.docsDir, sub)
    let entries
    try {
      entries = await readdir(base, { withFileTypes: true })
    } catch (e) {
      if (e.code !== 'ENOENT') errors.push(`could not read ${base}: ${e.message}`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      let files = []
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
      } catch (e) {
        errors.push(`could not read ${dir}: ${e.message}`)
        continue
      }
      plans.push({ dir, folder: entry.name, docsSubdir: sub, key: extractKey(entry.name), files })
    }
  }
  return { plans, errors }
}
