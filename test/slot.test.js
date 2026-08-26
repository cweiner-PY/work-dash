// test/slot.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSlot, branchFor } from '../actions/slot.js'

const config = { repos: { 'O/R': { slots: ['/w/A', '/w/B', '/w/C'] } } }
const slot = (dir, o = {}) => ({ dir, repo: 'O/R', branch: 'other', dirty: false, dirtyCount: 0, behind: 0, ahead: 0, ...o })
const item = (o = {}) => ({ id: 'PY-1', key: 'PY-1', repo: 'O/R', prs: [], slot: null, ...o })

test("branchFor uses the item's own PR when a colleague's review request is also present", () => {
  const mine = { headRefName: 'PY-1-my-branch', isMine: true }
  const review = { headRefName: 'PY-1-bruce-branch', isMine: false }
  assert.equal(branchFor(item({ prs: [review, mine] })), 'PY-1-my-branch')
})

test('branchFor falls back to the slot branch when the only PR is a review request', () => {
  const review = { headRefName: 'PY-1-bruce-branch', isMine: false }
  const s = { dir: '/w/A', branch: 'PY-1-my-older-branch' }
  assert.equal(branchFor(item({ prs: [review], slot: s })), 'PY-1-my-older-branch')
})

test('uses the slot that already has the branch checked out', () => {
  const slots = [slot('/w/A'), slot('/w/B', { branch: 'PY-1-x' })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.slot.dir, '/w/B')
  assert.equal(r.alreadyOnBranch, true)
})

test('prefers a clean slot sitting on master', () => {
  const slots = [slot('/w/A', { branch: 'busy-thing' }), slot('/w/B', { branch: 'master' })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.slot.dir, '/w/B')
})

test('accepts a clean slot whose branch is stale', () => {
  const slots = [slot('/w/A', { branch: 'busy' }), slot('/w/B', { branch: 'PY-9-done' })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
    { staleBranches: new Set(['PY-9-done']) })
  assert.equal(r.slot.dir, '/w/B')
})

test('NEVER auto-selects a dirty slot, even a stale one', () => {
  const slots = [slot('/w/A', { branch: 'PY-9-done', dirty: true, dirtyCount: 3 })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
    { staleBranches: new Set(['PY-9-done']) })
  assert.equal(r.needsPicker, true)
  const c = r.candidates.find((x) => x.dir === '/w/A')
  assert.equal(c.eligible, false)
  assert.match(c.why, /uncommitted/i)
})

test('fails CLOSED on ambiguous dirty state during automatic selection', () => {
  // dirty=undefined/null/0/'' are all ambiguous, not clean. Confirmed by probe against the
  // pre-fix code: each of these values was AUTO-SELECTED despite a nonzero dirtyCount.
  for (const dirty of [undefined, null, 0, '']) {
    const slots = [slot('/w/A', { branch: 'master', dirty, dirtyCount: 5 })]
    const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
    assert.equal(r.needsPicker, true, `dirty=${JSON.stringify(dirty)} must not be auto-selected`)
  }
})

test('an explicitly clean slot (dirty: false, dirtyCount: 0) is still auto-selected', () => {
  // Positive control: without this, a fix that simply refuses to ever auto-select anything
  // would also pass the ambiguous-state test above.
  const slots = [slot('/w/A', { branch: 'master', dirty: false, dirtyCount: 0 })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.needsPicker, undefined)
  assert.equal(r.slot.dir, '/w/A')
})

test('a claimed dir is skipped, with a reason, even though it would otherwise be eligible', () => {
  const slots = [slot('/w/A', { branch: 'master' }), slot('/w/B', { branch: 'master' })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
    { staleBranches: new Set(), claimedDirs: new Set(['/w/A']) })
  assert.equal(r.needsPicker, undefined)
  assert.equal(r.slot.dir, '/w/B', 'the claimed slot must be skipped in favor of the other eligible one')
})

test('every candidate claimed leaves no free slot, with the claimed reason surfaced', () => {
  const slots = [slot('/w/A', { branch: 'master' })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
    { staleBranches: new Set(), claimedDirs: new Set(['/w/A']) })
  assert.equal(r.needsPicker, true)
  const c = r.candidates.find((x) => x.dir === '/w/A')
  assert.equal(c.eligible, false)
  assert.match(c.why, /recently claimed/i)
})

test('returns a picker with a reason per slot when none are eligible', () => {
  const slots = [slot('/w/A', { branch: 'busy1' }), slot('/w/B', { branch: 'busy2', dirty: true, dirtyCount: 1 })]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.needsPicker, true)
  assert.equal(r.candidates.length, 2)
  assert.ok(r.candidates.every((c) => typeof c.why === 'string' && c.why.length > 0))
})

test('only considers slots belonging to the item repo', () => {
  const cfg = { repos: { 'O/R': { slots: ['/w/A'] }, 'O/S': { slots: ['/w/Z'] } } }
  const slots = [slot('/w/A', { branch: 'busy' }), { ...slot('/w/Z', { branch: 'master' }), repo: 'O/S' }]
  const r = resolveSlot(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, cfg, { staleBranches: new Set() })
  assert.equal(r.needsPicker, true)
  assert.equal(r.candidates.length, 1)
})

test('an item with no repo and no branch, and no repo supplied, asks which repository', () => {
  const r = resolveSlot(item({ repo: null, prs: [] }), [], config, { staleBranches: new Set() })
  assert.equal(r.needsPicker, true)
  assert.equal(r.needsRepo, true)
  assert.match(r.message, /repositor/i)
})

// --- branchless items (Change: a To Do ticket has no branch by definition) ---

test('a branchless item with a supplied repo resolves a clean slot from that pool', () => {
  const slots = [slot('/w/A', { branch: 'master' }), slot('/w/B', { branch: 'other-branch' })]
  const r = resolveSlot(item({ repo: null, prs: [] }), slots, config, { staleBranches: new Set(), repo: 'O/R' })
  assert.equal(r.needsPicker, undefined)
  // No target branch — busy-with-a-different-branch is not disqualifying, only dirty/claimed are.
  assert.equal(r.slot.dir, '/w/A')
})

test('a branchless item with item.repo already set ignores a conflicting supplied repo', () => {
  const cfg = { repos: { 'O/R': { slots: ['/w/A'] }, 'O/S': { slots: ['/w/Z'] } } }
  const slots = [slot('/w/A', { branch: 'master' }), { ...slot('/w/Z', { branch: 'master' }), repo: 'O/S' }]
  const r = resolveSlot(item({ repo: 'O/R', prs: [] }), slots, cfg, { staleBranches: new Set(), repo: 'O/S' })
  assert.equal(r.slot.dir, '/w/A', "item.repo must win over a caller-supplied repo hint")
})

test('a branchless item never auto-selects a dirty slot', () => {
  const slots = [slot('/w/A', { branch: 'master', dirty: true, dirtyCount: 2 })]
  const r = resolveSlot(item({ repo: null, prs: [] }), slots, config, { staleBranches: new Set(), repo: 'O/R' })
  assert.equal(r.needsPicker, true)
  const c = r.candidates.find((x) => x.dir === '/w/A')
  assert.equal(c.eligible, false)
  assert.match(c.why, /uncommitted/i)
})

test('a branchless item never auto-selects a claimed slot', () => {
  const slots = [slot('/w/A', { branch: 'master' }), slot('/w/B', { branch: 'master' })]
  const r = resolveSlot(item({ repo: null, prs: [] }), slots, config,
    { staleBranches: new Set(), repo: 'O/R', claimedDirs: new Set(['/w/A']) })
  assert.equal(r.needsPicker, undefined)
  assert.equal(r.slot.dir, '/w/B', 'the claimed slot must be skipped')
})

test('a branchless item with every slot dirty or claimed gets a picker naming why', () => {
  const slots = [slot('/w/A', { branch: 'master', dirty: true, dirtyCount: 1 }), slot('/w/B', { branch: 'master' })]
  const r = resolveSlot(item({ repo: null, prs: [] }), slots, config,
    { staleBranches: new Set(), repo: 'O/R', claimedDirs: new Set(['/w/B']) })
  assert.equal(r.needsPicker, true)
  assert.equal(r.needsRepo, undefined, 'the repo IS known here — only the working directory is unresolved')
  assert.equal(r.candidates.length, 2)
})

test('an item that DOES have a branch behaves exactly as before, repo option or not', () => {
  const slots = [slot('/w/A', { branch: 'busy-thing' }), slot('/w/B', { branch: 'master' })]
  const withBranch = item({ prs: [{ headRefName: 'PY-1-x' }] })
  const r1 = resolveSlot(withBranch, slots, config, { staleBranches: new Set() })
  const r2 = resolveSlot(withBranch, slots, config, { staleBranches: new Set(), repo: 'O/S' })
  assert.equal(r1.slot.dir, '/w/B')
  assert.equal(r2.slot.dir, '/w/B', 'item.repo already being set means the repo option is never consulted')
})
