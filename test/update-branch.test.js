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

// --- state-aware redesign: the user HAS an open PR, so GitHub decides what happens —
// its comparison of the branch against its base for "behind", and mergeStateStatus only
// for the conflict case it uniquely reports. NOT the local, possibly days-stale, count. ---

const behind = (n) => ({ behind: n, ahead: 1, status: n ? 'DIVERGED' : 'AHEAD', known: true })
const UNKNOWN_COMPARE = { behind: null, ahead: null, status: null, known: false }

const pr = (o = {}) => ({
  number: 7110, repo: 'O/R', headRefName: 'PY-1-x', isMine: true, mergeStateStatus: null,
  baseCompare: behind(3), ...o,
})
const itemWithPr = (p) => ({ id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: null, prs: [p] })

test('a comparison of zero refuses as a no-op, whatever the merge state says', async () => {
  for (const status of ['CLEAN', 'BLOCKED', 'UNSTABLE', 'UNKNOWN', null]) {
    let ran = 0
    const r = await updateBranch(
      { item: itemWithPr(pr({ mergeStateStatus: status, baseCompare: behind(0) })), slots: [] },
      { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
    assert.equal(ran, 0, `${status} must not run anything`)
    assert.equal(r.ok, false)
    assert.match(r.message, /up to date/i)
  }
})

// REGRESSION, live bug: #7230 was 24 commits behind master and this action refused it as
// "already up to date" because its mergeStateStatus was BLOCKED. BLOCKED and DIRTY
// outrank BEHIND, so every PR in these repos reported one of those and the action refused
// all of them — the feature never fired once.
test('BLOCKED/UNSTABLE/CLEAN with a real behind count DO run the remote update', async () => {
  for (const status of ['BLOCKED', 'UNSTABLE', 'CLEAN', 'UNKNOWN', null]) {
    const calls = []
    const r = await updateBranch(
      { item: itemWithPr(pr({ number: 7230, mergeStateStatus: status, baseCompare: behind(24) })), slots: [] },
      { run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' } } })
    assert.equal(r.ok, true, `${status}: ${r.message}`)
    assert.deepEqual(calls, ['gh pr update-branch 7230 --repo O/R'], String(status))
  }
})

test('an unknown comparison refuses rather than updating a branch of unknown position', async () => {
  for (const status of ['CLEAN', 'BLOCKED', 'UNSTABLE', 'UNKNOWN', null]) {
    let ran = 0
    const r = await updateBranch(
      { item: itemWithPr(pr({ mergeStateStatus: status, baseCompare: UNKNOWN_COMPARE })), slots: [] },
      { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
    assert.equal(ran, 0, `${status} must not run anything`)
    assert.equal(r.ok, false)
    assert.match(r.message, /isn't known yet/)
  }
})

test('BEHIND still acts when the comparison itself failed to come back', async () => {
  const calls = []
  const r = await updateBranch(
    { item: itemWithPr(pr({ mergeStateStatus: 'BEHIND', baseCompare: UNKNOWN_COMPARE })), slots: [] },
    { run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(r.ok, true, r.message)
  assert.deepEqual(calls, ['gh pr update-branch 7110 --repo O/R'])
})

test('mergeable CONFLICTING refuses locally even when the behind count is large', async () => {
  // The conflict check must come first: a conflicting branch cannot be updated
  // server-side however far behind it is, so offering the update would only fail.
  let ran = 0
  const r = await updateBranch(
    { item: itemWithPr(pr({ mergeStateStatus: 'UNKNOWN', mergeable: 'CONFLICTING', baseCompare: behind(24) })), slots: [] },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /conflicts with master/)
})

// The old test here asserted that an UNKNOWN/absent mergeStateStatus refuses with a
// retry message. That is behaviour this redesign deliberately drops: an uncomputed merge
// state is no longer a reason to refuse, because it was never the signal for "behind" in
// the first place. What must be known is the COMPARISON, and
// 'an unknown comparison refuses rather than updating a branch of unknown position'
// above covers exactly that, retry message included.

test('DIRTY refuses, naming the slot that holds the branch — server-side cannot resolve conflicts', async () => {
  let ran = 0
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'DIRTY' })), slots: [clean] },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /conflicts/i)
  assert.match(r.message, /checked out in A/)
})

test('DIRTY refuses, saying it is not checked out anywhere when no slot holds the branch', async () => {
  let ran = 0
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'DIRTY' })), slots: [] },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /not checked out anywhere/i)
})

test('BEHIND with a clean slot holding the branch: gh update-branch then git pull --ff-only, in order', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: 'ok', stderr: '' } }
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [clean] }, { run })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['gh pr update-branch 7110 --repo O/R', 'git pull --ff-only'])
  assert.match(r.message, /Updated #7110 from master/)
  assert.match(r.message, /pulled into A/)
})

test('BEHIND with no slot holding the branch: remote update only, message says not pulled locally', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: 'ok', stderr: '' } }
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [] }, { run })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['gh pr update-branch 7110 --repo O/R'])
  assert.match(r.message, /not checked out locally/)
})

test('BEHIND with a dirty slot holding the branch: remote update happens, local pull does not', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: 'ok', stderr: '' } }
  const dirty = { ...clean, dirty: true, dirtyCount: 2 }
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [dirty] }, { run })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['gh pr update-branch 7110 --repo O/R'], 'the local pull must not be attempted')
  assert.match(r.message, /uncommitted changes/i)
})

test('a failed gh pr update-branch does not attempt the local pull', async () => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    return { code: 1, stdout: '', stderr: 'GraphQL: not authorized' }
  }
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [clean] }, { run })
  assert.equal(r.ok, false)
  assert.deepEqual(calls, ['gh pr update-branch 7110 --repo O/R'])
  assert.match(r.message, /not authorized/)
})

test('a git pull that cannot fast-forward is reported, with no merge/reset/force/rebase attempted anywhere', async () => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (cmd === 'gh') return { code: 0, stdout: 'ok', stderr: '' }
    return { code: 1, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' }
  }
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [clean] }, { run })
  assert.equal(r.ok, true, 'the remote update already succeeded; the local pull is opportunistic')
  assert.match(r.message, /did not fast-forward/i)
  for (const c of calls) {
    assert.ok(!c.includes('merge'), 'must not fall back to a merge')
    assert.ok(!c.includes('reset'), 'must not reset')
    assert.ok(!c.includes('--force'), 'must not force anything')
    assert.ok(!c.includes('rebase'), 'must not rebase')
  }
})

test('BEHIND with an explicit chosenSlotDir belonging to a different repo refuses before running anything', async () => {
  let ran = 0
  const foreign = { ...clean, dir: '/w/OTHER', repo: 'X/Y' }
  const r = await updateBranch(
    { item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [foreign], chosenSlotDir: '/w/OTHER' },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(ran, 0)
  assert.equal(r.ok, false)
  assert.match(r.message, /belongs to X\/Y/)
})

test('BEHIND dry run composes both commands and runs nothing', async () => {
  let ran = false
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [clean] },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } }, dry: true })
  assert.equal(r.ok, true)
  assert.equal(ran, false)
  assert.match(r.detail, /gh pr update-branch 7110 --repo O\/R/)
  assert.match(r.detail, /git pull --ff-only/)
})

test('BEHIND dry run with no local candidate composes only the remote command', async () => {
  let ran = false
  const r = await updateBranch({ item: itemWithPr(pr({ mergeStateStatus: 'BEHIND' })), slots: [] },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } }, dry: true })
  assert.equal(r.ok, true)
  assert.equal(ran, false)
  assert.match(r.detail, /gh pr update-branch 7110 --repo O\/R/)
  assert.ok(!r.detail.includes('git pull'), 'nothing to pull into with no local checkout')
})

test('a review-requested PR (not the user\'s own) does not divert this from the old local-only path', async () => {
  // myPrOf must exclude a colleague's PR — an item carrying only one must still take the
  // local fetch+merge path, not the remote-state path.
  const calls = []
  const run = async (cmd, args) => { calls.push(args.join(' ')); return { code: 0, stdout: 'Fast-forward', stderr: '' } }
  const reviewOnly = { id: 'PY-1', key: 'PY-1', repo: 'O/R', slot: clean, prs: [pr({ isMine: false, mergeStateStatus: 'BEHIND' })] }
  const r = await updateBranch({ item: reviewOnly, slots: [clean] }, { run })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['fetch origin', 'merge origin/master'])
})
