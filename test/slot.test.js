// test/slot.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSlot, resolveBranch, checkoutBranchOf } from '../actions/slot.js'
import { branchesFrom, withBranches } from '../test-support/branches.js'

const config = { repos: { 'O/R': { slots: ['/w/A', '/w/B', '/w/C'] } } }
const slot = (dir, o = {}) => ({ dir, repo: 'O/R', branch: 'other', dirty: false, dirtyCount: 0, behind: 0, ahead: 0, ...o })
const item = (o = {}) => withBranches({ id: 'PY-1', key: 'PY-1', repo: 'O/R', prs: [], slot: null, ...o })

// resolveSlot no longer works out the branch itself — the caller resolves WHICH branch of the
// item the action is for and passes its name. These tests describe items by PR and checkout,
// so the name is derived here the way the routes derive it.
const resolveFor = (it, slots, cfg, opts = {}) =>
  resolveSlot(it, slots, cfg, { branch: checkoutBranchOf(branchesFrom(it)[0]), ...opts })

// --- which branch, and which branch to check out ---

test('resolveBranch takes the only branch when an item has exactly one', () => {
  const it = item({ prs: [{ headRefName: 'PY-1-x', isMine: true }] })
  assert.equal(resolveBranch(it).branch.name, 'PY-1-x')
})

test('resolveBranch refuses to pick when an item has several, and says what they are', () => {
  const it = item({ prs: [{ number: 1, headRefName: 'PY-1-a', isMine: true },
                           { number: 2, headRefName: 'PY-1-b', isMine: true }] })
  const r = resolveBranch(it)
  assert.equal(r.branch, undefined, 'no silent pick')
  assert.equal(r.needsBranch, true)
  assert.deepEqual(r.branches.map((b) => b.name), ['PY-1-a', 'PY-1-b'])
  assert.match(r.message, /2 branches/)
})

test('resolveBranch honours a named branch, and rejects one the item does not have', () => {
  const it = item({ prs: [{ number: 1, headRefName: 'PY-1-a', isMine: true },
                           { number: 2, headRefName: 'PY-1-b', isMine: true }] })
  assert.equal(resolveBranch(it, 'PY-1-b').branch.pr.number, 2)
  assert.match(resolveBranch(it, 'PY-1-elsewhere').error, /no branch PY-1-elsewhere/)
})

test("checkoutBranchOf uses the branch's own name for the user's own work", () => {
  const it = item({ prs: [{ headRefName: 'PY-1-my-branch', isMine: true }] })
  assert.equal(checkoutBranchOf(branchesFrom(it)[0]), 'PY-1-my-branch')
})

test('checkoutBranchOf refuses a branch that exists only as a review request', () => {
  // A plain `open` must never redirect onto a colleague's branch — /api/review is the action
  // for that, and it checks out detached so nothing can land on the author's branch.
  const it = item({ prs: [{ headRefName: 'PY-1-bruce-branch', isMine: false }] })
  assert.equal(checkoutBranchOf(branchesFrom(it)[0]), null)
})

test('checkoutBranchOf still returns a branch we have checked out ourselves', () => {
  const b = { name: 'PY-1-shared', repo: 'O/R', pr: { isMine: false }, slot: { dir: '/w/A' }, detached: false }
  assert.equal(checkoutBranchOf(b), 'PY-1-shared')
})

test('checkoutBranchOf refuses a DETACHED checkout of a colleague\'s PR', () => {
  // What a finished review leaves behind: on the commit, not on the branch.
  const b = { name: 'PY-1-bruce', repo: 'O/R', pr: { isMine: false }, slot: { dir: '/w/A' }, detached: true }
  assert.equal(checkoutBranchOf(b), null)
})

test('uses the slot that already has the branch checked out', () => {
  const slots = [slot('/w/A'), slot('/w/B', { branch: 'PY-1-x' })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.slot.dir, '/w/B')
  assert.equal(r.alreadyOnBranch, true)
})

test('prefers a clean slot sitting on master', () => {
  const slots = [slot('/w/A', { branch: 'busy-thing' }), slot('/w/B', { branch: 'master' })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.slot.dir, '/w/B')
})

test('accepts a clean slot whose branch is stale', () => {
  const slots = [slot('/w/A', { branch: 'busy' }), slot('/w/B', { branch: 'PY-9-done' })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
    { staleBranches: new Set(['PY-9-done']) })
  assert.equal(r.slot.dir, '/w/B')
})

test('NEVER auto-selects a dirty slot, even a stale one', () => {
  const slots = [slot('/w/A', { branch: 'PY-9-done', dirty: true, dirtyCount: 3 })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
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
    const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
    assert.equal(r.needsPicker, true, `dirty=${JSON.stringify(dirty)} must not be auto-selected`)
  }
})

test('an explicitly clean slot (dirty: false, dirtyCount: 0) is still auto-selected', () => {
  // Positive control: without this, a fix that simply refuses to ever auto-select anything
  // would also pass the ambiguous-state test above.
  const slots = [slot('/w/A', { branch: 'master', dirty: false, dirtyCount: 0 })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.needsPicker, undefined)
  assert.equal(r.slot.dir, '/w/A')
})

test('a claimed dir is skipped, with a reason, even though it would otherwise be eligible', () => {
  const slots = [slot('/w/A', { branch: 'master' }), slot('/w/B', { branch: 'master' })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
    { staleBranches: new Set(), claimedDirs: new Set(['/w/A']) })
  assert.equal(r.needsPicker, undefined)
  assert.equal(r.slot.dir, '/w/B', 'the claimed slot must be skipped in favor of the other eligible one')
})

test('every candidate claimed leaves no free slot, with the claimed reason surfaced', () => {
  const slots = [slot('/w/A', { branch: 'master' })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config,
    { staleBranches: new Set(), claimedDirs: new Set(['/w/A']) })
  assert.equal(r.needsPicker, true)
  const c = r.candidates.find((x) => x.dir === '/w/A')
  assert.equal(c.eligible, false)
  assert.match(c.why, /recently claimed/i)
})

test('returns a picker with a reason per slot when none are eligible', () => {
  const slots = [slot('/w/A', { branch: 'busy1' }), slot('/w/B', { branch: 'busy2', dirty: true, dirtyCount: 1 })]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, config, { staleBranches: new Set() })
  assert.equal(r.needsPicker, true)
  assert.equal(r.candidates.length, 2)
  assert.ok(r.candidates.every((c) => typeof c.why === 'string' && c.why.length > 0))
})

test('only considers slots belonging to the item repo', () => {
  const cfg = { repos: { 'O/R': { slots: ['/w/A'] }, 'O/S': { slots: ['/w/Z'] } } }
  const slots = [slot('/w/A', { branch: 'busy' }), { ...slot('/w/Z', { branch: 'master' }), repo: 'O/S' }]
  const r = resolveFor(item({ prs: [{ headRefName: 'PY-1-x' }] }), slots, cfg, { staleBranches: new Set() })
  assert.equal(r.needsPicker, true)
  assert.equal(r.candidates.length, 1)
})

test('an item with no repo and no branch, and no repo supplied, asks which repository', () => {
  const r = resolveFor(item({ repo: null, prs: [] }), [], config, { staleBranches: new Set() })
  assert.equal(r.needsPicker, true)
  assert.equal(r.needsRepo, true)
  assert.match(r.message, /repositor/i)
})

// --- branchless items (Change: a To Do ticket has no branch by definition) ---

test('a branchless item with a supplied repo resolves a clean slot from that pool', () => {
  const slots = [slot('/w/A', { branch: 'master' }), slot('/w/B', { branch: 'other-branch' })]
  const r = resolveFor(item({ repo: null, prs: [] }), slots, config, { staleBranches: new Set(), repo: 'O/R' })
  assert.equal(r.needsPicker, undefined)
  // No target branch — busy-with-a-different-branch is not disqualifying, only dirty/claimed are.
  assert.equal(r.slot.dir, '/w/A')
})

test('a branchless item with item.repo already set ignores a conflicting supplied repo', () => {
  const cfg = { repos: { 'O/R': { slots: ['/w/A'] }, 'O/S': { slots: ['/w/Z'] } } }
  const slots = [slot('/w/A', { branch: 'master' }), { ...slot('/w/Z', { branch: 'master' }), repo: 'O/S' }]
  const r = resolveFor(item({ repo: 'O/R', prs: [] }), slots, cfg, { staleBranches: new Set(), repo: 'O/S' })
  assert.equal(r.slot.dir, '/w/A', "item.repo must win over a caller-supplied repo hint")
})

test('a branchless item never auto-selects a dirty slot', () => {
  const slots = [slot('/w/A', { branch: 'master', dirty: true, dirtyCount: 2 })]
  const r = resolveFor(item({ repo: null, prs: [] }), slots, config, { staleBranches: new Set(), repo: 'O/R' })
  assert.equal(r.needsPicker, true)
  const c = r.candidates.find((x) => x.dir === '/w/A')
  assert.equal(c.eligible, false)
  assert.match(c.why, /uncommitted/i)
})

test('a branchless item never auto-selects a claimed slot', () => {
  const slots = [slot('/w/A', { branch: 'master' }), slot('/w/B', { branch: 'master' })]
  const r = resolveFor(item({ repo: null, prs: [] }), slots, config,
    { staleBranches: new Set(), repo: 'O/R', claimedDirs: new Set(['/w/A']) })
  assert.equal(r.needsPicker, undefined)
  assert.equal(r.slot.dir, '/w/B', 'the claimed slot must be skipped')
})

test('a branchless item with every slot dirty or claimed gets a picker naming why', () => {
  const slots = [slot('/w/A', { branch: 'master', dirty: true, dirtyCount: 1 }), slot('/w/B', { branch: 'master' })]
  const r = resolveFor(item({ repo: null, prs: [] }), slots, config,
    { staleBranches: new Set(), repo: 'O/R', claimedDirs: new Set(['/w/B']) })
  assert.equal(r.needsPicker, true)
  assert.equal(r.needsRepo, undefined, 'the repo IS known here — only the working directory is unresolved')
  assert.equal(r.candidates.length, 2)
})

test('an item that DOES have a branch behaves exactly as before, repo option or not', () => {
  const slots = [slot('/w/A', { branch: 'busy-thing' }), slot('/w/B', { branch: 'master' })]
  const branched = item({ prs: [{ headRefName: 'PY-1-x' }] })
  const r1 = resolveFor(branched, slots, config, { staleBranches: new Set() })
  const r2 = resolveFor(branched, slots, config, { staleBranches: new Set(), repo: 'O/S' })
  assert.equal(r1.slot.dir, '/w/B')
  assert.equal(r2.slot.dir, '/w/B', 'item.repo already being set means the repo option is never consulted')
})


// --- a detached checkout is what a finished review leaves behind -----------------------

const poolConfig = { repos: { 'O/R': { slots: ['/w/A', '/w/B', '/w/C'] } } }
const bare = { id: 'PY-9', key: 'PY-9', repo: 'O/R', slot: null, plans: [], prs: [] }
const sl = (dir, branch, o = {}) => ({ dir, repo: 'O/R', branch, dirty: false, dirtyCount: 0, ...o })

// REGRESSION: the review action checks a PR out detached, which read as "busy with null" and
// was never eligible again — so every review permanently consumed a slot.
test('a clean DETACHED slot is eligible, not "busy with null"', () => {
  const r = resolveSlot(bare, [sl('/w/A', null)], poolConfig, { branch: 'feat/x' })
  assert.equal(r.slot?.dir, '/w/A', 'a finished review must not strand the slot forever')
  assert.ok(!r.needsPicker)
})

test('a detached slot is taken LAST, after master and after a stale branch', () => {
  const slots = [sl('/w/A', null), sl('/w/B', 'old-done'), sl('/w/C', 'master')]
  const stale = new Set(['old-done'])
  // master first
  assert.equal(resolveSlot(bare, slots, poolConfig, { branch: 'feat/x', staleBranches: stale }).slot.dir, '/w/C')
  // then stale
  assert.equal(resolveSlot(bare, slots.slice(0, 2), poolConfig, { branch: 'feat/x', staleBranches: stale }).slot.dir, '/w/B')
  // detached only when nothing better exists
  assert.equal(resolveSlot(bare, [sl('/w/A', null)], poolConfig, { branch: 'feat/x' }).slot.dir, '/w/A')
})

test('a DIRTY detached slot is still refused', () => {
  // A review that left changes behind is exactly the case not to stomp on.
  const r = resolveSlot(bare, [sl('/w/A', null, { dirty: true, dirtyCount: 3 })], poolConfig, { branch: 'feat/x' })
  assert.equal(r.needsPicker, true)
  assert.match(r.candidates[0].why, /uncommitted/)
})

test('a slot busy with a live branch is still never taken', () => {
  const r = resolveSlot(bare, [sl('/w/A', 'someone-elses-live-work')], poolConfig, { branch: 'feat/x' })
  assert.equal(r.needsPicker, true)
  assert.match(r.candidates[0].why, /busy with someone-elses-live-work/)
})

test('the picker explains a detached slot in words, not as null', () => {
  // It only reaches the picker when something else blocks it; the reason still has to read.
  const slots = [sl('/w/A', null), sl('/w/B', 'live')]
  const r = resolveSlot(bare, slots, poolConfig, { branch: 'feat/x', claimedDirs: new Set(['/w/A']) })
  assert.equal(r.needsPicker, true)
  const a = r.candidates.find((c) => c.dir === '/w/A')
  assert.match(a.why, /claimed/)
})
