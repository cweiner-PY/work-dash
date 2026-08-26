import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from '../config.js'

const SENTINEL = 'SUPER_SECRET_TOKEN_VALUE_9f3a'
const base = {
  jiraSite: 'https://performyard.atlassian.net',
  jiraEmail: 'a@b.com', jiraToken: SENTINEL, myAccountId: 'acct1',
  repos: { 'O/R': { docsSubdir: 'PY', slots: ['/tmp/s1'] } },
}

test('applies defaults', () => {
  const c = loadConfig({ local: base, shared: { docsDir: '/docs', cloudId: 'cid' } })
  assert.equal(c.port, 4200)
  assert.equal(c.jiraProject, 'PY')
  assert.deepEqual(c.inFlightStatusOrder,
    ['In Progress', 'In Code Review', 'Ready To Test', 'In Testing', 'Ready To Merge'])
  assert.equal(c.docsDir, '/docs')
})

test('local config overrides defaults', () => {
  const c = loadConfig({ local: { ...base, port: 5000 }, shared: { docsDir: '/d', cloudId: 'c' } })
  assert.equal(c.port, 5000)
})

test('missing jiraToken throws a helpful ConfigError', () => {
  const { jiraToken, ...noToken } = base
  assert.throws(
    () => loadConfig({ local: noToken, shared: { docsDir: '/d', cloudId: 'c' } }),
    (e) => e instanceof ConfigError && /jiraToken/.test(e.message) && /id\.atlassian\.com/.test(e.message)
  )
})

test('missing docsDir in shared config throws', () => {
  assert.throws(() => loadConfig({ local: base, shared: {} }),
    (e) => e instanceof ConfigError && /docsDir/.test(e.message))
})

test('never exposes the token via toSafeJSON', () => {
  const c = loadConfig({ local: base, shared: { docsDir: '/d', cloudId: 'c' } })
  const safe = c.toSafeJSON()
  assert.equal(safe.jiraToken, undefined)
  assert.ok(!JSON.stringify(safe).includes(SENTINEL), 'token must not survive serialization')
  // and the rest of the config is still there
  assert.equal(safe.jiraEmail, 'a@b.com')
  assert.equal(safe.port, 4200)
})

test('JSON.stringify does not leak token via toJSON', () => {
  const c = loadConfig({ local: base, shared: { docsDir: '/d', cloudId: 'c' } })
  const serialized = JSON.stringify(c)
  assert.ok(!serialized.includes(SENTINEL), 'token must not survive JSON.stringify')
})

test('serialized config still contains non-secret keys', () => {
  const c = loadConfig({ local: base, shared: { docsDir: '/d', cloudId: 'c' } })
  const serialized = JSON.stringify(c)
  assert.ok(serialized.includes('a@b.com'), 'jiraEmail should be in serialized output')
  assert.ok(serialized.includes('4200'), 'port should be in serialized output')
})

test('jiraToken is still readable directly', () => {
  const c = loadConfig({ local: base, shared: { docsDir: '/d', cloudId: 'c' } })
  assert.equal(c.jiraToken, SENTINEL)
})

test('toJSON and toSafeJSON do not leak as keys in serialized output', () => {
  const c = loadConfig({ local: base, shared: { docsDir: '/d', cloudId: 'c' } })
  const serialized = JSON.stringify(c)
  assert.ok(!serialized.includes('toJSON'), 'toJSON must not appear as a key')
  assert.ok(!serialized.includes('toSafeJSON'), 'toSafeJSON must not appear as a key')
})
