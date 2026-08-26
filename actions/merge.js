// actions/merge.js
import { run as defaultRun } from '../util/run.js'
import { mergeGateFor } from '../lanes.js'

export async function mergePr({ item, prNumber, confirmed = false }, { run = defaultRun, dry = false } = {}) {
  const pr = item.prs.find((p) => p.number === Number(prNumber))
  if (!pr) return { ok: false, message: `No PR #${prNumber} on this item.` }

  if (!confirmed) {
    return { ok: false, message: `Confirm the squash merge of #${pr.number} "${pr.title}" first.`, needsConfirm: true }
  }

  // The UI's disabled button is a convenience. This is the authority.
  const gate = mergeGateFor(pr)
  if (!gate.allowed) {
    return { ok: false, message: `Cannot merge #${pr.number}: ${gate.blockers.join('; ')}` }
  }

  const args = ['pr', 'merge', String(pr.number), '--repo', pr.repo, '--squash']
  if (dry) return { ok: true, message: `dry run — would merge #${pr.number}`, detail: `gh ${args.join(' ')}` }

  const r = await run('gh', args)
  if (r.code !== 0) {
    return { ok: false, message: `gh pr merge failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}` }
  }
  return { ok: true, message: `Squash-merged #${pr.number}`, detail: r.stdout.trim() }
}
