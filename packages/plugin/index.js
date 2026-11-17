/**
 * DSH Web Control — DSH host plugin.
 *
 * Connects outbound to a personal relay server and lets a web browser
 * drive this DSH instance: list sessions, create a session, chat, stop, and
 * switch the reasoning effort.
 *
 * No runtime dependencies: uses the Electron/Node WebSocket and fetch globals.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN_VERSION = '0.2.0'
const DEFAULT_PORT = 7801
const DEFAULT_MODEL = 'deepseek-flash'
const FULL_ACCESS_PRESET = 'danger-full-access'
const MAX_TEXT = 40_000

export const inject = ['sessionController', 'commands', 'connection', 'webServer']

/* ------------------------------------------------------------------ config */

function configPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-web-control.json')
}

/** Settings written before the plugin was renamed to dsh-web-control. */
function legacyConfigPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'xdcontrol.json')
}

function readConfigFile(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function loadFileConfig() {
  const fallback = {
    enabled: true,
    relayHost: '',
    relayPort: DEFAULT_PORT,
    instanceName: os.hostname(),
    pluginToken: '',
    defaultCwd: '',
  }
  let raw
  let migrated = false
  try {
    raw = readConfigFile(configPath())
  } catch {
    try {
      raw = readConfigFile(legacyConfigPath())
      migrated = true
    } catch {
      return { config: fallback, migrated: false }
    }
  }
  const merged = { ...fallback, ...raw }
  merged.enabled = merged.enabled !== false
  merged.relayHost = normalizeHost(merged.relayHost)
  if (merged.relayPort === undefined || merged.relayPort === null) {
    merged.relayPort = DEFAULT_PORT
  }
  if (migrated) {
    // Keep the old file untouched; the next save writes the new one.
    try {
      writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8')
    } catch {
      migrated = false
    }
  }
  return { config: merged, migrated }
}

async function saveConfig(next) {
  const file = configPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(next, null, 2), 'utf8')
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendRpc(res, rpcId, result) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

/* ------------------------------------------------------------------- utils */

function clampText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? `${value.slice(0, limit)}\n…(已截断)` : value
}

function normalizeHost(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^\[|\]$/g, '')
}

function shortJson(value, limit = 2000) {
  if (value === undefined || value === null) return ''
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return clampText(text, limit)
}

function splitContent(content) {
  let text = ''
  let reasoning = ''
  if (!Array.isArray(content)) {
    if (typeof content === 'string') text = content
    return { text, reasoning }
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        text += block.text ?? ''
        break
      case 'reasoning':
        reasoning += block.text ?? ''
        break
      case 'image':
        text += '[图片]'
        break
      case 'file':
        text += `[文件${block.attachment?.name ? ` ${block.attachment.name}` : ''}]`
        break
      default:
        break
    }
  }
  return { text, reasoning }
}

function turnEndReason(reason) {
  if (!reason || typeof reason !== 'object') return { kind: 'completed' }
  const kind = reason.kind ?? 'completed'
  if (kind === 'error') {
    const message = reason.error?.message || reason.error?.code || '模型请求失败'
    return { kind, error: clampText(String(message), 2000) }
  }
  if (kind === 'aborted') {
    const cause = reason.reason?.kind
    return { kind, error: cause === 'user' ? '已被用户停止' : undefined }
  }
  return { kind }
}

/** Map one durable DSH session event into the browser timeline entry. */
function mapEvent(event, changesSummary) {
  if (!event || typeof event !== 'object') return null
  const data = event.data ?? {}
  const seq = event.seq
  const time = event.time
  switch (event.type) {
    case 'user/message': {
      const source = data.source
      if (source && typeof source === 'object' && source.kind && source.kind !== 'user') return null
      const { text } = splitContent(data.content)
      if (!text) return null
      const trimmed = text.trimStart()
      if (trimmed.startsWith('<system-reminder>')) return null
      if (/^Time sampled while preparing/.test(trimmed)) return null
      return { kind: 'user', seq, time, text: clampText(text) }
    }
    case 'assistant/message': {
      const { text, reasoning } = splitContent(data.message?.content)
      if (!text) return null
      const entry = {
        kind: 'assistant',
        seq,
        time,
        text: clampText(text),
        reasoning: clampText(reasoning),
        interrupted: data.interrupted === true,
      }
      if (data.usage) {
        entry.usage = {
          input: data.usage.inputTokens,
          output: data.usage.outputTokens,
          total: data.usage.totalTokens,
        }
      }
      return entry
    }
    case 'tool/call': {
      return {
        kind: 'tool',
        seq,
        time,
        callId: data.callId,
        name: data.name,
        args: shortJson(data.arguments),
      }
    }
    case 'tool/result': {
      const { text } = splitContent(data.message?.content)
      return {
        kind: 'tool-result',
        seq,
        time,
        callId: data.message?.toolCallId,
        ok: !data.error,
        text: clampText(text, 8000),
        error: data.error
          ? shortJson(data.error.reason || data.error.code || data.error.name)
          : undefined,
      }
    }
    case 'turn/end': {
      const ended = turnEndReason(data.reason)
      return { kind: 'turn-end', seq, time, reason: ended.kind, error: ended.error }
    }
    case 'workspace/changes': {
      const summary = changesSummary
      if (!summary || !Array.isArray(summary.files) || summary.files.length === 0) return null
      return {
        kind: 'changes',
        seq,
        time,
        turn: summary.turn,
        cwd: summary.cwd,
        files: summary.files.map(file => ({
          path: file.path,
          display: file.display,
          added: file.added,
          deleted: file.deleted,
          binary: file.binary === true,
          oversized: file.oversized === true,
        })),
        total: summary.total,
        added: summary.added,
        deleted: summary.deleted,
      }
    }
    default:
      return null
  }
}

function pickModel(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const candidates = []
  for (const group of groups) {
    for (const model of group.models ?? []) {
      candidates.push({ provider: group.id, model })
    }
  }
  if (candidates.length === 0) return null
  const preferred = catalog?.default
  const byDefault =
    preferred &&
    candidates.find(
      item => item.provider === preferred.provider && item.model.id === preferred.model,
    )
  const byId = candidates.find(item => item.model.id === DEFAULT_MODEL)
  const byName = candidates.find(item => /v4\.1.*flash/i.test(item.model.name ?? ''))
  const byFlash = candidates.find(item => /flash/i.test(item.model.id ?? ''))
  const chosen = byDefault ?? byId ?? byName ?? byFlash ?? candidates[0]
  let effort
  const reasoning = chosen.model.reasoning
  if (reasoning && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
    const high = reasoning.efforts.find(
      item => /high/i.test(item.id) || /高/i.test(item.name ?? ''),
    )
    effort =
      high?.id ??
      reasoning.defaultEffort ??
      reasoning.efforts[reasoning.efforts.length - 1].id
  }
  return { provider: chosen.provider, model: chosen.model.id, effort }
}

/* ------------------------------------------------------------- relay client */

class RelayClient {
  constructor(ctx, config, state) {
    this.ctx = ctx
    this.config = config
    this.state = state
    this.ws = null
    this.stopped = false
    this.retryMs = 1000
    this.retryTimer = null
    this.pingTimer = null
    this.lastPong = 0
    this.attached = new Map()
    this.prompts = new Map()
    this.promptSeq = 0
  }

  setConfig(config) {
    this.config = config
  }

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.retryTimer = null
    this.pingTimer = null
    this.abortAll()
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
  }

  reconnect(config) {
    this.config = config
    const old = this.ws
    this.ws = null
    if (old) {
      old.onclose = null
      old.onmessage = null
      try { old.close() } catch {}
    }
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryMs = 1000
    if (!this.stopped) this.connect()
  }

  url() {
    if (this.config.enabled === false) return null
    const host = normalizeHost(this.config.relayHost)
    if (!host) return null
    const port = Number(this.config.relayPort) || DEFAULT_PORT
    const name = encodeURIComponent(this.config.instanceName || os.hostname())
    const token = encodeURIComponent(this.config.pluginToken || '')
    return `ws://${host}:${port}/ws/plugin?name=${name}&token=${token}`
  }

  connect() {
    const url = this.url()
    if (!url) {
      this.ctx.logger.warn('dsh-web-control: relayHost 未配置，跳过连接')
      return
    }
    if (this.stopped) return
    this.ctx.logger.info(`dsh-web-control: 连接中继 ${url.replace(/([?&]token=)[^&]*/, '$1***')}`)
    let ws
    try {
      ws = new WebSocket(url)
    } catch (error) {
      this.ctx.logger.warn(`dsh-web-control: 无法创建 WebSocket: ${String(error)}`)
      this.scheduleRetry()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.retryMs = 1000
      this.lastPong = Date.now()
      this.ctx.logger.info('dsh-web-control: 已连接中继')
      this.send({
        type: 'hello',
        name: this.config.instanceName || os.hostname(),
        host: os.hostname(),
        version: PLUGIN_VERSION,
      })
      this.startHeartbeat()
    }
    ws.onmessage = event => {
      let message
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      this.onMessage(message)
    }
    ws.onerror = () => {
      // onclose owns reconnect; keep this quiet to avoid log spam.
    }
    ws.onclose = () => {
      this.stopHeartbeat()
      if (this.ws === ws) this.ws = null
      this.abortAll()
      if (!this.stopped) {
        this.ctx.logger.warn('dsh-web-control: 中继连接断开，准备重连')
        this.scheduleRetry()
      }
    }
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return
    const delay = this.retryMs
    this.retryMs = Math.min(this.retryMs * 2, 30_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > 75_000) {
        try { this.ws?.close() } catch {}
        return
      }
      this.send({ type: 'ping', ts: Date.now() })
    }, 20_000)
  }

  stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== 1) return false
    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  sendEvent(clientId, event) {
    this.send({ type: 'evt', clientId, event })
  }

  onMessage(message) {
    switch (message.type) {
      case 'pong':
        this.lastPong = Date.now()
        return
      case 'welcome':
        this.state.instanceId = message.id
        this.ctx.logger.info(`dsh-web-control: 中继已登记实例 ${message.id}`)
        return
      case 'req':
        void this.handleRequest(message)
        return
      case 'client.gone':
        this.abortClient(message.clientId)
        return
      default:
        return
    }
  }

  async handleRequest(request) {
    const clientId = request.clientId
    const id = request.id
    try {
      const result = await this.dispatch(request.method, request.params ?? {}, clientId)
      this.send({ type: 'res', clientId, id, ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`dsh-web-control: ${request.method} 失败: ${message}`)
      this.send({
        type: 'res',
        clientId,
        id,
        ok: false,
        error: { code: error?.code || 'internal', message },
      })
    }
  }

  async dispatch(method, params, clientId) {
    const ctx = this.ctx
    switch (method) {
      case 'status':
        return {
          connected: this.ws?.readyState === 1,
          instanceId: this.state.instanceId,
          relayHost: this.config.relayHost,
          relayPort: this.config.relayPort,
          version: PLUGIN_VERSION,
        }
      case 'sessions.list':
        return this.listSessions()
      case 'models.catalog': {
        const catalog = await ctx.sessionController.modelCatalog()
        return { groups: catalog.groups, default: catalog.default }
      }
      case 'session.create':
        return this.createSession(params)
      case 'session.attach':
        return this.attachSession(clientId, params)
      case 'session.history':
        return this.loadHistory(params)
      case 'session.detach':
        this.detach(clientId, params.sessionId)
        return { detached: true }
      case 'session.prompt':
        return this.prompt(params)
      case 'session.stop':
        await ctx.sessionController.cancel({ sessionId: params.sessionId })
        return { accepted: true }
      case 'session.setReasoning':
        return this.setReasoning(params)
      case 'session.setModel':
        return this.setModel(params)
      case 'session.exists':
        return this.sessionExists(params)
      case 'approval.answer':
        return this.answerApproval(params)
      case 'question.answer':
        return this.answerQuestion(params)
      case 'session.setPermission':
        return this.setPermission(params)
      case 'permissions.catalog':
        return this.permissionCatalog()
      case 'session.rename':
        return ctx.sessionController.rename({
          sessionId: params.sessionId,
          title: params.title,
        })
      case 'workspaces.list': {
        const registry = ctx.get('workspaceRegistry')
        if (!registry) return { items: [] }
        let visible = null
        try {
          const value = await ctx.sessionController.list({}, AbortSignal.timeout(10_000))
          const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
          visible = new Set(
            (value.items ?? [])
              .filter(item => item.origin !== 'subagent' && item.blank !== true && !archived.has(item.sessionId))
              .map(item => item.sessionId),
          )
        } catch {
          visible = null
        }
        return {
          items: registry.list().map(workspace => ({
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
            sessionCount:
              visible === null
                ? workspace.sessionIds.length
                : workspace.sessionIds.filter(id => visible.has(id)).length,
          })),
        }
      }
      default:
        throw Object.assign(new Error(`未知方法: ${method}`), { code: 'unknown-method' })
    }
  }

  async listSessions() {
    const controller = this.ctx.sessionController
    const value = await controller.list({}, AbortSignal.timeout(15_000))
    const archived = new Set(this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    const items = (value.items ?? [])
      .filter(item => item.origin !== 'subagent' && item.blank !== true && !archived.has(item.sessionId))
      .slice(0, 60)
      .map(item => ({
        id: item.sessionId,
        title: item.projections?.values?.title ?? null,
        updatedAt: item.updatedAt,
        running: item.running === true,
        blank: item.blank === true,
        cwd: item.cwd,
        available: item.agentAvailable !== false,
      }))

    const byId = new Map(items.map(item => [item.id, item]))
    const registry = this.ctx.get('workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    const groups = workspaces.map(workspace => {
      const sessionIds = (workspace.sessionIds ?? [])
        .filter(id => byId.has(id))
        .sort((a, b) => (byId.get(b)?.updatedAt ?? 0) - (byId.get(a)?.updatedAt ?? 0))
      return {
        id: workspace.id,
        title: workspace.title || workspace.path,
        path: workspace.path,
        sessionIds,
      }
    })
    const claimed = new Set(groups.flatMap(group => group.sessionIds))
    const ungrouped = items
      .filter(item => !claimed.has(item.id))
      .map(item => item.id)
    return { items, groups, ungrouped }
  }

  async pickCwd() {
    const configured = String(this.config.defaultCwd || '').trim()
    if (configured) return configured
    const registry = this.ctx.get('workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    const workspacePath = workspaces.find(workspace => workspace.path)?.path
    if (workspacePath) return workspacePath
    try {
      const value = await this.ctx.sessionController.list({}, AbortSignal.timeout(5000))
      const recent = (value.items ?? []).find(item => item.cwd && item.origin !== 'subagent')
      return recent?.cwd
    } catch {
      return undefined
    }
  }

  async createSession(params = {}) {
    const ctx = this.ctx
    const requestedWorkspace =
      typeof params?.workspaceId === 'string' && params.workspaceId.trim()
        ? params.workspaceId.trim()
        : undefined
    const cwd = requestedWorkspace ? undefined : await this.pickCwd()
    const created = await ctx.sessionController.create(
      requestedWorkspace ? { workspaceId: requestedWorkspace } : cwd ? { cwd } : {},
    )
    const sessionId = created.sessionId
    const requestedPermission =
      typeof params?.permission === 'string' && params.permission.trim()
        ? params.permission.trim()
        : null
    let permission = null
    let permissionError = null
    try {
      // createSession publishes the agent; make sure the store exposes it.
      await ctx.sessionController.resolveAgent?.(sessionId)
      const sessions = ctx.get('sessions')
      const session = sessions?.get(sessionId)
      const presets = ctx.get('permissionPresets')
      if (session && presets) {
        const fallback = presets.catalog?.().defaultPreset
        const target = requestedPermission || fallback || FULL_ACCESS_PRESET
        presets.set(session, target)
        permission = target
      } else if (!presets) {
        permissionError = 'permissionPresets 服务不可用'
      } else if (!session) {
        permissionError = '会话未进入 SessionStore'
      }
    } catch (error) {
      permissionError = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`dsh-web-control: 设置会话权限失败: ${permissionError}`)
    }

    let provider = null
    let model = null
    let effort = null
    let modelError = null
    const requestedProvider =
      typeof params?.provider === 'string' && params.provider.trim()
        ? params.provider.trim()
        : null
    const requestedModel =
      typeof params?.model === 'string' && params.model.trim()
        ? params.model.trim()
        : null
    const requestedEffort =
      typeof params?.reasoningEffort === 'string' && params.reasoningEffort.trim()
        ? params.reasoningEffort.trim()
        : null
    try {
      const catalog = await ctx.sessionController.modelCatalog()
      let chosen = null
      if (requestedProvider && requestedModel) {
        const group = (catalog.groups ?? []).find(item => item.id === requestedProvider)
        const entry = (group?.models ?? []).find(item => item.id === requestedModel)
        if (!entry) {
          modelError = `模型不可用: ${requestedProvider}/${requestedModel}`
        } else {
          const efforts = entry.reasoning?.efforts ?? []
          let effortId = requestedEffort
          if (effortId && efforts.length > 0 && !efforts.some(item => item.id === effortId)) {
            effortId = null
          }
          if (!effortId && efforts.length > 0) {
            effortId = entry.reasoning?.defaultEffort || efforts[0].id
          }
          chosen = { provider: requestedProvider, model: requestedModel, effort: effortId }
        }
      } else {
        chosen = pickModel(catalog)
      }
      if (chosen) {
        provider = chosen.provider
        model = chosen.model
        effort = chosen.effort ?? null
        try {
          await ctx.sessionController.selectModel({
            sessionId,
            provider,
            model,
            ...(effort ? { reasoningEffort: effort } : {}),
          })
        } catch (firstError) {
          // The model may not expose a named effort; keep the model selection
          // and let the adapter use its default effort.
          if (effort) {
            await ctx.sessionController.selectModel({ sessionId, provider, model })
            ctx.logger.warn(
              `dsh-web-control: 思考级别 ${effort} 不可用，使用适配器默认值: ${String(firstError)}`,
            )
            effort = null
          } else {
            throw firstError
          }
        }
      }
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`dsh-web-control: 选择模型失败: ${modelError}`)
    }

    ctx.logger.info(
      `dsh-web-control: 新建会话 ${sessionId} 权限=${permission} 模型=${model} effort=${effort}`,
    )
    return {
      sessionId,
      title: null,
      cwd: cwd ?? null,
      workspaceId: requestedWorkspace ?? null,
      permission,
      permissionError,
      provider,
      model,
      reasoningEffort: effort,
      modelError,
    }
  }

  async prompt(params) {
    const text = String(params.text ?? '').trim()
    if (!text) throw Object.assign(new Error('消息为空'), { code: 'empty-prompt' })
    const requestId = params.requestId || randomUUID()
    await this.ctx.sessionController.prompt(
      {
        requestId,
        sessionId: params.sessionId,
        mode: params.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text }],
      },
      AbortSignal.timeout(30_000),
    )
    return { accepted: true, requestId }
  }

  async setReasoning(params) {
    return this.ctx.sessionController.selectModel({
      sessionId: params.sessionId,
      provider: params.provider,
      model: params.model,
      ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
    })
  }

  async sessionExists(params) {
    const sessionId = String(params?.sessionId || '')
    if (!sessionId) throw new Error('缺少 sessionId')
    const value = await this.ctx.sessionController.list({}, AbortSignal.timeout(10_000))
    const archived = new Set(this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    return {
      exists: (value.items ?? []).some(item =>
        item.sessionId === sessionId && item.origin !== 'subagent' && !archived.has(sessionId)),
    }
  }

  async setModel(params) {    const sessionId = String(params?.sessionId || '')
    const provider = String(params?.provider || '').trim()
    const model = String(params?.model || '').trim()
    if (!sessionId) throw new Error('缺少 sessionId')
    if (!provider || !model) throw new Error('缺少模型')
    const effort = typeof params?.reasoningEffort === 'string' && params.reasoningEffort.trim()
      ? params.reasoningEffort.trim()
      : null
    return this.ctx.sessionController.selectModel({
      sessionId,
      provider,
      model,
      ...(effort ? { reasoningEffort: effort } : {}),
    })
  }

  sessionClients(sessionId) {
    const clients = []
    for (const key of this.attached.keys()) {
      const index = key.indexOf(':')
      if (index < 0) continue
      if (key.slice(index + 1) === sessionId) clients.push(key.slice(0, index))
    }
    return clients
  }

  promptPayload(prompt) {
    if (prompt.kind === 'approval') {
      return {
        id: prompt.id,
        kind: 'approval',
        sessionId: prompt.sessionId,
        createdAt: prompt.createdAt,
        toolName: prompt.toolName,
        callId: prompt.callId,
        reason: prompt.reason,
        displayReason: prompt.displayReason,
      }
    }
    return {
      id: prompt.id,
      kind: 'question',
      sessionId: prompt.sessionId,
      createdAt: prompt.createdAt,
      questions: prompt.questions,
      wait: prompt.wait,
    }
  }

  sendPrompt(prompt) {
    const payload = this.promptPayload(prompt)
    for (const clientId of this.sessionClients(prompt.sessionId)) {
      this.sendEvent(clientId, { kind: 'prompt', sessionId: prompt.sessionId, prompt: payload })
    }
  }

  sendPromptCancel(sessionId, promptId) {
    for (const clientId of this.sessionClients(sessionId)) {
      this.sendEvent(clientId, { kind: 'prompt.cancel', sessionId, promptId })
    }
  }

  finishPrompt(prompt) {
    this.prompts.delete(prompt.id)
    this.sendPromptCancel(prompt.sessionId, prompt.id)
  }

  answerApproval(params) {
    const promptId = String(params?.promptId || '')
    const sessionId = String(params?.sessionId || '')
    const prompt = this.prompts.get(promptId)
    if (!prompt || prompt.kind !== 'approval' || prompt.sessionId !== sessionId) {
      throw new Error('确认请求已结束')
    }
    const outcome = params?.outcome === 'allowed-once'
      ? 'allowed-once'
      : params?.outcome === 'rejected'
        ? 'rejected'
        : 'cancelled'
    prompt.resolve?.(outcome)
    return { accepted: true, outcome }
  }

  answerQuestion(params) {
    const promptId = String(params?.promptId || '')
    const sessionId = String(params?.sessionId || '')
    const prompt = this.prompts.get(promptId)
    if (!prompt || prompt.kind !== 'question' || prompt.sessionId !== sessionId) {
      throw new Error('问题已结束')
    }
    const answers = Array.isArray(params?.answers)
      ? params.answers
          .filter(item => item && typeof item.id === 'string')
          .map(item => ({
            id: item.id,
            selected: Array.isArray(item.selected)
              ? item.selected.filter(value => typeof value === 'string')
              : [],
            ...(typeof item.custom === 'string' ? { custom: item.custom } : {}),
          }))
      : []
    prompt.resolve?.({ answers })
    return { accepted: true }
  }

  async handleApproval(req, next) {
    const sessionId = req?.agent?.id
    if (!sessionId || this.sessionClients(sessionId).length === 0) return next()
    const id = `prompt_${++this.promptSeq}`
    let answer
    const browserAnswer = new Promise(resolve => { answer = resolve })
    const prompt = {
      id,
      kind: 'approval',
      sessionId,
      createdAt: Date.now(),
      toolName: req.toolName,
      callId: req.callId,
      reason: req.reason,
      displayReason: req.displayReason,
      resolve: answer,
    }
    this.prompts.set(id, prompt)
    this.sendPrompt(prompt)
    const result = await new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        this.finishPrompt(prompt)
        resolve(value)
      }
      void browserAnswer.then(finish)
      if (req.signal) {
        req.signal.addEventListener('abort', () => finish('cancelled'), { once: true })
      }
    })
    return result
  }

  async handleQuestion(request, next) {
    const sessionId = request?.agent?.id
    if (!sessionId || request.wait?.timed || this.sessionClients(sessionId).length === 0) {
      return next()
    }
    const id = `prompt_${++this.promptSeq}`
    let answer
    const browserAnswer = new Promise(resolve => { answer = resolve })
    const prompt = {
      id,
      kind: 'question',
      sessionId,
      createdAt: Date.now(),
      questions: request.questions,
      wait: request.wait,
      resolve: answer,
    }
    this.prompts.set(id, prompt)
    this.sendPrompt(prompt)
    const result = await new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        this.finishPrompt(prompt)
        resolve(value)
      }
      void browserAnswer.then(finish)
      if (request.signal) {
        request.signal.addEventListener('abort', () => finish({
          answers: (request.questions ?? []).map(question => ({
            id: question.id,
            selected: [],
          })),
        }), { once: true })
      }
    })
    return result
  }

  attachSession(clientId, params) {
    const sessionId = params.sessionId
    if (!sessionId) throw new Error('缺少 sessionId')
    this.detach(clientId, sessionId)
    const abort = new AbortController()
    this.attached.set(`${clientId}:${sessionId}`, abort)
    for (const prompt of this.prompts.values()) {
      if (prompt.sessionId === sessionId) {
        this.sendEvent(clientId, {
          kind: 'prompt',
          sessionId,
          prompt: this.promptPayload(prompt),
        })
      }
    }
    void this.runFollow(clientId, sessionId, abort.signal)
    return { attached: true }
  }

  detach(clientId, sessionId) {
    const key = `${clientId}:${sessionId}`
    const abort = this.attached.get(key)
    if (abort) {
      try { abort.abort() } catch {}
      this.attached.delete(key)
    }
  }

  abortClient(clientId) {
    for (const [key, abort] of this.attached) {
      if (key.startsWith(`${clientId}:`)) {
        try { abort.abort() } catch {}
        this.attached.delete(key)
      }
    }
  }

  abortAll() {
    for (const abort of this.attached.values()) {
      try { abort.abort() } catch {}
    }
    this.attached.clear()
  }

  sessionInfo(sessionId) {
    const session = this.ctx.get('sessions')?.get(sessionId)
    if (!session) return { sessionId }
    const header = session.requestHeader()
    let permission = null
    try {
      permission = this.ctx.get('permissionPresets')?.current?.(session) ?? null
    } catch {
      permission = null
    }
    return {
      sessionId,
      cwd: session.header?.cwd,
      provider: header?.config?.provider,
      model: header?.config?.model,
      reasoningEffort: header?.config?.reasoningEffort,
      permission,
    }
  }

  permissionCatalog() {
    const presets = this.ctx.get('permissionPresets')
    if (!presets) throw new Error('permissionPresets 服务不可用')
    const catalog = presets.catalog()
    return {
      options: catalog.options ?? [],
      defaultPreset: catalog.defaultPreset ?? null,
      defaultOptions: catalog.defaultOptions ?? [],
    }
  }

  setPermission(params) {
    const sessionId = String(params?.sessionId || '')
    const name = String(params?.permission || '').trim()
    if (!sessionId) throw new Error('缺少 sessionId')
    if (!name) throw new Error('缺少 permission')
    const presets = this.ctx.get('permissionPresets')
    if (!presets) throw new Error('permissionPresets 服务不可用')
    const session = this.ctx.get('sessions')?.get(sessionId)
    if (!session) throw new Error('会话未进入 SessionStore')
    presets.set(session, name)
    return { permission: presets.current(session) }
  }

  workspaceSummary(event, sessionId) {
    if (event?.type !== 'workspace/changes') return undefined
    const service = this.ctx.get('workspaceChanges')
    if (!service || typeof service.summary !== 'function') return undefined
    try {
      return service.summary(sessionId, event.seq)
    } catch {
      return undefined
    }
  }

  async loadHistory(params) {
    const sessionId = String(params?.sessionId || '')
    if (!sessionId) throw new Error('缺少 sessionId')
    const beforeSeq = Number(params?.beforeSeq)
    const request = {
      address: { kind: 'session', sessionId },
      maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
    }
    if (Number.isFinite(beforeSeq) && beforeSeq > 0) request.beforeSeq = beforeSeq
    const page = await this.ctx.sessionController.events(request, AbortSignal.timeout(20_000))
    const entries = []
    for (const record of page.records ?? []) {
      if (record?.type !== 'event') continue
      const entry = mapEvent(record.event, this.workspaceSummary(record.event, sessionId))
      if (entry) entries.push(entry)
    }
    return {
      entries,
      hasMore: page.hasMore === true,
      oldestSeq: entries[0]?.seq ?? null,
    }
  }

  async runFollow(clientId, sessionId, signal) {
    const controller = this.ctx.sessionController
    try {
      const stateValue = await controller
        .state({ sessionId }, AbortSignal.timeout(5000))
        .catch(() => null)
      this.sendEvent(clientId, {
        kind: 'session.info',
        ...this.sessionInfo(sessionId),
        running: stateValue?.running === true,
        pendingInput: stateValue?.pendingInput ?? [],
      })

      const stream = controller.follow(
        {
          address: { kind: 'session', sessionId },
          assistantStream: true,
          maxMessages: 500,
          turnWindow: { minMessages: 50, minTurns: 20 },
        },
        signal,
      )
      for await (const frame of stream) {
        if (signal.aborted) break
        if (frame.type === 'snapshot') {
          const entries = []
          for (const record of frame.records ?? []) {
            if (record?.type === 'event') {
              const entry = mapEvent(record.event, this.workspaceSummary(record.event, sessionId))
              if (entry) entries.push(entry)
            }
          }
          this.sendEvent(clientId, {
            kind: 'snapshot',
            sessionId,
            cursor: frame.cursor,
            entries,
            running: stateValue?.running === true,
            hasMore: frame.hasMore === true,
            oldestSeq: entries[0]?.seq ?? null,
          })
        } else if (frame.type === 'event') {
          const entry = mapEvent(frame.event, this.workspaceSummary(frame.event, sessionId))
          if (entry) this.sendEvent(clientId, { kind: 'entry', sessionId, entry })
          if (frame.event?.type === 'turn/start') {
            this.sendEvent(clientId, { kind: 'state', sessionId, running: true })
          } else if (frame.event?.type === 'turn/end') {
            this.sendEvent(clientId, { kind: 'state', sessionId, running: false })
          }
        } else if (frame.type === 'assistant-stream') {
          const inner = frame.frame
          if (inner?.type === 'chunk') {
            const chunk = inner.chunk
            if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') {
              this.sendEvent(clientId, {
                kind: 'delta',
                sessionId,
                attemptId: inner.attemptId,
                index: inner.index,
                text: chunk.text ?? '',
                reasoning: chunk.type === 'reasoning-delta',
              })
            }
          } else if (inner?.type === 'end') {
            this.sendEvent(clientId, {
              kind: 'delta.end',
              sessionId,
              attemptId: inner.attemptId,
            })
          }
        }
      }
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`dsh-web-control: follow 失败: ${message}`)
      this.sendEvent(clientId, { kind: 'error', sessionId, message })
    }
  }
}

/* --------------------------------------------------------------- plugin API */

export function apply(ctx) {
  const { config, migrated } = loadFileConfig()
  const state = { instanceId: null }
  const client = new RelayClient(ctx, config, state)
  const log = ctx.logger

  log.info(`dsh-web-control: 插件已加载，中继 ${config.relayHost || '(未配置)'}:${config.relayPort}`)
  if (migrated) {
    log.info(`dsh-web-control: 已把旧配置 xdcontrol.json 迁移到 ${configPath()}`)
  }

  const scopedListeners = new Map()
  const registerAgent = agent => {
    if (!agent?.ctx || scopedListeners.has(agent.id)) return
    scopedListeners.set(agent.id, [
      agent.ctx.on('approval/request', (req, next) => client.handleApproval(req, next), { prepend: true }),
      agent.ctx.on('user-questions/request', (request, next) => client.handleQuestion(request, next), { prepend: true }),
    ])
  }
  ctx.on('agent/created', payload => registerAgent(payload?.agent))
  ctx.on('agent/disposed', payload => {
    const disposers = scopedListeners.get(payload?.agent?.id)
    if (!disposers) return
    scopedListeners.delete(payload.agent.id)
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })
  for (const agent of ctx.get('agents')?.list?.() ?? []) registerAgent(agent)
  ctx.effect(() => () => {
    for (const disposers of scopedListeners.values()) {
      for (const dispose of disposers) {
        try { dispose() } catch {}
      }
    }
    scopedListeners.clear()
  })
  function publicConfig() {
    return {
      enabled: config.enabled !== false,
      relayHost: config.relayHost,
      relayPort: config.relayPort,
      instanceName: config.instanceName,
      defaultCwd: config.defaultCwd,
      pluginToken: config.pluginToken,
      connected: client.ws?.readyState === 1,
      instanceId: state.instanceId,
      version: PLUGIN_VERSION,
    }
  }

  function normalizeSettings(input) {
    const value = input && typeof input === 'object' ? input : {}
    const port = Math.trunc(Number(value.relayPort) || DEFAULT_PORT)
    return {
      enabled: value.enabled !== false,
      relayHost: normalizeHost(value.relayHost),
      relayPort: Math.min(65535, Math.max(1, port)),
      instanceName: String(value.instanceName || '').trim(),
      defaultCwd: String(value.defaultCwd || '').trim(),
      pluginToken: String(value.pluginToken || '').trim(),
    }
  }

  ctx.effect(() => {
    client.start()
    return () => client.stop()
  })

  // The DSH client settings page posts the standard Connection RPC envelope
  // here. This route is served by the same HTTP carrier as the GUI and admits
  // the browser cookie through ctx.connection.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/webctl',
      handler: async (req, res) => {
        let rpcId = null
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end('method not allowed')
            return
          }
          const admission = ctx.connection.admit({ headers: req.headers })
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (admission.peer.principal.kind !== 'owner') {
            res.writeHead(403)
            res.end('forbidden')
            return
          }

          const body = await readJsonBody(req)
          rpcId = body?.rpcId ?? null
          const pathname = new URL(req.url || '/', 'http://localhost').pathname
          const endpoint = pathname.startsWith('/webctl/')
            ? pathname.slice('/webctl/'.length)
            : ''
          let result
          if (endpoint === 'config.get') {
            result = { ok: true, value: publicConfig() }
          } else if (endpoint === 'config.set') {
            const next = normalizeSettings(body?.payload)
            Object.assign(config, next)
            await saveConfig(config)
            client.reconnect({ ...config })
            result = { ok: true, value: publicConfig() }
          } else {
            result = {
              ok: false,
              error: { code: 'not-found', message: `未知端点: ${endpoint}`, details: {} },
            }
          }
          sendRpc(res, rpcId, result)
        } catch (error) {
          sendRpc(res, rpcId, {
            ok: false,
            error: {
              code: 'internal',
              message: error instanceof Error ? error.message : String(error),
              details: {},
            },
          })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.commands.register({
      name: 'webctl',
      description: '配置并连接 DSH Web Control 中继服务器',
      input: { hint: '<host>[:<port>] | off | status' },
      handler: async invocation => {
        const raw = String(invocation.rawInput ?? '').trim()
        if (!raw || raw === 'status') {
          const connected = client.ws?.readyState === 1
          return {
            kind: 'success',
            text: [
              `DSH Web Control ${PLUGIN_VERSION}`,
              `中继: ${config.relayHost || '(未配置)'}:${config.relayPort}`,
              `状态: ${config.enabled === false ? '已关闭' : connected ? '已连接' : '未连接'}`,
              `实例: ${state.instanceId ?? '-'}`,
              `目录: ${config.defaultCwd || '(跟随最近会话)'}`,
              `插件令牌: ${config.pluginToken ? '已设置' : '未设置'}`,
              '',
              '优先在「插件 → DSH Web Control 远程控制」页面里修改。',
              '用法: /webctl <host>[:<port>]   设置并重连',
              '      /webctl cwd <绝对路径>   设置新会话目录',
              '      /webctl token <令牌>     设置中继插件令牌',
              '      /webctl off              断开',
            ].join('\n'),
          }
        }
        if (raw.startsWith('cwd ')) {
          const value = raw.slice(4).trim()
          if (!value) return { kind: 'error', text: '用法: /webctl cwd <绝对路径>' }
          Object.assign(config, { enabled: true, defaultCwd: value })
          try {
            await saveConfig(config)
          } catch (error) {
            return { kind: 'error', text: `保存配置失败: ${String(error)}` }
          }
          client.setConfig(config)
          return { kind: 'success', text: `新会话目录已设置为 ${value}` }
        }
        if (raw.startsWith('token ')) {
          const value = raw.slice(6).trim()
          Object.assign(config, { enabled: true, pluginToken: value })
          try {
            await saveConfig(config)
          } catch (error) {
            return { kind: 'error', text: `保存配置失败: ${String(error)}` }
          }
          client.reconnect({ ...config })
          return {
            kind: 'success',
            text: value ? '插件令牌已保存，正在重连…' : '插件令牌已清除，正在重连…',
          }
        }
        if (raw === 'off') {
          Object.assign(config, { enabled: false })
          try {
            await saveConfig(config)
          } catch (error) {
            return { kind: 'error', text: `保存配置失败: ${String(error)}` }
          }
          client.reconnect({ ...config })
          return { kind: 'success', text: '已断开 DSH Web Control 中继' }
        }
        const parts = raw.split(/\s+/)
        let host = normalizeHost(parts[0])
        let port = Number(parts[1] ?? 0)
        const colon = host.lastIndexOf(':')
        if (port === 0 && colon > 0) {
          const parsed = Number(host.slice(colon + 1))
          if (Number.isFinite(parsed) && parsed > 0) {
            port = parsed
            host = host.slice(0, colon)
          }
        }
        if (!host || !Number.isFinite(port) || port <= 0) port = DEFAULT_PORT
        const next = { ...config, enabled: true, relayHost: host, relayPort: port }
        try {
          await saveConfig(next)
        } catch (error) {
          return { kind: 'error', text: `保存配置失败: ${String(error)}` }
        }
        Object.assign(config, next)
        client.reconnect(next)
        return {
          kind: 'success',
          text: `DSH Web Control 已切换到 ${host}:${port}，正在连接…`,
        }
      },
    }),
  )
}
