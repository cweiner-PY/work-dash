// test/collect-jira.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeIssue, fetchPrimary, fetchByKeys, fetchSubtasks } from '../collect/jira.js'

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

test('an empty result with BAD credentials throws instead of returning []', async () => {
  // Jira answers an unauthenticated search with 200 + zero issues, so emptiness alone
  // must never be reported as "no work assigned".
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/myself')) return { ok: false, status: 401, text: async () => 'unauthorized' }
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  await assert.rejects(() => fetchPrimary(config, { fetchImpl }), /rejected the credentials/)
  assert.ok(calls.some((u) => u.endsWith('/myself')), 'must verify identity when empty')
})

test('an empty result with GOOD credentials returns [] and does not throw', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/myself')) return { ok: true, status: 200, json: async () => ({ accountId: 'acct1' }) }
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  const out = await fetchPrimary({ ...config, myAccountId: 'acct1' }, { fetchImpl })
  assert.deepEqual(out, [])
})

test('a NON-empty result skips the identity check entirely', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return { ok: true, status: 200, json: async () => ({ issues: [raw] }) }
  }
  const out = await fetchPrimary(config, { fetchImpl })
  assert.equal(out.length, 1)
  assert.ok(!calls.some((u) => u.endsWith('/myself')), 'no extra request in the common case')
})

test('an accountId mismatch warns but still returns the issues', async () => {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  try {
    const fetchImpl = async (url) => {
      if (url.endsWith('/myself')) return { ok: true, status: 200, json: async () => ({ accountId: 'someone-else' }) }
      return { ok: true, status: 200, json: async () => ({ issues: [] }) }
    }
    const out = await fetchPrimary({ ...config, myAccountId: 'acct1' }, { fetchImpl })
    assert.deepEqual(out, [])
    assert.ok(warnings.some((w) => /does not match/.test(w)), warnings.join(' | '))
  } finally {
    console.warn = realWarn
  }
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

test('a response of exactly 100 issues triggers pagination warning', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(''))
  try {
    const issues = Array(100).fill(raw)
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issues }) })
    await fetchPrimary(config, { fetchImpl })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /at least 100/)
  } finally {
    console.warn = originalWarn
  }
})

test('a response of 3 issues does not trigger pagination warning', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(''))
  try {
    const issues = Array(3).fill(raw)
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issues }) })
    await fetchPrimary(config, { fetchImpl })
    assert.equal(warnings.length, 0)
  } finally {
    console.warn = originalWarn
  }
})

test('isLast === false triggers pagination warning even with fewer issues', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(''))
  try {
    const issues = Array(5).fill(raw)
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issues, isLast: false }) })
    await fetchPrimary(config, { fetchImpl })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /at least 5/)
  } finally {
    console.warn = originalWarn
  }
})

test('nextPageToken in response triggers pagination warning', async () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(''))
  try {
    const issues = Array(50).fill(raw)
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ issues, nextPageToken: 'abc123' }) })
    await fetchPrimary(config, { fetchImpl })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /at least 50/)
  } finally {
    console.warn = originalWarn
  }
})

test('with empty jiraToken, error message does not get garbled', async () => {
  const configNoToken = { ...config, jiraToken: '' }
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized: bad credentials' })
  await assert.rejects(
    () => fetchPrimary(configNoToken, { fetchImpl }),
    (e) => e.message.includes('Unauthorized: bad credentials')
  )
})

test('with a real token, existing redaction still works', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'Invalid token: tok' })
  await assert.rejects(
    () => fetchPrimary(config, { fetchImpl }),
    (e) => !e.message.includes('tok') && e.message.includes('[redacted]')
  )
})

// --- fetchSubtasks ---

const subtaskRaw = {
  key: 'PY-12746-1',
  fields: {
    summary: 'Build catalog UI table',
    status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
    issuetype: { name: 'UI/UX Sub-Task' },
    assignee: { displayName: 'Colt Weiner' },
    parent: { key: 'PY-12746', fields: { summary: 'Post Competency MVP Release - Prototype: Competency Catalog' } },
  },
}

test('fetchSubtasks: empty parentKeys makes NO by-parent request', async () => {
  const calls = []
  const fetchImpl = async (_url, opts) => {
    calls.push(JSON.parse(opts.body).jql)
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  const { subtasks, orphans } = await fetchSubtasks(config, [], { fetchImpl })
  assert.deepEqual(subtasks, [])
  assert.deepEqual(orphans, [])
  assert.equal(calls.length, 1, 'only the mine-elsewhere query should run')
  assert.ok(!calls[0].startsWith('parent in'), 'must not send an unguarded parent in ()')
})

test('fetchSubtasks: by-parent query uses parent in (...) with the given keys', async () => {
  const calls = []
  const fetchImpl = async (_url, opts) => {
    calls.push(JSON.parse(opts.body).jql)
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  await fetchSubtasks(config, ['PY-1', 'PY-2'], { fetchImpl })
  assert.ok(calls.includes('parent in (PY-1,PY-2)'))
  assert.equal(calls.length, 2, 'both the by-parent and mine-elsewhere queries should run')
})

test('fetchSubtasks: the mine-elsewhere query uses subTaskIssueTypes()', async () => {
  const calls = []
  const fetchImpl = async (_url, opts) => {
    calls.push(JSON.parse(opts.body).jql)
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  await fetchSubtasks(config, ['PY-1'], { fetchImpl })
  const mineQuery = calls.find((q) => q.includes('currentUser()'))
  assert.ok(mineQuery, 'expected a mine-elsewhere query')
  assert.match(mineQuery, /assignee = currentUser\(\)/)
  assert.match(mineQuery, /issuetype in subTaskIssueTypes\(\)/)
  assert.match(mineQuery, /statusCategory != Done/)
})

test('fetchSubtasks: requests fields summary, status, issuetype, assignee, parent', async () => {
  let seenFields
  const fetchImpl = async (_url, opts) => {
    seenFields = JSON.parse(opts.body).fields
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  await fetchSubtasks(config, ['PY-1'], { fetchImpl })
  assert.deepEqual(seenFields, ['summary', 'status', 'issuetype', 'assignee', 'parent'])
})

test('fetchSubtasks: an orphan whose parent IS in parentKeys is excluded from orphans', async () => {
  const mineOrphan = { key: 'PY-99999-1', fields: { ...subtaskRaw.fields, parent: { key: 'PY-99999', fields: { summary: 'Not on board' } } } }
  const mineNotOrphan = { key: 'PY-12746-9', fields: { ...subtaskRaw.fields, parent: { key: 'PY-12746', fields: { summary: 'On board' } } } }
  const fetchImpl = async (_url, opts) => {
    const { jql } = JSON.parse(opts.body)
    if (jql.startsWith('parent in')) return { ok: true, status: 200, json: async () => ({ issues: [subtaskRaw] }) }
    return { ok: true, status: 200, json: async () => ({ issues: [mineOrphan, mineNotOrphan] }) }
  }
  const { subtasks, orphans } = await fetchSubtasks(config, ['PY-12746'], { fetchImpl })
  assert.equal(subtasks.length, 1)
  assert.equal(subtasks[0].key, 'PY-12746-1')
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].key, 'PY-99999-1')
})

test('fetchSubtasks: normalization maps every field, tolerating a missing parent', async () => {
  const noParent = { key: 'PY-1-1', fields: { ...subtaskRaw.fields, parent: undefined } }
  const fetchImpl = async (_url, opts) => {
    const { jql } = JSON.parse(opts.body)
    if (jql.startsWith('parent in')) return { ok: true, status: 200, json: async () => ({ issues: [subtaskRaw] }) }
    return { ok: true, status: 200, json: async () => ({ issues: [noParent] }) }
  }
  const { subtasks, orphans } = await fetchSubtasks(config, ['PY-12746'], { fetchImpl })
  assert.deepEqual(subtasks[0], {
    key: 'PY-12746-1',
    summary: 'Build catalog UI table',
    status: 'In Progress',
    statusCategory: 'In Progress',
    issuetype: 'UI/UX Sub-Task',
    assignee: 'Colt Weiner',
    parentKey: 'PY-12746',
    parentSummary: 'Post Competency MVP Release - Prototype: Competency Catalog',
    url: 'https://performyard.atlassian.net/browse/PY-12746-1',
  })
  assert.equal(orphans.length, 1)
  assert.equal(orphans[0].key, 'PY-1-1')
  assert.equal(orphans[0].parentKey, null)
  assert.equal(orphans[0].parentSummary, null)
})
