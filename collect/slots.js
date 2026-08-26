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
    for (const dir of cfg.slots ?? []) {
      try {
        const branch = (await git(run, dir, ['branch', '--show-current'])).trim() || null
        const porcelain = await git(run, dir, ['status', '--porcelain'])
        const dirtyCount = porcelain.split('\n').filter((l) => l.trim() !== '').length
        const counts = await git(run, dir, ['rev-list', '--left-right', '--count', 'origin/master...HEAD'])
        const [behind, ahead] = counts.trim().split(/\s+/).map((n) => Number(n) || 0)
        slots.push({ dir, repo, branch, dirty: dirtyCount > 0, dirtyCount, behind, ahead })
      } catch (e) {
        errors.push(e.message)
      }
    }
  }
  return { slots, errors }
}
