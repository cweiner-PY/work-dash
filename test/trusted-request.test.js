// test/trusted-request.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedRequest } from '../util/trusted-request.js'

const PORT = 4200

test('a foreign Host is rejected', () => {
  assert.equal(isTrustedRequest({ host: 'evil.com:4200' }, PORT), false)
  assert.equal(isTrustedRequest({ host: '127.0.0.1:9999' }, PORT), false, 'a mismatched port must also be rejected')
})

test('a matching Host with no Origin header is accepted', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4200' }, PORT), true)
  assert.equal(isTrustedRequest({ host: 'localhost:4200' }, PORT), true)
})

test('a matching Host with a foreign Origin is rejected', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4200', origin: 'http://evil.com' }, PORT), false)
  assert.equal(isTrustedRequest({ host: 'localhost:4200', origin: 'https://attacker.example' }, PORT), false)
})

test('a matching Host with the same-origin Origin is accepted', () => {
  assert.equal(isTrustedRequest({ host: '127.0.0.1:4200', origin: 'http://127.0.0.1:4200' }, PORT), true)
  assert.equal(isTrustedRequest({ host: 'localhost:4200', origin: 'http://localhost:4200' }, PORT), true)
})

test('a request with no Host header at all is rejected (default deny)', () => {
  assert.equal(isTrustedRequest({}, PORT), false)
})
