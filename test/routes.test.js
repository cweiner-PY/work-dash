// test/routes.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes } from '../routes.js'
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
