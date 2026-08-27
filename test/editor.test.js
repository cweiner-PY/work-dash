// test/editor.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openEditor as rawOpenEditor } from '../actions/editor.js'
import { theBranch } from '../test-support/branches.js'

// openEditor acts on ONE resolved branch of an item now — the caller decides which (see
// resolveBranch). These tests describe items by PR and checkout, so the branch is resolved
// here the way routes.js resolves it: from the item's single branch.
const openEditor = (o, deps) => rawOpenEditor('branch' in o ? o : { ...o, branch: theBranch(o.item) }, deps)

const slot = { dir: '/Users/x/Work/PY-2', repo: 'O/R', branch: 'PY-12746-x', dirty: false, dirtyCount: 0 }
const item = { id: 'PY-12746', key: 'PY-12746', repo: 'O/R', slot, prs: [] }

test('opens the item\'s own checkout with the configured editor', async () => {
  const calls = []
  const r = await openEditor({ item, slots: [slot], editor: 'Cursor' },
    { run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls, [['open', '-a', 'Cursor', '/Users/x/Work/PY-2']])
  assert.match(r.message, /PY-2/)
  assert.match(r.message, /Cursor/)
})

test('honours a different editor name without any code change', async () => {
  // The point of one config string: `open -a` resolves any installed application.
  const calls = []
  await openEditor({ item, slots: [slot], editor: 'Visual Studio Code' },
    { run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' } } })
  assert.deepEqual(calls[0], ['open', '-a', 'Visual Studio Code', '/Users/x/Work/PY-2'])
})

test('runs NO git and touches nothing — it only opens a folder', async () => {
  // This action must never check out, fetch, merge or stash. It is the one action safe to
  // fire at a dirty checkout, and that is only true while it stays this narrow.
  const calls = []
  await openEditor({ item: { ...item, slot: { ...slot, dirty: true, dirtyCount: 7 } }, slots: [slot] },
    { run: async (cmd, args) => { calls.push(cmd); return { code: 0, stdout: '', stderr: '' } } })
  assert.deepEqual(calls, ['open'], 'exactly one command, and it is not git')
})

test('a dirty checkout is still openable', async () => {
  // Every other action refuses a dirty tree because it would mutate it. Opening an editor
  // is precisely what you want when there are uncommitted changes to look at.
  const dirty = { ...slot, dirty: true, dirtyCount: 7 }
  const r = await openEditor({ item: { ...item, slot: dirty }, slots: [dirty] },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  assert.equal(r.ok, true, r.message)
})

test('refuses when the item has no local checkout', async () => {
  let ran = 0
  const r = await openEditor({ item: { ...item, slot: null }, slots: [] },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /no local checkout/i)
})

test('refuses a slot that is not on the board', async () => {
  // The directory reaches `open` as an argument, so it may only ever come from the board's
  // own slot list — never from whatever the caller sent.
  let ran = 0
  const r = await openEditor({ item, slots: [slot], chosenSlotDir: '/etc' },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0, 'must not open a directory it was simply handed')
  assert.equal(r.ok, false)
  assert.match(r.message, /unknown slot/i)
})

test('refuses a slot belonging to a different repo', async () => {
  let ran = 0
  const foreign = { ...slot, dir: '/Users/x/Work/Logan', repo: 'X/Y' }
  const r = await openEditor({ item, slots: [slot, foreign], chosenSlotDir: '/Users/x/Work/Logan' },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /belongs to X\/Y/)
})

test('an explicit slot on the board and in the right repo is honoured', async () => {
  // Positive control: the guards above must not reject legitimate choices too.
  const sibling = { ...slot, dir: '/Users/x/Work/PY-3' }
  const calls = []
  const r = await openEditor({ item, slots: [slot, sibling], chosenSlotDir: '/Users/x/Work/PY-3' },
    { run: async (cmd, args) => { calls.push(args.at(-1)); return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls, ['/Users/x/Work/PY-3'])
})

test('a failed launch is reported, not silently swallowed', async () => {
  const r = await openEditor({ item, slots: [slot], editor: 'NotInstalled' },
    { run: async () => ({ code: 1, stdout: '', stderr: "Unable to find application named 'NotInstalled'" }) })
  assert.equal(r.ok, false)
  assert.match(r.message, /NotInstalled/)
  assert.match(r.message, /Unable to find application/)
})

test('dry run runs nothing and shows the command', async () => {
  let ran = 0
  const r = await openEditor({ item, slots: [slot], editor: 'Cursor' },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } }, dry: true })
  assert.equal(ran, 0)
  assert.equal(r.ok, true)
  assert.match(r.detail, /open -a Cursor \/Users\/x\/Work\/PY-2/)
})
