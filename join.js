// join.js — PURE. No fs, no child_process, no clock.
import { extractKey } from './util/key.js'

function blank(id, key) {
  return { id, key, title: null, repo: null, jira: null, prs: [], branches: [], plans: [], subtasks: [] }
}

// Keyless artifacts are identified by repo + branch so that a PR and a slot
// sitting on the SAME branch become one item rather than two cards.
const keylessId = (repo, branch) => `${repo}:${branch}`

// THE BRANCH IS THE UNIT OF WORK. A ticket can carry several — that is how a big feature
// gets split into separately reviewable pieces — and each one has its own PR, its own
// checkout, or both. Before this existed the item had a scalar `slot` and consumers took
// `prs[0]`, so a second branch either overwrote the first or was silently ignored: the
// card's PR row and its checkout row could describe two different branches with nothing
// saying so, and a second PR's failing checks produced no text anywhere on the board.
//
// Keyed by repo AND name: one Jira key can legitimately have a branch of the same name in
// two repositories, and those are two different pieces of work.
const branchOf = (it, repo, name) => {
  let b = it.branches.find((x) => x.name === name && x.repo === repo)
  if (!b) { b = { name, repo, pr: null, slot: null, detached: false }; it.branches.push(b) }
  return b
}

// CREATION ORDER, first branch to last. The blocks on a card must never be sorted by urgency:
// the branches of one feature are sequential — pr3 builds on pr2 — so floating the urgent one
// to the top would show pr3 above pr2 and lie about the shape of the work. Urgency is flagged
// on the block instead.
//
// PR number ascending IS creation order: numbers are monotonic per repository, so this needs no
// extra collection. The order it replaces was arbitrary — `prs` arrives from a GraphQL `search`
// with no `sort`, so GitHub returns relevance order and it could change between refreshes: the
// same root cause as the `prs[0]` bug this whole structure exists to fix.
//
// A branch with no PR sorts last: nothing has been submitted for it, so it is the newest thing
// here. The case that rule gets wrong — a branch started first that never got a PR — is accepted
// deliberately. There is no cheap, reliable creation time for a bare branch, and inventing one
// from a checkout's mtime would mix two unrelated clocks.
//
// Exported so the tests order their inputs with the real comparator rather than a copy of it.
export function orderBranches(branches) {
  return [...branches].sort((a, b) =>
    String(a.repo ?? '').localeCompare(String(b.repo ?? '')) ||
    (a.pr?.number ?? Infinity) - (b.pr?.number ?? Infinity) ||
    String(a.name ?? '').localeCompare(String(b.name ?? '')))
}

export function join({ jira = [], enrichment = [], prs = [], slots = [], plans = [], subtasks = [], config }) {
  const byId = new Map()
  const get = (id, key = null) => {
    let it = byId.get(id)
    if (!it) { it = blank(id, key); byId.set(id, it) }
    return it
  }

  // 1. Jira, primary then enrichment. Primary wins on conflict.
  for (const issue of [...enrichment, ...jira]) {
    const it = get(issue.key, issue.key)
    it.jira = { ...issue, isMine: issue.assigneeAccountId === config.myAccountId }
    it.title = issue.summary
  }

  // 2. PRs. Key from head branch, falling back to title.
  for (const pr of prs) {
    const key = extractKey(pr.headRefName) ?? extractKey(pr.title)
    const it = key ? get(key, key) : get(keylessId(pr.repo, pr.headRefName))
    it.prs.push(pr)
    branchOf(it, pr.repo, pr.headRefName).pr = pr
    it.repo ??= pr.repo
    it.title ??= pr.title
  }

  // 3. Slots. Repo comes from which configured pool owns the directory.
  //
  // A slot only becomes an ITEM when it represents work. Two kinds do not:
  //
  //  - A DETACHED checkout has no branch to match on, so `keylessId(repo, null)` used to
  //    manufacture an item literally called "Owner/Repo:null" with no key and no title, and
  //    two detached checkouts in one repo collided into the same one. It is identified by
  //    its HEAD sha instead: if that is the head of a known PR, the slot belongs on that
  //    PR's branch, which is how "PY-1 is holding the review of #7353" becomes visible.
  //  - A slot sitting on the repo's DEFAULT BRANCH is spare capacity, not work in flight.
  //    It used to render as a card titled "master".
  //
  // Either way, an unattached slot is not lost — board.js reports whatever no item claimed.
  const prByHeadSha = new Map()
  for (const pr of prs) if (pr.headSha) prByHeadSha.set(pr.headSha, pr)
  const itemForPr = (pr) => {
    const k = extractKey(pr.headRefName)
    return k ? get(k, k) : get(keylessId(pr.repo, pr.headRefName))
  }

  for (const slot of slots) {
    const key = extractKey(slot.branch)
    if (key) {
      const it = get(key, key)
      branchOf(it, slot.repo, slot.branch).slot = slot
      it.repo ??= slot.repo
      it.title ??= slot.branch
      continue
    }

    if (!slot.branch) {
      const pr = slot.headSha ? prByHeadSha.get(slot.headSha) : null
      // Same repo required: an identical sha across repos would be a fork, not this PR.
      if (pr && pr.repo === slot.repo) {
        const it = itemForPr(pr)
        const b = branchOf(it, pr.repo, pr.headRefName)
        // Annotated on the item's COPY, so the slot list board.js hands to slot resolution
        // stays exactly what the collector read.
        b.slot = { ...slot, holdingPr: pr.number }
        // The checkout is on this branch's commit without being ON the branch — which is
        // what a review leaves behind, and why it must never be offered as "already on it".
        b.detached = true
        it.repo ??= slot.repo
      }
      continue
    }

    const defaultBranch = config?.repos?.[slot.repo]?.defaultBranch ?? 'master'
    const id = keylessId(slot.repo, slot.branch)
    // Idle only if nothing else already put an item here — a PR or ticket on master would.
    if ((slot.branch === defaultBranch || slot.branch === 'main') && !byId.has(id)) continue

    const it = get(id)
    branchOf(it, slot.repo, slot.branch).slot = slot
    it.repo ??= slot.repo
    it.title ??= slot.branch
  }

  // 4. Plans, by key only. An item may collect several folders.
  const plansByKey = new Map()
  for (const p of plans) {
    if (!p.key) continue
    if (!plansByKey.has(p.key)) plansByKey.set(p.key, [])
    plansByKey.get(p.key).push(p)
  }
  for (const it of byId.values()) {
    if (it.key && plansByKey.has(it.key)) it.plans = plansByKey.get(it.key)
  }

  // 5. Subtasks, by parentKey. A subtask whose parent key matches no item on the
  // board simply has nowhere to attach — it does not create one (see board.js:
  // orphan subtasks must never pull their parent onto the board as an item).
  const subtasksByParent = new Map()
  for (const s of subtasks) {
    if (!s.parentKey) continue
    if (!subtasksByParent.has(s.parentKey)) subtasksByParent.set(s.parentKey, [])
    subtasksByParent.get(s.parentKey).push(s)
  }
  for (const it of byId.values()) {
    if (it.key && subtasksByParent.has(it.key)) it.subtasks = subtasksByParent.get(it.key)
  }

  // 6. `branches` is NEVER empty. A To Do ticket with no PR and no checkout still gets one
  // entry with a null name, so every consumer — the lane fold, the skill predicates, the
  // action routes, the card render — has exactly ONE shape to handle instead of a scalar
  // case and a plural case. It is also what keeps a single-branch item behaving exactly as
  // it did when `slot` was scalar, which is why converting the consumers stayed safe.
  for (const it of byId.values()) {
    if (it.branches.length === 0) it.branches.push({ name: null, repo: it.repo, pr: null, slot: null, detached: false })
    it.branches = orderBranches(it.branches)
  }

  return [...byId.values()]
}
