// test/cli.test.js — the pure parts of the setup commands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDocsDir, loadConfig, ConfigError, SHARED_PATH } from '../config.js'
import { nodeVersionOk, report, isPlaceholder } from '../cli/doctor.js'
import { missingForWhoami, jiraIdentity, githubIdentity } from '../cli/whoami.js'

const base = {
  jiraSite: 'https://x.atlassian.net', jiraEmail: 'a@b.c', jiraToken: 't',
  myAccountId: 'acc', repos: { 'O/R': { slots: ['/w/A'] } },
}

// --- docsDir resolution -----------------------------------------------------------------

test('docsDir comes from config.json first', () => {
  assert.equal(resolveDocsDir({ docsDir: '/local' }, { docsDir: '/shared' }), '/local')
})

test('docsDir falls back to the optional shared file', () => {
  assert.equal(resolveDocsDir({}, { docsDir: '/shared' }), '/shared')
})

test('docsDir is null when neither has it', () => {
  assert.equal(resolveDocsDir({}, null), null)
  assert.equal(resolveDocsDir(null, null), null)
})

test('the shared file is no longer required — config.json alone is enough', () => {
  // This is the change that made the tool shareable at all: docsDir used to be REQUIRED
  // in ~/.claude/coltw.config.json, a path named after one person's account.
  const cfg = loadConfig({ local: { ...base, docsDir: '/docs' }, shared: null })
  assert.equal(cfg.docsDir, '/docs')
})

test('a missing docsDir names both places it can live', () => {
  assert.throws(() => loadConfig({ local: base, shared: null }), (e) => {
    assert.ok(e instanceof ConfigError)
    assert.match(e.message, /docsDir/)
    assert.match(e.message, /config\.json/)
    assert.match(e.message, /work-dash\.config\.json/)
    return true
  })
})

test('passing shared:null means "no shared file", not "go read the real one"', () => {
  // Otherwise every test here would depend on whatever is in the developer's home
  // directory, and would pass or fail differently on a teammate's machine.
  assert.ok(SHARED_PATH.endsWith('work-dash.config.json'))
  assert.throws(() => loadConfig({ local: base, shared: null }), ConfigError)
})

test('cloudId, which nothing ever read, is gone', () => {
  const cfg = loadConfig({ local: { ...base, docsDir: '/docs' }, shared: null })
  assert.ok(!('cloudId' in cfg))
})

// --- doctor -----------------------------------------------------------------------------

test('nodeVersionOk enforces the 20.11 floor that import.meta.dirname needs', () => {
  for (const v of ['v20.11.0', 'v20.19.4', 'v21.0.0', 'v22.3.1', '20.11.0']) {
    assert.equal(nodeVersionOk(v), true, v)
  }
  for (const v of ['v20.10.0', 'v18.19.0', 'v20.0.0', 'v19.9.9']) {
    assert.equal(nodeVersionOk(v), false, v)
  }
  for (const v of ['', 'banana', undefined, null]) {
    assert.equal(nodeVersionOk(v), false, String(v))
  }
})

test('report marks failures, counts them, and tells you to run it again', () => {
  const r = report([
    { name: 'a', ok: true },
    { name: 'b', ok: false, detail: 'do this' },
    { name: 'c', ok: true },
  ])
  assert.equal(r.failed, 1)
  assert.ok(r.lines[0].startsWith('ok  '))
  assert.ok(r.lines[1].startsWith('FAIL'))
  assert.match(r.lines[1], /do this/)
  assert.match(r.summary, /1 of 3 checks failed/)
})

test('report is clean when everything passes, and says what to do next', () => {
  const r = report([{ name: 'a', ok: true }, { name: 'b', ok: true }])
  assert.equal(r.failed, 0)
  assert.match(r.summary, /all 2 checks passed/)
  assert.ok(!r.lines.some((l) => l.startsWith('FAIL')))
})

test('report indents a multi-line detail so the FAIL lines stay greppable', () => {
  // Leading FAIL/ok is the whole point: an agent scans line starts.
  const r = report([{ name: 'a', ok: false, detail: 'line one\nline two' }])
  const [first, ...rest] = r.lines[0].split('\n')
  assert.ok(first.startsWith('FAIL'))
  for (const l of rest) assert.ok(!/^(ok|FAIL)/.test(l.trimStart()) || l.startsWith('     '), l)
})

// --- whoami -----------------------------------------------------------------------------

test('missingForWhoami names every missing key at once, not one per run', () => {
  assert.deepEqual(missingForWhoami({}), ['jiraSite', 'jiraEmail', 'jiraToken'])
  assert.deepEqual(missingForWhoami({ jiraSite: 's', jiraToken: 't' }), ['jiraEmail'])
  assert.deepEqual(missingForWhoami({ jiraSite: 's', jiraEmail: 'e', jiraToken: 't' }), [])
  assert.deepEqual(missingForWhoami(null), ['jiraSite', 'jiraEmail', 'jiraToken'])
})

test('jiraIdentity returns the accountId on success', async () => {
  const fetchFn = async (url, opts) => {
    assert.equal(url, 'https://x.atlassian.net/rest/api/3/myself')
    assert.match(opts.headers.Authorization, /^Basic /)
    return { ok: true, status: 200, json: async () => ({ accountId: 'abc123', displayName: 'A B', emailAddress: 'a@b.c' }) }
  }
  const r = await jiraIdentity({ jiraSite: 'https://x.atlassian.net', jiraEmail: 'a@b.c', jiraToken: 't' }, { fetchFn })
  assert.deepEqual(r, { ok: true, accountId: 'abc123', displayName: 'A B', email: 'a@b.c' })
})

test('jiraIdentity strips a trailing slash from the site URL', async () => {
  let seen = null
  const fetchFn = async (url) => { seen = url; return { ok: true, status: 200, json: async () => ({}) } }
  await jiraIdentity({ jiraSite: 'https://x.atlassian.net/', jiraEmail: 'a', jiraToken: 't' }, { fetchFn })
  assert.equal(seen, 'https://x.atlassian.net/rest/api/3/myself')
})

test('a 401 explains the Atlassian-vs-work-email trap rather than just failing', async () => {
  // This is the single most common setup mistake, and "HTTP 401" alone does not hint at it.
  const fetchFn = async () => ({ ok: false, status: 401 })
  const r = await jiraIdentity({ jiraSite: 'https://x', jiraEmail: 'work@co.com', jiraToken: 't' }, { fetchFn })
  assert.equal(r.ok, false)
  assert.match(r.error, /work@co\.com/)
  assert.match(r.error, /ATLASSIAN/i)
})

test('other Jira failures are reported with their status', async () => {
  const r = await jiraIdentity({ jiraSite: 'https://x', jiraEmail: 'a', jiraToken: 't' },
    { fetchFn: async () => ({ ok: false, status: 500 }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /500/)
})

test('githubIdentity reads the login from gh', async () => {
  const r = await githubIdentity({ runFn: async (cmd, args) => {
    assert.equal(cmd, 'gh')
    assert.deepEqual(args, ['api', 'user', '--jq', '.login'])
    return { code: 0, stdout: 'someone\n', stderr: '' }
  } })
  assert.deepEqual(r, { ok: true, login: 'someone' })
})

test('githubIdentity points at gh auth login when gh fails', async () => {
  const r = await githubIdentity({ runFn: async () => ({ code: 1, stdout: '', stderr: 'not logged in' }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /gh auth login/)
})

test('githubIdentity treats an empty login as a failure, not as a username', async () => {
  const r = await githubIdentity({ runFn: async () => ({ code: 0, stdout: '  \n', stderr: '' }) })
  assert.equal(r.ok, false)
})


test('isPlaceholder treats the example config\'s stand-ins as unset', () => {
  // A key holding "RUN: work-dash whoami" is present but useless. Reporting the required
  // keys as ok and letting a later check trip over it wastes a round of the fix loop.
  assert.equal(isPlaceholder('RUN: work-dash whoami'), true)
  assert.equal(isPlaceholder('PASTE_TOKEN_FROM_id.atlassian.com'), true)
  assert.equal(isPlaceholder('/Users/YOU/Work/docs'), true)
  // Real values must not be mistaken for placeholders.
  assert.equal(isPlaceholder('62b43cb267dff38e0988a3bc'), false)
  assert.equal(isPlaceholder('/Users/cweiner/Work/docs'), false)
  assert.equal(isPlaceholder('cweiner-PY'), false)
  assert.equal(isPlaceholder('you@performyard.com'), false, 'a real-looking email is not a placeholder')
  for (const v of [null, undefined, 42, {}, []]) assert.equal(isPlaceholder(v), false, String(v))
})
