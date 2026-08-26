export class PredicateError extends Error {}

function tokenize(src) {
  const tokens = []
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)/g
  let pos = 0
  let m
  while ((m = re.exec(src)) !== null) {
    if (m.index !== pos) break
    tokens.push(m[1])
    pos = re.lastIndex
  }
  if (src.slice(pos).trim() !== '') {
    throw new PredicateError(`Unexpected input in predicate: ${JSON.stringify(src.slice(pos))}`)
  }
  return tokens
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0
  if (v && typeof v === 'object') return true
  return Boolean(v)
}

function lookup(path, ctx) {
  let cur = ctx
  for (const part of path.split('.')) {
    if (cur == null) return undefined
    cur = cur[part]
  }
  return cur
}

// Recursive descent: or -> and -> cmp -> unary -> primary
export function evalPredicate(expr, ctx) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new PredicateError('Predicate must be a non-empty string')
  }
  const tokens = tokenize(expr)
  let i = 0
  const peek = () => tokens[i]
  const eat = (t) => {
    if (tokens[i] !== t) throw new PredicateError(`Expected ${t} in: ${expr}`)
    i++
  }

  function primary() {
    const t = peek()
    if (t === undefined) throw new PredicateError(`Unexpected end of predicate: ${expr}`)
    if (t === '(') { eat('('); const v = or(); eat(')'); return v }
    if (t.startsWith("'")) { i++; return t.slice(1, -1) }
    if (/^[A-Za-z_]/.test(t)) { i++; return lookup(t, ctx) }
    throw new PredicateError(`Unexpected token ${JSON.stringify(t)} in: ${expr}`)
  }
  function unary() {
    if (peek() === '!') { i++; return !truthy(unary()) }
    return primary()
  }
  function cmp() {
    const left = unary()
    const op = peek()
    if (op === '==' || op === '!=') {
      i++
      const right = unary()
      const eq = left === right
      return op === '==' ? eq : !eq
    }
    return left
  }
  function and() {
    let v = cmp()
    while (peek() === '&&') { i++; const r = cmp(); v = truthy(v) && truthy(r) }
    return v
  }
  function or() {
    let v = and()
    while (peek() === '||') { i++; const r = and(); v = truthy(v) || truthy(r) }
    return v
  }

  const result = or()
  if (i !== tokens.length) {
    throw new PredicateError(`Trailing tokens in predicate: ${expr}`)
  }
  return truthy(result)
}
