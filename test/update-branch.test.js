// test/update-branch.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { updateBranch } from '../actions/update-branch.js'

const item = { id: 'PY-1', key: 'PY-1', repo: 'O/R', prs: [], slot: null }
const clean = { dir: '/w/A', repo: 'O/R', branch: 'PY-1-x', dirty: false, dirtyCount: 0, behind: 13, ahead: 6 }

test('fetches then merges origin/master', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push(args.join(' ')); return { code: 0, stdout: 'Fast-forward', stderr: '' } }
  const r = await updateBranch({ item: { ...item, slot: clean }, slots: [clean] }, { run })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['fetch origin', 'merge origin/master'])  // default base
})

test('merges the CONFIGURED default branch, not a hardcoded master', async () => {
  // slots.js measures "N behind" against origin/<defaultBranch>. If this button merged
  // something else, the count on the card and the action that clears it would disagree.
  const calls = []
  const run = async (cmd, args) => { calls.push(args.join(' ')); return { code: 0, stdout: '', stderr: '' } }
  const r = await updateBranch(
    { item: { ...item, slot: clean }, slots: [clean], defaultBranch: 'trunk' }, { run })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['fetch origin', 'merge origin/trunk'])
  assert.match(r.message, /origin\/trunk/)
  assert.ok(!calls.some((c) => c.includes('origin/master')), 'must not fall back to master')
})

test('refuses when the working tree is dirty', async () => {
  let ran = false
  const dirty = { ...clean, dirty: true, dirtyCount: 3 }
  const r = await updateBranch({ item: { ...item, slot: dirty }, slots: [dirty] },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(r.ok, false)
  assert.match(r.message, /3 uncommitted/)
  assert.equal(ran, false, 'must not run any git command')
})

test('fails CLOSED on ambiguous dirty state', async () => {
  // A slot object whose `dirty` is missing or non-boolean must be treated as dirty.
  // Omit dirty/dirtyCount from the base first: spreading `bad` after the full `clean`
  // fixture could never make `{}` mean "missing" since clean already sets dirty: false.
  const { dirty, dirtyCount, ...base } = clean
  for (const bad of [{}, { dirty: undefined }, { dirty: null }, { dirty: 0 }, { dirty: false, dirtyCount: 3 }]) {
    let ran = 0
    const slot = { ...base, ...bad }
    const r = await updateBranch({ item: { ...item, slot }, slots: [slot] },
      { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
    assert.equal(ran, 0, `slot ${JSON.stringify(bad)} must not run git`)
    assert.equal(r.ok, false)
  }
})

test('refuses a slot belonging to a different repo', async () => {
  let ran = 0
  const foreign = { ...clean, dir: '/w/OTHER', repo: 'X/Y' }
  const r = await updateBranch(
    { item: { ...item, slot: clean }, slots: [clean, foreign], chosenSlotDir: '/w/OTHER' },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /belongs to X\/Y/)
})

test('reports a conflict without aborting', async () => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push(args.join(' '))
    if (args[0] === 'merge') return { code: 1, stdout: 'CONFLICT (content): Merge conflict in a.ts', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  const r = await updateBranch({ item: { ...item, slot: clean }, slots: [clean] }, { run })
  assert.equal(r.ok, false)
  assert.match(r.message, /conflict/i)
  assert.ok(!calls.some((c) => c.includes('abort')), 'must not abort the merge')
  assert.ok(!calls.some((c) => c.includes('stash')), 'must not stash')
})

test('never rebases or force-pushes', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push(args.join(' ')); return { code: 0, stdout: '', stderr: '' } }
  await updateBranch({ item: { ...item, slot: clean }, slots: [clean] }, { run })
  for (const c of calls) {
    assert.ok(!c.includes('rebase'), 'must not rebase')
    assert.ok(!c.includes('push'), 'must not push')
    assert.ok(!c.includes('--force'), 'must not force anything')
  }
})

test('reports a fetch failure and does not attempt the merge', async () => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push(args[0])
    return args[0] === 'fetch' ? { code: 128, stdout: '', stderr: 'network unreachable' } : { code: 0, stdout: '', stderr: '' }
  }
  const r = await updateBranch({ item: { ...item, slot: clean }, slots: [clean] }, { run })
  assert.equal(r.ok, false)
  assert.match(r.message, /network unreachable/)
  assert.deepEqual(calls, ['fetch'])
})

test('errors when the item has no slot', async () => {
  const r = await updateBranch({ item, slots: [] }, { run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  assert.equal(r.ok, false)
  assert.match(r.message, /no checkout/i)
})

test('dry run runs nothing', async () => {
  let ran = false
  const r = await updateBranch({ item: { ...item, slot: clean }, slots: [clean] },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } }, dry: true })
  assert.equal(r.ok, true)
  assert.equal(ran, false)
  assert.match(r.detail, /git merge origin\/master/)
})
