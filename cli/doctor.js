// cli/doctor.js — verify every precondition and say what to do about each failure.
//
// This exists so SETUP.md can be executed rather than merely followed: an agent (or a
// person) runs this, fixes what it names, and repeats until it is clean. Every check
// reports what to DO, not just that something is wrong.
import { createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../util/run.js'
import { REQUIRED_LOCAL, SHARED_PATH, resolveDocsDir, ConfigError, loadConfig } from '../config.js'
import { evalPredicate } from '../util/predicate.js'
import { checkoutMode, repoRootFor, worktreeRoot } from '../actions/worktree.js'
import { jiraIdentity, githubIdentity } from './whoami.js'

const ROOT = join(import.meta.dirname, '..')

// Pure: turn checks into output and a verdict. `ok  ` / `FAIL` are fixed-width and
// line-leading so the result greps cleanly.
export function report(checks) {
  const lines = checks.map((c) =>
    `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.detail ? `\n        ${c.detail.replaceAll('\n', '\n        ')}` : ''}`)
  const failed = checks.filter((c) => !c.ok).length
  return {
    lines,
    failed,
    summary: failed
      ? `${failed} of ${checks.length} checks failed — fix the FAIL lines above and run again.`
      : `all ${checks.length} checks passed — run \`work-dash\` and open the port it prints.`,
  }
}

// Pure: 20.11 is the floor because the code uses import.meta.dirname.
export function nodeVersionOk(version) {
  const [maj, min] = String(version).replace(/^v/, '').split('.').map(Number)
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false
  return maj > 20 || (maj === 20 && min >= 11)
}

// config.example.json ships placeholders rather than blanks, so a key can be present and
// still unset in practice. Treating those as missing keeps the first check honest instead
// of deferring the discovery to whichever later check happens to trip over it.
export function isPlaceholder(value) {
  return typeof value === 'string' && /^RUN:|^PASTE_|\/Users\/YOU\//.test(value)
}

const check = (name, ok, detail = null) => ({ name, ok, detail })

async function isDir(p) {
  try { return (await stat(p)).isDirectory() } catch { return false }
}

// Whoever holds the port: work-dash serves its own config on this route, so a response
// carrying a repos map identifies it. Any error at all means "not work-dash".
async function isWorkDash(port, { fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/api/config`)
    if (!res.ok) return false
    const body = await res.json()
    return Boolean(body && typeof body === 'object' && body.repos)
  } catch { return false }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

export async function checks({ runFn = run } = {}) {
  const out = []

  out.push(check('node >= 20.11', nodeVersionOk(process.version), `found ${process.version}`))

  // --- config.json --------------------------------------------------------------------
  let raw = null
  try {
    raw = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
    out.push(check('config.json parses', true))
  } catch (e) {
    out.push(check('config.json parses', false,
      `${e.message}\nRun: cp config.example.json config.json   (it is gitignored; never commit it)`))
    return out   // nothing below can be judged without it
  }

  const missing = Object.keys(REQUIRED_LOCAL).filter((k) => raw[k] == null || isPlaceholder(raw[k]))
  out.push(check('config.json has the required keys', missing.length === 0,
    missing.length
      ? `missing or still a placeholder: ${missing.join(', ')}\n` +
        missing.map((k) => `  ${k} — ${REQUIRED_LOCAL[k]}`).join('\n') +
        `\nmyAccountId and githubLogin: run \`work-dash whoami\``
      : null))

  // --- docsDir ------------------------------------------------------------------------
  let shared = null
  try { shared = JSON.parse(readFileSync(SHARED_PATH, 'utf8')) } catch { /* optional */ }
  const docsDir = resolveDocsDir(raw, shared)
  if (!docsDir) {
    out.push(check('docsDir configured', false,
      `Set "docsDir" in config.json to the root of your plans tree, or put it in ${SHARED_PATH}`))
  } else if (isPlaceholder(docsDir)) {
    out.push(check('docsDir configured', false,
      `still the placeholder from config.example.json (${docsDir}) — set it to your plans tree`))
  } else {
    out.push(check('docsDir exists', await isDir(docsDir),
      await isDir(docsDir) ? docsDir : `${docsDir} is not a directory — create it, or point docsDir elsewhere`))
  }

  // --- checkouts ----------------------------------------------------------------------
  // What "correctly configured" means differs by mode, so the checks do too: slots mode
  // needs every listed directory to be a clone; worktree mode needs ONE clone per repo to
  // create worktrees from, and a writable cache root.
  const mode = checkoutMode(raw)
  out.push(check(`checkout mode: ${mode}`, mode === 'slots' || mode === 'worktrees',
    raw.checkoutMode && mode !== raw.checkoutMode
      ? `"${raw.checkoutMode}" is not a mode — falling back to slots. Use "slots" or "worktrees".`
      : null))

  if (mode === 'worktrees') {
    const root = worktreeRoot(raw)
    out.push(check(`worktree root ${root}`, true,
      await isDir(root) ? null : 'does not exist yet — it is created on the first launch'))
    for (const repo of Object.keys(raw.repos ?? {})) {
      const clone = repoRootFor(raw, repo)
      if (!clone) {
        out.push(check(`${repo}: clone to create worktrees from`, false,
          `set repos["${repo}"].root (or one slots entry) to a local clone of ${repo}`))
        continue
      }
      const r = await runFn('git', ['-C', clone, 'remote', 'get-url', 'origin'])
      const url = r.stdout.trim()
      const matches = r.code === 0 && url.toLowerCase().includes(repo.toLowerCase())
      out.push(check(`${repo}: worktree source ${clone}`, matches,
        r.code !== 0 ? `not a git repo (${r.stderr.trim() || `exit ${r.code}`})`
                     : matches ? null : `origin is ${url}, expected a clone of ${repo}`))
    }
  }

  // --- checkout slots -----------------------------------------------------------------
  // A slot pointing somewhere that is not a clone of the repo it is listed under is the
  // failure that would let an action run git in the wrong place, so the remote is checked
  // too, not merely that the directory exists.
  for (const [repo, cfg] of Object.entries(raw.repos ?? {})) {
    const slots = cfg?.slots ?? []
    if (!slots.length) {
      // Only a problem in slots mode; worktree mode needs no pre-cloned pool.
      if (mode === 'slots') {
        out.push(check(`${repo}: slots configured`, false, 'no slots listed — add at least one checkout path'))
      }
      continue
    }
    for (const dir of slots) {
      if (!await isDir(dir)) {
        out.push(check(`slot ${dir}`, false, `not a directory — clone ${repo} there, or remove it from config.json`))
        continue
      }
      const r = await runFn('git', ['remote', 'get-url', 'origin'], { cwd: dir })
      const url = r.stdout.trim()
      const matches = r.code === 0 && url.toLowerCase().includes(repo.toLowerCase())
      out.push(check(`slot ${dir}`, matches,
        r.code !== 0 ? `not a git repo (${r.stderr.trim() || `exit ${r.code}`})`
                     : matches ? null : `origin is ${url}, expected a clone of ${repo}`))
    }
  }

  // --- gh -----------------------------------------------------------------------------
  const auth = await runFn('gh', ['auth', 'status'])
  out.push(check('gh is authenticated', auth.code === 0,
    auth.code === 0 ? null : `${(auth.stderr || auth.stdout).trim().slice(0, 200)}\nRun: gh auth login`))

  const gh = auth.code === 0 ? await githubIdentity({ runFn }) : { ok: false, error: 'skipped, gh not authenticated' }
  out.push(check('githubLogin matches the authenticated gh user', gh.ok && gh.login === raw.githubLogin,
    !gh.ok ? gh.error
      : gh.login === raw.githubLogin ? null
      : `gh says ${gh.login}, config.json says ${raw.githubLogin ?? '(unset)'}`))

  // --- jira ---------------------------------------------------------------------------
  if (!raw.jiraSite || !raw.jiraEmail || !raw.jiraToken) {
    out.push(check('Jira credentials accepted', false, 'jiraSite, jiraEmail and jiraToken must all be set'))
  } else {
    const jira = await jiraIdentity(raw)
    out.push(check('Jira credentials accepted', jira.ok, jira.ok ? `${jira.displayName}` : jira.error))
    // A wrong accountId is the quietest failure of all: Jira answers 200 with an empty
    // issue list, which looks exactly like "you have no assigned work".
    if (jira.ok) {
      out.push(check('myAccountId matches the authenticated Jira user', jira.accountId === raw.myAccountId,
        jira.accountId === raw.myAccountId ? null
          : `Jira says ${jira.accountId}, config.json says ${raw.myAccountId ?? '(unset)'}\n` +
            `A wrong accountId returns HTTP 200 with zero issues — it looks like an empty board, not an error.`))
    }
  }

  // --- skill rules --------------------------------------------------------------------
  // An unparseable rule only warns at runtime, so its skill silently never appears.
  const ctx = { key: 'X-1', repo: 'O/R', slot: null, branch: null, plans: [], jira: null, pr: null }
  const badRules = []
  for (const rule of raw.skills ?? []) {
    try { evalPredicate(rule.when, ctx) } catch (e) { badRules.push(`${rule.name}: ${e.message}`) }
  }
  out.push(check('every skill "when" rule parses', badRules.length === 0, badRules.join('\n') || null))

  // --- macOS helpers ------------------------------------------------------------------
  const osa = await runFn('osascript', ['-e', 'return 1'])
  out.push(check('osascript available (open, run, notifications)', osa.code === 0,
    osa.code === 0 ? null : 'these actions are macOS-only'))

  const editor = raw.editor ?? 'Cursor'
  const app = await runFn('osascript', ['-e', `id of app "${editor}"`])
  out.push(check(`editor "${editor}" is installed`, app.code === 0,
    app.code === 0 ? null : `macOS cannot resolve "${editor}" — set "editor" in config.json to an installed app`))

  // --- port ---------------------------------------------------------------------------
  // "Already running" is a HEALTHY state, and must not be reported as a failure — an agent
  // working through SETUP.md would otherwise loop on it forever. So an occupied port is
  // probed to find out who has it, rather than assumed to be a problem.
  const port = raw.port ?? 4200
  if (await portFree(port)) {
    out.push(check(`port ${port} is free`, true))
  } else {
    const mine = await isWorkDash(port)
    out.push(check(`port ${port}`, mine,
      mine ? 'work-dash is already running here'
           : 'occupied by something that is not work-dash — stop it, or change "port" in config.json'))
  }

  // Last: prove the real loader agrees with all of the above.
  try {
    loadConfig()
    out.push(check('loadConfig() succeeds', true))
  } catch (e) {
    out.push(check('loadConfig() succeeds', false, e instanceof ConfigError ? e.message : String(e)))
  }

  return out
}

export async function main() {
  const result = report(await checks())
  for (const line of result.lines) console.log(line)
  console.log(`\n${result.summary}`)
  if (result.failed) process.exitCode = 1
}
