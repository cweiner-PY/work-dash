// util/trusted-request.js — PURE. No fs, no clock, no http.
//
// DNS-rebinding / cross-origin defence for the local server. `server.js` binds to
// 127.0.0.1, but that is not a defence on its own: readBody ignores Content-Type, so a
// CORS-simple text/plain POST from any page the user happens to visit reaches the
// mutating routes. The absence of CORS response headers makes the RESPONSE unreadable to
// that page, but the SIDE EFFECTS (an irreversible public squash-merge, a Terminal/Claude
// session launched in a checkout) still happen. Missing Host validation additionally
// leaves DNS rebinding open, which would make the response readable too — and
// /api/items plus /api/config is the whole board, every docs path, every slot path.
//
// Kept as a small pure function, separate from server.js, so it can be unit tested
// without importing server.js — which reads the gitignored config.json (containing a
// live Jira token) as a side effect of module load.
export function isTrustedRequest(headers, port) {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (!allowedHosts.includes(headers.host)) return false

  const origin = headers.origin
  if (origin != null) {
    const allowedOrigins = allowedHosts.map((h) => `http://${h}`)
    if (!allowedOrigins.includes(origin)) return false
  }
  return true
}
