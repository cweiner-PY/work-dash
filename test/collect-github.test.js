// test/collect-github.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRequiredChecks, normalizePr, fetchGithub, hasHumanReviewFeedback,
         parseBaseCompare, parsePrSearch, searchQueries, latestChangesRequestedAt } from '../collect/github.js'
import { mergeGateFor } from '../lanes.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))

// One recorded `gh api graphql` PR search, 2026-08-27 — the single call that replaced four
// sequential `gh pr list` invocations.
const SEARCH_FX = 'gh-graphql-prs.json'
const searchStdout = () => JSON.stringify(fx(SEARCH_FX))
const node = (n) => {
  const d = fx(SEARCH_FX).data
  return [...d.mine.nodes, ...d.reviewRequested.nodes].find((x) => x.number === n)
}

// The fakes must tell the two `gh api graphql` calls apart: the PR search carries a `mine=`
// field, the base comparison carries `owner=`. Matching on 'graphql' alone would make every
// fake answer the search with a comparison response.
const isSearch = (args) => args.some((a) => String(a).startsWith('mine='))

test('parseRequiredChecks names the failing required checks (#7230)', () => {
  const r = parseRequiredChecks(fx('gh-checks-required-7230.json'))
  assert.equal(r.total, 6)
  assert.deepEqual(r.failing, ['QA Code Review'])
})

test('parseRequiredChecks on #7110 finds two failures', () => {
  const r = parseRequiredChecks(fx('gh-checks-required-7110.json'))
  assert.deepEqual(r.failing.sort(), ['Linting', 'Type Check'])
})

test('parseRequiredChecks on an EMPTY list means zero total and nothing failing', () => {
  const r = parseRequiredChecks(fx('gh-checks-required-704.json'))
  assert.deepEqual(r, { total: 0, failing: [], pending: [], known: true })
})

test('parseRequiredChecks splits PENDING/QUEUED into pending, not failing', () => {
  const r = parseRequiredChecks([
    { name: 'Unit Tests', state: 'PENDING' },
    { name: 'Build', state: 'QUEUED' },
    { name: 'Linting', state: 'SUCCESS' },
  ])
  assert.equal(r.total, 3)
  assert.deepEqual(r.failing, [])
  assert.deepEqual(r.pending.sort(), ['Build', 'Unit Tests'])
  assert.equal(r.known, true)
})

test('parseRequiredChecks: a genuinely failing check still lands in failing alongside a pending one', () => {
  const r = parseRequiredChecks([
    { name: 'Unit Tests', state: 'PENDING' },
    { name: 'Linting', state: 'FAILURE' },
  ])
  assert.deepEqual(r.failing, ['Linting'])
  assert.deepEqual(r.pending, ['Unit Tests'])
})

test('normalizePr maps the fields the board needs', () => {
  const pr = normalizePr(node(7110), { mine: true, myLogin: 'cweiner-PY' })
  assert.equal(pr.number, 7110)
  // The repo now comes from the node itself, not a parameter — one query spans every repo,
  // so the caller no longer knows which repo a given PR came from.
  assert.equal(pr.repo, 'PerformYard/PerformYard')
  assert.equal(pr.headRefName, 'PY-12746-competency-management-prototype-competency-catalog')
  assert.equal(pr.baseRefName, 'master')
  assert.equal(pr.reviewDecision, 'REVIEW_REQUIRED')
  assert.equal(pr.isDraft, true)
  assert.equal(pr.isMine, true)
  assert.ok(pr.lastCommitAt, 'the last commit date must survive — changesAddressed needs it')
  assert.deepEqual(pr.requiredChecks, { total: 0, failing: [], known: false }) // filled in later
  assert.equal(pr.baseCompare.known, false)                                    // filled in later
})

test('normalizePr carries mergeStateStatus and defaults it to null when absent', () => {
  assert.equal(normalizePr(node(7230), { mine: true, myLogin: 'me' }).mergeStateStatus, 'BLOCKED')
  const bare = { number: 1, repository: { nameWithOwner: 'O/R' } }
  assert.equal(normalizePr(bare, { mine: true, myLogin: 'me' }).mergeStateStatus, null)
})

test('normalizePr survives a node with nothing optional on it', () => {
  // Search can return a PullRequest whose nested connections came back empty; none of that
  // may throw, since one bad node would take the whole GitHub source down with it.
  const pr = normalizePr({ number: 9, repository: { nameWithOwner: 'O/R' } }, { mine: false, myLogin: 'me' })
  assert.equal(pr.lastCommitAt, null)
  assert.equal(pr.changesRequestedAt, null)
  assert.equal(pr.hasReviewComments, false)
  assert.equal(pr.isMine, false)
})

test('hasReviewComments is true only for human teammate feedback', () => {
  const ME = 'cweiner-PY'
  // #7230 carries 12 COMMENTED reviews, from the cursor bot AND teammate jleo-py (MEMBER).
  assert.equal(normalizePr(node(7230), { mine: true, myLogin: ME }).hasReviewComments, true)
  // #7110 has no reviews at all (bot issue-comments are not reviews).
  assert.equal(normalizePr(node(7110), { mine: true, myLogin: ME }).hasReviewComments, false)
})

test('hasHumanReviewFeedback ignores bots and the user themselves', () => {
  const ME = 'cweiner-PY'
  const bot = { author: { login: 'cursor' }, authorAssociation: 'NONE', state: 'COMMENTED' }
  const mine = { author: { login: ME }, authorAssociation: 'MEMBER', state: 'COMMENTED' }
  const mate = { author: { login: 'jleo-py' }, authorAssociation: 'MEMBER', state: 'COMMENTED' }
  const approve = { author: { login: 'jleo-py' }, authorAssociation: 'MEMBER', state: 'APPROVED' }
  const changes = { author: { login: 'jleo-py' }, authorAssociation: 'MEMBER', state: 'CHANGES_REQUESTED' }
  assert.equal(hasHumanReviewFeedback([bot], ME), false, 'a bot is not feedback')
  assert.equal(hasHumanReviewFeedback([mine], ME), false, 'your own comment is not feedback for you')
  assert.equal(hasHumanReviewFeedback([approve], ME), false, 'a bare approval is not feedback to resolve')
  assert.equal(hasHumanReviewFeedback([mate], ME), true)
  assert.equal(hasHumanReviewFeedback([changes], ME), true)
  assert.equal(hasHumanReviewFeedback([bot, mine, approve, mate], ME), true, 'one real comment among noise counts')
  assert.equal(hasHumanReviewFeedback([], ME), false)
  assert.equal(hasHumanReviewFeedback(undefined, ME), false)
})

// gh api graphql response for Ref.compare, recorded live 2026-08-27. Every fake `run`
// answers the compare call from these rather than falling through to the pr-list branch.
const compareFx = (name) => JSON.stringify(fx(name))
const isCompare = (args) => args.some((a) => String(a).startsWith('owner='))

// --- the consolidated PR search --------------------------------------------------------

test('searchQueries scopes the search to the configured repos ONLY', () => {
  // Unscoped, `is:pr is:open author:@me` would pull in every PR the user has open anywhere
  // on GitHub — personal projects, other orgs — and quietly present them as work.
  const q = searchQueries({ repos: { 'O/A': {}, 'O/B': {} } })
  assert.match(q.mine, /is:pr is:open author:@me/)
  assert.match(q.mine, /repo:O\/A/)
  assert.match(q.mine, /repo:O\/B/)
  assert.match(q.review, /review-requested:@me/)
  assert.match(q.review, /repo:O\/A repo:O\/B/)
  assert.ok(!q.mine.includes('review-requested'), 'the two queries must not blur together')
})

test('parsePrSearch pulls both result sets out of the recorded response', () => {
  const { mine, review } = parsePrSearch(searchStdout())
  assert.deepEqual(mine.map((n) => n.number).sort(), [704, 7110, 7230])
  assert.deepEqual(review.map((n) => n.number), [7353])
})

test('parsePrSearch returns null — not an empty array — when it cannot read a result set', () => {
  // The distinction is load-bearing: null means "the call failed" and is reported as an
  // error, while [] means "you genuinely have no PRs" and is a valid board.
  for (const bad of ['', 'not json', '{}', 'null', '{"data":{}}']) {
    const r = parsePrSearch(bad)
    assert.equal(r.mine, null, JSON.stringify(bad))
    assert.equal(r.review, null, JSON.stringify(bad))
  }
  const empty = parsePrSearch(JSON.stringify({ data: { mine: { nodes: [] }, reviewRequested: { nodes: [] } } }))
  assert.deepEqual(empty.mine, [])
  assert.deepEqual(empty.review, [])
})

test('parsePrSearch drops non-PullRequest search hits rather than normalising them', () => {
  const mixed = JSON.stringify({ data: {
    mine: { nodes: [{}, { number: 5, repository: { nameWithOwner: 'O/R' } }, null] },
    reviewRequested: { nodes: [] },
  } })
  assert.deepEqual(parsePrSearch(mixed).mine.map((n) => n.number), [5])
})

test('parsePrSearch uses data that arrives alongside a GraphQL errors array', () => {
  const partial = JSON.stringify({
    data: { mine: { nodes: [{ number: 1, repository: { nameWithOwner: 'O/R' } }] }, reviewRequested: null },
    errors: [{ message: 'something failed' }],
  })
  const r = parsePrSearch(partial)
  assert.deepEqual(r.mine.map((n) => n.number), [1], 'usable data must not be thrown away')
  assert.equal(r.review, null)
})

// --- latestChangesRequestedAt ----------------------------------------------------------

test('latestChangesRequestedAt takes the NEWEST changes-requested review', () => {
  // Reviews arrive in no guaranteed order, so taking the last element of the array would
  // silently use an older review and make an addressed PR look unaddressed (or worse).
  const reviews = [
    { state: 'CHANGES_REQUESTED', submittedAt: '2026-08-20T10:00:00Z' },
    { state: 'COMMENTED', submittedAt: '2026-08-26T10:00:00Z' },
    { state: 'CHANGES_REQUESTED', submittedAt: '2026-08-25T10:00:00Z' },
    { state: 'CHANGES_REQUESTED', submittedAt: '2026-08-22T10:00:00Z' },
  ]
  assert.equal(latestChangesRequestedAt(reviews), '2026-08-25T10:00:00.000Z')
})

test('latestChangesRequestedAt ignores every other review state', () => {
  assert.equal(latestChangesRequestedAt([
    { state: 'APPROVED', submittedAt: '2026-08-26T10:00:00Z' },
    { state: 'COMMENTED', submittedAt: '2026-08-26T10:00:00Z' },
  ]), null)
})

test('latestChangesRequestedAt on missing, empty or unparseable input is null', () => {
  assert.equal(latestChangesRequestedAt(undefined), null)
  assert.equal(latestChangesRequestedAt([]), null)
  assert.equal(latestChangesRequestedAt([{ state: 'CHANGES_REQUESTED' }]), null)
  assert.equal(latestChangesRequestedAt([{ state: 'CHANGES_REQUESTED', submittedAt: 'nope' }]), null)
})

// --- fetchGithub -----------------------------------------------------------------------

// Builds a PR-search response of the shape fetchGithub parses, from plain descriptions.
const prNode = (o) => ({
  number: o.number, title: o.title ?? 't', url: o.url ?? 'u',
  isDraft: Boolean(o.isDraft), mergeable: o.mergeable ?? 'MERGEABLE',
  reviewDecision: o.reviewDecision ?? null, mergeStateStatus: o.mergeStateStatus ?? null,
  updatedAt: o.updatedAt ?? null,
  headRefName: o.headRefName ?? 'b',
  // `in` rather than ?? so a test can assert the missing-base-ref path.
  ...('baseRefName' in o ? { baseRefName: o.baseRefName } : { baseRefName: 'master' }),
  repository: { nameWithOwner: o.repo ?? 'O/R' },
  reviews: { nodes: o.reviews ?? [] },
  commits: { nodes: [{ commit: { committedDate: o.lastCommitAt ?? '2026-01-01T00:00:00Z' } }] },
})
const searchResponse = ({ mine = [], review = [] } = {}) =>
  JSON.stringify({ data: { mine: { nodes: mine.map(prNode) }, reviewRequested: { nodes: review.map(prNode) } } })

const CONFIG = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/PerformYard': {}, 'PerformYard/Logan': {} } }

test('fetchGithub makes ONE search call for every repo, then enriches each PR', async () => {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, ...args.slice(0, 3)].join(' '))
    if (isSearch(args)) return { code: 0, stdout: searchStdout(), stderr: '' }
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    const n = args[2]   // ['pr','checks','<number>',...]
    return { code: 0, stdout: JSON.stringify(fx(`gh-checks-required-${n}.json`)), stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })

  assert.deepEqual(errors, [])
  assert.equal(prs.length, 4, 'three authored plus one review-requested')
  // Exactly one search, regardless of repo count — this is the whole point of the change.
  assert.equal(calls.filter((c) => c.startsWith('gh api graphql')).length - 3, 1)
  assert.deepEqual(prs.filter((p) => p.isMine).map((p) => p.number).sort(), [704, 7110, 7230])
  assert.deepEqual(prs.filter((p) => !p.isMine).map((p) => p.number), [7353])
  assert.deepEqual(prs.find((p) => p.number === 7230).requiredChecks.failing, ['QA Code Review'])
  assert.deepEqual(prs.find((p) => p.number === 704).requiredChecks,
    { total: 0, failing: [], pending: [], known: true })
})

test('a failed search is reported and yields no PRs, rather than a silently empty board', async () => {
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 1, stdout: '', stderr: 'gh: could not authenticate' }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.deepEqual(prs, [])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /pr search failed/)
  assert.match(errors[0], /could not authenticate/)
})

test('a genuinely empty search is NOT an error — it means you have no open PRs', async () => {
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse(), stderr: '' }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.deepEqual(prs, [])
  assert.deepEqual(errors, [], 'zero PRs is a valid board, not a failure')
})

test('one result set failing keeps the other AND says so', async () => {
  // The single call replaced a per-repo loop that could keep one repo when another failed.
  // Partial GraphQL data is therefore used, and the shortfall reported rather than hidden.
  const run = async (cmd, args) => {
    if (isSearch(args)) {
      return { code: 1, stderr: 'partial failure', stdout: JSON.stringify({
        data: { mine: { nodes: [prNode({ number: 1 })] }, reviewRequested: null },
        errors: [{ message: 'boom' }],
      }) }
    }
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.deepEqual(prs.map((p) => p.number), [1], 'the half that arrived is kept')
  assert.ok(errors.some((e) => /only part of the result/.test(e)), 'and the half that did not is reported')
})

test('a search that fills the result limit warns about truncation', async () => {
  // Same discipline as the Jira collector: a partial board must not present itself as whole.
  const many = Array.from({ length: 50 }, (_, i) => ({ number: i + 1 }))
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: many }), stderr: '' }
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { errors } = await fetchGithub(CONFIG, { run })
  assert.ok(errors.some((e) => /authored PR search hit the 50-result limit/.test(e)))
})

test('gh reporting NO required checks is a known zero, not a failure', async () => {
  // Real gh 2.86.0 behaviour for PerformYard/Logan: exit 1, empty stdout, and
  // "no required checks reported on the '<branch>' branch" on stderr. Treating that as a
  // collection failure would make every Logan PR permanently unmergeable.
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: [{ number: 704, repo: 'PerformYard/Logan' }] }), stderr: '' }
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' }
    return { code: 1, stdout: '', stderr: "no required checks reported on the 'feat/x' branch" }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.deepEqual(prs[0].requiredChecks, { total: 0, failing: [], pending: [], known: true })
  assert.deepEqual(errors, [], 'a determined zero is not an error')
})

test('a determined zero is still MERGEABLE once approved', () => {
  // The whole point: Logan PRs must remain mergeable from the dashboard.
  const gate = mergeGateFor({
    reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false,
    requiredChecks: { total: 0, failing: [], known: true },
  })
  assert.equal(gate.allowed, true, gate.blockers.join('; '))
})

test('a genuine gh-checks failure is RECORDED and leaves the gate unknown', async () => {
  // The dangerous case: gh itself fails (expired auth, offline, gh missing). Empty stdout
  // must NOT be read as "no required checks are failing".
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: [{ number: 704 }] }), stderr: '' }
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' }
    return { code: 1, stdout: '', stderr: 'gh: could not authenticate' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.equal(prs[0].requiredChecks.known, false, 'gate must remain unknown')
  assert.ok(errors.some((e) => /could not fetch required checks/.test(e)))
  assert.ok(!errors.some((e) => /no required checks/i.test(e)), 'must not be read as a determined zero')
})

test('a checks call that exits non-zero BUT returns valid json is still parsed', async () => {
  // The exit-code trap: gh exits 1 precisely because a check is failing. That data is the
  // most important data we collect, so it must not be discarded.
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: [{ number: 7230 }] }), stderr: '' }
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    return { code: 1, stdout: JSON.stringify(fx('gh-checks-required-7230.json')), stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.equal(prs[0].requiredChecks.known, true)
  assert.deepEqual(prs[0].requiredChecks.failing, ['QA Code Review'])
  assert.deepEqual(errors, [])
})

// --- the base comparison ---------------------------------------------------------------

test('fetchGithub compares OWN PRs only, and passes the real base and head refs', async () => {
  const compareCalls = []
  const run = async (cmd, args) => {
    if (isSearch(args)) {
      return { code: 0, stdout: searchResponse({
        mine: [{ number: 704, repo: 'PerformYard/Logan', headRefName: 'feat/x', baseRefName: 'master' }],
        review: [{ number: 999, repo: 'PerformYard/Logan', headRefName: 'theirs' }],
      }), stderr: '' }
    }
    if (isCompare(args)) { compareCalls.push(args.join(' ')); return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' } }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })

  assert.deepEqual(errors, [])
  assert.equal(prs.find((p) => p.number === 704).baseCompare.behind, 24)
  assert.equal(prs.find((p) => p.number === 999).baseCompare.known, false, "a colleague's PR is never compared")
  assert.equal(compareCalls.length, 1, 'exactly one comparison, for the one own PR')
  assert.match(compareCalls[0], /base=master/)
  assert.match(compareCalls[0], /head=feat\/x/)
  assert.match(compareCalls[0], /name=Logan/)
  assert.ok(!compareCalls[0].includes('theirs'))
})

test('the comparison uses raw string fields, so a branch named like a literal survives', async () => {
  // gh's typed -F coerces values that look like numbers, booleans or null. A branch
  // legitimately named "null" must reach GraphQL as the string "null".
  let seen = null
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: [{ number: 1, headRefName: 'null' }] }), stderr: '' }
    if (isCompare(args)) { seen = args; return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' } }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  await fetchGithub(CONFIG, { run })
  assert.ok(seen, 'the comparison must have been attempted')
  assert.ok(!seen.includes('-F'), "must never use gh's typed field flag")
  assert.ok(seen.includes('head=null'), 'the branch name must pass through verbatim')
})

test('a failed comparison is RECORDED and leaves the PR unknown, not up to date', async () => {
  // The dangerous direction: the call fails and behind silently reads as 0.
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: [{ number: 1 }] }), stderr: '' }
    if (isCompare(args)) return { code: 1, stdout: compareFx('gh-compare-notfound.json'), stderr: "Could not resolve head ref 'x'." }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.equal(prs.length, 1, 'the PR itself must survive a failed comparison')
  assert.equal(prs[0].baseCompare.known, false)
  assert.equal(prs[0].baseCompare.behind, null)
  assert.ok(errors.some((e) => /could not compare/.test(e)))
  assert.ok(errors.some((e) => /Could not resolve head ref/.test(e)))
})

test('a comparison that exits non-zero BUT returns a usable answer is still used', async () => {
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: [{ number: 1 }] }), stderr: '' }
    if (isCompare(args)) return { code: 1, stdout: compareFx('gh-compare-7230.json'), stderr: 'some warning' }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.equal(prs[0].baseCompare.behind, 24)
  assert.deepEqual(errors, [])
})

test('a PR missing its base ref name is reported, never silently compared', async () => {
  let attempted = 0
  const run = async (cmd, args) => {
    if (isSearch(args)) return { code: 0, stdout: searchResponse({ mine: [{ number: 5, baseRefName: null }] }), stderr: '' }
    if (isCompare(args)) { attempted++; return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' } }
    return { code: 0, stdout: '[]', stderr: '' }
  }
  const { prs, errors } = await fetchGithub(CONFIG, { run })
  assert.equal(attempted, 0, 'must not guess a base branch')
  assert.equal(prs[0].baseCompare.known, false)
  assert.ok(errors.some((e) => /missing ref names/.test(e)))
})

test('parseBaseCompare reads the real GraphQL response for #7230', () => {
  // Recorded live 2026-08-27, when #7230 sat 24 commits behind master while the board
  // reported "up to date" because its mergeStateStatus was BLOCKED.
  const c = parseBaseCompare(JSON.stringify(fx('gh-compare-7230.json')))
  assert.deepEqual(c, { behind: 24, ahead: 18, status: 'DIVERGED', known: true })
})

test('parseBaseCompare reads the real GraphQL response for Logan #704', () => {
  const c = parseBaseCompare(JSON.stringify(fx('gh-compare-704.json')))
  assert.deepEqual(c, { behind: 5, ahead: 7, status: 'DIVERGED', known: true })
})

test('parseBaseCompare: a NOT_FOUND response is unknown, never zero', () => {
  // The real failure shape, recorded live: compare:null alongside an errors array, with
  // gh exiting non-zero. behind must be null so no caller can read it as "up to date".
  const c = parseBaseCompare(JSON.stringify(fx('gh-compare-notfound.json')))
  assert.equal(c.known, false)
  assert.equal(c.behind, null)
})

test('parseBaseCompare: unparseable or empty output is unknown', () => {
  for (const bad of ['', 'not json', '{}', 'null', '{"data":{"repository":null}}']) {
    assert.equal(parseBaseCompare(bad).known, false, JSON.stringify(bad))
    assert.equal(parseBaseCompare(bad).behind, null, JSON.stringify(bad))
  }
})

test('parseBaseCompare: a non-numeric or missing count is unknown, not coerced', () => {
  // Absence of a number is absence of knowledge. Reading a missing behindBy as 0 is the
  // precise shape of the bug this whole comparison exists to fix.
  const wrap = (compare) => JSON.stringify({ data: { repository: { ref: { compare } } } })
  assert.equal(parseBaseCompare(wrap({ aheadBy: 1 })).known, false, 'behindBy missing')
  assert.equal(parseBaseCompare(wrap({ behindBy: 2 })).known, false, 'aheadBy missing')
  assert.equal(parseBaseCompare(wrap({ aheadBy: 1, behindBy: null })).known, false)
  assert.equal(parseBaseCompare(wrap({ aheadBy: 1, behindBy: '3' })).known, false, 'a string is not a count')
  // A legitimate zero IS knowledge, and must survive.
  assert.deepEqual(parseBaseCompare(wrap({ aheadBy: 4, behindBy: 0, status: 'AHEAD' })),
    { behind: 0, ahead: 4, status: 'AHEAD', known: true })
})
