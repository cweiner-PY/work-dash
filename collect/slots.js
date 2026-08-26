// collect/slots.js
import { run as defaultRun } from '../util/run.js'

async function git(run, dir, args) {
  const r = await run('git', args, { cwd: dir })
  if (r.code !== 0) throw new Error(`git ${args[0]} failed in ${dir}: ${r.stderr.trim() || r.code}`)
  return r.stdout
}

export async function collectSlots(config, { run = defaultRun } = {}) {
  const slots = []
  const errors = []

  for (const [repo, cfg] of Object.entries(config.repos)) {
    const base = `origin/${cfg.defaultBranch ?? 'master'}`
    for (const dir of cfg.slots ?? []) {
      try {
        const branch = (await git(run, dir, ['branch', '--show-current'])).trim() || null
        const porcelain = await git(run, dir, ['status', '--porcelain'])
        const dirtyCount = porcelain.split('\n').filter((l) => l.trim() !== '').length

        // Ahead/behind is the LEAST important field here and the most likely to fail
        // (a repo whose default branch is not `master`, a missing remote ref). It gets
        // its own guard so its failure cannot take the slot down with it: `dirty` is
        // safety information — it is how the user learns a checkout holds uncommitted
        // work — and it must survive an unrelated git command failing.
        let behind = null
        let ahead = null
        try {
          const counts = await git(run, dir, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
          const parts = counts.trim().split(/\s+/)
          if (parts.length >= 2) {
            behind = Number(parts[0]) || 0
            ahead = Number(parts[1]) || 0
          }
        } catch (e) {
          errors.push(e.message)
        }

        slots.push({ dir, repo, branch, dirty: dirtyCount > 0, dirtyCount, behind, ahead })
      } catch (e) {
        errors.push(e.message)
      }
    }
  }
  return { slots, errors }
}
