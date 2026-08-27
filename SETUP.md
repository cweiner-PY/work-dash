# Setting up work-dash

A local dashboard that gathers your assigned Jira tickets, your open PRs, PRs
awaiting your review, and your local checkouts onto one board, and gives each
item real buttons — open a Claude session on it, run one of your skills, update
the branch, resolve conflicts, squash-merge, open the checkout in your editor.

**This document is written to be executed, by a person or by a coding agent.**
Every step has a command and a way to tell whether it worked. Nothing here needs
to be guessed at.

---

## If you are an agent, read this first

- **Work through the steps in order.** After each one, run the verification it
  names. `work-dash doctor` is the authority on whether setup is complete: it
  checks every precondition and prints, for each failure, what to do about it.
  Re-run it after every change. Setup is done when it prints `all N checks
  passed` and exits 0. The number varies — there is one check per configured
  checkout — so treat the exit code, not a count, as the signal.
- **You cannot obtain the Jira API token.** It is created by a human in a browser
  session you do not have. When you reach that step, stop and ask for it. Do not
  invent a value, do not try to read it from another file, and do not proceed
  past it — every Jira-backed check will fail without it.
- **Never print, log, echo or commit the token.** `config.json` is gitignored and
  must stay that way. If you are asked to show the config, show
  `config.example.json` instead.
- **Every step is idempotent.** Re-running the whole document is safe. `cp` steps
  are the exception — do not overwrite a `config.json` that already exists.
- **Do not modify code to make a check pass.** A failing check means the
  environment is wrong, not the checker.

---

## 1. Prerequisites

```bash
node --version          # must be >= 20.11 (the code uses import.meta.dirname)
gh auth status          # must report you as logged in
```

If `gh` is not authenticated, run `gh auth login`. Required-check reading — and
therefore the merge gate — depends on it.

This tool is **macOS-only** for the terminal, editor and notification actions:
they go through `osascript` and `open`. The board itself works anywhere.

## 2. Get the code

```bash
git clone <REPO_URL> work-dash && cd work-dash
```

No `npm install`. There are **zero runtime dependencies** — the whole thing runs
on `node:http`, global `fetch` and `node:child_process`.

## 3. Create your config

```bash
cp config.example.json config.json      # skip if config.json already exists
```

`config.json` is gitignored because it holds your Jira API token. Never commit
it.

Now edit it. The values fall into three groups:

**Already correct for everyone at PerformYard** — leave alone:
`jiraSite`, `jiraProject`, `jiraSprintField`, the `repos` keys and their
`docsSubdir`, `inFlightStatusOrder`.

**You must set** — the example has placeholders:

| Key | What it is |
|---|---|
| `jiraEmail` | The email your **Atlassian account** signs in with. See step 4; this is the single most common thing to get wrong. |
| `jiraToken` | A Jira API token. Step 4. |
| `myAccountId` | Your Jira account id. Step 5 finds it. |
| `githubLogin` | Your GitHub username. Step 5 finds it. |
| `docsDir` | Absolute path to the root of your plans/docs tree. |
| `repos.*.slots` | Absolute paths to your local clones. Step 6. |

**Optional:** `port` (default 4200), `editor` (default `Cursor`, any installed
app name), `notifications` (default `true`), `humanGateChecks` (required checks
that are human gates rather than CI — default `["QA Code Review"]`), `skills`
(see the end of this doc), and `checkoutMode`:

- `slots` (default) — agents run in the pre-cloned directories you list in
  `repos.*.slots`. Step 6 sets these up.
- `worktrees` — agents run in a `git worktree` created per branch under
  `~/.cache/work-dash-worktrees`. Nothing to pre-clone beyond one clone per repo
  (`repos.*.root`, or the first `slots` entry), and no pool to exhaust.

## 4. Jira token — HUMAN REQUIRED

An agent must stop here and ask.

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens>
2. Create an API token and copy it.
3. Put it in `config.json` as `jiraToken`.

**Then get the email right.** Jira's basic auth wants the email your *Atlassian
account* signs in with, which is **not always your work address**. Test the pair
before going further:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -u 'YOUR_EMAIL:YOUR_TOKEN' \
  https://performyard.atlassian.net/rest/api/3/myself
```

`200` means that email is right. `401` means it is not — try the other address
you have on Atlassian. A wrong email is not always loud: the search endpoint
answers `200` with **zero issues**, which looks exactly like having no assigned
work.

## 5. Find your account ids

```bash
./bin/work-dash whoami
```

It prints your Jira `accountId` and your GitHub login, formatted to paste
straight into `config.json`. It reads `config.json` directly rather than through
the normal loader, so it works while the config is still incomplete — it needs
only `jiraSite`, `jiraEmail` and `jiraToken`.

## 6. Point it at your checkouts

**First, pick a checkout mode** — where agent sessions run. `"checkoutMode"` in
`config.json`:

- **`"slots"`** (the default) — a fixed pool of clones you set up now, below.
- **`"worktrees"`** — a `git worktree` per branch, created on demand under
  `~/.cache/work-dash-worktrees`. Then you only need ONE clone per repo: set
  `repos.*.root` to it (or leave a single `slots` entry, which is used as the
  source). Nothing to pre-clone per branch, and no pool to run out of.

Either way `doctor` checks what that mode actually requires, and switching later
hides nothing — worktree mode still shows any `slots` you have configured.

For slots mode: each repo needs at least one; several let you work on several
branches at once. Clone them wherever you like and list the absolute paths:

```bash
git clone git@github.com:PerformYard/PerformYard.git ~/Work/PY-1
git clone git@github.com:PerformYard/Logan.git       ~/Work/Logan
```

`doctor` verifies each slot is a real clone of the repo it is listed under, by
reading its `origin` remote. That check exists because a slot pointing at the
wrong repo is how an action could run git somewhere it shouldn't.

## 7. Verify

```bash
./bin/work-dash doctor
```

Fix every `FAIL` line — each one says what to do — and run it again until:

```
all N checks passed — run `work-dash` and open the port it prints.
```

(`N` depends on how many checkouts you listed — one check each.)

`doctor` exits non-zero while anything fails, so it can be used as a loop
condition.

## 8. Run it

```bash
./bin/work-dash
# or: node server.js
# or: npm start
```

Open the URL it prints (`http://127.0.0.1:<port>`). The first collection takes a
few seconds against live Jira and GitHub.

Optional, to run it from anywhere:

```bash
ln -s "$PWD/bin/work-dash" ~/.local/bin/work-dash
```

---

## Hooking in your own skills

This is per-user config, not code. Each entry in `skills` is a name and a
condition; when the condition holds for an item, that item gets a button that
opens a terminal on the right checkout and submits `/name TICKET-KEY` to Claude.

```json
"skills": [
  { "name": "ticket-planner",       "when": "!branch && !pr" },
  { "name": "critical-review",      "when": "slot" },
  { "name": "resolve-code-review",  "when": "pr.hasReviewComments || pr.changesRequested" },
  { "name": "toggle-logan-env",     "when": "repo == 'PerformYard/Logan'" }
]
```

The skill itself has to exist in **your own** Claude setup — the dashboard only
submits `/name`, it does not supply the skill.

What `when` can reference:

| Name | Value |
|---|---|
| `key` | Ticket key, e.g. `PY-12746`, or null for a checkout with no ticket |
| `repo` | `Owner/Repo`, or null if not yet known |
| `slot` | The local checkout, or null — truthy test only |
| `branch` | Branch name from your PR or your checkout, else null |
| `plans` | Attached plan files |
| `jira` | The ticket: `jira.status`, `jira.statusCategory`, `jira.url` … |
| `pr` | **Your own** PR only, never a colleague's review request. Adds `pr.hasReviewComments` and `pr.changesRequested`. |

Operators: `!`, `&&`, `||`, `==`, `!=`, parentheses, single-quoted strings,
dotted paths. It is a hand-written parser, not `eval`.

Two things to know:

- `pr` is deliberately *your* PR. A `pr`-gated skill will not fire on a PR you
  were merely asked to review.
- A rule that does not parse logs a warning and is skipped, so its button simply
  never appears. `doctor` checks every rule for you — a stray character in a
  `when` is otherwise a silent missing button.

## Troubleshooting

`doctor` covers nearly everything. Beyond it, see the Troubleshooting section of
`README.md`, which explains what a degraded source looks like on the board and
why a source failing never blanks the whole thing.
