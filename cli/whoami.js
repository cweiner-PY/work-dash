// cli/whoami.js — discover the two config values nobody can guess.
//
// Reads config.json DIRECTLY rather than through loadConfig, on purpose: the whole point
// is to run before the config is complete, and loadConfig requires myAccountId — one of
// the two values this command exists to find.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../util/run.js'

const ROOT = join(import.meta.dirname, '..')

// Pure: what is missing before we can even ask Jira who we are. Separated so it is
// testable and so the message can name every missing key at once rather than one per run.
export function missingForWhoami(cfg) {
  return ['jiraSite', 'jiraEmail', 'jiraToken'].filter((k) => !cfg?.[k])
}

export async function jiraIdentity({ jiraSite, jiraEmail, jiraToken }, { fetchFn = fetch } = {}) {
  const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')
  const res = await fetchFn(`${jiraSite.replace(/\/$/, '')}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  })
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error:
        `Jira rejected ${jiraEmail} (HTTP ${res.status}). Basic auth wants the email your ` +
        `ATLASSIAN account signs in with, which is not always your work address.`,
    }
  }
  if (!res.ok) return { ok: false, error: `Jira returned HTTP ${res.status}` }
  const me = await res.json()
  return { ok: true, accountId: me.accountId, displayName: me.displayName, email: me.emailAddress }
}

export async function githubIdentity({ runFn = run } = {}) {
  const r = await runFn('gh', ['api', 'user', '--jq', '.login'])
  if (r.code !== 0) {
    return { ok: false, error: `gh could not identify you: ${r.stderr.trim() || `exit ${r.code}`}. Try: gh auth login` }
  }
  const login = r.stdout.trim()
  return login ? { ok: true, login } : { ok: false, error: 'gh returned an empty login' }
}

export async function main() {
  let cfg
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'))
  } catch (e) {
    console.error(`Could not read config.json: ${e.message}\n  Run: cp config.example.json config.json`)
    process.exitCode = 1
    return
  }

  const missing = missingForWhoami(cfg)
  if (missing.length) {
    console.error(
      `config.json is missing ${missing.join(', ')}.\n` +
      `  Fill those in first — a Jira API token comes from\n` +
      `  https://id.atlassian.com/manage-profile/security/api-tokens`
    )
    process.exitCode = 1
    return
  }

  const [jira, gh] = await Promise.all([jiraIdentity(cfg), githubIdentity()])

  if (jira.ok) {
    console.log(`Jira:   ${jira.displayName} <${jira.email ?? 'email hidden'}>`)
    console.log(`        accountId: ${jira.accountId}`)
  } else {
    console.log(`Jira:   ${jira.error}`)
  }
  console.log(gh.ok ? `GitHub: ${gh.login}` : `GitHub: ${gh.error}`)

  if (jira.ok || gh.ok) {
    console.log('\nPut these in config.json:')
    if (jira.ok) console.log(`  "myAccountId": ${JSON.stringify(jira.accountId)},`)
    if (gh.ok) console.log(`  "githubLogin": ${JSON.stringify(gh.login)},`)
  }
  if (!jira.ok || !gh.ok) process.exitCode = 1
}
