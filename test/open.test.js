// test/open.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildLauncher, openItem, terminalMode, terminalArgs, tabHint } from '../actions/open.js'

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

test('a branchless item with a supplied repo resolves a clean slot, and the launcher has no git checkout', async () => {
  const branchless = { ...item, repo: null, prs: [] }
  const r = await openItem({ item: branchless, slots: [slotA], plans, skill: null, config, repo: 'O/R' },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
  assert.equal(r.ok, true)
  assert.equal(r.slot, '/w/A')
  assert.ok(!/git checkout/.test(r.detail), 'a To Do ticket with no branch must never emit a checkout')
})

test('buildLauncher tells Claude plainly there is no branch yet, and names the repo', () => {
  const branchless = { ...item, repo: null, prs: [] }
  const s = buildLauncher({ item: branchless, slot: slotA, plans, skill: null, config })
  assert.match(s, /no branch yet/i)
  assert.match(s, /Repo: O\/R/)
  assert.ok(!/git checkout/.test(s))
})

test('a branchless item with no repo at all, and none supplied, returns a picker asking for the repo', async () => {
  const branchless = { ...item, repo: null, prs: [] }
  const r = await openItem({ item: branchless, slots: [slotA], plans, skill: null, config },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
  assert.equal(r.ok, false)
  assert.equal(r.needsRepo, true)
  assert.match(r.message, /repositor/i)
})

test('a branchless item still never auto-selects a dirty or claimed slot', async () => {
  const branchless = { ...item, repo: null, prs: [] }
  const dirty = { ...slotA, dirty: true, dirtyCount: 2 }
  const r1 = await openItem({ item: branchless, slots: [dirty], plans, skill: null, config, repo: 'O/R' },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
  assert.equal(r1.ok, false)

  const other = { ...slotA, dir: '/w/OTHER' }
  const r2 = await openItem(
    { item: branchless, slots: [other], plans, skill: null, config, repo: 'O/R', claimedDirs: new Set(['/w/OTHER']) },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }), writeFile: async () => {}, dry: true })
  assert.equal(r2.ok, false)
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


// --- the "resolve conflicts" path: a launch that starts the merge in the checkout ------
//
// These run the generated script through bash with cd/git/claude stubbed, rather than
// matching regexes against it. The bug this path shipped with was not a wrong string: the
// script was correct and still did the wrong thing, because it put the conflict in
// --append-system-prompt (context) and passed Claude no instruction, so the session just
// sat there. Only executing it shows what Claude actually receives.

async function runLauncher(script, { mergeExit = 0 } = {}) {
  const out = join(tmpdir(), `work-dash-probe-${randomUUID()}`)
  const probe = [
    'cd() { :; }',
    `git() { printf 'GIT:%s\n' "$@" >> ${out}; if [ "$1" = merge ]; then return ${mergeExit}; fi; return 0; }`,
    `claude() { printf 'CLAUDE_LAST:%s\n' "\${!#}" >> ${out}; }`,
    script.split('\n').slice(1).join('\n'),   // drop the shebang; bash -c supplies the shell
  ].join('\n')
  const code = await new Promise((resolve, reject) => {
    const p = spawn('bash', ['-c', probe])
    p.on('error', reject)
    p.on('close', resolve)
  })
  const log = existsSync(out) ? readFileSync(out, 'utf8') : ''
  if (existsSync(out)) rmSync(out)
  return { code, log }
}
const lastPrompt = (log) => (log.match(/^CLAUDE_LAST:(.*)$/m) ?? [])[1] ?? null

test('a conflicting merge hands Claude an instruction to resolve it', async () => {
  // The actual defect: the merge ran, Claude opened, and nothing told it to do anything.
  const script = buildLauncher({ item, slot: slotA, plans, skill: null, config, mergeBase: 'master' })
  const { code, log } = await runLauncher(script, { mergeExit: 1 })
  assert.equal(code, 0, 'set -e must not kill the script when the merge conflicts')
  const prompt = lastPrompt(log)
  assert.ok(prompt, 'claude must be given a first instruction, not left waiting')
  assert.match(prompt, /stopped with conflicts/)
  assert.match(prompt, /resolve/i)
  assert.match(prompt, /commit/i)
})

test('a clean merge does NOT send Claude hunting for conflicts', async () => {
  // GitHub's DIRTY can be stale, and the conflict may already have been resolved
  // elsewhere. A single unconditional "resolve the conflicts" prompt would be a lie here.
  const script = buildLauncher({ item, slot: slotA, plans, skill: null, config, mergeBase: 'master' })
  const { code, log } = await runLauncher(script, { mergeExit: 0 })
  assert.equal(code, 0)
  const prompt = lastPrompt(log)
  assert.match(prompt, /cleanly/)
  assert.match(prompt, /no conflicts/)
  assert.ok(!/stopped with conflicts/.test(prompt))
})

test('the merge runs after the checkout and before claude', async () => {
  const script = buildLauncher({ item, slot: slotA, plans, skill: null, config, mergeBase: 'master' })
  const { log } = await runLauncher(script, { mergeExit: 1 })
  const order = log.split('\n').filter(Boolean)
  const at = (re) => order.findIndex((l) => re.test(l))
  assert.ok(at(/^GIT:checkout$/) < at(/^GIT:fetch$/), 'checkout before fetch')
  assert.ok(at(/^GIT:fetch$/) < at(/^GIT:merge$/), 'fetch before merge')
  assert.ok(at(/^GIT:merge$/) < at(/^CLAUDE_LAST:/), 'merge before claude')
})

test('an explicit skill wins over the merge prompt', async () => {
  // Both can arrive on one request. A skill is something the user asked for by name, so it
  // takes the single positional slot; passing two prompts would submit two.
  const script = buildLauncher({ item, slot: slotA, plans, skill: 'critical-review', config, mergeBase: 'master' })
  const { log } = await runLauncher(script, { mergeExit: 1 })
  assert.equal(lastPrompt(log), '/critical-review PY-12746')
  assert.match(log, /^GIT:merge$/m, 'the merge still happens')
})

test('without mergeBase nothing is merged and Claude is left waiting, as open always did', async () => {
  const script = buildLauncher({ item, slot: slotA, plans, skill: null, config })
  const { code, log } = await runLauncher(script)
  assert.equal(code, 0)
  assert.ok(!/^GIT:merge$/m.test(log), 'a plain open must not merge')
  assert.ok(!/^GIT:fetch$/m.test(log), 'nor fetch')
  // The last argument is the system prompt, so no instruction was submitted.
  assert.match(lastPrompt(log), /Active ticket/)
})

test('mergeBase names the base branch in the launch context', () => {
  const s = buildLauncher({ item, slot: slotA, plans, skill: null, config, mergeBase: 'master' })
  assert.match(s, /origin\/master has just been merged into this checkout/)
})

test('a base branch with shell metacharacters cannot become a second command', async () => {
  // Asserted by RUNNING the script rather than by matching a regex: a regex only proves
  // the string looks quoted, while bash is the thing that decides. The payload OPENS with
  // a quote so it closes the one q() wraps around it — the shape that breaks out of a
  // naive `'${s}'`. Verified to have teeth: with a naive q() this canary IS created.
  const canary = join(tmpdir(), `work-dash-injection-canary-${randomUUID()}`)
  const script = buildLauncher({
    item, slot: slotA, plans, skill: null, config,
    mergeBase: `master'; touch ${canary}; echo '`,
  })
  const { log } = await runLauncher(script, { mergeExit: 0 })

  assert.equal(existsSync(canary), false, 'the injected command must never execute')
  // git received the whole payload as ONE argument, metacharacters and all.
  assert.match(log, /^GIT:origin\/master'; touch .*; echo '$/m)
  if (existsSync(canary)) rmSync(canary)
})

test('openItem passes mergeBase through to the launcher', async () => {
  let script = null
  const r = await openItem(
    { item, slots: [slotA], plans, config, staleBranches: new Set(), claimedDirs: new Set(),
      mergeBase: 'master' },
    { run: async () => ({ code: 0, stdout: '', stderr: '' }),
      writeFile: async (_p, c) => { script = c } })
  assert.equal(r.ok, true, r.message)
  assert.match(script, /git merge 'origin\/master'/)
})


// --- terminal mode: a new window, or a tab of the front window -------------------------
//
// Asserted against the generated AppleScript, never by launching. Testing this by opening
// terminals leaves windows on the user's screen, which is how NOT to answer the question.

test('terminalMode defaults to window, and only the exact string "tab" opts in', () => {
  // A shared tool must not silently depend on an Accessibility grant nobody was asked for.
  assert.equal(terminalMode({}), 'window')
  assert.equal(terminalMode(undefined), 'window')
  assert.equal(terminalMode({ terminalMode: 'tab' }), 'tab')
  for (const bad of ['Tab', 'TAB', 'tabs', 'window', '', null, true, 1]) {
    assert.equal(terminalMode({ terminalMode: bad }), 'window', JSON.stringify(bad))
  }
})

test('window mode is exactly the old two-statement script', () => {
  const args = terminalArgs('/tmp/x.sh', 'window')
  assert.deepEqual(args, [
    '-e', 'tell application "Terminal" to do script "bash /tmp/x.sh"',
    '-e', 'tell application "Terminal" to activate',
  ])
})

test('tab mode sends Cmd+T and then targets the FRONT window', () => {
  // Terminal cannot make a tab from its own dictionary (`make new tab` -> -10000), so the
  // keystroke is the only route, and `do script ... in front window` lands in the new tab.
  const script = terminalArgs('/tmp/x.sh', 'tab').join(' ')
  assert.match(script, /keystroke "t" using command down/)
  assert.match(script, /do script "bash \/tmp\/x.sh" in front window/)
})

test('tab mode guards on Terminal already running', () => {
  // Cmd+T against a Terminal that is not running would leave an empty window plus a tab.
  const args = terminalArgs('/tmp/x.sh', 'tab')
  assert.equal(args[1], 'if application "Terminal" is running then')
  assert.ok(args.includes('else'), 'and has a not-running branch')
  assert.ok(args.includes('end if'))
  // The not-running branch opens a plain window, with no keystroke in it.
  const elseIdx = args.indexOf('else')
  const tail = args.slice(elseIdx).join(' ')
  assert.match(tail, /do script "bash \/tmp\/x.sh"/)
  assert.ok(!/keystroke/.test(tail))
})

test('tab mode keeps the delays the keystroke needs', () => {
  // The keystroke is asynchronous and `do script` needs the tab to exist first. Without
  // these the command lands in the wrong tab, or nowhere.
  const args = terminalArgs('/tmp/x.sh', 'tab')
  assert.ok(args.filter((a) => /^delay /.test(a)).length >= 2)
})

test('tabHint names the Accessibility grant for the opaque keystroke error', () => {
  assert.match(tabHint('osascript is not allowed to send keystrokes. (1002)'), /Accessibility/)
  assert.match(tabHint('System Events got an error: 1002'), /Accessibility/)
  // Anything else is passed through rather than mislabelled as a permissions problem.
  assert.equal(tabHint('some other failure'), 'some other failure')
  assert.equal(tabHint(''), 'the tab attempt failed')
  assert.equal(tabHint(undefined), 'the tab attempt failed')
})

test('a refused tab falls back to a window, and SAYS it did', async () => {
  // The user must not be left wondering why they got a window, nor left with nothing.
  const calls = []
  const r = await openItem(
    { item, slots: [slotA], plans, config: { ...config, terminalMode: 'tab' },
      staleBranches: new Set(), claimedDirs: new Set() },
    { run: async (cmd, args) => {
        const tab = args.some((a) => /keystroke/.test(String(a)))
        calls.push(tab ? 'tab' : 'window')
        return tab
          ? { code: 1, stdout: '', stderr: 'osascript is not allowed to send keystrokes. (1002)' }
          : { code: 0, stdout: '', stderr: '' }
      },
      writeFile: async () => {} })
  assert.equal(r.ok, true, 'a refused tab must still launch')
  assert.deepEqual(calls, ['tab', 'window'], 'tab attempted first, window as the fallback')
  assert.match(r.message, /new WINDOW, not a tab/)
  assert.match(r.message, /Accessibility/)
})

test('a successful tab does not also open a window', async () => {
  const calls = []
  const r = await openItem(
    { item, slots: [slotA], plans, config: { ...config, terminalMode: 'tab' },
      staleBranches: new Set(), claimedDirs: new Set() },
    { run: async (cmd, args) => {
        calls.push(args.some((a) => /keystroke/.test(String(a))) ? 'tab' : 'window')
        return { code: 0, stdout: '', stderr: '' }
      },
      writeFile: async () => {} })
  assert.equal(r.ok, true)
  assert.deepEqual(calls, ['tab'], 'exactly one launch')
  assert.ok(!/WINDOW/.test(r.message))
})

test('window mode never attempts a keystroke at all', async () => {
  const calls = []
  await openItem(
    { item, slots: [slotA], plans, config, staleBranches: new Set(), claimedDirs: new Set() },
    { run: async (cmd, args) => {
        calls.push(args.some((a) => /keystroke/.test(String(a))) ? 'tab' : 'window')
        return { code: 0, stdout: '', stderr: '' }
      },
      writeFile: async () => {} })
  assert.deepEqual(calls, ['window'])
})

test('both modes fail loudly when Terminal cannot be driven at all', async () => {
  for (const terminalMode of ['window', 'tab']) {
    const r = await openItem(
      { item, slots: [slotA], plans, config: { ...config, terminalMode },
        staleBranches: new Set(), claimedDirs: new Set() },
      { run: async () => ({ code: 1, stdout: '', stderr: 'no Terminal' }), writeFile: async () => {} })
    assert.equal(r.ok, false, terminalMode)
    assert.match(r.message, /Could not open Terminal/)
  }
})
