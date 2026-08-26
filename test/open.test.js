// test/open.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLauncher, openItem } from '../actions/open.js'

const config = { docsDir: '/docs', repos: { 'O/R': { slots: ['/w/A'] } } }
const item = {
  id: 'PY-12746', key: 'PY-12746', title: 'Competency Catalog', repo: 'O/R',
  jira: { status: 'In Progress', url: 'https://j/PY-12746' },
  prs: [{ number: 7110, headRefName: 'PY-12746-competency', url: 'https://gh/7110' }],
  slot: null, plans: [{ dir: '/docs/PY/PY-12746:Catalog', folder: 'PY-12746:Catalog', files: ['plan.md'] }],
}
const slotA = { dir: '/w/A', repo: 'O/R', branch: 'master', dirty: false, dirtyCount: 0 }
const plans = [{ dir: '/docs/PY/PY-12746:Catalog', file: 'plan.md' }]

test('launcher cds, checks out, and starts claude with name, add-dir and system prompt', () => {
  const s = buildLauncher({ item, slot: slotA, plans, skill: null, config })
  assert.match(s, /^#!\/usr\/bin\/env bash/)
  assert.match(s, /set -euo pipefail/)
  assert.match(s, /cd '\/w\/A'/)
  assert.match(s, /git checkout 'PY-12746-competency'/)
  assert.match(s, /claude -n 'PY-12746'/)
  assert.match(s, /--add-dir '\/docs\/PY\/PY-12746:Catalog'/)
  assert.match(s, /--append-system-prompt/)
  assert.match(s, /plan\.md/)
})

test("buildLauncher never shows a colleague's review-requested PR as the item's PR", () => {
  // Regression for the live PY-1 case: an item holding only a review-requested PR must not
  // have that PR's branch checked out, nor its number/url quoted in the launch context.
  const reviewOnly = { ...item, prs: [{ number: 9001, headRefName: 'PY-13888-bruce-branch', url: 'https://gh/9001', isMine: false }] }
  const s = buildLauncher({ item: reviewOnly, slot: { ...slotA, branch: 'PY-13888-my-older-branch' }, plans, skill: null, config })
  assert.ok(!/git checkout/.test(s), 'must not check out a colleague\'s branch')
  assert.ok(!/PR: #9001/.test(s), 'must not present a colleague\'s PR as this item\'s PR')
})

test('Open does NOT include a positional prompt; Run does', () => {
  const open = buildLauncher({ item, slot: slotA, plans, skill: null, config })
  const run = buildLauncher({ item, slot: slotA, plans, skill: 'ticket-finisher', config })
  assert.ok(!/claude .*'\/ticket-finisher/.test(open))
  assert.match(run, /'\/ticket-finisher PY-12746'/)
})

test('omits the checkout when the slot is already on the branch', () => {
  const s = buildLauncher({ item, slot: { ...slotA, branch: 'PY-12746-competency' }, plans, skill: null, config })
  assert.ok(!/git checkout/.test(s))
})

test('single-quotes are escaped so a title with an apostrophe cannot break out', () => {
  const nasty = { ...item, title: "Don't break 'this'", jira: { status: "It's fine", url: 'u' } }
  const s = buildLauncher({ item: nasty, slot: slotA, plans, skill: null, config })
  // Each embedded ' is closed, escaped and reopened: ' -> '\''
  assert.ok(s.includes(String.raw`Don'\''t break '\''this'\''`),
    'title apostrophes must be escaped, not left to break the quoting')
  assert.ok(s.includes(String.raw`It'\''s fine`))
})

test('dry run writes no file and runs no command, but returns the script', async () => {
  let wrote = false, ran = false
  const r = await openItem({ item, slots: [slotA], plans, skill: null, config },
    { run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' } },
      writeFile: async () => { wrote = true }, dry: true })
  assert.equal(r.ok, true)
  assert.equal(wrote, false)
  assert.equal(ran, false)
  assert.match(r.detail, /git checkout/)
})

test('a real run writes the launcher and invokes osascript', async () => {
  const calls = []
  const r = await openItem({ item, slots: [slotA], plans, skill: 'pr-description', config },
    { run: async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: '', stderr: '' } },
      writeFile: async () => {}, dry: false })
  assert.equal(r.ok, true)
  assert.equal(calls[0][0], 'osascript')
  assert.match(calls[0][1].join(' '), /tell application "Terminal"/)
})

test('refuses when no slot is eligible, and returns the candidates', async () => {
  const dirty = { ...slotA, branch: 'busy', dirty: true, dirtyCount: 4 }
  const r = await openItem({ item, slots: [dirty], plans, skill: null, config },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
  assert.equal(r.ok, false)
  assert.ok(r.candidates.length === 1)
  assert.match(r.message, /pick a slot/i)
})

test('refuses to emit a checkout into a dirty slot even when explicitly chosen', async () => {
  const dirty = { ...slotA, branch: 'busy', dirty: true, dirtyCount: 4 }
  const r = await openItem({ item, slots: [dirty], plans, skill: null, config, chosenSlotDir: '/w/A' },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /uncommitted/i)
})

test('fails CLOSED on ambiguous dirty state even when the slot is explicitly chosen', async () => {
  // Mirrors the same fail-closed fix in slot.js: dirty=undefined/null/0/'' must not be
  // treated as clean on the explicit-choice path either.
  for (const dirty of [undefined, null, 0, '']) {
    const ambiguous = { ...slotA, branch: 'busy', dirty, dirtyCount: 5 }
    const r = await openItem({ item, slots: [ambiguous], plans, skill: null, config, chosenSlotDir: '/w/A' },
      { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
    assert.equal(r.ok, false, `dirty=${JSON.stringify(dirty)} must be refused, not launched`)
    assert.match(r.message, /uncommitted/i)
  }
})

test('an explicit chosenSlotDir overrides a claim (a deliberate pick beats the server\'s guess)', async () => {
  const r = await openItem(
    { item, slots: [slotA], plans, skill: null, config, chosenSlotDir: '/w/A', claimedDirs: new Set(['/w/A']) },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
  assert.equal(r.ok, true)
})

test('two opens of the same ticket use different launcher paths (no path collision)', async () => {
  const paths = []
  const writeFile = async (p) => { paths.push(p) }
  const deps = { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile, dry: false }
  await openItem({ item, slots: [slotA], plans, skill: null, config }, deps)
  await openItem({ item, slots: [slotA], plans, skill: null, config }, deps)
  assert.equal(paths.length, 2)
  assert.notEqual(paths[0], paths[1], 'a second open of the same ticket must not race the first on one file')
})

test('refuses a chosenSlotDir belonging to a different repo', async () => {
  // The reviewer flagged that open.js shares update-branch.js's cross-repo hazard: a raw
  // API call could hand this item a slotDir from an unrelated repo, and a checkout would
  // be emitted into it. The slot's own `repo` field is the guard, same as update-branch.js.
  const foreign = { ...slotA, dir: '/w/OTHER', repo: 'X/Y' }
  let ran = 0
  const r = await openItem({ item, slots: [foreign], plans, skill: null, config, chosenSlotDir: '/w/OTHER' },
    { run: async () => { ran++; return { code: 0, stdout: '', stderr: '' } }, writeFile: async () => {}, dry: true })
  assert.equal(ran, 0, 'must not emit or run anything for a cross-repo slot')
  assert.equal(r.ok, false)
  assert.match(r.message, /belongs to X\/Y/)
})
