# DSH Web Control：DSH 远程控制方案

> 工作区：`D:\Products\dsh-web-control`
> 目标运行时：DeepSeek Harness Desktop `0.2.2-rc.3`（当前安装）
> 状态：v0.1 已实现（按用户要求简化），实际行为见 [README](../README.md)
> 结论：采用「DSH Host 插件 + 云服务器中继 + 浏览器 PWA」三段式；电脑只发起出站连接，不开放任何入站端口。

> **v0.1 实现说明（2026-11-15）**：按用户要求先做了简化版，实际行为以 [README](../README.md) 为准：
> 中继 HTTP + 用户名密码，无加密、无审批卡片、无推送、无文件上传；
> 远程新建会话可选择权限（只读 / 工作区可写 / 完全权限）、模型（DeepSeek-V4.1-Flash / DeepSeek-V4-Pro）和思考级别；
> PC 端在「插件 → DSH Web Control 远程控制」页面配置中继，`/webctl` 是快捷命令。
> 本文其余部分保留为后续版本的设计参考。

---

## 0. 一句话方案

在 DSH 里安装一个 Host 插件，由它主动连接你云服务器上的中继服务；浏览器通过 HTTPS/WSS 访问中继上的一个轻量控制台（PWA），中继把浏览器的操作转发给插件，插件直接调用 DSH 的 Host 服务完成「看会话、发指令、停止、审批、回答提问、收通知」。

这样：

- 电脑不需要公网 IP、不需要端口映射、不需要 VPN；
- 云服务器只做转发与配对，默认不保存对话内容；
- 浏览器端不持有 DSH 的启动 token，而是自己的设备令牌，可单独撤销；
- 后续可加端到端加密，让云主机即使被入侵也无法伪造指令。

---

## 1. 目标与非目标

### 1.1 目标（v1 验收）

1. 浏览器在外部网络下能打开控制台，看到 DSH 实例在线/离线。
2. 看到会话列表：哪些在运行、哪些在等待我审批/回答、最近活动时间。
3. 打开任一对话，实时看到助手输出、工具调用摘要、错误信息。
4. 能发送新指令（排队或插话）、能停止当前回合。
5. 能在浏览器里处理工具审批和 `ask_user_question` 提问。
6. 审批、提问、回合结束/失败时收到通知，点通知直达对应会话。
7. 配对、撤销设备、暂停远程控制都在 DSH 设置页完成。
8. 断网、电脑睡眠唤醒、DSH 重启、云中继重启后能自动恢复。

### 1.2 非目标（v1 不做）

- 多人共享/协作（DSH 已有 experimental-liveshare，不重复造）。
- 完整的 Web GUI 镜像（作为二期可选模式）。
- 终端、文件管理器、插件管理等重界面。
- 云端持久化对话正文或工具输出。
- 多租户 SaaS；一台中继只服务你自己的实例（可扩展多实例，但不做账号体系）。

---

## 2. 现状与关键事实

以下均基于当前安装的 DSH `0.2.2-rc.3` 实测/源码阅读，不是通用假设。

| 事实 | 对本方案的影响 |
|---|---|
| Desktop 的 Web GUI 只监听 loopback，端口每次启动可能不同（当前 `127.0.0.1:65053`），`dsh web --host 0.0.0.0` 不受支持 | 不能把 GUI 端口直接映射出去；必须由插件从进程内发起连接 |
| GUI 用一次性启动 token 换 30 天 HttpOnly Cookie，Cookie 绑定 hostname+port；Host/Origin 有信任栅栏 | 浏览器直接访问会 403；也不适合把 30 天 owner Cookie 复制到另一台设备 |
| 官方支持「反向代理 + `--public-url` + `--trusted-host` + TLS」发布 Web UI | 这是 `web` profile 的路径，Desktop 实例不能直接用；且缺少浏览器体验与设备级管理 |
| Host 有 `ctx.sessionController`：`list` / `create` / `prompt` / `cancel` / `state` / `follow` / `events` / `selectModel` / `rename` / `projections` | 插件可以在进程内完成浏览器端 90% 的会话操作，不必逆向 GUI |
| `sessionController.state` 返回 `pendingInput: 'approval' \| 'question' \| 'other'` | 会话列表可以直接做「需要我处理」徽标 |
| `sessionController.follow` 返回 snapshot + 增量事件 + 可选的 assistant 流式片段 | 浏览器时间线可以做到接近 GUI 的实时体验 |
| 全局事件 `session/event` 在每次提交后触发，携带完整 `SessionEvent` | 用于全局通知（回合结束、错误），避免为每个会话开流 |
| 审批由 `approval/request` waterfall 应答；返回 `allowed-once` 才是放行，无应答时失败关闭 | 插件可以作为「远程应答者」参与竞争，但不能绕过策略 |
| 提问由 `user-questions/request` waterfall 应答；已继续的问题可用 `ctx.userQuestions.answer` 补答 | 浏览器端可以覆盖阻塞式提问与延迟回答 |
| 插件可持久化密钥/状态：`ctx.credentials`、storage 服务 | 中继凭据不进 patch/config，不落到日志 |
| Client 侧存在 `settings.section`、`sidebar.footer.action` 等 Slot | 设置页里做「远程控制」卡片、侧栏做在线状态 |
| DSH 自带 experimental-liveshare：出站网关 + 独立中继 + 查看页 | 证明「插件出站连中继」的模式可行，可直接借鉴其网关/重连/降级思路 |
| 没有内置的远程控制界面、推送或远程访问 | 这是新增能力，不是开关某个内置功能 |

结论：**不需要也不应该把 DSH 的 Web GUI 暴露到公网**。插件走 Host 内部 API 是最短、最稳、权限最清晰的路径。

---

## 3. 总体架构

```
┌──────────────┐        HTTPS + WSS         ┌──────────────────────────┐
│  浏览器 PWA  │  ───────────────────────►  │  云服务器                 │
│  控制台/通知 │  ◄───────────────────────  │  Caddy (TLS) + Relay     │
└──────────────┘                            │  - 配对/设备令牌          │
                                            │  - 实例注册/在线状态       │
                                            │  - RPC 转发/事件队列       │
                                            │  - 推送适配器             │
                                            └────────────▲─────────────┘
                                                         │ 出站 WSS（插件主动连）
                                                         │ 无入站端口
┌────────────────────────────────────────────────────────┴─────────────┐
│ Windows PC：DSH Desktop（Electron）                                   │
│                                                                      │
│  ┌──────────────────────────────┐   调用 Host 服务                    │
│  │ 插件 dsh-web-control (Host)         │ ───────────────► ctx.sessionController│
│  │  - 中继连接/重连/心跳          │                  ctx.agents           │
│  │  - RPC 分发                   │                  approval/request   │
│  │  - 事件桥/截断/脱敏            │                  user-questions/... │
│  │  - 审批与提问应答者            │                  session/event       │
│  │  - 配对/设备/审计              │                  ctx.credentials     │
│  └──────────────────────────────┘                                      │
│                                                                      │
│  ┌──────────────────────────────┐                                      │
│  │ 插件 dsh-web-control (Client)       │  设置页：连接状态、二维码、设备列表    │
│  └──────────────────────────────┘                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 组件职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| Host 插件 | 维持到中继的 WSS；把浏览器 RPC 映射为 Host 服务调用；把 DSH 事件压缩成浏览器端事件；参与审批/提问 waterfall；本地审计与设备管理 | 不存对话、不做 UI |
| Client 插件 | 设置页卡片：中继地址、连接状态、配对二维码、设备撤销、远程开关 | 不直接连中继 |
| Relay（云） | TLS 终止、实例注册、配对、设备令牌、RPC 转发、短时事件缓冲、推送、审计 | 不解析/不持久化对话正文（默认） |
| 浏览器 PWA | 会话列表、时间线、输入框、停止、审批/提问卡片、通知、设置 | 不直连 PC |

### 3.2 三条关键链路

**配对**

1. 插件用「实例注册令牌」向中继登记，拿到 `instanceId + instanceSecret`（密钥存 `ctx.credentials`）。
2. 插件请求配对码，中继返回 8 位一次性码（5 分钟有效）。
3. DSH 设置页显示二维码：`https://<你的域名>/pair#<code>`。
4. 浏览器打开配对链接 → 中继校验 → 下发设备 Cookie（HttpOnly/Secure）→ 插件收到 `device.paired` 通知。
5. 设置页出现设备条目，可随时撤销。

**发指令**

1. 浏览器 `POST /v1/rpc` `{ method: 'session.prompt', params: { sessionId, requestId, text, mode } }`。
2. 中继查设备 → 查实例在线 → 通过实例 WSS 下发 `req` 帧。
3. 插件调用 `ctx.sessionController.prompt({ requestId, sessionId, mode, content: [{ type: 'text', text }] })`。
4. 返回 `{ accepted: true }`；随后 `session/event` / `follow` 把助手输出推回浏览器。

**审批**

1. DSH 工具调用触发 `approval/request`。
2. 插件注册的应答者被调用，同时做两件事：
   - 立即调用 `next()`（让桌面端 GUI 的应答者继续，用户坐在电脑前也能点）；
   - 向浏览器推送审批卡片，等待用户在浏览器里作答。
3. 谁先返回谁生效；浏览器端的等待可取消（用户离开、WS 断开），取消后完全交还桌面链路；**不设会提前拒绝的全局超时**。两者都没有应答者时仍按 DSH 语义失败关闭为 `unavailable`。
4. 决策写入 DSH 审计事件，插件另记一条「来自哪台设备」的本地审计。

> 关键点：远程端不是唯一的审批方，而是与桌面并列的「另一个可用应答器」。这样不会破坏 DSH 原有的失败关闭语义，也不会让桌面端的审批卡永久挂起。

---

## 4. 形态对比与选择

| 方案 | 做法 | 功能覆盖 | 浏览器体验 | 工作量 | 安全边界 | 结论 |
|---|---|---|---|---|---|---|
| **A. 浏览器控制台（推荐）** | 插件 + 中继 + 自制 PWA | 会话/指令/停止/审批/提问/通知 | 好，专为浏览器设计 | 中 | 设备级令牌、可撤销 | **v1 采用** |
| B. 完整 GUI 隧道 | 插件把 loopback GUI 经中继反向代理，浏览器开网页版 DSH | 100%（等价桌面） | 差，桌面布局挤在小窗口里 | 中高 | 需要 `trustedHosts` + token 注入，owner 权限过大 | 二期可选「兼容模式」 |
| C. IM 机器人 | 中继接 Telegram/飞书/企微，对话即控制 | 文本指令/通知/简单审批 | 极好，原生推送 | 低 | 依赖第三方平台 | 可作为通知与应急通道 |
| D. 官方 Remote API 客户端 | PWA 走 `/connect` + Typert RPC，等价一个官方客户端 | 随 DSH 版本自动增长 | 取决于自制 UI | 高，协议复杂 | 与 GUI 同一套认证 | 长期演进方向 |

**推荐路线：A 为 v1 主线，B 作为 v1.5 可选，C 只做通知适配器，D 暂不做。**

理由：

- DSH 的 GUI 是为桌面设计的，直接搬到小屏幕上体验不会好；而远程场景最高频的动作只有「看进度、发一句、停、批」。
- 自建协议比复刻 Typert 客户端简单一个数量级，且插件在 Host 内可以直接调服务，不需要跨进程 RPC 的类型生成。
- B 不做进 v1，是因为它需要改 profile 的 `trustedHosts`、处理 Host/Cookie 绑定和 token 注入，安全面更大，收益只是「功能全覆盖」。

---

## 5. 功能清单

优先级：P0 = v1 必须；P1 = 好用；P2 = 锦上添花。

### 5.1 P0（MVP）

| 能力 | 浏览器端表现 | Host 侧实现 | 验收 |
|---|---|---|---|
| 实例在线状态 | 顶部「已连接/离线/电脑睡眠」 | WSS 心跳 + `hello` 上报版本/主机名 | 拔网线/关电脑后 30s 内变灰 |
| 会话列表 | 标题、运行中、待审批/待回答、最近活动 | `sessionController.list()` + `projections`（标题在 projection 里，摘要本身不含标题） | 与桌面侧栏基本一致 |
| 实时时间线 | 用户/助手文本、工具调用折叠摘要、错误、token 用量 | `sessionController.follow({ assistantStream: true })` + `session/event` | 浏览器看到的内容在 1s 内追上桌面 |
| 发消息 | 输入框，排队/插话切换，发送回执 | `sessionController.prompt({ requestId, mode, content })` | 重复点发送只入队一次（requestId 幂等） |
| 停止 | 「停止」按钮，二次确认 | `sessionController.cancel()` | 当前回合停止，排队输入保留 |
| 审批 | 工具名、原因、参数预览、允许一次/拒绝 | `approval/request` 应答者 + `session/event` 里按 `callId` 找参数 | 浏览器允许后桌面工具继续执行 |
| 提问 | 单选/多选/自由文本/计划审阅 | `user-questions/request` 应答者；已继续的用 `userQuestions.answer` | 回答后模型拿到答案 |
| 通知 | 审批、提问、回合结束、失败 | `session/event` + 两个 waterfall 事件 | 系统通知能收到，点开直达会话 |
| 配对/撤销 | 链接/扫码配对、设备列表、撤销 | 中继配对接口 + `ctx.credentials` | 撤销后 10s 内浏览器 401 |
| 暂停远程 | 设置页总开关 | 插件断开/恢复 WSS | 暂停后浏览器端无法执行任何操作 |

### 5.2 P1（体验）

| 能力 | 说明 |
|---|---|
| 新建会话 | `sessionController.create({ workspaceId?, cwd?, agentPreset? })`；先选工作区 |
| 工作区列表 | `ctx.workspaceRegistry.list()`，显示路径与最近会话 |
| 模型/预设切换 | `modelCatalog()` + `selectModel()`；预设用 `agentPresets.list()` |
| 队列查看/编辑 | `state.queue` + `updateQueue`（改/删/插话） |
| 图片上传/查看 | `ctx.fileUploads` / `ctx.attachments`，选择本地图片上传 |
| 会话搜索/重命名/归档 | `search` / `rename` / `workspaceRegistry.archiveSession` |
| 多实例 | 浏览器端实例切换（家里 PC + 云上 DSH） |
| 通知渠道 | Web Push + ntfy/Bark/企微/飞书/Telegram 适配器 |
| 只读分享 | 给家人/同事一个只能看的链接（与 liveshare 不冲突，做轻量版） |

### 5.3 P2（扩展）

| 能力 | 说明 |
|---|---|
| 完整 GUI 兼容模式 | 反向代理 + `trustedHosts`，作为「功能全覆盖」的后备 |
| 端到端加密 | X25519 + AES-GCM，中继只转发密文 |
| Passkey/生物识别解锁 | WebAuthn，防登录设备被他人拿到后直接打开 |
| 终端/文件浏览 | 高风险，默认关闭，按需开启 |
| 子代理/团队/目标/定时任务 | 只读监控 + 简单操作 |
| 语音输入 | Web Speech API 或设备自带的语音输入 |
| 审计导出 | 插件本地审计 + 中继审计合并导出 |
| 端到端测试套件 | Playwright + 真实 DSH 实例的回归 |

---

## 6. 协议设计

### 6.1 原则

- 一个实例一条 WSS 长连接，多路复用所有浏览器请求；不为每个浏览器开隧道。
- 所有状态变更幂等：`requestId` 去重，重试安全。
- 事件带单调 `seq`，断线重连从 `lastSeq` 续传；中继只保留最近 N 分钟（默认 10 分钟 / 500 条）。
- 单帧上限 1 MiB；文本超长截断并标注 `truncated`；图片走单独上传通道，不走事件流。
- 版本协商：`protocol: 1`，插件/中继/PWA 任一方不兼容时明确报错，不做静默降级。

### 6.2 帧格式

```ts
type Frame =
  | { v: 1; t: 'hello'; instanceId: string; pluginVersion: string; dshVersion: string;
      host: { name: string; os: string }; capabilities: string[] }
  | { v: 1; t: 'req'; id: string; method: string; params: unknown }
  | { v: 1; t: 'res'; id: string; ok: true; result: unknown }
  | { v: 1; t: 'res'; id: string; ok: false; error: { code: string; message: string } }
  | { v: 1; t: 'evt'; seq: number; event: RemoteEvent }
  | { v: 1; t: 'ping' | 'pong'; ts: number };
```

### 6.3 RPC 方法

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `instance.status` | – | 在线、版本、当前活动会话数 | 首屏 |
| `sessions.list` | `{ cursor? }` | `SessionSummary[]` | 只读，冷会话不激活 Agent |
| `session.open` | `{ sessionId, beforeSeq? }` | `{ snapshot, cursor }` | 首屏历史 |
| `session.follow` | `{ sessionId }` | 流式事件 | 打开会话时订阅 |
| `session.unfollow` | `{ sessionId }` | – | 切走时取消 |
| `session.prompt` | `{ sessionId, requestId, text, mode }` | `{ accepted: true }` | `mode: 'queue' \| 'steer'` |
| `session.cancel` | `{ sessionId }` | `{ accepted: true }` | 停止当前回合 |
| `session.create` | `{ workspaceId?, cwd?, agentPreset? }` | `{ sessionId }` | P1 |
| `session.rename` | `{ sessionId, title }` | `{ title }` | P1 |
| `session.selectModel` | `{ sessionId, provider, model }` | `{ selected }` | P1 |
| `model.catalog` | – | 分组模型列表 | P1 |
| `workspace.list` | – | 工作区列表 | P1 |
| `queue.update` | `{ sessionId, itemId, action }` | `{ accepted }` | P1 |
| `approval.answer` | `{ sessionId, callId, outcome }` | `{ accepted }` | `allowed-once` / `rejected` |
| `question.answer` | `{ sessionId, callId, answers }` | `{ accepted }` | 已继续的问题 |
| `device.list` | – | 设备列表 | 设置页 |
| `device.revoke` | `{ deviceId }` | – | 设置页 |
| `instance.pause` | `{ paused }` | – | 总开关 |

### 6.4 浏览器端事件

```ts
type RemoteEvent =
  | { kind: 'session.upsert'; session: Summary }
  | { kind: 'session.state'; sessionId: string; running: boolean; pending: ('approval'|'question'|'other')[] }
  | { kind: 'entry'; sessionId: string; seq: number; entry: Entry }   // 时间线新增
  | { kind: 'assistant.delta'; sessionId: string; attemptId: string; index: number; text: string }
  | { kind: 'assistant.end'; sessionId: string; attemptId: string; seq: number }
  | { kind: 'approval.request'; sessionId: string; callId: string; toolName: string;
      reason?: string; argsPreview?: string; expiresAt?: number }
  | { kind: 'question.request'; sessionId: string; callId: string; questions: Question[]; timed?: boolean }
  | { kind: 'turn.end'; sessionId: string; reason: 'completed'|'aborted'|'error'|'blocked'|'max-tokens' }
  | { kind: 'notice'; level: 'info'|'warn'|'error'; message: string };
```

`Entry` 只保留浏览器需要的字段：`user`、`assistant`（含 usage）、`tool`（名称+参数摘要+状态）、`tool-result`（成功/失败+摘要）、`error`、`turn-end`。

### 6.5 断线与恢复

- 插件：指数退避 1s→2s→4s→…→30s，抖动 ±20%；收到 1012/1013 时重连。
- 中继：实例离线时保留最近事件与未完成请求 10 分钟；浏览器重连带 `lastSeq`。
- 浏览器：Service Worker 缓存壳；打开时先拉 `sessions.list`，再 `session.open`；WS 断开显示「重连中」，不阻塞输入（输入先入本地队列，恢复后按 `requestId` 重放）。
- DSH 重启：实例重新注册；浏览器端会话 id 不变，重新 `open` 即可。
- 电脑睡眠：WSS 断开；中继标记离线；浏览器显示「电脑可能已睡眠」，并提示如何唤醒（见风险）。

---

## 7. 安全设计

### 7.1 威胁模型

| 威胁 | 影响 | 对策 | 阶段 |
|---|---|---|---|
| 云服务器被入侵 | 可冒充浏览器下发指令（无 E2E 时） | 最小化中继权限、只存哈希、默认不存正文、审计；P1 上 E2E 后中继只能转发密文 | v1/P1 |
| 登录设备丢失 | 拿到设备令牌即可控制 | 设备令牌可撤销；PWA 生物识别/PIN；自动锁屏；单设备限权 | v1/P1 |
| 配对码泄露 | 他人绑定设备 | 5 分钟一次性码、限速、配对后桌面确认（可选）、新设备通知 | v1 |
| 中间人 | 窃听/篡改 | 全程 TLS（Caddy/Let's Encrypt）；HSTS；不允许降级 HTTP | v1 |
| CSRF | 第三方页面借 Cookie 发指令 | `SameSite=Lax` + 校验 `Origin` + 自定义头 `X-XD-Client` | v1 |
| XSS | 助手输出里的恶意 HTML 在浏览器端执行 | Markdown 渲染禁用原始 HTML，DOMPurify 白名单，严格 CSP | v1 |
| 重放 | 重复执行指令 | `requestId` 去重 + 时间窗 + TLS | v1 |
| 暴力破解 | 猜配对码/令牌 | 速率限制（IP+设备）、失败退避、告警 | v1 |
| 提示注入 | 模型被诱导执行危险工具 | 仍是 DSH 的审批策略；远程不降低审批级别；高风险工具可在远程回合强制 `ask` | v1.5 |
| 云主机日志泄露 | token/正文进日志 | 结构化日志脱敏；不记录 `Authorization`/Cookie/消息正文 | v1 |

### 7.2 认证与令牌

- **实例密钥**：32 字节随机，插件生成/中继签发，存 `ctx.credentials`；用于实例 WSS 鉴权（短时 ticket，不把密钥放 URL）。
- **设备令牌**：32 字节随机，中继只存 SHA-256；HttpOnly + Secure + SameSite=Lax Cookie，90 天滑动过期；每设备可单独撤销。
- **配对码**：8 位 Base32，5 分钟，一次性，错误 5 次作废。
- **作用域**：`read` / `prompt` / `approve` / `admin`。浏览器默认 `read+prompt+approve`；`admin`（撤销设备、暂停）只在桌面端。
- **不暴露 DSH 启动 token**：v1 的浏览器端完全不接触 GUI token；只有二期「完整 GUI 模式」才需要单独设计一次性 token 注入。

### 7.3 审批语义

- 插件只作为额外应答者，不改变 DSH 的 `ask`/`never` 策略，不绕过 `allowed-once`。
- 浏览器与桌面并行竞争，先到先得；浏览器离线或用户取消时回退到桌面，不额外设置会提前拒绝的全局超时。
- 两者都无法作答时返回 `unavailable`（失败关闭），与 DSH 现有语义一致。
- 每次决策在插件本地审计：时间、设备、会话、工具、结果。中继审计只记「谁在什么时候回答了哪次请求」，不记参数正文。

> 注意：`sessionController.prompt` 以 owner 身份写入 `user-rpc` 消息，模型侧看到的是普通用户输入，无法区分来自浏览器还是桌面。v1 的「来源」只存在于插件审计，不进入会话日志；若以后需要模型感知来源，再单独设计 `developer/message` 注入或 DSH 层支持。

### 7.4 云端加固

- 中继以非 root 运行，只读根文件系统，仅数据目录可写；容器加 `no-new-privileges`、`cap_drop: ALL`。
- 只开 80/443（80 仅用于 ACME）与受限 SSH；不暴露数据库端口。
- Caddy 自动 TLS + HSTS；请求体上限 1 MiB；连接数/速率限制。
- 依赖锁定 + `npm audit`；镜像定期重建。
- 备份只含 SQLite（实例、设备、配对码、审计），不含消息正文。
- 健康检查 `/healthz`；实例离线超过 N 分钟可选告警（ntfy/邮件）。

### 7.5 E2E（P1，强烈建议）

- 配对二维码里带插件公钥；浏览器生成密钥对，把公钥放进配对请求；中继只转发公钥。
- 双方 X25519 派生会话密钥，HKDF 分方向，AES-256-GCM 加密每个帧。
- 中继看到的只是 `{ instanceId, deviceId, ciphertext }`；被入侵也无法伪造指令。
- 代价：调试变难、推送内容需要中继可见的摘要（可只加密正文，保留「有审批」这类元数据）。
- 默认关闭，设置页开关；开启后中继日志中不再有任何可读内容。

---

## 8. DSH 插件实现

### 8.1 包结构

```
packages/
  plugin/                 # DSH bundle（Host + Client）
    package.json
    cordis.patch.yml
    lib/index.js          # Host 入口（esbuild 打包，零运行时依赖优先）
    lib/client.js         # Client 入口
    locale/en.json
    locale/zh.json
    icon.svg
    docs/DETAIL.md
  relay/                  # 云中继（Node + Fastify/ws + SQLite）
  web/                    # PWA（Vite + TS）
  protocol/               # 共享类型与常量（构建时内联）
deploy/
  Caddyfile
  docker-compose.yml
  systemd/
docs/
  PLAN.md
```

> DSH 插件建议打成**零依赖单文件**（`ws` 客户端用 Node 24 自带 `WebSocket`；若不可用则在构建时内联一个极小客户端），避免安装时 pnpm 解析依赖失败。

### 8.2 Manifest 与 patch

```json
{
  "name": "@local/dsh-web-control",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": []
    }
  },
  "files": ["lib", "cordis.patch.yml", "locale", "docs", "icon.svg"]
}
```

> `dsh.client.inject` 按设置页所属的 Client 包填写；这里留空，实现时用 `Slots.listSubTree` 确认槽位所有者与依赖后再补。

```yaml
- insert:
    - id: dsh-web-control
      name: '@local/dsh-web-control'
      config:
        relayUrl: https://dsh.example.com
        autoConnect: true
```

### 8.3 Host 入口

```ts
import z from '@deepseek-ai/schemastery'

export const inject = ['sessionController', 'credentials']
export const Config = z.object({
  relayUrl: z.string(), // apply 时做 URL 校验，避免依赖 schema 的 URL 辅助
  autoConnect: z.boolean().default(true),
  allowRemotePrompt: z.boolean().default(true),
  allowRemoteApproval: z.boolean().default(true),
  maxEventBytes: z.number().default(64 * 1024),
})

export function apply(ctx: Context, config: Config) {
  const link = new RelayLink(ctx, config)       // WSS、重连、心跳、ticket
  const rpc = new RpcRouter(ctx, link)          // 方法表
  const events = new EventBridge(ctx, link)     // session/event → RemoteEvent
  const approvals = new ApprovalAnswerer(ctx, link, config)
  const questions = new QuestionAnswerer(ctx, link, config)
  const pairing = new PairingService(ctx, link) // 二维码、设备、审计

  ctx.effect(() => link.start())
  ctx.effect(() => rpc.install())
  ctx.effect(() => events.install())
  ctx.effect(() => approvals.install())
  ctx.effect(() => questions.install())
  ctx.effect(() => pairing.install())
  return () => { /* 释放顺序：先停应答者，再断链 */ }
}
```

要点：

- 所有资源用 `ctx.effect` / `ctx.on` 注册并返回清理函数，保证热卸载干净。
- `ctx.on('session/event', (session, event) => ...)` 里只做轻量映射和入队，绝不做 I/O；监听器抛错会被 DSH 记录但不会影响提交。
- 审批/提问应答者里禁止长时间同步阻塞；浏览器等待用 `AbortSignal` 管理取消，不设会提前拒绝的固定超时。
- 所有对外发送的文本做长度/敏感信息截断；图片不走事件流。

### 8.4 Client 设置页

- 注册 `settings.section`，标题「远程控制」。
- 内容：
  - 连接状态（已连接/重连中/已暂停）+ 中继地址 + 延迟；
  - 「显示配对二维码」按钮（插件通过 RPC 向中继申请配对码，渲染成 SVG/PNG）；
  - 设备列表（名称、最后活跃、撤销）；
  - 开关：允许浏览器发指令 / 允许浏览器审批 / 允许浏览器看全部会话；
  - 「暂停远程控制」大按钮 + 「断开所有设备」。
- 侧栏 `sidebar.footer.action` 可选加一个小圆点，表示浏览器正在查看。

### 8.5 配置与凭据

- 非敏感配置（中继地址、开关、截断上限）走 `Config`，可在 Settings 修改。
- 实例密钥、设备令牌、配对码只进 `ctx.credentials.modifyRecord()` 的记录或插件私有状态文件，**不写进 `cordis.patch.yml`，不打日志**。
- 设置页修改非敏感配置时走 `ctx.get('configEditor').edit()`，不要自行改写 profile 的 patch；连接相关字段变更后断开重连，`volatile` 字段可原地更新。

### 8.6 兼容性与升级

- `dsh` 版本检测：`hello` 里带 `dshVersion`；插件对 `sessionController` 的必需方法做启动时探测，缺失则降级并明确提示，不崩溃。
- 不 import `@deepseek-ai/dsh-*` 的内部路径；只使用 `ctx.*` 服务和公开类型（类型可用 `import type`）。
- 锁定一个已测试的 DSH 版本范围（例如 `0.2.2-rc.x`），在 `README` 里写明；DSH 升级后跑回归。
- 协议版本独立于 DSH 版本；中继拒绝不兼容的插件/PWA，并给出可操作的错误。

### 8.7 日志与审计

- 插件日志走 DSH logger，字段：`instance`, `device`, `session`, `action`；不含消息正文、token、Cookie。
- 本地审计 JSONL：`$DSH_HOME/dsh-web-control/audit-YYYYMM.jsonl`，每行 `{ ts, deviceId, sessionId, action, result }`；保留 30 天。
- 设置页可看最近 50 条，可导出。

---

## 9. 云中继实现

### 9.1 技术栈

- Node 24 + Fastify（HTTP）+ `ws`（WebSocket）+ better-sqlite3（或 `node:sqlite`）。
- 与插件共享 `protocol/` 的 TypeScript 类型；构建时各自打包。
- 单进程足够；水平扩展不是 v1 目标（一个用户、一台实例）。

### 9.2 接口

| 方法/路径 | 认证 | 用途 |
|---|---|---|
| `POST /v1/instance/enroll` | 引导令牌（一次性） | 实例首次注册，返回 `instanceId + instanceSecret` |
| `POST /v1/instance/ticket` | 实例密钥 | 换取 60s 一次性 WSS ticket |
| `GET /v1/instance/ws?ticket=` | ticket | 插件长连接 |
| `POST /v1/pair/start` | 实例密钥 | 生成配对码/二维码 URL |
| `POST /v1/pair/claim` | 配对码 | 绑定设备，下发设备 Cookie |
| `GET /v1/me` | 设备 Cookie | 当前设备/实例/作用域 |
| `GET /v1/instances` | 设备 Cookie | 可访问实例列表（多实例） |
| `POST /v1/rpc` | 设备 Cookie + Origin + 自定义头 | 统一 RPC 转发 |
| `GET /v1/events` | 设备 Cookie | 浏览器事件 WSS |
| `DELETE /v1/devices/:id` | 设备 admin 或实例密钥 | 撤销 |
| `POST /v1/instance/pause` | 实例密钥 | 暂停远程 |
| `GET /healthz` | 无 | 健康检查 |

### 9.3 数据表（SQLite）

```sql
instances(id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT, dsh_version TEXT,
          last_seen INTEGER, paused INTEGER DEFAULT 0, created_at INTEGER);
devices(id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, name TEXT, token_hash TEXT NOT NULL,
        scopes TEXT NOT NULL, last_seen INTEGER, revoked_at INTEGER, created_at INTEGER);
pair_codes(code_hash TEXT PRIMARY KEY, instance_id TEXT NOT NULL, expires_at INTEGER, used_at INTEGER);
audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, instance_id TEXT, device_id TEXT,
      action TEXT, session_id TEXT, result TEXT);
```

- 不建消息表；事件只在内存环形缓冲（每实例 500 条/10 分钟）。
- 审计只记动作，不记正文；30 天清理。

### 9.4 部署

```yaml
# docker-compose.yml（示意）
services:
  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile", "caddy_data:/data"]
  relay:
    build: ./relay
    restart: unless-stopped
    read_only: true
    tmpfs: ["/tmp"]
    volumes: ["./data:/data"]
    environment:
      - PUBLIC_URL=https://dsh.example.com
      - BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}
      - DATA_DIR=/data
```

Caddyfile：

```
dsh.example.com {
  encode zstd gzip
  reverse_proxy relay:8787
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
  }
  request_body { max_size 1MB }
}
```

中国大陆部署注意：

- **域名备案**：大陆节点的 80/443 对外提供 Web 服务通常要求 ICP 备案；没有备案就用香港/新加坡节点，或改用非标端口 + DNS-01 证书（不推荐非标端口，兼容性差）。
- 安全组只开 80/443/SSH；SSH 限制来源 IP。
- 云厂商的「Web 应用防火墙」可选，但不要让它改写 WebSocket 升级头。

### 9.5 运维

- `/healthz` 供云监控探活；实例离线 > 5 分钟可选通知。
- 日志 JSON 行，轮转 7 天；脱敏。
- 升级：先停插件（或让中继发 1012 让插件重连），再滚动重启中继；插件退避重连，无需人工。
- 备份：每日 SQLite 快照，保留 7 天；恢复只需 `instances`/`devices`（配对码可丢）。

---

## 10. 浏览器端 PWA

### 10.1 页面

1. **实例/会话列表**
   - 顶部：实例名、在线状态、暂停按钮；
   - 分段：需要我处理 / 运行中 / 全部；
   - 行：标题、工作区、最近活动、运行中转圈、审批/提问徽标。
2. **会话详情**
   - 时间线：用户消息、助手文本（Markdown 安全渲染）、工具调用折叠卡（名称、状态、参数摘要、结果摘要）、错误条、回合结束；
   - 底部：输入框、排队/插话切换、发送、停止；
   - 顶部：模型、token 用量、返回。
3. **审批卡片**（底部弹层）
   - 工具名、原因、参数预览（脱敏/截断）、风险提示；
   - 「允许一次」「拒绝」；若请求本身带时限则显示倒计时。
4. **提问卡片**
   - 单选/多选/自由文本；`plan-review` 用 Markdown 展示计划正文；
   - 提交后显示「已提交」。
5. **设置**
   - 设备名、通知开关、通知渠道、生物识别解锁、退出（撤销本设备）。
6. **配对页**
   - 打开配对链接或扫码后自动提交；失败给明确原因（过期/已用/实例离线）。

### 10.2 技术栈

- Vite + TypeScript；UI 用 Preact 或原生 DOM（体积小、依赖少）。
- Markdown：`markdown-it` + `DOMPurify`（禁用 raw HTML）。
- 状态：IndexedDB 存最近会话缓存与未发送队列；Service Worker 缓存壳。
- 样式：CSS 变量，跟随系统深浅色；44px 点击目标；安全区适配（支持时使用 `env(safe-area-inset-*)`）。
- 不引入大型 UI 框架，首屏目标 < 150 KB gzip。

### 10.3 推送

- **Web Push（VAPID）**：Android Chrome 依赖 FCM，国内无 GMS 的设备不可靠；iOS 16.4+ 需「添加到主屏幕」后可用（走 APNs，通常可用）。
- **推荐同时提供 ntfy**：安装 ntfy 客户端，订阅自己的 topic；中继 POST 即可，国内可用、无 Google 依赖。
- 其他适配器：Bark（iOS）、企业微信/飞书机器人、Telegram（视网络环境）。
- 通知内容：会话标题 + 事件类型（「等待审批：bash」「回合完成」），不带工具参数/正文；点开深链到会话。

### 10.4 弱网与后台

- WS 断开时输入框仍可编辑，消息进本地队列；恢复后按 `requestId` 重放。
- 页面隐藏 30s 后降频心跳；靠推送唤醒。
- 标签页切到后台时浏览器可能挂起 WS，恢复时全量对齐（`lastSeq` + `sessions.list`）。

### 10.5 可访问性

- 键盘可操作、焦点可见、屏幕阅读器标签；审批按钮有明确动词。
- 颜色不是唯一状态标识（运行中同时有文字/图标）。

---

## 11. 里程碑

| 阶段 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| **M0 技术验证** | 插件连本地假中继；读 `sessionController.list`；发一条 prompt；浏览器页面（局域网）看到流式输出 | 另一台设备上的浏览器能发消息并看到回复 | 1–2 天 |
| **M1 可用 MVP** | 真实中继 + 配对 + 会话列表 + 时间线 + 发消息 + 停止 + 审批 + 提问 + 基础通知 | 浏览器在外部网络下完成一次「发指令→审批→看到完成」的闭环 | 5–8 天 |
| **M2 体验与安全** | 设备撤销、暂停、审计、设置页、断线恢复、速率限制、CSP、部署脚本、文档 | 撤销设备后立即失效；断网/重启后自动恢复；无高危告警 | 4–6 天 |
| **M3 扩展** | 新建会话/工作区/模型、图片、队列编辑、多实例、Web Push/ntfy、可选 E2E | 日常只用浏览器也能完成大部分操作 | 3–5 天 |
| **M4 可选** | 完整 GUI 兼容模式、只读分享、语音 | 需要时再做 | 3–5 天 |

**总计**：v1（M0–M2）约 10–16 个工作日；做到 M3 约 3–4 周。若先做「只读监控 + 通知」的 V0，2–3 天可上线。

---

## 12. 风险与对策

| 风险 | 可能性 | 影响 | 对策 |
|---|---|---|---|
| DSH 0.2.x 是 rc，Host API 变动 | 中 | 插件失效 | 只用公开服务 + 启动探测 + 版本范围 + 回归测试 |
| 审批 waterfall 与桌面端竞争 | 中 | 桌面卡片残留/重复 | 浏览器与桌面并行、先到先得；依赖 `approval/decided` 让桌面卡片自动收掉；浏览器取消时回退 |
| 电脑睡眠/断网 | 高 | 远程不可用 | 设置页提示；可选「接通电源时不睡眠」；WOL 仅作为局域网补充；离线状态明确 |
| 浏览器后台挂起 WS | 高 | 通知延迟 | 推送为主、WS 为辅；重连全量对齐 |
| 云主机被入侵 | 低 | 高（可控制 PC） | 最小权限、只存哈希、不存正文、审计；P1 E2E |
| 登录设备丢失 | 中 | 高 | 设备令牌撤销、生物识别、自动锁屏、作用域 |
| 域名/备案/端口 | 中 | 部署受阻 | 香港/新加坡节点；或 DNS-01 + 非标端口；Cloudflare Tunnel 备选 |
| 事件体过大（工具输出） | 高 | 流量/卡顿 | Host 侧截断与摘要；图片走单独通道；单帧上限 |
| XSS（助手输出） | 中 | 高 | 禁 raw HTML + DOMPurify + CSP |
| 用户误操作（远程批准危险命令） | 中 | 高 | 参数预览、风险提示、二次确认、审批不自动放行 |
| 依赖/供应链 | 低 | 中 | 插件零依赖；中继依赖锁定；镜像扫描 |

---

## 13. 需要你确认的事

1. **形态**：按推荐做「浏览器控制台」（A），还是更想要「完整 Web GUI 搬到浏览器」（B）？
   - 默认：A 为 v1，B 作为后续可选。
2. **控制范围**：v1 是否只要「看 + 发指令 + 停止 + 审批/提问 + 通知」？
   - 默认：是；新建会话/模型切换/图片放到 P1。
3. **云服务器**：系统（Ubuntu/Debian？）、是否有域名、是否能开 443、是否装了 Docker、在大陆还是境外（涉及备案）。
4. **浏览器**：桌面浏览器还是移动端浏览器？（影响推送方案：iOS Web Push 可用；国内 Android 建议 ntfy。）
5. **安全级别**：v1 只做 TLS + 设备令牌 + 审计，还是直接上 E2E？
   - 默认：v1 先 TLS，M2/M3 加 E2E 开关。
6. **实例数量**：只控制这台 Windows PC，还是也要控制云上/其他机器的 DSH？
7. **通知渠道**：Web Push、ntfy、Bark、企业微信/飞书、Telegram，优先哪个？

---

## 14. 下一步

你确认第 13 节的 3 个关键项（形态、云服务器情况、浏览器/设备类型）后，我按 M0 开始：

1. 在 `D:\Products\dsh-web-control` 建 monorepo（plugin / relay / web / protocol）。
2. 写一个只跑在本地的假中继，验证插件能：
   - 连接/重连；
   - `sessionController.list` 返回会话；
   - `prompt` 写入并触发 `session/event`；
   - `follow` 把助手流式输出推到浏览器页面。
3. 同一局域网内（用浏览器）打开页面，发一条消息，看到回复。
4. M0 通过后再接真实云中继、配对与审批。

M0 不需要你先买域名或改云服务器；本地跑通后再部署。
