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
    if (!showStale && isStale) { hidden.stale++; hidden.total++; return false }
    return true
  })

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
  return { lanes, hidden }
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
    const bar = el('div', 'sources')
    for (const [name, s] of Object.entries(sources)) {
      const chip = el('span', `src ${s.ok ? 'ok' : 'bad'}`, `${name} ${s.ok ? s.count : 'unavailable'}`)
      if (s.error) chip.title = s.error
      bar.append(chip)
    }
    return bar
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
      const rc = pr.requiredChecks
      row.append(el('span', `pr-checks ${rc.failing.length ? 'bad' : 'ok'}`,
        rc.total === 0 ? 'no required checks' : rc.failing.length ? `required failing: ${rc.failing.join(', ')}` : `required ${rc.total}/${rc.total}`))
      if (pr.isDraft) row.append(el('span', 'chip', 'draft'))
      c.append(row)
    }

    if (item.slot) {
      const s = el('div', 'slot')
      s.append(el('span', 'slot-dir', item.slot.dir.split('/').pop()))
      s.append(el('span', 'slot-branch', item.slot.branch ?? 'detached'))
      if (item.slot.dirty) s.append(el('span', 'chip bad', `${item.slot.dirtyCount} uncommitted`))
      if (item.slot.behind > 0) s.append(el('span', 'chip warn', `${item.slot.behind} behind`))
      if (item.signals.reclaimable) s.append(el('span', 'chip', 'reclaimable'))
      c.append(s)
    }

    if (item.reasons.length) {
      const ul = el('ul', 'reasons')
      for (const r of item.reasons) ul.append(el('li', null, r))
      c.append(ul)
    }

    if (item.plans.length) c.append(planPicker(item))

    // Actions are wired in Task 14; the container exists from here so the
    // layout does not shift when they arrive.
    c.append(el('div', 'actions'))
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
