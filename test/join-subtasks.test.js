// test/join-subtasks.test.js
// Kept separate from test/join.test.js on purpose: the acceptance board in that file
// must stay byte-for-byte unchanged as a regression guard, so subtask-specific cases
// live here instead of being appended to it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join as joinItems } from '../join.js'

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'))
const ME = 'deadbeefdeadbeefdeadbeef'

const config = {
  myAccountId: ME,
  repos: {
    'PerformYard/PerformYard': { docsSubdir: 'PY', slots: ['/Users/cweiner/Work/PY-1', '/Users/cweiner/Work/PY-2', '/Users/cweiner/Work/PY-3'] },
    'PerformYard/Logan': { docsSubdir: 'Logan', slots: ['/Users/cweiner/Work/Logan', '/Users/cweiner/Work/Logan2', '/Users/cweiner/Work/Logan3'] },
  },
}

function boardWithSubtasks() {
  const items = joinItems({
    jira: fx('jira-primary.json'),
    enrichment: fx('jira-enrichment.json'),
    prs: [], slots: [], plans: [],
    subtasks: fx('jira-subtasks.json'),
    config,
  })
  return new Map(items.map((i) => [i.id, i]))
}

test('subtasks attach to the right item by parentKey', () => {
  const b = boardWithSubtasks()
  const it = b.get('PY-12746')
  assert.equal(it.subtasks.length, 3)
  assert.deepEqual(it.subtasks.map((s) => s.key).sort(), ['PY-12746-1', 'PY-12746-2', 'PY-12746-3'])
})

test('an item with no matching subtasks gets an empty array', () => {
  const b = boardWithSubtasks()
  assert.deepEqual(b.get('PY-13751').subtasks, [])
})

test('a subtask whose parent is not on the board attaches nowhere, and creates no new item', () => {
  const b = boardWithSubtasks()
  for (const it of b.values()) {
    assert.ok(!it.subtasks.some((s) => s.key === 'PY-99999-1'), `PY-99999-1 leaked onto ${it.id}`)
  }
  assert.equal(b.has('PY-99999'), false)
})

test('keyless items get an empty subtasks array too', () => {
  const items = joinItems({
    jira: [], enrichment: [], plans: [], slots: [],
    prs: [{ repo: 'PerformYard/Logan', number: 1, title: 'no key here', headRefName: 'random-branch', isMine: true }],
    subtasks: fx('jira-subtasks.json'),
    config,
  })
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].subtasks, [])
})

test('join stays pure with a subtasks input', () => {
  const args = { jira: fx('jira-primary.json'), enrichment: fx('jira-enrichment.json'), prs: [], slots: [], plans: [], subtasks: fx('jira-subtasks.json'), config }
  const a = JSON.stringify(joinItems(args))
  const b = JSON.stringify(joinItems(args))
  assert.equal(a, b)
})

test('subtasks default to [] when the argument is omitted entirely', () => {
  const items = joinItems({ jira: fx('jira-primary.json'), enrichment: [], prs: [], slots: [], plans: [], config })
  assert.ok(items.every((i) => Array.isArray(i.subtasks) && i.subtasks.length === 0))
})
