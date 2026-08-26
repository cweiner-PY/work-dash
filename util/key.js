const KEY_RE = /\b(PY|LOGAN)-\d+\b/i

export function extractKey(str) {
  if (typeof str !== 'string' || str === '') return null
  const m = str.match(KEY_RE)
  return m ? m[0].toUpperCase() : null
}
