/* Integration probe: behaves like the web page against the running relay. */
import { WebSocket } from 'ws'

const BASE = process.env.XD_BASE || 'http://127.0.0.1:7801'
const USER = process.env.XD_USER || 'admin'
const PASS = process.env.DSWC_PASS || 'dswc'

const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})
if (!login.ok) throw new Error(`login ${login.status}`)
const setCookie = login.headers.getSetCookie?.() ?? []
const cookie = setCookie[0]?.split(';')[0]
if (!cookie) throw new Error('no cookie')
console.log('login ok')

const listed = await (await fetch(`${BASE}/api/instances`, { headers: { cookie } })).json()
console.log('instances', listed)
const instance = listed.items?.[0]
if (!instance) throw new Error('no online instance')

const ws = new WebSocket(`ws://127.0.0.1:7801/ws/client?instance=${instance.id}`, {
  headers: { Cookie: cookie },
})

let nextId = 0
const pending = new Map()
const entries = []
let assistantText = ''
let turnEnded = false

const connected = new Promise((resolve, reject) => {
  ws.on('open', () => console.log('ws open'))
  ws.on('error', reject)
  ws.on('message', data => {
    const message = JSON.parse(data.toString())
    if (message.type === 'relay') {
      if (message.event === 'connected') {
        console.log('relay connected', message.instance)
        resolve(message)
      } else {
        console.log('relay event', message.event)
      }
      return
    }
    if (message.type === 'res') {
      const pendingCall = pending.get(message.id)
      if (!pendingCall) return
      pending.delete(message.id)
      if (message.ok) pendingCall.resolve(message.result)
      else pendingCall.reject(new Error(message.error?.message || 'rpc failed'))
      return
    }
    if (message.type === 'evt') {
      const event = message.event
      if (!event) return
      if (event.kind === 'snapshot') {
        console.log('snapshot entries', event.entries?.length, 'running', event.running)
      } else if (event.kind === 'entry') {
        const entry = event.entry
        entries.push(entry)
        if (entry.kind === 'assistant') {
          assistantText = entry.text || ''
          console.log('assistant entry:', JSON.stringify(assistantText.slice(0, 120)))
        } else if (entry.kind === 'tool') {
          console.log('tool call:', entry.name)
        } else if (entry.kind === 'turn-end') {
          console.log('turn end:', entry.kind, entry.error || '')
          turnEnded = true
        } else if (entry.kind === 'user') {
          console.log('user entry:', JSON.stringify((entry.text || '').slice(0, 80)))
        }
      } else if (event.kind === 'delta') {
        assistantText += event.text || ''
      } else if (event.kind === 'state') {
        console.log('state running=', event.running)
      } else if (event.kind === 'error') {
        console.log('error event:', event.message)
      }
    }
  })
})

function rpc(method, params = {}, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const id = String(++nextId)
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value) },
      reject: error => { clearTimeout(timer); reject(error) },
    })
    ws.send(JSON.stringify({ type: 'req', id, method, params }))
  })
}

await connected
console.log('--- sessions.list ---')
const sessions = await rpc('sessions.list')
console.log('sessions:', sessions.items.slice(0, 5).map(s => ({ id: s.id, title: s.title, running: s.running })))

console.log('--- models.catalog ---')
const catalog = await rpc('models.catalog')
console.log('groups:', catalog.groups.map(g => ({ id: g.id, models: g.models.map(m => m.id) })))

console.log('--- session.create ---')
const created = await rpc('session.create')
console.log('created:', created)
if (created.permissionError) console.log('permission error:', created.permissionError)
if (created.modelError) console.log('model error:', created.modelError)

console.log('--- session.attach ---')
await rpc('session.attach', { sessionId: created.sessionId })
await new Promise(resolve => setTimeout(resolve, 800))

console.log('--- session.prompt ---')
const promptResult = await rpc('session.prompt', {
  sessionId: created.sessionId,
  text: process.env.XD_TEXT || '只回复一句话：远程连接成功',
  requestId: `probe-${Date.now()}`,
  mode: 'queue',
})
console.log('prompt:', promptResult)

const deadline = Date.now() + Number(process.env.XD_WAIT || 90_000)
while (!turnEnded && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 500))
}
console.log('turnEnded:', turnEnded)
console.log('assistant text:', JSON.stringify(assistantText.slice(0, 500)))
console.log('entries:', entries.length)
ws.close()
process.exit(turnEnded ? 0 : 2)
