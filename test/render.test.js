// test/render.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupForDisplay } from '../public/app.js'

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

test('empty lanes are omitted', () => {
  const { lanes } = groupForDisplay([it({ id: 'A', lane: 'needs-you' })], { showBacklog: true, showStale: true })
  assert.deepEqual(lanes.map((l) => l.id), ['needs-you'])
})
