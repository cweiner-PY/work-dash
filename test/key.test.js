import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractKey } from '../util/key.js'

test('extracts from a branch name', () => {
  assert.equal(extractKey('PY-13888-fix-share-report-basic-admin'), 'PY-13888')
})
test('uppercases', () => {
  assert.equal(extractKey('py-12746-competency'), 'PY-12746')
})
test('extracts LOGAN keys', () => {
  assert.equal(extractKey('logan-42-thing'), 'LOGAN-42')
})
test('extracts from a plan folder name with a colon', () => {
  assert.equal(extractKey('PY-12579:Download-Call-Transcripts'), 'PY-12579')
})
test('extracts from a PR title', () => {
  assert.equal(extractKey('PY-13751 report subject scoping check never runs'), 'PY-13751')
})
test('returns null when there is no key', () => {
  assert.equal(extractKey('feat/salesforce-implementation-date-source-of-truth'), null)
  assert.equal(extractKey('update-churn-agent-prompt'), null)
  assert.equal(extractKey(''), null)
  assert.equal(extractKey(null), null)
})
test('does not match a bare number or a different project', () => {
  assert.equal(extractKey('QTM-1244'), null)
  assert.equal(extractKey('12746'), null)
})
test('takes the first key when several appear', () => {
  assert.equal(extractKey('PY-12856-PY-12866:Manager-Report'), 'PY-12856')
})
