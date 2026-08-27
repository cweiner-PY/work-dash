# work-dash

A local dashboard that unifies Jira tickets, GitHub PRs, local git checkouts,
and on-disk plan folders into one board, grouped by what needs action.

It runs as a single Node HTTP server with no build step and no external
services beyond Jira's REST API and the `gh` CLI. The server binds to
`127.0.0.1` only.

**macOS only, currently.** The **open** and **run** actions launch a new
Terminal window via `osascript`/AppleScript (`tell application "Terminal"`),
so those two actions require macOS. Everything else — collecting the board,
**update branch**, **squash & merge** — has no such dependency.

## Setup

1. **Node >= 20.11.** The code uses `import.meta.dirname`, which requires
   that version or later.

2. **`gh` must be authenticated:**

   ```
   gh auth status
   ```

   Required-check reading (and therefore the merge gate) depends on it — see
   Troubleshooting below for what happens when it isn't.

3. **Copy the example config:**

   ```
   cp config.example.json config.json
   ```

   `config.json` is gitignored; never commit it.

4. **Create a Jira API token** at
   <https://id.atlassian.com/manage-profile/security/api-tokens> and put it
   in `config.json` as `jiraToken`.

5. **Get the Jira email right.** This is the setting most likely to trip
   people up. Jira's basic auth wants the email your *Atlassian account*
   actually uses to sign in — which is not always your work address. Test a
   candidate email/token pair directly:

   ```
   curl -u 'you@example.com:YOUR_TOKEN' https://your-site.atlassian.net/rest/api/3/myself
   ```

   HTTP 200 means that email is the right one; HTTP 401 means it isn't, even
   if the token is otherwise valid. (Confirmed against the live API for this
   setup: the same Atlassian account, same token, returns 401 for the work
   address and 200 for a different address — `accountId
   62b43cb267dff38e0988a3bc` either way.)

6. **Fill in the rest of `config.json`:**
   - `jiraSite` — your Jira base URL.
   - `jiraProject` — the project key to pull tickets from.
   - `myAccountId` — your Jira `accountId`, visible in the `/myself` response
     above or in any issue JSON under `fields.assignee.accountId`.
   - `repos` — a map of `"Owner/Repo"` to `{ docsSubdir, slots: [...] }`,
     where `slots` is the list of local checkout directories work-dash is
     allowed to inspect and drive for that repo, and `docsSubdir` is the
     subdirectory of the shared `docsDir` (see below) holding that repo's
     plan folders. A repo entry may also set `defaultBranch` (defaults to
     `master`) — it's the branch `collect/slots.js` measures "behind" against
     and the one `update branch` merges from.
   - `port` — what the server listens on. `config.example.json` defaults to
     `4200`; this isn't a hard-coded value the app assumes — it's whatever
     `config.json` sets it to (this checkout runs it on `4210`).
   - `inFlightStatusOrder` and `skills` are optional and have defaults — see
     `config.example.json` for their shape. `skills` maps skill names to a
     small predicate language (`&&`, `||`, `!`, `==`, `!=`, dotted field
     paths like `pr.changesRequested`) evaluated against each item to decide
     which skills to offer for it.
   - `githubLogin` (optional) — your GitHub login, used only to tell your own
     PR replies and comments apart from a human teammate's review feedback.

7. **Shared config.** `docsDir` (and optionally `cloudId`) come from
   `~/.claude/coltw.config.json`, not from `config.json` — this file is
   expected to be shared across tools on the machine, not maintained per
   project. `docsDir` must be set or the server refuses to start.

If any required key is missing from either file, the server prints exactly
which one and exits rather than starting in a half-configured state.

## Running

```
node server.js
# or, if installed as a bin:
work-dash
```

Then open `http://127.0.0.1:<port>` (the port from `config.json`).

### Appearance

Six palettes, picked with the swatches at the right of the controls row: four light
grounds (`ledger` tan, `clay` rose-grey, `linen` putty, `sage` green-grey) and two dark
(`manifest` charcoal, `phosphor` CRT). The choice is stored per browser in
`localStorage` under `work-dash:palette`; `ledger` is the default.

The palette is deliberately NOT derived from `prefers-color-scheme`. That signal answers
to both the macOS appearance schedule and Chrome's own theme setting, so a board keyed
to it changes look on its own for reasons that have nothing to do with the board.

Each palette is one token block in `public/style.css`; every rule in that file reads
tokens rather than colour literals, so adding a seventh is a block plus one string in
`PALETTES` in `public/app.js`.

### Time, polling and notifications

The board shows how long each PR has sat without activity — a push, a comment, a
review — as an `idle Nd` chip, quiet at 1–2 days, amber from 3, red from 7.
Nothing under a day, because `idle 2h` on every card is noise rather than
information. Without it a PR awaiting review since last Tuesday looked exactly
like one opened this morning, which is the difference between ignoring it and
going to nudge someone.

The page polls every 60s, matching the server's cache TTL, so essentially every
tick really does re-collect: about 10 `gh` invocations plus the Jira calls. It
skips the poll entirely while the tab is hidden, and catches up the moment you
look at it again — but only if what's on screen is older than one poll, so
flicking between tabs doesn't fire a collection each time. An unrecognised
`visibilityState` polls rather than not, since silently never updating again is
the worse failure.

When an item **newly enters** the needs-you lane you get a macOS notification:
one item is named with its reason, several become a single roll-call. It fires
from the one place a real collection happens, so it runs once per collection
however many polls asked for one, and the first collection after startup
announces nothing — otherwise launching the dashboard would notify you about
everything at once. The notification text is passed to `osascript` as arguments
rather than interpolated into AppleScript, since ticket summaries contain quotes
and backslashes. Set `"notifications": false` in `config.json` to silence it.

## Lanes

The board sorts every item into exactly one of five lanes:

| Lane | Meaning |
|---|---|
| **Needs you** | Any of: a review is requested of you; the ticket is Done but your PR is still open; a **required** check is failing; changes were requested on your PR; your PR conflicts with the default branch; or your PR is approved and mergeable and just needs the merge button pressed. |
| **Waiting on others** | Your PR is open, not a draft, awaiting review, and has no failing required checks. |
| **In flight** | The item has a local checkout, or a draft PR. Sub-grouped by Jira status, ordered by `inFlightStatusOrder`; statuses not in that list sort last. |
| **Ready to start** | The ticket's status category is "To Do" and it has at least one plan folder on disk. |
| **Backlog** | Everything else. |

The default view hides backlog/ready-to-start items and "stale" items
(assigned to someone else, or whose ticket is already Done) — the "show
backlog" and "show stale slots" checkboxes reveal them. Whatever is hidden is
always counted, e.g. "6 backlog · 3 stale", so nothing disappears silently.

## Actions

- **open** — opens a new Terminal window, `cd`s into the resolved checkout,
  checks out the item's branch only if the checkout isn't already on it, and
  starts `claude` there with the ticket key, Jira status/URL, branch, PR
  link, and any attached plan file paths written into its system prompt (and
  granted as `--add-dir` for the plan directories).
- **the checkout name on the slot row** (`PY-2`, `Logan3`) — click it to open
  that folder in your editor. It follows the card's two other clickable
  identifiers: the ticket key opens Jira, the PR number opens GitHub, the
  checkout opens the editor. A `<button>` styled as text rather than an `<a>`,
  since it performs an action instead of navigating.

  Runs `open -a <editor> <dir>` and nothing else: no git, no checkout, no slot
  resolution, and no board refresh afterwards — opening a folder changes nothing
  the board reports, so re-collecting would cost ~6s of live API calls for
  nothing. Because it mutates nothing it is the one action safe to fire at a
  dirty checkout, which is exactly when you want it.

  `open -a` rather than a `cursor`/`code` CLI shim, since those are optional
  installs while the .app is what actually exists; macOS resolves the name, so
  `"editor": "Zed"` in `config.json` is the whole change needed to switch.
- **`/skill-name`** (the `run` action) — the same as open, but also submits
  a skill immediately, as `/skill-name TICKET-KEY`. Only skills the server
  computed as applicable to that item (via the `skills` predicates in
  config) are accepted.
- **update branch (N behind)** — for a PR, `gh pr update-branch`, then a local
  `git pull --ff-only` if the branch happens to be checked out (never a merge,
  never a force). With no PR, `git fetch origin` then
  `git merge origin/<defaultBranch>` in the item's checkout. Refuses outright
  if the working tree is dirty; it never rebases, stashes, force-pushes, or
  aborts a conflicted merge. If the merge conflicts, the repo is left exactly
  as git left it, for you to resolve by hand.

  The count comes from GitHub's own `Ref.compare`, **not** from
  `mergeStateStatus`. That field answers "can this merge", not "is this
  behind": `BEHIND` is only reported when branch protection requires branches
  be up to date, and `BLOCKED`/`DIRTY` outrank it. Reading it as a
  behind-signal once made the board show "up to date" on a PR 24 commits
  behind master. A comparison that can't be read shows **behind state
  unknown** and disables the button, rather than guessing zero.
- **resolve conflicts** — replaces the update button when the PR conflicts
  with its base, which GitHub cannot fix server-side. Opens a Terminal in the
  checkout, runs `git fetch` and `git merge origin/<base>`, then starts
  `claude` **with an instruction submitted immediately** — like the run-skill
  action, not like `open`, which deliberately waits for you to type.

  Which instruction depends on how the merge actually went: the script branches
  on the merge's exit status, so a merge that stops on conflicts tells Claude to
  resolve them and commit, while one that merges cleanly tells Claude to confirm
  and stop. GitHub's `DIRTY` can be stale, so the clean case is real and an
  unconditional "resolve the conflicts" would send Claude hunting through a
  clean tree. If a skill is also supplied it takes the prompt slot instead, since
  a skill is something you asked for by name.

  The merge sits in an `if` rather than being run bare: `set -euo pipefail` is on,
  and a conflicting merge — the entire point — would otherwise kill the launcher
  before Claude started. Clicking again on a still-conflicted tree is safe: the
  slot resolves because it is already on the branch, and git's refusal to merge
  over unmerged files lands on the same resolve instruction. The base branch is
  derived server-side from your own PR; the client sends only a boolean.
- **squash & merge** — `gh pr merge --squash`. The button reflects the merge
  gate (below) but the server re-checks it independently before running
  anything, requires an explicit confirmation, and refuses to merge a PR you
  don't own.

### The merge gate

A PR is mergeable only when **all** of these hold:
- it's approved (`reviewDecision === 'APPROVED'`),
- GitHub reports it as `MERGEABLE`,
- it isn't a draft,
- the required-check list was actually read (not merely absent/unknown), and
- every check in that list passed.

Two things worth being explicit about, both verified against real PRs in
this setup:
- **Only required checks gate the merge.** A PR can have several failing
  *non-required* checks and still be offered for merge if the one required
  check on it passes — confirmed on a live PR with 2 failing non-required
  checks and 1 failing required check, where only the required failure
  blocked the button.
- **A repo with no required checks configured merges on its own merits.**
  One of the two repos here configures none; PRs on it are gated only by
  approval, mergeability, and draft status.

## Safety guarantees

- `collect/slots.js` is read-only: the only git commands it ever runs
  against your checkouts are `git branch --show-current`,
  `git status --porcelain`, and
  `git rev-list --left-right --count <base>...HEAD`.
- **update branch** refuses when the working tree is dirty, and never
  rebases, stashes, force-pushes, or aborts a conflicted merge. On conflict
  it leaves the repo exactly as git left it.
- **open**/**run** never check out a branch over uncommitted changes, and
  never operate on a checkout that belongs to a different repository than
  the item being opened.
- **squash & merge** requires an explicit confirmation from the caller,
  re-checks the merge gate on the server regardless of what the UI showed,
  and refuses to merge a PR authored by someone other than you.
- The server binds `127.0.0.1` only. The Jira token is stripped from every
  config response (`GET /api/config`) and redacted out of Jira error
  messages before they're surfaced.

## Troubleshooting

**The board is empty and I know I have tickets assigned.** Jira's search
endpoint answers an unauthenticated (or wrong-email) request with HTTP 200
and zero issues — not an error. work-dash knows this: whenever the primary
Jira query comes back with zero issues, it separately calls `/rest/api/3/myself`
to verify the credentials, and reports a credentials error (naming the likely
cause — email vs. work address) instead of quietly showing a blank board. If
you see that error, re-check `jiraEmail` against the Setup step above.

**A PR's merge button won't enable and I don't know why.** Read the reason
shown for it — the gate lists every blocker, not just the first one it
finds. If it says the required-check status is unknown, that most often
means `gh` isn't authenticated or a `gh pr checks` call failed; work-dash
treats an unreadable check list as blocking, not as "assume it's fine",
because guessing wrong here would let a broken PR merge silently.

**`gh` isn't authenticated.** Run `gh auth status`. Without it, work-dash
can still list PRs but records an error for the ones whose required-check
state it couldn't read, and refuses to offer a merge for those PRs rather
than treating the unknown state as clean.

## Development

```
node --test                       # full 175-test suite, no network calls
WORK_DASH_DRY=1 node server.js     # actions log their commands instead of running them
```

`join.js` and `lanes.js` are pure functions (no fs, no child_process, no
clock) and are tested against real recorded fixtures in `test/fixtures/`
(actual Jira and `gh` responses, sanitized). The collectors and actions take
their `run`/`fetch` dependency as an injectable argument, which the tests
replace with fakes. Each action also takes a `dry` flag, checked before it
runs any command; `WORK_DASH_DRY=1` sets that flag at server startup, so
every action returns what it *would* do — the resolved checkout, the git
commands, the `gh` invocation — without touching git, GitHub, or opening a
Terminal.
