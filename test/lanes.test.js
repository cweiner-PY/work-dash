// test/lanes.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignLanes as rawAssignLanes, mergeGateFor, myPrOf, isMinePr, needsSprintFallback, changesAddressed, shortBranch } from '../lanes.js'

// assignLanes reads item.branches — join.js builds them by pairing each PR with the checkout
// on the same branch. These tests describe their inputs in the terms they are ABOUT (a PR, a
// checkout), so branches are derived here once, the same way join.js derives them. That keeps
// each test's intent legible while still exercising the real, branch-shaped code path.
const branchesFrom = ({ prs = [], slot = null, repo = null, branches }) => {
  if (branches) return branches
  const out = []
  const at = (name) => {
    let b = out.find((x) => x.name === name)
    if (!b) { b = { name, repo, pr: null, slot: null, detached: false }; out.push(b) }
    return b
  }
  for (const p of prs) at(p.headRefName ?? null).pr = p
  if (slot) at(slot.branch ?? null).slot = slot
  if (!out.length) out.push({ name: null, repo, pr: null, slot: null, detached: false })
  return out
}
const withBranches = (o) => ({ ...o, branches: branchesFrom(o) })
const assignLanes = (items, config) => rawAssignLanes(items.map(withBranches), config)

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
const jira = (o = {}) => ({ key: 'PY-1', summary: 's', status: 'In Progress', statusCategory: 'In Progress',
  assignee: 'Colt Weiner', isMine: true,
  // Realistic default: the sprint field IS present on a normalized Jira issue (Jira omits
  // it entirely only when misconfigured — see needsSprintFallback in lanes.js). Tests that
  // specifically exercise the fallback override this explicitly.
  sprintFieldPresent: true,
  ...o })
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

// --- do-not-silently-degrade: the field-ABSENT misconfiguration fallback. Presence, not
// value, is the discriminator — Jira omits an unrecognized field entirely rather than
// returning it as null, so a field that IS present but empty just means "no active
// sprint right now", which must never warn or trigger the fallback. ---
test('needsSprintFallback: true when every jira item is missing the sprint field entirely', () => {
  assert.equal(needsSprintFallback([
    item({ jira: jira({ sprintFieldPresent: false }) }),
    item({ id: 'PY-2', jira: jira({ sprintFieldPresent: false }) }),
  ]), true)
})
test('needsSprintFallback: false when at least one jira item has the field present, even with a null value', () => {
  assert.equal(needsSprintFallback([
    item({ jira: jira({ sprintFieldPresent: false }) }),
    item({ id: 'PY-2', jira: jira({ sprintFieldPresent: true, activeSprint: null }) }),
  ]), false)
})
test('needsSprintFallback: false when there are no jira items at all (nothing to warn about)', () => {
  assert.equal(needsSprintFallback([item({ jira: null }), item({ id: 'PY-2', jira: null })]), false)
})

test('field present but every active sprint is null: NO fallback, NO warning, ready-to-start is legitimately empty', () => {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try {
    const a = item({ jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null, sprintFieldPresent: true }) })
    const b = item({ id: 'PY-2', jira: jira({ status: 'In Progress', statusCategory: 'In Progress', activeSprint: null, sprintFieldPresent: true }) })
    const out = assignLanes([a, b], config)
    assert.equal(warnings.length, 0, 'genuinely between sprints must not warn about a misconfiguration that does not exist')
    assert.ok(!out.some((i) => i.lane === 'ready-to-start'), 'ready-to-start is legitimately empty, not silently reverted to the plan heuristic')
  } finally {
    console.warn = realWarn
  }
})

test('field absent on every item: fallback triggers, assignLanes warns exactly once (naming the field), and ready-to-start reverts to the plan-folder rule', () => {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try {
    const withPlan = item({ jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null, sprintFieldPresent: false }), plans: [{ dir: '/d', folder: 'f', key: 'PY-1', files: ['plan.md'] }] })
    const withoutPlan = item({ id: 'PY-2', jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null, sprintFieldPresent: false }) })
    const [a, b] = assignLanes([withPlan, withoutPlan], { ...config, jiraSprintField: 'customfield_10020' })
    assert.equal(a.lane, 'ready-to-start')
    assert.equal(b.lane, 'backlog')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /customfield_10020/)
  } finally {
    console.warn = realWarn
  }
})

test('field present on some items with a real active sprint: normal sprint-committed behaviour, no warning', () => {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try {
    const withSprint = item({ jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: 'S1', sprintFieldPresent: true }) })
    const withoutSprint = item({ id: 'PY-2', jira: jira({ status: 'READY', statusCategory: 'To Do', activeSprint: null, sprintFieldPresent: true }) })
    const [a, b] = assignLanes([withSprint, withoutSprint], config)
    assert.equal(a.lane, 'ready-to-start')
    assert.equal(b.lane, 'backlog')
    assert.equal(warnings.length, 0)
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


// --- changesAddressed: whose turn is it on a changes-requested PR? ---------------------

const REVIEWED = '2026-08-25T10:00:00Z'
const cr = (o = {}) => ({
  number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
  reviewDecision: 'CHANGES_REQUESTED', changesRequestedAt: REVIEWED,
  requiredChecks: { total: 0, failing: [], known: true },
  ...o,
})

test('changesAddressed is true only once you pushed AFTER the review', () => {
  assert.equal(changesAddressed(cr({ lastCommitAt: '2026-08-26T10:00:00Z' })), true, 'pushed after')
  assert.equal(changesAddressed(cr({ lastCommitAt: '2026-08-24T10:00:00Z' })), false, 'pushed before')
  assert.equal(changesAddressed(cr({ lastCommitAt: REVIEWED })), false, 'same instant is not after')
})

test('changesAddressed only applies to a CHANGES_REQUESTED PR', () => {
  for (const reviewDecision of ['APPROVED', 'REVIEW_REQUIRED', null, undefined]) {
    assert.equal(changesAddressed(cr({ reviewDecision, lastCommitAt: '2026-08-26T10:00:00Z' })), false,
      String(reviewDecision))
  }
})

test('changesAddressed fails PESSIMISTIC on missing or unparseable timestamps', () => {
  // The safe direction is to keep nagging. Guessing "addressed" would quietly tell the user
  // a real "changes requested" is somebody else's problem.
  for (const o of [
    { lastCommitAt: null }, { lastCommitAt: undefined }, { lastCommitAt: 'nope' },
    { changesRequestedAt: null, lastCommitAt: '2026-08-26T10:00:00Z' },
    { changesRequestedAt: 'nope', lastCommitAt: '2026-08-26T10:00:00Z' },
  ]) {
    assert.equal(changesAddressed(cr(o)), false, JSON.stringify(o))
  }
  assert.equal(changesAddressed(null), false)
  assert.equal(changesAddressed(undefined), false)
})

// REGRESSION: before this, ANY changes-requested PR was promoted to needs-you, so a PR you
// had already pushed fixes for nagged you until the reviewer came back — someone else's turn
// presented as yours.
test('an UNaddressed changes-requested PR is needs-you', () => {
  const [item] = assignLanes([{
    id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: null, plans: [], jira: null,
    prs: [cr({ lastCommitAt: '2026-08-24T10:00:00Z' })],
    signals: {},
  }], { inFlightStatusOrder: [] })
  assert.equal(item.lane, 'needs-you')
  assert.ok(item.reasons.some((r) => /changes requested/.test(r)))
})

test('an ADDRESSED changes-requested PR moves to waiting, and says why', () => {
  const [item] = assignLanes([{
    id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: null, plans: [], jira: null,
    prs: [cr({ lastCommitAt: '2026-08-26T10:00:00Z' })],
    signals: {},
  }], { inFlightStatusOrder: [] })
  assert.equal(item.lane, 'waiting', 'the ball is in the reviewer\'s court')
  assert.ok(item.reasons.some((r) => /changes pushed/.test(r)), item.reasons.join('; '))
  assert.ok(!item.reasons.some((r) => r === 'changes requested'))
})

test('a failing required check outranks being addressed — CI is yours either way', () => {
  const [item] = assignLanes([{
    id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: null, plans: [], jira: null,
    prs: [cr({
      lastCommitAt: '2026-08-26T10:00:00Z',
      requiredChecks: { total: 1, failing: ['Linting'], known: true },
    })],
    signals: {},
  }], { inFlightStatusOrder: [] })
  assert.equal(item.lane, 'needs-you')
  assert.ok(item.reasons.some((r) => /Linting/.test(r)))
})

test('a DRAFT that is addressed does not land in waiting', () => {
  // A draft is not awaiting anyone's review by definition.
  const [item] = assignLanes([{
    id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: null, plans: [], jira: null,
    prs: [cr({ isDraft: true, lastCommitAt: '2026-08-26T10:00:00Z' })],
    signals: {},
  }], { inFlightStatusOrder: [] })
  assert.equal(item.lane, 'in-flight')
})


// --- human gates: a check that stays red until a PERSON acts ---------------------------

const GATES = { inFlightStatusOrder: [], humanGateChecks: ['QA Code Review'] }
const withPr = (pr, jira = null) => assignLanes([{
  id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: null, plans: [], jira, prs: [pr], signals: {},
}], GATES)[0]

// REGRESSION, reported from the live board: PY-13751 sat in NEEDS YOU reading "required
// check failing: QA Code Review" while its Jira status was Ready To Test. The gate is
// FAILURE until a QA engineer approves — the expected state of a ticket with QA — so the
// board was telling the user to fix something only somebody else can act on.
test('a failing HUMAN gate does not put an approved PR in needs-you', () => {
  const item = withPr({
    number: 7230, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    requiredChecks: { total: 6, failing: ['QA Code Review'], known: true },
  })
  assert.equal(item.lane, 'waiting', item.reasons.join('; '))
  assert.ok(item.reasons.some((r) => /awaiting QA Code Review/.test(r)), item.reasons.join('; '))
  assert.ok(!item.reasons.some((r) => /required check failing/.test(r)),
    'must not imply the user broke something')
})

test('a failing CI check still lands in needs-you, gate or no gate', () => {
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    requiredChecks: { total: 6, failing: ['QA Code Review', 'Linting'], known: true },
  })
  assert.equal(item.lane, 'needs-you')
  assert.ok(item.reasons.some((r) => /required check failing: Linting/.test(r)),
    'and names only the check the user can actually fix: ' + item.reasons.join('; '))
})

test('a human gate still BLOCKS the merge gate — QA must sign off first', () => {
  // The lane changed; permission to merge did not.
  const gate = mergeGateFor({
    reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false,
    requiredChecks: { total: 6, failing: ['QA Code Review'], known: true },
  })
  assert.equal(gate.allowed, false)
  assert.ok(gate.blockers.some((b) => /QA Code Review/.test(b)), gate.blockers.join('; '))
})

test('an unreviewed PR held by a gate reports BOTH waits', () => {
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    requiredChecks: { total: 6, failing: ['QA Code Review'], known: true },
  })
  assert.equal(item.lane, 'waiting')
  assert.ok(item.reasons.some((r) => /awaiting review/.test(r)), item.reasons.join('; '))
  assert.ok(item.reasons.some((r) => /awaiting QA Code Review/.test(r)), item.reasons.join('; '))
})

test('with no humanGateChecks configured, every required check is CI again', () => {
  // An organisation without a human gate must get the old behaviour exactly.
  const item = assignLanes([{
    id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: null, plans: [], jira: null, signals: {},
    prs: [{
      number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      requiredChecks: { total: 1, failing: ['QA Code Review'], known: true },
    }],
  }], { inFlightStatusOrder: [], humanGateChecks: [] })[0]
  assert.equal(item.lane, 'needs-you')
  assert.ok(item.reasons.some((r) => /required check failing: QA Code Review/.test(r)))
})

test('a DRAFT held by a gate is in flight, not waiting on anyone', () => {
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: true, mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    requiredChecks: { total: 6, failing: ['QA Code Review'], known: true },
  })
  assert.equal(item.lane, 'in-flight')
})


// --- open review threads pull an item into needs-you ------------------------------------

test('unanswered review threads are your move', () => {
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED', openThreads: 3,
    requiredChecks: { total: 0, failing: [], known: true },
  })
  assert.equal(item.lane, 'needs-you')
  assert.ok(item.reasons.some((r) => /3 open review threads on #1/.test(r)), item.reasons.join('; '))
})

test('one thread is singular', () => {
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED', openThreads: 1,
    requiredChecks: { total: 0, failing: [], known: true },
  })
  assert.ok(item.reasons.some((r) => /1 open review thread on #1/.test(r)), item.reasons.join('; '))
})

test('zero threads says nothing at all', () => {
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED', openThreads: 0,
    requiredChecks: { total: 0, failing: [], known: true },
  })
  assert.equal(item.lane, 'waiting')
  assert.ok(!item.reasons.some((r) => /thread/.test(r)))
})

test('a draft with open threads explains itself but is not promoted', () => {
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: true, mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED', openThreads: 2,
    requiredChecks: { total: 0, failing: [], known: true },
  })
  assert.equal(item.lane, 'in-flight')
  assert.ok(item.reasons.some((r) => /2 open review threads/.test(r)))
})

test('a missing openThreads field is not a truthy promotion', () => {
  // Every other PR-shaped object in this codebase predates the field.
  const item = withPr({
    number: 1, repo: 'O/R', isMine: true, isDraft: false, mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    requiredChecks: { total: 0, failing: [], known: true },
  })
  assert.equal(item.lane, 'waiting')
})

// --- many branches on one ticket -------------------------------------------------------
//
// REGRESSION, the whole point of `branches`: every lane decision, every reason line, and the
// merge gate were computed against `myPrs[0]` — the first PR in an array filled from a GitHub
// search with no explicit sort. A ticket's second PR contributed NOTHING to the board. Its
// failing checks, requested changes, open threads and conflicts were all silent, and which of
// the two got to speak was not even stable between refreshes.

const twoPrs = (a, b) => item({
  jira: jira(),
  prs: [pr({ number: 7110, headRefName: 'PY-1-catalog', ...a }),
        pr({ number: 7200, headRefName: 'PY-1-catalog-pr2-agent-suggestions', ...b })],
})

test('a second PR failing CI is no longer invisible behind the first', () => {
  const it = lane(twoPrs({}, { requiredChecks: { total: 6, failing: ['Linting'], known: true } }))
  assert.equal(it.branches.length, 2)
  assert.equal(it.lane, 'needs-you', 'the failing branch decides the lane, not whichever PR came first')
  assert.ok(it.reasons.some((r) => r === '#7200: required check failing: Linting'), it.reasons.join('; '))
})

test('PR order no longer decides what the board says', () => {
  // The direct test for the myPrs[0] nondeterminism: the same two PRs in either order must
  // produce the same lane and the same set of reasons.
  const forward = lane(twoPrs({}, { reviewDecision: 'CHANGES_REQUESTED' }))
  const reversed = lane(item({
    jira: jira(),
    prs: [pr({ number: 7200, headRefName: 'PY-1-catalog-pr2-agent-suggestions', reviewDecision: 'CHANGES_REQUESTED' }),
          pr({ number: 7110, headRefName: 'PY-1-catalog' })],
  }))
  assert.equal(forward.lane, reversed.lane)
  assert.deepEqual([...forward.reasons].sort(), [...reversed.reasons].sort())
})

test('each branch carries its own merge gate', () => {
  const it = lane(twoPrs({ reviewDecision: 'APPROVED' }, { reviewDecision: 'REVIEW_REQUIRED' }))
  const byPr = new Map(it.branches.map((b) => [b.pr.number, b]))
  assert.equal(byPr.get(7110).mergeGate.allowed, true)
  assert.equal(byPr.get(7200).mergeGate.allowed, false)
  assert.ok(byPr.get(7200).mergeGate.blockers.some((b) => /not approved/.test(b)))
})

test('the lane is the most urgent across branches, not the first branch\'s', () => {
  // #7110 alone is waiting (review required, green, non-draft); #7200 alone is needs-you.
  const it = lane(twoPrs({}, { mergeable: 'CONFLICTING' }))
  const lanes = it.branches.map((b) => b.lane)
  assert.deepEqual(lanes, ['waiting', 'needs-you'])
  assert.equal(it.lane, 'needs-you')
})

test('a checkout on a second branch is attributed to THAT branch by name', () => {
  const it = lane(item({
    jira: jira(),
    prs: [pr({ number: 7110, headRefName: 'PY-1-catalog' })],
    slot: { dir: '/s', branch: 'PY-1-catalog-pr2-agent-suggestions', dirty: true, dirtyCount: 3, behind: 4 },
  }))
  assert.equal(it.branches.length, 2)
  assert.ok(it.reasons.includes('catalog-pr2-agent-suggestions: uncommitted changes (3 files)'), it.reasons.join('; '))
  assert.ok(it.reasons.includes('catalog-pr2-agent-suggestions: 4 behind master'), it.reasons.join('; '))
  // and the PR branch's own reason still names the PR rather than being prefixed twice
  assert.ok(it.reasons.includes('awaiting review on #7110'), it.reasons.join('; '))
})

test('a single-branch item\'s reason text carries no branch label at all', () => {
  const it = lane(item({ jira: jira(), prs: [pr({ mergeable: 'CONFLICTING' })] }))
  assert.ok(it.reasons.includes('conflicts with master'), it.reasons.join('; '))
  assert.ok(!it.reasons.some((r) => /^#\d+: /.test(r)), 'nothing to disambiguate, so nothing is prefixed')
})

test('ticket-level reasons are said once, not once per branch', () => {
  const it = lane(twoPrs({}, {}))
  assert.equal(it.reasons.filter((r) => r === 'assigned to Colt Weiner').length, 0)
  const done = lane(item({
    jira: jira({ status: 'Done', statusCategory: 'Done', isMine: false, assignee: 'Bruce Pereira' }),
    prs: [pr({ number: 1, headRefName: 'PY-1-a' }), pr({ number: 2, headRefName: 'PY-1-b' })],
  }))
  assert.equal(done.reasons.filter((r) => r === 'ticket is Done').length, 1)
  assert.equal(done.reasons.filter((r) => r === 'assigned to Bruce Pereira').length, 1)
})

test('shortBranch drops the ticket key the card already shows', () => {
  assert.equal(shortBranch({ key: 'PY-12746' }, { name: 'PY-12746-catalog-pr2' }), 'catalog-pr2')
  assert.equal(shortBranch({ key: 'PY-12746' }, { name: 'feat/unrelated' }), 'feat/unrelated')
  assert.equal(shortBranch({ key: null }, { name: 'feat/x' }), 'feat/x')
  assert.equal(shortBranch({ key: 'PY-1' }, { name: null }), null)
})

test('a Done ticket with a sibling PR still open does not offer either checkout as reclaimable', () => {
  // Item-scoped on purpose: a sibling branch still in review means the work is not finished,
  // whichever branch the checkout happens to hold.
  const it = lane(item({
    jira: jira({ status: 'Done', statusCategory: 'Done' }),
    prs: [pr({ number: 7110, headRefName: 'PY-1-catalog' })],
    slot: { dir: '/s', branch: 'PY-1-part-two', dirty: false, behind: 0 },
  }))
  assert.equal(it.signals.reclaimable, false)
  assert.ok(!it.reasons.some((r) => /reclaimable/.test(r)))
})
