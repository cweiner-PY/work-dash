// test-support/branches.js — shared input-shaping for the unit tests. Not a test file.
//
// join.js pairs each PR with the checkout on the same branch to build `item.branches`, and
// every consumer now acts on ONE resolved branch of an item rather than on a scalar
// `item.slot` and `prs[0]`. The unit tests upstream of join deliberately describe their items
// in the terms they are ABOUT — a PR, a checkout — so the branches are derived here the same
// way join.js derives them. That keeps each test's intent legible while still exercising the
// real, branch-shaped code path.
import { orderBranches } from '../join.js'

export function branchesFrom({ prs = [], slot = null, repo = null, branches }) {
  if (branches) return branches
  const out = []
  const at = (name) => {
    let b = out.find((x) => x.name === name)
    if (!b) { b = { name, repo, pr: null, slot: null, detached: false }; out.push(b) }
    return b
  }
  for (const p of prs) at(p.headRefName ?? null).pr = p
  if (slot) at(slot.branch ?? null).slot = slot
  if (!out.length) out.push({ name: null, repo, pr: null, slot: null, detached: false })
  // The real comparator, not a copy: creation order is part of what these tests exercise.
  return orderBranches(out)
}

export const withBranches = (item) => ({ ...item, branches: branchesFrom(item) })

// The single branch an item unambiguously means. Throws rather than guessing when there is
// more than one: a test that wants a specific branch of a multi-branch item must name it, for
// the same reason resolveBranch refuses to pick one at runtime.
export function theBranch(item) {
  const bs = branchesFrom(item)
  if (bs.length !== 1) throw new Error(`${item.id ?? item.key} has ${bs.length} branches — name the one you mean`)
  return bs[0]
}
