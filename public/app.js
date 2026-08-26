// public/app.js
const LANES = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'waiting', label: 'Waiting on others' },
  { id: 'in-flight', label: 'In flight' },
  { id: 'ready-to-start', label: 'Ready to start' },
  { id: 'backlog', label: 'Backlog' },
]

export function groupForDisplay(items, { showBacklog, showStale }) {
  const hidden = { backlog: 0, stale: 0, total: 0 }
  const visible = items.filter((i) => {
    const isBacklogish = i.lane === 'backlog' || i.lane === 'ready-to-start'
    const isStale = i.signals.stale || i.signals.foreign
    if (!showBacklog && isBacklogish) { hidden.backlog++; hidden.total++; return false }
    // A needs-you item is never hidden by the stale/foreign filter — "ticket is Done but
    // the PR is still open" is precisely the cross-source insight this tool exists to
    // surface, and it must not look identical to "nothing to do" by default.
    if (!showStale && isStale && i.lane !== 'needs-you') { hidden.stale++; hidden.total++; return false }
    return true
  })

  // Anything whose lane is not one of the five known ids still gets rendered, under a
  // catch-all group. Dropping it would be a silent data loss, and this dashboard's whole
  // value rests on the board being a complete picture of outstanding work. Unreachable
  // today (lanes.js defaults to 'backlog'), but the failure direction must be "show
  // something unexpected", never "quietly lose work".
  const KNOWN = new Set(LANES.map((l) => l.id))
  const orphans = visible.filter((i) => !KNOWN.has(i.lane))

  const lanes = []
  for (const lane of LANES) {
    const mine = visible.filter((i) => i.lane === lane.id)
    if (!mine.length) continue
    if (lane.id !== 'in-flight') { lanes.push({ ...lane, items: mine, subgroups: null }); continue }
    const byStatus = new Map()
    for (const i of mine) {
      if (!byStatus.has(i.statusGroup)) byStatus.set(i.statusGroup, { label: i.statusGroup, sortIndex: i.sortIndex, items: [] })
      byStatus.get(i.statusGroup).items.push(i)
    }
    const subgroups = [...byStatus.values()].sort((a, b) => {
      if (a.label === 'no ticket') return 1
      if (b.label === 'no ticket') return -1
      if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex
      return a.label.localeCompare(b.label)
    })
    lanes.push({ ...lane, items: null, subgroups })
  }
  if (orphans.length) {
    lanes.push({ id: 'other', label: 'Other (unrecognised lane)', items: orphans, subgroups: null })
  }
  return { lanes, hidden }
}

// board.js's source() can report three distinguishable states: ok:true/error:null,
// ok:true/error:"..." (the collector returned data but recorded partial failures — a
// degraded source, not a failed one), and ok:false. All three must look different on
// screen; a degraded source rendering identically to a healthy one hides exactly the
// kind of partial failure this dashboard exists to surface.
export function sourceChip(name, s) {
  const cls = s.ok ? (s.error ? 'warn' : 'ok') : 'bad'
  const text = `${name} ${s.ok ? s.count : 'unavailable'}${s.ok && s.error ? ' (degraded)' : ''}`
  return { cls, text, error: s.error ?? null }
}

// A PR whose required-check state could not be read (known !== true) must never render
// as the confident "no required checks" — the merge gate already fails safe on this
// case (see mergeGateFor), and the card must not contradict it. known is checked first,
// before total/failing/pending, so that distinction survives to the last rendering step.
export function prChecksChip(rc) {
  if (rc.known !== true) return { cls: 'bad', text: 'check status unknown' }
  if (rc.failing.length) return { cls: 'bad', text: `required failing: ${rc.failing.join(', ')}` }
  if (rc.pending?.length) return { cls: 'warn', text: `required ${rc.pending.length} running` }
  if (rc.total === 0) return { cls: 'ok', text: 'no required checks' }
  return { cls: 'ok', text: `required ${rc.total}/${rc.total}` }
}

// The update-branch button's label and enabled state are driven by the PR's
// mergeStateStatus, not the local (possibly days-stale) "N behind" count — see
// actions/update-branch.js. Pure and exported so it is testable without a DOM, same as
// prChecksChip. `mainPr` is the item's OWN PR (never a colleague's review request) or null.
export function updateBranchSpec(item, mainPr) {
  if (mainPr) {
    switch (mainPr.mergeStateStatus) {
      case 'BEHIND':
        return { label: 'update branch', disabled: false, title: null }
      case 'DIRTY':
        return {
          label: 'resolve conflicts locally', disabled: true,
          title: `#${mainPr.number} conflicts with the base branch — resolve it locally, GitHub can't.`,
        }
      case 'CLEAN': case 'BLOCKED': case 'UNSTABLE':
        return { label: 'up to date', disabled: true, title: 'Already up to date with the base branch.' }
      default:
        return {
          label: 'state unknown', disabled: true,
          title: "GitHub hasn't finished computing this yet — try again after the next refresh.",
        }
    }
  }
  // No PR: fall back to the old local-only signal. The count is only as fresh as the
  // user's last manual fetch, so it must never be presented as current.
  if (!item.slot) return null
  return {
    label: item.slot.behind > 0 ? `update (${item.slot.behind} behind, as of last fetch)` : 'update branch',
    disabled: item.slot.dirty,
    title: item.slot.dirty ? `${item.slot.dirtyCount} uncommitted change(s)` : null,
  }
}

// Pure bucketing, not a sort within either bucket: openList holds every subtask whose
// statusCategory isn't 'Done' (rendered first in the card), doneList holds the rest
// (rendered after, dimmed) — regardless of the order they arrived in.
export function summarizeSubtasks(subtasks) {
  const openList = subtasks.filter((s) => s.statusCategory !== 'Done')
  const doneList = subtasks.filter((s) => s.statusCategory === 'Done')
  return { open: openList.length, done: doneList.length, total: subtasks.length, openList, doneList }
}

// --- appended to public/app.js ---
// Guarded so the module stays importable by node --test (no document there).
if (typeof document !== 'undefined') {
  const state = { board: null, showBacklog: false, showStale: false, busy: new Set() }
  const $ = (sel) => document.querySelector(sel)
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return res.json()
  }

  async function load({ force = false } = {}) {
    state.board = force ? await api('/api/refresh', {}) : await api('/api/items')
    render()
  }

  function sourceBar(sources) {
    const wrap = el('div')
    const bar = el('div', 'sources')
    const errorLines = []
    for (const [name, s] of Object.entries(sources)) {
      const { cls, text, error } = sourceChip(name, s)
      const chip = el('span', `src ${cls}`, text)
      if (error) { chip.title = error; errorLines.push(`${name}: ${error}`) }
      bar.append(chip)
    }
    wrap.append(bar)
    if (errorLines.length) wrap.append(el('div', 'src-errors', errorLines.join(' · ')))
    return wrap
  }

  function planPicker(item) {
    const box = el('div', 'plans')
    for (const folder of item.plans) {
      const group = el('div', 'plan-folder')
      group.append(el('div', 'plan-folder-name', folder.folder))
      for (const f of folder.files) {
        const id = `plan:${item.id}:${folder.dir}/${f}`
        const label = el('label', 'plan-file')
        const cb = el('input')
        cb.type = 'checkbox'; cb.checked = true; cb.dataset.dir = folder.dir; cb.dataset.file = f; cb.id = id
        label.append(cb, el('span', null, f))
        group.append(label)
      }
      box.append(group)
    }
    return box
  }

  function selectedPlans(card) {
    return [...card.querySelectorAll('.plan-file input:checked')]
      .map((cb) => ({ dir: cb.dataset.dir, file: cb.dataset.file }))
  }

  function subtaskRow(s, { done = false } = {}) {
    const row = el('div', `subtask${done ? ' subtask-done' : ''}`)
    const a = el('a', 'subtask-key', s.key)
    a.href = s.url ?? '#'; a.target = '_blank'
    row.append(a)
    row.append(el('span', 'subtask-summary', s.summary ?? ''))
    row.append(el('span', 'chip', s.issuetype ?? ''))
    row.append(el('span', 'chip', s.status ?? ''))
    row.append(el('span', 'subtask-assignee', s.assignee ?? 'unassigned'))
    return row
  }

  // Native <details>/<summary> rather than a JS toggle: no state to manage, and
  // keyboard accessibility comes for free.
  function subtasksDetails(item) {
    const { open, done, openList, doneList } = summarizeSubtasks(item.subtasks)
    const details = el('details', 'subtasks')
    details.append(el('summary', null, `subtasks — ${open} open · ${done} done`))
    for (const s of openList) details.append(subtaskRow(s))
    if (doneList.length) {
      details.append(el('div', 'subtask-divider', '── done ──'))
      for (const s of doneList) details.append(subtaskRow(s, { done: true }))
    }
    return details
  }

  // Not a lane: the user's own open subtasks whose parent is NOT on the board. Rendered
  // as one group after the lanes, outside groupForDisplay entirely, so it never affects
  // LANES, the lane list, or the hidden counts.
  function orphanSubtasksSection(orphans) {
    const sec = el('section', 'lane')
    sec.append(el('h2', null, `My subtasks elsewhere (${orphans.length})`))
    for (const s of orphans) {
      const row = el('div', 'orphan-subtask')
      const a = el('a', 'key', s.key)
      a.href = s.url ?? '#'; a.target = '_blank'
      row.append(a)
      row.append(el('span', 'chip', s.issuetype ?? ''))
      row.append(el('span', 'chip', s.status ?? ''))
      row.append(el('span', 'subtask-parent', `↳ parent ${s.parentKey ?? '?'} · ${s.parentSummary ?? ''}`))
      sec.append(row)
    }
    return sec
  }

  function card(item) {
    const c = el('article', `card lane-${item.lane}`)
    const head = el('header')
    if (item.key) {
      const a = el('a', 'key', item.key)
      a.href = item.jira?.url ?? '#'; a.target = '_blank'
      head.append(a)
    }
    head.append(el('span', 'title', item.title ?? item.id))
    if (item.jira?.status) head.append(el('span', 'status', item.jira.status))
    c.append(head)

    for (const pr of item.prs) {
      const row = el('div', 'pr')
      const a = el('a', 'pr-num', `#${pr.number}`); a.href = pr.url; a.target = '_blank'
      row.append(a, el('span', 'pr-repo', pr.repo))
      row.append(el('span', `pr-review ${pr.reviewDecision === 'APPROVED' ? 'ok' : 'warn'}`, pr.reviewDecision ?? 'no review'))
      const { cls, text } = prChecksChip(pr.requiredChecks)
      row.append(el('span', `pr-checks ${cls}`, text))
      if (pr.isDraft) row.append(el('span', 'chip', 'draft'))
      c.append(row)
    }

    if (item.slot) {
      const s = el('div', 'slot')
      s.append(el('span', 'slot-dir', item.slot.dir.split('/').pop()))
      s.append(el('span', 'slot-branch', item.slot.branch ?? 'detached'))
      if (item.slot.dirty) s.append(el('span', 'chip bad', `${item.slot.dirtyCount} uncommitted`))
      if (item.slot.behind > 0) s.append(el('span', 'chip warn', `${item.slot.behind} behind (as of last fetch)`))
      if (item.signals.reclaimable) s.append(el('span', 'chip', 'reclaimable'))
      c.append(s)
    }

    if (item.reasons.length) {
      const ul = el('ul', 'reasons')
      for (const r of item.reasons) ul.append(el('li', null, r))
      c.append(ul)
    }

    if (item.plans.length) c.append(planPicker(item))

    // Empty is rendered as nothing at all — no empty <details>, no zero-count line.
    if (item.subtasks.length > 0) c.append(subtasksDetails(item))

    const actions = el('div', 'actions')
    const msg = el('p', 'action-msg')

    const post = async (path, body, btn) => {
      btn.disabled = true
      msg.className = 'action-msg'
      msg.textContent = 'working…'
      const res = await api(path, { id: item.id, plans: selectedPlans(c), ...body })
      msg.className = `action-msg ${res.ok ? 'ok' : 'bad'}`
      msg.textContent = res.message
      if (res.candidates?.length) {
        msg.append(document.createElement('br'))
        for (const cand of res.candidates) {
          const b = el('button', null, `${cand.dir.split('/').pop()} — ${cand.why}`)
          b.addEventListener('click', () => post(path, { ...body, slotDir: cand.dir }, b))
          msg.append(b)
        }
      }
      btn.disabled = false
      if (res.ok) setTimeout(() => load({ force: true }), 1200)
    }

    // The user's own PR (never a colleague's review-requested one) — drives both the
    // update-branch button below and the merge button.
    const mainPr = item.prs.find((p) => p.isMine !== false)

    const open = el('button', null, 'open')
    open.addEventListener('click', () => post('/api/open', {}, open))
    actions.append(open)

    for (const skill of item.skills ?? []) {
      const b = el('button', null, `/${skill}`)
      b.addEventListener('click', () => post('/api/run', { skill }, b))
      actions.append(b)
    }

    const spec = updateBranchSpec(item, mainPr)
    if (spec) {
      const u = el('button', null, spec.label)
      u.disabled = spec.disabled
      if (spec.title) u.title = spec.title
      u.addEventListener('click', () => post('/api/update-branch', {}, u))
      actions.append(u)
    }

    if (mainPr) {
      const m = el('button', null, 'squash & merge')
      if (!item.mergeGate.allowed) { m.disabled = true; m.title = item.mergeGate.blockers.join('; ') }
      m.addEventListener('click', () => {
        if (!confirm(`Squash-merge #${mainPr.number} "${mainPr.title}" into master?`)) return
        post('/api/merge', { prNumber: mainPr.number, confirmed: true }, m)
      })
      actions.append(m)
    }

    c.append(actions, msg)
    c.dataset.id = item.id
    return c
  }

  function render() {
    const b = state.board
    const root = $('#board')
    root.replaceChildren()
    $('#meta').replaceChildren(
      el('span', 'time', `updated ${new Date(b.generatedAt).toLocaleTimeString()}`),
      sourceBar(b.sources)
    )
    const { lanes, hidden } = groupForDisplay(b.items, state)
    for (const lane of lanes) {
      const sec = el('section', 'lane')
      sec.append(el('h2', null, `${lane.label} (${lane.items?.length ?? lane.subgroups.reduce((n, s) => n + s.items.length, 0)})`))
      if (lane.items) {
        for (const i of lane.items) sec.append(card(i))
      } else {
        for (const sg of lane.subgroups) {
          sec.append(el('h3', 'subgroup', `${sg.label} (${sg.items.length})`))
          for (const i of sg.items) sec.append(card(i))
        }
      }
      root.append(sec)
    }
    if (b.orphanSubtasks?.length) root.append(orphanSubtasksSection(b.orphanSubtasks))
    $('#hidden').textContent = hidden.total
      ? `${hidden.backlog} backlog · ${hidden.stale} stale — use the toggles above`
      : ''
  }

  $('#refresh').addEventListener('click', () => load({ force: true }))
  $('#showBacklog').addEventListener('change', (e) => { state.showBacklog = e.target.checked; render() })
  $('#showStale').addEventListener('change', (e) => { state.showStale = e.target.checked; render() })

  load()
  setInterval(() => load(), 60_000)

  window.__workDash = { state, load, render, selectedPlans }
}
