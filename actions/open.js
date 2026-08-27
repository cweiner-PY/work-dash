// actions/open.js
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { run as defaultRun } from '../util/run.js'
import { resolveSlot, branchFor } from './slot.js'
import { myPrOf } from '../lanes.js'

// Single-quote a value for bash: close, escape, reopen.
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

// mergeBase, when given, is the base branch to merge in before Claude starts — the
// "resolve conflicts" action. The merge runs HERE, in the Terminal the user is watching,
// rather than server-side: the output is visible, and /api/open never mutates a checkout
// as an invisible side effect.
export function buildLauncher({ item, slot, plans, skill, config, mergeBase = null }) {
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
      ? `This branch conflicts with origin/${mergeBase}. The merge has just been started ` +
        `in this checkout and left conflicted on purpose — resolve the conflicts, then commit.`
      : null,
  ].filter(Boolean).join('\n')

  const claude = [
    'claude', '-n', q(item.key ?? item.id),
    ...planDirs.flatMap((d) => ['--add-dir', q(d)]),
    '--append-system-prompt', q(context),
    ...(skill ? [q(`/${skill} ${item.key ?? ''}`.trim())] : []),
  ].join(' ')

  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `cd ${q(slot.dir)}`,
  ]
  if (branch && slot.branch !== branch) lines.push(`git checkout ${q(branch)}`)
  if (mergeBase) {
    // Both tolerant of failure, and both loud about it. `set -e` is on, so a bare `git
    // merge` that stops on conflicts — the entire point of this path — would kill the
    // script before Claude ever launched.
    lines.push(
      `git fetch origin || echo ${q(`>> git fetch failed — origin/${mergeBase} may be stale`)}`,
      `git merge ${q(`origin/${mergeBase}`)} || echo ${q('>> merge stopped with conflicts — resolve them, then commit')}`,
    )
  }
  lines.push(claude, '')
  return lines.join('\n')
}

export async function openItem(
  { item, slots, plans = [], skill = null, config, chosenSlotDir = null, staleBranches, claimedDirs, repo = null, mergeBase = null },
  { run = defaultRun, writeFile = fsWriteFile, dry = false } = {}
) {
  let slot
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
    slot = r.slot
  }

  const script = buildLauncher({ item, slot, plans, skill, config, mergeBase })
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
  const applescript = `tell application "Terminal" to do script "bash ${path}"`
  const r = await run('osascript', ['-e', applescript, '-e', 'tell application "Terminal" to activate'])
  if (r.code !== 0) return { ok: false, message: `Could not open Terminal: ${r.stderr.trim()}` }
  return {
    ok: true,
    message: skill ? `Running /${skill} in ${slot.dir.split('/').pop()}` : `Opened ${slot.dir.split('/').pop()}`,
    detail: script, slot: slot.dir,
  }
}
