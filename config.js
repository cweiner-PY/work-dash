import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class ConfigError extends Error {}

const DEFAULTS = {
  port: 4200,
  // 'window' (default) or 'tab'. Tab needs an Accessibility grant per machine, so it is
  // opt-in — see terminalMode in actions/open.js.
  terminalMode: 'window',
  // Required checks that are HUMAN gates rather than CI. These stay FAILURE until a person
  // acts, so they must not be read as "you broke something" — see lanes.js. Set to [] at an
  // organisation that has none.
  humanGateChecks: ['QA Code Review'],
  // macOS notification when an item newly enters the needs-you lane. Set false to silence.
  notifications: true,
  // Resolved by `open -a <editor>`, so any installed application name works.
  editor: 'Cursor',
  jiraProject: 'PY',
  inFlightStatusOrder: [
    'In Progress', 'In Code Review', 'Ready To Test', 'In Testing', 'Ready To Merge',
  ],
  skills: [],
}

// A generically-named optional file for anyone who keeps one cross-tool config. This used
// to be REQUIRED, at ~/.claude/coltw.config.json — a path named after one person's
// account, which meant nobody else could run this at all. docsDir now belongs in
// config.json; this remains only as a convenience.
export const SHARED_PATH = join(homedir(), '.claude', 'work-dash.config.json')

export const REQUIRED_LOCAL = {
  jiraSite: 'your Jira site URL, e.g. https://performyard.atlassian.net',
  jiraEmail: 'the email your Jira account uses',
  jiraToken: 'a Jira API token — create one at id.atlassian.com under Security > API tokens',
  myAccountId: 'your Jira accountId (visible in any issue JSON under fields.assignee.accountId)',
  repos: 'a map of "Owner/Repo" -> { docsSubdir, slots: [...] }',
}

function readJson(path, { optional = false, hint = null } = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if (optional && e.code === 'ENOENT') return null
    if (e.code === 'ENOENT') {
      // The first thing anyone sees on a fresh clone, so it says what to DO, not just
      // which file is absent.
      throw new ConfigError(`Missing config file: ${path}${hint ? `\n  ${hint}` : ''}`)
    }
    throw new ConfigError(`Could not parse ${path}: ${e.message}`)
  }
}

// Local config wins, then the optional shared file. Exported so doctor and the tests can
// ask the same question without loading a whole config.
export function resolveDocsDir(localCfg, sharedCfg) {
  return localCfg?.docsDir ?? sharedCfg?.docsDir ?? null
}

export function loadConfig({ local, shared } = {}) {
  const localCfg = local ?? readJson(join(import.meta.dirname, 'config.json'), {
    hint: 'Run: cp config.example.json config.json   — then see SETUP.md',
  })
  // `shared !== undefined` rather than `??`: a caller passing null means "there is no
  // shared file", and must not silently fall through to reading the real one off this
  // machine — which would make tests depend on the developer's home directory.
  const sharedCfg = shared !== undefined ? shared : readJson(SHARED_PATH, { optional: true })

  for (const [key, hint] of Object.entries(REQUIRED_LOCAL)) {
    if (localCfg?.[key] == null) {
      throw new ConfigError(
        `config.json is missing "${key}".\n  It should be ${hint}.\n` +
        `  Copy config.example.json to config.json and fill it in.`
      )
    }
  }
  const docsDir = resolveDocsDir(localCfg, sharedCfg)
  if (docsDir == null) {
    throw new ConfigError(
      'No "docsDir" configured.\n' +
      '  It should be the root of your plans/docs tree, e.g. /Users/you/Work/docs.\n' +
      `  Put it in config.json, or in ${SHARED_PATH}.`
    )
  }

  const cfg = { ...DEFAULTS, ...localCfg, docsDir }

  const getSafeConfig = () => {
    const { jiraToken, toJSON, toSafeJSON, ...rest } = cfg
    return rest
  }

  cfg.toJSON = getSafeConfig
  cfg.toSafeJSON = getSafeConfig

  return cfg
}
