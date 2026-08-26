// test/render.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupForDisplay, sourceChip, prChecksChip, summarizeSubtasks } from '../public/app.js'

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

test('default filter hides backlog, ready-to-start and stale items', () => {
  const { lanes, hidden } = groupForDisplay(items, { showBacklog: false, showStale: false })
  const shown = lanes.flatMap((l) => l.subgroups ? l.subgroups.flatMap((s) => s.items) : l.items).map((i) => i.id)
  assert.deepEqual(shown.sort(), ['A', 'B', 'C', 'D', 'E'])
  assert.equal(hidden.backlog, 2)   // G and H
  assert.equal(hidden.stale, 1)     // F
  assert.equal(hidden.total, 3)
})

test('showBacklog reveals backlog and ready-to-start', () => {
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
