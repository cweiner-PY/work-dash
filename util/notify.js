// util/notify.js
import { run as defaultRun } from '../util/run.js'

// Which items have just ENTERED the needs-you lane. `prev === null` means this is the
// first collection of the process: the board as a whole is not news, so nothing is newly
// anything. Without that guard, starting the server would fire a notification for every
// item already needing attention.
//
// Items that leave and later come back DO notify again, which is right — a check going red
// a second time is news a second time.
export function newlyNeedsYou(prevItems, nextItems) {
  if (!prevItems) return []
  const was = new Set(prevItems.filter((i) => i.lane === 'needs-you').map((i) => i.id))
  return (nextItems ?? []).filter((i) => i.lane === 'needs-you' && !was.has(i.id))
}

// What to say. One item gets its own reason, since that is the actionable part; several get
// a roll-call, because three separate notifications for three items is noise rather than
// three times the information.
export function notificationFor(items) {
  if (!items?.length) return null
  if (items.length === 1) {
    const only = items[0]
    return {
      title: 'work-dash — needs you',
      message: `${only.key ?? only.id} — ${only.reasons?.[0] ?? 'needs you'}`,
    }
  }
  return {
    title: `work-dash — ${items.length} need you`,
    message: items.map((i) => i.key ?? i.id).join(', '),
  }
}

// The text is passed as ARGUMENTS to osascript, never interpolated into the AppleScript
// source. Ticket summaries routinely contain quotes, backslashes and em-dashes, and text
// that never becomes part of the script has no escaping to get wrong.
export function displayNotification({ title, message }, { run = defaultRun } = {}) {
  return run('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
    '-e', 'end run',
    message, title,
  ])
}

export async function notifyLaneChanges(
  prevItems, nextItems, { run = defaultRun, enabled = true } = {}
) {
  if (!enabled) return { notified: [] }
  const fresh = newlyNeedsYou(prevItems, nextItems)
  const note = notificationFor(fresh)
  if (!note) return { notified: [] }
  const r = await displayNotification(note, { run })
  // Reported, not thrown: a notification is the least important thing this process does,
  // and it must never be the reason a board collection looks like it failed.
  return { notified: fresh.map((i) => i.id), ...note, ok: r.code === 0 }
}
