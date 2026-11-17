/**
 * DSH Web Control relay.
 *
 * Serves the web UI and forwards JSON frames between browsers and the DSH
 * plugin that connects outbound from the PC. No message content is persisted.
 */
import http from 'node:http'
import { createReadStream, readFileSync, promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')

/* ------------------------------------------------------------------- config */

// Deployment settings live in config.json next to this file (or the path
// in DSWC_CONFIG). A value in that file wins over its environment variable, so
// a deployment can keep everything in one file; variables remain as fallback.
const CONFIG_FILENAME = 'config.json'

const CONFIG_FIELDS = {
  host: 'HOST',
  port: 'PORT',
  username: 'DSWC_USER',
  password: 'DSWC_PASSWORD',
  sessionSecret: 'DSWC_SECRET',
  sessionTtlDays: 'DSWC_SESSION_TTL_DAYS',
  pluginToken: 'DSWC_PLUGIN_TOKEN',
}

const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: 7801,
  username: 'admin',
  password: 'dswc',
  sessionSecret: '',
  sessionTtlDays: 30,
  pluginToken: '',
}

const WEAK_PASSWORDS = new Set(['dswc', 'change-me', 'change-me-please', 'password', '123456'])

function configLocation() {
  const explicit = String(process.env.DSWC_CONFIG || '').trim()
  if (explicit) return { file: path.resolve(explicit), explicit: true }
  return { file: path.join(__dirname, CONFIG_FILENAME), explicit: false }
}

function readJsonConfig(file, explicit) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (explicit) throw new Error(`DSWC_CONFIG 指向的配置文件不存在: ${file}`)
      return null
    }
    throw new Error(`读取配置文件失败 ${file}: ${error.message}`)
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON: ${file} (${error.message})`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`配置文件顶层必须是 JSON 对象: ${file}`)
  }
  return value
}

function pickValue(file, fileConfig, key) {
  if (fileConfig && Object.hasOwn(fileConfig, key)) {
    return { value: fileConfig[key], source: `配置文件 ${file} 的 ${key}` }
  }
  const envName = CONFIG_FIELDS[key]
  const envValue = process.env[envName]
  if (envValue !== undefined && envValue !== '') {
    return { value: envValue, source: `环境变量 ${envName}` }
  }
  return { value: DEFAULT_CONFIG[key], source: '内置默认值' }
}

function invalidField(field, message, picked) {
  return new Error(`配置项 ${field} ${message}（来源: ${picked.source}）`)
}

function normalizeConfig(file, fileConfig) {
  const keys = Object.keys(CONFIG_FIELDS)
  const picked = {}
  for (const key of keys) picked[key] = pickValue(file, fileConfig, key)

  const host = String(picked.host.value).trim()
  if (!host) throw invalidField('host', '不能为空', picked.host)

  const port = Number(picked.port.value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidField('port', `必须是 1-65535 的整数，当前为 ${JSON.stringify(picked.port.value)}`, picked.port)
  }

  const username = String(picked.username.value).trim()
  if (!username) throw invalidField('username', '不能为空', picked.username)

  const password = String(picked.password.value)
  if (!password) throw invalidField('password', '不能为空', picked.password)

  const sessionSecret = String(picked.sessionSecret.value ?? '').trim()
  const sessionTtlDays = Number(picked.sessionTtlDays.value)
  if (!Number.isFinite(sessionTtlDays) || sessionTtlDays <= 0 || sessionTtlDays > 3650) {
    throw invalidField(
      'sessionTtlDays',
      `必须是大于 0 且不超过 3650 的天数，当前为 ${JSON.stringify(picked.sessionTtlDays.value)}`,
      picked.sessionTtlDays,
    )
  }
  const pluginToken = String(picked.pluginToken.value ?? '').trim()

  return {
    config: { host, port, username, password, sessionSecret, sessionTtlDays, pluginToken },
    unknownKeys: fileConfig ? Object.keys(fileConfig).filter(key => !keys.includes(key)) : [],
  }
}

function loadConfig() {
  const { file, explicit } = configLocation()
  const fileConfig = readJsonConfig(file, explicit)
  const { config, unknownKeys } = normalizeConfig(file, fileConfig)
  return { config, file: fileConfig ? file : null, unknownKeys }
}

let loadedConfig
try {
  loadedConfig = loadConfig()
} catch (error) {
  console.error(`[dsh-web-control] 启动失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const PORT = loadedConfig.config.port
const HOST = loadedConfig.config.host
const USERNAME = loadedConfig.config.username
const PASSWORD = loadedConfig.config.password
const PLUGIN_TOKEN = loadedConfig.config.pluginToken
const SESSION_SECRET = loadedConfig.config.sessionSecret || crypto.randomBytes(32).toString('hex')
const COOKIE_NAME = 'dswc_session'
const SESSION_TTL_SECONDS = Math.max(60, Math.round(loadedConfig.config.sessionTtlDays * 86400))
const MAX_BODY = 16 * 1024
const MAX_WS_PAYLOAD = 2 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

/** @type {Map<string, Instance>} */
const instances = new Map()

/* ------------------------------------------------------------------ helpers */

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

function sendJson(socket, value) {
  if (socket.readyState !== 1) return
  try {
    socket.send(JSON.stringify(value))
  } catch (error) {
    log('send failed:', error?.message)
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function issueSessionCookie() {
  const payload = Buffer.from(
    JSON.stringify({ u: USERNAME, exp: Date.now() + SESSION_TTL_SECONDS * 1000 }),
  ).toString('base64url')
  const token = `${payload}.${hmac(payload)}`
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function verifySession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME]
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!safeEqual(signature, hmac(payload))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (data.u !== USERNAME) return null
    if (!Number.isFinite(data.exp) || data.exp < Date.now()) return null
    return data
  } catch {
    return null
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function instanceList() {
  return [...instances.values()].map(instance => ({
    id: instance.id,
    name: instance.name,
    host: instance.host,
    version: instance.version,
    connectedAt: instance.connectedAt,
    clients: instance.clients.size,
  }))
}

/* --------------------------------------------------------------- static HTTP */

async function serveStatic(req, res, pathname) {
  let relative = pathname === '/' ? '/index.html' : pathname
  if (relative.includes('..')) {
    res.writeHead(400); res.end('bad path'); return
  }
  const file = path.join(PUBLIC_DIR, relative)
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) throw new Error('not a file')
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // Small static app; always revalidate so a relay update takes effect.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  }
}

/* -------------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  // Basic browser hardening; this server is HTTP-only in v0.1.
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')

  try {
    if (pathname === '/healthz') {
      json(res, 200, { ok: true, instances: instances.size })
      return
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown'
      if (!allowLogin(ip)) {
        json(res, 429, { error: '尝试次数过多，请稍后再试' })
        return
      }
      const body = await readBody(req)
      const userOk = safeEqual(body?.username ?? '', USERNAME)
      const passOk = safeEqual(body?.password ?? '', PASSWORD)
      if (!userOk || !passOk) {
        json(res, 401, { error: '用户名或密码错误' })
        return
      }
      res.setHeader('set-cookie', issueSessionCookie())
      json(res, 200, { ok: true, username: USERNAME })
      return
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', clearSessionCookie())
      json(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const session = verifySession(req)
      if (!session) { json(res, 401, { error: '未登录' }); return }
      json(res, 200, { username: session.u })
      return
    }

    if (pathname === '/api/instances' && req.method === 'GET') {
      if (!verifySession(req)) { json(res, 401, { error: '未登录' }); return }
      json(res, 200, { items: instanceList() })
      return
    }

    if (pathname.startsWith('/api/')) {
      json(res, 404, { error: 'not found' })
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname)
      return
    }

    res.writeHead(405); res.end('Method not allowed')
  } catch (error) {
    log('http error:', error?.message)
    if (!res.headersSent) json(res, 500, { error: 'internal error' })
    else res.end()
  }
})

/* ---------------------------------------------------------------- rate limit */

const loginAttempts = new Map()
function allowLogin(ip) {
  const now = Date.now()
  const window = loginAttempts.get(ip)
  if (!window || now > window.reset) {
    loginAttempts.set(ip, { count: 1, reset: now + 60_000 })
    return true
  }
  window.count += 1
  return window.count <= 10
}

/* -------------------------------------------------------------- websockets */

const pluginWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })
const clientWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })

function rejectUpgrade(socket, status = 401) {
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/ws/plugin') {
    if (PLUGIN_TOKEN) {
      const token = url.searchParams.get('token') || ''
      if (!safeEqual(token, PLUGIN_TOKEN)) { rejectUpgrade(socket); return }
    }
    pluginWss.handleUpgrade(req, socket, head, ws => pluginWss.emit('connection', ws, req, url))
    return
  }

  if (url.pathname === '/ws/client') {
    if (!verifySession(req)) { rejectUpgrade(socket); return }
    const instanceId = url.searchParams.get('instance') || ''
    const instance = instances.get(instanceId)
    if (!instance) { rejectUpgrade(socket, 404); return }
    clientWss.handleUpgrade(req, socket, head, ws => clientWss.emit('connection', ws, req, url, instance))
    return
  }

  rejectUpgrade(socket, 404)
})

pluginWss.on('connection', (ws, req, url) => {
  const id = `inst_${crypto.randomBytes(6).toString('hex')}`
  const name = (url.searchParams.get('name') || 'DSH').slice(0, 80)
  const instance = {
    id,
    name,
    host: '',
    version: '',
    socket: ws,
    clients: new Map(),
    connectedAt: Date.now(),
  }
  instances.set(id, instance)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  sendJson(ws, { type: 'welcome', id, name })
  log(`plugin connected: ${id} (${name})`)

  ws.on('message', data => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    switch (message.type) {
      case 'hello':
        instance.name = String(message.name || instance.name).slice(0, 80)
        instance.host = String(message.host || '')
        instance.version = String(message.version || '')
        break
      case 'ping':
        sendJson(ws, { type: 'pong', ts: message.ts })
        break
      case 'res': {
        const client = instance.clients.get(message.clientId)
        if (client) sendJson(client, message)
        break
      }
      case 'evt': {
        if (message.clientId) {
          const client = instance.clients.get(message.clientId)
          if (client) sendJson(client, message)
        } else {
          for (const client of instance.clients.values()) sendJson(client, message)
        }
        break
      }
      default:
        break
    }
  })

  ws.on('close', () => {
    instances.delete(id)
    log(`plugin disconnected: ${id}`)
    for (const client of instance.clients.values()) {
      sendJson(client, { type: 'relay', event: 'instance.disconnected' })
      try { client.close(1001, 'instance disconnected') } catch {}
    }
    instance.clients.clear()
  })
})

clientWss.on('connection', (ws, req, url, instance) => {
  const clientId = `cli_${crypto.randomBytes(6).toString('hex')}`
  ws.clientId = clientId
  ws.instanceId = instance.id
  instance.clients.set(clientId, ws)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  sendJson(ws, {
    type: 'relay',
    event: 'connected',
    clientId,
    instance: {
      id: instance.id,
      name: instance.name,
      host: instance.host,
      version: instance.version,
    },
  })

  ws.on('message', data => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    if (message.type !== 'req') return
    message.clientId = clientId
    if (instance.socket.readyState !== 1) {
      sendJson(ws, {
        type: 'res',
        clientId,
        id: message.id,
        ok: false,
        error: { code: 'instance-offline', message: '电脑端已离线' },
      })
      return
    }
    sendJson(instance.socket, message)
  })

  ws.on('close', () => {
    instance.clients.delete(clientId)
    if (instance.socket.readyState === 1) {
      sendJson(instance.socket, { type: 'client.gone', clientId })
    }
  })
})

/* ------------------------------------------------------------- liveness ping */

const heartbeat = setInterval(() => {
  for (const ws of pluginWss.clients) {
    if (!ws.isAlive) { try { ws.terminate() } catch {}; continue }
    ws.isAlive = false
    try { ws.ping() } catch {}
  }
  for (const ws of clientWss.clients) {
    if (!ws.isAlive) { try { ws.terminate() } catch {}; continue }
    ws.isAlive = false
    try { ws.ping() } catch {}
  }
}, 30_000)

/* ----------------------------------------------------------------- startup */

server.listen(PORT, HOST, () => {
  log(`DSH Web Control relay listening on http://${HOST}:${PORT}`)
  log(`login user: ${USERNAME}`)
  log(`session TTL: ${loadedConfig.config.sessionTtlDays} day(s) (${SESSION_TTL_SECONDS}s)`)
  log(`config: ${loadedConfig.file || '环境变量 / 内置默认值'}`)
  for (const key of loadedConfig.unknownKeys) {
    log(`config: ignored unknown field "${key}" in ${loadedConfig.file}`)
  }
  if (WEAK_PASSWORDS.has(PASSWORD)) {
    log('WARNING: password is a default or placeholder value; set "password" in config.json (or DSWC_PASSWORD) before exposing this port.')
  }
  if (!loadedConfig.config.sessionSecret) {
    log('note: sessionSecret is empty; existing browser logins expire when the relay restarts (set it in the config file or DSWC_SECRET).')
  }
  if (!PLUGIN_TOKEN) {
    log('note: pluginToken is empty; any client may register as an instance.')
  }
})

function shutdown() {
  log('shutting down')
  clearInterval(heartbeat)
  for (const instance of instances.values()) {
    try { instance.socket.close(1012, 'server restart') } catch {}
    for (const client of instance.clients.values()) {
      try { client.close(1012, 'server restart') } catch {}
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
