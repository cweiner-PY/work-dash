// collect/github.js
import { run as defaultRun } from '../util/run.js'

const PR_FIELDS = 'number,title,headRefName,baseRefName,reviewDecision,mergeable,isDraft,statusCheckRollup,updatedAt,url,reviews,mergeStateStatus'

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

// mergeStateStatus CANNOT answer "is this branch behind its base". Two reasons, both
// found the hard way against PerformYard/PerformYard#7230, which sat 24 commits behind
// master while the dashboard called it up to date:
//   1. BEHIND is only reported when branch protection requires branches be up to date
//      before merging. Without that setting a behind branch reports CLEAN.
//   2. BLOCKED and DIRTY OUTRANK BEHIND. Any PR with a failing required check reports
//      BLOCKED no matter how far behind it is — and every open PR in these repos is
//      BLOCKED or DIRTY, so the update-branch button was never once enabled.
// Ref.compare is the authoritative answer and, unlike the REST compare endpoint, returns
// only these three numbers instead of every file patch in the diff.
const BASE_COMPARE_QUERY = `query($owner:String!,$name:String!,$base:String!,$head:String!){
  repository(owner:$owner,name:$name){
    ref(qualifiedName:$base){ compare(headRef:$head){ aheadBy behindBy status } }
  }
}`

// Same shape and same fail-closed rule as requiredChecks: known:false means "we did not
// find out", never "zero". A caller must not read behind:null as behind:0.
const COMPARE_UNKNOWN = { behind: null, ahead: null, status: null, known: false }

// Pure, so the parse is testable without gh. GraphQL answers a failed comparison with
// compare:null PLUS an errors array and a non-zero gh exit — a deleted head ref, a base
// branch that does not exist, or a fork PR whose head lives in another repository. All of
// those land on known:false, which the UI renders as "behind state unknown" rather than
// as either "up to date" or "behind".
export function parseBaseCompare(stdout) {
  let data
  try { data = JSON.parse(stdout) } catch { return COMPARE_UNKNOWN }
  const c = data?.data?.repository?.ref?.compare
  if (!c || typeof c.behindBy !== 'number' || typeof c.aheadBy !== 'number') return COMPARE_UNKNOWN
  return { behind: c.behindBy, ahead: c.aheadBy, status: c.status ?? null, known: true }
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
    baseRefName: raw.baseRefName ?? null,
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
    // Kept for the conflict case only (DIRTY), which GitHub cannot resolve server-side.
    // It is NOT the source of truth for "behind" — see BASE_COMPARE_QUERY above.
    mergeStateStatus: raw.mergeStateStatus ?? null,
    // Starts unknown for the same reason requiredChecks does. fetchGithub fills this in
    // for the user's own PRs, which are the only ones update-branch can act on.
    baseCompare: { ...COMPARE_UNKNOWN },
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

  // How far behind its base each of the user's OWN PRs is — the signal update-branch
  // actually needs. Own PRs only: a colleague's review-requested PR has no update-branch
  // button (see myPrOf in lanes.js), so a call for it would be a wasted round trip.
  await Promise.all(prs.filter((pr) => pr.isMine).map(async (pr) => {
    const [owner, name] = pr.repo.split('/')
    if (!owner || !name || !pr.baseRefName || !pr.headRefName) {
      errors.push(`cannot compare ${pr.repo}#${pr.number} with its base: missing ref names`)
      return
    }
    // -f (raw string), never -F: gh's typed fields coerce values that look like numbers,
    // booleans or null, and would mangle a branch legitimately named "null" or "123".
    const r = await run('gh', ['api', 'graphql',
      '-f', `query=${BASE_COMPARE_QUERY}`,
      '-f', `owner=${owner}`, '-f', `name=${name}`,
      '-f', `base=${pr.baseRefName}`, '-f', `head=${pr.headRefName}`])
    // gh exits non-zero on a GraphQL error but still prints the body, and that body can
    // carry a usable answer — so parse stdout first and judge on what it contains,
    // exactly as the required-checks read above does.
    const parsed = parseBaseCompare(r.stdout)
    if (parsed.known) { pr.baseCompare = parsed; return }
    errors.push(
      `could not compare ${pr.repo}#${pr.number} (${pr.baseRefName}...${pr.headRefName}) : ` +
      `${r.stderr.trim() || `exit ${r.code}`}`
    )
  }))

  return { prs, errors }
}
