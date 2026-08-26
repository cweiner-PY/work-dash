// collect/github.js
import { run as defaultRun } from '../util/run.js'

const PR_FIELDS = 'number,title,headRefName,reviewDecision,mergeable,isDraft,statusCheckRollup,updatedAt,url,reviews'

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

export function parseRequiredChecks(arr) {
  const list = arr ?? []
  return { total: list.length, failing: list.filter((c) => c.state !== 'SUCCESS').map((c) => c.name) }
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
    requiredChecks: { total: 0, failing: [] }, // filled by fetchGithub
    hasReviewComments: hasHumanReviewFeedback(raw.reviews, myLogin),
    isMine: mine,
    url: raw.url ?? null,
    updatedAt: raw.updatedAt ?? null,
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
    // gh exits non-zero when any check is failing, so parse stdout regardless.
    if (r.stdout.trim()) {
      try { pr.requiredChecks = parseRequiredChecks(JSON.parse(r.stdout)) }
      catch { errors.push(`could not parse required checks for ${pr.repo}#${pr.number}`) }
    }
  }))

  return { prs, errors }
}
