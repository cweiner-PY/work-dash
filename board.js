// board.js
import { join as joinItems } from './join.js'
import { assignLanes } from './lanes.js'
import { extractKey } from './util/key.js'
import { fetchPrimary as jiraPrimary, fetchByKeys as jiraByKeys } from './collect/jira.js'
import { fetchGithub as ghFetch } from './collect/github.js'
import { collectSlots as slotsFetch } from './collect/slots.js'
import { collectPlans as plansFetch } from './collect/plans.js'

async function guarded(fn, fallback) {
  try {
    const value = await fn()
    return { value, ok: true, error: null }
  } catch (e) {
    return { value: fallback, ok: false, error: e.message }
  }
}

const source = (r, count, partial = []) => ({
  ok: r.ok,
  error: r.error ?? (partial.length ? partial.join('; ') : null),
  count,
})

export async function buildBoard(config, deps = {}) {
  const {
    now = () => new Date(),
    fetchPrimary = jiraPrimary,
    fetchByKeys = jiraByKeys,
    fetchGithub = ghFetch,
    collectSlots = slotsFetch,
    collectPlans = plansFetch,
  } = deps

  // Independent collectors run concurrently; each is individually guarded.
  const [jiraR, ghR, slotR, planR] = await Promise.all([
    guarded(() => fetchPrimary(config), []),
    guarded(() => fetchGithub(config), { prs: [], errors: [] }),
    guarded(() => collectSlots(config), { slots: [], errors: [] }),
    guarded(() => collectPlans(config), { plans: [], errors: [] }),
  ])

  const jira = jiraR.value
  const { prs, errors: ghErrors } = ghR.value
  const { slots, errors: slotErrors } = slotR.value
  const { plans, errors: planErrors } = planR.value

  // Enrichment: every key seen anywhere that the primary query did not return.
  const known = new Set(jira.map((i) => i.key))
  const discovered = new Set()
  for (const pr of prs) {
    const k = extractKey(pr.headRefName) ?? extractKey(pr.title)
    if (k && !known.has(k)) discovered.add(k)
  }
  for (const s of slots) {
    const k = extractKey(s.branch)
    if (k && !known.has(k)) discovered.add(k)
  }
  // Plan folders deliberately contribute NOTHING to enrichment. docs/ holds ~27
  // keyed folders of mostly finished historical work, and join() creates an item
  // for every enriched issue — so enriching from plans would flood the board
  // with long-done tickets. Plans attach to items that live work already put on
  // the board (join step 4); they never bring one into existence.

  const enrichR = jiraR.ok
    ? await guarded(() => fetchByKeys(config, [...discovered]), [])
    : { value: [], ok: false, error: jiraR.error }

  const items = assignLanes(
    joinItems({ jira, enrichment: enrichR.value, prs, slots, plans, config }),
    config
  )

  return {
    generatedAt: now().toISOString(),
    items,
    sources: {
      jira: source({ ok: jiraR.ok && enrichR.ok, error: jiraR.error ?? enrichR.error },
                   jira.length + enrichR.value.length),
      github: source(ghR, prs.length, ghErrors),
      slots: source(slotR, slots.length, slotErrors),
      plans: source(planR, plans.length, planErrors),
    },
  }
}
