// test/collect-plans.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectPlans } from '../collect/plans.js'

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'work-dash-plans-'))
  const mk = (sub, folder, files) => {
    const d = join(root, sub, folder)
    mkdirSync(d, { recursive: true })
    for (const f of files) writeFileSync(join(d, f), '#')
  }
  mk('PY', 'PY-12746:Competency-Catalog', ['plan.md', 'notes.md', 'decisions.md'])
  mk('PY', 'PY-12746:Prototype-Competency-Catalog', ['engineering-notes.md'])
  mk('PY', 'PY-13751:Report-Subject-Scoping', ['plan.md', 'code-review.md', 'screenshot.png'])
  mk('Logan', 'Separate-salesforce-push-pull', ['README.md'])
  return root
}

const config = (root) => ({
  docsDir: root,
  repos: { 'PerformYard/PerformYard': { docsSubdir: 'PY' }, 'PerformYard/Logan': { docsSubdir: 'Logan' } },
})

test('finds folders and extracts keys', async () => {
  const root = makeTree()
  const { plans, errors } = await collectPlans(config(root))
  assert.deepEqual(errors, [])
  assert.equal(plans.length, 4)
  const keys = plans.map((p) => p.key).sort()
  // JS default sort is string-based: "null" (n) sorts after "PY…" (P)
  assert.deepEqual(keys, ['PY-12746', 'PY-12746', 'PY-13751', null])
})

test('the same key can appear in two folders', async () => {
  const root = makeTree()
  const { plans } = await collectPlans(config(root))
  const mine = plans.filter((p) => p.key === 'PY-12746')
  assert.equal(mine.length, 2)
})

test('lists only .md files, sorted', async () => {
  const root = makeTree()
  const { plans } = await collectPlans(config(root))
  const p = plans.find((x) => x.folder === 'PY-13751:Report-Subject-Scoping')
  assert.deepEqual(p.files, ['code-review.md', 'plan.md'])
})

test('records docsSubdir and an absolute dir', async () => {
  const root = makeTree()
  const { plans } = await collectPlans(config(root))
  const p = plans.find((x) => x.key === 'PY-13751')
  assert.equal(p.docsSubdir, 'PY')
  assert.equal(p.dir, join(root, 'PY', 'PY-13751:Report-Subject-Scoping'))
})

test('a missing subdirectory is not an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'work-dash-empty-'))
  const { plans, errors } = await collectPlans(config(root))
  assert.deepEqual(plans, [])
  assert.deepEqual(errors, [])
})
