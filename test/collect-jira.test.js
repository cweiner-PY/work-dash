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
    activeSprint: null,
    // `raw.fields` above has no customfield_10020 key at all — the field is absent,
    // not merely null-valued.
    sprintFieldPresent: false,
    url: 'https://performyard.atlassian.net/browse/PY-13751',
  })
})

test('tolerates null assignee and null priority', () => {
  const n = normalizeIssue({ key: 'PY-1', fields: { ...raw.fields, assignee: null, priority: null } }, config.jiraSite)
  assert.equal(n.assignee, null)
  assert.equal(n.assigneeAccountId, null)
  assert.equal(n.priority, null)
})

// --- activeSprint normalization ---
// customfield_10020 (the default sprint field) returns an array of sprint objects,
// each with at least { name, state }. Only the FIRST sprint whose state is 'active'
// counts — a closed sprint (PY-11672: a ticket that rode out its sprint and is still
// open) must normalize to null, not to that closed sprint's name.
const sprintField = 'customfield_10020'
const withSprint = (value) => normalizeIssue({ key: 'PY-1', fields: { ...raw.fields, [sprintField]: value } }, config.jiraSite)

test('activeSprint: an active sprint yields its name', () => {
  const n = withSprint([{ id: 1, name: 'RW2026.6-S1 Ending 2026.08.26', state: 'active' }])
  assert.equal(n.activeSprint, 'RW2026.6-S1 Ending 2026.08.26')
})

test('activeSprint: a CLOSED sprint yields null, not the closed sprint\'s name (PY-11672 case)', () => {
  const n = withSprint([{ id: 1, name: 'RW2026.1-S2 Ending 2026.02.18', state: 'closed' }])
  assert.equal(n.activeSprint, null)
})

test('activeSprint: the first ACTIVE sprint wins when multiple sprints are present', () => {
  const n = withSprint([
    { id: 1, name: 'Old Sprint', state: 'closed' },
    { id: 2, name: 'Current Sprint', state: 'active' },
    { id: 3, name: 'Future Sprint', state: 'future' },
  ])
  assert.equal(n.activeSprint, 'Current Sprint')
})

test('activeSprint: field absent from fields entirely yields null', () => {
  const n = normalizeIssue(raw, config.jiraSite)
  assert.equal(n.activeSprint, null)
})

test('activeSprint: an empty array yields null', () => {
  assert.equal(withSprint([]).activeSprint, null)
})

test('activeSprint: null yields null (no throw)', () => {
  assert.equal(withSprint(null).activeSprint, null)
})

test('activeSprint: a non-array value yields null (no throw)', () => {
  assert.equal(withSprint('not an array').activeSprint, null)
  assert.equal(withSprint({ not: 'an array' }).activeSprint, null)
})

test('activeSprint: a null entry in the array is tolerated (no throw)', () => {
  const n = withSprint([null, { id: 2, name: 'Current Sprint', state: 'active' }])
  assert.equal(n.activeSprint, 'Current Sprint')
})

test('activeSprint: an active entry missing "name" yields null rather than throwing', () => {
  assert.equal(withSprint([{ id: 1, state: 'active' }]).activeSprint, null)
})

test('activeSprint: an active entry missing "state" is never mistaken for active', () => {
  assert.equal(withSprint([{ id: 1, name: 'No State Sprint' }]).activeSprint, null)
})

test('normalizeIssue reads the sprint field name passed to it, not just the default', () => {
  const n = normalizeIssue(
    { key: 'PY-1', fields: { ...raw.fields, customfield_99999: [{ name: 'Custom Field Sprint', state: 'active' }] } },
    config.jiraSite,
    'customfield_99999'
  )
  assert.equal(n.activeSprint, 'Custom Field Sprint')
})

// --- sprintFieldPresent: presence, not value, distinguishes "no active sprint right
// now" from "jiraSprintField is misconfigured" (see needsSprintFallback in lanes.js) ---

test('sprintFieldPresent: true when the field key exists on fields, even with a null-ish value', () => {
  assert.equal(withSprint(null).sprintFieldPresent, true)
  assert.equal(withSprint([]).sprintFieldPresent, true)
  assert.equal(withSprint([{ id: 1, name: 'S1', state: 'active' }]).sprintFieldPresent, true)
})

test('sprintFieldPresent: false when the field is absent from fields entirely', () => {
  const n = normalizeIssue(raw, config.jiraSite)
  assert.equal(n.sprintFieldPresent, false)
})

test('sprintFieldPresent respects an overridden sprint field name, not just the default', () => {
  const present = normalizeIssue(
    { key: 'PY-1', fields: { ...raw.fields, customfield_99999: null } },
    config.jiraSite, 'customfield_99999')
  assert.equal(present.sprintFieldPresent, true)
  // raw.fields has customfield_10020 nowhere, so asking about a DIFFERENT field name
  // must also report absent — it must check the actual configured key, not just any key.
  const absent = normalizeIssue(raw, config.jiraSite, 'customfield_99999')
  assert.equal(absent.sprintFieldPresent, false)
})

test('the enrichment query (fetchByKeys) carries sprintFieldPresent the same way fetchPrimary does', async () => {
  // A board built mostly from enriched items must not miss a real misconfiguration, nor
  // false-alarm on one just because the field happened to be checked via a different query.
  const fetchImpl = async (_url, opts) => {
    const { fields } = JSON.parse(opts.body)
    assert.ok(fields.includes('customfield_10020'))
    return { ok: true, status: 200, json: async () => ({ issues: [raw] }) } // raw carries NO sprint field key
  }
  const out = await fetchByKeys(config, ['PY-13751'], { fetchImpl })
  assert.equal(out[0].sprintFieldPresent, false)
})

// --- sprint field threaded through the fields list (Change 1) ---
test('fetchPrimary requests the sprint field, defaulting to customfield_10020', async () => {
  let seenFields
  // A non-empty result so fetchPrimary doesn't also hit /myself (which has no body).
  const fetchImpl = async (_url, opts) => {
    seenFields = JSON.parse(opts.body).fields
    return { ok: true, status: 200, json: async () => ({ issues: [raw] }) }
  }
  await fetchPrimary(config, { fetchImpl })
  assert.ok(seenFields.includes('customfield_10020'))
})

test('fetchByKeys also requests the sprint field, for a consistent shape across all items', async () => {
  let seenFields
  const fetchImpl = async (_url, opts) => {
    seenFields = JSON.parse(opts.body).fields
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  await fetchByKeys(config, ['PY-1'], { fetchImpl })
  assert.ok(seenFields.includes('customfield_10020'))
})

test('a configured jiraSprintField overrides the default in the requested fields AND the normalized output', async () => {
  let seenFields
  const raw99999 = { key: 'PY-1', fields: { ...raw.fields, customfield_99999: [{ name: 'Instance Sprint', state: 'active' }] } }
  const fetchImpl = async (_url, opts) => {
    seenFields = JSON.parse(opts.body).fields
    return { ok: true, status: 200, json: async () => ({ issues: [raw99999] }) }
  }
  const out = await fetchPrimary({ ...config, jiraSprintField: 'customfield_99999' }, { fetchImpl })
  assert.ok(seenFields.includes('customfield_99999'))
  assert.ok(!seenFields.includes('customfield_10020'))
  assert.equal(out[0].activeSprint, 'Instance Sprint')
})

test('fetchSubtasks does NOT request the sprint field — subtasks keep their own field list', async () => {
  let seenFields
  const fetchImpl = async (_url, opts) => {
    seenFields = JSON.parse(opts.body).fields
    return { ok: true, status: 200, json: async () => ({ issues: [] }) }
  }
  await fetchSubtasks(config, ['PY-1'], { fetchImpl })
  assert.ok(!seenFields.includes('customfield_10020'))
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
