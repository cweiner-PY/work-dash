// test/collect-slots.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectSlots } from '../collect/slots.js'

const config = {
  repos: {
    'PerformYard/PerformYard': { slots: ['/Users/cweiner/Work/PY-1'] },
    'PerformYard/Logan': { slots: ['/Users/cweiner/Work/Logan2'] },
  },
}

function fakeRun(map) {
  return async (cmd, args, opts) => {
    const key = `${opts.cwd}|${args.join(' ')}`
    if (!(key in map)) return { code: 1, stdout: '', stderr: `unexpected: ${key}` }
    return { code: 0, stdout: map[key], stderr: '' }
  }
}

test('reads branch, dirty count and ahead/behind', async () => {
  const run = fakeRun({
    '/Users/cweiner/Work/PY-1|branch --show-current': 'PY-13888-fix-share-report-basic-admin\n',
    '/Users/cweiner/Work/PY-1|status --porcelain': ' M a.ts\n M b.ts\n',
    '/Users/cweiner/Work/PY-1|rev-list --left-right --count origin/master...HEAD': '13\t6\n',
    '/Users/cweiner/Work/Logan2|branch --show-current': 'PY-13925-Sometimes-in-Logan\n',
    '/Users/cweiner/Work/Logan2|status --porcelain': '',
    '/Users/cweiner/Work/Logan2|rev-list --left-right --count origin/master...HEAD': '2\t1\n',
  })
  const { slots, errors } = await collectSlots(config, { run })
  assert.deepEqual(errors, [])
  assert.deepEqual(slots[0], {
    dir: '/Users/cweiner/Work/PY-1', repo: 'PerformYard/PerformYard',
    branch: 'PY-13888-fix-share-report-basic-admin',
    dirty: true, dirtyCount: 2, behind: 13, ahead: 6,
  })
  assert.equal(slots[1].dirty, false)
  assert.equal(slots[1].dirtyCount, 0)
  assert.equal(slots[1].repo, 'PerformYard/Logan')
})

test('never runs a fetch or any mutating git command', async () => {
  const seen = []
  const run = async (cmd, args) => { seen.push(args[0]); return { code: 0, stdout: '', stderr: '' } }
  await collectSlots(config, { run })
  for (const verb of seen) {
    assert.ok(!['fetch', 'merge', 'checkout', 'pull', 'push', 'rebase'].includes(verb),
      `collect must not run git ${verb}`)
  }
})

test('a broken slot is reported and the others still return', async () => {
  const run = async (cmd, args, opts) => {
    if (opts.cwd.endsWith('PY-1')) return { code: 128, stdout: '', stderr: 'not a git repository' }
    if (args[0] === 'branch') return { code: 0, stdout: 'b\n', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '0\t0\n', stderr: '' }
  }
  const { slots, errors } = await collectSlots(config, { run })
  assert.equal(slots.length, 1)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /PY-1/)
})

test('a detached HEAD yields a null branch, not a crash', async () => {
  const run = async (cmd, args) => {
    if (args[0] === 'branch') return { code: 0, stdout: '\n', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '0\t0\n', stderr: '' }
  }
  const { slots } = await collectSlots({ repos: { 'O/R': { slots: ['/tmp/x'] } } }, { run })
  assert.equal(slots[0].branch, null)
})
