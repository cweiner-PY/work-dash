// board.js
import { join as joinItems } from './join.js'
import { assignLanes, myPrOf } from './lanes.js'
import { extractKey } from './util/key.js'
import { fetchPrimary as jiraPrimary, fetchByKeys as jiraByKeys, fetchSubtasks as jiraSubtasks } from './collect/jira.js'
import { fetchGithub as ghFetch } from './collect/github.js'
import { collectSlots as slotsFetch } from './collect/slots.js'
import { collectPlans as plansFetch } from './collect/plans.js'
import { evalPredicate } from './util/predicate.js'

export function skillsForItem(item, config) {
  // The user's own PR, never a colleague's review request — a `pr`-gated skill (e.g.
  // /pr-description, /ticket-finisher) must not appear for a PR the user doesn't own.
  const pr = myPrOf(item)
  const ctx = {
    key: item.key,
    repo: item.repo,
    slot: item.slot,
    branch: item.slot?.branch ?? pr?.headRefName ?? null,
    plans: item.plans ?? [],
    jira: item.jira,
    pr: pr && {
      ...pr,
      changesRequested: pr.reviewDecision === 'CHANGES_REQUESTED',
      hasReviewComments: Boolean(pr.hasReviewComments),
    },
  }
  const out = []
  for (const rule of config.skills ?? []) {
    try {
      if (evalPredicate(rule.when, ctx)) out.push(rule.name)
    } catch (e) {
      console.warn(`skill rule "${rule.name}" is not a valid predicate (${rule.when}): ${e.message}`)
    }
  }
  return out
}

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
    fetchSubtasks = jiraSubtasks,
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

  // Subtasks: every item that has a Jira key — the primary query's keys plus every key
  // discovered above via a PR or slot branch — is checked for subtasks. Same credential
  // and endpoint as the rest of Jira, so a failure here is guarded the same way and
  // folded into the jira source's error rather than getting its own source.
  //
  // Orphan subtasks (the user's own, whose parent is not one of parentKeys) deliberately
  // contribute NOTHING to enrichment/discovery here — same reasoning as plan folders
  // above: pulling an orphan's parent onto the board would fill it with colleagues'
  // stories the user does not own.
  const parentKeys = [...known, ...discovered]
  const subtaskR = jiraR.ok
    ? await guarded(() => fetchSubtasks(config, parentKeys), { subtasks: [], orphans: [] })
    : { value: { subtasks: [], orphans: [] }, ok: false, error: jiraR.error }

  const items = assignLanes(
    joinItems({ jira, enrichment: enrichR.value, prs, slots, plans, subtasks: subtaskR.value.subtasks, config }),
    config
  ).map((i) => ({ ...i, skills: skillsForItem(i, config) }))

  return {
    generatedAt: now().toISOString(),
    items,
    slots,
    orphanSubtasks: subtaskR.value.orphans,
    sources: {
      jira: source({
        ok: jiraR.ok && enrichR.ok && subtaskR.ok,
        error: jiraR.error ?? enrichR.error ?? subtaskR.error,
      }, jira.length + enrichR.value.length),
      github: source(ghR, prs.length, ghErrors),
      slots: source(slotR, slots.length, slotErrors),
      plans: source(planR, plans.length, planErrors),
    },
  }
}
