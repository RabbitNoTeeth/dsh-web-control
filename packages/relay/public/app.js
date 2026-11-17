/* DSH Web Control web UI. No framework, no build step. */

const $ = id => document.getElementById(id)

const state = {
  user: null,
  instances: [],
  instance: null,
  ws: null,
  clientId: null,
  connected: false,
  sessions: [],
  groups: [],
  ungrouped: [],
  expanded: new Set(),
  expandedReady: false,
  sessionId: null,
  entries: [],
  turnOpen: new Map(),
  detailsOpen: new Set(),
  changesOpen: new Set(),
  history: { hasMore: false, oldestSeq: null, loading: false },
  follow: true,
  running: false,
  sending: false,
  catalog: [],
  defaultSelection: null,
  provider: null,
  model: null,
  reasoning: null,
  permission: null,
  permissions: { options: [], defaultPreset: null, loaded: false },
  prompts: new Map(),
  pendingWorkspace: null,
  routeToken: 0,
  route: { view: 'devices' },
  recentSessionId: null,
  sessionSeed: null,
  pending: new Map(),
  pollTimer: null,
  reconnectTimer: null,
  toastTimer: null,
  live: null,
}

/* ------------------------------------------------------------------- utils */

const PERMISSION_INFO = {
  'read-only': { name: '只读', desc: '只能读取文件，不能执行写入。' },
  'workspace-write': { name: '工作区可写', desc: '允许修改当前工作区内的文件，工作区外仍受限。' },
  'danger-full-access': { name: '完全权限', desc: '不限制命令和文件访问，风险最高，请只在你信任的任务里使用。' },
  custom: { name: '自定义', desc: '当前会话的权限组合不在预设列表中。' },
}

function permissionInfo(value) {
  return PERMISSION_INFO[value] || { name: value || '默认', desc: '' }
}

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function toast(text, ms = 2600) {
  const el = $('toast')
  el.textContent = text
  el.classList.remove('hidden')
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => el.classList.add('hidden'), ms)
}

function show(name) {
  for (const id of ['login', 'instances', 'console']) {
    $(id).classList.toggle('hidden', id !== name)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/'
  const parts = raw.split('/').filter(Boolean)
  try {
    if (parts.length === 0) return { view: 'devices' }
    if (parts[0] === 'pc' && parts.length === 2) {
      return { view: 'instance', instanceId: decodeURIComponent(parts[1]) }
    }
    if (parts[0] === 'pc' && parts[2] === 's' && parts.length === 4) {
      return {
        view: 'session',
        instanceId: decodeURIComponent(parts[1]),
        sessionId: decodeURIComponent(parts[3]),
      }
    }
  } catch {
    return { view: 'unknown' }
  }
  return { view: 'unknown' }
}

function routeHash(route) {
  if (route?.view === 'session') {
    return `#/pc/${encodeURIComponent(route.instanceId)}/s/${encodeURIComponent(route.sessionId)}`
  }
  if (route?.view === 'instance') {
    return `#/pc/${encodeURIComponent(route.instanceId)}`
  }
  return '#/'
}

function setRoute(route, options = {}) {
  const hash = routeHash(route)
  if (location.hash === hash) {
    void renderRoute()
    return
  }
  if (options.replace) {
    history.replaceState(null, '', hash)
    void renderRoute()
    return
  }
  location.hash = hash
}

function setConn(text, tone = 'muted') {
  const el = $('conn-state')
  el.textContent = text
  el.style.color = tone === 'ok' ? 'var(--green)' : tone === 'bad' ? 'var(--red)' : 'var(--muted)'
}

function relativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(ts).toLocaleDateString()
}

function basename(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Fallback for when the vendored Markdown libraries are unavailable. */
function formatTextLegacy(text) {
  const escaped = escapeHtml(text ?? '')
  const parts = escaped.split('```')
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return `<pre class="code">${part.replace(/^\n/, '')}</pre>`
      return part.replace(/\n/g, '<br>')
    })
    .join('')
}

function renderMarkdown(text) {
  const source = String(text ?? '')
  try {
    if (window.marked?.parse && window.DOMPurify?.sanitize) {
      const html = window.marked.parse(source, { gfm: true, breaks: true })
      const clean = window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
      const template = document.createElement('template')
      template.innerHTML = clean
      for (const link of template.content.querySelectorAll('a')) {
        link.target = '_blank'
        link.rel = 'noreferrer noopener'
      }
      return template.innerHTML
    }
  } catch {
    // Fall through to the conservative renderer.
  }
  return formatTextLegacy(source)
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.body) headers['content-type'] = 'application/json'
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`)
    error.status = res.status
    throw error
  }
  return data
}

/* ------------------------------------------------------------------- login */

async function boot() {
  bindEvents()
  if (!location.hash || location.hash === '#') {
    history.replaceState(null, '', '#/')
  }
  try {
    const me = await api('/api/me')
    state.user = me.username
    await renderRoute()
  } catch {
    show('login')
  }
}

function bindEvents() {
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault()
    $('login-error').textContent = ''
    const button = event.submitter
    if (button) button.disabled = true
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('username').value.trim(),
          password: $('password').value,
        }),
      })
      state.user = data.username
      $('password').value = ''
      await renderRoute()
    } catch (error) {
      $('login-error').textContent = error.message
    } finally {
      if (button) button.disabled = false
    }
  })

  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }) } catch {}
    clearInterval(state.pollTimer)
    state.pollTimer = null
    closeConsole()
    state.user = null
    state.routeToken += 1
    history.replaceState(null, '', '#/')
    show('login')
    clearInterval(state.pollTimer)
    state.pollTimer = null
  })

  $('back').addEventListener('click', () => {
    if (state.route.view === 'session') {
      setRoute({ view: 'instance', instanceId: state.route.instanceId })
    } else if (state.route.view === 'instance') {
      setRoute({ view: 'devices' })
    } else {
      showInstances()
    }
  })

  window.addEventListener('hashchange', () => { void renderRoute() })

  $('empty-new-chat').addEventListener('click', () => {
    void openNewChat(null)
  })
  $('send').addEventListener('click', sendMessage)
  $('stop').addEventListener('click', stopTurn)
  $('permission').addEventListener('change', changePermission)
  $('model').addEventListener('change', changeModel)
  $('new-chat-model').addEventListener('change', changeNewChatModel)
  $('new-chat-cancel').addEventListener('click', closeNewChat)
  $('new-chat-create').addEventListener('click', () => { void confirmNewChat() })
  $('new-chat-permission').addEventListener('change', updateNewChatDescription)
  $('new-chat-sheet').addEventListener('click', event => {
    if (event.target === $('new-chat-sheet')) closeNewChat()
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('new-chat-sheet').classList.contains('hidden')) closeNewChat()
  })

  $('input').addEventListener('input', () => {
    const el = $('input')
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`
    updateSendState()
  })

  $('input').addEventListener('keydown', event => {
    const finePointer = window.matchMedia?.('(pointer: fine)').matches
    if (finePointer && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  })

  $('reasoning').addEventListener('change', changeReasoning)
  $('messages').addEventListener('scroll', () => {
    state.follow = nearBottom()
    updateTurnNav()
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.instance === null) {
      refreshInstances().catch(() => {})
    }
  })
}

async function renderRoute() {
  const token = ++state.routeToken
  const route = parseRoute()
  state.route = route
  if (!state.user) {
    show('login')
    return
  }
  if (route.view === 'devices') {
    await showInstances(token)
    return
  }
  if (route.view === 'unknown') {
    toast('页面不存在，已回到设备列表')
    setRoute({ view: 'devices' }, { replace: true })
    return
  }
  try {
    const item = await ensureInstance(route.instanceId, token)
    if (!item || token !== state.routeToken) return
    if (route.view === 'instance') {
      await showSessionList()
      return
    }
    if (!state.sessions.some(session => session.id === route.sessionId)
      && state.recentSessionId !== route.sessionId) {
      const exists = await rpc('session.exists', { sessionId: route.sessionId })
      if (token !== state.routeToken) return
      if (!exists.exists) {
        throw Object.assign(new Error('会话不存在或已归档'), { code: 'missing-session' })
      }
    }
    await openSession(route.sessionId)
  } catch (error) {
    if (token !== state.routeToken) return
    toast(error.message || '打开页面失败', 4000)
    if (route.view === 'session' && error?.code === 'missing-session') {
      setRoute({ view: 'instance', instanceId: route.instanceId }, { replace: true })
    } else {
      setRoute({ view: 'devices' }, { replace: true })
    }
  }
}

async function ensureInstance(instanceId, token) {
  let item = state.instance?.id === instanceId ? state.instance : null
  if (!item) item = state.instances.find(candidate => candidate.id === instanceId) || null
  if (!item) {
    const data = await api('/api/instances')
    state.instances = data.items || []
    item = state.instances.find(candidate => candidate.id === instanceId) || null
  }
  if (!item) throw new Error('电脑不在线或不存在')
  if (token !== state.routeToken) return null
  if (state.instance?.id !== item.id) {
    openConsole(item)
  } else {
    clearInterval(state.pollTimer)
    state.pollTimer = null
    show('console')
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connect()
  }
  const connected = await waitConnected(token)
  if (!connected) return null
  await loadSessions()
  if (token !== state.routeToken) return null
  return item
}

async function waitConnected(token) {
  const deadline = Date.now() + 10_000
  while (!state.clientId) {
    if (token !== state.routeToken) return false
    if (Date.now() > deadline) throw new Error('连接电脑超时')
    await sleep(100)
  }
  return true
}

async function showSessionList() {
  if (state.sessionId) {
    await showSessions()
    return
  }
  $('chat').classList.add('hidden')
  $('session-list-wrap').classList.remove('hidden')
  await loadSessions()
}

async function showInstances(expectedToken = null) {
  show('instances')
  closeSocket()
  state.instance = null
  await refreshInstances().catch(() => {})
  if (expectedToken !== null && expectedToken !== state.routeToken) return
  clearInterval(state.pollTimer)
  state.pollTimer = setInterval(() => {
    if (!document.hidden) refreshInstances().catch(() => {})
  }, 3000)
}

async function refreshInstances() {
  try {
    const data = await api('/api/instances')
    state.instances = data.items || []
    renderInstances()
  } catch (error) {
    if (error.status === 401) {
      clearInterval(state.pollTimer)
      state.pollTimer = null
      state.user = null
      show('login')
    }
    throw error
  }
}

function renderInstances() {
  const wrap = $('instance-list')
  wrap.replaceChildren()
  const empty = $('empty-instances')
  empty.classList.toggle('hidden', state.instances.length > 0)
  for (const item of state.instances) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'card'
    const dot = document.createElement('span')
    dot.className = 'dot online'
    const main = document.createElement('span')
    main.className = 'card-main'
    const name = document.createElement('span')
    name.className = 'card-name'
    name.textContent = item.name || 'DSH'
    const meta = document.createElement('span')
    meta.className = 'card-meta'
    meta.textContent = [item.host, item.version ? `v${item.version}` : '', '在线'].filter(Boolean).join(' · ')
    main.append(name, meta)
    const chev = document.createElement('span')
    chev.className = 'chev'
    chev.textContent = '›'
    card.append(dot, main, chev)
    card.addEventListener('click', () => {
      setRoute({ view: 'instance', instanceId: item.id })
    })
    wrap.append(card)
  }
}

/* ----------------------------------------------------------------- console */

async function openConsole(item) {
  clearInterval(state.pollTimer)
  state.instance = item
  state.sessions = []
  state.groups = []
  state.ungrouped = []
  state.expanded = new Set()
  state.expandedReady = false
  state.sessionId = null
  state.entries = []
  state.turnOpen.clear()
  state.detailsOpen.clear()
  state.changesOpen.clear()
  state.history = { hasMore: false, oldestSeq: null, loading: false }
  state.follow = true
  state.live = null
  state.catalog = []
  state.model = null
  state.provider = null
  state.reasoning = null
  state.permission = null
  state.permissions = { options: [], defaultPreset: null, loaded: false }
  state.prompts.clear()
  state.recentSessionId = null
  state.sessionSeed = null
  renderPrompts()
  $('instance-name').textContent = item.name || 'DSH'
  $('session-list').replaceChildren()
  $('empty-sessions').classList.add('hidden')
  $('chat').classList.add('hidden')
  $('session-list-wrap').classList.remove('hidden')
  show('console')
  setConn('连接中…')
  connect()
}

function closeConsole() {
  closeSocket()
  state.instance = null
  state.sessionId = null
  state.routeToken += 1
}

function closeSocket() {
  clearTimeout(state.reconnectTimer)
  state.reconnectTimer = null
  if (state.ws) {
    try { state.ws.close() } catch {}
    state.ws = null
  }
  state.clientId = null
  state.connected = false
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error('连接已关闭'))
  }
  state.pending.clear()
}

function connect() {
  if (!state.instance) return
  closeSocket()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/ws/client?instance=${encodeURIComponent(state.instance.id)}`
  let ws
  try {
    ws = new WebSocket(url)
  } catch (error) {
    setConn('无法连接', 'bad')
    return
  }
  state.ws = ws
  ws.onopen = () => {
    state.connected = true
    setConn('已连接', 'ok')
  }
  ws.onmessage = event => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    handleMessage(message)
  }
  ws.onerror = () => {}
  ws.onclose = () => {
    state.connected = false
    state.clientId = null
    if (!state.instance) return
    setConn('已断开，重连中…', 'bad')
    // A relay restart invalidates the login cookie: go back to the login page
    // instead of retrying an upgrade that will keep returning 401.
    api('/api/me').catch(error => {
      if (error.status !== 401) return
      clearInterval(state.pollTimer)
      state.pollTimer = null
      state.instance = null
      state.sessionId = null
      closeSocket()
      show('login')
    })
    // A reconnected PC gets a new relay instance id. Retrying the old id would
    // fail forever, so refresh the list and let the user pick the new card.
    api('/api/instances').then(data => {
      if (!state.instance) return
      const stillThere = (data.items || []).some(item => item.id === state.instance.id)
      if (!stillThere) {
        toast('电脑已重新连接，请重新选择')
        state.instance = null
        state.sessionId = null
        closeSocket()
        showInstances()
        return
      }
      scheduleReconnect()
    }).catch(() => scheduleReconnect())
  }
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer)
  state.reconnectTimer = setTimeout(() => {
    if (state.instance) connect()
  }, 2000)
}

function handleMessage(message) {
  if (message.type === 'relay') {
    if (message.event === 'connected') {
      state.clientId = message.clientId
      const info = message.instance || {}
      $('instance-name').textContent = info.name || state.instance?.name || 'DSH'
      setConn('已连接', 'ok')
      loadCatalog()
      loadPermissions()
      loadSessions()
      // A reconnect creates a new relay client id; re-open the conversation
      // that was visible before the transport dropped.
      if (state.sessionId && !$('chat').classList.contains('hidden')) {
        rpc('session.attach', { sessionId: state.sessionId }).catch(error => toast(error.message))
      }
    } else if (message.event === 'instance.disconnected') {
      setConn('电脑已离线', 'bad')
    }
    return
  }

  if (message.type === 'res') {
    const pending = state.pending.get(message.id)
    if (!pending) return
    state.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error?.message || '请求失败'))
    return
  }

  if (message.type === 'evt') {
    handleEvent(message.event)
  }
}

function rpc(method, params = {}, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('尚未连接电脑'))
      return
    }
    const id = uid()
    const timer = setTimeout(() => {
      if (state.pending.delete(id)) reject(new Error('请求超时'))
    }, timeoutMs)
    state.pending.set(id, { resolve, reject, timer })
    state.ws.send(JSON.stringify({ type: 'req', id, method, params }))
  })
}

/* ---------------------------------------------------------------- sessions */

async function loadSessions() {
  if (!state.clientId) return
  try {
    const data = await rpc('sessions.list')
    state.sessions = (data.items || []).filter(item => item.blank !== true)
    state.groups = Array.isArray(data.groups) ? data.groups : []
    state.ungrouped = Array.isArray(data.ungrouped) ? data.ungrouped : []
    if (state.groups.length === 0 && state.sessions.length > 0) {
      state.groups = [{
        id: '__all__',
        title: '全部会话',
        path: '',
        sessionIds: state.sessions.map(item => item.id),
      }]
    }
    if (!state.expandedReady) {
      state.expanded = new Set(
        state.groups
          .filter(group => (group.sessionIds || []).length > 0)
          .map(group => group.id),
      )
      if (state.ungrouped.length > 0) state.expanded.add('__ungrouped__')
      state.expandedReady = true
    }
    renderSessions()
  } catch (error) {
    toast(error.message)
  }
}

function sessionRow(item) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'session'
  if (item.id === state.sessionId) button.classList.add('active')

  const title = document.createElement('div')
  title.className = 'session-title'
  const text = document.createElement('span')
  text.textContent = item.title || '新对话'
  title.append(text)
  if (item.running) {
    const badge = document.createElement('span')
    badge.className = 'badge run'
    badge.textContent = '运行中'
    title.append(badge)
  }

  const meta = document.createElement('div')
  meta.className = 'session-meta'
  const time = document.createElement('span')
  time.textContent = relativeTime(item.updatedAt)
  meta.append(time)
  if (item.cwd) {
    const cwd = document.createElement('span')
    cwd.textContent = basename(item.cwd)
    meta.append(cwd)
  }

  button.append(title, meta)
  button.addEventListener('click', () => {
    if (!state.instance) return
    setRoute({
      view: 'session',
      instanceId: state.instance.id,
      sessionId: item.id,
    })
  })
  return button
}

function workspaceNode(group, sessions) {
  const ungrouped = group.id === '__ungrouped__' || group.id === '__all__'
  const expanded = state.expanded.has(group.id)
  const wrap = document.createElement('div')
  wrap.className = `ws${expanded ? ' open' : ''}`

  const row = document.createElement('div')
  row.className = 'ws-row'
  row.setAttribute('role', 'button')
  row.tabIndex = 0
  row.setAttribute('aria-expanded', String(expanded))

  const chevron = document.createElement('span')
  chevron.className = 'ws-chevron'
  chevron.textContent = '▶'

  const icon = document.createElement('span')
  icon.className = 'ws-icon'
  icon.textContent = ungrouped ? '🗂️' : '📁'

  const main = document.createElement('span')
  main.className = 'ws-main'
  const title = document.createElement('span')
  title.className = 'ws-title'
  title.textContent = group.title || basename(group.path) || '工作区'
  const meta = document.createElement('span')
  meta.className = 'ws-meta'
  meta.textContent = group.id === '__ungrouped__'
    ? `${sessions.length} 个未分组会话`
    : group.id === '__all__'
      ? '没有工作区，显示全部会话'
      : (group.path || '')
  main.append(title, meta)

  const count = document.createElement('span')
  count.className = 'ws-count'
  count.textContent = String(sessions.length)

  row.append(chevron, icon, main, count)

  if (group.id !== '__ungrouped__') {
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'ws-add'
    add.title = group.id === '__all__' ? '新建默认对话' : '在此工作区新建对话'
    add.setAttribute('aria-label', group.id === '__all__' ? '新建默认对话' : `在 ${group.title || '工作区'} 新建对话`)
    add.textContent = '+'
    add.addEventListener('click', event => {
      event.stopPropagation()
      void openNewChat(group.id === '__all__' ? null : group.id)
    })
    row.append(add)
  }

  function toggle() {
    if (state.expanded.has(group.id)) state.expanded.delete(group.id)
    else state.expanded.add(group.id)
    renderSessions()
  }
  row.addEventListener('click', toggle)
  row.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })
  wrap.append(row)

  if (expanded) {
    const children = document.createElement('div')
    children.className = 'ws-children'
    if (sessions.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.style.padding = '12px'
      empty.style.fontSize = '12px'
      empty.textContent = ungrouped ? '没有未分组会话' : '这个工作区还没有对话'
      children.append(empty)
    } else {
      for (const item of sessions) children.append(sessionRow(item))
    }
    wrap.append(children)
  }
  return wrap
}

function renderSessions() {
  const wrap = $('session-list')
  wrap.replaceChildren()
  const byId = new Map(state.sessions.map(item => [item.id, item]))
  let total = 0

  for (const group of state.groups) {
    const sessions = (group.sessionIds || [])
      .map(id => byId.get(id))
      .filter(Boolean)
    total += sessions.length
    wrap.append(workspaceNode(group, sessions))
  }

  if (state.ungrouped.length > 0) {
    const sessions = state.ungrouped.map(id => byId.get(id)).filter(Boolean)
    total += sessions.length
    wrap.append(workspaceNode({
      id: '__ungrouped__',
      title: '未分组',
      path: '',
      sessionIds: state.ungrouped,
    }, sessions))
  }

  $('empty-sessions').classList.toggle('hidden', total > 0 || state.groups.length > 0)
}

async function showSessions() {
  if (state.sessionId) {
    rpc('session.detach', { sessionId: state.sessionId }).catch(() => {})
    state.sessionId = null
  }
  state.live = null
  state.permission = null
  clearPrompts()
  updatePermissionControls()
  $('chat').classList.add('hidden')
  $('session-list-wrap').classList.remove('hidden')
  await loadSessions()
}

async function openSession(sessionId, seed) {
  if (!seed && state.sessionSeed?.sessionId === sessionId) {
    seed = state.sessionSeed
    state.sessionSeed = null
  }
  if (state.recentSessionId === sessionId) state.recentSessionId = null
  if (state.sessionId && state.sessionId !== sessionId) {
    rpc('session.detach', { sessionId: state.sessionId }).catch(() => {})
  }
  state.sessionId = sessionId
  for (const group of state.groups) {
    if ((group.sessionIds || []).includes(sessionId)) state.expanded.add(group.id)
  }
  if (state.ungrouped.includes(sessionId)) state.expanded.add('__ungrouped__')
  state.entries = []
  state.turnOpen.clear()
  state.detailsOpen.clear()
  state.changesOpen.clear()
  state.history = { hasMore: false, oldestSeq: null, loading: false }
  state.follow = true
  state.live = null
  state.permission = null
  state.prompts.clear()
  renderPrompts()
  $('messages').replaceChildren()
  $('turn-nav').replaceChildren()
  $('turn-nav').classList.add('hidden')
  $('session-list-wrap').classList.add('hidden')
  $('chat').classList.remove('hidden')
  state.model = seed?.model || null
  state.provider = seed?.provider || null
  state.reasoning = seed?.reasoningEffort || null
  $('model-wrap').classList.add('hidden')
  $('model').replaceChildren()
  $('reasoning-wrap').classList.add('hidden')
  $('permission-wrap').classList.add('hidden')
  if (seed?.model) updateModelControls()
  renderSessions()
  setRunning(false)
  try {
    await rpc('session.attach', { sessionId })
  } catch (error) {
    toast(error.message)
  }
}

function permissionOptions(include) {
  const fallback = Object.keys(PERMISSION_INFO)
    .filter(value => value !== 'custom')
    .map(value => ({ value, name: value }))
  const base = state.permissions.options.length > 0 ? state.permissions.options : fallback
  const list = [...base]
  if (include && !list.some(option => option.value === include)) {
    list.push({ value: include, name: include })
  }
  return list
}

function fillPermissionSelect(select, value) {
  select.replaceChildren()
  for (const option of permissionOptions(value)) {
    const el = document.createElement('option')
    el.value = option.value
    el.textContent = permissionInfo(option.value).name
    select.append(el)
  }
  select.value = value || select.options[0]?.value || 'workspace-write'
}

async function loadPermissions() {
  if (!state.clientId) return
  try {
    const data = await rpc('permissions.catalog')
    state.permissions = {
      options: Array.isArray(data.options) ? data.options : [],
      defaultPreset: data.defaultPreset || 'workspace-write',
      loaded: true,
    }
  } catch {
    state.permissions = { options: [], defaultPreset: 'workspace-write', loaded: false }
  }
  updatePermissionControls()
}

function updatePermissionControls() {
  const wrap = $('permission-wrap')
  if (!wrap) return
  if (!state.sessionId) {
    wrap.classList.add('hidden')
    return
  }
  wrap.classList.remove('hidden')
  const value = state.permission || state.permissions.defaultPreset || 'workspace-write'
  fillPermissionSelect($('permission'), value)
}

async function changePermission() {
  const select = $('permission')
  const next = select.value
  if (!state.sessionId || !next || next === state.permission) return
  const previous = state.permission
  state.permission = next
  try {
    const data = await rpc('session.setPermission', {
      sessionId: state.sessionId,
      permission: next,
    })
    state.permission = data.permission || next
    toast(`权限已切换为「${permissionInfo(state.permission).name}」`)
  } catch (error) {
    state.permission = previous
    toast(error.message, 4000)
  }
  updatePermissionControls()
}

function updateNewChatDescription() {
  const select = $('new-chat-permission')
  const info = permissionInfo(select.value)
  $('new-chat-permission-desc').textContent = info.desc || ''
}

async function openNewChat(workspaceId) {
  state.pendingWorkspace = workspaceId ?? null
  if (!state.permissions.loaded) await loadPermissions()
  if (state.catalog.length === 0 && state.clientId) await loadCatalog()
  const workspace = workspaceId ? state.groups.find(group => group.id === workspaceId) : null
  $('new-chat-target').textContent = workspaceId
    ? `位置：${workspace?.title || basename(workspace?.path) || '工作区'}${workspace?.path ? ` · ${workspace.path}` : ''}`
    : '位置：默认目录（没有选择工作区）'
  let saved = null
  try { saved = localStorage.getItem('dswc_permission') } catch {}
  const initial = saved && permissionOptions().some(option => option.value === saved)
    ? saved
    : (state.permissions.defaultPreset || 'workspace-write')
  fillPermissionSelect($('new-chat-permission'), initial)
  populateNewChatModels()
  updateNewChatDescription()
  $('new-chat-sheet').classList.remove('hidden')
  $('new-chat-create').focus()
}

function closeNewChat() {
  $('new-chat-sheet').classList.add('hidden')
  state.pendingWorkspace = null
}

async function confirmNewChat() {
  const permission = $('new-chat-permission').value
  const workspaceId = state.pendingWorkspace
  const parsed = parseModelValue($('new-chat-model').value)
  const effort = $('new-chat-reasoning').value || null
  const modelSelection = parsed
    ? {
        provider: parsed.provider,
        model: parsed.model,
        ...(effort ? { reasoningEffort: effort } : {}),
      }
    : null
  if (permission) {
    try { localStorage.setItem('dswc_permission', permission) } catch {}
  }
  if (modelSelection) saveModelSelection(modelSelection)
  closeNewChat()
  await createChat(workspaceId, permission, modelSelection)
}

async function createChat(workspaceId, permission, modelSelection) {
  try {
    const params = {
      ...(workspaceId ? { workspaceId } : {}),
      ...(permission ? { permission } : {}),
      ...(modelSelection || {}),
    }
    const created = await rpc('session.create', params)
    if (created.permissionError) toast(`权限设置失败：${created.permissionError}`, 4000)
    else {
      const group = state.groups.find(item => item.id === workspaceId)
      const place = workspaceId && group
        ? `已在「${group.title || basename(group.path)}」新建会话`
        : '已新建会话'
      toast(`${place} · 权限：${permissionInfo(created.permission).name}`)
    }
    if (created.modelError) toast(`模型设置失败：${created.modelError}`, 4000)
    if (created.provider) state.provider = created.provider
    if (created.model) state.model = created.model
    if (created.reasoningEffort) state.reasoning = created.reasoningEffort
    if (created.permission) state.permission = created.permission
    if (created.workspaceId) state.expanded.add(created.workspaceId)
    else state.expanded.add('__ungrouped__')
    const seed = !created.modelError && created.model
      ? {
          provider: created.provider,
          model: created.model,
          reasoningEffort: created.reasoningEffort,
        }
      : null
    const instanceId = state.instance?.id
    if (instanceId) {
      state.recentSessionId = created.sessionId
      state.sessionSeed = seed ? { sessionId: created.sessionId, ...seed } : null
      await loadSessions()
      setRoute({ view: 'session', instanceId, sessionId: created.sessionId })
    } else {
      await openSession(created.sessionId, seed)
    }
  } catch (error) {
    toast(error.message, 4000)
  }
}

/* -------------------------------------------------------------------- chat */

function localizedText(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return value.zh || value['zh-CN'] || value.en || Object.values(value).find(item => typeof item === 'string') || ''
}

function addPrompt(prompt) {
  if (!prompt?.id) return
  if (prompt.sessionId && state.sessionId && prompt.sessionId !== state.sessionId) return
  state.prompts.set(prompt.id, prompt)
  renderPrompts()
}

function removePrompt(promptId) {
  if (!promptId) return
  state.prompts.delete(promptId)
  renderPrompts()
}

function clearPrompts() {
  state.prompts.clear()
  renderPrompts()
}

function renderPrompts() {
  const box = $('prompts')
  if (!box) return
  const prompts = [...state.prompts.values()]
  box.replaceChildren()
  box.classList.toggle('hidden', prompts.length === 0)
  for (const prompt of prompts) {
    if (prompt.kind === 'approval') box.append(renderApprovalPrompt(prompt))
    else if (prompt.kind === 'question') box.append(renderQuestionPrompt(prompt))
  }
}

function renderApprovalPrompt(prompt) {
  const card = document.createElement('div')
  card.className = 'prompt-card approval'
  const head = document.createElement('div')
  head.className = 'prompt-head'
  head.textContent = `需要确认：${prompt.toolName || '工具'}`
  const reason = localizedText(prompt.displayReason) || prompt.reason || ''
  card.append(head)
  if (reason) {
    const text = document.createElement('p')
    text.className = 'prompt-reason'
    text.textContent = reason
    card.append(text)
  }
  const actions = document.createElement('div')
  actions.className = 'prompt-actions'
  const reject = document.createElement('button')
  reject.type = 'button'
  reject.className = 'ghost'
  reject.textContent = '拒绝'
  const allow = document.createElement('button')
  allow.type = 'button'
  allow.className = 'primary'
  allow.textContent = '允许一次'
  const decide = async outcome => {
    reject.disabled = true
    allow.disabled = true
    try {
      await rpc('approval.answer', {
        sessionId: state.sessionId,
        promptId: prompt.id,
        outcome,
      })
      removePrompt(prompt.id)
    } catch (error) {
      reject.disabled = false
      allow.disabled = false
      toast(error.message, 4000)
    }
  }
  reject.addEventListener('click', () => { void decide('rejected') })
  allow.addEventListener('click', () => { void decide('allowed-once') })
  actions.append(reject, allow)
  card.append(actions)
  return card
}

function renderQuestionPrompt(prompt) {
  const card = document.createElement('div')
  card.className = 'prompt-card question'
  const head = document.createElement('div')
  head.className = 'prompt-head'
  head.textContent = (prompt.questions?.length || 0) > 1
    ? `需要你的回答（${prompt.questions.length} 个问题）`
    : '需要你的回答'
  card.append(head)

  const blocks = []
  for (const question of prompt.questions || []) {
    const block = document.createElement('div')
    block.className = 'prompt-question'
    if (question.header && question.header !== question.question) {
      const title = document.createElement('h4')
      title.textContent = question.header
      block.append(title)
    }
    const text = document.createElement('div')
    text.textContent = localizedText(question.intent?.display?.question) || question.question || ''
    block.append(text)
    if (question.detail) {
      const detail = document.createElement('div')
      detail.className = 'prompt-detail'
      detail.innerHTML = renderMarkdown(question.detail)
      block.append(detail)
    }
    if (Array.isArray(question.options) && question.options.length > 0) {
      const options = document.createElement('div')
      options.className = 'prompt-options'
      const name = `prompt-${prompt.id}-${question.id}`
      for (const option of question.options) {
        const label = document.createElement('label')
        label.className = 'prompt-option'
        const input = document.createElement('input')
        input.type = question.multiSelect ? 'checkbox' : 'radio'
        input.name = name
        input.value = option.label
        const content = document.createElement('span')
        content.textContent = option.label
        if (option.description) {
          const desc = document.createElement('span')
          desc.className = 'prompt-option-desc'
          desc.textContent = option.description
          content.append(desc)
        }
        label.append(input, content)
        options.append(label)
      }
      block.append(options)
    }
    const custom = document.createElement('textarea')
    custom.className = 'prompt-custom'
    custom.rows = 2
    custom.placeholder = '自定义回答（可选）'
    block.append(custom)
    card.append(block)
    blocks.push({ question, block })
  }

  const actions = document.createElement('div')
  actions.className = 'prompt-actions'
  const submit = document.createElement('button')
  submit.type = 'button'
  submit.className = 'primary'
  submit.textContent = '提交回答'
  submit.addEventListener('click', async () => {
    const answers = []
    for (const { question, block } of blocks) {
      const selected = [...block.querySelectorAll('input:checked')].map(input => input.value)
      const custom = block.querySelector('textarea').value.trim()
      if (question.multiSelect) {
        const answer = { id: question.id, selected }
        if (custom) answer.custom = custom
        answers.push(answer)
      } else if (custom) {
        answers.push({ id: question.id, selected: [], custom })
      } else {
        answers.push({ id: question.id, selected: selected.slice(0, 1) })
      }
    }
    submit.disabled = true
    try {
      await rpc('question.answer', {
        sessionId: state.sessionId,
        promptId: prompt.id,
        answers,
      })
      removePrompt(prompt.id)
    } catch (error) {
      submit.disabled = false
      toast(error.message, 4000)
    }
  })
  actions.append(submit)
  card.append(actions)
  return card
}

function updateSendState() {
  const input = $('input')
  $('send').disabled = state.running || state.sending || !state.sessionId || input.value.trim().length === 0
}

function setRunning(running) {
  state.running = running
  $('send').classList.toggle('hidden', running)
  $('stop').classList.toggle('hidden', !running)
  updateSendState()
  if (state.sessionId) {
    const row = state.sessions.find(item => item.id === state.sessionId)
    if (row) {
      row.running = running
      renderSessions()
    }
  }
}

async function sendMessage() {
  const input = $('input')
  const text = input.value.trim()
  if (!text || !state.sessionId || state.running || state.sending) return
  state.sending = true
  const button = $('send')
  button.disabled = true
  try {
    await rpc('session.prompt', {
      sessionId: state.sessionId,
      text,
      requestId: uid(),
      mode: 'queue',
    })
    input.value = ''
    input.style.height = 'auto'
    state.follow = true
    scrollBottom(true)
    setRunning(true)
  } catch (error) {
    toast(error.message, 4000)
  } finally {
    state.sending = false
    updateSendState()
    input.focus()
  }
}

async function stopTurn() {
  if (!state.sessionId) return
  try {
    await rpc('session.stop', { sessionId: state.sessionId })
  } catch (error) {
    toast(error.message)
  }
}

function handleEvent(event) {
  if (!event || event.sessionId !== state.sessionId) {
    if (event?.kind === 'snapshot' && !state.sessionId) return
    if (event?.kind === 'session.info' && event.sessionId !== state.sessionId) return
    if (event?.kind === 'error') toast(event.message, 4000)
    return
  }

  switch (event.kind) {
    case 'session.info':
      if (event.provider) state.provider = event.provider
      if (event.model) state.model = event.model
      if (event.reasoningEffort) state.reasoning = event.reasoningEffort
      if (event.permission) state.permission = event.permission
      updateModelControls()
      updatePermissionControls()
      setRunning(event.running === true)
      break
    case 'snapshot':
      state.entries = event.entries || []
      state.history = {
        hasMore: event.hasMore === true,
        oldestSeq: Number.isFinite(event.oldestSeq)
          ? event.oldestSeq
          : (state.entries[0]?.seq ?? null),
        loading: false,
      }
      state.follow = true
      renderMessages(true)
      requestAnimationFrame(() => scrollBottom(true))
      setRunning(event.running === true)
      break
    case 'entry':
      if (event.entry) {
        state.entries.push(event.entry)
        renderMessages()
      }
      break
    case 'prompt':
      if (event.prompt) addPrompt(event.prompt)
      break
    case 'prompt.cancel':
      removePrompt(event.promptId)
      break
    case 'delta':
      appendDelta(event)
      break
    case 'delta.end':
      if (state.live) state.live.done = true
      break
    case 'state':
      setRunning(event.running === true)
      break
    case 'error':
      toast(event.message, 4000)
      break
    default:
      break
  }
}

function renderMessages(forceBottom = false) {
  const messages = $('messages')
  const stick = forceBottom || state.follow || nearBottom()
  const previousTop = messages.scrollTop
  messages.replaceChildren()
  state.live = null
  if (state.history.hasMore) messages.append(renderLoadOlder())
  for (const turn of groupTurns(state.entries)) messages.append(renderTurn(turn))
  renderTurnNav()
  if (stick) {
    state.follow = true
    scrollBottom(true)
  } else {
    messages.scrollTop = previousTop
  }
}

function renderLoadOlder() {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'load-older'
  button.disabled = state.history.loading
  button.textContent = state.history.loading ? '加载中…' : '加载更早的消息'
  button.addEventListener('click', () => { void loadOlder() })
  return button
}

function renderTurnNav() {
  const nav = $('turn-nav')
  if (!nav) return
  const items = [...$('messages').querySelectorAll('.turn[data-nav]')]
  nav.replaceChildren()
  if (items.length < 2) {
    nav.classList.add('hidden')
    return
  }
  nav.classList.remove('hidden')
  items.forEach((item, index) => {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = 'turn-dot'
    const label = item.dataset.nav || `问题 ${index + 1}`
    dot.title = label
    dot.setAttribute('aria-label', `跳到问题 ${index + 1}: ${label}`)
    dot.addEventListener('click', () => scrollToQuestion(item, dot))
    nav.append(dot)
  })
  updateTurnNav()
}

function scrollToQuestion(item, dot) {
  const messages = $('messages')
  state.follow = false
  messages.scrollTop = Math.max(0, item.offsetTop - 8)
  for (const button of $('turn-nav').children) button.classList.remove('active')
  dot.classList.add('active')
}

function updateTurnNav() {
  const nav = $('turn-nav')
  if (!nav || nav.classList.contains('hidden')) return
  const messages = $('messages')
  const items = [...messages.querySelectorAll('.turn[data-nav]')]
  if (items.length === 0) return
  const top = messages.getBoundingClientRect().top
  let active = 0
  items.forEach((item, index) => {
    if (item.getBoundingClientRect().top - top <= 40) active = index
  })
  if (nearBottom()) active = items.length - 1
  const dots = [...nav.children]
  dots.forEach((dot, index) => dot.classList.toggle('active', index === active))
}

async function loadOlder() {
  if (state.history.loading || !state.history.hasMore || !state.sessionId) return
  const messages = $('messages')
  const beforeHeight = messages.scrollHeight
  const beforeTop = messages.scrollTop
  state.follow = false
  state.history.loading = true
  renderMessages()
  try {
    const data = await rpc('session.history', {
      sessionId: state.sessionId,
      beforeSeq: state.history.oldestSeq,
    })
    const known = new Set(state.entries.map(entry => entry.seq))
    const older = (data.entries || []).filter(entry => !known.has(entry.seq))
    state.entries = [...older, ...state.entries]
    state.history.hasMore = data.hasMore === true
    state.history.oldestSeq = older[0]?.seq ?? state.entries[0]?.seq ?? null
    state.history.loading = false
    renderMessages()
    messages.scrollTop = beforeTop + (messages.scrollHeight - beforeHeight)
  } catch (error) {
    state.history.loading = false
    toast(error.message, 4000)
    renderMessages()
  }
}

/**
 * One Turn is a user input plus everything until the next input or turn end.
 * The process (reasoning and tool calls) is folded; every assistant reply stays
 * visible, mirroring DSH Chat's default "all replies" presentation.
 */
function groupTurns(entries) {
  const turns = []
  let turn = null
  const openTurn = entry => {
    turn = {
      key: entry.seq != null ? `seq:${entry.seq}` : `idx:${turns.length}`,
      items: [],
      end: null,
      startTime: entry.time ?? null,
      startFromInput: entry.kind === 'user',
    }
    turns.push(turn)
  }
  for (const entry of entries) {
    if (!turn) openTurn(entry)
    if (!turn.startTime && entry.time) turn.startTime = entry.time
    if (entry.kind === 'user') {
      if (turn.items.length > 0) openTurn(entry)
      turn.items.push(entry)
      continue
    }
    if (entry.kind === 'turn-end') {
      turn.end = entry
      turn = null
      continue
    }
    turn.items.push(entry)
  }
  return turns
}

function renderTurn(turn) {
  const wrap = document.createElement('div')
  wrap.className = 'turn'
  const inputs = turn.items.filter(item => item.kind === 'user')
  for (const input of inputs) wrap.append(renderUserBubble(input))
  if (inputs.length > 0) {
    const label = inputs.map(input => input.text || '').join(' ').replace(/\s+/g, ' ').trim()
    if (label) wrap.dataset.nav = label.slice(0, 140)
  }
  const process = collectProcess(turn.items)
  const toolCount = process.reduce((count, item) => count + (item.call ? 1 : 0), 0)
  if (process.length > 0) wrap.append(renderProcess(turn, process, toolCount))
  for (const item of turn.items) {
    if (item.kind === 'assistant') wrap.append(renderAssistantBubble(item))
  }
  const changes = [...turn.items].reverse().find(item => item.kind === 'changes' && item.files?.length)
  if (changes) wrap.append(renderChanges(changes, `changes:${changes.seq}`))
  if (turn.end?.reason === 'error' && turn.end.error) {
    const divider = document.createElement('div')
    divider.className = 'turn-end error'
    divider.textContent = turn.end.error
    wrap.append(divider)
  }
  return wrap
}

function renderUserBubble(entry) {
  const row = document.createElement('div')
  row.className = 'msg user'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const text = document.createElement('div')
  text.className = 'text'
  text.textContent = entry.text || ''
  bubble.append(text)
  row.append(bubble)
  return row
}

function renderAssistantBubble(entry) {
  const row = document.createElement('div')
  row.className = 'msg assistant'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const text = document.createElement('div')
  text.className = 'text markdown'
  text.innerHTML = renderMarkdown(entry.text || '')
  bubble.append(text)
  if (entry.interrupted) {
    const note = document.createElement('div')
    note.className = 'usage'
    note.textContent = '已中断'
    bubble.append(note)
  } else if (entry.usage) {
    const usage = document.createElement('div')
    usage.className = 'usage'
    const total = entry.usage.total ?? (entry.usage.input ?? 0) + (entry.usage.output ?? 0)
    usage.textContent = `${total} tokens`
    bubble.append(usage)
  }
  row.append(bubble)
  return row
}

function renderChanges(entry, key) {
  const files = entry.files || []
  const card = document.createElement('div')
  card.className = 'changes-card'
  const head = document.createElement('div')
  head.className = 'changes-head'
  const title = document.createElement('span')
  title.className = 'changes-title'
  title.textContent = `已编辑 ${entry.total ?? files.length} 个文件`
  const stats = document.createElement('span')
  stats.className = 'changes-stats'
  if (Number.isFinite(entry.added) || Number.isFinite(entry.deleted)) {
    const added = document.createElement('span')
    added.className = 'changes-add'
    added.textContent = `+${entry.added ?? 0}`
    const deleted = document.createElement('span')
    deleted.className = 'changes-del'
    deleted.textContent = `-${entry.deleted ?? 0}`
    stats.append(added, deleted)
  }
  head.append(title, stats)
  const list = document.createElement('ul')
  list.className = 'changes-list'
  const expanded = state.changesOpen.has(key)
  const visible = expanded ? files : files.slice(0, 4)
  for (const file of visible) {
    const row = document.createElement('li')
    row.className = 'changes-row'
    const path = document.createElement('span')
    path.className = 'changes-path'
    path.textContent = file.display || file.path
    path.title = file.path
    const counts = document.createElement('span')
    counts.className = 'changes-counts'
    if (file.binary) counts.textContent = '二进制'
    else if (file.oversized) counts.textContent = '过大'
    else {
      const added = document.createElement('span')
      added.className = 'changes-add'
      added.textContent = `+${file.added ?? 0}`
      const deleted = document.createElement('span')
      deleted.className = 'changes-del'
      deleted.textContent = `-${file.deleted ?? 0}`
      counts.append(added, deleted)
    }
    row.append(path, counts)
    list.append(row)
  }
  card.append(head, list)
  if (files.length > 4) {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'changes-toggle'
    toggle.textContent = expanded ? '收起' : `展开全部 ${files.length} 个`
    toggle.addEventListener('click', () => {
      if (expanded) state.changesOpen.delete(key)
      else state.changesOpen.add(key)
      renderMessages()
    })
    card.append(toggle)
  }
  return card
}

/** Pair tool calls with their results and keep reasoning in its original order. */
function collectProcess(items) {
  const list = []
  const calls = new Map()
  for (const item of items) {
    if (item.kind === 'tool') {
      const card = { call: item, result: null }
      if (item.callId) calls.set(item.callId, card)
      list.push(card)
    } else if (item.kind === 'tool-result') {
      const card = item.callId ? calls.get(item.callId) : undefined
      if (card) card.result = item
      else list.push({ call: null, result: item })
    } else if (item.kind === 'assistant' && item.reasoning) {
      list.push({ reasoning: item.reasoning, seq: item.seq })
    }
  }
  return list
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

function processSummary(turn, toolCount) {
  const reason = turn.end?.reason
  let label
  if (!turn.end) label = '处理中'
  else if (reason === 'aborted') label = '已停止'
  else if (reason === 'error') label = '处理失败'
  else if (reason === 'max-tokens') label = '达到输出上限'
  else if (reason === 'blocked') label = '已阻止'
  else if (turn.startFromInput && turn.startTime && turn.end.time) {
    label = `已处理 ${formatDuration(turn.end.time - turn.startTime)}`
  } else label = '已处理'
  return { label, meta: toolCount > 0 ? `${toolCount} 个工具调用` : '' }
}

function renderProcess(turn, process, toolCount) {
  const details = document.createElement('details')
  details.className = 'turn-process'
  details.open = state.turnOpen.get(turn.key) === true
  const summary = document.createElement('summary')
  const label = document.createElement('span')
  label.className = 'proc-label'
  const info = processSummary(turn, toolCount)
  label.textContent = info.label
  summary.append(label)
  if (info.meta) {
    const right = document.createElement('span')
    right.className = 'proc-meta'
    right.textContent = info.meta
    summary.append(right)
  }
  const body = document.createElement('div')
  body.className = 'process-body'
  process.forEach((item, index) => {
    if (item.reasoning) {
      body.append(renderReasoningBlock(item, `reason:${item.seq ?? index}`))
    } else {
      const key = item.call?.callId
        ? `tool:${item.call.callId}`
        : item.result?.seq
          ? `result:${item.result.seq}`
          : `tool:${turn.key}:${index}`
      body.append(renderToolBlock(item, key))
    }
  })
  details.append(summary, body)
  details.addEventListener('toggle', () => state.turnOpen.set(turn.key, details.open))
  return details
}

function bindDetails(details, key) {
  details.open = state.detailsOpen.has(key)
  details.addEventListener('toggle', () => {
    if (details.open) state.detailsOpen.add(key)
    else state.detailsOpen.delete(key)
  })
}

function renderToolBlock(item, key) {
  const { call, result } = item
  const details = document.createElement('details')
  details.className = 'tool'
  if (result && result.ok === false) details.classList.add('err')
  const summary = document.createElement('summary')
  const name = document.createElement('span')
  name.className = 'tool-name'
  name.textContent = `🔧 ${call?.name || '工具结果'}`
  const status = document.createElement('span')
  status.className = 'tool-state'
  status.textContent = result ? (result.ok ? '成功' : '失败') : '运行中'
  summary.append(name, status)
  details.append(summary)
  if (call?.args) addToolSection(details, '参数', call.args)
  if (result?.text) addToolSection(details, '结果', result.text)
  else if (result?.error) addToolSection(details, '错误', result.error)
  bindDetails(details, key)
  return details
}

function addToolSection(details, title, text) {
  const box = document.createElement('div')
  box.className = 'tool-section'
  const caption = document.createElement('div')
  caption.className = 'tool-caption'
  caption.textContent = title
  const pre = document.createElement('pre')
  pre.textContent = text
  box.append(caption, pre)
  details.append(box)
}

function renderReasoningBlock(item, key) {
  const details = document.createElement('details')
  details.className = 'process-reasoning'
  const summary = document.createElement('summary')
  summary.textContent = '思考过程'
  const pre = document.createElement('pre')
  pre.textContent = item.reasoning
  details.append(summary, pre)
  bindDetails(details, key)
  return details
}

function ensureLive() {
  if (state.live && !state.live.done) return state.live
  removeLive()
  const row = document.createElement('div')
  row.className = 'msg assistant'
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  const text = document.createElement('div')
  text.className = 'text markdown'
  bubble.append(text)
  row.append(bubble)
  $('messages').append(row)
  state.live = { row, bubble, text, done: false, textValue: '' }
  return state.live
}

function appendDelta(event) {
  // Reasoning streams into the settled Turn process, not into a visible reply.
  if (event.reasoning) return
  const shouldScroll = nearBottom()
  const live = ensureLive()
  live.textValue += event.text || ''
  live.text.innerHTML = renderMarkdown(live.textValue)
  if (shouldScroll) scrollBottom(true)
}

function removeLive() {
  if (state.live?.row) {
    try { state.live.row.remove() } catch {}
  }
  state.live = null
}

function nearBottom() {
  const el = $('messages')
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140
}

function scrollBottom(force = false) {
  if (!force && !state.follow && !nearBottom()) return
  const el = $('messages')
  el.scrollTop = el.scrollHeight
  if (force) state.follow = true
}

/* ------------------------------------------------------------------ models */

async function loadCatalog() {
  try {
    const data = await rpc('models.catalog')
    state.catalog = data.groups || []
    state.defaultSelection = data.default || null
    updateModelControls()
  } catch {
    // A missing catalog only disables the model and reasoning selectors.
  }
}

function modelItems() {
  const items = []
  for (const group of state.catalog) {
    for (const model of group.models || []) {
      items.push({ provider: group.id, groupName: group.name || group.id, model })
    }
  }
  return items
}

function findCatalogModel(provider, modelId) {
  return modelItems().find(item =>
    item.model.id === modelId && (!provider || item.provider === provider)) || null
}

function modelValue(provider, modelId) {
  return JSON.stringify([provider || '', modelId || ''])
}

function parseModelValue(value) {
  try {
    const [provider, model] = JSON.parse(value)
    if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  } catch {}
  return null
}

function populateModelSelect(select, provider, modelId) {
  const items = modelItems()
  select.replaceChildren()
  if (items.length === 0) {
    const option = document.createElement('option')
    option.value = modelId ? modelValue(provider || '', modelId) : ''
    option.textContent = modelId || '暂无模型'
    select.append(option)
    select.disabled = !modelId
    return modelId ? { provider: provider || '', model: modelId, entry: null } : null
  }

  let selected = null
  if (modelId) {
    selected = items.find(item =>
      item.model.id === modelId && (!provider || item.provider === provider)) || null
  } else {
    const fallback = state.defaultSelection
    if (fallback) {
      selected = items.find(item =>
        item.model.id === fallback.model && item.provider === fallback.provider) || null
    }
    if (!selected) selected = items.find(item => /flash/i.test(item.model.id)) || items[0]
  }

  const groups = new Map()
  for (const item of items) {
    let bucket = groups.get(item.provider)
    if (!bucket) {
      bucket = { name: item.groupName, items: [] }
      groups.set(item.provider, bucket)
    }
    bucket.items.push(item)
  }
  for (const bucket of groups.values()) {
    const optgroup = document.createElement('optgroup')
    optgroup.label = bucket.name
    for (const item of bucket.items) {
      const option = document.createElement('option')
      option.value = modelValue(item.provider, item.model.id)
      option.textContent = item.model.name || item.model.id
      optgroup.append(option)
    }
    select.append(optgroup)
  }

  const hasRequested = modelId && items.some(item =>
    item.model.id === modelId && (!provider || item.provider === provider))
  if (modelId && !hasRequested) {
    const option = document.createElement('option')
    option.value = modelValue(provider || '', modelId)
    option.textContent = `${modelId}（不可用）`
    select.append(option)
    selected = { provider: provider || '', model: modelId, entry: null }
  }

  select.disabled = false
  if (!selected) return null
  const selectedId = typeof selected.model === 'string' ? selected.model : selected.model.id
  select.value = modelValue(selected.provider, selectedId)
  if (selected.entry === undefined && typeof selected.model === 'object') {
    return { provider: selected.provider, model: selectedId, entry: selected }
  }
  return selected
}

function populateReasoningSelect(select, wrap, selected, preferred) {
  const efforts = selected?.entry?.model?.reasoning?.efforts || []
  if (!selected?.entry || efforts.length === 0) {
    wrap.classList.add('hidden')
    select.replaceChildren()
    return null
  }
  wrap.classList.remove('hidden')
  let value = efforts.some(effort => effort.id === preferred) ? preferred : null
  if (!value) value = selected.entry.model.reasoning?.defaultEffort || efforts[0].id
  select.replaceChildren()
  for (const effort of efforts) {
    const option = document.createElement('option')
    option.value = effort.id
    option.textContent = effort.name || effort.id
    select.append(option)
  }
  select.value = value
  return value
}

function updateModelControls() {
  if (!state.model && state.catalog.length === 0) {
    $('model-wrap').classList.add('hidden')
    $('reasoning-wrap').classList.add('hidden')
    return
  }
  const selected = populateModelSelect($('model'), state.provider, state.model)
  if (!selected) {
    $('model-wrap').classList.add('hidden')
    $('reasoning-wrap').classList.add('hidden')
    return
  }
  $('model-wrap').classList.remove('hidden')
  if (selected.entry) {
    state.provider = selected.provider
    state.model = selected.model
  }
  const effort = populateReasoningSelect($('reasoning'), $('reasoning-wrap'), selected, state.reasoning)
  state.reasoning = effort
}

async function changeModel() {
  const parsed = parseModelValue($('model').value)
  if (!state.sessionId || !parsed) return
  const item = findCatalogModel(parsed.provider, parsed.model)
  if (!item) return
  const previous = {
    provider: state.provider,
    model: state.model,
    reasoning: state.reasoning,
  }
  const efforts = item.model.reasoning?.efforts || []
  let effort = efforts.some(entry => entry.id === state.reasoning) ? state.reasoning : null
  if (!effort && efforts.length > 0) {
    effort = item.model.reasoning?.defaultEffort || efforts[0].id
  }
  state.provider = item.provider
  state.model = item.model.id
  state.reasoning = effort || null
  updateModelControls()
  try {
    await rpc('session.setModel', {
      sessionId: state.sessionId,
      provider: item.provider,
      model: item.model.id,
      ...(effort ? { reasoningEffort: effort } : {}),
    })
    toast(`模型已切换为「${item.model.name || item.model.id}」`)
  } catch (error) {
    Object.assign(state, previous)
    updateModelControls()
    toast(error.message, 4000)
  }
}

async function changeReasoning() {
  const value = $('reasoning').value
  if (!state.sessionId || !state.model || !state.provider) return
  const previous = state.reasoning
  state.reasoning = value
  try {
    await rpc('session.setReasoning', {
      sessionId: state.sessionId,
      provider: state.provider,
      model: state.model,
      reasoningEffort: value,
    })
    const found = findCatalogModel(state.provider, state.model)
    const effort = found?.model.reasoning?.efforts?.find(item => item.id === value)
    toast(`思考级别：${effort?.name || value}`)
  } catch (error) {
    state.reasoning = previous
    updateModelControls()
    toast(error.message, 4000)
  }
}

function readSavedModel() {
  try {
    const raw = localStorage.getItem('dswc_model')
    if (!raw) return null
    const value = JSON.parse(raw)
    if (typeof value?.provider === 'string' && typeof value.model === 'string') {
      return value
    }
  } catch {}
  return null
}

function saveModelSelection(selection) {
  try { localStorage.setItem('dswc_model', JSON.stringify(selection)) } catch {}
}

function populateNewChatModels() {
  const saved = readSavedModel()
  let provider = null
  let modelId = null
  let preferred = null
  if (state.model && state.provider) {
    provider = state.provider
    modelId = state.model
    preferred = state.reasoning
  } else if (saved) {
    provider = saved.provider
    modelId = saved.model
    preferred = saved.reasoningEffort ?? null
  }
  if (!modelId && state.defaultSelection) {
    provider = state.defaultSelection.provider
    modelId = state.defaultSelection.model
    preferred = state.defaultSelection.reasoningEffort ?? null
  }
  if (modelId && !findCatalogModel(provider, modelId)) {
    const fallback = state.defaultSelection
    provider = fallback?.provider ?? null
    modelId = fallback?.model ?? null
    preferred = fallback?.reasoningEffort ?? null
  }
  const selected = populateModelSelect($('new-chat-model'), provider, modelId)
  populateReasoningSelect($('new-chat-reasoning'), $('new-chat-reasoning-wrap'), selected, preferred)
}

function changeNewChatModel() {
  const parsed = parseModelValue($('new-chat-model').value)
  if (!parsed) return
  const item = findCatalogModel(parsed.provider, parsed.model)
  const preferred = $('new-chat-reasoning').value || null
  populateReasoningSelect(
    $('new-chat-reasoning'),
    $('new-chat-reasoning-wrap'),
    item ? { provider: parsed.provider, model: parsed.model, entry: item } : null,
    preferred,
  )
}

boot()
