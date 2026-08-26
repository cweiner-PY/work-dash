// actions/update-branch.js
import { run as defaultRun } from '../util/run.js'

export async function updateBranch(
  { item, slots, chosenSlotDir = null, defaultBranch = 'master' },
  { run = defaultRun, dry = false } = {}
) {
  const slot = chosenSlotDir ? slots.find((s) => s.dir === chosenSlotDir) : item.slot
  if (!slot) return { ok: false, message: 'This item has no checkout to update.' }

  // A caller-supplied slotDir is resolved against the whole board, so confirm the slot
  // actually belongs to this item's repository. Otherwise a raw API call could merge one
  // repo's default branch into a checkout of a different repo.
  if (item.repo && slot.repo && slot.repo !== item.repo) {
    return { ok: false, message: `${slot.dir} belongs to ${slot.repo}, not ${item.repo}.` }
  }
  // Same base collect/slots.js measures "N behind" against — see the interface note.
  const base = `origin/${defaultBranch}`

  // Refuse before touching git at all. Fail CLOSED on ambiguous state: treat a missing or
  // non-boolean `dirty` as dirty rather than clean. This module is the last line of defence
  // before mutating a directory that may hold the user's only copy of uncommitted work, so
  // it must not depend on an upstream invariant holding forever.
  if (slot.dirty !== false || (slot.dirtyCount ?? 0) > 0) {
    return { ok: false, message: `${slot.dir} has ${slot.dirtyCount} uncommitted change(s) — commit or stash first.` }
  }
  if (dry) {
    return { ok: true, message: `dry run — would update ${slot.dir}`,
             detail: `cd ${slot.dir}\ngit fetch origin\ngit merge ${base}` }
  }

  const fetched = await run('git', ['fetch', 'origin'], { cwd: slot.dir })
  if (fetched.code !== 0) {
    return { ok: false, message: `git fetch failed: ${fetched.stderr.trim() || fetched.stdout.trim()}` }
  }

  const merged = await run('git', ['merge', base], { cwd: slot.dir })
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
  return { ok: true, message: `Merged ${base} into ${slot.branch}`, detail: output }
}
