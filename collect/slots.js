// collect/slots.js
import { stat as defaultStat } from 'node:fs/promises'
import { run as defaultRun } from '../util/run.js'
import { checkoutMode, repoRootFor, parseWorktreeList } from '../actions/worktree.js'

// Which directories to inspect for a repo. Slots mode reads the configured list. Worktree
// mode reads that list AND whatever `git worktree list` reports, deduped.
//
// The union matters: worktree mode lists only the worktrees of ONE clone, so without it
// switching modes would make every other configured clone vanish from the board — a probe
// against the real config saw 6 checkouts drop to 2. Nothing should disappear because you
// changed where NEW launches go. Someone who configures no slots at all simply gets the
// discovered worktrees.
async function dirsFor(config, repo, cfg, { run, errors }) {
  const configured = cfg.slots ?? []
  if (checkoutMode(config) !== 'worktrees') return configured

  const root = repoRootFor(config, repo)
  if (!root) {
    errors.push(`no clone configured for ${repo}: set repos["${repo}"].root to a local clone`)
    return configured
  }
  const r = await run('git', ['-C', root, 'worktree', 'list', '--porcelain'])
  if (r.code !== 0) {
    errors.push(`could not list worktrees for ${repo}: ${r.stderr.trim() || `exit ${r.code}`}`)
    return configured
  }
  const discovered = parseWorktreeList(r.stdout).filter((w) => !w.bare).map((w) => w.dir)
  return [...new Set([...configured, ...discovered])]
}

async function git(run, dir, args) {
  const r = await run('git', args, { cwd: dir })
  if (r.code !== 0) throw new Error(`git ${args[0]} failed in ${dir}: ${r.stderr.trim() || r.code}`)
  return r.stdout
}

export async function collectSlots(config, { run = defaultRun, stat = defaultStat } = {}) {
  const errors = []

  // Three git commands per checkout. Run SEQUENTIALLY this was 3.4s for six slots and the
  // slowest source on the board — each subprocess costs ~190ms and none of them depend on
  // another. Collected as a list of tasks and awaited together; the results are mapped in
  // order rather than pushed on completion, so the slot order still follows the config.
  const tasks = []
  for (const [repo, cfg] of Object.entries(config.repos)) {
    const base = `origin/${cfg.defaultBranch ?? 'master'}`
    for (const dir of await dirsFor(config, repo, cfg, { run, errors })) {
      tasks.push(async () => {
      try {
        const branch = (await git(run, dir, ['branch', '--show-current'])).trim() || null
        const porcelain = await git(run, dir, ['status', '--porcelain'])
        const dirtyCount = porcelain.split('\n').filter((l) => l.trim() !== '').length

        // Ahead/behind is the LEAST important field here and the most likely to fail
        // (a repo whose default branch is not `master`, a missing remote ref). It gets
        // its own guard so its failure cannot take the slot down with it: `dirty` is
        // safety information — it is how the user learns a checkout holds uncommitted
        // work — and it must survive an unrelated git command failing.
        let behind = null
        let ahead = null
        try {
          const counts = await git(run, dir, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
          const parts = counts.trim().split(/\s+/)
          if (parts.length >= 2) {
            behind = Number(parts[0]) || 0
            ahead = Number(parts[1]) || 0
          }
        } catch (e) {
          errors.push(e.message)
        }

        // mtime is only used to decide which worktrees are old enough to prune, and its
        // absence must never cost us the slot — prunableWorktrees ignores a non-finite one.
        let mtimeMs = null
        try { mtimeMs = (await stat(dir)).mtimeMs } catch { /* not prunable, still a slot */ }

        return { dir, repo, branch, dirty: dirtyCount > 0, dirtyCount, behind, ahead, mtimeMs }
      } catch (e) {
        // One unreadable checkout must not cost the others. Reported, and dropped from the
        // slot list rather than half-populated — a slot whose `dirty` is unknown is exactly
        // what every action's fail-closed check is written to distrust.
        errors.push(e.message)
        return null
      }
      })
    }
  }

  const slots = (await Promise.all(tasks.map((t) => t()))).filter(Boolean)
  return { slots, errors }
}
