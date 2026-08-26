// test/merge.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergePr } from '../actions/merge.js'

// requiredChecks.known: true means the check state was actually read; lanes.js's
// mergeGateFor blocks whenever it is not exactly true (see lanes.js). A fixture
// standing in for a PR whose checks were verified must say so explicitly.
const pr = (o = {}) => ({ repo: 'O/R', number: 7230, title: 'Fix the thing',
  reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false,
  requiredChecks: { total: 6, failing: [], known: true }, isMine: true, url: 'u', ...o })
const item = (p) => ({ id: 'PY-1', key: 'PY-1', repo: 'O/R', prs: [p] })

test('merges when the gate passes and the action is confirmed', async () => {
  const calls = []
  const run = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: 0, stdout: 'merged', stderr: '' } }
  const r = await mergePr({ item: item(pr()), prNumber: 7230, confirmed: true }, { run })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^gh pr merge 7230 --repo O\/R --squash/)
})

test('ONLY boolean true confirms — no truthy coercion', async () => {
  // confirmed:"false" / "no" / 1 / {} are all truthy in JS. An irreversible public action
  // must not accept any of them.
  for (const bad of ['true', 'false', 'no', 1, '0', {}, [], 'yes']) {
    let ran = 0
    const r = await mergePr({ item: item(pr()), prNumber: 7230, confirmed: bad },
      { run: async () => { ran++; return { code: 0, stdout: 'merged', stderr: '' } } })
    assert.equal(ran, 0, `confirmed=${JSON.stringify(bad)} must NOT merge`)
    assert.equal(r.ok, false)
  }
  // and the real thing still works
  let ok = 0
  const good = await mergePr({ item: item(pr()), prNumber: 7230, confirmed: true },
    { run: async () => { ok++; return { code: 0, stdout: 'merged', stderr: '' } } })
  assert.equal(ok, 1)
  assert.equal(good.ok, true)
})

test("refuses to merge someone else's PR", async () => {
  let ran = 0
  const r = await mergePr({ item: item(pr({ isMine: false })), prNumber: 7230, confirmed: true },
    { run: async () => { ran++; return { code: 0, stdout: 'merged', stderr: '' } } })
  assert.equal(ran, 0, 'must not merge a review-requested PR')
  assert.equal(r.ok, false)
  assert.match(r.message, /authored by someone else/)
})

test('refuses without confirmation', async () => {
  let ran = false
  const r = await mergePr({ item: item(pr()), prNumber: 7230, confirmed: false },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(r.ok, false)
  assert.match(r.message, /confirm/i)
  assert.equal(ran, false)
})

test('re-checks the gate server-side and refuses a failing required check', async () => {
  let ran = false
  const bad = pr({ requiredChecks: { total: 6, failing: ['QA Code Review'], known: true } })
  const r = await mergePr({ item: item(bad), prNumber: 7230, confirmed: true },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } } })
  assert.equal(r.ok, false)
  assert.match(r.message, /QA Code Review/)
  assert.equal(ran, false, 'must not call gh when the gate fails')
})

test('refuses a draft, a conflict, and an unapproved PR', async () => {
  for (const bad of [pr({ isDraft: true }), pr({ mergeable: 'CONFLICTING' }), pr({ reviewDecision: 'REVIEW_REQUIRED' })]) {
    const r = await mergePr({ item: item(bad), prNumber: 7230, confirmed: true },
      { run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    assert.equal(r.ok, false)
  }
})

test('allows a PR with zero required checks', async () => {
  const r = await mergePr({ item: item(pr({ requiredChecks: { total: 0, failing: [], known: true } })), prNumber: 7230, confirmed: true },
    { run: async () => ({ code: 0, stdout: 'merged', stderr: '' }) })
  assert.equal(r.ok, true)
})

test('reports an unknown PR number', async () => {
  const r = await mergePr({ item: item(pr()), prNumber: 9999, confirmed: true },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  assert.equal(r.ok, false)
  assert.match(r.message, /9999/)
})

test('surfaces a gh failure', async () => {
  const r = await mergePr({ item: item(pr()), prNumber: 7230, confirmed: true },
    { run: async () => ({ code: 1, stdout: '', stderr: 'not authorized to merge' }) })
  assert.equal(r.ok, false)
  assert.match(r.message, /not authorized/)
})

test('dry run does not merge', async () => {
  let ran = false
  const r = await mergePr({ item: item(pr()), prNumber: 7230, confirmed: true },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } }, dry: true })
  assert.equal(r.ok, true)
  assert.equal(ran, false)
  assert.match(r.detail, /gh pr merge 7230/)
})
