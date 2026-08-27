// actions/worktree.js
//
// The worktree checkout mode. Slots mode (the default) uses a fixed list of pre-cloned
// directories from config; worktree mode creates one worktree per branch on demand under a
// cache root, so nothing has to be cloned in advance and there is no pool to exhaust.
//
// Everything here is pure. The git that creates a worktree runs in the launcher script, in
// the Terminal the user is watching — same rule as the conflict merge: this server does not
// mutate a checkout as an invisible side effect.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_WORKTREE_ROOT = join(homedir(), '.cache', 'work-dash-worktrees')
export const DEFAULT_WORKTREE_MAX_AGE_MS = 72 * 60 * 60 * 1000   // 3 days, as greg's does

export function checkoutMode(config) {
  // Anything other than an explicit 'worktrees' is slots. An unrecognised value must not
  // silently switch how the tool touches your repositories.
  return config?.checkoutMode === 'worktrees' ? 'worktrees' : 'slots'
}

export function worktreeRoot(config) {
  return config?.worktreeRoot ?? DEFAULT_WORKTREE_ROOT
}

// The clone `git worktree add` is run from. An explicit `root` wins; otherwise the first
// configured slot, so a config written for slots mode works in worktree mode untouched.
export function repoRootFor(config, repo) {
  const cfg = config?.repos?.[repo]
  return cfg?.root ?? cfg?.slots?.[0] ?? null
}

// A branch name is not a directory name: it can contain slashes (feat/foo), dots, and on a
// case-insensitive filesystem two branches can collide. Slugged, and suffixed with a short
// hash so distinct branches cannot land on the same path.
export function slugFor(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  let h = 0
  for (const ch of String(name ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 0xffffffff
  const suffix = h.toString(36).slice(0, 6)
  return slug ? `${slug}-${suffix}` : suffix
}

// Grouped by REPO name, not by the basename of whichever clone happens to be the root:
// changing which clone worktrees are created from must not move every existing worktree.
export function worktreePathFor(config, repo, name) {
  return join(worktreeRoot(config), String(repo).split('/').pop(), slugFor(name))
}

// `git worktree list --porcelain` emits blank-line-separated records:
//   worktree /path
//   HEAD <sha>
//   branch refs/heads/<name>     (or `detached`)
// The main clone is the FIRST record and is not a worktree we manage; callers exclude it by
// path, not by position, since order is not documented as stable.
export function parseWorktreeList(stdout) {
  const out = []
  for (const block of String(stdout ?? '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    const dir = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!dir) continue
    const branchLine = lines.find((l) => l.startsWith('branch '))
    out.push({
      dir,
      branch: branchLine ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '') : null,
      detached: lines.includes('detached'),
      bare: lines.includes('bare'),
    })
  }
  return out
}

// Which worktrees are safe to remove: ours (under the configured root), clean, and older
// than the age limit. A dirty worktree is NEVER prunable however old — it may hold the only
// copy of someone's work. The main clone can never match, since it is not under the root.
export function prunableWorktrees(slots, { config, now, maxAgeMs = DEFAULT_WORKTREE_MAX_AGE_MS } = {}) {
  const root = worktreeRoot(config)
  return (slots ?? [])
    .filter((s) => s.dir?.startsWith(root + '/'))
    .filter((s) => s.dirty === false && (s.dirtyCount ?? 0) === 0)
    .filter((s) => Number.isFinite(s.mtimeMs) && now - s.mtimeMs > maxAgeMs)
    .map((s) => s.dir)
}

// The worktree this item should run in, and whether it has to be created first.
// `base` is what a NEW worktree is created at:
//   - a branch that exists on the remote  -> origin/<branch>, so the code is the PR's code
//   - no branch yet (a To Do ticket)      -> origin/<defaultBranch>
// Created detached in both cases. A branch can only be checked out in one worktree at a
// time, and detaching sidesteps that entirely — the agent creates a local branch if it
// needs to push, and an existing worktree already on the branch is reused instead.
export function planWorktree(item, slots, config, { repo = null, branch = null } = {}) {
  const effectiveRepo = item?.repo ?? repo
  if (!effectiveRepo) {
    return { needsRepo: true, message: 'This ticket has no known repository yet — which one is it in?' }
  }
  const root = repoRootFor(config, effectiveRepo)
  if (!root) {
    return {
      error: `No clone configured for ${effectiveRepo}. Set repos["${effectiveRepo}"].root ` +
             `(or a slots entry) to a local clone — worktrees are created from it.`,
    }
  }

  const name = branch ?? item?.key ?? item?.id
  const existing = (slots ?? []).find((s) => branch && s.branch === branch && s.repo === effectiveRepo)
  if (existing) return { slot: existing, create: false, root, alreadyOnBranch: true }

  const defaultBranch = config?.repos?.[effectiveRepo]?.defaultBranch ?? 'master'
  return {
    slot: { dir: worktreePathFor(config, effectiveRepo, name), repo: effectiveRepo, branch: branch ?? null,
            dirty: false, dirtyCount: 0, behind: null, ahead: null },
    create: true,
    root,
    base: `origin/${branch ?? defaultBranch}`,
    alreadyOnBranch: false,
  }
}

// Removes the worktrees prunableWorktrees selected. `git worktree remove` refuses a dirty
// worktree on its own, which is a second safety net under our own dirty filter — between
// them, a worktree holding uncommitted work cannot be removed by this tool.
export async function pruneWorktrees(slots, config, { run, now = Date.now(), maxAgeMs } = {}) {
  const removed = []
  for (const dir of prunableWorktrees(slots, { config, now, maxAgeMs })) {
    const repo = (slots ?? []).find((s) => s.dir === dir)?.repo
    const root = repoRootFor(config, repo)
    if (!root) continue
    const r = await run('git', ['-C', root, 'worktree', 'remove', dir])
    if (r.code === 0) removed.push(dir)
  }
  return removed
}
