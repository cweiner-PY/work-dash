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

// If the configured sprint field is ABSENT from every Jira issue's raw `fields` — not
// merely null-valued — that is almost certainly a misconfigured jiraSprintField for this
// Jira instance. Jira omits an unrecognized custom field entirely rather than returning
// it as null (verified against the live API), so presence is the only reliable
// discriminator: a field that IS present but empty just means "no active sprint right
// now, legitimately", which must never warn or silently switch ready-to-start back to
// the plan-folder heuristic. Exported so the decision is directly testable without
// needing to intercept console.warn or re-derive it from assignLanes's output.
export function needsSprintFallback(items) {
  const jiraItems = items.filter((i) => i.jira)
  return jiraItems.length > 0 && jiraItems.every((i) => !i.jira.sprintFieldPresent)
}

// True once you have pushed commits AFTER the newest changes-requested review. GitHub's
// reviewDecision stays CHANGES_REQUESTED until the reviewer comes back, so without this the
// board keeps an already-addressed PR in needs-you and nags you about someone else's turn.
// Self-correcting: a newer changes-requested review moves the timestamp and flips it back.
//
// Fails SAFE in the pessimistic direction — a missing or unparseable timestamp means "not
// addressed", so an unknown state keeps nagging rather than quietly telling you a real
// "changes requested" is somebody else's problem.
export function changesAddressed(pr) {
  if (pr?.reviewDecision !== 'CHANGES_REQUESTED') return false
  const reviewed = Date.parse(pr.changesRequestedAt ?? '')
  const pushed = Date.parse(pr.lastCommitAt ?? '')
  if (!Number.isFinite(reviewed) || !Number.isFinite(pushed)) return false
  return pushed > reviewed
}

// Lanes in order of who has to act, most urgent first. An item's lane is the most urgent
// of what its branches demand and what its ticket alone implies — which is how a ticket
// with a clean PR on one branch and a failing one on another stops reporting whichever PR
// GitHub's unsorted search happened to return first.
const LANE_URGENCY = ['needs-you', 'waiting', 'in-flight', 'ready-to-start', 'backlog']
const mostUrgent = (lanes) => {
  let best = null
  for (const l of lanes) {
    if (!l) continue
    if (best === null || LANE_URGENCY.indexOf(l) < LANE_URGENCY.indexOf(best)) best = l
  }
  return best
}

// The branch name minus the ticket key it repeats: on a card already titled PY-12746, the
// useful half of "PY-12746-catalog-pr2-agent-suggestions" is what comes after the key.
export function shortBranch(item, branch) {
  const name = branch?.name
  if (!name) return null
  return item?.key && name.startsWith(`${item.key}-`) ? name.slice(item.key.length + 1) : name
}

// Which branch a reason belongs to, said ONLY when the item has more than one branch to tell
// apart — and not at all when the text already names the PR it is about ("awaiting review on
// #7110" needs no prefix). So a single-branch item's reason text is byte-identical to what it
// was before branches existed, which is what kept this change reviewable.
function labelReason(item, branch, reason) {
  const pr = branch.pr
  if (pr && reason.includes(`#${pr.number}`)) return reason
  const label = pr ? `#${pr.number}` : shortBranch(item, branch)
  return label ? `${label}: ${reason}` : reason
}

// What ONE branch demands, judged only on its own PR and its own checkout. Everything here
// used to be computed once per ITEM against `myPrs[0]` and a scalar `item.slot`, so a second
// branch's failing checks, requested changes, open threads, conflicts, and uncommitted work
// produced no text anywhere on the board.
//
// `itemHasMyPr` is deliberately item-scoped, not branch-scoped: a checkout on a Done ticket
// is only fair game when the user has no open PR on that ticket AT ALL. A sibling branch
// still in review means the work is not finished, whichever branch the checkout holds.
function assessBranch(branch, { item, config, foreign, stale, itemHasMyPr, humanGates }) {
  const pr = branch.pr
  const myPr = pr && isMinePr(pr) ? pr : null
  const reviewPr = pr && pr.isMine === false ? pr : null
  const slot = branch.slot
  const gate = mergeGateFor(myPr)
  const reasons = []

  // --- checkout facts ---
  const reclaimable = Boolean(slot && (foreign || stale) && !itemHasMyPr)
  if (reclaimable) reasons.push('slot reclaimable')
  if (slot?.dirty) reasons.push(`uncommitted changes (${slot.dirtyCount ?? '?'} files)`)
  if (slot?.behind > 0) reasons.push(`${slot.behind} behind master`)

  // --- lane 1: needs you ---
  // Collect EVERY applicable reason, not just the first: one branch can be both "ticket
  // Done but PR open" and "required check failing". The reason TEXT and the lane-PROMOTION
  // decision are kept separate: a draft is by definition not ready for review, so its
  // failing checks and its conflicts with master are the expected state of work in
  // progress, not something actionable — they still explain the card, they just don't pull
  // the item into needs-you.
  let lane = null
  const failing = myPr?.requiredChecks?.failing ?? []
  // Some required checks are HUMAN gates, not CI. PerformYard's "QA Code Review" is FAILURE
  // until a QA engineer approves it, which is the EXPECTED state of a ticket sitting in
  // Ready To Test. Counting it as a failing check put every such ticket in needs-you reading
  // "required check failing", implying the user could fix it by pushing code. They cannot —
  // it is someone else's move. It still blocks mergeGateFor: you may not merge before QA
  // signs off. The only thing that changes is whose turn the board says it is.
  const failingCi = failing.filter((n) => !humanGates.has(n))
  const failingGates = failing.filter((n) => humanGates.has(n))
  const needs = []
  let promote = false
  if (reviewPr) { needs.push(`review requested of you (#${reviewPr.number})`); promote = true }
  if (myPr && stale) { needs.push(`ticket is Done but PR #${myPr.number} is still open`); promote = true }
  if (failingCi.length) {
    needs.push(`required check failing: ${failingCi.join(', ')}`)
    if (!myPr.isDraft) promote = true
  }
  // Only when you have NOT already pushed fixes — see changesAddressed. An addressed PR is
  // handled by the waiting lane below, where the ball actually is.
  if (myPr?.reviewDecision === 'CHANGES_REQUESTED' && !changesAddressed(myPr)) {
    needs.push('changes requested'); promote = true
  }
  // Feedback you have not answered is your move. Distinct from hasReviewComments, which is
  // the broader "a human said something" net that gates the resolve-code-review skill; this
  // is the count that is still actually waiting on you.
  if (myPr?.openThreads > 0) {
    needs.push(`${myPr.openThreads} open review thread${myPr.openThreads === 1 ? '' : 's'} on #${myPr.number}`)
    if (!myPr.isDraft) promote = true
  }
  if (myPr && myPr.mergeable === 'CONFLICTING') {
    needs.push('conflicts with master')
    if (!myPr.isDraft) promote = true
  }
  if (gate.allowed) { needs.push('approved and mergeable — merge it'); promote = true }
  if (needs.length) reasons.push(...needs)
  if (promote) lane = 'needs-you'

  // --- lane 2: waiting on others ---
  // Three ways the ball can be in someone else's court: never reviewed, reviewed and since
  // addressed, or held only by a human gate. A failing required check outranks all three —
  // CI is your problem either way.
  const addressed = changesAddressed(myPr)
  const gateHeld = failingGates.length > 0 && failingCi.length === 0
  if (!lane && myPr && !myPr.isDraft && failingCi.length === 0 &&
      (myPr.reviewDecision === 'REVIEW_REQUIRED' || addressed || gateHeld)) {
    lane = 'waiting'
    if (addressed) reasons.push(`changes pushed — awaiting re-review on #${myPr.number}`)
    else if (myPr.reviewDecision === 'REVIEW_REQUIRED') reasons.push(`awaiting review on #${myPr.number}`)
    if (gateHeld) reasons.push(`awaiting ${failingGates.join(', ')} on #${myPr.number}`)
  }

  // --- lane 3: in flight ---
  // A checkout exists, or the PR is still a draft. The ticket-level "already In Progress in
  // Jira" case is decided by the caller, since it belongs to no single branch.
  if (!lane && (slot || myPr?.isDraft)) lane = 'in-flight'

  return { ...branch, lane, reasons, mergeGate: gate, reclaimable }
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
      `work-dash: the configured sprint field ("${field}") is absent from every Jira ` +
      `issue's fields entirely (not merely null-valued). This usually means jiraSprintField ` +
      `is misconfigured for this Jira instance — Jira omits an unrecognized field rather ` +
      `than returning it as null. Falling back to the plan-folder heuristic for ready-to-start.`
    )
  }
  const humanGates = new Set(config.humanGateChecks ?? [])

  return items.map((item) => {
    const myPrs = item.prs.filter(isMinePr)

    // --- ticket-level signals: true of the whole ticket, not of any one branch ---
    const foreign = Boolean(item.jira && item.jira.isMine === false)
    const stale = Boolean(item.jira && item.jira.statusCategory === 'Done')
    const reasons = []
    if (foreign) reasons.push(`assigned to ${item.jira.assignee}`)
    if (stale) reasons.push('ticket is Done')

    const branches = (item.branches ?? []).map((b) =>
      assessBranch(b, { item, config, foreign, stale, itemHasMyPr: myPrs.length > 0, humanGates }))

    const multi = branches.length > 1
    for (const b of branches) {
      for (const r of b.reasons) reasons.push(multi ? labelReason(item, b, r) : r)
    }

    // --- ticket-level lanes ---
    // A ticket already In Progress (by Jira's own statusCategory, which covers every literal
    // status in inFlightStatusOrder — In Progress, In Code Review, Ready To Test, etc.)
    // belongs in-flight even with no branch checked out yet: moving a ticket to In Progress
    // must not make it LESS visible by dropping it all the way to backlog.
    //
    // Ready to start is sprint-committed To Do work — the literal status string (TO DO vs
    // READY) doesn't matter, only the category plus active-sprint membership. When the sprint
    // field looks misconfigured (see needsSprintFallback), fall back to the old
    // plan-folder-on-disk heuristic so the lane isn't silently dead.
    const sprintCommitted = fallbackToPlans ? item.plans.length > 0 : Boolean(item.jira?.activeSprint)
    let ticketLane = null
    if (item.jira?.statusCategory === 'In Progress') ticketLane = 'in-flight'
    else if (item.jira?.statusCategory === 'To Do' && sprintCommitted) ticketLane = 'ready-to-start'

    const lane = mostUrgent([...branches.map((b) => b.lane), ticketLane]) ?? 'backlog'
    // Said only when the lane it explains is the one the item actually landed in — an item
    // with a checkout is in-flight, and telling it that it is sprint-committed would be
    // explaining a lane it isn't in.
    if (lane === 'ready-to-start') {
      reasons.push(fallbackToPlans
        ? `${item.plans.length} plan folder${item.plans.length > 1 ? 's' : ''} on disk`
        : `sprint-committed: ${item.jira.activeSprint}`)
    }

    const statusGroup = item.jira?.status ?? 'no ticket'
    const idx = order.indexOf(statusGroup)

    return { ...item, branches, lane, reasons,
             signals: { foreign, stale, reclaimable: branches.some((b) => b.reclaimable) },
             // DEPRECATED item-level gate: there can be one per branch. Kept unchanged
             // (myPrs[0], exactly as before) until public/app.js reads branch.mergeGate.
             mergeGate: mergeGateFor(myPrs[0]),
             statusGroup, sortIndex: idx === -1 ? Infinity : idx }
  })
}
