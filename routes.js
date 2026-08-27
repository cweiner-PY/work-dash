// routes.js
import { openItem } from './actions/open.js'
import { resolveBranch, myPrOfBranch } from './actions/slot.js'
import { updateBranch } from './actions/update-branch.js'
import { mergePr } from './actions/merge.js'
import { openEditor } from './actions/editor.js'
import { pickReviewPr, reviewTarget } from './actions/review.js'

// Branches whose ticket is finished or reassigned — a slot holding one is fair game.
function staleBranchesOf(board) {
  const set = new Set()
  for (const i of board.items ?? []) {
    if (!(i.signals?.stale || i.signals?.foreign)) continue
    // Every branch of the item, not the one the scalar `item.slot` happened to name: a
    // finished ticket's SECOND checkout is just as fair game as its first, and leaving it out
    // meant the slot picker called it "busy" forever.
    for (const b of i.branches ?? []) if (b.slot?.branch) set.add(b.slot.branch)
  }
  return set
}

// A launch happens asynchronously in a Terminal window the server never waits on, so the
// cached board cannot observe the new checkout for seconds — no re-poll can fix that.
// Without a claim, two concurrent /api/open calls against the same cached board resolve
// deterministically to the SAME slot (rank() prefers master/main every time, not
// occasionally), and two Claude sessions then fight over one git checkout.
const CLAIM_MS = 90_000

// Exported and pure (aside from the pruning mutation) so it is directly testable without
// a real clock or an HTTP round-trip: pass a Map and an optional `now`.
export function liveClaimedDirs(claims, now = Date.now()) {
  const live = new Set()
  for (const [dir, expiry] of claims) {
    if (expiry > now) live.add(dir)
    else claims.delete(dir) // pruned lazily on read, not on a timer
  }
  return live
}

export function registerRoutes(routes, { getBoard, config, deps = {} }) {
  // Scoped to this registerRoutes call (one per running server), not module-level — so
  // repeated test registrations never leak claims into each other.
  const claims = new Map()

  const find = async (id) => {
    const board = await getBoard()
    // `JSON.parse('null')` yields null, so callers may hand us a non-object body.
    const item = (board.items ?? []).find((i) => i.id === id)
    return { board, item }
  }

  // WHICH BRANCH of the item this request is for. A ticket can carry several — that is how a
  // big feature gets split into separately reviewable pieces — so there is no longer any such
  // thing as "the item's branch". With one branch it is unambiguous; with more, and no name
  // supplied, this REFUSES and hands back the choices rather than picking one.
  //
  // Refusing matters: picking is what made `update branch` read its label off one branch's
  // behind-count and then run against a different branch's PR. The UI renders a button per
  // branch so it never has to see this, but the UI is a convenience and this is the authority.
  //
  // It is also the allowlist for `body.branch`: only a name the board already has for THIS
  // item resolves, so a raw API call cannot hand an arbitrary string to git.
  const pickBranch = (item, body) => {
    const named = typeof body.branch === 'string' ? body.branch : null
    const r = resolveBranch(item, named)
    if (r.error) return { error: { ok: false, message: r.error } }
    if (r.needsBranch) {
      return { error: { ok: false, message: r.message, branches: r.branches, needsBranch: true } }
    }
    return { branch: r.branch }
  }

  const launch = (skillRequired) => async (body, ctx) => {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object body.' }
    const { item, board } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }
    if (skillRequired && !body.skill) return { ok: false, message: 'A skill name is required.' }
    const picked = pickBranch(item, body)
    if (picked.error) return picked.error
    const branch = picked.branch
    // Validate whenever a skill is SUPPLIED, not only when it is required. /api/open does
    // not require one, but if a caller passes one it is submitted to Claude just the same,
    // so the applicability check must apply to both routes or the sibling route is a bypass.
    //
    // Against THIS branch's skills, not a union over the item's. A rule like `slot.dirty` can
    // be true of one branch and false of another, and a union would let a skill valid for one
    // be launched against the other.
    if (body.skill && !(branch.skills ?? []).includes(body.skill)) {
      return { ok: false, message: `${body.skill} does not apply to ${item.id}${branch.name ? ` on ${branch.name}` : ''}.` }
    }
    // A repo hint is only meaningful for a branchless, repo-less item — the user telling
    // the picker which repo to draw a working directory from. Validate it against
    // configured repos so a raw API call cannot point slot resolution at an arbitrary
    // string; do not pass it through unvalidated.
    if (body.repo != null && !Object.prototype.hasOwnProperty.call(config.repos, body.repo)) {
      return { ok: false, message: `Unknown repo: ${body.repo}` }
    }
    // Only accept plan paths the server already knows belong to this item. `plans` becomes
    // --add-dir arguments granting Claude filesystem access, so an unvalidated list would let
    // a caller point it anywhere (/etc, ~/.ssh). slotDir is validated the same way; plans
    // must be too.
    const allowed = new Map((item.plans ?? []).map((p) => [p.dir, new Set(p.files ?? [])]))
    const plans = (body.plans ?? []).filter((p) => allowed.get(p?.dir)?.has(p?.file))
    const rejected = (body.plans ?? []).length - plans.length
    if (rejected > 0) {
      return { ok: false, message: `${rejected} plan path(s) do not belong to ${item.id}.` }
    }

    // The "resolve conflicts" action. A boolean from the client, never a ref name: the
    // base branch is derived here from the item's own PR, so a raw API call cannot make
    // the launcher merge an arbitrary ref into a checkout. Strict === true for the same
    // reason /api/merge requires it of `confirmed` — Boolean("false") is true.
    const mergeBase = body.resolveConflicts === true
      ? (myPrOfBranch(branch)?.baseRefName ?? config.repos[item.repo]?.defaultBranch ?? 'master')
      : null

    const result = await openItem({
      item, branch, slots: board.slots ?? [], plans, skill: body.skill ?? null,
      config, chosenSlotDir: body.slotDir ?? null, staleBranches: staleBranchesOf(board),
      claimedDirs: liveClaimedDirs(claims), repo: body.repo ?? null, mergeBase,
    }, deps)
    if (result.ok) {
      ctx.invalidate()
      if (result.slot) claims.set(result.slot, Date.now() + CLAIM_MS)
    }
    return result
  }

  routes.set('POST /api/open', launch(false))
  routes.set('POST /api/run', launch(true))

  routes.set('POST /api/update-branch', async (body, ctx) => {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object body.' }
    const { item, board } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }
    const picked = pickBranch(item, body)
    if (picked.error) return picked.error
    const result = await updateBranch({
      item,
      branch: picked.branch,
      slots: board.slots ?? [],
      chosenSlotDir: body.slotDir ?? null,
      // Keep the merge base identical to the one slots.js measured "N behind" with.
      defaultBranch: config.repos[item.repo]?.defaultBranch ?? 'master',
    }, deps)
    if (result.ok) ctx.invalidate()
    return result
  })

  // Reviews a colleague's PR: their branch, checked out detached in a slot, with a reviewer's
  // system prompt and the configured review skill.
  //
  // No skill-applicability gate, and that is safe for a specific reason: the skill name comes
  // from config.reviewSkill, never from the request. /api/run needs that gate precisely
  // because its skill IS client-supplied.
  routes.set('POST /api/review', async (body, ctx) => {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object body.' }
    const { item, board } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }

    const picked = pickReviewPr(item, typeof body.prNumber === 'number' ? body.prNumber : null)
    if (picked.error) return { ok: false, message: picked.error }
    const target = reviewTarget(picked.pr)
    if (target.error) return { ok: false, message: target.error }
    // No ambiguity to resolve here: the PR under review names its own branch, so that is the
    // branch entry this launch is for. Nothing is inferred and body.branch is not consulted.
    const onBranch = resolveBranch(item, picked.pr.headRefName)
    if (onBranch.error) return { ok: false, message: onBranch.error }

    // Same allowlist as /api/open: plans become --add-dir arguments, so an unvalidated list
    // would hand Claude filesystem access anywhere.
    const allowed = new Map((item.plans ?? []).map((p) => [p.dir, new Set(p.files ?? [])]))
    const plans = (body.plans ?? []).filter((p) => allowed.get(p?.dir)?.has(p?.file))

    const result = await openItem({
      item, branch: onBranch.branch, slots: board.slots ?? [], plans, skill: config.reviewSkill ?? null,
      config, chosenSlotDir: body.slotDir ?? null, staleBranches: staleBranchesOf(board),
      claimedDirs: liveClaimedDirs(claims), review: target.review,
    }, deps)
    if (result.ok) {
      ctx.invalidate()
      if (result.slot) claims.set(result.slot, Date.now() + CLAIM_MS)
    }
    return result
  })

  // Opens an existing checkout in the configured editor. No ctx.invalidate(): opening a
  // folder changes nothing the board reports, so re-collecting would be pure cost. No slot
  // claim either — an editor window is not a Claude session competing for the checkout.
  routes.set('POST /api/open-editor', async (body) => {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object body.' }
    const { item, board } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }
    const picked = pickBranch(item, body)
    if (picked.error) return picked.error
    return openEditor({
      item, branch: picked.branch, slots: board.slots ?? [],
      chosenSlotDir: body.slotDir ?? null, editor: config.editor,
    }, deps)
  })

  routes.set('POST /api/merge', async (body, ctx) => {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object body.' }
    const { item } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }
    // Pass the value through UNCOERCED. Boolean("false") is true, so coercing here would
    // reintroduce exactly the bypass the strict check in mergePr exists to close.
    const result = await mergePr(
      { item, prNumber: body.prNumber, confirmed: body.confirmed === true }, deps)
    if (result.ok) ctx.invalidate()
    return result
  })

  routes.set('GET /api/slots', async () => {
    const board = await getBoard()
    return { ok: true, slots: board.slots ?? [] }
  })
}
