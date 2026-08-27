// test/worktree.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import {
  checkoutMode, worktreeRoot, repoRootFor, slugFor, worktreePathFor,
  parseWorktreeList, prunableWorktrees, planWorktree, pruneWorktrees,
  DEFAULT_WORKTREE_MAX_AGE_MS,
} from '../actions/worktree.js'
import { resolveSlot } from '../actions/slot.js'
import { buildLauncher, openItem } from '../actions/open.js'

const REPO = 'PerformYard/Logan'
const wtConfig = {
  checkoutMode: 'worktrees',
  worktreeRoot: '/wt',
  docsDir: '/docs',
  repos: { [REPO]: { root: '/clones/Logan', defaultBranch: 'master' } },
}

// --- mode selection --------------------------------------------------------------------

test('checkoutMode defaults to slots, and an unrecognised value does NOT switch modes', () => {
  // Silently changing how the tool touches your repositories on a typo is not acceptable.
  assert.equal(checkoutMode({}), 'slots')
  assert.equal(checkoutMode(undefined), 'slots')
  assert.equal(checkoutMode({ checkoutMode: 'slots' }), 'slots')
  assert.equal(checkoutMode({ checkoutMode: 'worktrees' }), 'worktrees')
  for (const bad of ['wortrees', 'worktree', 'WORKTREES', '', null, 1, true]) {
    assert.equal(checkoutMode({ checkoutMode: bad }), 'slots', JSON.stringify(bad))
  }
})

test('worktreeRoot defaults under the user cache directory', () => {
  assert.equal(worktreeRoot({ worktreeRoot: '/x' }), '/x')
  assert.ok(worktreeRoot({}).startsWith(homedir()))
})

test('repoRootFor prefers an explicit root, then falls back to the first slot', () => {
  // The fallback is what lets a config written for slots mode work in worktree mode
  // without being rewritten.
  assert.equal(repoRootFor({ repos: { R: { root: '/a', slots: ['/b'] } } }, 'R'), '/a')
  assert.equal(repoRootFor({ repos: { R: { slots: ['/b', '/c'] } } }, 'R'), '/b')
  assert.equal(repoRootFor({ repos: { R: {} } }, 'R'), null)
  assert.equal(repoRootFor({ repos: {} }, 'R'), null)
})

// --- path derivation -------------------------------------------------------------------

test('slugFor makes a branch name safe as a directory, and keeps distinct branches distinct', () => {
  assert.match(slugFor('feat/salesforce-source-of-truth'), /^feat-salesforce-source-of-truth-[a-z0-9]+$/)
  // Slashes and dots cannot survive as-is, and a case-insensitive filesystem would collide
  // two branches that differ only in case — hence the hash suffix.
  assert.notEqual(slugFor('Feature/A'), slugFor('feature/a'))
  assert.notEqual(slugFor('a/b'), slugFor('a-b'))
  assert.ok(!slugFor('a/b/c').includes('/'))
  assert.ok(slugFor('').length > 0, 'even an empty name must produce a usable directory')
  assert.ok(slugFor('x'.repeat(300)).length < 80, 'and a long one must stay a legal filename')
})

test('slugFor is stable, so relaunching reuses one worktree instead of making another', () => {
  assert.equal(slugFor('PY-1-thing'), slugFor('PY-1-thing'))
})

test('worktreePathFor groups by REPO name, not by which clone is the root', () => {
  const a = worktreePathFor(wtConfig, REPO, 'b')
  const b = worktreePathFor({ ...wtConfig, repos: { [REPO]: { root: '/somewhere/else' } } }, REPO, 'b')
  assert.equal(a, b, 'changing the source clone must not move existing worktrees')
  assert.ok(a.startsWith('/wt/Logan/'))
})

// --- porcelain parsing -----------------------------------------------------------------

test('parseWorktreeList reads the real porcelain format', () => {
  // Verified against `git worktree list --porcelain` in a live checkout.
  const stdout = [
    'worktree /Users/x/Work/PY-2',
    'HEAD 1abb97d061630b7138fd5dd73af03d336f5e66cf',
    'branch refs/heads/PY-12746-competency-management',
    '',
    'worktree /wt/Logan/detached-abc',
    'HEAD efbf1a3ab12523cdb702e60f272b31ffa55b811f',
    'detached',
    '',
  ].join('\n')
  assert.deepEqual(parseWorktreeList(stdout), [
    { dir: '/Users/x/Work/PY-2', branch: 'PY-12746-competency-management', detached: false, bare: false },
    { dir: '/wt/Logan/detached-abc', branch: null, detached: true, bare: false },
  ])
})

test('parseWorktreeList flags a bare repo and survives junk', () => {
  assert.deepEqual(parseWorktreeList('worktree /r\nbare\n'),
    [{ dir: '/r', branch: null, detached: false, bare: true }])
  for (const junk of ['', '\n\n', 'HEAD abc\nbranch refs/heads/x']) {
    assert.deepEqual(parseWorktreeList(junk), [], JSON.stringify(junk))
  }
  assert.deepEqual(parseWorktreeList(undefined), [])
})

// --- pruning ---------------------------------------------------------------------------

const OLD = 1_000_000
const NOW = OLD + DEFAULT_WORKTREE_MAX_AGE_MS + 1

test('prunableWorktrees takes only ours, clean, and old', () => {
  const slots = [
    { dir: '/wt/Logan/old-clean', dirty: false, dirtyCount: 0, mtimeMs: OLD },
    { dir: '/wt/Logan/new-clean', dirty: false, dirtyCount: 0, mtimeMs: NOW - 1000 },
    { dir: '/wt/Logan/old-dirty', dirty: true, dirtyCount: 3, mtimeMs: OLD },
    { dir: '/clones/Logan', dirty: false, dirtyCount: 0, mtimeMs: OLD },   // the main clone
  ]
  assert.deepEqual(prunableWorktrees(slots, { config: wtConfig, now: NOW }), ['/wt/Logan/old-clean'])
})

test('prunableWorktrees NEVER selects a dirty worktree, however old', () => {
  // It may hold the only copy of someone's work. Fail-closed on ambiguity too.
  for (const dirt of [{ dirty: true, dirtyCount: 0 }, { dirty: false, dirtyCount: 2 },
                      { dirty: undefined, dirtyCount: 0 }, { dirtyCount: 1 }]) {
    const slots = [{ dir: '/wt/Logan/x', mtimeMs: OLD, ...dirt }]
    assert.deepEqual(prunableWorktrees(slots, { config: wtConfig, now: NOW }), [], JSON.stringify(dirt))
  }
})

test('prunableWorktrees skips a worktree whose age is unknown', () => {
  for (const mtimeMs of [null, undefined, NaN, 'old']) {
    assert.deepEqual(prunableWorktrees([{ dir: '/wt/Logan/x', dirty: false, dirtyCount: 0, mtimeMs }],
      { config: wtConfig, now: NOW }), [])
  }
})

test('pruneWorktrees removes from the source clone and reports what went', async () => {
  const calls = []
  const slots = [
    { dir: '/wt/Logan/old', repo: REPO, dirty: false, dirtyCount: 0, mtimeMs: OLD },
    { dir: '/wt/Logan/new', repo: REPO, dirty: false, dirtyCount: 0, mtimeMs: NOW },
  ]
  const removed = await pruneWorktrees(slots, wtConfig, {
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' } },
    now: NOW,
  })
  assert.deepEqual(removed, ['/wt/Logan/old'])
  assert.deepEqual(calls, ['git -C /clones/Logan worktree remove /wt/Logan/old'])
})

test('a failed removal is not reported as removed', async () => {
  const slots = [{ dir: '/wt/Logan/old', repo: REPO, dirty: false, dirtyCount: 0, mtimeMs: OLD }]
  const removed = await pruneWorktrees(slots, wtConfig, {
    run: async () => ({ code: 1, stdout: '', stderr: 'contains modified files' }), now: NOW,
  })
  assert.deepEqual(removed, [], 'git refusing a dirty worktree is the second safety net')
})

// --- planning and resolution -----------------------------------------------------------

const itemWithBranch = {
  id: 'PY-1', key: 'PY-1', repo: REPO, slot: null, plans: [],
  prs: [{ number: 704, isMine: true, headRefName: 'feat/x' }],
}

test('planWorktree reuses an existing worktree already on the branch', () => {
  const existing = { dir: '/wt/Logan/feat-x-abc', repo: REPO, branch: 'feat/x', dirty: false, dirtyCount: 0 }
  const plan = planWorktree(itemWithBranch, [existing], wtConfig, { branch: 'feat/x' })
  assert.equal(plan.create, false, 'relaunching must not create a second worktree')
  assert.equal(plan.slot, existing)
  assert.equal(plan.alreadyOnBranch, true)
})

test('planWorktree plans a new worktree at origin/<branch> when there is none', () => {
  const plan = planWorktree(itemWithBranch, [], wtConfig, { branch: 'feat/x' })
  assert.equal(plan.create, true)
  assert.equal(plan.base, 'origin/feat/x', "a new worktree holds the PR's code, not master")
  assert.equal(plan.root, '/clones/Logan')
  assert.ok(plan.slot.dir.startsWith('/wt/Logan/'))
  assert.equal(plan.slot.dirty, false, 'a directory that does not exist yet cannot be dirty')
})

test('planWorktree uses the default branch for a ticket with no branch yet', () => {
  const todo = { id: 'PY-9', key: 'PY-9', repo: REPO, slot: null, plans: [], prs: [] }
  const plan = planWorktree(todo, [], wtConfig, { branch: null })
  assert.equal(plan.base, 'origin/master')
  assert.ok(plan.slot.dir.includes('py-9'), 'named after the ticket, since there is no branch')
})

test('planWorktree honours a per-repo defaultBranch', () => {
  const cfg = { ...wtConfig, repos: { [REPO]: { root: '/c', defaultBranch: 'trunk' } } }
  const todo = { id: 'PY-9', key: 'PY-9', repo: REPO, slot: null, plans: [], prs: [] }
  assert.equal(planWorktree(todo, [], cfg, { branch: null }).base, 'origin/trunk')
})

test('planWorktree refuses when no clone exists to create worktrees from', () => {
  const cfg = { ...wtConfig, repos: { [REPO]: {} } }
  const plan = planWorktree(itemWithBranch, [], cfg, { branch: 'feat/x' })
  assert.match(plan.error, /No clone configured/)
  assert.match(plan.error, /root/, 'and says which key to set')
})

test('planWorktree asks which repo when the ticket names none', () => {
  const plan = planWorktree({ id: 'X', key: 'X', prs: [], plans: [] }, [], wtConfig, {})
  assert.equal(plan.needsRepo, true)
})

test('resolveSlot routes to worktrees only when the mode says so', () => {
  const slotsCfg = { repos: { [REPO]: { slots: ['/w/A'] } } }
  const pool = [{ dir: '/w/A', repo: REPO, branch: 'master', dirty: false, dirtyCount: 0 }]
  // Slots mode: unchanged, picks from the pool.
  assert.equal(resolveSlot(itemWithBranch, pool, slotsCfg, {}).slot.dir, '/w/A')
  // Worktree mode: plans a path instead.
  const wt = resolveSlot(itemWithBranch, [], wtConfig, {})
  assert.equal(wt.create, true)
  assert.ok(wt.slot.dir.startsWith('/wt/Logan/'))
})

test('worktree mode ignores slot claims, so relaunching the same item is not refused', () => {
  // Claims exist to stop two different items grabbing one pooled slot. A worktree path is
  // derived from the branch, so collision is impossible — and refusing the second launch on
  // the SAME item would be a bug, not a safeguard.
  const existing = { dir: '/wt/Logan/feat-x-abc', repo: REPO, branch: 'feat/x', dirty: false, dirtyCount: 0 }
  const r = resolveSlot(itemWithBranch, [existing], wtConfig, { claimedDirs: new Set([existing.dir]) })
  assert.equal(r.slot, existing)
  assert.ok(!r.needsPicker)
})

// --- the launcher ----------------------------------------------------------------------

test('a new worktree is created DETACHED, from the clone, before cd-ing into it', () => {
  const slot = { dir: '/wt/Logan/feat-x-abc', repo: REPO, branch: null, dirty: false, dirtyCount: 0 }
  const script = buildLauncher({
    item: itemWithBranch, slot, plans: [], skill: null, config: wtConfig,
    worktree: { create: true, root: '/clones/Logan', base: 'origin/feat/x' },
  })
  const lines = script.split('\n')
  const at = (re) => lines.findIndex((l) => re.test(l))
  assert.ok(at(/^cd '\/clones\/Logan'$/) < at(/^git fetch origin$/), 'fetch happens in the clone')
  assert.ok(at(/^git fetch origin$/) < at(/^git worktree add/), 'fetch before add')
  assert.ok(at(/^git worktree add/) < at(/^cd '\/wt\/Logan\/feat-x-abc'$/), 'add before cd into it')
  assert.match(script, /git worktree add --detach '\/wt\/Logan\/feat-x-abc' 'origin\/feat\/x'/)
  // Detached on purpose: a branch can only be checked out in one worktree at a time, so a
  // `git checkout` here could fail because the branch is open elsewhere.
  assert.ok(!/git checkout/.test(script), 'must not also try to check the branch out')
})

test('an EXISTING worktree is used as-is, with no git worktree add', () => {
  const slot = { dir: '/wt/Logan/feat-x-abc', repo: REPO, branch: 'feat/x', dirty: false, dirtyCount: 0 }
  const script = buildLauncher({
    item: itemWithBranch, slot, plans: [], skill: null, config: wtConfig, worktree: null,
  })
  assert.ok(!/git worktree add/.test(script))
  assert.match(script, /^cd '\/wt\/Logan\/feat-x-abc'$/m)
})

test('slots mode still checks the branch out, exactly as before', () => {
  const slot = { dir: '/w/A', repo: REPO, branch: 'master', dirty: false, dirtyCount: 0 }
  const script = buildLauncher({
    item: itemWithBranch, slot, plans: [], skill: null,
    config: { repos: { [REPO]: { slots: ['/w/A'] } }, docsDir: '/docs' },
  })
  assert.match(script, /git checkout 'feat\/x'/)
  assert.ok(!/git worktree/.test(script))
})

test('openItem in worktree mode prunes first, then emits the creation script', async () => {
  const calls = []
  const stale = { dir: '/wt/Logan/old', repo: REPO, dirty: false, dirtyCount: 0, mtimeMs: 0 }
  let script = null
  const r = await openItem(
    { item: itemWithBranch, slots: [stale], plans: [], config: wtConfig,
      staleBranches: new Set(), claimedDirs: new Set() },
    { run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' } },
      writeFile: async (_p, c) => { script = c } })
  assert.equal(r.ok, true, r.message)
  assert.ok(calls.some((c) => /worktree remove \/wt\/Logan\/old/.test(c)), 'the stale one is swept')
  assert.match(script, /git worktree add --detach/)
})

test('openItem in worktree mode surfaces a missing clone as a plain message', async () => {
  const cfg = { ...wtConfig, repos: { [REPO]: {} } }
  const r = await openItem(
    { item: itemWithBranch, slots: [], plans: [], config: cfg,
      staleBranches: new Set(), claimedDirs: new Set() },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /No clone configured/)
})

test('dry mode prunes nothing', async () => {
  const calls = []
  const stale = { dir: '/wt/Logan/old', repo: REPO, dirty: false, dirtyCount: 0, mtimeMs: 0 }
  await openItem(
    { item: itemWithBranch, slots: [stale], plans: [], config: wtConfig,
      staleBranches: new Set(), claimedDirs: new Set() },
    { run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: '', stderr: '' } },
      writeFile: async () => {}, dry: true })
  assert.ok(!calls.some((c) => /worktree remove/.test(c)), 'a dry run must not delete anything')
})
