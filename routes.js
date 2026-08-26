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
    const item = (board.items ?? []).find((i) => i.id === id)
    return { board, item }
  }

  const launch = (skillRequired) => async (body, ctx) => {
    const { item, board } = await find(body.id)
    if (!item) return { ok: false, message: `Unknown item: ${body.id}` }
    if (skillRequired && !body.skill) return { ok: false, message: 'A skill name is required.' }
    if (skillRequired && !item.skills.includes(body.skill)) {
      return { ok: false, message: `${body.skill} does not apply to ${item.id}.` }
    }
    const result = await openItem({
      item, slots: board.slots ?? [], plans: body.plans ?? [], skill: body.skill ?? null,
      config, chosenSlotDir: body.slotDir ?? null, staleBranches: staleBranchesOf(board),
    }, deps)
    if (result.ok) ctx.invalidate()
    return result
  }

  routes.set('POST /api/open', launch(false))
  routes.set('POST /api/run', launch(true))

  routes.set('POST /api/update-branch', async (body, ctx) => {
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
