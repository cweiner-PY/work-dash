// actions/merge.js
import { run as defaultRun } from '../util/run.js'
import { mergeGateFor } from '../lanes.js'

export async function mergePr({ item, prNumber, confirmed = false }, { run = defaultRun, dry = false } = {}) {
  const pr = item.prs.find((p) => p.number === Number(prNumber))
  if (!pr) return { ok: false, message: `No PR #${prNumber} on this item.` }

  // STRICT identity check, not truthiness. `confirmed: "false"`, `"no"`, `1`, `{}` are
  // all truthy in JS, and this action is irreversible and public — the one place in this
  // codebase where a permissive coercion could land code in master by accident.
  if (confirmed !== true) {
    return { ok: false, message: `Confirm the squash merge of #${pr.number} "${pr.title}" first.`, needsConfirm: true }
  }

  // Never merge a PR that is not the user's own. Review-requested PRs appear on this board
  // so they can be reviewed, not merged on someone else's behalf. The UI only offers the
  // button for the user's own PRs, but the UI is a convenience and this is the authority.
  if (pr.isMine === false) {
    return { ok: false, message: `#${pr.number} was authored by someone else — merge it from GitHub, not here.` }
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
