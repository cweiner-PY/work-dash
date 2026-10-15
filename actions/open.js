// actions/open.js
import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { run as defaultRun } from '../util/run.js'
import { resolveSlot, checkoutBranchOf, myPrOfBranch } from './slot.js'
import { checkoutMode, pruneWorktrees } from './worktree.js'

// Single-quote a value for bash: close, escape, reopen.
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

// mergeBase, when given, is the base branch to merge in before Claude starts — the
// "resolve conflicts" action. The merge runs HERE, in the Terminal the user is watching,
// rather than server-side: the output is visible, and /api/open never mutates a checkout
// as an invisible side effect.
export function buildLauncher({ item, branch: target = null, slot, plans, skill, config, mergeBase = null, worktree = null, review = null, naming = null }) {
  // ONE branch of the item — the one the caller resolved. A ticket can carry several, and
  // launching Claude with the wrong one's context is how a session got told it was on the PR's
  // branch while the checkout actually held a different one.
  const branch = checkoutBranchOf(target)

  // Terminal keeps an escape-sequence title in the SAME field as `custom title`, so an agent
  // that names its own window overwrites the name we just gave it — a second or two after the
  // window opens, which is why the title looked right and then changed. Naming a window
  // therefore means asking the agent not to name it. terminalTitleOnly: false is the opt-out,
  // and there it is Claude's ◐ indicator that wins, deliberately.
  const quiet = naming?.title && naming.titleOnly
    ? ['export CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1']
    : []

  const planDirs = [...new Set(plans.map((p) => p.dir))]
  const planFiles = plans.map((p) => `${p.dir}/${p.file}`)
  // Only the user's own PR belongs in the launch context — a colleague's review-requested
  // PR must not be presented to Claude as "the" PR for this ticket.
  const myPr = myPrOfBranch(target)

  // Reviewing someone else's PR is a different job from working your own ticket, so it gets
  // its own context rather than a line appended to the author's one. Stated flatly and up
  // front, because this is the one launch where the wrong assumption edits a colleague's work.
  if (review) {
    const lines = [
      `You are REVIEWING a pull request. You are the reviewer, NOT the author.`,
      `Do not modify, stage, commit, push, revert or rebase anything in this checkout.`,
      `Read the code, form a judgement, and report it. Making changes is out of scope.`,
      `PR #${review.number}${review.author ? ` by ${review.author}` : ''} — ${review.title ?? ''}`.trim(),
      review.url ? `PR: ${review.url}` : null,
      `Repo: ${review.repo}. Branch under review: ${review.headRefName}.`,
      // Detached on purpose, and said so: a commit made by mistake lands on no branch and
      // cannot reach the author's PR without deliberate effort.
      `This checkout is DETACHED at origin/${review.headRefName} — there is no local branch,`,
      `which is intentional: nothing you do here can land on the author's branch.`,
      item.key ? `Related Jira ticket: ${item.key} — ${item.title ?? ''}`.trim() : null,
      item.jira?.url ? `Jira: ${item.jira.url}` : null,
      planFiles.length ? `Reference material: ${planFiles.join(', ')}.` : null,
    ].filter(Boolean).join('\n')

    const claudeReview = [
      'claude', '-n', q(`review-${review.number}`),
      ...planDirs.flatMap((d) => ['--add-dir', q(d)]),
      '--append-system-prompt', q(lines),
      ...(skill ? [q(`/${skill} #${review.number}`)] : []),
    ].join(' ')

    return [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      ...quiet,
      `cd ${q(slot.dir)}`,
      `git fetch origin ${q(review.headRefName)}`,
      `git checkout --detach ${q(`origin/${review.headRefName}`)}`,
      claudeReview,
      '',
    ].join('\n')
  }

  const context = [
    `Active ticket: ${item.key ?? item.id} — ${item.title ?? ''}`.trim(),
    item.jira?.status ? `Jira status: ${item.jira.status}.` : null,
    item.jira?.url ? `Jira: ${item.jira.url}` : null,
    // No branch yet is the normal state for a To Do ticket. Say so plainly, and name the
    // repo from the resolved slot, so Claude does not go hunting for a branch that
    // doesn't exist — /ticket-planner and similar skills exist to run before branching.
    branch ? `Branch: ${branch}` : `No branch yet — this ticket has not been started. Repo: ${slot.repo}.`,
    myPr ? `PR: #${myPr.number} ${myPr.url}` : null,
    planFiles.length ? `Plan files: ${planFiles.join(', ')}. Read them before acting.` : null,
    mergeBase
      ? `origin/${mergeBase} has just been merged into this checkout. Your first ` +
        `instruction states whether that produced conflicts.`
      : null,
  ].filter(Boolean).join('\n')

  // A positional argument is submitted to Claude immediately; without one the session
  // just opens and waits for the user to type. `open` wants that wait. The conflict path
  // does NOT — it exists to get the conflicts resolved, so it hands Claude an instruction
  // the way the run-skill action does. An explicit skill still wins if both are supplied,
  // since a skill is something the user asked for by name.
  const firstPrompt = skill
    ? q(`/${skill} ${item.key ?? ''}`.trim())
    : (mergeBase ? '"$WD_MERGE_PROMPT"' : null)   // set by the if/else below, so it must expand

  const claude = [
    'claude', '-n', q(item.key ?? item.id),
    ...planDirs.flatMap((d) => ['--add-dir', q(d)]),
    '--append-system-prompt', q(context),
    ...(firstPrompt ? [firstPrompt] : []),
  ].join(' ')

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...quiet,
  ]

  // Worktree mode, first launch on this branch: create it here, in the Terminal the user is
  // watching, rather than server-side. Created DETACHED at origin/<ref> on purpose — a
  // branch can only be checked out in one worktree at a time, and detaching sidesteps that
  // entirely, so a launch can never fail because the branch is open somewhere else. The
  // agent creates a local branch if it needs to push.
  if (worktree?.create) {
    lines.push(
      `cd ${q(worktree.root)}`,
      'git fetch origin',
      `git worktree add --detach ${q(slot.dir)} ${q(worktree.base)}`,
      `cd ${q(slot.dir)}`,
    )
  } else {
    lines.push(`cd ${q(slot.dir)}`)
    if (branch && slot.branch !== branch) lines.push(`git checkout ${q(branch)}`)
  }
  if (mergeBase) {
    // The merge decides the instruction. GitHub's DIRTY can be stale, and the conflict may
    // already have been resolved elsewhere, so the clean case has to be handled — telling
    // Claude to resolve conflicts that do not exist sends it hunting through a clean tree.
    //
    // `if git merge` rather than `git merge || ...`: `set -e` is on, and a bare merge that
    // stops on conflicts — the entire point of this path — would kill the script before
    // Claude ever launched. A command in an `if` condition is exempt from `set -e`.
    // Both branches assign WD_MERGE_PROMPT, so `set -u` holds either way.
    const conflicted =
      `The merge of origin/${mergeBase} into this branch stopped with conflicts. ` +
      `Run git status to see which files conflicted, resolve every one of them, then ` +
      `stage and commit the merge.`
    const clean =
      `origin/${mergeBase} merged into this branch cleanly — there are no conflicts to ` +
      `resolve. Confirm with git status and stop; there is nothing else to do here.`
    lines.push(
      `git fetch origin || echo ${q(`>> git fetch failed — origin/${mergeBase} may be stale`)}`,
      `if git merge ${q(`origin/${mergeBase}`)}; then`,
      `  WD_MERGE_PROMPT=${q(clean)}`,
      'else',
      `  WD_MERGE_PROMPT=${q(conflicted)}`,
      'fi',
    )
  }
  lines.push(claude, '')
  return lines.join('\n')
}

// 'tab' opens the session as a tab of the frontmost Terminal window; anything else opens a
// new window. Window is the default: tab needs an Accessibility grant on each machine, and a
// shared tool must not depend on a permission the user has not been asked for.
export function terminalMode(config) {
  return config?.terminalMode === 'tab' ? 'tab' : 'window'
}

// --- naming the window ------------------------------------------------------------------

// Which window is which, answered the way the board answers it: the ticket, what it is, and
// the checkout it landed in. Set terminalTitle to "" to opt out and let Terminal name its
// own windows, as it did before.
export const TITLE_TEMPLATE = '{key} — {title} · {slot}'

// Long enough for a ticket key, a real Jira title and a slot; short enough that the Window
// menu stays readable. Terminal truncates the bar itself, but the menu shows the whole thing.
const MAX_TITLE = 120

// The values a template may name. A review launch describes the PR rather than the ticket:
// that window's whole job IS the PR, and naming it after the Jira key would put a colleague's
// ticket on a window that must never touch the ticket's own branch.
export function titleFields({ item, slot, branch = null, skill = null, review = null }) {
  const folder = slot?.dir ? slot.dir.split('/').pop() : ''
  if (review) {
    return {
      key: `Review #${review.number}`,
      title: review.title ?? '',
      slot: folder,
      repo: review.repo ?? '',
      branch: review.headRefName ?? '',
      skill: skill ?? '',
    }
  }
  return {
    key: item?.key ?? item?.id ?? '',
    title: item?.title ?? '',
    slot: folder,
    repo: item?.repo ?? slot?.repo ?? '',
    branch: checkoutBranchOf(branch) ?? '',
    skill: skill ?? '',
  }
}

// A placeholder owns the literal text in front of it, so resolving to nothing takes that
// text along: "{key} — {title}" on a ticket with no title reads "PY-1", never "PY-1 —".
//
// An unknown {foo} is left in the output verbatim rather than blanked — a typo in a template
// should be visible in the title, not silently eat the separator next to it.
export function renderTitle(template, fields) {
  if (typeof template !== 'string' || template === '') return null
  let out = ''
  let last = 0
  const re = /\{(\w+)\}/g
  let m
  while ((m = re.exec(template)) !== null) {
    const literal = template.slice(last, m.index)
    last = re.lastIndex
    if (!(m[1] in fields)) { out += literal + m[0]; continue }
    const value = String(fields[m[1]] ?? '').replaceAll(/\s+/g, ' ').trim()
    if (value) out += literal + value
  }
  out += template.slice(last)
  // Only the EDGES are stripped of separators. A dash inside a Jira title is part of the
  // title, and collapsing those would rewrite the user's own words back at them.
  out = out.replaceAll(/\s+/g, ' ').replace(/^[\s—–·|,:-]+/, '').replace(/[\s—–·|,:-]+$/, '')
  if (!out) return null
  return out.length > MAX_TITLE ? `${out.slice(0, MAX_TITLE - 1).trimEnd()}…` : out
}

// An AppleScript string literal understands \" and \\ and nothing else — a raw newline in
// one is a syntax error, not an escape — so control characters become spaces rather than
// being escaped. Backslash first: escaping the quotes first would then double their escapes.
export function osaString(s) {
  return `"${String(s)
    .replaceAll(/[\u0000-\u001f\u007f]/g, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')}"`
}

// Terminal composes a title out of several segments, and the default set buries the name we
// chose under a launcher filename and a window size:
//
//   work-dash — ◐ review-7353 — caffeinate • work-dash-PY-12349-cfd02880-…sh — 201×59
//
// Four of them are per-TAB properties, so they are turned off on our own tab and nowhere
// else — the user's profile is never written to, and every other Terminal window they have
// open keeps the title it had. The fifth, the active process name, is not in Terminal's
// AppleScript dictionary at all; `work-dash doctor` names the one-time preference for it.
//
// `title displays file name` is also what carries a title set by an escape sequence, which
// is where Claude Code's ◐ busy indicator lives. Dropping it is the point — it is the noise
// being removed — and terminalTitleOnly: false keeps it for anyone who wants the spinner.
//
// `do script` RETURNS the tab it started in, which is what makes this reliable. Reaching for
// `window 1` instead would be a guess: it is not necessarily the window just created.
function launchLines(path, { title, titleOnly, front = false }) {
  const target = front ? ' in front window' : ''
  if (!title) return [`tell application "Terminal" to do script "bash ${path}"${target}`]
  return [
    'tell application "Terminal"',
    `set wdTab to do script "bash ${path}"${target}`,
    `set custom title of wdTab to ${osaString(title)}`,
    // Without this a profile with "Custom title" unticked accepts the title and never shows it.
    'set title displays custom title of wdTab to true',
    'set title displays window size of wdTab to false',
    'set title displays device name of wdTab to false',
    'set title displays shell path of wdTab to false',
    ...(titleOnly ? ['set title displays file name of wdTab to false'] : []),
    'end tell',
  ]
}

const launchedMessage = (skill, slot) =>
  skill ? `Running /${skill} in ${slot.dir.split('/').pop()}` : `Opened ${slot.dir.split('/').pop()}`

// The failure that matters is the un-granted keystroke, and its message is opaque
// ("osascript is not allowed to send keystrokes. (1002)"), so it gets named.
export function tabHint(stderr) {
  return /not allowed to send keystrokes|1002/.test(String(stderr ?? ''))
    ? 'grant Accessibility to Terminal in System Settings → Privacy & Security → Accessibility'
    : (String(stderr ?? '').trim() || 'the tab attempt failed')
}

// Pure, and exported, so the AppleScript can be asserted without running it — the one thing
// in this file that must never be tested by launching something.
//
// Terminal.app cannot create a tab from its own dictionary (`make new tab` fails with
// -10000), so a tab means sending Cmd+T through System Events and then targeting the front
// window. The delays are unavoidable: the keystroke is asynchronous, and `do script` needs
// the new tab to exist before it can be addressed.
//
// `is running` guards it because Cmd+T against a Terminal that is not running would produce
// an empty window plus a tab. That query does not launch the app.
//
// With no title this returns exactly what it always returned, byte for byte, so a config
// that opts out of naming gets the behaviour it had before naming existed.
export function terminalArgs(path, mode, { title = null, titleOnly = true } = {}) {
  const flags = (lines) => lines.flatMap((line) => ['-e', line])
  if (mode !== 'tab') {
    return flags([
      ...launchLines(path, { title, titleOnly }),
      'tell application "Terminal" to activate',
    ])
  }
  return flags([
    'if application "Terminal" is running then',
    'tell application "Terminal" to activate',
    'delay 0.2',
    'tell application "System Events" to keystroke "t" using command down',
    'delay 0.4',
    ...launchLines(path, { title, titleOnly, front: true }),
    'else',
    ...launchLines(path, { title, titleOnly }),
    'tell application "Terminal" to activate',
    'end if',
  ])
}

// 'warp' launches in Warp; anything else keeps Terminal.app, which is the only app the
// AppleScript below knows how to drive.
export function terminalApp(config) {
  return config?.terminalApp === 'warp' ? 'warp' : 'terminal'
}

// Warp has no AppleScript `do script`, so it is driven through a Launch Configuration: a
// YAML file in its config directory, opened by name with warp://launch/<file>. Each launch
// writes its own, and the command it runs deletes that file first — Warp has read it by
// then — so they do not pile up. Strings go through JSON.stringify, which is a valid YAML
// double-quoted scalar, so a ticket title cannot break out of the document.
//
// cwd is the temp dir rather than the checkout: in worktree mode the checkout does not exist
// until the launcher creates it, and the launcher does its own cd either way.
export function warpLaunchConfig({ name, launcher, self, title = null }) {
  return [
    '---',
    `name: ${JSON.stringify(name)}`,
    'windows:',
    '  - tabs:',
    ...(title ? [`      - title: ${JSON.stringify(title)}`, '        layout:'] : ['      - layout:']),
    `          cwd: ${JSON.stringify(tmpdir())}`,
    '          commands:',
    `            - exec: ${JSON.stringify(`rm -f ${q(self)}; bash ${q(launcher)}`)}`,
    '',
  ].join('\n')
}

export const WARP_LAUNCH_DIR = join(homedir(), '.warp', 'launch_configurations')

async function launchInWarp({ path, naming, config, skill, slot, script }, { run, writeFile, warpDir }) {
  const file = path.split('/').pop().replace(/\.sh$/, '.yaml')
  const self = join(warpDir, file)
  await mkdir(warpDir, { recursive: true })
  await writeFile(self, warpLaunchConfig({ name: file.replace(/\.yaml$/, ''), launcher: path, self, title: naming.title || null }))
  const r = await run('open', [`warp://launch/${encodeURIComponent(file)}`])
  if (r.code !== 0) return { ok: false, message: `Could not open Warp: ${r.stderr.trim()}` }
  // A launch configuration always opens its own window; there is no way to aim it at an
  // existing one, so tab mode is a Terminal-only setting and says so rather than vanishing.
  const note = terminalMode(config) === 'tab' ? ' — in a new Warp window (terminalMode "tab" applies to Terminal only)' : ''
  return { ok: true, message: `${launchedMessage(skill, slot)}${note}`, detail: script, slot: slot.dir }
}

export async function openItem(
  { item, branch = null, slots, plans = [], skill = null, config, chosenSlotDir = null, staleBranches, claimedDirs, repo = null, mergeBase = null, review = null },
  { run = defaultRun, writeFile = fsWriteFile, dry = false, warpDir = WARP_LAUNCH_DIR } = {}
) {
  // Worktree mode accumulates one worktree per branch ever launched on, so old ones are
  // swept on launch — clean and older than the age limit only, never a dirty one. Never in
  // dry mode, and a failure here must not stop the launch it was only tidying up for.
  if (!dry && checkoutMode(config) === 'worktrees') {
    try { await pruneWorktrees(slots, config, { run }) } catch { /* tidying is best-effort */ }
  }

  let slot
  let worktree = null
  if (chosenSlotDir) {
    slot = slots.find((s) => s.dir === chosenSlotDir)
    if (!slot) return { ok: false, message: `Unknown slot: ${chosenSlotDir}` }
    // Resolved against the whole board, so confirm it belongs to this item's repo —
    // otherwise a raw API call could check a branch out in an unrelated repository.
    if (item.repo && slot.repo && slot.repo !== item.repo) {
      return { ok: false, message: `${slot.dir} belongs to ${slot.repo}, not ${item.repo}.` }
    }
    // Explicit choice never overrides the dirty-tree rule. It DOES override a claim,
    // though — the user picking a slot deliberately is a different act from the server
    // guessing one, so claimedDirs is never consulted on this path.
    const looksDirty = slot.dirty !== false || (slot.dirty ?? 0) > 0 || (slot.dirtyCount ?? 0) > 0
    const wanted = review?.headRefName ?? checkoutBranchOf(branch)
    if (looksDirty && slot.branch !== wanted) {
      return { ok: false, message: `${slot.dir} has ${slot.dirtyCount ?? 'an unknown number of'} uncommitted change(s) — commit or stash first.` }
    }
  } else {
    const r = resolveSlot(item, slots, config, {
      staleBranches, claimedDirs, repo,
      // A review needs the AUTHOR's branch, which checkoutBranchOf deliberately refuses to
      // return — a plain open must never redirect onto a colleague's branch.
      branch: review?.headRefName ?? checkoutBranchOf(branch),
    })
    if (r.needsPicker) return { ok: false, message: r.message, candidates: r.candidates, needsRepo: r.needsRepo }
    // Worktree mode can fail for a reason no slot picker can fix — no clone to create the
    // worktree from — so it reports a message rather than a list of candidates.
    if (r.error) return { ok: false, message: r.error }
    slot = r.slot
    worktree = r.create ? { create: true, root: r.root, base: r.base } : null
  }

  // Resolved before the script is built, because the script depends on it: a named window
  // has to tell the agent inside it not to rename it out from under us.
  const naming = {
    title: renderTitle(config?.terminalTitle ?? TITLE_TEMPLATE,
                       titleFields({ item, slot, branch, skill, review })),
    titleOnly: config?.terminalTitleOnly !== false,
  }

  const script = buildLauncher({ item, branch, slot, plans, skill, config, mergeBase, worktree, review, naming })
  // A per-invocation suffix: the old deterministic path meant two opens of the SAME ticket
  // (e.g. a double-click, or /open then /run) raced on writing one file.
  const path = join(tmpdir(), `work-dash-${(item.key ?? item.id).replaceAll(/[^\w.-]/g, '_')}-${randomUUID()}.sh`)

  if (dry) return { ok: true, message: `dry run — would launch in ${slot.dir}`, detail: script, slot: slot.dir }

  // The filename is sanitised above to [\w.-] only, so it cannot contain a quote. Assert
  // that here rather than trusting it from a distance: this string has no escaping of its
  // own, so if the sanitiser is ever loosened, this must fail loudly instead of silently
  // becoming an AppleScript injection point.
  if (/["\\\n]/.test(path)) {
    return { ok: false, message: `Refusing to launch: unsafe launcher path ${path}` }
  }
  await writeFile(path, script, { mode: 0o700 })

  if (terminalApp(config) === 'warp') {
    return launchInWarp({ path, naming, config, skill, slot, script }, { run, writeFile, warpDir })
  }

  // Tab mode first when configured, falling back to a new window. Ordered this way, not
  // guarded by a permission check, because there is no reliable way to ask: reading process
  // names through System Events is allowed while SENDING a keystroke is a separate grant, so
  // the permissive-looking read told us nothing. Attempting it and falling back is the only
  // honest test, and the fallback is exactly today's behaviour.
  let r = null
  if (terminalMode(config) === 'tab') {
    r = await run('osascript', terminalArgs(path, 'tab', naming))
    if (r.code !== 0) {
      // Nothing has launched at this point: both the keystroke and the `do script` come
      // before anything runs, so retrying as a window cannot double-launch.
      const why = r.stderr.trim()
      r = await run('osascript', terminalArgs(path, 'window', naming))
      if (r.code === 0) {
        return {
          ok: true,
          message: `${launchedMessage(skill, slot)} — in a new WINDOW, not a tab: ${tabHint(why)}`,
          detail: script, slot: slot.dir,
        }
      }
    }
  } else {
    r = await run('osascript', terminalArgs(path, 'window', naming))
  }
  if (r.code !== 0) return { ok: false, message: `Could not open Terminal: ${r.stderr.trim()}` }
  return { ok: true, message: launchedMessage(skill, slot), detail: script, slot: slot.dir }
}
