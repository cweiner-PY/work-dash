// actions/open.js
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { run as defaultRun } from '../util/run.js'
import { resolveSlot, branchFor } from './slot.js'
import { checkoutMode, pruneWorktrees } from './worktree.js'
import { myPrOf } from '../lanes.js'

// Single-quote a value for bash: close, escape, reopen.
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

// mergeBase, when given, is the base branch to merge in before Claude starts — the
// "resolve conflicts" action. The merge runs HERE, in the Terminal the user is watching,
// rather than server-side: the output is visible, and /api/open never mutates a checkout
// as an invisible side effect.
export function buildLauncher({ item, slot, plans, skill, config, mergeBase = null, worktree = null }) {
  const branch = branchFor(item)
  const planDirs = [...new Set(plans.map((p) => p.dir))]
  const planFiles = plans.map((p) => `${p.dir}/${p.file}`)
  // Only the user's own PR belongs in the launch context — a colleague's review-requested
  // PR must not be presented to Claude as "the" PR for this ticket.
  const myPr = myPrOf(item)

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
export function terminalArgs(path, mode) {
  if (mode !== 'tab') {
    return ['-e', `tell application "Terminal" to do script "bash ${path}"`,
            '-e', 'tell application "Terminal" to activate']
  }
  return ['-e', 'if application "Terminal" is running then',
          '-e', 'tell application "Terminal" to activate',
          '-e', 'delay 0.2',
          '-e', 'tell application "System Events" to keystroke "t" using command down',
          '-e', 'delay 0.4',
          '-e', `tell application "Terminal" to do script "bash ${path}" in front window`,
          '-e', 'else',
          '-e', `tell application "Terminal" to do script "bash ${path}"`,
          '-e', 'tell application "Terminal" to activate',
          '-e', 'end if']
}

export async function openItem(
  { item, slots, plans = [], skill = null, config, chosenSlotDir = null, staleBranches, claimedDirs, repo = null, mergeBase = null },
  { run = defaultRun, writeFile = fsWriteFile, dry = false } = {}
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
    if (looksDirty && slot.branch !== branchFor(item)) {
      return { ok: false, message: `${slot.dir} has ${slot.dirtyCount ?? 'an unknown number of'} uncommitted change(s) — commit or stash first.` }
    }
  } else {
    const r = resolveSlot(item, slots, config, { staleBranches, claimedDirs, repo })
    if (r.needsPicker) return { ok: false, message: r.message, candidates: r.candidates, needsRepo: r.needsRepo }
    // Worktree mode can fail for a reason no slot picker can fix — no clone to create the
    // worktree from — so it reports a message rather than a list of candidates.
    if (r.error) return { ok: false, message: r.error }
    slot = r.slot
    worktree = r.create ? { create: true, root: r.root, base: r.base } : null
  }

  const script = buildLauncher({ item, slot, plans, skill, config, mergeBase, worktree })
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

  // Tab mode first when configured, falling back to a new window. Ordered this way, not
  // guarded by a permission check, because there is no reliable way to ask: reading process
  // names through System Events is allowed while SENDING a keystroke is a separate grant, so
  // the permissive-looking read told us nothing. Attempting it and falling back is the only
  // honest test, and the fallback is exactly today's behaviour.
  let r = null
  if (terminalMode(config) === 'tab') {
    r = await run('osascript', terminalArgs(path, 'tab'))
    if (r.code !== 0) {
      // Nothing has launched at this point: both the keystroke and the `do script` come
      // before anything runs, so retrying as a window cannot double-launch.
      const why = r.stderr.trim()
      r = await run('osascript', terminalArgs(path, 'window'))
      if (r.code === 0) {
        return {
          ok: true,
          message: `${launchedMessage(skill, slot)} — in a new WINDOW, not a tab: ${tabHint(why)}`,
          detail: script, slot: slot.dir,
        }
      }
    }
  } else {
    r = await run('osascript', terminalArgs(path, 'window'))
  }
  if (r.code !== 0) return { ok: false, message: `Could not open Terminal: ${r.stderr.trim()}` }
  return { ok: true, message: launchedMessage(skill, slot), detail: script, slot: slot.dir }
}
