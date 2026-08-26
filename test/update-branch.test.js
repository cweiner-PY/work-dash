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
  assert.deepEqual(calls, ['fetch origin', 'merge origin/master'])
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
