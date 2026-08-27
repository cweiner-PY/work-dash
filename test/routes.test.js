// test/routes.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes, liveClaimedDirs } from '../routes.js'
import { skillsForItem } from '../board.js'

const config = {
  repos: { 'O/R': { slots: ['/w/A'] } },
  skills: [
    { name: 'ticket-planner', when: '!branch && !pr' },
    { name: 'critical-review', when: 'slot' },
    { name: 'resolve-code-review', when: 'pr.hasReviewComments || pr.changesRequested' },
    { name: 'toggle-logan-env', when: "repo == 'PerformYard/Logan'" },
    { name: 'broken', when: 'slot &&' },
  ],
}

test('skillsForItem picks the applicable skills', () => {
  const bare = { key: 'PY-1', repo: 'O/R', prs: [], slot: null, plans: [], jira: null }
  assert.deepEqual(skillsForItem(bare, config), ['ticket-planner'])

  const withSlot = { ...bare, slot: { dir: '/w/A', branch: 'PY-1-x' } }
  assert.deepEqual(skillsForItem(withSlot, config), ['critical-review'])

  const withComments = { ...bare, prs: [{ hasReviewComments: true, reviewDecision: 'REVIEW_REQUIRED' }] }
  assert.deepEqual(skillsForItem(withComments, config), ['resolve-code-review'])
})

test('a Logan item gets the logan-only skill', () => {
  const logan = { key: 'PY-1', repo: 'PerformYard/Logan', prs: [], slot: { dir: '/w/L', branch: 'b' }, plans: [], jira: null }
  assert.ok(skillsForItem(logan, config).includes('toggle-logan-env'))
})

test('an unparseable rule is skipped, not thrown', () => {
  const withSlot = { key: 'PY-1', repo: 'O/R', prs: [], slot: { dir: '/w/A', branch: 'b' }, plans: [], jira: null }
  const out = skillsForItem(withSlot, config)
  assert.ok(!out.includes('broken'))
})

test("skillsForItem on a review-request-only item does not offer pr-gated skills", () => {
  // Regression for the live PY-1 case: an item carrying only a colleague's review-requested
  // PR must not offer /pr-description, /ticket-finisher, etc. — those are gated on `pr`,
  // and `pr` must be null here, not the raw first (foreign) PR.
  const reviewOnly = {
    key: 'PY-1', repo: 'O/R', slot: { dir: '/w/A', branch: 'PY-1-my-older-branch' }, plans: [], jira: null,
    prs: [{ hasReviewComments: true, reviewDecision: 'REVIEW_REQUIRED', isMine: false }],
  }
  const out = skillsForItem(reviewOnly, config)
  assert.ok(!out.includes('resolve-code-review'), 'a pr-gated skill must not appear for a PR that is not the user\'s own')
  assert.deepEqual(out, ['critical-review'], 'only the slot-gated skill applies')
})

test('routes reject an unknown item id', async () => {
  const routes = new Map()
  registerRoutes(routes, { getBoard: async () => ({ items: [] }), config })
  const r = await routes.get('POST /api/open')({ id: 'nope' }, { config, invalidate() {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /nope/)
})

test('POST /api/run requires a skill name', async () => {
  const item = { id: 'PY-1', key: 'PY-1', repo: 'O/R', prs: [], slot: null, plans: [], jira: null, skills: [] }
  const routes = new Map()
  registerRoutes(routes, { getBoard: async () => ({ items: [item] }), config })
  const r = await routes.get('POST /api/run')({ id: 'PY-1' }, { config, invalidate() {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /skill/i)
})

test('POST /api/open refuses a skill not applicable to the item (same gate as /api/run)', async () => {
  // This was the actual bypass: /api/run enforced the applicability check via `skillRequired`,
  // but /api/open forwarded any supplied skill straight through to openItem unchecked.
  const item = { id: 'PY-1', key: 'PY-1', repo: 'O/R', prs: [], slot: null, plans: [], jira: null, skills: [] }
  const routes = new Map()
  registerRoutes(routes, { getBoard: async () => ({ items: [item] }), config })
  const r = await routes.get('POST /api/open')({ id: 'PY-1', skill: 'not-a-real-skill' }, { config, invalidate() {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /not-a-real-skill/)
})

test('POST /api/open refuses a plan path that is not among the item\'s known plans', async () => {
  const item = {
    id: 'PY-1', key: 'PY-1', repo: 'O/R', prs: [], slot: null,
    plans: [{ dir: '/docs/PY-1', files: ['plan.md'] }], jira: null, skills: [],
  }
  const routes = new Map()
  registerRoutes(routes, { getBoard: async () => ({ items: [item] }), config })
  const r = await routes.get('POST /api/open')(
    { id: 'PY-1', plans: [{ dir: '/etc', file: 'passwd' }] }, { config, invalidate() {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /plan path/i)
})

test('POST /api/open lets a plan path drawn from item.plans through unmodified', async () => {
  // Positive control: an allowlist that is built slightly wrong (e.g. keyed on the wrong
  // field) would silently drop every legitimate plan too — this is what would catch it.
  const slot = { dir: '/w/A', repo: 'O/R', branch: 'PY-1-x', dirty: false, dirtyCount: 0 }
  const item = {
    id: 'PY-1', key: 'PY-1', title: 't', repo: 'O/R', prs: [{ headRefName: 'PY-1-x' }], slot,
    plans: [{ dir: '/docs/PY-1', files: ['plan.md'] }], jira: null, skills: [],
  }
  const routes = new Map()
  registerRoutes(routes, {
    getBoard: async () => ({ items: [item], slots: [slot] }),
    config,
    deps: { dry: true },
  })
  const r = await routes.get('POST /api/open')(
    { id: 'PY-1', plans: [{ dir: '/docs/PY-1', file: 'plan.md' }] }, { config, invalidate() {} })
  assert.equal(r.ok, true)
  assert.match(r.detail, /plan\.md/)
})

test('POST /api/open rejects an unconfigured repo string rather than passing it through', async () => {
  const item = { id: 'PY-1', key: 'PY-1', repo: null, prs: [], slot: null, plans: [], jira: null, skills: [] }
  const routes = new Map()
  registerRoutes(routes, { getBoard: async () => ({ items: [item] }), config })
  const r = await routes.get('POST /api/open')({ id: 'PY-1', repo: 'Not/Configured' }, { config, invalidate() {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /unknown repo/i)
})

test('POST /api/run also rejects an unconfigured repo string', async () => {
  const item = { id: 'PY-1', key: 'PY-1', repo: null, prs: [], slot: null, plans: [], jira: null, skills: ['ticket-planner'] }
  const routes = new Map()
  registerRoutes(routes, { getBoard: async () => ({ items: [item] }), config })
  const r = await routes.get('POST /api/run')(
    { id: 'PY-1', skill: 'ticket-planner', repo: 'Not/Configured' }, { config, invalidate() {} })
  assert.equal(r.ok, false)
  assert.match(r.message, /unknown repo/i)
})

test('POST /api/open with a valid repo resolves a branchless, repo-less item into that pool', async () => {
  const slot = { dir: '/w/A', repo: 'O/R', branch: 'master', dirty: false, dirtyCount: 0 }
  const item = { id: 'PY-1', key: 'PY-1', repo: null, prs: [], slot: null, plans: [], jira: null, skills: [] }
  const routes = new Map()
  registerRoutes(routes, {
    getBoard: async () => ({ items: [item], slots: [slot] }),
    config,
    deps: { dry: true },
  })
  const r = await routes.get('POST /api/open')({ id: 'PY-1', repo: 'O/R' }, { config, invalidate() {} })
  assert.equal(r.ok, true)
  assert.equal(r.slot, '/w/A')
})

test('a body of literal null returns a clean refusal, not a throw, from every route', async () => {
  // JSON.parse('null') succeeds and yields null, so a caller can hand routes a non-object
  // body; body.id must not be dereferenced before the shape is checked.
  const routes = new Map()
  registerRoutes(routes, { getBoard: async () => ({ items: [] }), config })
  for (const path of ['POST /api/open', 'POST /api/run', 'POST /api/update-branch', 'POST /api/merge']) {
    const r = await routes.get(path)(JSON.parse('null'), { config, invalidate() {} })
    assert.equal(r.ok, false, `${path} with a null body must refuse cleanly`)
    assert.match(r.message, /JSON object body/)
  }
})

test('liveClaimedDirs prunes an expired claim and excludes it from the live set', () => {
  const claims = new Map([['/w/A', Date.now() - 1000]])
  const live = liveClaimedDirs(claims)
  assert.equal(live.has('/w/A'), false)
  assert.equal(claims.has('/w/A'), false, 'expired entries must be pruned on read')
})

test('liveClaimedDirs includes a claim that has not yet expired', () => {
  const claims = new Map([['/w/A', Date.now() + 90_000]])
  const live = liveClaimedDirs(claims)
  assert.equal(live.has('/w/A'), true)
  assert.equal(claims.has('/w/A'), true, 'a live claim is not pruned')
})

test('a successful open claims its slot so a concurrent open on the same board picks a different one', async () => {
  const slotA = { dir: '/w/A', repo: 'O/R', branch: 'master', dirty: false, dirtyCount: 0 }
  const slotB = { dir: '/w/B', repo: 'O/R', branch: 'master', dirty: false, dirtyCount: 0 }
  const cfgTwoSlots = { ...config, repos: { 'O/R': { slots: ['/w/A', '/w/B'] } } }
  const item1 = { id: 'PY-201', key: 'PY-201', repo: 'O/R', prs: [{ headRefName: 'PY-201-x' }], slot: null, plans: [], jira: null, skills: [] }
  const item2 = { id: 'PY-202', key: 'PY-202', repo: 'O/R', prs: [{ headRefName: 'PY-202-x' }], slot: null, plans: [], jira: null, skills: [] }
  const routes = new Map()
  registerRoutes(routes, {
    getBoard: async () => ({ items: [item1, item2], slots: [slotA, slotB] }),
    config: cfgTwoSlots,
    deps: { dry: true },
  })
  const r1 = await routes.get('POST /api/open')({ id: 'PY-201' }, { config: cfgTwoSlots, invalidate() {} })
  const r2 = await routes.get('POST /api/open')({ id: 'PY-202' }, { config: cfgTwoSlots, invalidate() {} })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.notEqual(r1.slot, r2.slot, 'two concurrent opens must not collide on the same checkout')
})

test('a successful action invalidates the board cache', async () => {
  let invalidated = false
  const slot = { dir: '/w/A', repo: 'O/R', branch: 'PY-1-x', dirty: false, dirtyCount: 0 }
  const item = { id: 'PY-1', key: 'PY-1', title: 't', repo: 'O/R', prs: [], slot, plans: [], jira: null, skills: [] }
  const routes = new Map()
  registerRoutes(routes, {
    getBoard: async () => ({ items: [item], slots: [slot] }),
    config,
    deps: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
  })
  const r = await routes.get('POST /api/update-branch')({ id: 'PY-1' },
    { config, invalidate: () => { invalidated = true } })
  assert.equal(r.ok, true)
  assert.equal(invalidated, true)
})


// --- POST /api/open with resolveConflicts: the "resolve conflicts" button -------------

const conflictItem = (pr = {}) => {
  const slot = { dir: '/w/A', repo: 'O/R', branch: 'PY-1-x', dirty: false, dirtyCount: 0 }
  const item = {
    id: 'PY-1', key: 'PY-1', title: 't', repo: 'O/R', slot, plans: [], jira: null, skills: [],
    prs: [{ number: 7110, headRefName: 'PY-1-x', isMine: true, baseRefName: 'master', ...pr }],
  }
  return { item, slot }
}
const openWith = async (body, { item, slot }) => {
  const routes = new Map()
  registerRoutes(routes, {
    getBoard: async () => ({ items: [item], slots: [slot] }), config, deps: { dry: true },
  })
  return routes.get('POST /api/open')({ id: 'PY-1', ...body }, { config, invalidate() {} })
}

test('resolveConflicts merges the base branch named by the PR, not a hardcoded master', async () => {
  const r = await openWith({ resolveConflicts: true }, conflictItem({ baseRefName: 'release-2' }))
  assert.equal(r.ok, true, r.message)
  assert.match(r.detail, /git merge 'origin\/release-2'/)
  assert.ok(!r.detail.includes("origin/master"), 'must not fall back to master when a base is known')
})

test('resolveConflicts falls back to the configured default branch when the PR names no base', async () => {
  const cfg = { ...config, repos: { 'O/R': { slots: ['/w/A'], defaultBranch: 'trunk' } } }
  const { item, slot } = conflictItem({ baseRefName: null })
  const routes = new Map()
  registerRoutes(routes, {
    getBoard: async () => ({ items: [item], slots: [slot] }), config: cfg, deps: { dry: true },
  })
  const r = await routes.get('POST /api/open')(
    { id: 'PY-1', resolveConflicts: true }, { config: cfg, invalidate() {} })
  assert.equal(r.ok, true, r.message)
  assert.match(r.detail, /git merge 'origin\/trunk'/)
})

test('resolveConflicts is strict === true — no truthy value may trigger a merge', async () => {
  // Same trap as `confirmed` on /api/merge: Boolean("false") is true, so anything short of
  // a strict comparison would let "false", 1 or {} start a merge in the user's checkout.
  for (const value of ['true', 'false', 1, {}, [], 'yes', null, undefined]) {
    const r = await openWith({ resolveConflicts: value }, conflictItem())
    assert.equal(r.ok, true, `${JSON.stringify(value)}: ${r.message}`)
    assert.ok(!r.detail.includes('git merge'),
      `resolveConflicts: ${JSON.stringify(value)} must NOT start a merge`)
  }
})

test('a client cannot name the ref to merge — only whether to merge at all', async () => {
  // mergeBase is derived server-side. If the body could set it, a raw call could merge an
  // arbitrary ref into the checkout, which is the same class of hole the repo and plan
  // allowlists above exist to close.
  const r = await openWith(
    { resolveConflicts: true, mergeBase: 'attacker-branch' },
    conflictItem({ baseRefName: 'master' }))
  assert.equal(r.ok, true, r.message)
  assert.match(r.detail, /git merge 'origin\/master'/)
  assert.ok(!r.detail.includes('attacker-branch'))
})

test("resolveConflicts ignores a colleague's review-requested PR when choosing the base", async () => {
  // myPrOf, not prs[0]: a foreign PR's base branch must never decide what gets merged
  // into the user's checkout.
  const slot = { dir: '/w/A', repo: 'O/R', branch: 'PY-1-x', dirty: false, dirtyCount: 0 }
  const item = {
    id: 'PY-1', key: 'PY-1', title: 't', repo: 'O/R', slot, plans: [], jira: null, skills: [],
    prs: [{ number: 1, headRefName: 'theirs', isMine: false, baseRefName: 'their-base' }],
  }
  const r = await openWith({ resolveConflicts: true }, { item, slot })
  assert.equal(r.ok, true, r.message)
  assert.ok(!r.detail.includes('their-base'), "a foreign PR's base must not be merged")
  assert.match(r.detail, /git merge 'origin\/master'/, 'falls back to the configured default')
})

test('a plain open still touches neither fetch nor merge', async () => {
  const r = await openWith({}, conflictItem())
  assert.equal(r.ok, true, r.message)
  assert.ok(!r.detail.includes('git merge'))
  assert.ok(!r.detail.includes('git fetch'))
})
