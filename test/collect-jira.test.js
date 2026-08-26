// test/collect-jira.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIssue, fetchPrimary, fetchByKeys } from '../collect/jira.js'

const config = {
  jiraSite: 'https://performyard.atlassian.net',
  jiraEmail: 'a@b.com', jiraToken: 'tok', jiraProject: 'PY',
}

const raw = {
  key: 'PY-13751',
  fields: {
    summary: 'Report subject-scoping check never runs',
    status: { name: 'Ready To Test', statusCategory: { name: 'In Progress' } },
    issuetype: { name: 'Bug' },
    priority: { name: 'P2-Medium' },
    assignee: { displayName: 'Colt Weiner', accountId: '62b43cb267dff38e0988a3bc' },
  },
}

test('normalizes a raw issue', () => {
  assert.deepEqual(normalizeIssue(raw, config.jiraSite), {
    key: 'PY-13751',
    summary: 'Report subject-scoping check never runs',
    status: 'Ready To Test',
    statusCategory: 'In Progress',
    issuetype: 'Bug',
    priority: 'P2-Medium',
    assignee: 'Colt Weiner',
    assigneeAccountId: '62b43cb267dff38e0988a3bc',
    url: 'https://performyard.atlassian.net/browse/PY-13751',
  })
})

test('tolerates null assignee and null priority', () => {
  const n = normalizeIssue({ key: 'PY-1', fields: { ...raw.fields, assignee: null, priority: null } }, config.jiraSite)
  assert.equal(n.assignee, null)
  assert.equal(n.assigneeAccountId, null)
  assert.equal(n.priority, null)
})

test('fetchPrimary sends the right JQL and basic auth', async () => {
  let seen
  const fetchImpl = async (url, opts) => {
    seen = { url, opts }
    return { ok: true, status: 200, json: async () => ({ issues: [raw] }) }
  }
  const out = await fetchPrimary(config, { fetchImpl })
  assert.equal(out.length, 1)
  assert.equal(out[0].key, 'PY-13751')
  assert.match(seen.url, /\/rest\/api\/3\/search\/jql$/)
  const body = JSON.parse(seen.opts.body)
  assert.equal(body.jql,
    'assignee = currentUser() AND project = PY AND statusCategory != Done ORDER BY updated DESC')
  assert.equal(seen.opts.headers.Authorization,
    'Basic ' + Buffer.from('a@b.com:tok').toString('base64'))
})

test('fetchByKeys builds a key IN query', async () => {
  let body
  const fetchImpl = async (_u, opts) => {
    body = JSON.parse(opts.body)
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  await fetchByKeys(config, ['PY-13888', 'PY-13044'], { fetchImpl })
  assert.equal(body.jql, 'key in (PY-13888,PY-13044)')
})

test('fetchByKeys with no keys makes NO request', async () => {
  let called = false
  const fetchImpl = async () => { called = true }
  const out = await fetchByKeys(config, [], { fetchImpl })
  assert.deepEqual(out, [])
  assert.equal(called, false)
})

test('a non-ok response throws with the status and body', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' })
  await assert.rejects(() => fetchPrimary(config, { fetchImpl }), /401/)
})

test('the error message never contains the token', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad token tok' })
  await assert.rejects(() => fetchPrimary(config, { fetchImpl }),
    (e) => !e.message.includes('tok') || e.message.includes('[redacted]'))
})
