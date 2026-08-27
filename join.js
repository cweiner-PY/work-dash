// join.js — PURE. No fs, no child_process, no clock.
import { extractKey } from './util/key.js'

function blank(id, key) {
  return { id, key, title: null, repo: null, jira: null, prs: [], slot: null, plans: [], subtasks: [] }
}

// Keyless artifacts are identified by repo + branch so that a PR and a slot
// sitting on the SAME branch become one item rather than two cards.
const keylessId = (repo, branch) => `${repo}:${branch}`

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
  //    PR's card, which is how "PY-1 is holding the review of #7353" becomes visible.
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
      it.slot = slot
      it.repo ??= slot.repo
      it.title ??= slot.branch
      continue
    }

    if (!slot.branch) {
      const pr = slot.headSha ? prByHeadSha.get(slot.headSha) : null
      // Same repo required: an identical sha across repos would be a fork, not this PR.
      if (pr && pr.repo === slot.repo) {
        const it = itemForPr(pr)
        // Annotated on the item's COPY, so the slot list board.js hands to slot resolution
        // stays exactly what the collector read.
        it.slot = { ...slot, holdingPr: pr.number }
        it.repo ??= slot.repo
      }
      continue
    }

    const defaultBranch = config?.repos?.[slot.repo]?.defaultBranch ?? 'master'
    const id = keylessId(slot.repo, slot.branch)
    // Idle only if nothing else already put an item here — a PR or ticket on master would.
    if ((slot.branch === defaultBranch || slot.branch === 'main') && !byId.has(id)) continue

    const it = get(id)
    it.slot = slot
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

  return [...byId.values()]
}
