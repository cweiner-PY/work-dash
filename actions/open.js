// actions/open.js
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run as defaultRun } from '../util/run.js'
import { resolveSlot, branchFor } from './slot.js'

// Single-quote a value for bash: close, escape, reopen.
const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

export function buildLauncher({ item, slot, plans, skill, config }) {
  const branch = branchFor(item)
  const planDirs = [...new Set(plans.map((p) => p.dir))]
  const planFiles = plans.map((p) => `${p.dir}/${p.file}`)

  const context = [
    `Active ticket: ${item.key ?? item.id} — ${item.title ?? ''}`.trim(),
    item.jira?.status ? `Jira status: ${item.jira.status}.` : null,
    item.jira?.url ? `Jira: ${item.jira.url}` : null,
    branch ? `Branch: ${branch}` : null,
    item.prs.length ? `PR: #${item.prs[0].number} ${item.prs[0].url}` : null,
    planFiles.length ? `Plan files: ${planFiles.join(', ')}. Read them before acting.` : null,
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
  lines.push(claude, '')
  return lines.join('\n')
}

export async function openItem(
  { item, slots, plans = [], skill = null, config, chosenSlotDir = null, staleBranches },
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
    // Explicit choice never overrides the dirty-tree rule.
    if (slot.dirty && slot.branch !== branchFor(item)) {
      return { ok: false, message: `${slot.dir} has ${slot.dirtyCount} uncommitted change(s) — commit or stash first.` }
    }
  } else {
    const r = resolveSlot(item, slots, config, { staleBranches })
    if (r.needsPicker) return { ok: false, message: r.message, candidates: r.candidates }
    slot = r.slot
  }

  const script = buildLauncher({ item, slot, plans, skill, config })
  const path = join(tmpdir(), `work-dash-${(item.key ?? item.id).replaceAll(/[^\w.-]/g, '_')}.sh`)

  if (dry) return { ok: true, message: `dry run — would launch in ${slot.dir}`, detail: script, slot: slot.dir }

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
