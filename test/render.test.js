// test/render.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupForDisplay, sourceChip, prChecksChip, prBehindChip, summarizeSubtasks, updateBranchSpec, hasBranch, needsRepoChoice, repoLabel, refreshLabel, editorSpec, idleChip, shouldCollect,
         slotHolding, idleSlotsLine, branchLabel, shortBranchName, checkoutNameOf, ownPrOf, reviewSpecOf,
         branchExpanded, branchSummary, plansSummary } from '../public/app.js'

const it = (o) => ({ id: o.id, lane: o.lane, statusGroup: o.statusGroup ?? 'no ticket',
  sortIndex: o.sortIndex ?? Infinity, signals: { foreign: false, stale: false, reclaimable: false, ...o.signals },
  reasons: [], prs: [], plans: [], slot: null, jira: null, mergeGate: { allowed: false, blockers: [] }, ...o })

const items = [
  it({ id: 'A', lane: 'needs-you' }),
  it({ id: 'B', lane: 'waiting' }),
  it({ id: 'C', lane: 'in-flight', statusGroup: 'Ready To Test', sortIndex: 2 }),
  it({ id: 'D', lane: 'in-flight', statusGroup: 'In Progress', sortIndex: 0 }),
  it({ id: 'E', lane: 'in-flight', statusGroup: 'no ticket', sortIndex: Infinity }),
  it({ id: 'F', lane: 'in-flight', statusGroup: 'Done', sortIndex: Infinity, signals: { stale: true } }),
  it({ id: 'G', lane: 'backlog' }),
  it({ id: 'H', lane: 'ready-to-start' }),
]

test('default filter hides backlog and stale items, but SHOWS ready-to-start', () => {
  // Sprint-committed work the user has not started belongs in view by default —
  // only backlog stays behind its toggle.
  const { lanes, hidden } = groupForDisplay(items, { showBacklog: false, showStale: false })
  const shown = lanes.flatMap((l) => l.subgroups ? l.subgroups.flatMap((s) => s.items) : l.items).map((i) => i.id)
  assert.deepEqual(shown.sort(), ['A', 'B', 'C', 'D', 'E', 'H'])
  assert.equal(hidden.backlog, 1)   // G only
  assert.equal(hidden.stale, 1)     // F
  assert.equal(hidden.total, 2)
  // every item is either shown or accounted for as hidden
  assert.equal(shown.length + hidden.total, items.length)
})

test('ready-to-start is shown even with showBacklog off; showBacklog only reveals backlog', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: false, showStale: false })
  const ids = lanes.flatMap((l) => l.subgroups ? l.subgroups.flatMap((s) => s.items) : l.items).map((i) => i.id)
  assert.ok(ids.includes('H'), 'ready-to-start item must be visible by default')
  assert.ok(!ids.includes('G'), 'backlog item must still be hidden by default')
})

test('showBacklog reveals backlog (ready-to-start was already shown)', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: true, showStale: false })
  const ids = lanes.flatMap((l) => l.subgroups ? l.subgroups.flatMap((s) => s.items) : l.items).map((i) => i.id)
  assert.ok(ids.includes('G'))
  assert.ok(ids.includes('H'))
  assert.ok(!ids.includes('F'))
})

test('lane order is fixed', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: true, showStale: true })
  assert.deepEqual(lanes.map((l) => l.id),
    ['needs-you', 'waiting', 'in-flight', 'ready-to-start', 'backlog'])
})

test('in-flight subgroups are ordered by sortIndex with "no ticket" last', () => {
  const { lanes } = groupForDisplay(items, { showBacklog: false, showStale: true })
  const inflight = lanes.find((l) => l.id === 'in-flight')
  assert.deepEqual(inflight.subgroups.map((s) => s.label),
    ['In Progress', 'Ready To Test', 'Done', 'no ticket'])
})

test('an item with an unrecognised lane is SHOWN, never silently dropped', () => {
  const odd = it({ id: 'ODD', lane: 'some-future-lane' })
  const { lanes, hidden } = groupForDisplay([it({ id: 'A', lane: 'needs-you' }), odd],
    { showBacklog: true, showStale: true })
  const shown = lanes.flatMap((l) => l.items ?? l.subgroups.flatMap((s) => s.items)).map((i) => i.id)
  assert.ok(shown.includes('ODD'), 'the orphan must appear somewhere')
  assert.equal(shown.length + hidden.total, 2, 'every item is either shown or counted as hidden')
  const other = lanes.find((l) => l.id === 'other')
  assert.ok(other, 'a catch-all lane exists')
  assert.equal(other.label, 'Other (unrecognised lane)')
})

test('the catch-all lane is absent when every lane is recognised', () => {
  const { lanes } = groupForDisplay([it({ id: 'A', lane: 'needs-you' })],
    { showBacklog: true, showStale: true })
  assert.equal(lanes.find((l) => l.id === 'other'), undefined)
})

test('empty lanes are omitted', () => {
  const { lanes } = groupForDisplay([it({ id: 'A', lane: 'needs-you' })], { showBacklog: true, showStale: true })
  assert.deepEqual(lanes.map((l) => l.id), ['needs-you'])
})

test('a needs-you item is never hidden by the default filter, even when stale or foreign', () => {
  const staleNeedsYou = it({ id: 'NY', lane: 'needs-you', signals: { stale: true } })
  const foreignNeedsYou = it({ id: 'NY2', lane: 'needs-you', signals: { foreign: true } })
  const staleInFlight = it({ id: 'IF', lane: 'in-flight', statusGroup: 'Done', signals: { stale: true } })
  const { lanes, hidden } = groupForDisplay(
    [staleNeedsYou, foreignNeedsYou, staleInFlight],
    { showBacklog: false, showStale: false }
  )
  const shown = lanes.flatMap((l) => l.items ?? l.subgroups.flatMap((s) => s.items)).map((i) => i.id)
  assert.ok(shown.includes('NY'), 'a stale needs-you item must still be shown')
  assert.ok(shown.includes('NY2'), 'a foreign needs-you item must still be shown')
  assert.ok(!shown.includes('IF'), 'a stale item in another lane is still hidden by default')
  // only the in-flight item was withheld — the two needs-you items count as shown, not hidden
  assert.equal(hidden.stale, 1)
  assert.equal(hidden.total, 1)
})

test('sourceChip: a healthy source (ok, no error) renders the ok class', () => {
  const { cls, text, error } = sourceChip('jira', { ok: true, error: null, count: 12 })
  assert.equal(cls, 'ok')
  assert.equal(text, 'jira 12')
  assert.equal(error, null)
})

test('sourceChip: ok:true with a non-null error is DEGRADED (warn), and the error text is real data, not only a title', () => {
  const { cls, text, error } = sourceChip('slots', { ok: true, error: 'PY-1 is not a git repo', count: 5 })
  assert.equal(cls, 'warn', 'a degraded source must not render identically to a healthy one')
  assert.ok(text.includes('(degraded)'))
  // The error string itself is returned as plain data the caller can render as visible
  // text (e.g. into a .src-errors block) — not something only reachable via a title attr.
  assert.equal(error, 'PY-1 is not a git repo')
})

test('sourceChip: ok:false renders the bad class regardless of error', () => {
  const { cls, text } = sourceChip('github', { ok: false, error: '401 Unauthorized', count: 0 })
  assert.equal(cls, 'bad')
  assert.equal(text, 'github unavailable')
})

test('prChecksChip: known:false shows "check status unknown", never the confident "no required checks"', () => {
  const { cls, text } = prChecksChip({ total: 0, failing: [], known: false })
  assert.equal(cls, 'bad')
  assert.equal(text, 'check status unknown')
})

test('prChecksChip: known:true with no checks configured is the real "no required checks"', () => {
  const { cls, text } = prChecksChip({ total: 0, failing: [], pending: [], known: true })
  assert.equal(cls, 'ok')
  assert.equal(text, 'no required checks')
})

test('prChecksChip: a failing check wins over a pending one', () => {
  const { cls, text } = prChecksChip({ total: 2, failing: ['Linting'], pending: ['Unit Tests'], known: true })
  assert.equal(cls, 'bad')
  assert.equal(text, 'required failing: Linting')
})

test('prChecksChip: a pending check with nothing failing is "running", not a failure', () => {
  const { cls, text } = prChecksChip({ total: 1, failing: [], pending: ['Unit Tests'], known: true })
  assert.equal(cls, 'warn')
  assert.equal(text, 'required 1 running')
})

// --- summarizeSubtasks ---

const st = (key, statusCategory) => ({ key, summary: key, status: statusCategory, statusCategory, issuetype: 'UI/UX Sub-Task', assignee: 'Colt Weiner' })

test('summarizeSubtasks: counts open vs done and total, regardless of input order', () => {
  const subtasks = [st('A', 'Done'), st('B', 'In Progress'), st('C', 'To Do'), st('D', 'Done')]
  const s = summarizeSubtasks(subtasks)
  assert.equal(s.total, 4)
  assert.equal(s.open, 2)
  assert.equal(s.done, 2)
})

test('summarizeSubtasks: openList holds only the non-Done ones, doneList only the Done ones', () => {
  const subtasks = [st('A', 'Done'), st('B', 'In Progress'), st('C', 'To Do'), st('D', 'Done')]
  const s = summarizeSubtasks(subtasks)
  assert.deepEqual(s.openList.map((x) => x.key), ['B', 'C'])
  assert.deepEqual(s.doneList.map((x) => x.key), ['A', 'D'])
})

test('summarizeSubtasks: an all-done set', () => {
  const subtasks = [st('A', 'Done'), st('B', 'Done')]
  const s = summarizeSubtasks(subtasks)
  assert.equal(s.open, 0)
  assert.equal(s.done, 2)
  assert.equal(s.total, 2)
  assert.deepEqual(s.openList, [])
  assert.equal(s.doneList.length, 2)
})

test('summarizeSubtasks: an empty set', () => {
  const s = summarizeSubtasks([])
  assert.deepEqual(s, { open: 0, done: 0, total: 0, openList: [], doneList: [] })
})

// --- updateBranchSpec ---

test('updateBranchSpec: BEHIND is enabled with the plain "update branch" label', () => {
  const spec = updateBranchSpec({ slot: null }, { number: 1, mergeStateStatus: 'BEHIND' })
  assert.equal(spec.disabled, false)
  assert.equal(spec.label, 'update branch')
})

test('updateBranchSpec: DIRTY is an ENABLED action, not a label telling you to go elsewhere', () => {
  const spec = updateBranchSpec({ slot: null }, {
    number: 7110, mergeStateStatus: 'DIRTY', baseRefName: 'master',
    baseCompare: { behind: 24, ahead: 11, status: 'DIVERGED', known: true },
  })
  assert.equal(spec.disabled, false, 'a disabled button naming a manual task is just a label')
  assert.equal(spec.label, 'resolve conflicts')
  assert.equal(spec.action, 'resolve-conflicts', 'must route to the launcher, not update-branch')
  assert.match(spec.title, /master/)
})

// REGRESSION, live bug: PerformYard/PerformYard#7230 sat 24 commits behind master while
// the dashboard showed a disabled "up to date". Its mergeStateStatus was BLOCKED, because
// a required check was failing, and BLOCKED/DIRTY outrank BEHIND — so no PR in these repos
// ever reported BEHIND and the button was never once enabled. mergeStateStatus answers
// "can this merge", never "is this behind".
test('updateBranchSpec: BLOCKED/UNSTABLE/CLEAN with a real behind count offer the update', () => {
  for (const mergeStateStatus of ['BLOCKED', 'UNSTABLE', 'CLEAN', 'UNKNOWN', null, undefined]) {
    const spec = updateBranchSpec({ slot: null }, {
      number: 7230, mergeStateStatus, baseRefName: 'master',
      baseCompare: { behind: 24, ahead: 18, status: 'DIVERGED', known: true },
    })
    assert.equal(spec.disabled, false, `${mergeStateStatus} must not disable a behind branch`)
    assert.match(spec.label, /24 behind/, String(mergeStateStatus))
  }
})

test('updateBranchSpec: "up to date" requires the comparison to SAY zero, whatever the merge state', () => {
  for (const mergeStateStatus of ['BLOCKED', 'UNSTABLE', 'CLEAN']) {
    const spec = updateBranchSpec({ slot: null }, {
      number: 1, mergeStateStatus, baseRefName: 'master',
      baseCompare: { behind: 0, ahead: 3, status: 'AHEAD', known: true },
    })
    assert.equal(spec.disabled, true, mergeStateStatus)
    assert.equal(spec.label, 'up to date', mergeStateStatus)
  }
})

test('updateBranchSpec: an unknown comparison never renders as "up to date"', () => {
  for (const mergeStateStatus of ['BLOCKED', 'UNSTABLE', 'CLEAN', 'UNKNOWN', null]) {
    const spec = updateBranchSpec({ slot: null }, {
      number: 1, mergeStateStatus, baseRefName: 'master',
      baseCompare: { behind: null, ahead: null, status: null, known: false },
    })
    assert.equal(spec.disabled, true, mergeStateStatus)
    assert.equal(spec.label, 'behind state unknown', mergeStateStatus)
    assert.match(spec.title, /try again after the next refresh/)
  }
})

test('updateBranchSpec: a missing baseCompare entirely still fails closed', () => {
  const spec = updateBranchSpec({ slot: null }, { number: 1, mergeStateStatus: 'BLOCKED' })
  assert.equal(spec.disabled, true)
  assert.equal(spec.label, 'behind state unknown')
})

test('updateBranchSpec: BEHIND still acts even when the comparison failed', () => {
  // BEHIND is only ever reported when the branch really is behind, so it remains a
  // usable fallback when the comparison call itself did not come back.
  const spec = updateBranchSpec({ slot: null }, {
    number: 1, mergeStateStatus: 'BEHIND', baseRefName: 'master',
    baseCompare: { behind: null, ahead: null, status: null, known: false },
  })
  assert.equal(spec.disabled, false)
  assert.equal(spec.label, 'update branch')
})

test('updateBranchSpec: conflicts outrank the behind count', () => {
  // A conflicting branch cannot be brought up to date server-side however far behind it
  // is, so DIRTY (or a CONFLICTING mergeable) must win over behind:24 and offer the
  // conflict path rather than an update that would fail.
  for (const pr of [
    { number: 7110, mergeStateStatus: 'DIRTY', baseRefName: 'master',
      baseCompare: { behind: 24, ahead: 11, status: 'DIVERGED', known: true } },
    { number: 7110, mergeStateStatus: 'UNKNOWN', mergeable: 'CONFLICTING', baseRefName: 'master',
      baseCompare: { behind: 24, ahead: 11, status: 'DIVERGED', known: true } },
  ]) {
    const spec = updateBranchSpec({ slot: null }, pr)
    assert.equal(spec.action, 'resolve-conflicts')
    assert.equal(spec.label, 'resolve conflicts')
    assert.match(spec.title, /master/)
  }
})

test('updateBranchSpec: every non-conflict outcome routes to update-branch', () => {
  // The click handler dispatches on spec.action, so an outcome that forgot to declare one
  // would silently POST to the wrong endpoint.
  const cases = [
    { number: 1, mergeStateStatus: 'BLOCKED', baseCompare: { behind: 24, ahead: 1, known: true } },
    { number: 1, mergeStateStatus: 'BLOCKED', baseCompare: { behind: 0, ahead: 1, known: true } },
    { number: 1, mergeStateStatus: 'BLOCKED', baseCompare: { behind: null, known: false } },
    { number: 1, mergeStateStatus: 'BEHIND', baseCompare: { behind: null, known: false } },
  ]
  for (const pr of cases) {
    assert.equal(updateBranchSpec({ slot: null }, pr).action, 'update-branch', JSON.stringify(pr))
  }
  // ...including the no-PR local fallback.
  assert.equal(updateBranchSpec({ slot: { behind: 3, dirty: false, dirtyCount: 0 } }, null).action, 'update-branch')
})

test('prBehindChip: says nothing when the branch is up to date', () => {
  assert.equal(prBehindChip({ baseRefName: 'master', baseCompare: { behind: 0, ahead: 2, known: true } }), null)
})

test('prBehindChip: a behind branch is named on the card, not only on the button', () => {
  const chip = prBehindChip({ baseRefName: 'master', baseCompare: { behind: 24, ahead: 18, known: true } })
  assert.equal(chip.cls, 'warn')
  assert.equal(chip.text, '24 behind master')
})

test('prBehindChip: an unknown comparison is SHOWN as unknown, never omitted', () => {
  // Silence is what let the false "up to date" survive; a fact we failed to establish
  // must look different from a fact we established as fine.
  const chip = prBehindChip({ baseRefName: 'master', baseCompare: { behind: null, known: false } })
  assert.equal(chip.cls, 'warn')
  assert.match(chip.text, /unknown/)
})

test('prBehindChip: a PR with no baseCompare field at all renders no chip', () => {
  // A colleague's review-requested PR is never compared, so it has no field to report.
  assert.equal(prBehindChip({ baseRefName: 'master' }), null)
})

test('updateBranchSpec: no PR falls back to the local behind count, relabelled as stale', () => {
  const spec = updateBranchSpec({ slot: { behind: 13, dirty: false, dirtyCount: 0 } }, null)
  assert.equal(spec.disabled, false)
  assert.match(spec.label, /13 behind/)
  assert.match(spec.label, /as of last fetch/, 'the stale local count must be labelled as such, never presented as current')
})

test('updateBranchSpec: no PR and no slot means nothing to show', () => {
  assert.equal(updateBranchSpec({ slot: null }, null), null)
})

test('updateBranchSpec: no PR and a dirty slot is disabled with the uncommitted-count title', () => {
  const spec = updateBranchSpec({ slot: { behind: 0, dirty: true, dirtyCount: 3 } }, null)
  assert.equal(spec.disabled, true)
  assert.match(spec.title, /3 uncommitted/)
})

// --- hasBranch / needsRepoChoice / repoLabel ---
//
// These take ONE BRANCH of an item now, not the item: `{ name, pr, slot, detached }`.

const br = (o = {}) => ({ name: null, repo: 'O/R', pr: null, slot: null, detached: false, ...o })

test('hasBranch: true from the branch\'s own name', () => {
  assert.equal(hasBranch(br({ name: 'PY-1-x', pr: { isMine: true, headRefName: 'PY-1-x' } })), true)
})

test('hasBranch: a colleague\'s review-requested PR does not count', () => {
  // A plain open must never redirect onto their branch — /api/review does that, detached.
  assert.equal(hasBranch(br({ name: 'PY-1-bruce', pr: { isMine: false, headRefName: 'PY-1-bruce' } })), false)
})

test('hasBranch: a branch we have checked out ourselves counts', () => {
  assert.equal(hasBranch(br({ name: 'PY-1-x', slot: { dir: '/w/A', branch: 'PY-1-x' } })), true)
})

test('hasBranch: false for a branch with no name at all', () => {
  assert.equal(hasBranch(br()), false)
  assert.equal(hasBranch(null), false)
})

test('needsRepoChoice: true only when both branchless AND repo-less', () => {
  assert.equal(needsRepoChoice({ repo: null }, br()), true)
  assert.equal(needsRepoChoice({ repo: 'O/R' }, br()), false, 'a known repo keeps today\'s single button')
  assert.equal(needsRepoChoice({ repo: null }, br({ name: 'b', pr: { isMine: true } })), false,
    'a known branch keeps today\'s single button')
})

// --- branch identity on the card ---

test('shortBranchName drops the ticket key the card already shows', () => {
  assert.equal(shortBranchName({ key: 'PY-12746' }, br({ name: 'PY-12746-catalog-pr2' })), 'catalog-pr2')
  assert.equal(shortBranchName({ key: 'PY-12746' }, br({ name: 'feat/other' })), 'feat/other')
  assert.equal(shortBranchName({ key: null }, br({ name: 'feat/x' })), 'feat/x')
  assert.equal(shortBranchName({ key: 'PY-1' }, br()), null)
})

test('branchLabel says nothing at all for a single-branch item', () => {
  // What keeps a one-branch card looking exactly as it did: there is nothing to tell apart,
  // and labelling the only branch is pure noise.
  const item = { key: 'PY-1' }
  assert.equal(branchLabel(item, br({ name: 'PY-1-x', pr: { number: 1 } }), 1), null)
  assert.equal(branchLabel(item, br({ name: 'PY-1-x', slot: { dir: '/w/A' } }), 1), null)
})

test('branchLabel titles every branch of a multi-branch item', () => {
  // It is the block's title on a folding card, so it always has content. Returning null for
  // a branch that had both a PR and a checkout left that block headed by a bare chevron.
  const item = { key: 'PY-12746' }
  assert.equal(branchLabel(item, br({ name: 'PY-12746-catalog', pr: { number: 7110 }, slot: { dir: '/w/A' } }), 2), 'catalog')
  assert.equal(branchLabel(item, br({ name: 'PY-12746-catalog', pr: { number: 7110 } }), 2), 'catalog')
  assert.equal(branchLabel(item, br({ name: 'PY-12746-pr2', slot: { dir: '/w/B' } }), 2), 'no PR yet · pr2')
  assert.equal(branchLabel(item, br(), 2), 'not started')
  // A nameless branch that somehow carries a PR falls back to the number rather than nothing.
  assert.equal(branchLabel(item, br({ name: null, pr: { number: 7110 } }), 2), '#7110')
})

test('ownPrOf ignores a colleague\'s PR', () => {
  assert.equal(ownPrOf(br({ pr: { number: 1, isMine: true } })).number, 1)
  assert.equal(ownPrOf(br({ pr: { number: 2 } })).number, 2, 'isMine undefined means mine')
  assert.equal(ownPrOf(br({ pr: { number: 3, isMine: false } })), null)
  assert.equal(ownPrOf(br()), null)
})

test('checkoutNameOf refuses a detached checkout of a colleague\'s PR', () => {
  assert.equal(checkoutNameOf(br({ name: 'theirs', pr: { isMine: false }, slot: { dir: '/w/A' }, detached: true })), null)
  assert.equal(checkoutNameOf(br({ name: 'theirs', pr: { isMine: false }, slot: { dir: '/w/A' } })), 'theirs')
})

test('reviewSpecOf offers the button only for somebody else\'s PR', () => {
  const cfg = { reviewSkill: 'critical-review' }
  assert.equal(reviewSpecOf(br({ pr: { number: 7353, isMine: false, headRefName: 'theirs', author: 'bruce' } }), cfg).label,
    'review #7353')
  assert.equal(reviewSpecOf(br({ pr: { number: 1, isMine: true, headRefName: 'mine' } }), cfg), null)
  assert.equal(reviewSpecOf(br(), cfg), null)
})

test('repoLabel: uses docsSubdir when configured', () => {
  const config = { repos: { 'PerformYard/Logan': { docsSubdir: 'Logan' } } }
  assert.equal(repoLabel(config, 'PerformYard/Logan'), 'Logan')
})

test('repoLabel: falls back to the full repo key when docsSubdir is unset', () => {
  const config = { repos: { 'Owner/Repo': {} } }
  assert.equal(repoLabel(config, 'Owner/Repo'), 'Owner/Repo')
})

// --- refreshLabel ---

test('refreshLabel: not busy returns the idle label', () => {
  assert.equal(refreshLabel({ busy: false }), 'refresh')
  assert.equal(refreshLabel({ busy: false, elapsedMs: 5000 }), 'refresh', 'elapsedMs is irrelevant when not busy')
})

test('refreshLabel: busy under one second is the plain label, no counter yet', () => {
  assert.equal(refreshLabel({ busy: true, elapsedMs: 0 }), 'refreshing…')
  assert.equal(refreshLabel({ busy: true, elapsedMs: 400 }), 'refreshing…')
  assert.equal(refreshLabel({ busy: true, elapsedMs: 999 }), 'refreshing…')
})

test('refreshLabel: busy at 2s/3s/10s shows the counted form — a static label reads as stuck', () => {
  assert.equal(refreshLabel({ busy: true, elapsedMs: 2000 }), 'refreshing… 2s')
  assert.equal(refreshLabel({ busy: true, elapsedMs: 3000 }), 'refreshing… 3s')
  assert.equal(refreshLabel({ busy: true, elapsedMs: 10000 }), 'refreshing… 10s')
})

test('refreshLabel: never returns an empty string, busy or not, at any elapsed time', () => {
  const samples = [
    { busy: false },
    { busy: false, elapsedMs: 0 },
    { busy: true, elapsedMs: 0 },
    { busy: true, elapsedMs: 500 },
    { busy: true, elapsedMs: 1000 },
    { busy: true, elapsedMs: 2000 },
    { busy: true, elapsedMs: 59000 },
    { busy: true, elapsedMs: 600000 },
  ]
  for (const sample of samples) {
    const label = refreshLabel(sample)
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0, `expected a non-empty label for ${JSON.stringify(sample)}`)
  }
})


// --- editorSpec: the open-in-editor button ---------------------------------------------

test('editorSpec: the visible text is the checkout name, not the editor name', () => {
  // The directory itself is the control, the way the ticket key and PR number are. The
  // editor belongs in the tooltip; putting it in the text would replace information the
  // slot row already earns its space with.
  const spec = editorSpec({ slot: { dir: '/Users/x/Work/PY-2' } }, { editor: 'Cursor' })
  assert.equal(spec.name, 'PY-2')
  assert.equal(spec.dir, '/Users/x/Work/PY-2')
  assert.equal(spec.editor, 'Cursor')
  assert.match(spec.title, /\/Users\/x\/Work\/PY-2/, 'the tooltip must say which folder opens')
  assert.match(spec.title, /Cursor/, 'and which editor it opens in')
})

test('editorSpec: the name is the last path segment, with no trailing-slash surprise', () => {
  assert.equal(editorSpec({ slot: { dir: '/w/Logan3' } }, {}).name, 'Logan3')
  assert.equal(editorSpec({ slot: { dir: 'PY-2' } }, {}).name, 'PY-2')
})

test('editorSpec: no local checkout means no button at all, not a disabled one', () => {
  // A To Do ticket with no checkout is the ordinary case, not a problem to flag. There is
  // nothing to enable the button for, so it should not be on the card.
  assert.equal(editorSpec({ slot: null }, { editor: 'Cursor' }), null)
  assert.equal(editorSpec({}, { editor: 'Cursor' }), null)
  assert.equal(editorSpec({ slot: { dir: null } }, { editor: 'Cursor' }), null)
})

test('editorSpec: falls back to Cursor before config has loaded', () => {
  // state.config is null until /api/config returns; the first render must not crash or
  // put "undefined" in the tooltip.
  for (const config of [null, undefined, {}]) {
    const spec = editorSpec({ slot: { dir: '/w/PY-2' } }, config)
    assert.equal(spec.editor, 'Cursor')
    assert.match(spec.title, /in Cursor$/)
  }
})

test('editorSpec: a configured editor name reaches the tooltip', () => {
  assert.match(editorSpec({ slot: { dir: '/w/PY-2' } }, { editor: 'Zed' }).title, /in Zed$/)
})


// --- idleChip: the board's only sense of time ------------------------------------------

const DAY = 86_400_000
const NOW = Date.parse('2026-08-27T10:00:00Z')
const agedPr = (days) => ({ updatedAt: new Date(NOW - days * DAY).toISOString() })

test('idleChip: nothing under a day — "idle 2h" on every card is noise', () => {
  for (const hours of [0, 1, 5, 23.9]) {
    assert.equal(idleChip({ updatedAt: new Date(NOW - hours * 3_600_000).toISOString() }, NOW), null,
      `${hours}h must not render a chip`)
  }
})

test('idleChip: whole days, escalating by how long it has sat', () => {
  assert.deepEqual(idleChip(agedPr(1), NOW), { cls: '', text: 'idle 1d', days: 1 })
  assert.deepEqual(idleChip(agedPr(2), NOW), { cls: '', text: 'idle 2d', days: 2 })
  assert.equal(idleChip(agedPr(3), NOW).cls, 'warn', 'three days is a nudge')
  assert.equal(idleChip(agedPr(6), NOW).cls, 'warn')
  assert.equal(idleChip(agedPr(7), NOW).cls, 'bad', 'a week is a problem')
  assert.equal(idleChip(agedPr(30), NOW).text, 'idle 30d')
})

test('idleChip: a missing or unparseable timestamp says nothing, never "idle NaNd"', () => {
  for (const updatedAt of [null, undefined, '', 'not a date', 'yesterday']) {
    assert.equal(idleChip({ updatedAt }, NOW), null, JSON.stringify(updatedAt))
  }
  assert.equal(idleChip(null, NOW), null)
  assert.equal(idleChip({}, NOW), null)
})

test('idleChip: a future timestamp (clock skew) renders nothing rather than a negative age', () => {
  assert.equal(idleChip({ updatedAt: new Date(NOW + 5 * DAY).toISOString() }, NOW), null)
})

// --- shouldCollect: do not poll for a tab nobody is looking at -------------------------

test('shouldCollect: a hidden tab never collects', () => {
  assert.equal(shouldCollect({ visibility: 'hidden', lastLoadedAt: 0, now: NOW }), false)
  // Not even when the data on screen is ancient — there is nobody to show it to.
  assert.equal(shouldCollect({ visibility: 'hidden', lastLoadedAt: NOW - 10 * DAY, now: NOW, minAgeMs: 60_000 }), false)
})

test('shouldCollect: a visible tab collects on the interval tick regardless of age', () => {
  // minAgeMs defaults to 0: the tick IS the schedule, so it does not second-guess itself.
  assert.equal(shouldCollect({ visibility: 'visible', lastLoadedAt: NOW - 1000, now: NOW }), true)
})

test('shouldCollect: coming back to a tab only collects if the board is actually stale', () => {
  // Flicking between tabs must not fire a ~6s collection every time.
  assert.equal(shouldCollect({ visibility: 'visible', lastLoadedAt: NOW - 5_000, now: NOW, minAgeMs: 60_000 }), false)
  assert.equal(shouldCollect({ visibility: 'visible', lastLoadedAt: NOW - 61_000, now: NOW, minAgeMs: 60_000 }), true)
  // Exactly at the boundary counts as stale.
  assert.equal(shouldCollect({ visibility: 'visible', lastLoadedAt: NOW - 60_000, now: NOW, minAgeMs: 60_000 }), true)
})

test('shouldCollect: an unfamiliar visibilityState fails OPEN, still polling', () => {
  // Failing closed here would mean a browser reporting something we did not anticipate
  // silently stops updating the board forever, which is the worse of the two directions.
  for (const visibility of ['prerender', 'unloaded', undefined, null, '']) {
    assert.equal(shouldCollect({ visibility, lastLoadedAt: 0, now: NOW }), true, String(visibility))
  }
})

test('shouldCollect: never loaded yet is always stale enough', () => {
  assert.equal(shouldCollect({ visibility: 'visible', now: NOW, minAgeMs: 60_000 }), true)
})


test('prBehindChip says nothing for a PR we never compared', () => {
  // A colleague's review-requested PR is never compared, so reporting "unknown" would claim
  // a failure that never happened — it showed as "BEHIND MASTER: UNKNOWN" on the live board.
  const theirs = { isMine: false, baseRefName: 'master', baseCompare: { behind: null, known: false } }
  assert.equal(prBehindChip(theirs), null)
  // Our own unread comparison DOES still say unknown, because we did try.
  const mine = { isMine: true, baseRefName: 'master', baseCompare: { behind: null, known: false } }
  assert.match(prBehindChip(mine).text, /unknown/)
})


// --- what a checkout is holding --------------------------------------------------------

test('slotHolding names the PR a detached checkout is reviewing', () => {
  const h = slotHolding({ dir: '/w/PY-1', branch: null, headSha: 'abc12345def', holdingPr: 7353 })
  assert.equal(h.text, 'reviewing #7353')
  assert.equal(h.cls, 'slot-reviewing', 'and is coloured differently — it is not your work')
})

test('slotHolding shows the branch when there is one', () => {
  assert.deepEqual(slotHolding({ branch: 'PY-1-x', headSha: 'abc' }),
    { text: 'PY-1-x', cls: 'slot-branch' })
})

test('slotHolding falls back to the sha, not a bare "detached"', () => {
  // Unattributable but at least traceable by hand.
  assert.equal(slotHolding({ branch: null, headSha: 'abc12345deadbeef' }).text, 'detached at abc12345')
  assert.equal(slotHolding({ branch: null, headSha: null }).text, 'detached')
})

test('slotHolding on no slot is null', () => {
  assert.equal(slotHolding(null), null)
  assert.equal(slotHolding(undefined), null)
})

test('idleSlotsLine lists spare checkouts compactly, with their state', () => {
  const line = idleSlotsLine([
    { dir: '/w/PY-3', branch: 'master', headSha: 'a', dirty: false, dirtyCount: 0 },
    { dir: '/w/PY-4', branch: null, headSha: 'deadbeef1234', dirty: true, dirtyCount: 3 },
  ], null)
  assert.match(line, /free checkouts:/)
  assert.match(line, /PY-3 \(master\)/)
  // A dirty spare is not silently "free" — it holds something.
  assert.match(line, /PY-4 \(detached at deadbeef · 3 uncommitted\)/)
})

test('idleSlotsLine says nothing when every checkout is claimed', () => {
  assert.equal(idleSlotsLine([], null), null)
  assert.equal(idleSlotsLine(undefined, null), null)
})

// --- folding quiet branches, and flagging urgent ones ----------------------------------
//
// Half of a five-branch card was blocks that needed nothing: 472px of 946px, measured. A block
// folds to one line unless it is why the card sits in the lane it does. Nothing is REORDERED to
// achieve this — the blocks stay in creation order, because pr3 reading above pr2 would lie
// about the shape of the work, so urgency is flagged where the block already sits.

const brl = (lane, o = {}) => ({ name: 'PY-1-x', repo: 'O/R', pr: null, slot: null, detached: false, lane, reasons: [], ...o })

test('a lone branch is always expanded — there is nothing to fold', () => {
  const item = { lane: 'backlog', branches: [brl('backlog')] }
  assert.equal(branchExpanded(item, item.branches[0], 0), true)
})

test('branches that explain the card\'s lane are open; the rest fold', () => {
  const branches = [brl('waiting', { name: 'PY-1-a' }), brl('in-flight', { name: 'PY-1-b' }), brl('needs-you', { name: 'PY-1-c' })]
  const item = { lane: 'needs-you', branches }
  assert.deepEqual(branches.map((b, i) => branchExpanded(item, b, i)), [false, false, true])
})

test('several branches can be open at once when several need you', () => {
  const branches = [brl('needs-you', { name: 'PY-1-a' }), brl('in-flight', { name: 'PY-1-b' }), brl('needs-you', { name: 'PY-1-c' })]
  const item = { lane: 'needs-you', branches }
  assert.deepEqual(branches.map((b, i) => branchExpanded(item, b, i)), [true, false, true])
})

test('when the LANE comes from the ticket, the first branch opens rather than none', () => {
  // ready-to-start and backlog are decided by the Jira status, not by any branch — so no
  // branch's lane matches, and a card of nothing but one-liners would say nothing at all.
  const branches = [brl('in-flight', { name: 'PY-1-a' }), brl('in-flight', { name: 'PY-1-b' })]
  const item = { lane: 'ready-to-start', branches }
  assert.deepEqual(branches.map((b, i) => branchExpanded(item, b, i)), [true, false])
})

test('branchSummary carries enough to decide whether to unfold', () => {
  const s = branchSummary({ key: 'PY-12746' }, {
    name: 'PY-12746-catalog-pr3-scoring-rules', lane: 'needs-you',
    pr: { number: 7211 }, slot: { dir: '/Users/cweiner/Work/PY-3' },
    reasons: ['required check failing: Linting', 'changes requested', '3 open review threads on #7211'],
  })
  assert.deepEqual(s, {
    pr: 7211, name: 'catalog-pr3-scoring-rules', slot: 'PY-3', lane: 'needs-you',
    note: 'required check failing: Linting', more: 2,
  })
})

test('branchSummary on a branch with nothing to say says nothing, not undefined', () => {
  const s = branchSummary({ key: 'PY-1' }, { name: 'PY-1-quiet', lane: 'in-flight', pr: null, slot: null, reasons: [] })
  assert.equal(s.note, null)
  assert.equal(s.more, 0)
  assert.equal(s.pr, null)
  assert.equal(s.slot, null)
})

test('plansSummary states how many files are SELECTED, not just how many exist', () => {
  // Folding something that quietly feeds --add-dir arguments to Claude must not also hide
  // how many it is feeding.
  const plans = [{ folder: 'A', files: ['plan.md'] }, { folder: 'B', files: ['a.md', 'b.md', 'c.md'] }]
  assert.equal(plansSummary(plans), 'plans — 4 of 4 files · 2 folders')
  assert.equal(plansSummary(plans, 1), 'plans — 1 of 4 files · 2 folders')
  assert.equal(plansSummary([{ folder: 'A', files: ['only.md'] }]), 'plans — 1 of 1 file · 1 folder')
  assert.equal(plansSummary([]), 'plans — 0 of 0 files · 0 folders')
})
