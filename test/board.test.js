// test/board.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildBoard } from '../board.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))
const ME = '62b43cb267dff38e0988a3bc'

const config = {
  myAccountId: ME,
  inFlightStatusOrder: ['In Progress', 'In Code Review', 'Ready To Test', 'In Testing', 'Ready To Merge'],
  repos: {
    'PerformYard/PerformYard': { docsSubdir: 'PY', slots: ['/Users/cweiner/Work/PY-1', '/Users/cweiner/Work/PY-2', '/Users/cweiner/Work/PY-3'] },
    'PerformYard/Logan': { docsSubdir: 'Logan', slots: ['/Users/cweiner/Work/Logan', '/Users/cweiner/Work/Logan2', '/Users/cweiner/Work/Logan3'] },
  },
}

const okDeps = () => ({
  now: () => new Date('2026-08-26T12:00:00Z'),
  fetchPrimary: async () => fx('jira-primary.json'),
  fetchByKeys: async (_c, keys) => fx('jira-enrichment.json').filter((i) => keys.includes(i.key)),
  fetchGithub: async () => ({ prs: [], errors: [] }),
  collectSlots: async () => ({
    slots: fx('git-slots.json').map((s) => ({
      dir: s.dir, repo: s.dir.includes('/Logan') ? 'PerformYard/Logan' : 'PerformYard/PerformYard',
      branch: s.branch, dirty: s.dirtyCount > 0, dirtyCount: s.dirtyCount, behind: s.behind, ahead: s.ahead,
    })), errors: [],
  }),
  collectPlans: async () => ({ plans: fx('plans.json'), errors: [] }),
})

test('all four sources report ok and the board has items', async () => {
  const b = await buildBoard(config, okDeps())
  assert.equal(b.sources.jira.ok, true)
  assert.equal(b.sources.github.ok, true)
  assert.equal(b.sources.slots.ok, true)
  assert.equal(b.sources.plans.ok, true)
  assert.equal(b.generatedAt, '2026-08-26T12:00:00.000Z')
  assert.ok(b.items.length > 10)
})

test('enrichment is requested for exactly the keys the primary query missed', async () => {
  let asked = null
  const deps = { ...okDeps(), fetchByKeys: async (_c, keys) => { asked = keys.slice().sort(); return [] } }
  await buildBoard(config, deps)
  // PY-13888, PY-13044, PY-13925 come from slot branches.
  assert.ok(asked.includes('PY-13888'))
  assert.ok(asked.includes('PY-13044'))
  assert.ok(asked.includes('PY-13925'))
  // keys already in the primary result must NOT be re-fetched
  assert.ok(!asked.includes('PY-12746'))
  assert.ok(!asked.includes('PY-13751'))
})

test('plan folders never trigger enrichment on their own', async () => {
  // With no PRs and no matching slot branch, PY-12275 exists ONLY as a plan
  // folder. It must not be enriched, or the board fills with historical work.
  let asked = null
  const deps = { ...okDeps(), fetchByKeys: async (_c, keys) => { asked = keys; return [] } }
  await buildBoard(config, deps)
  assert.ok(!asked.includes('PY-12275'), 'a plan-folder-only key must not be enriched')
  // sanity: plans.json really does carry that key
  assert.ok(fx('plans.json').some((p) => p.key === 'PY-12275'))
})

test('a Jira failure leaves the other three sources working', async () => {
  const deps = { ...okDeps(), fetchPrimary: async () => { throw new Error('401 Unauthorized') } }
  const b = await buildBoard(config, deps)
  assert.equal(b.sources.jira.ok, false)
  assert.match(b.sources.jira.error, /401/)
  assert.equal(b.sources.slots.ok, true)
  assert.equal(b.sources.plans.ok, true)
  // slots still produce items, just without Jira status
  assert.ok(b.items.length >= 6)
  assert.ok(b.items.every((i) => i.jira === null))
})

test('a GitHub failure does not take down the board', async () => {
  const deps = { ...okDeps(), fetchGithub: async () => { throw new Error('gh not found') } }
  const b = await buildBoard(config, deps)
  assert.equal(b.sources.github.ok, false)
  assert.equal(b.sources.jira.ok, true)
  assert.ok(b.items.length > 0)
})

test('partial collector errors surface without marking the source failed', async () => {
  const deps = { ...okDeps(), collectSlots: async () => ({ slots: [], errors: ['PY-1 is not a git repo'] }) }
  const b = await buildBoard(config, deps)
  assert.equal(b.sources.slots.ok, true)
  assert.match(b.sources.slots.error, /PY-1/)
})

test('every item carries a lane and a reasons array', async () => {
  const b = await buildBoard(config, okDeps())
  for (const i of b.items) {
    assert.ok(['needs-you', 'waiting', 'in-flight', 'ready-to-start', 'backlog'].includes(i.lane), i.id)
    assert.ok(Array.isArray(i.reasons))
    assert.ok(i.mergeGate && typeof i.mergeGate.allowed === 'boolean')
  }
})
