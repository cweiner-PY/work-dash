// collect/jira.js

// customfield_10020 (the sprint field) returns an array of sprint objects, each
// carrying at least { name, state }. We want the FIRST sprint whose state is
// 'active' — a closed sprint (a ticket that rode out its sprint and is still
// open) must not count as sprint-committed. Tolerate the field being absent, a
// non-array, null entries, and entries missing state or name — never throw.
function extractActiveSprint(value) {
  if (!Array.isArray(value)) return null
  const active = value.find((s) => s && s.state === 'active')
  return typeof active?.name === 'string' ? active.name : null
}

// sprintField is instance-specific (config.jiraSprintField) and is threaded through
// from search() rather than hardcoded here.
export function normalizeIssue(raw, jiraSite, sprintField = 'customfield_10020') {
  const f = raw.fields ?? {}
  return {
    key: raw.key,
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.name ?? null,
    issuetype: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    assigneeAccountId: f.assignee?.accountId ?? null,
    activeSprint: extractActiveSprint(f[sprintField]),
    // Jira OMITS an unrecognized custom field from `fields` entirely rather than
    // returning it as null — verified against the live API. So presence (not the value)
    // is what tells "this Jira instance genuinely has no active sprint right now" apart
    // from "jiraSprintField is misconfigured for this instance". See needsSprintFallback
    // in lanes.js, the actual consumer of this flag.
    sprintFieldPresent: Object.prototype.hasOwnProperty.call(f, sprintField),
    url: `${jiraSite}/browse/${raw.key}`,
  }
}

function normalizeSubtask(raw, jiraSite) {
  const f = raw.fields ?? {}
  return {
    key: raw.key,
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    statusCategory: f.status?.statusCategory?.name ?? null,
    issuetype: f.issuetype?.name ?? null,
    assignee: f.assignee?.displayName ?? null,
    parentKey: f.parent?.key ?? null,
    parentSummary: f.parent?.fields?.summary ?? null,
    url: `${jiraSite}/browse/${raw.key}`,
  }
}

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee']
const SUBTASK_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'parent']
const MAX_RESULTS = 100

// `fields` and `normalize` are overridable so fetchSubtasks can reuse this same request/
// pagination-warning/redaction machinery with a different field list and a different
// shape (parentKey/parentSummary instead of priority) — normalizeIssue stays the default
// so fetchPrimary/fetchByKeys are untouched. When `fields` is NOT overridden (i.e. the
// primary and by-keys/enrichment queries), the sprint field is appended so both carry a
// consistent activeSprint shape; fetchSubtasks explicitly overrides fields and so never
// requests it.
async function search(config, jql, { fetchImpl = fetch, fields, normalize = normalizeIssue } = {}) {
  const sprintField = config.jiraSprintField ?? 'customfield_10020'
  const effectiveFields = fields ?? [...FIELDS, sprintField]
  const res = await fetchImpl(`${config.jiraSite}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString('base64'),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jql, fields: effectiveFields, maxResults: MAX_RESULTS }),
  })
  if (!res.ok) {
    let body = await res.text()
    // Guard the empty-token case: ''.replaceAll would splice [redacted] between
    // every character, garbling the one message the user reads during setup.
    if (config.jiraToken) body = body.replaceAll(config.jiraToken, '[redacted]')
    throw new Error(`Jira request failed: ${res.status} ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const issues = data.issues ?? []
  // Never truncate silently. A board that quietly omits work is worse than a
  // noisy one, because the user cannot tell the difference from "nothing to do".
  if (issues.length >= MAX_RESULTS || data.isLast === false || data.nextPageToken) {
    console.warn(
      `work-dash: Jira returned at least ${issues.length} issues for this query and ` +
      `may have more. Only the first ${MAX_RESULTS} are shown. Narrow the JQL filter.`
    )
  }
  return issues.map((raw) => normalize(raw, config.jiraSite, sprintField))
}

// Jira's /search/jql returns HTTP 200 with an EMPTY issue list when the credentials are
// bad, rather than 401. Verified against the live API: with a wrong jiraEmail, /myself
// returns 401 while the same search returns 200 and zero issues. So an expired token or a
// typo'd email would render a completely empty board that is indistinguishable from
// "you have nothing to do" — the single most misleading state this dashboard could show.
// We therefore only pay for an identity check when the result is empty, and use it to tell
// the two cases apart.
async function assertAuthenticated(config, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${config.jiraSite}/rest/api/3/myself`, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString('base64'),
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    throw new Error(
      `Jira rejected the credentials (HTTP ${res.status}). Check jiraEmail and jiraToken in ` +
      `config.json — note the email must be the one your Atlassian account actually uses, ` +
      `which is not always your work address.`
    )
  }
  const me = await res.json()
  if (config.myAccountId && me.accountId && me.accountId !== config.myAccountId) {
    console.warn(
      `work-dash: config myAccountId (${config.myAccountId}) does not match the token's ` +
      `account (${me.accountId}). "Assigned to me" and the foreign-ticket flag will be wrong.`
    )
  }
  return me
}

export async function fetchPrimary(config, opts) {
  const jql = `assignee = currentUser() AND project = ${config.jiraProject}` +
              ` AND statusCategory != Done ORDER BY updated DESC`
  const issues = await search(config, jql, opts)
  // Empty is ambiguous: genuinely nothing assigned, or silently unauthenticated.
  if (issues.length === 0) await assertAuthenticated(config, opts)
  return issues
}

export async function fetchByKeys(config, keys, opts) {
  if (!keys?.length) return []
  return search(config, `key in (${keys.join(',')})`, opts)
}

// subTaskIssueTypes() over hardcoding "UI/UX Sub-Task", "Bug Sub-task", "Verification
// Sub-Task": verified against the live instance, and those literal names will drift —
// a rename would silently empty this view rather than error.
export async function fetchSubtasks(config, parentKeys, opts) {
  const subOpts = { ...opts, fields: SUBTASK_FIELDS, normalize: normalizeSubtask }
  // Mirror fetchByKeys's guard: an unguarded `parent in ()` is a malformed query on
  // every refresh, so skip this half entirely when there is nothing to ask about.
  const subtasks = parentKeys?.length
    ? await search(config, `parent in (${parentKeys.join(',')})`, subOpts)
    : []
  const mine = await search(
    config,
    'assignee = currentUser() AND issuetype in subTaskIssueTypes() AND statusCategory != Done',
    subOpts
  )
  const onBoard = new Set(parentKeys ?? [])
  // Subtasks already nested under their parent (above) must not also appear as
  // "orphans" — showing them twice would be worse than not showing them.
  const orphans = mine.filter((s) => !onBoard.has(s.parentKey))
  return { subtasks, orphans }
}
