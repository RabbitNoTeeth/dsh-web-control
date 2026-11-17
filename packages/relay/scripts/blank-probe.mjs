/* Verify a newly created but unused session stays out of the web session list. */
import { WebSocket } from 'ws'

const BASE = process.env.XD_BASE || 'http://127.0.0.1:7801'
const login = await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'dswc' }),
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

const before = await rpc('workspaces.list')
const workspace = before.items[0]
if (!workspace) throw new Error('no workspace')
const beforeCount = workspace.sessionCount
const created = await rpc('session.create', { workspaceId: workspace.id })
const sessions = await rpc('sessions.list')
const after = await rpc('workspaces.list')
const afterCount = after.items.find(item => item.id === workspace.id)?.sessionCount

const visibleInItems = (sessions.items || []).some(item => item.id === created.sessionId)
const visibleInGroups = (sessions.groups || []).some(group => group.sessionIds.includes(created.sessionId))
console.log({
  sessionId: created.sessionId,
  workspace: workspace.title,
  beforeCount,
  afterCount,
  visibleInItems,
  visibleInGroups,
})
ws.close()
process.exit(!visibleInItems && !visibleInGroups && beforeCount === afterCount ? 0 : 2)
