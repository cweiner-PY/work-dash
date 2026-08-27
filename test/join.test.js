// test/join.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinItems } from '../join.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))
const ME = 'deadbeefdeadbeefdeadbeef'

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
  const [b] = it.branches
  assert.equal(b.slot.dir, '/Users/cweiner/Work/PY-1')
  assert.equal(b.slot.dirty, true)
  assert.equal(b.slot.behind, 13)
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
  assert.equal(it.branches.length, 1, 'one branch carrying both the PR and the checkout')
  assert.equal(it.branches[0].slot.dir, '/Users/cweiner/Work/Logan')
  // and there is no second, PR-only or slot-only, item for that branch
  const dupes = [...b.values()].filter((i) => i.prs.some((p) => p.number === 704))
  assert.equal(dupes.length, 1)
})

test('a keyless slot with no PR becomes its own item', () => {
  const it = board().get('PerformYard/Logan:update-churn-agent-prompt')
  assert.equal(it.key, null)
  assert.equal(it.prs.length, 0)
  assert.equal(it.branches[0].slot.dir, '/Users/cweiner/Work/Logan3')
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

// --- a detached checkout is identified by its HEAD sha ---------------------------------

const cfg = { repos: { 'O/R': { slots: ['/w/A', '/w/B'], defaultBranch: 'master' } } }
const slotAt = (dir, branch, headSha, o = {}) =>
  ({ dir, repo: 'O/R', branch, headSha, dirty: false, dirtyCount: 0, ...o })
const prAt = (number, headRefName, headSha, o = {}) =>
  ({ number, repo: 'O/R', headRefName, headSha, isMine: false, title: 't', ...o })

// REGRESSION: a detached slot went through keylessId(repo, null) and manufactured an item
// literally called "O/R:null" with no key and no title, which rendered as a blank card.
test('a detached slot whose HEAD is a known PR head lands on THAT PR\'s item', () => {
  const items = joinItems({
    prs: [prAt(7353, 'PY-12349-bulk-select', 'abc123')],
    slots: [slotAt('/w/A', null, 'abc123')],
    config: cfg,
  })
  assert.ok(!items.some((i) => i.id.includes('null')), 'no phantom item')
  const it = items.find((i) => i.key === 'PY-12349')
  assert.equal(it.branches[0].slot.dir, '/w/A')
  assert.equal(it.branches[0].slot.holdingPr, 7353, 'and it says which PR it is holding')
})

test('the annotation is on the item\'s copy, never on the collector\'s slot', () => {
  // board.js hands the same slot array to slot resolution; it must stay what git reported.
  const slot = slotAt('/w/A', null, 'abc123')
  joinItems({ prs: [prAt(7353, 'PY-1-x', 'abc123')], slots: [slot], config: cfg })
  assert.equal(slot.holdingPr, undefined)
})

test('a detached slot matching NO known PR creates no item at all', () => {
  const items = joinItems({ prs: [], slots: [slotAt('/w/A', null, 'unknown-sha')], config: cfg })
  assert.deepEqual(items, [], 'unattributable, so not work — board.js reports it as idle')
})

test('an identical sha in a DIFFERENT repo does not attach — that would be a fork', () => {
  const items = joinItems({
    prs: [{ ...prAt(1, 'b', 'abc123'), repo: 'Other/Repo' }],
    slots: [slotAt('/w/A', null, 'abc123')],
    config: cfg,
  })
  assert.ok(!items.some((i) => i.branches.some((b) => b.slot)))
})

test('two detached slots no longer collide into one item', () => {
  // Both used to resolve to the id "O/R:null" and the second silently overwrote the first.
  const items = joinItems({
    prs: [prAt(1, 'PY-1-x', 'sha1'), prAt(2, 'PY-2-y', 'sha2')],
    slots: [slotAt('/w/A', null, 'sha1'), slotAt('/w/B', null, 'sha2')],
    config: cfg,
  })
  assert.deepEqual(items.flatMap((i) => i.branches).map((b) => b.slot?.dir).filter(Boolean).sort(),
    ['/w/A', '/w/B'])
})

test('a detached slot with no sha at all is simply not work', () => {
  assert.deepEqual(joinItems({ prs: [], slots: [slotAt('/w/A', null, null)], config: cfg }), [])
})

// --- a checkout sitting on the default branch is capacity, not work ---------------------

test('a slot on the default branch creates no card', () => {
  // It used to render as an item titled "master" in the in-flight lane.
  assert.deepEqual(joinItems({ slots: [slotAt('/w/A', 'master', 'x')], config: cfg }), [])
  assert.deepEqual(joinItems({ slots: [slotAt('/w/A', 'main', 'x')], config: cfg }), [])
})

test('a repo whose default branch is not master is honoured', () => {
  const trunk = { repos: { 'O/R': { slots: ['/w/A'], defaultBranch: 'trunk' } } }
  assert.deepEqual(joinItems({ slots: [slotAt('/w/A', 'trunk', 'x')], config: trunk }), [])
  // ...and a non-default branch is still work.
  assert.equal(joinItems({ slots: [slotAt('/w/A', 'master', 'x')], config: trunk }).length, 1)
})

test('a default-branch slot DOES attach when something else already made that item', () => {
  // A PR opened from master is unusual but real, and the slot belongs on its card.
  const items = joinItems({
    prs: [prAt(9, 'master', 'sha9')],
    slots: [slotAt('/w/A', 'master', 'sha9')],
    config: cfg,
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].branches.find((b) => b.slot).slot.dir, '/w/A')
})

test('a slot on a live feature branch with no PR is still work', () => {
  const items = joinItems({ slots: [slotAt('/w/A', 'some-local-experiment', 'x')], config: cfg })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'some-local-experiment')
})

// --- the branch is the unit of work: one ticket, several branches ----------------------
//
// The shape this project actually works in: a big feature gets split into separately
// reviewable branches that all carry the same Jira key. Before `branches` existed the item
// had a scalar `slot`, so the second branch's checkout either overwrote the first or was
// reported under "free checkouts" while holding real commits, and the card's PR row and its
// slot row could describe two different branches with nothing saying so.

test('two branches on one Jira key become two branch entries, each correctly paired', () => {
  const items = joinItems({
    prs: [prAt(7110, 'PY-12746-catalog', 'sha1', { isMine: true })],
    slots: [slotAt('/w/B', 'PY-12746-catalog-pr2-agent-suggestions', 'sha2')],
    config: cfg,
  })
  assert.equal(items.length, 1, 'still ONE card — the ticket is the card')
  const [it] = items
  assert.equal(it.key, 'PY-12746')
  assert.equal(it.branches.length, 2)

  const withPr = it.branches.find((b) => b.name === 'PY-12746-catalog')
  assert.equal(withPr.pr.number, 7110)
  assert.equal(withPr.slot, null, 'the PR branch is not checked out anywhere')

  const withSlot = it.branches.find((b) => b.name === 'PY-12746-catalog-pr2-agent-suggestions')
  assert.equal(withSlot.pr, null, 'the second branch has no PR yet')
  assert.equal(withSlot.slot.dir, '/w/B')
})

test('a PR and a slot on the SAME branch are ONE entry, not two', () => {
  const items = joinItems({
    prs: [prAt(7110, 'PY-12746-catalog', 'sha1', { isMine: true })],
    slots: [slotAt('/w/A', 'PY-12746-catalog', 'sha1')],
    config: cfg,
  })
  assert.equal(items[0].branches.length, 1)
  assert.equal(items[0].branches[0].pr.number, 7110)
  assert.equal(items[0].branches[0].slot.dir, '/w/A')
  assert.equal(items[0].branches[0].detached, false)
})

test('branches is never empty — a ticket with no PR and no checkout gets one null entry', () => {
  const items = joinItems({
    jira: [{ key: 'PY-1', summary: 'plain ticket', assigneeAccountId: 'me' }],
    config: { myAccountId: 'me', repos: {} },
  })
  assert.deepEqual(items[0].branches, [{ name: null, repo: null, pr: null, slot: null, detached: false }])
})

test('branch entries are keyed by repo as well as name', () => {
  // The same branch name in two repositories is two different pieces of work, even under
  // one ticket. Keying on name alone would merge them and lose one PR's state entirely.
  const items = joinItems({
    prs: [
      { number: 1, repo: 'O/R', headRefName: 'PY-9-shared-name', isMine: true, title: 'a' },
      { number: 2, repo: 'O/Other', headRefName: 'PY-9-shared-name', isMine: true, title: 'b' },
    ],
    config: cfg,
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].branches.length, 2)
  assert.deepEqual(items[0].branches.map((b) => b.repo).sort(), ['O/Other', 'O/R'])
})

test('a detached slot lands on its PR\'s branch entry and is marked detached', () => {
  const items = joinItems({
    prs: [prAt(7353, 'PY-12349-bulk-select', 'abc123')],
    slots: [slotAt('/w/A', null, 'abc123')],
    config: cfg,
  })
  const [b] = items[0].branches
  assert.equal(b.name, 'PY-12349-bulk-select', 'named by the PR, not left null')
  assert.equal(b.slot.dir, '/w/A')
  assert.equal(b.slot.holdingPr, 7353)
  assert.equal(b.detached, true, 'on the commit, not on the branch — never "already on it"')
})

test('a second checked-out branch is no longer lost to the scalar slot', () => {
  // REGRESSION: `it.slot = slot` was last-writer-wins, so one of two checkouts holding the
  // same ticket vanished from the item and turned up under "free checkouts".
  const items = joinItems({
    slots: [
      slotAt('/w/A', 'PY-12746-part-one', 'sha1'),
      slotAt('/w/B', 'PY-12746-part-two', 'sha2'),
    ],
    config: cfg,
  })
  assert.deepEqual(items[0].branches.map((b) => b.slot.dir).sort(), ['/w/A', '/w/B'])
})

// --- branch blocks stay in creation order ----------------------------------------------
//
// Never sorted by urgency. The branches of one feature are sequential — pr3 builds on pr2 —
// so floating the urgent one to the top would show pr3 above pr2 and lie about the shape of
// the work. Urgency is flagged on the block instead (see branchExpanded in public/app.js).

test('branches are ordered by PR number ascending, which IS creation order', () => {
  // Deliberately fed in the reverse of the intended order: `prs` arrives from a GraphQL
  // `search` with no `sort`, so GitHub's relevance order is what this has to correct.
  const items = joinItems({
    prs: [
      prAt(7266, 'PY-9-pr4-audit-log', 'd', { isMine: true }),
      prAt(7110, 'PY-9-catalog', 'a', { isMine: true }),
      prAt(7240, 'PY-9-pr3-bulk-import', 'c', { isMine: true }),
      prAt(7211, 'PY-9-pr2-scoring', 'b', { isMine: true }),
    ],
    config: cfg,
  })
  assert.deepEqual(items[0].branches.map((b) => b.pr.number), [7110, 7211, 7240, 7266])
})

test('a branch with no PR yet sorts last — nothing has been submitted for it', () => {
  const items = joinItems({
    prs: [prAt(7110, 'PY-9-catalog', 'a', { isMine: true })],
    slots: [slotAt('/w/A', 'PY-9-pr2-agent-suggestions', 'b')],
    config: cfg,
  })
  assert.deepEqual(items[0].branches.map((b) => b.name), ['PY-9-catalog', 'PY-9-pr2-agent-suggestions'])
})

test('the order is stable whatever order the collectors happened to return', () => {
  const build = (prs) => joinItems({ prs, config: cfg })[0].branches.map((b) => b.pr.number)
  const a = prAt(7110, 'PY-9-a', 'a', { isMine: true })
  const b = prAt(7211, 'PY-9-b', 'b', { isMine: true })
  const c = prAt(7240, 'PY-9-c', 'c', { isMine: true })
  assert.deepEqual(build([a, b, c]), [7110, 7211, 7240])
  assert.deepEqual(build([c, a, b]), [7110, 7211, 7240])
  assert.deepEqual(build([b, c, a]), [7110, 7211, 7240])
})

test('PR numbers from different repos are grouped by repo, not interleaved', () => {
  // Numbers are monotonic PER repository, so comparing across repos would be meaningless.
  const items = joinItems({
    prs: [
      { number: 900, repo: 'O/Zed', headRefName: 'PY-9-z', isMine: true, title: 't' },
      { number: 7110, repo: 'O/Alpha', headRefName: 'PY-9-a', isMine: true, title: 't' },
    ],
    config: cfg,
  })
  assert.deepEqual(items[0].branches.map((b) => b.repo), ['O/Alpha', 'O/Zed'])
})
