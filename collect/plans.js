// collect/plans.js
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { extractKey } from '../util/key.js'

export async function collectPlans(config, _opts = {}) {
  const plans = []
  const errors = []

  // Tolerating ENOENT per subdirectory (below) is correct — a repo may legitimately
  // have no docs folder yet. Tolerating it for the docsDir ROOT is not: a missing or
  // misconfigured docsDir makes every plan checkbox vanish from every card AND makes
  // the ready-to-start lane silently unreachable (lanes.js requires plans.length > 0),
  // with nothing on screen to explain why. That must be a loud, named error instead.
  try {
    const st = await stat(config.docsDir)
    if (!st.isDirectory()) {
      errors.push(`docsDir is not a directory: ${config.docsDir}`)
      return { plans, errors }
    }
  } catch (e) {
    errors.push(`could not read docsDir ${config.docsDir}: ${e.message}`)
    return { plans, errors }
  }

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
