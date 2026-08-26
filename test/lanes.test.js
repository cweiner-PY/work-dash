// test/lanes.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignLanes, mergeGateFor, myPrOf, isMinePr, needsSprintFallback } from '../lanes.js'

// assignLanes warns once (see needsSprintFallback) whenever every Jira issue in a batch
// has a null active sprint — true of nearly every single-synthetic-item call below, none
// of which are testing sprint behavior. Swallow it by default; the dedicated fallback
// test captures it explicitly instead.
console.warn = () => {}

const config = {
  inFlightStatusOrder: ['In Progress', 'In Code Review', 'Ready To Test', 'In Testing', 'Ready To Merge'],
  myAccountId: 'me',
}
const lane = (item) => assignLanes([item], config)[0]

const pr = (o = {}) => ({
  repo: 'O/R', number: 1, title: 't', headRefName: 'b',
  reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', isDraft: false,
  checks: { pass: 1, fail: 0, pending: 0 },
  requiredChecks: { total: 3, failing: [], known: true },
  hasReviewComments: false, isMine: true, url: 'u', ...o,
})
const jira = (o = {}) => ({ key: 'PY-1', summary: 's', status: 'In Progress', statusCategory: 'In Progress', assignee: 'Colt Weiner', isMine: true, ...o })
const item = (o = {}) => ({ id: 'PY-1', key: 'PY-1', title: 's', repo: 'O/R', jira: null, prs: [], slot: null, plans: [], ...o })

// --- myPrOf / isMinePr ---
test('myPrOf returns the user\'s own PR when the item also carries a review request', () => {
  const mine = pr({ number: 1, isMine: true })
  const review = pr({ number: 2, isMine: false })
  assert.equal(myPrOf(item({ prs: [review, mine] })).number, 1)
})
test('myPrOf returns null when the item\'s only PR is a review request', () => {
  const review = pr({ number: 2, isMine: false })
  assert.equal(myPrOf(item({ prs: [review] })), null)
})
test('myPrOf returns null for an item with no PRs at all', () => {
  assert.equal(myPrOf(item({ prs: [] })), null)
})
test('isMinePr treats isMine: undefined as mine (no explicit false)', () => {
  assert.equal(isMinePr({ number: 1 }), true)
  assert.equal(isMinePr({ number: 1, isMine: false }), false)
})

// --- merge gate ---
test('merge gate passes on approved, mergeable, non-draft, required checks green', () => {
  assert.deepEqual(mergeGateFor(pr({ reviewDecision: 'APPROVED' })), { allowed: true, blockers: [] })
})
test('ZERO required checks passes vacuously when KNOWN (Logan has none configured)', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'APPROVED', requiredChecks: { total: 0, failing: [], known: true } }))
  assert.equal(g.allowed, true)
})
test('merge gate blocks when required-check status is unknown (gh read failed)', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'APPROVED', requiredChecks: { total: 0, failing: [], known: false } }))
  assert.equal(g.allowed, false)
  assert.ok(g.blockers.some((b) => b.includes('unknown')))
})
test('a requiredChecks object missing the known field entirely is also treated as unknown', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'APPROVED', requiredChecks: { total: 0, failing: [] } }))
  assert.equal(g.allowed, false)
  assert.ok(g.blockers.some((b) => b.includes('unknown')))
})
test('merge gate blocks and names each failing required check', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'APPROVED', requiredChecks: { total: 6, failing: ['QA Code Review'] } }))
  assert.equal(g.allowed, false)
  assert.ok(g.blockers.some((b) => b.includes('QA Code Review')))
})
test('merge gate blocks on not-approved, draft, and conflicting, listing all of them', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'REVIEW_REQUIRED', isDraft: true, mergeable: 'CONFLICTING' }))
  assert.equal(g.allowed, false)
  assert.equal(g.blockers.length, 3)
})
test('merge gate with no PR is not allowed', () => {
  assert.equal(mergeGateFor(undefined).allowed, false)
})
test('merge gate blocks on a pending required check with a distinct "still running" blocker, not a failure', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'APPROVED',
    requiredChecks: { total: 1, failing: [], pending: ['Unit Tests'], known: true } }))
  assert.equal(g.allowed, false)
  assert.ok(g.blockers.some((b) => /still running/.test(b)))
  assert.ok(!g.blockers.some((b) => /failing/.test(b)), 'a pending check must not be reported as failing')
})
test('a genuinely failing required check still blocks even alongside a pending one', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'APPROVED',
    requiredChecks: { total: 2, failing: ['Linting'], pending: ['Unit Tests'], known: true } }))
  assert.equal(g.allowed, false)
  assert.ok(g.blockers.some((b) => b.includes('Linting')))
  assert.ok(g.blockers.some((b) => /still running/.test(b)))
})

// --- lanes ---
test('failing required check puts the item in needs-you', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ requiredChecks: { total: 6, failing: ['Linting'] } })] }))
  assert.equal(it.lane, 'needs-you')
  assert.ok(it.reasons.some((r) => r.includes('Linting')))
})
test('approved and mergeable with green required checks is needs-you: go merge', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ reviewDecision: 'APPROVED' })] }))
  assert.equal(it.lane, 'needs-you')
  assert.equal(it.mergeGate.allowed, true)
  assert.ok(it.reasons.some((r) => /merge/i.test(r)))
})
test('changes requested is needs-you', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ reviewDecision: 'CHANGES_REQUESTED' })] }))
  assert.equal(it.lane, 'needs-you')
})
test('CONFLICTING is needs-you', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ mergeable: 'CONFLICTING' })] }))
  assert.equal(it.lane, 'needs-you')
})
test('a PR someone asked you to review is needs-you', () => {
  const it = lane(item({ jira: null, prs: [pr({ isMine: false })] }))
  assert.equal(it.lane, 'needs-you')
  assert.ok(it.reasons.some((r) => /review requested/i.test(r)))
})
test('jira Done with an open PR is needs-you', () => {
  const it = lane(item({ jira: jira({ status: 'Done', statusCategory: 'Done' }), prs: [pr()] }))
  assert.equal(it.lane, 'needs-you')
  assert.ok(it.reasons.some((r) => /done/i.test(r) && /open/i.test(r)))
})
test('open, review-required, green, non-draft is waiting — even with a slot', () => {
  const it = lane(item({ jira: jira(), prs: [pr()], slot: { dir: '/s', branch: 'b', dirty: false, behind: 0, ahead: 1 } }))
  assert.equal(it.lane, 'waiting')
})
test('waiting takes precedence over in-flight (PR #704 case: 0 required checks)', () => {
  const it = lane(item({ key: null, jira: null, prs: [pr({ requiredChecks: { total: 0, failing: [] } })], slot: { dir: '/s', branch: 'b', dirty: false, behind: 0, ahead: 7 } }))
  assert.equal(it.lane, 'waiting')
})
test('a slot with no PR is in-flight, sub-grouped by jira status', () => {
  const it = lane(item({ jira: jira({ status: 'Ready To Test' }), slot: { dir: '/s', branch: 'b', dirty: false, behind: 0, ahead: 1 } }))
  assert.equal(it.lane, 'in-flight')
  assert.equal(it.statusGroup, 'Ready To Test')
  assert.equal(it.sortIndex, 2)
})
test('a draft PR with nothing demanding is in-flight', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ isDraft: true, mergeable: 'MERGEABLE', requiredChecks: { total: 3, failing: [] } })] }))
  assert.equal(it.lane, 'in-flight')
})
test('an in-flight item with no jira gets the "no ticket" group and Infinity sortIndex', () => {
  const it = lane(item({ key: null, jira: null, slot: { dir: '/s', branch: 'b', dirty: false, behind: 0, ahead: 1 } }))
  assert.equal(it.lane, 'in-flight')
  assert.equal(it.statusGroup, 'no ticket')
  assert.equal(it.sortIndex, Infinity)
})
test('In Progress, In Code Review, and Ready To Test with no branch and no slot are all in-flight, not backlog', () => {
  for (const status of ['In Progress', 'In Code Review', 'Ready To Test']) {
    const it = lane(item({ jira: jira({ status, statusCategory: 'In Progress' }) }))
    assert.equal(it.lane, 'in-flight', status)
  }
})

// --- ready-to-start: sprint-committed To Do work (Change 2) ---
// A sentinel item carrying a real active sprint keeps needsSprintFallback false for the
// whole batch, so these exercise the direct activeSprint rule, not the plan-folder
// fallback (which single-item calls above would otherwise trigger).
const sentinel = item({ id: 'sentinel', jira: jira({ activeSprint: 'S1' }) })
const withSprintConfigured = (it) => assignLanes([it, sentinel], config)[0]

test('ready-to-start requires BOTH To Do AND an active sprint (all four combinations)', () => {
  const toDoWithSprint = withSprintConfigured(item({ jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: 'S1' }) }))
  assert.equal(toDoWithSprint.lane, 'ready-to-start')

  const toDoNoSprint = withSprintConfigured(item({ jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null }) }))
  assert.equal(toDoNoSprint.lane, 'backlog')

  const doneWithSprint = withSprintConfigured(item({ jira: jira({ status: 'Done', statusCategory: 'Done', activeSprint: 'S1' }) }))
  assert.equal(doneWithSprint.lane, 'backlog')

  const doneNoSprint = withSprintConfigured(item({ jira: jira({ status: 'Done', statusCategory: 'Done', activeSprint: null }) }))
  assert.equal(doneNoSprint.lane, 'backlog')
})

test('a To Do item with a plan folder but NO active sprint is backlog, not ready-to-start (deliberate behaviour change)', () => {
  const it = withSprintConfigured(item({
    jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null }),
    plans: [{ dir: '/d', folder: 'f', key: 'PY-1', files: ['plan.md'] }],
  }))
  assert.equal(it.lane, 'backlog')
})

test('the reason text names the active sprint', () => {
  const it = withSprintConfigured(item({ jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: 'RW2026.6-S1' }) }))
  assert.ok(it.reasons.some((r) => r.includes('RW2026.6-S1')))
})

// --- do-not-silently-degrade: the all-null misconfiguration fallback ---
test('needsSprintFallback: true when every jira item has a null active sprint', () => {
  assert.equal(needsSprintFallback([
    item({ jira: jira({ activeSprint: null }) }),
    item({ id: 'PY-2', jira: jira({ activeSprint: undefined }) }),
  ]), true)
})
test('needsSprintFallback: false when at least one jira item has a real active sprint', () => {
  assert.equal(needsSprintFallback([
    item({ jira: jira({ activeSprint: null }) }),
    item({ id: 'PY-2', jira: jira({ activeSprint: 'S1' }) }),
  ]), false)
})
test('needsSprintFallback: false when there are no jira items at all (nothing to warn about)', () => {
  assert.equal(needsSprintFallback([item({ jira: null }), item({ id: 'PY-2', jira: null })]), false)
})

test('when every Jira issue has a null active sprint, assignLanes warns once (naming the field) and ready-to-start reverts to the plan-folder rule', () => {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try {
    const withPlan = item({ jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null }), plans: [{ dir: '/d', folder: 'f', key: 'PY-1', files: ['plan.md'] }] })
    const withoutPlan = item({ id: 'PY-2', jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null }) })
    const [a, b] = assignLanes([withPlan, withoutPlan], { ...config, jiraSprintField: 'customfield_10020' })
    assert.equal(a.lane, 'ready-to-start')
    assert.equal(b.lane, 'backlog')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /customfield_10020/)
  } finally {
    console.warn = realWarn
  }
})

// --- lane 1 draft gating: a draft's failing checks / conflicts are expected,
// not actionable — they must not promote to needs-you, but must still show ---
test('a draft with failing required checks is not needs-you, but the reason still shows', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ isDraft: true, requiredChecks: { total: 3, failing: ['Linting'], known: true } })] }))
  assert.equal(it.lane, 'in-flight')
  assert.ok(it.reasons.some((r) => r.includes('Linting')))
})
test('the same failing-check PR promotes to needs-you once it is not a draft', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ isDraft: false, requiredChecks: { total: 3, failing: ['Linting'], known: true } })] }))
  assert.equal(it.lane, 'needs-you')
  assert.ok(it.reasons.some((r) => r.includes('Linting')))
})
test('a draft that conflicts with master is not needs-you, but the reason still shows', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ isDraft: true, mergeable: 'CONFLICTING' })] }))
  assert.equal(it.lane, 'in-flight')
  assert.ok(it.reasons.some((r) => /conflicts with master/.test(r)))
})
test('the same conflicting PR promotes to needs-you once it is not a draft', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ isDraft: false, mergeable: 'CONFLICTING' })] }))
  assert.equal(it.lane, 'needs-you')
  assert.ok(it.reasons.some((r) => /conflicts with master/.test(r)))
})
test('a draft with changes requested is still needs-you', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED' })] }))
  assert.equal(it.lane, 'needs-you')
})
test('a draft on a Jira-Done ticket is still needs-you', () => {
  const it = lane(item({ jira: jira({ status: 'Done', statusCategory: 'Done' }), prs: [pr({ isDraft: true })] }))
  assert.equal(it.lane, 'needs-you')
})
test('a draft carrying a review-requested PR of someone else\'s is still needs-you', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ isDraft: true }), pr({ number: 2, isMine: false })] }))
  assert.equal(it.lane, 'needs-you')
  assert.ok(it.reasons.some((r) => /review requested/i.test(r)))
})
test('mergeGateFor still blocks a draft PR even when approved and mergeable', () => {
  const g = mergeGateFor(pr({ reviewDecision: 'APPROVED', isDraft: true }))
  assert.equal(g.allowed, false)
  assert.ok(g.blockers.includes('draft'))
})

// --- signals ---
test('foreign, stale and reclaimable', () => {
  const foreign = lane(item({ jira: jira({ status: 'Ready To Test', isMine: false, assignee: 'Bruce Pereira' }), slot: { dir: '/s', branch: 'b', dirty: true, behind: 13, ahead: 6 } }))
  assert.equal(foreign.signals.foreign, true)
  assert.equal(foreign.signals.reclaimable, true)
  assert.ok(foreign.reasons.some((r) => r.includes('Bruce Pereira')))

  const stale = lane(item({ jira: jira({ status: 'Done', statusCategory: 'Done' }), slot: { dir: '/s', branch: 'b', dirty: false, behind: 0, ahead: 12 } }))
  assert.equal(stale.signals.stale, true)
  assert.equal(stale.signals.reclaimable, true)
})
test('an open PR of mine keeps a slot from being reclaimable', () => {
  const it = lane(item({ jira: jira({ status: 'Done', statusCategory: 'Done' }), prs: [pr()], slot: { dir: '/s', branch: 'b', dirty: false, behind: 0, ahead: 1 } }))
  assert.equal(it.signals.stale, true)
  assert.equal(it.signals.reclaimable, false)
})
test('a dirty slot that is behind master is reported in reasons', () => {
  const it = lane(item({ jira: jira(), slot: { dir: '/s', branch: 'b', dirty: true, dirtyCount: 2, behind: 13, ahead: 6 } }))
  assert.ok(it.reasons.some((r) => /behind/.test(r)))
  assert.ok(it.reasons.some((r) => /uncommitted/i.test(r)))
})
