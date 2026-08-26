import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evalPredicate, PredicateError } from '../util/predicate.js'

const ctx = {
  slot: { dir: '/tmp' },
  branch: 'PY-1-x',
  pr: { changesRequested: false, hasReviewComments: true },
  repo: 'PerformYard/Logan',
}
const empty = { slot: null, branch: null, pr: null, repo: 'PerformYard/PerformYard' }

test('bare identifier truthiness', () => {
  assert.equal(evalPredicate('slot', ctx), true)
  assert.equal(evalPredicate('slot', empty), false)
})
test('negation', () => {
  assert.equal(evalPredicate('!pr', empty), true)
  assert.equal(evalPredicate('!pr', ctx), false)
})
test('conjunction', () => {
  assert.equal(evalPredicate('!branch && !pr', empty), true)
  assert.equal(evalPredicate('!branch && !pr', ctx), false)
})
test('disjunction over dotted paths', () => {
  assert.equal(evalPredicate('pr.hasReviewComments || pr.changesRequested', ctx), true)
  assert.equal(evalPredicate('pr.changesRequested || pr.other', ctx), false)
})
test('dotted path through null is falsy, not a throw', () => {
  assert.equal(evalPredicate('pr.hasReviewComments', empty), false)
})
test('string equality and inequality', () => {
  assert.equal(evalPredicate("repo == 'PerformYard/Logan'", ctx), true)
  assert.equal(evalPredicate("repo == 'PerformYard/Logan'", empty), false)
  assert.equal(evalPredicate("repo != 'PerformYard/Logan'", empty), true)
})
test('parentheses change precedence', () => {
  assert.equal(evalPredicate('!(slot && pr)', ctx), false)
  assert.equal(evalPredicate('!(slot && pr)', empty), true)
})
test('empty array is falsy, non-empty is truthy', () => {
  assert.equal(evalPredicate('plans', { plans: [] }), false)
  assert.equal(evalPredicate('plans', { plans: [{ dir: 'x' }] }), true)
})
test('unparseable expression throws PredicateError', () => {
  assert.throws(() => evalPredicate('slot &&', ctx), PredicateError)
  assert.throws(() => evalPredicate('slot === "x"', ctx), PredicateError)
})
