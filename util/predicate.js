export class PredicateError extends Error {}

function validateIdentifier(token) {
  // Validate that identifier follows pattern: segment(.segment)*
  // Each segment must start with letter or underscore, contain only alphanumerics and underscores
  const parts = token.split('.')
  if (parts.length === 0) {
    throw new PredicateError(`Invalid identifier: ${JSON.stringify(token)}`)
  }
  for (const part of parts) {
    if (part === '') {
      throw new PredicateError(`Invalid identifier: ${JSON.stringify(token)}`)
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      throw new PredicateError(`Invalid identifier: ${JSON.stringify(token)}`)
    }
  }
}

function tokenize(src) {
  const tokens = []
  const re = /\s*(\|\||&&|==|!=|!|\(|\)|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)/g
  let pos = 0
  let m
  while ((m = re.exec(src)) !== null) {
    if (m.index !== pos) break
    const token = m[1]
    // Validate identifier tokens
    if (/^[A-Za-z_]/.test(token)) {
      validateIdentifier(token)
    }
    tokens.push(token)
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

const MAX_DEPTH = 64

// Recursive descent: or -> and -> cmp -> unary -> primary
export function evalPredicate(expr, ctx) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new PredicateError('Predicate must be a non-empty string')
  }
  const tokens = tokenize(expr)
  let i = 0
  let depth = 0
  const peek = () => tokens[i]
  const eat = (t) => {
    if (tokens[i] !== t) throw new PredicateError(`Expected ${t} in: ${expr}`)
    i++
  }
  const checkDepth = () => {
    if (depth > MAX_DEPTH) {
      throw new PredicateError(`Predicate nesting depth exceeds limit of ${MAX_DEPTH}`)
    }
  }

  function primary() {
    depth++
    checkDepth()
    const t = peek()
    if (t === undefined) throw new PredicateError(`Unexpected end of predicate: ${expr}`)
    let result
    if (t === '(') { eat('('); result = or(); eat(')') }
    else if (t.startsWith("'")) { i++; result = t.slice(1, -1) }
    else if (/^[A-Za-z_]/.test(t)) { i++; result = lookup(t, ctx) }
    else throw new PredicateError(`Unexpected token ${JSON.stringify(t)} in: ${expr}`)
    depth--
    return result
  }
  function unary() {
    depth++
    checkDepth()
    let result
    if (peek() === '!') { i++; result = !truthy(unary()) }
    else result = primary()
    depth--
    return result
  }
  function cmp() {
    depth++
    checkDepth()
    const left = unary()
    const op = peek()
    let result
    if (op === '==' || op === '!=') {
      i++
      const right = unary()
      const eq = left === right
      result = op === '==' ? eq : !eq
    } else {
      result = left
    }
    depth--
    return result
  }
  function and() {
    depth++
    checkDepth()
    let v = cmp()
    while (peek() === '&&') { i++; const r = cmp(); v = truthy(v) && truthy(r) }
    depth--
    return v
  }
  function or() {
    depth++
    checkDepth()
    let v = and()
    while (peek() === '||') { i++; const r = and(); v = truthy(v) || truthy(r) }
    depth--
    return v
  }

  const result = or()
  if (i !== tokens.length) {
    throw new PredicateError(`Trailing tokens in predicate: ${expr}`)
  }
  return truthy(result)
}
