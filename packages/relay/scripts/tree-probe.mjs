/* Read-only probe for workspace grouping. */
import { WebSocket } from 'ws'

const BASE = process.env.XD_BASE || 'http://127.0.0.1:7801'
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    username: process.env.XD_USER || 'admin',
    password: process.env.DSWC_PASS || 'dswc',
  }),
})
const cookie = (login.headers.getSetCookie?.() || [])[0]?.split(';')[0]
const instances = await (await fetch(`${BASE}/api/instances`, { headers: { cookie } })).json()
const instance = instances.items?.[0]
if (!instance) throw new Error('no instance')
const ws = new WebSocket(`ws://127.0.0.1:7801/ws/client?instance=${instance.id}`, {
  headers: { Cookie: cookie },
})
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})

let nextId = 0
const pending = new Map()
ws.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.type === 'res' && pending.has(message.id)) {
    const call = pending.get(message.id)
    pending.delete(message.id)
    if (message.ok) call.resolve(message.result)
    else call.reject(new Error(message.error?.message || 'rpc failed'))
  }
})
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++nextId)
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ type: 'req', id, method, params }))
  })
}

const sessions = await rpc('sessions.list')
const workspaces = await rpc('workspaces.list')
console.log('workspaces:', workspaces.items)
console.log('groups:')
for (const group of sessions.groups || []) {
  console.log(`- ${group.title} (${group.path}) sessions=${group.sessionIds.length}`)
}
console.log('ungrouped:', (sessions.ungrouped || []).length)
console.log('items:', (sessions.items || []).length)
ws.close()
process.exit(0)
