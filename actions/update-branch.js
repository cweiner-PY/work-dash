// actions/update-branch.js
import { run as defaultRun } from '../util/run.js'
import { myPrOfBranch } from './slot.js'

// `branch` is ONE resolved branch of the item — the caller decides which (see resolveBranch).
// It used to be `myPrOf(item)` and the scalar `item.slot`, which on a ticket with two branches
// meant the button read its label off one branch's behind-count and then ran `gh pr
// update-branch` against a different branch's PR. The local pull then looked for a checkout on
// THAT PR's head, failed to find the one sitting right there, and reported "not checked out
// locally" — so the branch the user was actually working in never got updated at all.
export async function updateBranch(
  { item, branch = null, slots, chosenSlotDir = null, defaultBranch = 'master' },
  { run = defaultRun, dry = false } = {}
) {
  // The branch's own PR, if any (never a colleague's review request — see lanes.js). Its
  // presence changes the whole strategy: with a PR, GitHub's own comparison of the branch
  // against its base is the source of truth for "behind", since collect/slots.js never
  // fetches and the local ahead/behind count can be days stale. Without one, there is
  // nothing for GitHub to compare against, so a local branch behind master falls back to
  // the old local-only path.
  const pr = myPrOfBranch(branch)
  if (!pr) return localOnlyUpdate({ item, branch, slots, chosenSlotDir, defaultBranch }, { run, dry })
  return remoteUpdate({ item, branch, pr, slots, chosenSlotDir, defaultBranch }, { run, dry })
}

// --- No PR of the user's: today's local-only behaviour, unchanged. A local branch with
// no PR can still be behind, and this path is already reviewed and correct. ---
async function localOnlyUpdate({ item, branch, slots, chosenSlotDir, defaultBranch }, { run, dry }) {
  const slot = chosenSlotDir ? slots.find((s) => s.dir === chosenSlotDir) : branch?.slot
  if (!slot) return { ok: false, message: 'This item has no checkout to update.' }

  // A DETACHED checkout — what a finished review leaves behind — is on a commit, not on a
  // branch. Merging into it would put the merge commit on no branch at all, where it is
  // reachable only by sha and is lost the moment the checkout moves. Refuse instead.
  if (!chosenSlotDir && branch?.detached) {
    return { ok: false, message: `${slot.dir.split('/').pop()} is detached — check a branch out before updating it.` }
  }

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
function findLocalCandidate({ item, branch, slots, chosenSlotDir }) {
  if (chosenSlotDir) {
    const found = slots.find((s) => s.dir === chosenSlotDir) ?? null
    if (found && item.repo && found.repo && found.repo !== item.repo) {
      return { error: `${found.dir} belongs to ${found.repo}, not ${item.repo}.` }
    }
    return { slot: found }
  }
  // The pairing join.js already made: THIS branch's own checkout. Searching the slot list for
  // one whose branch equalled the PR's head is what this used to do, and on a two-branch
  // ticket it hunted for the PR branch while the user's checkout held the other one.
  // A detached checkout is excluded — a fast-forward pull there would land on no branch.
  if (branch?.detached) return { slot: null }
  return { slot: branch?.slot ?? null }
}

// --- The user has an open PR: GitHub's branch comparison drives the decision, with
// mergeStateStatus consulted only for the conflict case it uniquely reports. ---
async function remoteUpdate({ item, branch, pr, slots, chosenSlotDir, defaultBranch }, { run, dry }) {
  const status = pr.mergeStateStatus ?? null
  // What the PR is actually measured against — which for a STACKED PR is the parent branch,
  // not the repo's default. baseCompare already compares against pr.baseRefName, so saying
  // "master" in these messages described a comparison that never happened.
  const base = pr.baseRefName ?? defaultBranch
  const found = findLocalCandidate({ item, branch, slots, chosenSlotDir })
  if (found.error) return { ok: false, message: found.error }
  const candidate = found.slot

  if (status === 'DIRTY' || pr.mergeable === 'CONFLICTING') {
    // Server-side cannot resolve conflicts — only the user, locally, can. Checked before
    // the behind count, since a conflicting branch is unmergeable however far behind.
    const where = candidate ? `checked out in ${candidate.dir.split('/').pop()}` : 'not checked out anywhere'
    return {
      ok: false,
      message: `#${pr.number} conflicts with ${base} and needs resolving locally (${where}).`,
    }
  }

  // The behind count, NOT mergeStateStatus. BLOCKED and UNSTABLE describe review and
  // check state; they say nothing about the branch's position relative to its base, and
  // they outrank BEHIND when both apply. Reading them as "up to date" is what made this
  // action refuse every PR in these repos — all of which were behind master at the time.
  const cmp = pr.baseCompare ?? { known: false, behind: null }
  if (cmp.known !== true) {
    // A BEHIND status still proves the branch is behind, so it is actionable even when
    // the comparison itself failed. Anything else fails closed rather than running
    // `gh pr update-branch` against a branch whose position is unknown.
    if (status !== 'BEHIND') {
      return {
        ok: false,
        message: `#${pr.number}'s position relative to ${base} isn't known yet — try again after the next refresh.`,
      }
    }
  } else if (cmp.behind === 0) {
    return { ok: false, message: `#${pr.number} is already up to date with ${base} — nothing to do.` }
  }

  // Behind confirmed. The remote update proceeds regardless of local checkout state;
  // the local pull is an opportunistic second step that never blocks the first.
  const canPullLocally = candidate && !isSlotDirty(candidate)
  if (dry) {
    const lines = [`gh pr update-branch ${pr.number} --repo ${pr.repo}`]
    if (canPullLocally) lines.push(`cd ${candidate.dir}`, 'git pull --ff-only')
    return {
      ok: true,
      message: `dry run — would update #${pr.number} from ${base}`,
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
      message: `Updated #${pr.number} from ${base} (not checked out locally)`,
      detail: updated.stdout.trim(),
    }
  }
  if (isSlotDirty(candidate)) {
    return {
      ok: true,
      message: `Updated #${pr.number} from ${base} (${candidate.dir.split('/').pop()} has uncommitted changes — pull manually)`,
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
      message: `Updated #${pr.number} from ${base}; local pull in ${candidate.dir.split('/').pop()} did not fast-forward — resolve by hand.`,
      detail: pullOutput,
    }
  }
  return {
    ok: true,
    message: `Updated #${pr.number} from ${base}; pulled into ${candidate.dir.split('/').pop()}`,
    detail: pullOutput,
  }
}
