// test/port-error.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describePortError } from '../util/port-error.js'

test('EADDRINUSE produces a clear message naming the port', () => {
  const msg = describePortError({ code: 'EADDRINUSE' }, 4210)
  assert.match(msg, /4210/)
  assert.match(msg, /already in use/i)
  assert.match(msg, /already be running/i)
  assert.match(msg, /config\.json/)
})

test('a different error code is not handled here (returns null, so the caller re-throws)', () => {
  assert.equal(describePortError({ code: 'EACCES' }, 4210), null)
  assert.equal(describePortError(new Error('boom'), 4210), null)
})

test('an error with no code at all is also not handled here', () => {
  assert.equal(describePortError({}, 4210), null)
})
