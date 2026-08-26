// routes.js
import { openItem } from './actions/open.js'
import { updateBranch } from './actions/update-branch.js'
import { mergePr } from './actions/merge.js'

// Branches whose ticket is finished or reassigned — a slot holding one is fair game.
function staleBranchesOf(board) {
  const set = new Set()
  for (const i of board.items ?? []) {
    if (i.slot?.branch && (i.signals?.stale || i.signals?.foreign)) set.add(i.slot.branch)
  }
  return set
}

export function registerRoutes(routes, { getBoard, config, deps = {} }) {
  const find = async (id) => {
    const board = await getBoard()
    // `JSON.parse('null')` yields null, so callers may hand us a non-object body.
    const item = (board.items ?? []).find((i) => i.id === id)
    return { board, item }
  }

  const launch = (skillRequired) => async (body, ctx) => {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object body.' }
    const { item, board } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }
    if (skillRequired && !body.skill) return { ok: false, message: 'A skill name is required.' }
    // Validate whenever a skill is SUPPLIED, not only when it is required. /api/open does
    // not require one, but if a caller passes one it is submitted to Claude just the same,
    // so the applicability check must apply to both routes or the sibling route is a bypass.
    if (body.skill && !item.skills.includes(body.skill)) {
      return { ok: false, message: `${body.skill} does not apply to ${item.id}.` }
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

    const result = await openItem({
      item, slots: board.slots ?? [], plans, skill: body.skill ?? null,
      config, chosenSlotDir: body.slotDir ?? null, staleBranches: staleBranchesOf(board),
    }, deps)
    if (result.ok) ctx.invalidate()
    return result
  }

  routes.set('POST /api/open', launch(false))
  routes.set('POST /api/run', launch(true))

  routes.set('POST /api/update-branch', async (body, ctx) => {
    if (!body || typeof body !== 'object') return { ok: false, message: 'Expected a JSON object body.' }
    const { item, board } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }
    const result = await updateBranch({
      item,
      slots: board.slots ?? [],
      chosenSlotDir: body.slotDir ?? null,
      // Keep the merge base identical to the one slots.js measured "N behind" with.
      defaultBranch: config.repos[item.repo]?.defaultBranch ?? 'master',
    }, deps)
    if (result.ok) ctx.invalidate()
    return result
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
