// actions/update-branch.js
import { run as defaultRun } from '../util/run.js'
import { myPrOf } from '../lanes.js'

export async function updateBranch(
  { item, slots, chosenSlotDir = null, defaultBranch = 'master' },
  { run = defaultRun, dry = false } = {}
) {
  // The user's own PR, if any (never a colleague's review request — see lanes.js). Its
  // presence changes the whole strategy: with a PR, GitHub's mergeStateStatus is the
  // source of truth for "behind", since collect/slots.js never fetches and the local
  // ahead/behind count can be days stale. Without one, there is nothing for GitHub to
  // compare against, so a local branch behind master falls back to the old local-only path.
  const pr = myPrOf(item)
  if (!pr) return localOnlyUpdate({ item, slots, chosenSlotDir, defaultBranch }, { run, dry })
  return remoteUpdate({ item, pr, slots, chosenSlotDir, defaultBranch }, { run, dry })
}

// --- No PR of the user's: today's local-only behaviour, unchanged. A local branch with
// no PR can still be behind, and this path is already reviewed and correct. ---
async function localOnlyUpdate({ item, slots, chosenSlotDir, defaultBranch }, { run, dry }) {
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

// A missing/non-boolean `dirty`, or a nonzero dirtyCount, counts as dirty. Same fail-closed
// rule as everywhere else that touches a checkout.
const isSlotDirty = (s) => s.dirty !== false || (s.dirtyCount ?? 0) > 0

// Find the slot to opportunistically pull into after a successful remote update: an
// explicit choice (cross-repo guarded, same as every other explicit slotDir in this
// codebase), or whichever slot already has this PR's branch checked out. Neither is
// required — the remote update is the primary action and proceeds without either.
function findLocalCandidate({ item, pr, slots, chosenSlotDir }) {
  if (chosenSlotDir) {
    const found = slots.find((s) => s.dir === chosenSlotDir) ?? null
    if (found && item.repo && found.repo && found.repo !== item.repo) {
      return { error: `${found.dir} belongs to ${found.repo}, not ${item.repo}.` }
    }
    return { slot: found }
  }
  const found = slots.find((s) => s.branch === pr.headRefName && (!item.repo || !s.repo || s.repo === item.repo))
  return { slot: found ?? null }
}

// --- The user has an open PR: GitHub's mergeStateStatus drives the whole decision. ---
async function remoteUpdate({ item, pr, slots, chosenSlotDir, defaultBranch }, { run, dry }) {
  const status = pr.mergeStateStatus ?? null
  const found = findLocalCandidate({ item, pr, slots, chosenSlotDir })
  if (found.error) return { ok: false, message: found.error }
  const candidate = found.slot

  if (status === 'DIRTY') {
    // Server-side cannot resolve conflicts — only the user, locally, can.
    const where = candidate ? `checked out in ${candidate.dir.split('/').pop()}` : 'not checked out anywhere'
    return {
      ok: false,
      message: `#${pr.number} conflicts with ${defaultBranch} and needs resolving locally (${where}).`,
    }
  }
  if (status === 'CLEAN' || status === 'BLOCKED' || status === 'UNSTABLE') {
    // Not behind: BLOCKED/UNSTABLE describe review or check state, not the branch's
    // relationship to the base branch, so there is nothing for this action to fix.
    return { ok: false, message: `#${pr.number} is already up to date with ${defaultBranch} — nothing to do.` }
  }
  if (status !== 'BEHIND') {
    // UNKNOWN, or the field absent entirely: GitHub computes this lazily and had not
    // finished as of the last collection.
    return { ok: false, message: `#${pr.number}'s merge state isn't known yet — try again after the next refresh.` }
  }

  // status === 'BEHIND'. The remote update proceeds regardless of local checkout state;
  // the local pull is an opportunistic second step that never blocks the first.
  const canPullLocally = candidate && !isSlotDirty(candidate)
  if (dry) {
    const lines = [`gh pr update-branch ${pr.number} --repo ${pr.repo}`]
    if (canPullLocally) lines.push(`cd ${candidate.dir}`, 'git pull --ff-only')
    return {
      ok: true,
      message: `dry run — would update #${pr.number} from ${defaultBranch}`,
      detail: lines.join('\n'),
    }
  }

  const updated = await run('gh', ['pr', 'update-branch', String(pr.number), '--repo', pr.repo])
  if (updated.code !== 0) {
    return { ok: false, message: `gh pr update-branch failed: ${(updated.stderr || updated.stdout).trim().slice(0, 300)}` }
  }

  if (!candidate) {
    return {
      ok: true,
      message: `Updated #${pr.number} from ${defaultBranch} (not checked out locally)`,
      detail: updated.stdout.trim(),
    }
  }
  if (isSlotDirty(candidate)) {
    return {
      ok: true,
      message: `Updated #${pr.number} from ${defaultBranch} (${candidate.dir.split('/').pop()} has uncommitted changes — pull manually)`,
      detail: updated.stdout.trim(),
    }
  }

  // The server already did the merge remotely, so locally only a fast-forward is
  // legitimate. Never fall back to a merge, never force, never reset.
  const pulled = await run('git', ['pull', '--ff-only'], { cwd: candidate.dir })
  const pullOutput = `${pulled.stdout}\n${pulled.stderr}`.trim()
  if (pulled.code !== 0) {
    return {
      ok: true,
      message: `Updated #${pr.number} from ${defaultBranch}; local pull in ${candidate.dir.split('/').pop()} did not fast-forward — resolve by hand.`,
      detail: pullOutput,
    }
  }
  return {
    ok: true,
    message: `Updated #${pr.number} from ${defaultBranch}; pulled into ${candidate.dir.split('/').pop()}`,
    detail: pullOutput,
  }
}
