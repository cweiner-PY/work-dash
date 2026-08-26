// actions/slot.js
import { myPrOf } from '../lanes.js'

export function branchFor(item) {
  // Only the user's own PR names a branch to check out — a colleague's review-requested
  // PR must never redirect this item's checkout to their branch. Falls back to the
  // slot's own branch, which is how a review-request-only item still resolves correctly.
  return myPrOf(item)?.headRefName ?? item.slot?.branch ?? null
}

export function resolveSlot(item, slots, config, { staleBranches = new Set(), claimedDirs = new Set() } = {}) {
  const branch = branchFor(item)
  if (!item.repo || !branch) {
    return { needsPicker: true, candidates: [], message: 'No branch is known for this item — nothing to check out.' }
  }
  const pool = (config.repos[item.repo]?.slots ?? [])
  const mine = slots.filter((s) => pool.includes(s.dir))

  const already = mine.find((s) => s.branch === branch)
  if (already) return { slot: already, alreadyOnBranch: true }

  const candidates = mine.map((s) => {
    let eligible = true
    let why = 'free'
    // Fail CLOSED: anything other than an explicit `dirty: false` counts as dirty, and a
    // non-zero dirtyCount overrides a false flag. This is the AUTOMATIC selection path — it
    // picks a checkout without the user choosing one — so ambiguous safety data must never
    // read as "safe to clobber".
    if (s.dirty !== false || (s.dirtyCount ?? 0) > 0) {
      eligible = false
      why = `${s.dirtyCount ?? 'unknown'} uncommitted change(s)`
    }
    else if (claimedDirs.has(s.dir)) {
      // A launch happens asynchronously in a Terminal window the server never waits on,
      // so re-polling the board cannot observe the new checkout for seconds. Without this,
      // two concurrent opens resolve deterministically to the SAME slot — rank() prefers
      // master/main every time, not occasionally — and two sessions fight over one checkout.
      eligible = false
      why = 'recently claimed by another launch'
    }
    else if (s.branch === 'master' || s.branch === 'main') why = `on ${s.branch}`
    else if (staleBranches.has(s.branch)) why = 'holding a finished or reassigned ticket'
    else { eligible = false; why = `busy with ${s.branch}` }
    return { dir: s.dir, branch: s.branch, dirty: s.dirty, dirtyCount: s.dirtyCount, eligible, why, slot: s }
  })

  // Prefer master/main, then stale, then anything else eligible.
  const rank = (c) => (c.branch === 'master' || c.branch === 'main' ? 0 : 1)
  const free = candidates.filter((c) => c.eligible).sort((a, b) => rank(a) - rank(b))
  if (free.length) return { slot: free[0].slot, alreadyOnBranch: false }

  return {
    needsPicker: true,
    candidates: candidates.map(({ slot, ...c }) => c),
    message: 'No free checkout — pick a slot to use.',
  }
}
