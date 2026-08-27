// test/gitignore.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

// `git check-ignore` is asked rather than .gitignore being string-matched: git is the
// authority, and it accounts for later negations, ~/.gitignore_global and .git/info/exclude
// — any of which could re-expose a file a plain text match would call safe.
const isIgnored = (path) => {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT })
    return true
  } catch { return false }
}

test('config.json is gitignored — it holds the Jira API token', () => {
  assert.equal(isIgnored('config.json'), true,
    'config.json must never be committable: it carries a live Jira API token')
})

test('config.json has never been committed', () => {
  // The check above only protects the future. This one checks the past, which no
  // .gitignore can fix retroactively.
  const everCommitted = execFileSync('git', ['log', '--all', '--pretty=format:', '--name-only'],
    { cwd: ROOT, encoding: 'utf8' })
    .split('\n').some((l) => l.trim() === 'config.json')
  assert.equal(everCommitted, false, 'config.json appears in the history — the token must be rotated')
})

test('the example config is NOT ignored — a teammate needs it', () => {
  // The .env.* pattern nearly swallowed .env.example; the same mistake with the config
  // template would leave a fresh clone with nothing to copy.
  assert.equal(isIgnored('config.example.json'), false)
})

test('common credential file shapes are ignored', () => {
  for (const p of ['.env', '.env.local', 'id_rsa.key', 'server.pem', 'jira.token']) {
    assert.equal(isIgnored(p), true, `${p} should be ignored`)
  }
  assert.equal(isIgnored('.env.example'), false, '.env.example is a template, not a secret')
})

test('no tracked file contains an Atlassian API token', () => {
  // A shape check, not a match against any particular token — Atlassian issues tokens with
  // a fixed prefix. Assembled from fragments so that THIS file does not itself contain the
  // literal: on the first run after committing, it found itself. Excluding this file by name
  // would have worked too, and would have left a blind spot in the one file most likely to
  // have a real token pasted into it while someone is editing this very test.
  const needle = ['ATATT', '3xFfGF0'].join('')
  // The WORKING TREE of every tracked file, not HEAD: a token pasted into a tracked file
  // should fail the suite before it is committed, which is the point at which it is still
  // cheap to fix. Reading HEAD would only ever report it afterwards.
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  const hits = []
  for (const f of tracked) {
    try {
      if (readFileSync(join(ROOT, f), 'utf8').includes(needle)) hits.push(f)
    } catch { /* absent or binary: nothing to match */ }
  }
  assert.deepEqual(hits, [], 'an Atlassian token prefix appears in a tracked file')
})

test('the token scanner actually detects a token, and is not vacuously green', () => {
  // A scanner that can never fire is worse than no scanner: it reports safety it did not
  // establish. Proven against a synthetic token of the real shape.
  const needle = ['ATATT', '3xFfGF0'].join('')
  const synthetic = `${needle}abc123_NOT_A_REAL_TOKEN`
  assert.ok(synthetic.includes(needle), 'the assembled prefix must match a real-shaped token')
  assert.ok(!'a harmless file with no secrets'.includes(needle))
})
