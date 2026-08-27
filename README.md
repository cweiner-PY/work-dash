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
| **Needs you** | A review is requested of you · the ticket is Done but your PR is still open · a **required** CI check is failing · review threads are waiting on your reply · changes were requested · your PR conflicts with its base · or it's approved and mergeable and just needs the button pressed |
| **Waiting on others** | Your PR is open, not a draft, no failing required checks, and either awaiting first review or **already updated since a changes-requested review** — the reviewer's move either way |
| **In flight** | It has a local checkout, a draft PR, or Jira status category *In Progress*. Sub-grouped by Jira status in `inFlightStatusOrder` order |
| **Ready to start** | Status category *To Do* **and** committed to the active sprint |
| **Backlog** | Everything else |

Only **Backlog** and stale items (assigned to someone else, or whose ticket is
already Done) are hidden by default; the two checkboxes reveal them. Anything
hidden is still counted — "6 backlog · 3 stale" — so nothing vanishes silently.

**A card is a ticket; its blocks are branches.** Split a big feature across
several branches carrying one Jira key and each gets its own block on that
ticket's card: its own PR state, its own checkout, its own reasons, and its own
buttons. A ticket with one branch renders flat, exactly as before — the blocks
only appear when there is something to tell apart.

Blocks stay in **creation order**, first branch to last, ordered by PR number
(monotonic per repo, so ascending number *is* creation order; a branch with no PR
yet sorts last). They are never sorted by urgency: the branches of one feature are
sequential, and showing `pr3` above `pr2` would lie about the shape of the work.
Urgency is **flagged** instead — each block's left edge carries its own lane
colour, the same vocabulary the card's edge already uses.

A block **folds to one line** unless it is why the card sits in the lane it does,
so a five-branch ticket is ~610px rather than ~950px. The folded line names the
branch, its checkout, and the first thing it has to say. Click to unfold. The plan
picker folds the same way, with the selected file count in its summary.

Each block carries: that branch's PR state and required checks, how far behind
its base it is, an `idle Nd` chip once a PR has gone a day without activity
(amber at 3, red at 7), its local checkout, and why it is in its lane. Plan
files and Jira subtasks belong to the ticket and sit once at the bottom.

Every action names the branch it acts on. The server **refuses** to act on a
multi-branch ticket without one rather than picking — so `update branch` can no
longer read its label off one branch and run against another.

**Checkouts** are matched to branches by name, and a **detached** one — which
is what a review leaves behind — by its HEAD sha against known PR heads, so it
reads `reviewing #7353` on that PR's block rather than appearing as a blank item.
Checkouts no card claims are listed as `free checkouts:` in the masthead, with
their state, so an exhausted pool is visible. A checkout sitting on the default
branch is capacity and gets no card; it used to render as an item titled
`master`.

## Actions

| Action | What it does |
|---|---|
| **open** | New Terminal, `cd` to the checkout, check out the branch if needed, start `claude` with the ticket, branch, PR and selected plan paths in its system prompt — then waits for you to type |
| **`/skill-name`** | The same, but submits `/skill-name TICKET-KEY` immediately. Only skills the server computed as applicable are accepted |
| **review #N** | Appears where a PR awaits **your** review. Resolves a slot, `git fetch` + `git checkout --detach origin/<their-branch>`, and runs `reviewSkill` (default `/critical-review`) with a system prompt stating you are the reviewer, not the author, and must change nothing. Detached on purpose: an accidental commit lands on no branch and cannot reach their PR. One button per reviewable PR, so you pick |
| **update branch (N behind)** | `gh pr update-branch`, then a local `git pull --ff-only` if that branch is checked out. With no PR, `git fetch` + `git merge origin/<base>` locally. Refused on a detached checkout — the merge would land on no branch |
| **resolve conflicts** | Replaces the update button when the PR conflicts, which GitHub can't fix server-side. Opens a Terminal, runs the merge, and hands Claude an instruction based on whether it actually conflicted |
| **squash & merge** | `gh pr merge --squash`, gated (below) |
| **the checkout name** | Click `PY-2` on a block's checkout row to open that folder in your editor. The ticket key opens Jira and the PR number opens GitHub, same idea |

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
| `checkoutMode` | | `slots` (default) or `worktrees` — see below |
| `reviewSkill` | | The skill a **review #N** launch submits. Default `critical-review`. Read from config, never from the request — which is why that route needs no applicability gate |
| `terminalMode` | | `window` (default) or `tab`. Tab opens the session as a tab of the front Terminal window — it needs Accessibility granted to Terminal, and falls back to a window (saying so) if refused |
| `worktreeRoot` | | Where worktrees live. Default `~/.cache/work-dash-worktrees` |
| `humanGateChecks` | | Required checks that are human gates, not CI — they explain a card but never claim to be your move. Default `["QA Code Review"]` |
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

Rules are evaluated **once per branch**, so `slot` and `pr` are singular for
real: on a ticket with a PR on one branch and a checkout on another, the
`pr`-gated skills appear on the first block and the `slot`-gated ones on the
second, each acting on its own branch.

`pr` is deliberately **your own** PR, never a colleague's review request, so a
`pr`-gated skill won't fire on someone else's work. A rule that fails to parse
is skipped with a warning — meaning its button silently never appears, which is
why `doctor` checks every rule.

### Checkout mode: slots or worktrees

Where an agent session runs. Set `checkoutMode` in `config.json`:

**`slots`** (default) — a fixed pool of pre-cloned directories per repo, listed in
`repos.*.slots`. A launch picks a free one, preferring a checkout sitting on
master, and refuses a dirty one. You clone them once, up front; the pool can be
exhausted if you have more work in flight than directories.

**`worktrees`** — one `git worktree` per branch, created on demand under
`worktreeRoot` (default `~/.cache/work-dash-worktrees`), grouped by repo name.
Nothing to pre-clone and no pool to run out of. Needs one clone per repo to
create worktrees from: `repos.*.root`, falling back to the first `slots` entry so
a slots config works unchanged.

New worktrees are created **detached** at `origin/<branch>` (or
`origin/<defaultBranch>` for a ticket with no branch yet). Detached on purpose —
a branch can only be checked out in one worktree at a time, so a launch can never
fail because that branch is open somewhere else; the agent makes a local branch if
it needs to push. Relaunching the same ticket reuses its worktree rather than
making another. Clean worktrees older than 72h are swept on the next launch;
a dirty one is never touched, and `git worktree remove` refuses one anyway.

Worktree mode still shows every directory in `repos.*.slots` as well as the
worktrees it discovers, so switching modes changes where *new* launches go
without hiding checkouts you already have.

### Appearance and polling

Six palettes via the swatches in the controls row — four light grounds
(`ledger` tan, `clay`, `linen`, `sage`) and two dark (`manifest`, `phosphor`) —
stored per browser, defaulting to `ledger`. Deliberately not tied to
`prefers-color-scheme`. Each is one token block in `public/style.css`.

The page polls every 60s, skips it entirely while the tab is hidden, and catches
up when you return if the board is stale. A collection takes ~3.5s: one GraphQL
call for every PR in every repo, then required checks and base comparisons
concurrently.

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
