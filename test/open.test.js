// test/open.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildLauncher as rawBuildLauncher, openItem as rawOpenItem, terminalMode, terminalArgs, tabHint,
         terminalApp, warpLaunchConfig,
         renderTitle, titleFields, osaString, TITLE_TEMPLATE } from '../actions/open.js'
import { theBranch } from '../test-support/branches.js'

// Both now act on ONE resolved branch of an item — a ticket can carry several. These tests
// describe their items by PR and checkout, so the branch is resolved here exactly as routes.js
// resolves it: from the item's single branch. A test that means a specific branch of a
// multi-branch item passes `branch` itself and this leaves it alone.
const withBranch = (o) => ('branch' in o ? o : { ...o, branch: theBranch(o.item) })
const buildLauncher = (o) => rawBuildLauncher(withBranch(o))
const openItem = (o, deps) => rawOpenItem(withBranch(o), deps)

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


// --- naming the window ------------------------------------------------------------------
//
// Same rule as the AppleScript above: asserted against the generated strings, never by
// launching. The one exception is the injection canary, which runs osascript on a script
// that only returns a string — it names nothing and opens no Terminal window.

test('the default template names the ticket, what it is, and the checkout', () => {
  const t = renderTitle(TITLE_TEMPLATE, titleFields({ item, slot: slotA }))
  assert.equal(t, 'PY-12746 — Competency Catalog · A')
})

test('an empty placeholder takes its separator with it', () => {
  // "PY-12746 —  · A" is the bug this rule exists to prevent: a ticket with no title must
  // not leave the punctuation that was there to separate it from something.
  const untitled = { ...item, title: null }
  assert.equal(renderTitle(TITLE_TEMPLATE, titleFields({ item: untitled, slot: slotA })),
    'PY-12746 · A')
  // Dropped at the FRONT, too — nothing may start with a dangling separator.
  assert.equal(renderTitle('{title} — {key}', titleFields({ item: untitled, slot: slotA })),
    'PY-12746')
  // Everything empty is no title at all, not a string of punctuation.
  assert.equal(renderTitle('{branch} — {skill}', titleFields({ item: untitled, slot: slotA })), null)
})

test('a separator INSIDE a value survives — a title is the user\'s own words', () => {
  const dashed = { ...item, title: 'Catalog – phase two' }
  assert.match(renderTitle(TITLE_TEMPLATE, titleFields({ item: dashed, slot: slotA })),
    /Catalog – phase two/)
})

test('an unknown placeholder is left visible rather than silently blanked', () => {
  // A typo in a template should show up in the title, where it can be noticed and fixed.
  assert.equal(renderTitle('{key} {nope}', titleFields({ item, slot: slotA })), 'PY-12746 {nope}')
})

test('an empty template opts out entirely, and so does a non-string', () => {
  for (const bad of ['', null, undefined, 5, {}]) assert.equal(renderTitle(bad, {}), null)
})

test('a very long title is truncated, so the Window menu stays readable', () => {
  const long = { ...item, title: 'x'.repeat(400) }
  const t = renderTitle(TITLE_TEMPLATE, titleFields({ item: long, slot: slotA }))
  assert.ok(t.length <= 120, `${t.length} > 120`)
  assert.match(t, /…$/)
  assert.match(t, /^PY-12746 — x+/)
})

test('a newline in a Jira title becomes a space, not two lines', () => {
  const multi = { ...item, title: 'Catalog\n\tphase two' }
  assert.equal(renderTitle('{title}', titleFields({ item: multi, slot: slotA })), 'Catalog phase two')
})

test('titleFields describes the PR on a review launch, never the ticket', () => {
  // The window's whole job is a colleague's PR. Naming it after the Jira key would put a
  // ticket on a window that must never touch that ticket's own branch.
  const review = { number: 7353, title: 'Fix flaky sprint sync', repo: 'O/R', headRefName: 'bruce-branch' }
  const f = titleFields({ item, slot: slotA, review })
  assert.equal(f.key, 'Review #7353')
  assert.equal(f.title, 'Fix flaky sprint sync')
  assert.equal(f.branch, 'bruce-branch')
  assert.equal(renderTitle(TITLE_TEMPLATE, f), 'Review #7353 — Fix flaky sprint sync · A')
})

test('titleFields exposes repo, branch and skill for anyone who wants them', () => {
  const f = titleFields({ item, slot: slotA, branch: theBranch(item), skill: 'ticket-finisher' })
  assert.equal(f.repo, 'O/R')
  assert.equal(f.branch, 'PY-12746-competency')
  assert.equal(f.skill, 'ticket-finisher')
  assert.equal(f.slot, 'A')
  assert.equal(renderTitle('/{skill} — {key} · {slot}', f), '/ticket-finisher — PY-12746 · A')
})

test('a named window sets the custom title AND turns the display on', () => {
  // A profile with "Custom title" unticked accepts the title and never shows it, so the
  // toggle is not optional.
  const script = terminalArgs('/tmp/x.sh', 'window', { title: 'PY-1 — Thing' }).join('\n')
  assert.match(script, /set wdTab to do script "bash \/tmp\/x\.sh"/)
  assert.match(script, /set custom title of wdTab to "PY-1 — Thing"/)
  assert.match(script, /set title displays custom title of wdTab to true/)
})

test('a named window suppresses every segment Terminal exposes per-tab', () => {
  const script = terminalArgs('/tmp/x.sh', 'window', { title: 'T' }).join('\n')
  for (const seg of ['window size', 'device name', 'shell path', 'file name']) {
    assert.match(script, new RegExp(`set title displays ${seg} of wdTab to false`), seg)
  }
})

test('terminalTitleOnly: false keeps the title a program sets for itself', () => {
  // `title displays file name` is what carries an escape-sequence title — where Claude
  // Code's busy indicator lives. Keeping it is the whole point of the opt-out.
  const script = terminalArgs('/tmp/x.sh', 'window', { title: 'T', titleOnly: false }).join('\n')
  assert.ok(!/title displays file name/.test(script))
  assert.match(script, /set title displays window size of wdTab to false/)
  assert.match(script, /set custom title of wdTab to "T"/)
})

test('tab mode names the tab it created, in BOTH branches', () => {
  // The not-running branch opens a window instead, and it must be named too — otherwise the
  // first launch after a reboot is the one window that comes out anonymous.
  const args = terminalArgs('/tmp/x.sh', 'tab', { title: 'T' })
  const script = args.join('\n')
  assert.match(script, /set wdTab to do script "bash \/tmp\/x\.sh" in front window/)
  assert.equal(script.match(/set custom title of wdTab to "T"/g).length, 2)
  const tail = args.slice(args.indexOf('else')).join('\n')
  assert.match(tail, /set custom title of wdTab to "T"/)
  assert.ok(!/keystroke/.test(tail))
})

test('with no title the AppleScript is byte-identical to what it always was', () => {
  // Opting out must give back exactly the old behaviour, not a near-miss of it.
  assert.deepEqual(terminalArgs('/tmp/x.sh', 'window'), [
    '-e', 'tell application "Terminal" to do script "bash /tmp/x.sh"',
    '-e', 'tell application "Terminal" to activate',
  ])
  assert.deepEqual(terminalArgs('/tmp/x.sh', 'window', { title: null }),
    terminalArgs('/tmp/x.sh', 'window'))
})

test('osaString escapes the two characters an AppleScript literal understands', () => {
  assert.equal(osaString('plain'), '"plain"')
  assert.equal(osaString('say "hi"'), String.raw`"say \"hi\""`)
  assert.equal(osaString('back\\slash'), String.raw`"back\\slash"`)
  // Control characters cannot be escaped inside a literal at all, so they become spaces.
  assert.equal(osaString('a\nb\tc'), '"a b c"')
})

test('a title with AppleScript metacharacters cannot become a second statement', async () => {
  // The analogue of the bash injection canary above, and asserted the same way: by RUNNING
  // the thing that decides. The payload opens with a quote to close the literal osaString
  // wraps it in, then concatenates a `do shell script` — the shape that breaks out of a
  // naive `"${s}"`. Verified to have teeth: with a naive quoter this canary IS created.
  //
  // The script evaluated here only RETURNS a string. It names no application and opens no
  // window, so this stays inside the rule that Terminal is never launched by a test.
  const canary = join(tmpdir(), `work-dash-osa-canary-${randomUUID()}`)
  const nasty = `PY-1" & (do shell script "touch ${canary}") & "`
  const r = await new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', `return ${osaString(nasty)}`])
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, out: out.trimEnd() }))
  })
  assert.equal(existsSync(canary), false, 'the injected command must never execute')
  assert.equal(r.code, 0, 'the generated literal must still be valid AppleScript')
  assert.equal(r.out, nasty, 'and must round-trip the payload as ONE plain string')
  if (existsSync(canary)) rmSync(canary)
})

test('openItem names the window from the slot it actually resolved', async () => {
  let args = null
  const r = await openItem({ item, slots: [slotA], plans, skill: null, config },
    { run: async (_cmd, a) => { args = a; return { code: 0, stdout: '', stderr: '' } },
      writeFile: async () => {} })
  assert.equal(r.ok, true)
  assert.match(args.join('\n'), /set custom title of wdTab to "PY-12746 — Competency Catalog · A"/)
})

test('a tab that falls back to a window does not lose its name on the way', async () => {
  const seen = []
  await openItem(
    { item, slots: [slotA], plans, config: { ...config, terminalMode: 'tab' },
      staleBranches: new Set(), claimedDirs: new Set() },
    { run: async (_cmd, a) => {
        const tab = a.some((x) => /keystroke/.test(String(x)))
        seen.push([tab ? 'tab' : 'window', a.join('\n')])
        return tab ? { code: 1, stdout: '', stderr: '1002' } : { code: 0, stdout: '', stderr: '' }
      },
      writeFile: async () => {} })
  assert.equal(seen.length, 2)
  for (const [mode, script] of seen) {
    assert.match(script, /set custom title of wdTab to "PY-12746 — Competency Catalog · A"/, mode)
  }
})

test('terminalTitle: "" opts out, and the launch still happens', async () => {
  let args = null
  const r = await openItem(
    { item, slots: [slotA], plans, skill: null, config: { ...config, terminalTitle: '' } },
    { run: async (_cmd, a) => { args = a; return { code: 0, stdout: '', stderr: '' } },
      writeFile: async () => {} })
  assert.equal(r.ok, true)
  assert.ok(!/custom title/.test(args.join('\n')))
  assert.deepEqual(args, terminalArgs(args[1].match(/bash (\S+)"/)[1], 'window'))
})

test('a custom template is used verbatim', async () => {
  let args = null
  await openItem(
    { item, slots: [slotA], plans, skill: null,
      config: { ...config, terminalTitle: '{slot}: {key} [{branch}]' } },
    { run: async (_cmd, a) => { args = a; return { code: 0, stdout: '', stderr: '' } },
      writeFile: async () => {} })
  assert.match(args.join('\n'), /set custom title of wdTab to "A: PY-12746 \[PY-12746-competency\]"/)
})


// --- the agent must not rename the window we just named ---------------------------------
//
// The defect these cover shipped and was seen: the title was correct for about a second and
// then became Claude's own. Terminal keeps an escape-sequence title in the same field as
// `custom title`, so whoever writes last wins, and the agent writes continuously.

test('a named launch tells the agent not to set the terminal title', () => {
  const s = buildLauncher({ item, slot: slotA, plans, skill: null, config,
                            naming: { title: 'PY-12746 — Thing · A', titleOnly: true } })
  assert.match(s, /^export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1$/m)
  // Before the agent starts, or it would already have set one.
  assert.ok(s.indexOf('CLAUDE_CODE_DISABLE_TERMINAL_TITLE') < s.indexOf('claude -n'))
})

test('the review launch is named too, so it gets the same line', () => {
  const review = { number: 7353, title: 'Fix it', repo: 'O/R', headRefName: 'their-branch' }
  const s = buildLauncher({ item, slot: slotA, plans, skill: null, config, review,
                            naming: { title: 'Review #7353 — Fix it · A', titleOnly: true } })
  assert.match(s, /^export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1$/m)
  assert.ok(s.indexOf('CLAUDE_CODE_DISABLE_TERMINAL_TITLE') < s.indexOf('claude -n'))
})

test('an unnamed launch leaves the agent\'s own title alone', () => {
  // terminalTitle: "" wants Terminal's behaviour back, and that includes Claude's title.
  for (const naming of [null, { title: null, titleOnly: true }]) {
    const s = buildLauncher({ item, slot: slotA, plans, skill: null, config, naming })
    assert.ok(!/CLAUDE_CODE_DISABLE_TERMINAL_TITLE/.test(s), JSON.stringify(naming))
  }
})

test('terminalTitleOnly: false keeps the agent\'s ◐ indicator, and lets it win', () => {
  // The opt-out is coherent both ways: it keeps the segment Terminal would show AND stops
  // us from silencing the thing that writes into it.
  const s = buildLauncher({ item, slot: slotA, plans, skill: null, config,
                            naming: { title: 'T', titleOnly: false } })
  assert.ok(!/CLAUDE_CODE_DISABLE_TERMINAL_TITLE/.test(s))
})

test('openItem names the window and silences the agent in the SAME launch', async () => {
  // The two halves have to agree: naming the window without this line is the bug, and the
  // line without a name would suppress a title for no reason.
  let script = null, args = null
  await openItem({ item, slots: [slotA], plans, skill: null, config },
    { run: async (_c, a) => { args = a; return { code: 0, stdout: '', stderr: '' } },
      writeFile: async (_p, c) => { script = c } })
  assert.match(script, /export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1/)
  assert.match(args.join('\n'), /set custom title of wdTab to "PY-12746 — Competency Catalog · A"/)
})

test('openItem opts out of both halves together', async () => {
  let script = null, args = null
  await openItem({ item, slots: [slotA], plans, skill: null, config: { ...config, terminalTitle: '' } },
    { run: async (_c, a) => { args = a; return { code: 0, stdout: '', stderr: '' } },
      writeFile: async (_p, c) => { script = c } })
  assert.ok(!/CLAUDE_CODE_DISABLE_TERMINAL_TITLE/.test(script))
  assert.ok(!/custom title/.test(args.join('\n')))
})

test('the launcher still runs correctly with the export in it', async () => {
  // Executed, not matched: `set -u` plus an export is exactly the shape that has broken this
  // script before, and the merge path reads a variable the export sits next to.
  const s = buildLauncher({ item, slot: slotA, plans, skill: null, config, mergeBase: 'master',
                            naming: { title: 'T', titleOnly: true } })
  const { code, log } = await runLauncher(s, { mergeExit: 1 })
  assert.equal(code, 0)
  assert.match(lastPrompt(log), /stopped with conflicts/)
})

test('terminalApp defaults to Terminal, and only the exact string "warp" opts in', () => {
  assert.equal(terminalApp({}), 'terminal')
  assert.equal(terminalApp(undefined), 'terminal')
  assert.equal(terminalApp({ terminalApp: 'warp' }), 'warp')
  for (const bad of ['Warp', 'WARP', 'iterm', '', null, true]) {
    assert.equal(terminalApp({ terminalApp: bad }), 'terminal', JSON.stringify(bad))
  }
})

test('the Warp launch config runs the launcher and deletes itself first', () => {
  const yaml = warpLaunchConfig({ name: 'n', launcher: '/tmp/x.sh', self: '/w/n.yaml', title: 'T' })
  assert.match(yaml, /exec: "rm -f '\/w\/n.yaml'; bash '\/tmp\/x.sh'"/)
  assert.match(yaml, /- title: "T"/)
})

test('a hostile title cannot break out of the Warp YAML', () => {
  const yaml = warpLaunchConfig({ name: 'n', launcher: '/tmp/x.sh', self: '/w/n.yaml', title: 'a"\nexec: rm -rf ~' })
  const titleLines = yaml.split('\n').filter((l) => /rm -rf/.test(l))
  assert.equal(titleLines.length, 1, 'the newline stays escaped inside one scalar')
  assert.match(titleLines[0], /^ {6}- title: "/)
})

test('no title leaves the Warp tab unnamed', () => {
  const yaml = warpLaunchConfig({ name: 'n', launcher: '/tmp/x.sh', self: '/w/n.yaml' })
  assert.ok(!/title:/.test(yaml))
  assert.match(yaml, /- layout:/)
})

test('warp mode writes a launch config and opens it — no osascript', async () => {
  const calls = []
  const written = {}
  const warpDir = join(tmpdir(), `wd-warp-${randomUUID()}`)
  try {
    const r = await openItem(
      { item, slots: [slotA], plans, config: { ...config, terminalApp: 'warp', terminalMode: 'tab' },
        staleBranches: new Set(), claimedDirs: new Set() },
      { run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' } },
        writeFile: async (p, c) => { written[p] = c },
        warpDir })
    assert.equal(r.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], 'open')
    const file = calls[0][1].replace('warp://launch/', '')
    assert.ok(written[join(warpDir, decodeURIComponent(file))], 'opens the file it wrote')
    assert.match(r.message, /Terminal only/, 'tab mode says it does not apply')
  } finally { rmSync(warpDir, { recursive: true, force: true }) }
})
