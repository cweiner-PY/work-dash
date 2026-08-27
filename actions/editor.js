// actions/editor.js
import { run as defaultRun } from '../util/run.js'

// Opening an editor on a checkout that already exists. Deliberately the narrowest action
// in this codebase: it resolves nothing, checks nothing out, and runs no git at all.
//
// `open -a <editor>` rather than a `cursor`/`code` CLI: those shims are optional installs
// (this machine has `code` but no `cursor`), while the .app is what actually exists.
// macOS resolves the name against installed applications, so one config string covers
// Cursor, VS Code, Zed or anything else.
export async function openEditor(
  { item, slots = [], chosenSlotDir = null, editor = 'Cursor' },
  { run = defaultRun, dry = false } = {}
) {
  let slot
  if (chosenSlotDir) {
    // Validated against the board's own slot list, and against the item's repo, for the
    // same reason every other explicit slotDir in this codebase is: a raw API call must
    // not be able to name an arbitrary directory to open.
    slot = slots.find((s) => s.dir === chosenSlotDir)
    if (!slot) return { ok: false, message: `Unknown slot: ${chosenSlotDir}` }
    if (item.repo && slot.repo && slot.repo !== item.repo) {
      return { ok: false, message: `${slot.dir} belongs to ${slot.repo}, not ${item.repo}.` }
    }
  } else {
    slot = item.slot
  }

  // No local checkout is the ordinary state for a To Do ticket, and there is nothing
  // honest to open. The button is hidden in that case; this is the server-side guard.
  if (!slot?.dir) {
    return { ok: false, message: `${item.key ?? item.id} has no local checkout to open.` }
  }

  const name = slot.dir.split('/').pop()
  if (dry) {
    return { ok: true, message: `dry run — would open ${name} in ${editor}`,
             detail: `open -a ${editor} ${slot.dir}`, slot: slot.dir }
  }

  const r = await run('open', ['-a', editor, slot.dir])
  if (r.code !== 0) {
    // The usual cause is an editor name macOS cannot resolve to an installed app.
    return {
      ok: false,
      message: `Could not open ${editor}: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`,
    }
  }
  return { ok: true, message: `Opened ${name} in ${editor}`, slot: slot.dir }
}
