// collect/jira.js
export function normalizeIssue(raw, jiraSite) {
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
    url: `${jiraSite}/browse/${raw.key}`,
  }
}

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee']
const MAX_RESULTS = 100

async function search(config, jql, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${config.jiraSite}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString('base64'),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jql, fields: FIELDS, maxResults: MAX_RESULTS }),
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
  return issues.map((raw) => normalizeIssue(raw, config.jiraSite))
}

export function fetchPrimary(config, opts) {
  const jql = `assignee = currentUser() AND project = ${config.jiraProject}` +
              ` AND statusCategory != Done ORDER BY updated DESC`
  return search(config, jql, opts)
}

export async function fetchByKeys(config, keys, opts) {
  if (!keys?.length) return []
  return search(config, `key in (${keys.join(',')})`, opts)
}
