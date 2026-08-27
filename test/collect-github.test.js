// test/collect-github.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { summarizeChecks, parseRequiredChecks, normalizePr, fetchGithub, hasHumanReviewFeedback, parseBaseCompare } from '../collect/github.js'
import { mergeGateFor } from '../lanes.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))

test('summarizeChecks counts pass, fail and pending; CANCELLED is neither', () => {
  const s = summarizeChecks([
    { conclusion: 'SUCCESS', status: 'COMPLETED' },
    { conclusion: 'FAILURE', status: 'COMPLETED' },
    { conclusion: 'CANCELLED', status: 'COMPLETED' },
    { conclusion: null, status: 'IN_PROGRESS' },
  ])
  assert.deepEqual(s, { pass: 1, fail: 1, pending: 1 })
})

test('summarizeChecks on the real #7230 rollup', () => {
  const pr = fx('gh-prs-PerformYard_PerformYard.json').find((p) => p.number === 7230)
  const s = summarizeChecks(pr.statusCheckRollup)
  assert.ok(s.fail > 0, 'expected failures')
  assert.ok(s.pass > 40, 'expected many passes')
})

test('summarizeChecks handles a missing rollup', () => {
  assert.deepEqual(summarizeChecks(undefined), { pass: 0, fail: 0, pending: 0 })
})

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
  const raw = fx('gh-prs-PerformYard_PerformYard.json').find((p) => p.number === 7110)
  const pr = normalizePr(raw, 'PerformYard/PerformYard', { mine: true, myLogin: 'cweiner-PY' })
  assert.equal(pr.number, 7110)
  assert.equal(pr.repo, 'PerformYard/PerformYard')
  assert.equal(pr.headRefName, 'PY-12746-competency-management-prototype-competency-catalog')
  assert.equal(pr.reviewDecision, 'REVIEW_REQUIRED')
  assert.equal(pr.mergeable, 'CONFLICTING')
  assert.equal(pr.isDraft, true)
  assert.equal(pr.isMine, true)
  assert.deepEqual(pr.requiredChecks, { total: 0, failing: [], known: false }) // filled in later by fetchGithub
  // The fixture predates PR_FIELDS carrying mergeStateStatus, so it is absent from the
  // raw JSON — confirms the documented default rather than an undefined passthrough.
  assert.equal(pr.mergeStateStatus, null)
})

test('normalizePr carries mergeStateStatus onto the normalized PR when GitHub provides it', () => {
  const raw = fx('gh-prs-PerformYard_PerformYard.json').find((p) => p.number === 7110)
  const pr = normalizePr({ ...raw, mergeStateStatus: 'BEHIND' }, 'PerformYard/PerformYard', { mine: true, myLogin: 'cweiner-PY' })
  assert.equal(pr.mergeStateStatus, 'BEHIND')
})

test('hasReviewComments is true only for human teammate feedback', () => {
  const fx7230 = fx('gh-prs-PerformYard_PerformYard.json').find((p) => p.number === 7230)
  const fx7110 = fx('gh-prs-PerformYard_PerformYard.json').find((p) => p.number === 7110)
  const ME = 'cweiner-PY'
  // #7230 carries real COMMENTED reviews from teammate jleo-py (MEMBER)
  assert.equal(normalizePr(fx7230, 'r', { mine: true, myLogin: ME }).hasReviewComments, true)
  // #7110 has no reviews at all (only bot issue-comments, which are not reviews)
  assert.equal(normalizePr(fx7110, 'r', { mine: true, myLogin: ME }).hasReviewComments, false)
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
const isCompare = (args) => args.includes('graphql')

test('fetchGithub calls gh per repo and attaches required checks', async () => {
  const calls = []
  const run = async (cmd, args) => {
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    calls.push([cmd, ...args].join(' '))
    if (args.includes('checks')) {
      const n = args[2]   // ['pr', 'checks', '<number>', ...]
      return { code: 0, stdout: JSON.stringify(fx(`gh-checks-required-${n}.json`)), stderr: '' }
    }
    const repo = args[args.indexOf('--repo') + 1]
    const isReview = args.some((a) => String(a).includes('review-requested'))
    if (isReview) return { code: 0, stdout: '[]', stderr: '' }
    const file = 'gh-prs-' + repo.replace('/', '_') + '.json'
    return { code: 0, stdout: JSON.stringify(fx(file)), stderr: '' }
  }
  const config = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/PerformYard': {}, 'PerformYard/Logan': {} } }
  const { prs, errors } = await fetchGithub(config, { run })

  assert.deepEqual(errors, [])
  assert.equal(prs.length, 4)
  const p7230 = prs.find((p) => p.number === 7230)
  assert.deepEqual(p7230.requiredChecks.failing, ['QA Code Review'])
  const p704 = prs.find((p) => p.number === 704)
  assert.deepEqual(p704.requiredChecks, { total: 0, failing: [], pending: [], known: true })
  assert.ok(calls.some((c) => c.includes('--author @me')))
  assert.ok(calls.some((c) => c.includes('review-requested:@me')))
})

test('gh reporting NO required checks is a known zero, not a failure', async () => {
  // Real gh 2.86.0 behaviour for PerformYard/Logan #704: exit 1, empty stdout, and
  // "no required checks reported on the '<branch>' branch" on stderr. Treating that as
  // a collection failure would make every Logan PR permanently unmergeable.
  const run = async (cmd, args) => {
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    if (args.includes('checks')) {
      return {
        code: 1,
        stdout: '',
        stderr: "no required checks reported on the 'feat/salesforce-implementation-date-source-of-truth' branch",
      }
    }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    const repo = args[args.indexOf('--repo') + 1]
    return { code: 0, stdout: JSON.stringify(fx('gh-prs-' + repo.replace('/', '_') + '.json')), stderr: '' }
  }
  const config = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/Logan': {} } }
  const { prs, errors } = await fetchGithub(config, { run })
  assert.deepEqual(prs[0].requiredChecks, { total: 0, failing: [], pending: [], known: true })
  assert.deepEqual(errors, [], 'a determined zero is not an error')
})

test('a determined zero is still MERGEABLE once approved', async () => {
  // The whole point: Logan PRs must remain mergeable from the dashboard.
  const gate = mergeGateFor({
    reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false,
    requiredChecks: { total: 0, failing: [], known: true },
  })
  assert.equal(gate.allowed, true, gate.blockers.join('; '))
})

test('a genuine gh-checks failure is RECORDED and leaves the gate unknown', async () => {
  // The dangerous case: gh itself fails (expired auth, offline, gh missing). Empty
  // stdout must NOT be read as "no required checks are failing".
  const run = async (cmd, args) => {
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    if (args.includes('checks')) return { code: 1, stdout: '', stderr: 'gh: could not authenticate' }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    const repo = args[args.indexOf('--repo') + 1]
    return { code: 0, stdout: JSON.stringify(fx('gh-prs-' + repo.replace('/', '_') + '.json')), stderr: '' }
  }
  const config = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/Logan': {} } }
  const { prs, errors } = await fetchGithub(config, { run })
  assert.equal(prs.length, 1)
  assert.equal(prs[0].requiredChecks.known, false, 'gate must remain unknown')
  assert.ok(!/no required checks/i.test(errors[0]), 'must not be confused with a determined zero')
  assert.equal(errors.length, 1, 'the failure must be surfaced, not swallowed')
  assert.match(errors[0], /could not fetch required checks/)
  assert.match(errors[0], /could not authenticate/)
})

test('a checks call that exits non-zero BUT returns valid json is still parsed', async () => {
  // The exit-code trap: gh exits 1 precisely because a check is failing. That data
  // is the most important data we collect, so it must not be discarded.
  const run = async (cmd, args) => {
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    if (args.includes('checks')) {
      return { code: 1, stdout: JSON.stringify(fx('gh-checks-required-7230.json')), stderr: '' }
    }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    const repo = args[args.indexOf('--repo') + 1]
    return { code: 0, stdout: JSON.stringify(fx('gh-prs-' + repo.replace('/', '_') + '.json')), stderr: '' }
  }
  const config = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/Logan': {} } }
  const { prs, errors } = await fetchGithub(config, { run })
  assert.equal(prs[0].requiredChecks.known, true)
  assert.deepEqual(prs[0].requiredChecks.failing, ['QA Code Review'])
  assert.deepEqual(errors, [])
})

test('a failing gh call for one repo is reported but does not lose the other repo', async () => {
  const run = async (cmd, args) => {
    if (isCompare(args)) return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    if (args.includes('PerformYard/Logan')) return { code: 1, stdout: '', stderr: 'boom' }
    if (args.includes('checks')) return { code: 0, stdout: '[]', stderr: '' }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    return { code: 0, stdout: JSON.stringify(fx('gh-prs-PerformYard_PerformYard.json')), stderr: '' }
  }
  const config = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/PerformYard': {}, 'PerformYard/Logan': {} } }
  const { prs, errors } = await fetchGithub(config, { run })
  assert.equal(prs.length, 3)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /Logan/)
})


// --- base comparison: how far behind its base each of the user's own PRs is ---------
// The signal mergeStateStatus cannot provide. See BASE_COMPARE_QUERY in collect/github.js.

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

test('normalizePr carries baseRefName and starts the comparison unknown', () => {
  const raw = fx('gh-prs-PerformYard_PerformYard.json').find((p) => p.number === 7230)
  const pr = normalizePr(raw, 'PerformYard/PerformYard', { mine: true, myLogin: 'cweiner-PY' })
  assert.equal(pr.baseRefName, 'master')
  assert.equal(pr.baseCompare.known, false, 'must not claim knowledge before the call is made')
  assert.equal(pr.baseCompare.behind, null)
})

test('fetchGithub compares OWN PRs only, and passes the real base and head refs', async () => {
  const graphqlCalls = []
  const run = async (cmd, args) => {
    if (isCompare(args)) {
      graphqlCalls.push(args.join(' '))
      return { code: 0, stdout: compareFx('gh-compare-7230.json'), stderr: '' }
    }
    if (args.includes('checks')) return { code: 0, stdout: '[]', stderr: '' }
    const repo = args[args.indexOf('--repo') + 1]
    if (args.some((a) => String(a).includes('review-requested'))) {
      // A colleague's PR: it has no update-branch button, so it must not be compared.
      return { code: 0, stdout: JSON.stringify([{
        number: 999, title: 'theirs', headRefName: 'their-branch', baseRefName: 'master',
        url: 'u', reviews: [],
      }]), stderr: '' }
    }
    return { code: 0, stdout: JSON.stringify(fx('gh-prs-' + repo.replace('/', '_') + '.json')), stderr: '' }
  }
  const config = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/Logan': {} } }
  const { prs, errors } = await fetchGithub(config, { run })

  const mine = prs.find((p) => p.number === 704)
  const theirs = prs.find((p) => p.number === 999)
  assert.deepEqual(errors, [])
  assert.equal(mine.baseCompare.behind, 24)
  assert.equal(theirs.baseCompare.known, false, "a colleague's PR is never compared")
  assert.equal(graphqlCalls.length, 1, 'exactly one comparison, for the one own PR')
  assert.match(graphqlCalls[0], /base=master/)
  assert.match(graphqlCalls[0], /head=feat\/salesforce-implementation-date-source-of-truth/)
  assert.match(graphqlCalls[0], /owner=PerformYard/)
  assert.match(graphqlCalls[0], /name=Logan/)
  assert.ok(!graphqlCalls[0].includes('their-branch'))
})

test('fetchGithub uses raw string fields, so a branch named like a literal survives', async () => {
  // gh's typed -F coerces values that look like numbers, booleans or null. A branch
  // legitimately named "null" must reach GraphQL as the string "null".
  let seen = null
  const run = async (cmd, args) => {
    if (isCompare(args)) { seen = args; return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' } }
    if (args.includes('checks')) return { code: 0, stdout: '[]', stderr: '' }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    return { code: 0, stdout: JSON.stringify([{
      number: 1, title: 't', headRefName: 'null', baseRefName: 'master', url: 'u', reviews: [],
    }]), stderr: '' }
  }
  await fetchGithub({ githubLogin: 'me', repos: { 'O/R': {} } }, { run })
  assert.ok(seen, 'the comparison must have been attempted')
  assert.ok(!seen.includes('-F'), 'must never use gh\'s typed field flag')
  assert.ok(seen.includes('head=null'), 'the branch name must pass through verbatim')
})

test('a failed comparison is RECORDED and leaves the PR unknown, not up to date', async () => {
  // The dangerous direction: the call fails and behind silently reads as 0. Mirrors the
  // required-checks contract exactly — known stays false and the failure is surfaced.
  const run = async (cmd, args) => {
    if (isCompare(args)) {
      return { code: 1, stdout: compareFx('gh-compare-notfound.json'),
               stderr: "Could not resolve head ref 'no-such-branch-xyz'." }
    }
    if (args.includes('checks')) return { code: 0, stdout: '[]', stderr: '' }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    const repo = args[args.indexOf('--repo') + 1]
    return { code: 0, stdout: JSON.stringify(fx('gh-prs-' + repo.replace('/', '_') + '.json')), stderr: '' }
  }
  const config = { githubLogin: 'cweiner-PY', repos: { 'PerformYard/Logan': {} } }
  const { prs, errors } = await fetchGithub(config, { run })

  assert.equal(prs.length, 1, 'the PR itself must survive a failed comparison')
  assert.equal(prs[0].baseCompare.known, false)
  assert.equal(prs[0].baseCompare.behind, null)
  assert.equal(errors.length, 1, 'the failure must be surfaced, not swallowed')
  assert.match(errors[0], /could not compare/)
  assert.match(errors[0], /Could not resolve head ref/)
})

test('a comparison that exits non-zero BUT returns a usable answer is still used', async () => {
  // GraphQL can answer with data AND a non-zero gh exit. Discarding a good number
  // because of the exit code is the same trap the required-checks read already avoids.
  const run = async (cmd, args) => {
    if (isCompare(args)) return { code: 1, stdout: compareFx('gh-compare-7230.json'), stderr: 'some warning' }
    if (args.includes('checks')) return { code: 0, stdout: '[]', stderr: '' }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    const repo = args[args.indexOf('--repo') + 1]
    return { code: 0, stdout: JSON.stringify(fx('gh-prs-' + repo.replace('/', '_') + '.json')), stderr: '' }
  }
  const { prs, errors } = await fetchGithub(
    { githubLogin: 'cweiner-PY', repos: { 'PerformYard/Logan': {} } }, { run })
  assert.equal(prs[0].baseCompare.behind, 24)
  assert.deepEqual(errors, [])
})

test('a PR missing its base ref name is reported, never silently compared', async () => {
  let attempted = 0
  const run = async (cmd, args) => {
    if (isCompare(args)) { attempted++; return { code: 0, stdout: compareFx('gh-compare-704.json'), stderr: '' } }
    if (args.includes('checks')) return { code: 0, stdout: '[]', stderr: '' }
    if (args.some((a) => String(a).includes('review-requested'))) return { code: 0, stdout: '[]', stderr: '' }
    return { code: 0, stdout: JSON.stringify([{
      number: 5, title: 't', headRefName: 'x', url: 'u', reviews: [],   // no baseRefName
    }]), stderr: '' }
  }
  const { prs, errors } = await fetchGithub({ githubLogin: 'me', repos: { 'O/R': {} } }, { run })
  assert.equal(attempted, 0, 'must not guess a base branch')
  assert.equal(prs[0].baseCompare.known, false)
  assert.match(errors[0], /missing ref names/)
})
