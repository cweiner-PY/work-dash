// lanes.js — PURE. No fs, no child_process, no clock.

export function mergeGateFor(pr) {
  if (!pr) return { allowed: false, blockers: ['no PR'] }
  const blockers = []
  if (pr.reviewDecision !== 'APPROVED') blockers.push(`not approved (${pr.reviewDecision ?? 'no review'})`)
  if (pr.mergeable !== 'MERGEABLE') blockers.push(`not mergeable (${pr.mergeable})`)
  if (pr.isDraft) blockers.push('draft')
  // known:true means we actually read the required-check list. known:false — or the
  // field being absent entirely — means the read never succeeded, so the gate refuses
  // rather than mistaking silence for a clean bill of health.
  if (pr.requiredChecks?.known !== true) blockers.push('required check status unknown (could not read checks)')
  // An empty required-check list, once known, passes vacuously — some repos configure none.
  const failing = pr.requiredChecks?.failing ?? []
  if (failing.length) blockers.push(`required check failing: ${failing.join(', ')}`)
  // Pending/queued checks are neither a failure nor a green light — the gate still
  // blocks, but for a distinct, non-alarming reason: CI hasn't finished yet.
  const pending = pr.requiredChecks?.pending ?? []
  if (pending.length) blockers.push(`${pending.length} required check(s) still running`)
  return { allowed: blockers.length === 0, blockers }
}

// It never checked open/closed — there is no such field — only whose PR it is. Shared by
// lanes.js, actions/merge.js, board.js's skillsForItem, actions/slot.js's branchFor, and
// actions/open.js: an item can carry a colleague's review-requested PR alongside (or
// instead of) the user's own, and every consumer of "the item's PR" must agree on which
// one that is.
export const isMinePr = (pr) => pr?.isMine !== false

// The user's own PR on this item, or null if the item carries none (e.g. only a
// colleague's review request). Never falls back to `prs[0]` — that would silently treat
// a review-requested PR as if it belonged to the user.
export const myPrOf = (item) => (item?.prs ?? []).find(isMinePr) ?? null

export function assignLanes(items, config) {
  const order = config.inFlightStatusOrder ?? []
  return items.map((item) => {
    const reasons = []
    const myPrs = item.prs.filter(isMinePr)
    const reviewPrs = item.prs.filter((p) => p.isMine === false)
    const pr = myPrs[0]
    const gate = mergeGateFor(pr)

    // --- signals ---
    const foreign = Boolean(item.jira && item.jira.isMine === false)
    const stale = Boolean(item.jira && item.jira.statusCategory === 'Done')
    const reclaimable = Boolean(item.slot && (foreign || stale) && myPrs.length === 0)
    if (foreign) reasons.push(`assigned to ${item.jira.assignee}`)
    if (stale) reasons.push('ticket is Done')
    if (reclaimable) reasons.push('slot reclaimable')

    // --- slot facts ---
    if (item.slot?.dirty) reasons.push(`uncommitted changes (${item.slot.dirtyCount ?? '?'} files)`)
    if (item.slot?.behind > 0) reasons.push(`${item.slot.behind} behind master`)

    // --- lane 1: needs you ---
    // Collect EVERY applicable reason, not just the first: a single item can be
    // both "ticket Done but PR open" and "required check failing".
    let lane = null
    const failing = pr?.requiredChecks?.failing ?? []
    const needs = []
    if (reviewPrs.length) needs.push(`review requested of you (#${reviewPrs[0].number})`)
    if (pr && stale) needs.push(`ticket is Done but PR #${pr.number} is still open`)
    if (failing.length) needs.push(`required check failing: ${failing.join(', ')}`)
    if (pr?.reviewDecision === 'CHANGES_REQUESTED') needs.push('changes requested')
    if (pr && pr.mergeable === 'CONFLICTING') needs.push('conflicts with master')
    if (gate.allowed) needs.push('approved and mergeable — merge it')
    if (needs.length) {
      lane = 'needs-you'
      reasons.push(...needs)
    }

    // --- lane 2: waiting on others ---
    if (!lane && pr && !pr.isDraft && pr.reviewDecision === 'REVIEW_REQUIRED' && failing.length === 0) {
      lane = 'waiting'
      reasons.push(`awaiting review on #${pr.number}`)
    }

    // --- lane 3: in flight ---
    if (!lane && (item.slot || pr?.isDraft)) lane = 'in-flight'

    // --- lane 4: ready to start ---
    if (!lane && item.jira?.statusCategory === 'To Do' && item.plans.length > 0) {
      lane = 'ready-to-start'
      reasons.push(`${item.plans.length} plan folder${item.plans.length > 1 ? 's' : ''} on disk`)
    }

    // --- lane 5: backlog ---
    lane ??= 'backlog'

    const statusGroup = item.jira?.status ?? 'no ticket'
    const idx = order.indexOf(statusGroup)

    return { ...item, lane, reasons, signals: { foreign, stale, reclaimable }, mergeGate: gate,
             statusGroup, sortIndex: idx === -1 ? Infinity : idx }
  })
}
