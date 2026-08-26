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

// If every Jira issue in this item set has a null active sprint, that is almost
// certainly a misconfigured jiraSprintField for this Jira instance — not "nothing is
// sprint-committed". Exported so the decision is directly testable without needing to
// intercept console.warn or re-derive it from assignLanes's output.
export function needsSprintFallback(items) {
  const jiraItems = items.filter((i) => i.jira)
  return jiraItems.length > 0 && jiraItems.every((i) => i.jira.activeSprint == null)
}

export function assignLanes(items, config) {
  const order = config.inFlightStatusOrder ?? []

  // Do not silently degrade: a lane that quietly goes empty because a field name is
  // wrong for this instance is exactly the failure class this project keeps getting
  // bitten by. Warn once, by name, and keep ready-to-start alive via the old
  // plan-folder-on-disk heuristic instead of going dark.
  const fallbackToPlans = needsSprintFallback(items)
  if (fallbackToPlans) {
    const field = config.jiraSprintField ?? 'customfield_10020'
    console.warn(
      `work-dash: every Jira issue has a null active sprint (field "${field}"). This usually ` +
      `means jiraSprintField is misconfigured for this Jira instance, not that nothing is ` +
      `sprint-committed. Falling back to the plan-folder heuristic for ready-to-start.`
    )
  }

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
    // both "ticket Done but PR open" and "required check failing". The reason
    // TEXT and the lane-PROMOTION decision are kept separate: a draft is by
    // definition not ready for review, so its failing checks and its conflicts
    // with master are the expected state of work in progress, not something
    // actionable — they still explain the card via `reasons`, they just don't
    // pull the item into needs-you.
    let lane = null
    const failing = pr?.requiredChecks?.failing ?? []
    const needs = []
    let promote = false
    if (reviewPrs.length) { needs.push(`review requested of you (#${reviewPrs[0].number})`); promote = true }
    if (pr && stale) { needs.push(`ticket is Done but PR #${pr.number} is still open`); promote = true }
    if (failing.length) {
      needs.push(`required check failing: ${failing.join(', ')}`)
      if (!pr.isDraft) promote = true
    }
    if (pr?.reviewDecision === 'CHANGES_REQUESTED') { needs.push('changes requested'); promote = true }
    if (pr && pr.mergeable === 'CONFLICTING') {
      needs.push('conflicts with master')
      if (!pr.isDraft) promote = true
    }
    if (gate.allowed) { needs.push('approved and mergeable — merge it'); promote = true }
    if (needs.length) reasons.push(...needs)
    if (promote) lane = 'needs-you'

    // --- lane 2: waiting on others ---
    if (!lane && pr && !pr.isDraft && pr.reviewDecision === 'REVIEW_REQUIRED' && failing.length === 0) {
      lane = 'waiting'
      reasons.push(`awaiting review on #${pr.number}`)
    }

    // --- lane 3: in flight ---
    // A ticket already In Progress (by Jira's own statusCategory, which covers every
    // literal status in inFlightStatusOrder — In Progress, In Code Review, Ready To
    // Test, etc.) belongs here even with no branch checked out yet: moving a ticket to
    // In Progress must not make it LESS visible by dropping it all the way to backlog.
    if (!lane && (item.slot || pr?.isDraft || item.jira?.statusCategory === 'In Progress')) lane = 'in-flight'

    // --- lane 4: ready to start ---
    // Sprint-committed To Do work is what actually belongs here — the literal status
    // string (TO DO vs READY) doesn't matter, only the category plus active-sprint
    // membership. When the sprint field looks misconfigured (see needsSprintFallback),
    // fall back to the old plan-folder-on-disk heuristic so the lane isn't silently dead.
    const sprintCommitted = fallbackToPlans ? item.plans.length > 0 : Boolean(item.jira?.activeSprint)
    if (!lane && item.jira?.statusCategory === 'To Do' && sprintCommitted) {
      lane = 'ready-to-start'
      reasons.push(fallbackToPlans
        ? `${item.plans.length} plan folder${item.plans.length > 1 ? 's' : ''} on disk`
        : `sprint-committed: ${item.jira.activeSprint}`)
    }

    // --- lane 5: backlog ---
    lane ??= 'backlog'

    const statusGroup = item.jira?.status ?? 'no ticket'
    const idx = order.indexOf(statusGroup)

    return { ...item, lane, reasons, signals: { foreign, stale, reclaimable }, mergeGate: gate,
             statusGroup, sortIndex: idx === -1 ? Infinity : idx }
  })
}
