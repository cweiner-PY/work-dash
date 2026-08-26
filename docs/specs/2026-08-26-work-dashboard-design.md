# work-dash — Design

**Date:** 2026-08-26
**Status:** Approved design, pending implementation plan
**Location:** `/Users/cweiner/Work/work-dash`

## Purpose

One local dashboard that unifies Colt's Jira tickets, GitHub PRs, local
checkouts, and on-disk plans into a single board, grouped by what needs
action. Every item can launch a Claude session in the correct checkout with
the right plan attached, update its branch from master, or squash-merge when
green.

The problem it solves: this work is currently spread across the Jira board,
GitHub's PR list, eight parallel checkouts, and a `docs/` tree, with no single
view. Cross-source facts are invisible — an approved-and-mergeable PR, a
checkout parked on a ticket that shipped weeks ago, a plan that exists for a
ticket you have not started.

## Non-goals

- Not a Jira or GitHub replacement. It links out for anything it does not
  aggregate.
- Not multi-user, not hosted, no auth. Binds to localhost only.
- Does not write to Jira. Status transitions stay in Jira.
- Does not run Claude headlessly. Every Claude invocation opens a Terminal the
  user drives.

## Architecture

A single Node process, no framework and no build step. `work-dash` starts an
HTTP server on `localhost:4200` and opens the browser. The client is one HTML
file plus vanilla JS that polls `/api/items`.

This is a single-user local tool. A bundler would add a build step and buy
nothing; keeping the UI as plain files means it stays editable in place.

```
/Users/cweiner/Work/work-dash/
  README.md
  .gitignore                     # config.json, node_modules, scratch launchers
  config.json                    # gitignored — token, slot pools, skill rules
  config.example.json
  bin/work-dash                  # executable entry point
  server.js                      # http server + routes
  collect/
    jira.js                      # Jira REST
    github.js                    # gh CLI
    slots.js                     # git state per checkout
    plans.js                     # docs/ tree scan
  join.js                        # PURE: sources -> items[]
  lanes.js                       # PURE: item -> lane + reasons[]
  actions/
    open.js                      # Terminal launch (Open and Run)
    update-branch.js             # fetch + merge origin/master
    merge.js                     # gated squash merge
  public/
    index.html  app.js  style.css
  test/
    fixtures/                    # recorded real API responses
    join.test.js  lanes.test.js  actions.test.js
  docs/specs/
```

`join.js` and `lanes.js` are pure functions with no I/O. All the logic that is
actually subtle lives there and is table-testable against fixtures.

## Configuration

Shared values are read from the existing `~/.claude/coltw.config.json` so
nothing is duplicated:

- `docsDir` — `/Users/cweiner/Work/docs`
- `cloudId` — `dae27113-c253-44d8-b982-0a102e6a5113`
- `loganRepo`

Values specific to work-dash live in `work-dash/config.json`, which is
gitignored:

```json
{
  "port": 4200,
  "jiraSite": "https://performyard.atlassian.net",
  "jiraEmail": "cweiner@performyard.com",
  "jiraToken": "<from id.atlassian.com>",
  "jiraProject": "PY",
  "repos": {
    "PerformYard/PerformYard": {
      "docsSubdir": "PY",
      "slots": ["/Users/cweiner/Work/PY-1",
                "/Users/cweiner/Work/PY-2",
                "/Users/cweiner/Work/PY-3"]
    },
    "PerformYard/Logan": {
      "docsSubdir": "Logan",
      "slots": ["/Users/cweiner/Work/Logan",
                "/Users/cweiner/Work/Logan2",
                "/Users/cweiner/Work/Logan3"]
    }
  },
  "inFlightStatusOrder": [
    "In Progress", "In Code Review", "Ready To Test",
    "In Testing", "Ready To Merge"
  ],
  "skills": [
    { "name": "ticket-planner",         "when": "!branch && !pr" },
    { "name": "engineering-subtasking", "when": "!branch && !pr" },
    { "name": "critical-review",        "when": "slot" },
    { "name": "react-doctor",           "when": "slot" },
    { "name": "resolve-code-review",    "when": "pr.hasReviewComments || pr.changesRequested" },
    { "name": "pr-description",         "when": "pr" },
    { "name": "ticket-finisher",        "when": "pr" },
    { "name": "toggle-logan-env",       "when": "repo == 'PerformYard/Logan'" }
  ]
}
```

`/Users/cweiner/Work/PerformYard` and `/Users/cweiner/Work/QA` are
deliberately excluded from the slot pools — they stay as pristine copies.

Slot pools and skill rules are config, not code, so they can be retuned
without editing source.

The `when` strings are evaluated by a small purpose-built predicate parser, not
`eval`. Supported grammar: identifier paths (`pr.changesRequested`), `!`,
`&&`, `||`, `==` and `!=` against single-quoted literals, and parentheses. An
unparseable rule logs a warning and hides that skill rather than throwing.

## Data collection

Four collectors run on each refresh (60s poll, plus a manual refresh button).
Each is independent; one failing does not block the others.

### `collect/jira.js`

Primary query, via `POST /rest/api/3/search/jql` with basic auth
(`jiraEmail:jiraToken`):

```
assignee = currentUser() AND project = PY AND statusCategory != Done
```

`project = PY` is the whole filter. Logan work is tracked under PY keys too
(e.g. PY-13247 "Use the same Package Manager everywhere in Logan"), so one
project covers both repos. This also excludes the QTM project, which
contributes 26 Test Execution items that are not development work.

**Enrichment pass.** Keys discovered from branches, PRs, or plan folders that
the primary query did not return are fetched with a second call:

```
key in (PY-13888, PY-13044, PY-13925, PY-12275)
```

returning `summary`, `status`, `assignee`. This pass is not optional — it is
what makes in-flight Jira statuses displayable and what makes stale-slot
detection possible. Verified 2026-08-26: of the four keys above, PY-13888 is
*Ready To Test* assigned to Bruce Pereira, PY-13925 is *Done* assigned to Lucy
Murphy, and PY-13044 and PY-12275 are *Done*. None appear in the primary
query, so without enrichment all four would render with no status at all.

Returns per issue: `key`, `summary`, `status`, `statusCategory`, `issuetype`,
`priority`, `assignee`, `url`, `isMine`.

### `collect/github.js`

Uses the `gh` CLI (already authed as `cweiner-PY`, scopes `repo`, `read:org`,
`workflow`). Per repo:

```
gh pr list --repo <repo> --author @me --state open \
  --json number,title,headRefName,reviewDecision,mergeable,isDraft,\
         statusCheckRollup,updatedAt,url,comments
gh pr list --repo <repo> --search "review-requested:@me" --state open --json ...
```

Per-repo `gh pr list` is used rather than `gh search prs`: the latter errors
when `--json repository` is requested (verified 2026-08-26).

For any PR that is a squash-merge candidate, required-check state comes from a
separate call:

```
gh pr checks <n> --repo <repo> --required
```

The distinction matters. On PR #7230 the full check list shows nine failing
Unit Tests, but none are required; the only failing *required* check is "QA
Code Review". Merge gating reads required checks only, while the card displays
both counts.

### `collect/slots.js`

For each configured slot directory: current branch, dirty flag
(`git status --porcelain`), and ahead/behind counts against `origin/master`
(`git rev-list --left-right --count`). Read-only; never fetches as a side
effect of collection.

### `collect/plans.js`

Scans `<docsDir>/{PY,Logan}/*` for folders. Folder names follow
`PY-12579:Title-Slug`, so the leading key is extracted where present. Returns
the folder path and the `.md` files inside (`plan.md`, `code-review.md`,
`notes.md`, `findings.md`, `implementation-plan.md`, `decisions.md`, …).

## The join

Key extraction uses `/\b(PY|LOGAN)-\d+\b/i` applied to: the Jira key, the PR
head branch name (falling back to PR title), the slot's current branch name,
and the plan folder name.

**The board is a union keyed on ticket, not a Jira list with decorations.**
Any of the four sources can bring an item into existence. This is required by
observed reality: four active branches point at keys absent from the
assigned-open Jira query, and PR #7306 is open against a ticket marked Done.

Artifacts with no extractable key still become items, identified by
`repo#number` (PRs) or `dir:branch` (slots).

Item shape:

```js
{
  id,                    // key, or repo#number, or dir:branch
  key,                   // "PY-12746" | null
  title,
  repo,                  // "PerformYard/PerformYard" | null
  jira:  { status, statusCategory, type, priority, assignee, isMine, url } | null,
  prs:   [ { repo, number, title, headRefName, reviewDecision, mergeable,
             isDraft, checks: {pass, fail, pending},
             requiredChecks: {pass, fail, failing: []},
             hasReviewComments, url } ],
  slot:  { dir, branch, dirty, ahead, behind } | null,
  plans: [ { dir, files: [] } ],
  lane,
  reasons: []            // why it landed in that lane; rendered on the card
}
```

## Lanes

First match wins. Every item carries `reasons[]` so each card explains itself.

1. **Needs you** — any of: a required check failing · `CHANGES_REQUESTED` ·
   `APPROVED` and `MERGEABLE` with required checks green (go merge) ·
   `mergeable == CONFLICTING` · review requested of you · Jira Done while a PR
   is still open
2. **Waiting on others** — PR open, `REVIEW_REQUIRED`, required checks green,
   not draft
3. **In flight** — has a slot or a draft PR, nothing demanding. Sub-grouped by
   Jira status in `inFlightStatusOrder`, with an untracked subgroup for items
   with no Jira status
4. **Ready to start** — Jira in the To Do category *and* a plan exists on disk
5. **Backlog** — everything else

### Derived signals

- `foreign` — Jira assignee is not the user
- `stale` — Jira status category is Done
- `reclaimable` — a slot holds a branch whose ticket is `stale` or `foreign`
  and has no open PR of the user's

`reclaimable` is high-value given a fixed pool of six checkouts. As of
2026-08-26 it is true for three of five occupied slots (PY-1 holds Bruce's
Ready-To-Test ticket; PY-3 and Logan2 hold Done tickets).

## Default view filter

The board defaults to **assigned to me and in progress** — Jira's
`In Progress` status category, which covers In Progress, In Code Review, Ready
To Test, In Testing, and Ready To Merge. Two checkboxes reveal the rest:

- **Show backlog** — To Do category items (ready-to-start and backlog lanes)
- **Show stale slots** — items flagged `stale` or `foreign`

Hidden counts are always displayed, so nothing disappears silently: the header
reads e.g. `6 backlog · 3 stale slots · 2 keyless PRs`. Collection is
unfiltered; this is a display filter only, so toggling never triggers a fetch.

## Actions

### Open

Prepares the environment and hands over the keyboard.

1. Resolve the slot (see Slot policy).
2. Write a launcher script to the scratchpad.
3. `osascript -e 'tell application "Terminal" to do script "bash <launcher>"'`

The launcher:

```bash
cd /Users/cweiner/Work/PY-2 \
  && git checkout PY-12746-competency-management-prototype-competency-catalog \
  && claude -n "PY-12746" \
       --add-dir "/Users/cweiner/Work/docs/PY/PY-12746:Competency-Catalog" \
       --append-system-prompt "Active ticket: PY-12746 — <summary>.
Jira status: In Progress. Branch: <branch>. PR: #7110 <url>.
Plan files: <selected paths>. Read the plan before acting."
```

Claude opens with the ticket, branch, PR, and plan already in its system
prompt, awaiting the user's first message. No turn is consumed loading
context.

A launcher script is used rather than inlining the command into the AppleScript
string, because nesting shell quoting inside AppleScript quoting inside the
`claude` argument is error-prone with ticket titles that contain apostrophes,
colons, or quotes.

### Run

Identical to Open, with the skill command appended as the positional prompt so
it submits immediately:

```bash
  ... claude -n "PY-12746" --add-dir ... --append-system-prompt "..." \
       "/ticket-finisher PY-12746"
```

One flag's difference between the two modes. Both are interactive Terminal
sessions the user controls; neither runs headless.

### Update branch

`git fetch origin && git merge origin/master`, run in the item's slot.

Merge rather than rebase: these branches are pushed and have open PRs, so
rebasing would require a force-push. Refuses when the working tree is dirty or
the merge conflicts — never stashes, never forces. The card surfaces the
reason and offers `[open in terminal]` to resolve by hand.

### Squash and merge

Available on items whose PR passes **all four** gates:

| Gate | Source |
|---|---|
| `reviewDecision == APPROVED` | `gh pr list` |
| `mergeable == MERGEABLE` | `gh pr list` |
| not draft | `gh pr list` |
| every required check passes | `gh pr checks --required` |

Pass → `[squash & merge]` is live, and runs
`gh pr merge <n> --repo <repo> --squash`. A confirmation dialog echoes the PR
number and title first, because the action is irreversible and public.

Fail → the button is disabled and shows the blocking reason verbatim, e.g.
`required check failing: QA Code Review`.

Never merges automatically on a poll. Always an explicit click.

### Plan attachment

Each card lists the `.md` files found in the item's plan folder as checkboxes,
all checked by default. Checked files are passed via `--add-dir` on the folder
and named explicitly in the `--append-system-prompt` text. `--add-dir` is
required because `docs/` lives outside every repo.

## API

| Route | Purpose |
|---|---|
| `GET /api/items` | The joined, laned board plus per-source freshness and errors |
| `POST /api/open` | `{id, plans[]}` — resolve slot, launch Terminal, no skill |
| `POST /api/run` | `{id, skill, plans[]}` — same, with the skill auto-submitted |
| `POST /api/update-branch` | `{id}` — fetch and merge `origin/master` in the slot |
| `POST /api/merge` | `{repo, number}` — gated squash merge |
| `POST /api/refresh` | Force an immediate re-collection |
| `GET /api/slots` | Slot inventory, for the picker when none are free |

All mutating routes return `{ok, message, detail}`. The server binds to
`127.0.0.1` only.

## Slot policy

Open and Run perform a checkout, so this is the highest-risk path in the
system. Resolution order:

1. The branch is already checked out in some slot → **use that slot**.
2. Otherwise pick a free slot from the repo's pool. Free means a clean working
   tree *and* (currently on master, or holding a `stale`/`foreign` ticket).
   Prefer the stalest.
3. No free slot → **show a picker** listing every slot with its branch, dirty
   state, and why it was not eligible. The user chooses.
4. **Never** check out over a dirty working tree, under any path.

## Error handling

Collectors fail independently. An expired Jira token leaves a working
GitHub-and-git board with a banner reading `Jira unavailable — check token`,
not a blank page. The header shows per-source freshness and status.

Actions return `{ok, message, detail}`. Failures render inline on the
originating card; nothing fails silently. Git and merge actions refuse rather
than force when preconditions are unmet.

## Testing

- **`join.js` and `lanes.js`** — pure, table-driven tests over fixtures
  recorded from real responses on 2026-08-26. The fixture set already covers
  every hard case found while designing: foreign assignee, Done ticket with an
  open draft PR, keyless PR (Logan #704), branch key absent from the primary
  JQL, and non-required checks failing while required ones pass. A synthetic
  fixture covers one key with multiple PRs, which has not occurred in the live
  data but the join must handle.
- **Collectors** — unit tests against recorded fixtures; no live calls in the
  test suite.
- **Actions** — honor `WORK_DASH_DRY=1`, logging the composed command instead
  of executing it. Covers the launcher-script contents, the merge gate
  decision, and the dirty-tree refusal without side effects.
- **Manual smoke** — run against live data and compare the rendered board to
  the hand-built table in this spec.

## Setup requirement

A Jira API token must be created at `id.atlassian.com` and placed in
`work-dash/config.json`. The Atlassian MCP cannot be used: MCP tools exist
only inside a Claude session and are unreachable from a standalone server
process.
