// server.js
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { loadConfig, ConfigError } from './config.js'
import { buildBoard } from './board.js'
import { registerRoutes } from './routes.js'

const PUBLIC = join(import.meta.dirname, 'public')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }
const CACHE_MS = 60_000

let config
try {
  config = loadConfig()
} catch (e) {
  if (e instanceof ConfigError) { console.error(`\nConfiguration problem:\n\n${e.message}\n`); process.exit(1) }
  throw e
}

let cache = { at: 0, board: null }

async function board({ force = false } = {}) {
  if (!force && cache.board && Date.now() - cache.at < CACHE_MS) return cache.board
  cache = { at: Date.now(), board: await buildBoard(config) }
  return cache.board
}

const json = (res, code, body) => {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

// Action handlers are registered in Task 14; this map keeps server.js from
// growing a branch per endpoint.
export const routes = new Map()
registerRoutes(routes, { getBoard: () => board(), config, deps: { dry: process.env.WORK_DASH_DRY === '1' } })

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/api/items') return json(res, 200, await board())
    if (req.method === 'POST' && url.pathname === '/api/refresh') return json(res, 200, await board({ force: true }))
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, config.toSafeJSON())

    const route = routes.get(`${req.method} ${url.pathname}`)
    if (route) {
      const result = await route(await readBody(req), { config, invalidate: () => { cache.board = null } })
      return json(res, result.ok ? 200 : 400, result)
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').slice(1)
      const file = join(PUBLIC, rel)
      if (!file.startsWith(PUBLIC)) return json(res, 403, { ok: false, message: 'forbidden' })
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
      return res.end(body)
    }
    json(res, 404, { ok: false, message: 'not found' })
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { ok: false, message: 'not found' })
    json(res, 500, { ok: false, message: e.message })
  }
})

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${config.port}`
  console.log(`work-dash serving on ${url}`)
})
