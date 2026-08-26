// util/port-error.js — PURE. No fs, no process, no console.
//
// Extracted out of server.js so the EADDRINUSE message can be unit tested without
// importing server.js, which reads the gitignored config.json (a live Jira token) as a
// side effect of module load. Returns the message to print, or null when `e` is not a
// port-in-use error — the caller re-throws in that case rather than swallowing an
// unrelated failure.
export function describePortError(e, port) {
  if (e?.code !== 'EADDRINUSE') return null
  return (
    `\nCould not start work-dash: port ${port} is already in use.\n\n` +
    `work-dash may already be running — stop that instance, or change "port" in config.json.\n`
  )
}
