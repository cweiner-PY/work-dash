// collect/github.js
import { run as defaultRun } from '../util/run.js'

const PR_FIELDS = 'number,title,headRefName,reviewDecision,mergeable,isDraft,statusCheckRollup,updatedAt,url,reviews,mergeStateStatus'

// gh signals "this repo configures no required checks" via a non-zero exit and this
// message on stderr, NOT via an empty JSON array on stdout.
const NO_REQUIRED_CHECKS = /no required checks/i

export function summarizeChecks(rollup) {
  const out = { pass: 0, fail: 0, pending: 0 }
  for (const c of rollup ?? []) {
    if (c.status && c.status !== 'COMPLETED') { out.pending++; continue }
    if (c.conclusion === 'SUCCESS') out.pass++
    else if (c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT') out.fail++
    // CANCELLED, SKIPPED, NEUTRAL count as neither.
  }
  return out
}

// PENDING/QUEUED mean the check is still running, not that it failed. Every PR spends
// a few minutes here after each push; counting that as "failing" would promote the
// item to needs-you and paint the card red for CI that hasn't had a chance to finish.
const PENDING_STATES = new Set(['PENDING', 'QUEUED'])

// `known: true` means we actually read the list. An empty list with known:true is a
// real "this repo requires nothing" (PerformYard/Logan is exactly that) and passes the
// gate. Absence of knowledge is NOT absence of failures — see mergeGateFor.
export function parseRequiredChecks(arr) {
  const list = arr ?? []
  return {
    total: list.length,
    failing: list.filter((c) => c.state !== 'SUCCESS' && !PENDING_STATES.has(c.state)).map((c) => c.name),
    pending: list.filter((c) => PENDING_STATES.has(c.state)).map((c) => c.name),
    known: true,
  }
}

// A PR has review comments worth acting on only when a HUMAN TEAMMATE left
// feedback. Bots (aws-amplify-us-east-1, cursor, codex connectors) comment
// constantly and would otherwise light up the resolve-code-review action on
// every PR; the user's own replies are not feedback for them to resolve either.
export function hasHumanReviewFeedback(reviews, myLogin) {
  const ASSOC = new Set(['MEMBER', 'OWNER', 'COLLABORATOR'])
  return (reviews ?? []).some((r) =>
    (r.state === 'COMMENTED' || r.state === 'CHANGES_REQUESTED') &&
    r.author?.login !== myLogin &&
    ASSOC.has(r.authorAssociation))
}

export function normalizePr(raw, repo, { mine, myLogin }) {
  return {
    repo,
    number: raw.number,
    title: raw.title,
    headRefName: raw.headRefName,
    reviewDecision: raw.reviewDecision ?? null,
    mergeable: raw.mergeable ?? null,
    isDraft: Boolean(raw.isDraft),
    checks: summarizeChecks(raw.statusCheckRollup),
    // Starts UNKNOWN, not "zero required checks". fetchGithub replaces this with a
    // known:true result on a successful read; if the read fails it stays unknown and
    // the merge gate refuses rather than mistaking silence for a clean bill of health.
    requiredChecks: { total: 0, failing: [], known: false },
    hasReviewComments: hasHumanReviewFeedback(raw.reviews, myLogin),
    isMine: mine,
    url: raw.url ?? null,
    updatedAt: raw.updatedAt ?? null,
    // GitHub's own comparison of this PR's branch against its base — the only correct
    // source for "is this behind", since collect/slots.js is deliberately read-only and
    // never fetches, so the local ahead/behind count can be days stale.
    mergeStateStatus: raw.mergeStateStatus ?? null,
  }
}

async function listPrs(repo, extraArgs, { run }) {
  const args = ['pr', 'list', '--repo', repo, '--state', 'open', '--json', PR_FIELDS, '--limit', '50', ...extraArgs]
  const r = await run('gh', args)
  if (r.code !== 0) throw new Error(`gh pr list failed for ${repo}: ${r.stderr.trim() || r.code}`)
  return JSON.parse(r.stdout || '[]')
}

export async function fetchGithub(config, { run = defaultRun } = {}) {
  const prs = []
  const errors = []

  for (const repo of Object.keys(config.repos)) {
    try {
      const mineRaw = await listPrs(repo, ['--author', '@me'], { run })
      const reviewRaw = await listPrs(repo, ['--search', 'review-requested:@me'], { run })
      const myLogin = config.githubLogin
      for (const raw of mineRaw) prs.push(normalizePr(raw, repo, { mine: true, myLogin }))
      for (const raw of reviewRaw) prs.push(normalizePr(raw, repo, { mine: false, myLogin }))
    } catch (e) {
      errors.push(e.message)
    }
  }

  // Required checks, one call per PR.
  await Promise.all(prs.map(async (pr) => {
    const r = await run('gh', ['pr', 'checks', String(pr.number), '--repo', pr.repo,
                               '--required', '--json', 'name,state,link'])
    // gh exits non-zero when any check is FAILING, so parse stdout regardless of code.
    if (r.stdout.trim()) {
      try { pr.requiredChecks = parseRequiredChecks(JSON.parse(r.stdout)) }
      catch { errors.push(`could not parse required checks for ${pr.repo}#${pr.number}`) }
    } else if (NO_REQUIRED_CHECKS.test(r.stderr)) {
      // `gh pr checks --required` EXITS 1 WITH EMPTY STDOUT when a repo has no required
      // checks configured, reporting it on stderr as
      //   "no required checks reported on the '<branch>' branch"
      // That is a successful determination of zero, not a collection failure —
      // PerformYard/Logan is exactly this case. Verified against the live CLI:
      // gh 2.86.0 exits 1 here, while a repo WITH required checks exits 0.
      // If gh ever rewords this message the match fails and we fall through to the
      // branch below, which BLOCKS the merge gate with a reason. That is the safe
      // direction to break in.
      pr.requiredChecks = { total: 0, failing: [], pending: [], known: true }
    } else if (r.code !== 0) {
      // A genuine gh failure: expired auth, no network, gh missing, rate limited.
      // requiredChecks stays known:false, so the merge gate refuses this PR.
      errors.push(
        `could not fetch required checks for ${pr.repo}#${pr.number}: ` +
        `${r.stderr.trim() || `exit ${r.code}`}`
      )
    }
  }))

  return { prs, errors }
}
