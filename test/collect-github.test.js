// test/collect-github.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { summarizeChecks, parseRequiredChecks, normalizePr, fetchGithub, hasHumanReviewFeedback } from '../collect/github.js'

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
  assert.deepEqual(r, { total: 0, failing: [] })
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
  assert.deepEqual(pr.requiredChecks, { total: 0, failing: [] }) // filled in later by fetchGithub
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

test('fetchGithub calls gh per repo and attaches required checks', async () => {
  const calls = []
  const run = async (cmd, args) => {
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
  assert.deepEqual(p704.requiredChecks, { total: 0, failing: [] })
  assert.ok(calls.some((c) => c.includes('--author @me')))
  assert.ok(calls.some((c) => c.includes('review-requested:@me')))
})

test('a failing gh call for one repo is reported but does not lose the other repo', async () => {
  const run = async (cmd, args) => {
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
