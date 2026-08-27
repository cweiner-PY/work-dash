// actions/slot.js
import { isMinePr } from '../lanes.js'
import { checkoutMode, planWorktree } from './worktree.js'

// WHICH BRANCH an action is aimed at. There is no "the item's branch" any more — a ticket can
// carry several — so either the caller names one, or the item has exactly one branch and that
// is unambiguously what was meant.
//
// Fails CLOSED on ambiguity: with more than one branch and no name supplied it hands back the
// choices instead of picking. Picking is precisely what went wrong before — `update branch`
// read its label off one branch's behind-count and then ran against a different branch's PR,
// and neither the label nor the result said which.
export function resolveBranch(item, name = null) {
  const branches = item?.branches ?? []
  if (name != null) {
    const found = branches.find((b) => b.name === name)
    if (!found) return { error: `${item?.key ?? item?.id} has no branch ${name}.` }
    return { branch: found }
  }
  if (branches.length === 1) return { branch: branches[0] }
  // join.js guarantees at least one entry, so this is a belt-and-braces refusal rather than
  // a reachable path — but an item arriving from anywhere else must not silently act on
  // nothing.
  if (branches.length === 0) return { error: `${item?.key ?? item?.id} has no branches at all.` }
  return {
    needsBranch: true,
    branches: branches.map((b) => ({ name: b.name, pr: b.pr?.number ?? null, slot: b.slot?.dir ?? null })),
    message: `${item?.key ?? item?.id} has ${branches.length} branches — which one?`,
  }
}

// The branch a plain `open` should CHECK OUT for this branch entry: its own name, unless the
// entry exists only because a colleague asked for a review. A review-requested PR must never
// redirect `open` onto their branch — /api/review is the action for that, and it checks out
// detached so nothing done there can land on the author's branch.
//
// A checkout of our own sitting on that same name is different: the branch is local and real,
// so it is returned. `detached` excludes the checkout a finished review left behind, which is
// on the commit rather than on the branch.
export function checkoutBranchOf(branch) {
  if (!branch) return null
  const colleaguesPr = branch.pr && branch.pr.isMine === false
  const ownCheckout = branch.slot && !branch.detached
  if (colleaguesPr && !ownCheckout) return null
  return branch.name ?? null
}

// The branch entry's own PR, and only when it is the user's. Same rule isMinePr has always
// enforced item-wide, applied to one branch.
export const myPrOfBranch = (branch) => (branch?.pr && isMinePr(branch.pr) ? branch.pr : null)

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
  // `branch` is supplied by the caller, which has already resolved WHICH branch of the item
  // this is for (see resolveBranch and checkoutBranchOf). null means there is no branch to
  // check out — a To Do ticket, or an item that exists only because a colleague asked for a
  // review — and the branchless path below resolves a clean working directory instead.
  { staleBranches = new Set(), claimedDirs = new Set(), repo = null, branch = null } = {}
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
