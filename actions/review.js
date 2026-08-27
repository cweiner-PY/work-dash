// actions/review.js
//
// Launching a review of someone ELSE's pull request. Deliberately its own action rather than
// a flag on open, because the job is the opposite one: open works your ticket on your branch,
// this reads a colleague's branch and changes nothing.

// Which PR is being reviewed. Only PRs the collector marked as not the user's own are
// eligible — reviewing your own PR through this path would check your branch out detached
// and tell Claude not to touch it, which is never what anyone wants.
export function reviewablePrs(item) {
  return (item?.prs ?? []).filter((p) => p.isMine === false)
}

// prNumber comes from the client, so it is matched against the item's OWN review PRs rather
// than trusted — otherwise a raw call could name any number and have it quoted into a prompt
// and a branch name.
export function pickReviewPr(item, prNumber = null) {
  const candidates = reviewablePrs(item)
  if (!candidates.length) {
    return { error: `${item?.key ?? item?.id} has no PR awaiting your review.` }
  }
  if (prNumber == null) {
    if (candidates.length === 1) return { pr: candidates[0] }
    return {
      error: `${candidates.length} PRs await your review here — say which: ` +
             candidates.map((p) => `#${p.number}`).join(', '),
      candidates: candidates.map((p) => ({ number: p.number, repo: p.repo, title: p.title })),
    }
  }
  const pr = candidates.find((p) => p.number === prNumber)
  if (!pr) return { error: `#${prNumber} is not a PR awaiting your review on ${item?.key ?? item?.id}.` }
  return { pr }
}

// A review cannot proceed without a branch to check out — the whole point is reading the
// author's code at their head.
export function reviewTarget(pr) {
  if (!pr?.headRefName) return { error: `#${pr?.number} does not name a branch to check out.` }
  return {
    review: {
      number: pr.number, repo: pr.repo, headRefName: pr.headRefName,
      title: pr.title ?? null, url: pr.url ?? null, author: pr.author ?? null,
    },
  }
}
