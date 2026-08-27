// actions/slot.js
import { myPrOf } from '../lanes.js'
import { checkoutMode, planWorktree } from './worktree.js'

export function branchFor(item) {
  // Only the user's own PR names a branch to check out — a colleague's review-requested
  // PR must never redirect this item's checkout to their branch. Falls back to the
  // slot's own branch, which is how a review-request-only item still resolves correctly.
  return myPrOf(item)?.headRefName ?? item.slot?.branch ?? null
}

// Same fail-closed dirty check and claim check as the branch-known path below — factored
// out so the branchless path (no target branch, so no master/main/stale distinction
// applies) and the branch-known path share exactly one definition of "safe to touch".
function eligibility(s, { claimedDirs }) {
  if (s.dirty !== false || (s.dirtyCount ?? 0) > 0) {
    return { eligible: false, why: `${s.dirtyCount ?? 'unknown'} uncommitted change(s)` }
  }
  if (claimedDirs.has(s.dir)) {
    // A launch happens asynchronously in a Terminal window the server never waits on,
    // so re-polling the board cannot observe the new checkout for seconds. Without this,
    // two concurrent opens resolve deterministically to the SAME slot — rank() prefers
    // master/main every time, not occasionally — and two sessions fight over one checkout.
    return { eligible: false, why: 'recently claimed by another launch' }
  }
  return null
}

export function resolveSlot(
  item, slots, config,
  { staleBranches = new Set(), claimedDirs = new Set(), repo = null, branch: branchOverride = null } = {}
) {
  // Jira carries nothing identifying the repo — a To Do ticket's title mentioning
  // "Logan" is prose, not data. item.repo (known from a PR or an existing slot) always
  // wins; a caller-supplied repo is only consulted when the item itself doesn't know.
  const effectiveRepo = item.repo ?? repo
  if (!effectiveRepo) {
    return {
      needsPicker: true, needsRepo: true, candidates: [],
      message: 'This ticket has no known repository yet — which one is it in?',
    }
  }

  // branchFor deliberately ignores a colleague's review-requested PR, so reviewing one
  // requires saying which branch out loud. Nothing else passes an override.
  const branch = branchOverride ?? branchFor(item)

  // Worktree mode resolves a path instead of competing for a pool. Nothing to rank and no
  // claim check: the path is derived from the branch, so two different items can never
  // collide, and two launches on the SAME item should reuse one worktree rather than have
  // the second refused as "recently claimed".
  if (checkoutMode(config) === 'worktrees') {
    return planWorktree(item, slots, config, { repo: effectiveRepo, branch })
  }

  const pool = (config.repos[effectiveRepo]?.slots ?? [])
  const mine = slots.filter((s) => pool.includes(s.dir))

  if (!branch) {
    // A To Do ticket has no branch by definition — /ticket-planner and similar skills
    // exist to run BEFORE branching, so this resolves a clean working directory only.
    // No checkout is emitted (buildLauncher already guards its checkout line on branch
    // being truthy). Busy-with-another-branch is not disqualifying here — nothing is
    // being taken over, only borrowed for research — but dirty and claimed still are.
    const candidates = mine.map((s) => {
      const blocked = eligibility(s, { claimedDirs })
      return {
        dir: s.dir, branch: s.branch, dirty: s.dirty, dirtyCount: s.dirtyCount,
        eligible: !blocked, why: blocked?.why ?? 'free', slot: s,
      }
    })
    const free = candidates.filter((c) => c.eligible)
    if (free.length) return { slot: free[0].slot, alreadyOnBranch: false }
    return {
      needsPicker: true,
      candidates: candidates.map(({ slot, ...c }) => c),
      message: 'No free checkout — pick a slot to use.',
    }
  }

  const already = mine.find((s) => s.branch === branch)
  if (already) return { slot: already, alreadyOnBranch: true }

  const candidates = mine.map((s) => {
    const blocked = eligibility(s, { claimedDirs })
    let eligible = !blocked
    let why = blocked?.why ?? 'free'
    if (!blocked) {
      if (s.branch === 'master' || s.branch === 'main') why = `on ${s.branch}`
      else if (staleBranches.has(s.branch)) why = 'holding a finished or reassigned ticket'
      // A DETACHED checkout is what a finished review leaves behind (see actions/review.js).
      // Without this it read as "busy with null" and was never eligible again, so every
      // review permanently consumed a slot and the pool drained one review at a time.
      // Reclaimable because a detached HEAD holds no branch — but ranked last among the
      // eligible, so anything genuinely idle is taken first.
      else if (s.branch === null) why = 'detached (a finished review)'
      else { eligible = false; why = `busy with ${s.branch}` }
    }
    return { dir: s.dir, branch: s.branch, dirty: s.dirty, dirtyCount: s.dirtyCount, eligible, why, slot: s }
  })

  // Prefer master/main, then a stale branch, then a detached review checkout last: of the
  // three it is the only one whose commits, if any were made, are not on a branch at all.
  const rank = (c) => {
    if (c.branch === 'master' || c.branch === 'main') return 0
    if (c.branch === null) return 2
    return 1
  }
  const free = candidates.filter((c) => c.eligible).sort((a, b) => rank(a) - rank(b))
  if (free.length) return { slot: free[0].slot, alreadyOnBranch: false }

  return {
    needsPicker: true,
    candidates: candidates.map(({ slot, ...c }) => c),
    message: 'No free checkout — pick a slot to use.',
  }
}
