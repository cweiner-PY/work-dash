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

async function search(config, jql, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${config.jiraSite}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${config.jiraEmail}:${config.jiraToken}`).toString('base64'),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ jql, fields: FIELDS, maxResults: 100 }),
  })
  if (!res.ok) {
    const body = (await res.text()).replaceAll(config.jiraToken, '[redacted]')
    throw new Error(`Jira request failed: ${res.status} ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  return (data.issues ?? []).map((raw) => normalizeIssue(raw, config.jiraSite))
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
