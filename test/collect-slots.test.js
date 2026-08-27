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
  // stat is injected, so this asserts on the collector rather than on whether the fixture
  // paths happen to exist on the machine running the suite.
  const { slots, errors } = await collectSlots(config, { run, stat: async () => ({ mtimeMs: 1000 }) })
  assert.deepEqual(errors, [])
  assert.deepEqual(slots[0], {
    dir: '/Users/cweiner/Work/PY-1', repo: 'PerformYard/PerformYard',
    branch: 'PY-13888-fix-share-report-basic-admin',
    dirty: true, dirtyCount: 2, behind: 13, ahead: 6, mtimeMs: 1000,
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

test('a rev-list failure keeps the slot and preserves the dirty flag', async () => {
  // The dirty flag is safety information. A missing origin/<default> must not erase it.
  const run = async (cmd, args) => {
    if (args[0] === 'branch') return { code: 0, stdout: 'PY-13888-fix\n', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: ' M a.ts\n M b.ts\n', stderr: '' }
    return { code: 128, stdout: '', stderr: "fatal: ambiguous argument 'origin/master'" }
  }
  const { slots, errors } = await collectSlots({ repos: { 'O/R': { slots: ['/w/PY-1'] } } }, { run })
  assert.equal(slots.length, 1, 'the slot must survive')
  assert.equal(slots[0].dirty, true)
  assert.equal(slots[0].dirtyCount, 2)
  assert.equal(slots[0].branch, 'PY-13888-fix')
  assert.equal(slots[0].behind, null, 'unknown, not 0 — 0 would falsely mean up to date')
  assert.equal(slots[0].ahead, null)
  assert.equal(errors.length, 1)
})

test('the comparison base honours a repo whose default branch is not master', async () => {
  const seen = []
  const run = async (cmd, args) => {
    seen.push(args.join(' '))
    if (args[0] === 'branch') return { code: 0, stdout: 'feature\n', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '1\t2\n', stderr: '' }
  }
  await collectSlots({ repos: { 'O/QA': { defaultBranch: 'main', slots: ['/w/QA'] } } }, { run })
  assert.ok(seen.some((c) => c.includes('origin/main...HEAD')), seen.join(' | '))
  assert.ok(!seen.some((c) => c.includes('origin/master')), 'must not fall back to master')
})

test('short rev-list output leaves behind/ahead null rather than undefined', async () => {
  const run = async (cmd, args) => {
    if (args[0] === 'branch') return { code: 0, stdout: 'b\n', stderr: '' }
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '\n', stderr: '' }
  }
  const { slots } = await collectSlots({ repos: { 'O/R': { slots: ['/w/x'] } } }, { run })
  assert.equal(slots[0].behind, null)
  assert.equal(slots[0].ahead, null)
  assert.ok('ahead' in slots[0], 'the key must exist so JSON.stringify keeps it')
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


test('a slot survives stat failing — mtime only gates pruning', async () => {
  const run = fakeRun({
    '/Users/cweiner/Work/PY-1|branch --show-current': 'b\n',
    '/Users/cweiner/Work/PY-1|status --porcelain': '',
    '/Users/cweiner/Work/PY-1|rev-list --left-right --count origin/master...HEAD': '0\t0\n',
    '/Users/cweiner/Work/Logan2|branch --show-current': 'c\n',
    '/Users/cweiner/Work/Logan2|status --porcelain': '',
    '/Users/cweiner/Work/Logan2|rev-list --left-right --count origin/master...HEAD': '0\t0\n',
  })
  const { slots, errors } = await collectSlots(config, {
    run, stat: async () => { throw new Error('ENOENT') },
  })
  assert.equal(slots.length, 2, 'the slots must still be reported')
  assert.equal(slots[0].mtimeMs, null)
  assert.deepEqual(errors, [], 'an unstattable directory is not a collection error')
})
