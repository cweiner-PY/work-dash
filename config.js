import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export class ConfigError extends Error {}

const DEFAULTS = {
  port: 4200,
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

const REQUIRED_LOCAL = {
  jiraSite: 'your Jira site URL, e.g. https://performyard.atlassian.net',
  jiraEmail: 'the email your Jira account uses',
  jiraToken: 'a Jira API token — create one at id.atlassian.com under Security > API tokens',
  myAccountId: 'your Jira accountId (visible in any issue JSON under fields.assignee.accountId)',
  repos: 'a map of "Owner/Repo" -> { docsSubdir, slots: [...] }',
}

function readJson(path, { optional = false } = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if (optional && e.code === 'ENOENT') return null
    if (e.code === 'ENOENT') {
      throw new ConfigError(`Missing config file: ${path}`)
    }
    throw new ConfigError(`Could not parse ${path}: ${e.message}`)
  }
}

export function loadConfig({ local, shared } = {}) {
  const localCfg = local ?? readJson(join(import.meta.dirname, 'config.json'))
  const sharedCfg = shared ?? readJson(join(homedir(), '.claude', 'coltw.config.json'))

  for (const [key, hint] of Object.entries(REQUIRED_LOCAL)) {
    if (localCfg?.[key] == null) {
      throw new ConfigError(
        `config.json is missing "${key}".\n  It should be ${hint}.\n` +
        `  Copy config.example.json to config.json and fill it in.`
      )
    }
  }
  if (sharedCfg?.docsDir == null) {
    throw new ConfigError('~/.claude/coltw.config.json is missing "docsDir".')
  }

  const cfg = {
    ...DEFAULTS,
    ...localCfg,
    docsDir: sharedCfg.docsDir,
    cloudId: sharedCfg.cloudId ?? null,
  }

  const getSafeConfig = () => {
    const { jiraToken, toJSON, toSafeJSON, ...rest } = cfg
    return rest
  }

  cfg.toJSON = getSafeConfig
  cfg.toSafeJSON = getSafeConfig

  return cfg
}
