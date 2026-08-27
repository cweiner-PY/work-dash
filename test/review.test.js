// test/review.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewablePrs, pickReviewPr, reviewTarget } from '../actions/review.js'
import { buildLauncher as rawBuildLauncher, openItem as rawOpenItem } from '../actions/open.js'
import { theBranch, branchesFrom } from '../test-support/branches.js'

// Both act on ONE resolved branch of an item now. A review passes its own `review` target
// and the branch it resolves from is the item's single branch, same as every other launch.
const withBranch = (o) => ('branch' in o ? o : { ...o, branch: theBranch(o.item) })
const buildLauncher = (o) => rawBuildLauncher(withBranch(o))
const openItem = (o, deps) => rawOpenItem(withBranch(o), deps)
import { registerRoutes } from '../routes.js'
import { reviewSpecs } from '../public/app.js'

const theirs = (o = {}) => ({
  number: 7353, repo: 'PerformYard/PerformYard', isMine: false,
  headRefName: 'PY-12349-bulk-select', title: 'Bulk select', url: 'https://gh/7353',
  author: 'bpereiraperform', ...o,
})
const mine = (o = {}) => ({ number: 1, repo: 'O/R', isMine: true, headRefName: 'mine', ...o })
const item = (prs) => ({
  id: 'PY-12349', key: 'PY-12349', title: 'Bulk select feedback', repo: 'PerformYard/PerformYard',
  slot: null, plans: [], jira: { url: 'https://j/PY-12349' }, prs,
})

// --- which PR ---------------------------------------------------------------------------

test('only PRs that are NOT yours are reviewable', () => {
  // Reviewing your own PR here would detach your branch and tell Claude not to touch it.
  assert.deepEqual(reviewablePrs(item([theirs(), mine()])).map((p) => p.number), [7353])
  assert.deepEqual(reviewablePrs(item([mine()])), [])
  assert.deepEqual(reviewablePrs({}), [])
})

test('a single review PR is picked without asking', () => {
  assert.equal(pickReviewPr(item([theirs(), mine()])).pr.number, 7353)
})

test('several review PRs refuse until one is named, and list them', () => {
  const r = pickReviewPr(item([theirs(), theirs({ number: 9000 })]))
  assert.match(r.error, /#7353/)
  assert.match(r.error, /#9000/)
  assert.deepEqual(r.candidates.map((c) => c.number), [7353, 9000])
})

test('a named PR must be one of THIS item\'s review PRs', () => {
  // prNumber arrives from the client and is quoted into a prompt and a branch name, so it is
  // matched against the item rather than trusted.
  assert.equal(pickReviewPr(item([theirs()]), 7353).pr.number, 7353)
  assert.match(pickReviewPr(item([theirs()]), 9999).error, /not a PR awaiting your review/)
  // Your own PR cannot be smuggled in by number either.
  assert.match(pickReviewPr(item([theirs(), mine()]), 1).error, /not a PR awaiting your review/)
})

test('an item with nothing to review says so', () => {
  assert.match(pickReviewPr(item([mine()])).error, /no PR awaiting your review/)
})

test('reviewTarget refuses a PR with no branch', () => {
  assert.match(reviewTarget({ number: 5 }).error, /does not name a branch/)
  assert.equal(reviewTarget(theirs()).review.headRefName, 'PY-12349-bulk-select')
})

// --- the launcher ----------------------------------------------------------------------

const slot = { dir: '/w/A', repo: 'PerformYard/PerformYard', branch: 'master', dirty: false, dirtyCount: 0 }
const config = { docsDir: '/docs', reviewSkill: 'critical-review', repos: { 'PerformYard/PerformYard': { slots: ['/w/A'] } } }
const reviewScript = (over = {}) => buildLauncher({
  item: item([theirs()]), slot, plans: [], skill: 'critical-review', config,
  review: reviewTarget(theirs()).review, ...over,
})

test('a review checks the branch out DETACHED, never onto a local branch', () => {
  // A commit made by mistake then lands on no branch and cannot reach the author's PR.
  const s = reviewScript()
  assert.match(s, /git fetch origin 'PY-12349-bulk-select'/)
  assert.match(s, /git checkout --detach 'origin\/PY-12349-bulk-select'/)
  assert.ok(!/git checkout '[^-]/.test(s), 'must not check out a local branch')
})

test('the review prompt says plainly that the user is not the author', () => {
  const s = reviewScript()
  assert.match(s, /You are REVIEWING a pull request/)
  assert.match(s, /NOT the author/)
  assert.match(s, /Do not modify, stage, commit, push, revert or rebase/)
  assert.match(s, /DETACHED/)
})

test('the review prompt names the PR, its author and the repo', () => {
  const s = reviewScript()
  assert.match(s, /PR #7353 by bpereiraperform/)
  assert.match(s, /https:\/\/gh\/7353/)
  assert.match(s, /Repo: PerformYard\/PerformYard/)
  // The Jira ticket is context, not the subject.
  assert.match(s, /Related Jira ticket: PY-12349/)
})

test('the review submits the configured skill with the PR number', () => {
  assert.match(reviewScript(), /'\/critical-review #7353'/)
})

test('a review launcher runs NO other git — it is a read of someone else\'s work', () => {
  const s = reviewScript()
  for (const forbidden of ['git merge', 'git rebase', 'git push', 'git commit', 'git reset', 'git worktree']) {
    assert.ok(!s.includes(forbidden), `must not ${forbidden}`)
  }
})

test('an author with an unknown login is simply omitted, not rendered as null', () => {
  const s = buildLauncher({
    item: item([theirs({ author: null })]), slot, plans: [], skill: 'critical-review', config,
    review: reviewTarget(theirs({ author: null })).review,
  })
  assert.match(s, /PR #7353 —/)
  assert.ok(!/null/.test(s))
})

test('a normal (non-review) launch is completely unaffected', () => {
  const s = buildLauncher({ item: item([mine()]), slot, plans: [], skill: null, config })
  assert.ok(!/REVIEWING/.test(s))
  assert.ok(!/--detach/.test(s))
  assert.match(s, /git checkout 'mine'/)
})

// --- slot resolution -------------------------------------------------------------------

test('a review resolves a slot on THEIR branch, which a plain open would never target', async () => {
  let script = null
  const r = await openItem(
    { item: item([theirs()]), slots: [slot], plans: [], config,
      staleBranches: new Set(), claimedDirs: new Set(), skill: 'critical-review',
      review: reviewTarget(theirs()).review },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async (_p, c) => { script = c } })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.slot, '/w/A')
  assert.match(script, /origin\/PY-12349-bulk-select/)
})

test('a review still refuses a dirty slot', async () => {
  // Checking out over uncommitted work is no more acceptable for a review than for anything
  // else — arguably less, since none of it is the reviewer's.
  const dirty = { ...slot, dirty: true, dirtyCount: 4 }
  const r = await openItem(
    { item: item([theirs()]), slots: [dirty], plans: [], config, chosenSlotDir: '/w/A',
      staleBranches: new Set(), claimedDirs: new Set(), review: reviewTarget(theirs()).review },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /uncommitted/)
})

// --- the route -------------------------------------------------------------------------

// The board is shaped the way board.js shapes it before serving: each item's branches derived
// from its PRs and its checkout. /api/review resolves the branch under review by the PR's own
// head, so the entry has to exist.
const routesFor = (board, cfg = config) => {
  const routes = new Map()
  const items = (board.items ?? []).map((i) => ({ ...i, branches: branchesFrom(i) }))
  registerRoutes(routes, { getBoard: async () => ({ ...board, items }), config: cfg, deps: { dry: true } })
  return routes
}

test('POST /api/review launches the review for the one PR awaiting you', async () => {
  const it = item([theirs()])
  const r = await routesFor({ items: [it], slots: [slot] })
    .get('POST /api/review')({ id: it.id }, { config, invalidate() {} })
  assert.equal(r.ok, true, r.message)
  assert.match(r.detail, /git checkout --detach 'origin\/PY-12349-bulk-select'/)
  assert.match(r.detail, /'\/critical-review #7353'/)
})

test('POST /api/review takes the skill from CONFIG, never from the request', async () => {
  // This is what makes the route safe without /api/run's applicability gate.
  const it = item([theirs()])
  const r = await routesFor({ items: [it], slots: [slot] }, { ...config, reviewSkill: 'deep-review' })
    .get('POST /api/review')({ id: it.id, skill: 'rm-rf' }, { config, invalidate() {} })
  assert.equal(r.ok, true, r.message)
  assert.match(r.detail, /'\/deep-review #7353'/)
  assert.ok(!r.detail.includes('rm-rf'))
})

test('POST /api/review rejects a PR number that is not awaiting your review', async () => {
  const it = item([theirs(), mine()])
  for (const prNumber of [9999, 1]) {
    const r = await routesFor({ items: [it], slots: [slot] })
      .get('POST /api/review')({ id: it.id, prNumber }, { config, invalidate() {} })
    assert.equal(r.ok, false, String(prNumber))
    assert.match(r.message, /not a PR awaiting your review/)
  }
})

test('POST /api/review rejects an unreviewable item, a bad body and an unknown id', async () => {
  const routes = routesFor({ items: [item([mine()])], slots: [slot] })
  assert.match((await routes.get('POST /api/review')({ id: 'PY-12349' }, { config, invalidate() {} })).message,
    /no PR awaiting your review/)
  assert.match((await routes.get('POST /api/review')(null, { config, invalidate() {} })).message, /JSON object/)
  assert.match((await routes.get('POST /api/review')({ id: 'nope' }, { config, invalidate() {} })).message,
    /unknown item/i)
})

test('POST /api/review still validates plan paths', async () => {
  const it = { ...item([theirs()]), plans: [{ dir: '/docs/PY-12349', files: ['plan.md'] }] }
  const r = await routesFor({ items: [it], slots: [slot] })
    .get('POST /api/review')({ id: it.id, plans: [{ dir: '/etc', file: 'passwd' }] }, { config, invalidate() {} })
  assert.equal(r.ok, true, r.message)
  assert.ok(!r.detail.includes('/etc'), 'an unlisted plan path must not become an --add-dir')
})

// --- the button ------------------------------------------------------------------------

test('reviewSpecs offers one button per PR awaiting you, and none for your own', () => {
  const specs = reviewSpecs(item([theirs(), mine(), theirs({ number: 9000 })]), config)
  assert.deepEqual(specs.map((s) => s.prNumber), [7353, 9000])
  assert.equal(specs[0].label, 'review #7353')
  assert.match(specs[0].title, /critical-review/)
  assert.match(specs[0].title, /Makes no changes/)
  assert.match(specs[0].title, /bpereiraperform/)
})

test('reviewSpecs is empty for an item with no foreign PR', () => {
  assert.deepEqual(reviewSpecs(item([mine()]), config), [])
  assert.deepEqual(reviewSpecs(item([]), config), [])
  assert.deepEqual(reviewSpecs({}, config), [])
})

test('reviewSpecs skips a PR with no branch to check out', () => {
  assert.deepEqual(reviewSpecs(item([theirs({ headRefName: null })]), config), [])
})

test('reviewSpecs falls back to critical-review before config loads', () => {
  for (const cfg of [null, undefined, {}]) {
    assert.match(reviewSpecs(item([theirs()]), cfg)[0].title, /\/critical-review/)
  }
})
