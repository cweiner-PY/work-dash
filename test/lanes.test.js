// test/lanes.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignLanes, mergeGateFor } from '../lanes.js'

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
test('To Do with a plan is ready-to-start; without one it is backlog', () => {
  const withPlan = lane(item({ jira: jira({ status: 'READY', statusCategory: 'To Do' }), plans: [{ dir: '/d', folder: 'f', key: 'PY-1', files: ['plan.md'] }] }))
  assert.equal(withPlan.lane, 'ready-to-start')
  const without = lane(item({ jira: jira({ status: 'READY', statusCategory: 'To Do' }) }))
  assert.equal(without.lane, 'backlog')
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
