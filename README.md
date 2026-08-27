# work-dash

One local board for your Jira tickets, open PRs, PRs awaiting your review, and
your git checkouts — grouped by what needs action, with a button on every item
that does the next thing.

A single Node process: no build step, **no runtime dependencies**, nothing
beyond Jira's REST API and the `gh` CLI. Binds `127.0.0.1` only. The actions
that launch things (**open**, **run a skill**, **resolve conflicts**, the editor
link) are macOS-only; collecting the board and the git/GitHub actions aren't.

## Quick start

```bash
cp config.example.json config.json   # gitignored: it holds your Jira API token
./bin/work-dash whoami               # prints your Jira accountId + GitHub login
./bin/work-dash doctor               # checks every precondition, says how to fix each failure
./bin/work-dash                      # start it, then open the URL it prints
```

**First time? Follow [SETUP.md](SETUP.md)** — a runbook with a verification after
every step, written to be followed by a person or executed by a coding agent.

`doctor` exits non-zero while anything is wrong, so it works as a loop
condition. It checks the Node floor, config keys, `docsDir`, that each slot is a
real clone of the repo it's listed under, `gh` auth, that `githubLogin` and
`myAccountId` match the accounts actually authenticated, that every skill rule
parses, the editor, and the port.

## The board

Every item lands in exactly one lane, in this order:

| Lane | When |
|---|---|
| **Needs you** | A review is requested of you · the ticket is Done but your PR is still open · a **required** check is failing · changes were requested · your PR conflicts with its base · or it's approved and mergeable and just needs the button pressed |
| **Waiting on others** | Your PR is open, not a draft, awaiting review, no failing required checks |
| **In flight** | It has a local checkout, a draft PR, or Jira status category *In Progress*. Sub-grouped by Jira status in `inFlightStatusOrder` order |
| **Ready to start** | Status category *To Do* **and** committed to the active sprint |
| **Backlog** | Everything else |

Only **Backlog** and stale items (assigned to someone else, or whose ticket is
already Done) are hidden by default; the two checkboxes reveal them. Anything
hidden is still counted — "6 backlog · 3 stale" — so nothing vanishes silently.

Cards also carry: your own PR's state and required checks, how far behind its
base it is, an `idle Nd` chip once a PR has gone a day without activity (amber
at 3, red at 7), the local checkout, why the item is in its lane, attached plan
files, and Jira subtasks.

## Actions

| Action | What it does |
|---|---|
| **open** | New Terminal, `cd` to the checkout, check out the branch if needed, start `claude` with the ticket, branch, PR and selected plan paths in its system prompt — then waits for you to type |
| **`/skill-name`** | The same, but submits `/skill-name TICKET-KEY` immediately. Only skills the server computed as applicable are accepted |
| **update branch (N behind)** | `gh pr update-branch`, then a local `git pull --ff-only` if the branch is checked out. With no PR, `git fetch` + `git merge origin/<base>` locally |
| **resolve conflicts** | Replaces the update button when the PR conflicts, which GitHub can't fix server-side. Opens a Terminal, runs the merge, and hands Claude an instruction based on whether it actually conflicted |
| **squash & merge** | `gh pr merge --squash`, gated (below) |
| **the checkout name** | Click `PY-2` on the slot row to open that folder in your editor. The ticket key opens Jira and the PR number opens GitHub, same idea |

### The merge gate

A PR is offered for merge only when it's approved, GitHub reports it
`MERGEABLE`, it isn't a draft, the required-check list was **actually read**,
and every check in it passed. The button shows the gate but the server
re-checks it independently, requires explicit confirmation, and refuses to merge
a PR you don't own.

Only *required* checks gate it — a PR with failing non-required checks still
merges. A repo configuring no required checks is gated on approval alone.

"Behind" comes from GitHub's `Ref.compare`, never `mergeStateStatus` — that
field answers "can this merge", not "is this behind" (see the comment in
`collect/github.js`). An unreadable comparison shows **behind state unknown**
and disables the button rather than guessing zero.

## Configuration

Everything lives in `config.json`. `work-dash whoami` finds the two values you
can't guess; `doctor` validates the rest.

| Key | | |
|---|---|---|
| `jiraSite` | required | Jira base URL |
| `jiraEmail` | required | The email your **Atlassian** account signs in with — not always your work address. A wrong one returns `200` with zero issues |
| `jiraToken` | required | API token from id.atlassian.com |
| `myAccountId` | required | Your Jira account id |
| `docsDir` | required | Root of your plans/docs tree |
| `repos` | required | `"Owner/Repo"` → `{ docsSubdir, slots: [...], defaultBranch? }`. `slots` are the checkouts work-dash may drive; `defaultBranch` defaults to `master` |
| `jiraProject` | | Project key. Default `PY` |
| `githubLogin` | | Distinguishes your own PR comments from a teammate's review feedback |
| `port` | | Default 4200 |
| `editor` | | Any installed app name, resolved by `open -a`. Default `Cursor` |
| `notifications` | | macOS notification when an item newly needs you. Default `true` |
| `inFlightStatusOrder` | | Jira statuses in the order their subgroups appear |
| `skills` | | Below |

A missing required key stops the server naming that key, rather than starting
half-configured.

### Your own skills

Per-user config, not code. Each rule is a name and a condition; when it holds,
that item gets a button that opens a terminal on the right checkout and submits
`/name TICKET-KEY`. The skill has to exist in **your** Claude setup — the
dashboard only submits the slash command.

```json
"skills": [
  { "name": "ticket-planner",      "when": "!branch && !pr" },
  { "name": "critical-review",     "when": "slot" },
  { "name": "resolve-code-review", "when": "pr.hasReviewComments || pr.changesRequested" },
  { "name": "toggle-logan-env",    "when": "repo == 'PerformYard/Logan'" }
]
```

`when` sees `key`, `repo`, `slot`, `branch`, `plans`, `jira` and `pr`, with `!`,
`&&`, `||`, `==`, `!=`, parentheses, single-quoted strings and dotted paths. A
hand-written parser, not `eval`.

`pr` is deliberately **your own** PR, never a colleague's review request, so a
`pr`-gated skill won't fire on someone else's work. A rule that fails to parse
is skipped with a warning — meaning its button silently never appears, which is
why `doctor` checks every rule.

### Appearance and polling

Six palettes via the swatches in the controls row — four light grounds
(`ledger` tan, `clay`, `linen`, `sage`) and two dark (`manifest`, `phosphor`) —
stored per browser, defaulting to `ledger`. Deliberately not tied to
`prefers-color-scheme`. Each is one token block in `public/style.css`.

The page polls every 60s, skips it entirely while the tab is hidden, and catches
up when you return if the board is stale.

## Safety guarantees

- `collect/slots.js` is read-only. The only git it runs against your checkouts
  is `branch --show-current`, `status --porcelain`, and `rev-list --count`.
- **update branch** refuses a dirty tree, and never rebases, stashes,
  force-pushes, or aborts a conflicted merge — on conflict it leaves the repo
  exactly as git left it.
- **open** / **run** never check a branch out over uncommitted changes, and
  never touch a checkout belonging to a different repo than the item.
- **squash & merge** needs explicit confirmation, re-checks the gate server-side
  whatever the UI showed, and refuses a PR you don't own.
- Unreadable state is never treated as good state: an unread check list blocks
  the gate, an unread comparison disables the update button.
- The token is stripped from `GET /api/config` and redacted from Jira errors.
  `config.json` is gitignored, has never been committed, and
  `test/gitignore.test.js` asserts both.

## Troubleshooting

Start with `work-dash doctor` — it covers nearly everything. Beyond it:

**Board empty but I have tickets.** Jira answers a wrong-email request with
`200` and zero issues, not an error. work-dash re-checks `/myself` whenever the
primary query returns nothing and reports a credentials error naming the likely
cause, rather than showing a blank board.

**Merge button won't enable.** Its tooltip lists every blocker, not just the
first. "Check status unknown" usually means `gh` auth expired — an unreadable
check list blocks the gate rather than being assumed clean.


## Development

```bash
node --test                        # full suite, no network
WORK_DASH_DRY=1 node server.js     # actions print what they would run
work-dash doctor                   # verifies the live environment (this one does hit the network)
```

`join.js` and `lanes.js` are pure — no fs, no child_process, no clock — and are
tested against recorded fixtures. Collectors and actions take their `run`/`fetch`
dependency as an argument, which tests replace with fakes, and every action
takes a `dry` flag checked before it runs anything.
