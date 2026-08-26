// actions/update-branch.js
import { run as defaultRun } from '../util/run.js'

export async function updateBranch({ item, slots, chosenSlotDir = null }, { run = defaultRun, dry = false } = {}) {
  const slot = chosenSlotDir ? slots.find((s) => s.dir === chosenSlotDir) : item.slot
  if (!slot) return { ok: false, message: 'This item has no checkout to update.' }

  // Refuse before touching git at all.
  if (slot.dirty) {
    return { ok: false, message: `${slot.dir} has ${slot.dirtyCount} uncommitted change(s) — commit or stash first.` }
  }
  if (dry) {
    return { ok: true, message: `dry run — would update ${slot.dir}`,
             detail: `cd ${slot.dir}\ngit fetch origin\ngit merge origin/master` }
  }

  const fetched = await run('git', ['fetch', 'origin'], { cwd: slot.dir })
  if (fetched.code !== 0) {
    return { ok: false, message: `git fetch failed: ${fetched.stderr.trim() || fetched.stdout.trim()}` }
  }

  const merged = await run('git', ['merge', 'origin/master'], { cwd: slot.dir })
  const output = `${merged.stdout}\n${merged.stderr}`.trim()
  if (merged.code !== 0) {
    // Leave the repo exactly as git left it so the user can resolve by hand.
    const conflict = /conflict/i.test(output)
    return {
      ok: false,
      message: conflict
        ? `Merge conflict in ${slot.dir.split('/').pop()} — resolve it in a terminal.`
        : `git merge failed: ${output.slice(0, 300)}`,
      detail: output,
    }
  }
  return { ok: true, message: `Merged origin/master into ${slot.branch}`, detail: output }
}
