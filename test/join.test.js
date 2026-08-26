// test/join.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinItems } from '../join.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))
const ME = '62b43cb267dff38e0988a3bc'

const config = {
  myAccountId: ME,
  repos: {
    'PerformYard/PerformYard': { docsSubdir: 'PY', slots: ['/Users/cweiner/Work/PY-1', '/Users/cweiner/Work/PY-2', '/Users/cweiner/Work/PY-3'] },
    'PerformYard/Logan': { docsSubdir: 'Logan', slots: ['/Users/cweiner/Work/Logan', '/Users/cweiner/Work/Logan2', '/Users/cweiner/Work/Logan3'] },
  },
}

// Normalized PR inputs matching the gh fixtures plus their required-check fixtures.
const prs = [
  { repo: 'PerformYard/PerformYard', number: 7306, title: 'Py 12275 parse latency instrumentation', headRefName: 'PY-12275-parse-latency-instrumentation', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING', isDraft: true, checks: { pass: 53, fail: 2, pending: 0 }, requiredChecks: { total: 6, failing: ['Spellcheck', 'Prettier'], known: true }, hasReviewComments: false, isMine: true, url: 'u7306' },
  { repo: 'PerformYard/PerformYard', number: 7230, title: 'PY-13751 report subject scoping check never runs', headRefName: 'PY-13751-report-subject-scoping-check-never-runs', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false, checks: { pass: 51, fail: 9, pending: 0 }, requiredChecks: { total: 6, failing: ['QA Code Review'], known: true }, hasReviewComments: true, isMine: true, url: 'u7230' },
  { repo: 'PerformYard/PerformYard', number: 7110, title: 'PY-12746 competency management prototype competency catalog', headRefName: 'PY-12746-competency-management-prototype-competency-catalog', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING', isDraft: true, checks: { pass: 57, fail: 4, pending: 0 }, requiredChecks: { total: 6, failing: ['Linting', 'Type Check'], known: true }, hasReviewComments: false, isMine: true, url: 'u7110' },
  { repo: 'PerformYard/Logan', number: 704, title: 'Make Salesforce the source of truth for company implementation dates', headRefName: 'feat/salesforce-implementation-date-source-of-truth', reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', isDraft: false, checks: { pass: 0, fail: 0, pending: 0 }, requiredChecks: { total: 0, failing: [], known: true }, hasReviewComments: false, isMine: true, url: 'u704' },
]

const slots = fx('git-slots.json').map((s) => ({
  dir: s.dir,
  repo: s.dir.includes('/Logan') ? 'PerformYard/Logan' : 'PerformYard/PerformYard',
  branch: s.branch,
  dirty: s.dirtyCount > 0,
  dirtyCount: s.dirtyCount,
  behind: s.behind,
  ahead: s.ahead,
}))

function board() {
  const items = joinItems({
    jira: fx('jira-primary.json'),
    enrichment: fx('jira-enrichment.json'),
    prs, slots, plans: fx('plans.json'), config,
  })
  return new Map(items.map((i) => [i.id, i]))
}

test('every Jira issue from both passes becomes an item', () => {
  const b = board()
  for (const k of ['PY-13751','PY-12746','PY-13247','PY-13181','PY-13088','PY-13076','PY-12576','PY-11672',
                   'PY-13888','PY-13044','PY-13925','PY-12275']) {
    assert.ok(b.has(k), `missing ${k}`)
  }
})

test('a PR attaches to its Jira item by branch key', () => {
  const it = board().get('PY-12746')
  assert.equal(it.prs.length, 1)
  assert.equal(it.prs[0].number, 7110)
  assert.equal(it.repo, 'PerformYard/PerformYard')
})

test('a PR whose ticket is absent from the primary query still joins via enrichment', () => {
  const it = board().get('PY-12275')
  assert.equal(it.jira.status, 'Done')
  assert.equal(it.prs[0].number, 7306)
})

test('a slot attaches to its Jira item by branch key', () => {
  const it = board().get('PY-13888')
  assert.equal(it.slot.dir, '/Users/cweiner/Work/PY-1')
  assert.equal(it.slot.dirty, true)
  assert.equal(it.slot.behind, 13)
  assert.equal(it.jira.assignee, 'Bruce Pereira')
})

test('keyless PR and keyless slot on the same branch join into ONE item', () => {
  const b = board()
  const id = 'PerformYard/Logan:feat/salesforce-implementation-date-source-of-truth'
  assert.ok(b.has(id), `missing ${id}`)
  const it = b.get(id)
  assert.equal(it.key, null)
  assert.equal(it.prs.length, 1)
  assert.equal(it.prs[0].number, 704)
  assert.equal(it.slot.dir, '/Users/cweiner/Work/Logan')
  // and there is no second, PR-only or slot-only, item for that branch
  const dupes = [...b.values()].filter((i) => i.prs.some((p) => p.number === 704))
  assert.equal(dupes.length, 1)
})

test('a keyless slot with no PR becomes its own item', () => {
  const it = board().get('PerformYard/Logan:update-churn-agent-prompt')
  assert.equal(it.key, null)
  assert.equal(it.prs.length, 0)
  assert.equal(it.slot.dir, '/Users/cweiner/Work/Logan3')
  assert.equal(it.title, 'update-churn-agent-prompt')
})

test('an item can carry more than one plan folder', () => {
  const it = board().get('PY-12746')
  assert.equal(it.plans.length, 2)
  const folders = it.plans.map((p) => p.folder).sort()
  assert.deepEqual(folders, ['PY-12746:Competency-Catalog', 'PY-12746:Prototype-Competency-Catalog'])
})

test('title falls back from jira summary to PR title to branch name', () => {
  const b = board()
  assert.match(b.get('PY-12746').title, /Competency Catalog/)           // jira summary
  assert.equal(b.get('PerformYard/Logan:feat/salesforce-implementation-date-source-of-truth').title,
    'Make Salesforce the source of truth for company implementation dates') // PR title
  assert.equal(b.get('PerformYard/Logan:update-churn-agent-prompt').title,
    'update-churn-agent-prompt')                                         // branch
})

test('isMine reflects the configured accountId', () => {
  const b = board()
  assert.equal(b.get('PY-12746').jira.isMine, true)
  assert.equal(b.get('PY-13888').jira.isMine, false)
  assert.equal(b.get('PY-13925').jira.isMine, false)
})

test('repo is inferred from slot or PR, and is null when neither exists', () => {
  const b = board()
  assert.equal(b.get('PY-13925').repo, 'PerformYard/Logan')       // via slot Logan2
  assert.equal(b.get('PY-13247').repo, null)                      // jira only
})

test('is pure — calling twice with the same input gives equal output', () => {
  const a = JSON.stringify(joinItems({ jira: fx('jira-primary.json'), enrichment: fx('jira-enrichment.json'), prs, slots, plans: fx('plans.json'), config }))
  const b = JSON.stringify(joinItems({ jira: fx('jira-primary.json'), enrichment: fx('jira-enrichment.json'), prs, slots, plans: fx('plans.json'), config }))
  assert.equal(a, b)
})

test('handles a key with two PRs', () => {
  const extra = { ...prs[1], number: 9999, url: 'u9999' }
  const items = joinItems({ jira: fx('jira-primary.json'), enrichment: [], prs: [...prs, extra], slots: [], plans: [], config })
  const it = items.find((i) => i.id === 'PY-13751')
  assert.equal(it.prs.length, 2)
  assert.deepEqual(it.prs.map((p) => p.number).sort((x, y) => x - y), [7230, 9999])
})

test('empty inputs produce an empty board, not a throw', () => {
  assert.deepEqual(joinItems({ jira: [], enrichment: [], prs: [], slots: [], plans: [], config }), [])
})

// append to test/join.test.js
import { assignLanes } from '../lanes.js'

test('the whole fixture set produces the expected board', () => {
  const laned = assignLanes(
    joinItems({ jira: fx('jira-primary.json'), enrichment: fx('jira-enrichment.json'), prs, slots, plans: fx('plans.json'), config }),
    { ...config, inFlightStatusOrder: ['In Progress', 'In Code Review', 'Ready To Test', 'In Testing', 'Ready To Merge'] }
  )
  const byLane = (l) => laned.filter((i) => i.lane === l).map((i) => i.id).sort()

  // PY-12746 is a draft: its failing checks and conflict with master are
  // expected work-in-progress state, not something needing you — it lives
  // in-flight instead of needs-you (PY-13751 is not a draft, so it stays).
  assert.deepEqual(byLane('needs-you'), ['PY-12275', 'PY-13751'])
  assert.deepEqual(byLane('waiting'),
    ['PerformYard/Logan:feat/salesforce-implementation-date-source-of-truth'])
  assert.deepEqual(byLane('in-flight'),
    ['PY-12746', 'PY-13044', 'PY-13888', 'PY-13925', 'PerformYard/Logan:update-churn-agent-prompt'])
  // PY-13247 and PY-13181 are both To Do and sprint-committed (active sprint
  // RW2026.6-S1). PY-13088/PY-13076 (READY, no sprint) and PY-12576/PY-11672
  // (TO DO, no active sprint — PY-11672's sprint exists but is closed) stay backlog.
  assert.deepEqual(byLane('ready-to-start'), ['PY-13181', 'PY-13247'])
  assert.deepEqual(byLane('backlog'),
    ['PY-11672', 'PY-12576', 'PY-13076', 'PY-13088'])

  // three of five occupied slots are reclaimable
  assert.equal(laned.filter((i) => i.signals.reclaimable).length, 3)
})
