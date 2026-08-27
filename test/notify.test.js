// test/notify.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newlyNeedsYou, notificationFor, displayNotification, notifyLaneChanges } from '../util/notify.js'

const item = (id, lane, o = {}) => ({ id, key: id, lane, reasons: [], ...o })

test('the first collection notifies nothing', async () => {
  // prev === null is process start. Without this guard, launching the dashboard would fire
  // a notification for every item already needing attention — the loudest possible way to
  // make the feature useless.
  const before = [item('PY-1', 'needs-you'), item('PY-2', 'needs-you')]
  assert.deepEqual(newlyNeedsYou(null, before), [])
  let ran = 0
  const r = await notifyLaneChanges(null, before, { run: async () => { ran++; return { code: 0 } } })
  assert.equal(ran, 0)
  assert.deepEqual(r.notified, [])
})

test('an item entering needs-you is news', () => {
  const prev = [item('PY-1', 'in-flight')]
  const next = [item('PY-1', 'needs-you')]
  assert.deepEqual(newlyNeedsYou(prev, next).map((i) => i.id), ['PY-1'])
})

test('an item ALREADY in needs-you is not news again', () => {
  // The poll runs every minute; re-announcing the same item 60 times an hour would train
  // the user to ignore the notifications entirely.
  const prev = [item('PY-1', 'needs-you')]
  assert.deepEqual(newlyNeedsYou(prev, [item('PY-1', 'needs-you')]), [])
})

test('an item that leaves and comes back IS news again', () => {
  const gone = newlyNeedsYou([item('PY-1', 'needs-you')], [item('PY-1', 'in-flight')])
  assert.deepEqual(gone, [])
  const back = newlyNeedsYou([item('PY-1', 'in-flight')], [item('PY-1', 'needs-you')])
  assert.deepEqual(back.map((i) => i.id), ['PY-1'], 'a check going red twice is news twice')
})

test('an item leaving needs-you notifies nothing', () => {
  assert.deepEqual(newlyNeedsYou([item('PY-1', 'needs-you')], [item('PY-1', 'waiting')]), [])
})

test('a brand new item straight into needs-you is news', () => {
  assert.deepEqual(newlyNeedsYou([], [item('PY-9', 'needs-you')]).map((i) => i.id), ['PY-9'])
})

test('one item is announced with its reason, which is the actionable part', () => {
  const note = notificationFor([item('PY-13751', 'needs-you', { reasons: ['required check failing: QA Code Review'] })])
  assert.match(note.title, /needs you/)
  assert.equal(note.message, 'PY-13751 — required check failing: QA Code Review')
})

test('several items are one roll-call, not one notification each', () => {
  const note = notificationFor([
    item('PY-1', 'needs-you', { reasons: ['a'] }),
    item('PY-2', 'needs-you', { reasons: ['b'] }),
    item('PY-3', 'needs-you', { reasons: ['c'] }),
  ])
  assert.match(note.title, /3 need you/)
  assert.equal(note.message, 'PY-1, PY-2, PY-3')
})

test('a keyless item falls back to its id', () => {
  // Local checkouts with no ticket have no key — repo:branch is their identity.
  const note = notificationFor([{ id: 'PerformYard/Logan:update-churn-agent-prompt', lane: 'needs-you' }])
  assert.match(note.message, /update-churn-agent-prompt/)
  assert.match(note.message, /needs you/, 'and gets a default reason rather than "undefined"')
})

test('an empty set produces no notification at all', () => {
  assert.equal(notificationFor([]), null)
  assert.equal(notificationFor(undefined), null)
})

test('the text is passed as ARGUMENTS, never interpolated into the AppleScript', async () => {
  // Ticket summaries carry quotes, backslashes and em-dashes. Text that never becomes part
  // of the script source has no escaping to get wrong.
  const nasty = 'PY-1 — check "QA" failed \\ again'
  let seen = null
  await displayNotification({ title: 'work-dash', message: nasty },
    { run: async (cmd, args) => { seen = { cmd, args }; return { code: 0 } } })
  assert.equal(seen.cmd, 'osascript')
  assert.equal(seen.args.at(-2), nasty, 'the message is its own argv entry, verbatim')
  assert.equal(seen.args.at(-1), 'work-dash')
  // No -e fragment may contain the payload; that would mean it was interpolated.
  for (const a of seen.args.filter((x) => x.startsWith('-e') || x.includes('display notification'))) {
    assert.ok(!a.includes('QA'), `payload leaked into script source: ${a}`)
  }
  assert.ok(seen.args.some((a) => a.includes('item 1 of argv')), 'the script must read from argv')
})

test('notifications can be switched off entirely', async () => {
  let ran = 0
  const r = await notifyLaneChanges([item('PY-1', 'waiting')], [item('PY-1', 'needs-you')],
    { run: async () => { ran++; return { code: 0 } }, enabled: false })
  assert.equal(ran, 0)
  assert.deepEqual(r.notified, [])
})

test('a failed osascript is reported, not thrown', async () => {
  // The board response must never depend on a notification succeeding.
  const r = await notifyLaneChanges([item('PY-1', 'waiting')], [item('PY-1', 'needs-you')],
    { run: async () => ({ code: 1, stderr: 'not permitted' }) })
  assert.equal(r.ok, false)
  assert.deepEqual(r.notified, ['PY-1'])
})
