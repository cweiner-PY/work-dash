// collect/github.js
import { run as defaultRun } from '../util/run.js'

// ONE query for every PR in every configured repo, replacing four sequential
// `gh pr list` invocations — measured at 5.2s of this collector's 7.1s, because gh spawns
// a process and makes its own request per call. The consolidated call measures 1.4s.
//
// Required checks deliberately do NOT move here. GraphQL's branchProtectionRules does not
// cover repository RULESETS, so a repo using those would report an empty required list —
// and an empty-but-known list is exactly what mergeGateFor treats as passing. Trading a
// silently permissive merge gate for 1.4s is not a trade worth making, so `gh pr checks
// --required` stays.
const PR_QUERY = `query($mine:String!,$review:String!,$first:Int!){
  mine: search(query:$mine, type:ISSUE, first:$first){ nodes{ ...pr } }
  reviewRequested: search(query:$review, type:ISSUE, first:$first){ nodes{ ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft mergeable reviewDecision mergeStateStatus updatedAt
  headRefName headRefOid baseRefName
  repository { nameWithOwner }
  author { login }
  reviews(last:50){ nodes{ state submittedAt author{ login } authorAssociation } }
  commits(last:1){ nodes{ commit{ committedDate } } }
  reviewThreads(first:100){ nodes{ isResolved comments(last:1){ nodes{ author{ login } } } } }
}`

// Search caps out well below this in practice; the warning below fires if it ever doesn't.
const SEARCH_LIMIT = 50

// gh signals "this repo configures no required checks" via a non-zero exit and this
// message on stderr, NOT via an empty JSON array on stdout.
const NO_REQUIRED_CHECKS = /no required checks/i

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

// The newest changes-requested review's timestamp, or null. Pure and exported because it
// is half of the changesAddressed decision in lanes.js, and the half most likely to be
// wrong — reviews arrive in no guaranteed order, so this takes the MAX rather than the last.
export function latestChangesRequestedAt(reviews) {
  const times = (reviews ?? [])
    .filter((r) => r.state === 'CHANGES_REQUESTED' && r.submittedAt)
    .map((r) => Date.parse(r.submittedAt))
    .filter(Number.isFinite)
  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

// Review threads that are actually waiting on YOU: unresolved, and whose last comment is
// not yours — once you have replied, the ball is back with the reviewer even though the
// thread stays open. Verified against the live #7230, which has 6 unresolved threads whose
// last comment is mine on every one: a naive count would have demanded attention for six
// things already answered.
//
// Approved PRs count zero regardless. Reviewers here rarely click resolve, so an approval
// supersedes whatever threads are still technically open — and nothing about an approved PR
// is waiting on a comment.
//
// `first: 100` caps it. A PR with more open threads than that has bigger problems than an
// undercount, and undercounting is the quiet direction rather than the alarming one.
export function countOpenThreads(node, myLogin) {
  if (node?.reviewDecision === 'APPROVED') return 0
  return (node?.reviewThreads?.nodes ?? []).filter((t) => {
    if (t?.isResolved) return false
    const last = t?.comments?.nodes?.[0]?.author?.login ?? null
    // An unattributable last comment counts as theirs: better to surface a thread that
    // needed no attention than to hide one that did.
    return last !== myLogin
  }).length
}

export function normalizePr(node, { mine, myLogin }) {
  const reviews = node.reviews?.nodes ?? []
  return {
    repo: node.repository?.nameWithOwner ?? null,
    number: node.number,
    title: node.title,
    headRefName: node.headRefName,
    // Lets a DETACHED local checkout be identified as holding this PR — see join.js.
    headSha: node.headRefOid ?? null,
    baseRefName: node.baseRefName ?? null,
    reviewDecision: node.reviewDecision ?? null,
    mergeable: node.mergeable ?? null,
    isDraft: Boolean(node.isDraft),
    author: node.author?.login ?? null,
    // Starts UNKNOWN, not "zero required checks". fetchGithub replaces this with a
    // known:true result on a successful read; if the read fails it stays unknown and
    // the merge gate refuses rather than mistaking silence for a clean bill of health.
    requiredChecks: { total: 0, failing: [], known: false },
    hasReviewComments: hasHumanReviewFeedback(reviews, myLogin),
    isMine: mine,
    url: node.url ?? null,
    updatedAt: node.updatedAt ?? null,
    // The two halves of changesAddressed (lanes.js). Both come free with the PR query, so
    // "have I already pushed fixes for this review?" costs no extra request.
    lastCommitAt: node.commits?.nodes?.[0]?.commit?.committedDate ?? null,
    changesRequestedAt: latestChangesRequestedAt(reviews),
    // Own PRs only. On a colleague's PR, "threads whose last comment isn't mine" counts
    // their internal discussion, which says nothing about what the user should do.
    openThreads: mine ? countOpenThreads(node, myLogin) : 0,
    // Kept for the conflict case only (DIRTY), which GitHub cannot resolve server-side.
    // It is NOT the source of truth for "behind" — see BASE_COMPARE_QUERY above.
    mergeStateStatus: node.mergeStateStatus ?? null,
    // Starts unknown for the same reason requiredChecks does. fetchGithub fills this in
    // for the user's own PRs, which are the only ones update-branch can act on.
    baseCompare: { ...COMPARE_UNKNOWN },
  }
}

// The search qualifiers for one query covering every configured repo. Exported so a test
// can assert the repo scoping, which is the part that silently returns the wrong PRs if
// it is built wrong — an unscoped search would pull in PRs from every repo on GitHub.
export function searchQueries(config) {
  const scope = Object.keys(config.repos).map((r) => `repo:${r}`).join(' ')
  return {
    mine: `is:pr is:open author:@me ${scope}`,
    review: `is:pr is:open review-requested:@me ${scope}`,
  }
}

// Pure: pull the PR nodes out of a GraphQL response. GraphQL can answer with data AND an
// errors array, so partial data is used rather than discarded — the same rule the required
// checks and the base comparison already follow.
export function parsePrSearch(stdout) {
  let data
  try { data = JSON.parse(stdout) } catch { return { mine: null, review: null } }
  const nodes = (key) => {
    const n = data?.data?.[key]?.nodes
    // A node without a number is a non-PullRequest search hit; the fragment cannot match it.
    return Array.isArray(n) ? n.filter((x) => x && typeof x.number === 'number') : null
  }
  return { mine: nodes('mine'), review: nodes('reviewRequested') }
}

export async function fetchGithub(config, { run = defaultRun } = {}) {
  const prs = []
  const errors = []
  const myLogin = config.githubLogin

  const { mine, review } = searchQueries(config)
  const r = await run('gh', ['api', 'graphql',
    '-f', `query=${PR_QUERY}`, '-f', `mine=${mine}`, '-f', `review=${review}`,
    '-F', `first=${SEARCH_LIMIT}`])
  const found = parsePrSearch(r.stdout)

  // One call now covers every repo, so a total failure loses all GitHub data where the old
  // per-repo loop could keep one repo's PRs. Partial data is therefore taken whenever
  // GraphQL returns any, and a null (not merely empty) result is what counts as failure.
  if (found.mine === null && found.review === null) {
    errors.push(`gh pr search failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  } else {
    for (const node of found.mine ?? []) prs.push(normalizePr(node, { mine: true, myLogin }))
    for (const node of found.review ?? []) prs.push(normalizePr(node, { mine: false, myLogin }))
    if (found.mine === null || found.review === null) {
      errors.push(`gh pr search returned only part of the result: ${r.stderr.trim() || `exit ${r.code}`}`)
    }
    // Same truncation discipline as the Jira collector: say so rather than silently
    // presenting a partial board as complete.
    for (const [name, list] of [['authored', found.mine], ['review-requested', found.review]]) {
      if (list?.length >= SEARCH_LIMIT) {
        errors.push(`${name} PR search hit the ${SEARCH_LIMIT}-result limit; some may be missing`)
      }
    }
  }

  // Required checks, one call per PR.
  // The two enrichment passes are independent of each other, so they run concurrently
  // rather than one after the other — they were costing ~1.4s and ~0.5s in series.
  const requiredChecksPass = () => Promise.all(prs.map(async (pr) => {
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
  const baseComparePass = () => Promise.all(prs.filter((pr) => pr.isMine).map(async (pr) => {
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

  await Promise.all([requiredChecksPass(), baseComparePass()])

  return { prs, errors }
}
