// test/render.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupForDisplay, sourceChip, prChecksChip, summarizeSubtasks, updateBranchSpec, hasBranch, needsRepoChoice, repoLabel } from '../public/app.js'

const it = (o) => ({ id: o.id, lane: o.lane, statusGroup: o.statusGroup ?? 'no ticket',
  sortIndex: o.sortIndex ?? Infinity, signals: { foreign: false, stale: false, reclaimable: false, ...o.signals },
  reasons: [], prs: [], plans: [], slot: null, jira: null, mergeGate: { allowed: false, blockers: [] }, ...o })

const items = [
  it({ id: 'A', lane: 'needs-you' }),
  it({ id: 'B', lane: 'waiting' }),
  it({ id: 'C', lane: 'in-flight', statusGroup: 'Ready To Test', sortIndex: 2 }),
  it({ id: 'D', lane: 'in-flight', statusGroup: 'In Progress', sortIndex: 0 }),
  it({ id: 'E', lane: 'in-flight', statusGroup: 'no ticket', sortIndex: Infinity }),
  it({ id: 'F', lane: 'in-flight', statusGroup: 'Done', sortIndex: Infinity, signals: { stale: true } }),
  it({ id: 'G', lane: 'backlog' }),
  it({ id: 'H', lane: 'ready-to-start' }),
]

test('default filter hides backlog and stale items, but SHOWS ready-to-start', () => {
  // Sprint-committed work the user has not started belongs in view by default —
  // only backlog stays behind its toggle.
  const { lanes, hidden } = groupForDisplay(items, { showBacklog: false, showStale: false })
  const shown = lanes.flatMap((l) => l.subgroups ? l.subgroups.flatMap((s) => s.items) : l.items).map((i) => i.id)
  assert.deepEqual(shown.sort(), ['A', 'B', 'C', 'D', 'E', 'H'])
  assert.equal(hidden.backlog, 1)   // G only
  assert.equal(hidden.stale, 1)     // F
  assert.equal(hidden.total, 2)
  // every item is either shown or accounted for as hidden
  assert.equal(shown.length + hidden.total, items.length)
})

test('ready-to-start is shown even with showBacklog off; showBacklog only reveals backlog', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: false, showStale: false })
  const ids = lanes.flatMap((l) => l.subgroups ? l.subgroups.flatMap((s) => s.items) : l.items).map((i) => i.id)
  assert.ok(ids.includes('H'), 'ready-to-start item must be visible by default')
  assert.ok(!ids.includes('G'), 'backlog item must still be hidden by default')
})

test('showBacklog reveals backlog (ready-to-start was already shown)', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: true, showStale: false })
  const ids = lanes.flatMap((l) => l.subgroups ? l.subgroups.flatMap((s) => s.items) : l.items).map((i) => i.id)
  assert.ok(ids.includes('G'))
  assert.ok(ids.includes('H'))
  assert.ok(!ids.includes('F'))
})

test('lane order is fixed', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: true, showStale: true })
  assert.deepEqual(lanes.map((l) => l.id),
    ['needs-you', 'waiting', 'in-flight', 'ready-to-start', 'backlog'])
})

test('in-flight subgroups are ordered by sortIndex with "no ticket" last', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: false, showStale: true })
  const inflight = lanes.find((l) => l.id === 'in-flight')
  assert.deepEqual(inflight.subgroups.map((s) => s.label),
    ['In Progress', 'Ready To Test', 'Done', 'no ticket'])
})

test('an item with an unrecognised lane is SHOWN, never silently dropped', () => {
  const odd = it({ id: 'ODD', lane: 'some-future-lane' })
  const { lanes, hidden } = groupForDisplay([it({ id: 'A', lane: 'needs-you' }), odd],
    { showBacklog: true, showStale: true })
  const shown = lanes.flatMap((l) => l.items ?? l.subgroups.flatMap((s) => s.items)).map((i) => i.id)
  assert.ok(shown.includes('ODD'), 'the orphan must appear somewhere')
  assert.equal(shown.length + hidden.total, 2, 'every item is either shown or counted as hidden')
  const other = lanes.find((l) => l.id === 'other')
  assert.ok(other, 'a catch-all lane exists')
  assert.equal(other.label, 'Other (unrecognised lane)')
})

test('the catch-all lane is absent when every lane is recognised', () => {
  const { lanes } = groupForDisplay([it({ id: 'A', lane: 'needs-you' })],
    { showBacklog: true, showStale: true })
  assert.equal(lanes.find((l) => l.id === 'other'), undefined)
})

test('empty lanes are omitted', () => {
  const { lanes } = groupForDisplay([it({ id: 'A', lane: 'needs-you' })], { showBacklog: true, showStale: true })
  assert.deepEqual(lanes.map((l) => l.id), ['needs-you'])
})

test('a needs-you item is never hidden by the default filter, even when stale or foreign', () => {
  const staleNeedsYou = it({ id: 'NY', lane: 'needs-you', signals: { stale: true } })
  const foreignNeedsYou = it({ id: 'NY2', lane: 'needs-you', signals: { foreign: true } })
  const staleInFlight = it({ id: 'IF', lane: 'in-flight', statusGroup: 'Done', signals: { stale: true } })
  const { lanes, hidden } = groupForDisplay(
    [staleNeedsYou, foreignNeedsYou, staleInFlight],
    { showBacklog: false, showStale: false }
  )
  const shown = lanes.flatMap((l) => l.items ?? l.subgroups.flatMap((s) => s.items)).map((i) => i.id)
  assert.ok(shown.includes('NY'), 'a stale needs-you item must still be shown')
  assert.ok(shown.includes('NY2'), 'a foreign needs-you item must still be shown')
  assert.ok(!shown.includes('IF'), 'a stale item in another lane is still hidden by default')
  // only the in-flight item was withheld — the two needs-you items count as shown, not hidden
  assert.equal(hidden.stale, 1)
  assert.equal(hidden.total, 1)
})

test('sourceChip: a healthy source (ok, no error) renders the ok class', () => {
  const { cls, text, error } = sourceChip('jira', { ok: true, error: null, count: 12 })
  assert.equal(cls, 'ok')
  assert.equal(text, 'jira 12')
  assert.equal(error, null)
})

test('sourceChip: ok:true with a non-null error is DEGRADED (warn), and the error text is real data, not only a title', () => {
  const { cls, text, error } = sourceChip('slots', { ok: true, error: 'PY-1 is not a git repo', count: 5 })
  assert.equal(cls, 'warn', 'a degraded source must not render identically to a healthy one')
  assert.ok(text.includes('(degraded)'))
  // The error string itself is returned as plain data the caller can render as visible
  // text (e.g. into a .src-errors block) — not something only reachable via a title attr.
  assert.equal(error, 'PY-1 is not a git repo')
})

test('sourceChip: ok:false renders the bad class regardless of error', () => {
  const { cls, text } = sourceChip('github', { ok: false, error: '401 Unauthorized', count: 0 })
  assert.equal(cls, 'bad')
  assert.equal(text, 'github unavailable')
})

test('prChecksChip: known:false shows "check status unknown", never the confident "no required checks"', () => {
  const { cls, text } = prChecksChip({ total: 0, failing: [], known: false })
  assert.equal(cls, 'bad')
  assert.equal(text, 'check status unknown')
})

test('prChecksChip: known:true with no checks configured is the real "no required checks"', () => {
  const { cls, text } = prChecksChip({ total: 0, failing: [], pending: [], known: true })
  assert.equal(cls, 'ok')
  assert.equal(text, 'no required checks')
})

test('prChecksChip: a failing check wins over a pending one', () => {
  const { cls, text } = prChecksChip({ total: 2, failing: ['Linting'], pending: ['Unit Tests'], known: true })
  assert.equal(cls, 'bad')
  assert.equal(text, 'required failing: Linting')
})

test('prChecksChip: a pending check with nothing failing is "running", not a failure', () => {
  const { cls, text } = prChecksChip({ total: 1, failing: [], pending: ['Unit Tests'], known: true })
  assert.equal(cls, 'warn')
  assert.equal(text, 'required 1 running')
})

// --- summarizeSubtasks ---

const st = (key, statusCategory) => ({ key, summary: key, status: statusCategory, statusCategory, issuetype: 'UI/UX Sub-Task', assignee: 'Colt Weiner' })

test('summarizeSubtasks: counts open vs done and total, regardless of input order', () => {
  const subtasks = [st('A', 'Done'), st('B', 'In Progress'), st('C', 'To Do'), st('D', 'Done')]
  const s = summarizeSubtasks(subtasks)
  assert.equal(s.total, 4)
  assert.equal(s.open, 2)
  assert.equal(s.done, 2)
})

test('summarizeSubtasks: openList holds only the non-Done ones, doneList only the Done ones', () => {
  const subtasks = [st('A', 'Done'), st('B', 'In Progress'), st('C', 'To Do'), st('D', 'Done')]
  const s = summarizeSubtasks(subtasks)
  assert.deepEqual(s.openList.map((x) => x.key), ['B', 'C'])
  assert.deepEqual(s.doneList.map((x) => x.key), ['A', 'D'])
})

test('summarizeSubtasks: an all-done set', () => {
  const subtasks = [st('A', 'Done'), st('B', 'Done')]
  const s = summarizeSubtasks(subtasks)
  assert.equal(s.open, 0)
  assert.equal(s.done, 2)
  assert.equal(s.total, 2)
  assert.deepEqual(s.openList, [])
  assert.equal(s.doneList.length, 2)
})

test('summarizeSubtasks: an empty set', () => {
  const s = summarizeSubtasks([])
  assert.deepEqual(s, { open: 0, done: 0, total: 0, openList: [], doneList: [] })
})

// --- updateBranchSpec ---

test('updateBranchSpec: BEHIND is enabled with the plain "update branch" label', () => {
  const spec = updateBranchSpec({ slot: null }, { number: 1, mergeStateStatus: 'BEHIND' })
  assert.equal(spec.disabled, false)
  assert.equal(spec.label, 'update branch')
})

test('updateBranchSpec: DIRTY is disabled, labelled to resolve locally, with a reason in the title', () => {
  const spec = updateBranchSpec({ slot: null }, { number: 42, mergeStateStatus: 'DIRTY' })
  assert.equal(spec.disabled, true)
  assert.match(spec.label, /resolve conflicts locally/)
  assert.match(spec.title, /#42/)
})

test('updateBranchSpec: CLEAN, BLOCKED and UNSTABLE are all disabled and labelled "up to date"', () => {
  for (const mergeStateStatus of ['CLEAN', 'BLOCKED', 'UNSTABLE']) {
    const spec = updateBranchSpec({ slot: null }, { number: 1, mergeStateStatus })
    assert.equal(spec.disabled, true, mergeStateStatus)
    assert.equal(spec.label, 'up to date', mergeStateStatus)
  }
})

test('updateBranchSpec: UNKNOWN and a missing mergeStateStatus are disabled and labelled "state unknown"', () => {
  for (const mergeStateStatus of ['UNKNOWN', null, undefined]) {
    const spec = updateBranchSpec({ slot: null }, { number: 1, mergeStateStatus })
    assert.equal(spec.disabled, true)
    assert.equal(spec.label, 'state unknown')
  }
})

test('updateBranchSpec: no PR falls back to the local behind count, relabelled as stale', () => {
  const spec = updateBranchSpec({ slot: { behind: 13, dirty: false, dirtyCount: 0 } }, null)
  assert.equal(spec.disabled, false)
  assert.match(spec.label, /13 behind/)
  assert.match(spec.label, /as of last fetch/, 'the stale local count must be labelled as such, never presented as current')
})

test('updateBranchSpec: no PR and no slot means nothing to show', () => {
  assert.equal(updateBranchSpec({ slot: null }, null), null)
})

test('updateBranchSpec: no PR and a dirty slot is disabled with the uncommitted-count title', () => {
  const spec = updateBranchSpec({ slot: { behind: 0, dirty: true, dirtyCount: 3 } }, null)
  assert.equal(spec.disabled, true)
  assert.match(spec.title, /3 uncommitted/)
})

// --- hasBranch / needsRepoChoice / repoLabel ---

test('hasBranch: true from the user\'s own PR headRefName', () => {
  assert.equal(hasBranch({ prs: [{ isMine: true, headRefName: 'PY-1-x' }], slot: null }), true)
})

test('hasBranch: a colleague\'s review-requested PR does not count', () => {
  assert.equal(hasBranch({ prs: [{ isMine: false, headRefName: 'PY-1-bruce' }], slot: null }), false)
})

test('hasBranch: falls back to the slot\'s branch', () => {
  assert.equal(hasBranch({ prs: [], slot: { branch: 'PY-1-x' } }), true)
})

test('hasBranch: false with no PR of the user\'s and no slot', () => {
  assert.equal(hasBranch({ prs: [], slot: null }), false)
})

test('needsRepoChoice: true only when both branchless AND repo-less', () => {
  assert.equal(needsRepoChoice({ prs: [], slot: null, repo: null }), true)
  assert.equal(needsRepoChoice({ prs: [], slot: null, repo: 'O/R' }), false, 'a known repo keeps today\'s single button')
  assert.equal(needsRepoChoice({ prs: [{ isMine: true, headRefName: 'b' }], slot: null, repo: null }), false, 'a known branch keeps today\'s single button')
})

test('repoLabel: uses docsSubdir when configured', () => {
  const config = { repos: { 'PerformYard/Logan': { docsSubdir: 'Logan' } } }
  assert.equal(repoLabel(config, 'PerformYard/Logan'), 'Logan')
})

test('repoLabel: falls back to the full repo key when docsSubdir is unset', () => {
  const config = { repos: { 'Owner/Repo': {} } }
  assert.equal(repoLabel(config, 'Owner/Repo'), 'Owner/Repo')
})
