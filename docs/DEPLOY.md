# 部署中继服务

中继是 DSH Web Control 唯一的公网服务：它托管 Web 页面，并在浏览器和 DSH 插件之间转发消息。PC 插件只主动发起出站 WebSocket，不需要公网 IP、端口映射或 VPN。

## 架构与端口

```text
浏览器 ──HTTP/WS──► 云服务器:7801（中继）
                              ▲
                              │ 出站 WSS（PC 主动连）
                              │
                     Windows PC 上的 DSH 插件
                              │
                              ▼
                        DSH Desktop / 会话
```

- 默认端口：`7801`；
- PC 不需要开放任何入站端口；
- 中继只保存内存中的实例列表和短期连接状态，不保存对话内容；
- 多台 PC 可以连接同一个中继，浏览器实例列表会显示多个实例卡片。

## 配置文件（推荐）

中继从 `config.json` 读取部署设置。默认位置是 `packages/relay/config.json`（与 `server.js` 同级），直接编辑这个文件即可；也可以用环境变量 `DSWC_CONFIG` 指向其他路径。

```bash
cd packages/relay
npm ci
nano config.json          # Windows: notepad config.json
node server.js
```

`config.json` 是 UTF-8 编码的 JSON 对象。仓库里的默认内容就是下面这份，直接改值即可：

```json
{
  "host": "0.0.0.0",
  "port": 7801,
  "username": "admin",
  "password": "change-me",
  "sessionSecret": "",
  "sessionTtlDays": 30,
  "pluginToken": ""
}
```

### 字段总表

| 字段 | 类型 | 文件里缺省时 | 对应环境变量 | 作用 |
|---|---|---|---|---|
| `host` | string | `"0.0.0.0"` | `HOST` | 监听地址 |
| `port` | integer | `7801` | `PORT` | 监听端口 |
| `username` | string | `"admin"` | `DSWC_USER` | 浏览器端登录用户名 |
| `password` | string | `"dswc"` | `DSWC_PASSWORD` | 浏览器端登录密码 |
| `sessionSecret` | string | `""`（每次启动随机） | `DSWC_SECRET` | 浏览器端登录 Cookie 的签名密钥 |
| `sessionTtlDays` | number | `30` | `DSWC_SESSION_TTL_DAYS` | 浏览器端登录有效期（天） |
| `pluginToken` | string | `""`（不校验） | `DSWC_PLUGIN_TOKEN` | PC 插件实例连接令牌 |

### host：监听地址

- 字符串，默认 `0.0.0.0`，表示监听所有网卡；首尾空格会被去掉，空字符串会导致启动失败。
- 只想本机访问（前面有 Caddy/Nginx 反向代理）时用 `127.0.0.1`；也可以填某张网卡的具体 IP。
- Docker 部署时保持 `0.0.0.0`，否则宿主机的 `ports` 映射进不到容器。
- 它只决定中继监听哪里；浏览器和 PC 实际连接的是你填写的域名/IP 和 `port`。

### port：监听端口

- 整数，范围 1–65535（JSON 里写数字，写 `"7801"` 这样的数字字符串也能识别），默认 `7801`。
- 以下位置要使用同一个值：浏览器页面地址、PC 插件「端口」、防火墙/安全组、Docker `ports` 映射、反向代理转发。
- 非法值（0、负数、超过 65535、非数字）会启动失败，并在错误里标出来源（文件还是环境变量）。
- 改端口后要同步改 PC 插件配置，否则 PC 连不上；已连接的实例会断开并按退避重连。

### username：浏览器端登录用户名

- 字符串，默认 `admin`；首尾空格会被去掉，空字符串会导致启动失败。
- 只用于浏览器端网页登录，和 PC 插件的 `pluginToken` 无关。
- 登录成功后写进 `dswc_session` Cookie 的用户名字段；改用户名会让已登录的浏览器失效（旧 Cookie 对不上），需要重新登录。
- 特殊字符可以正常使用；登录页按原样输入即可。

### password：浏览器端登录密码

- 字符串，默认 `dswc`，不能为空；仓库里的 `config.json` 预置为占位值 `change-me`，部署时改成强密码。
- **不做首尾空格裁剪**：密码两端的空格也算密码的一部分，手动编辑时注意别带进来。
- 启动时如果检测到 `dswc`、`change-me` 等占位值会打印 WARNING，提醒你还没改。
- 修改密码不会让已登录的浏览器立即掉线（Cookie 里不含密码，只含用户名和过期时间），但下次登录要用新密码。
- 密码校验是在中继内存里做的常量时间比较；浏览器到中继是 HTTP 明文，安全依赖 VPN/内网/反向代理。

### sessionSecret：登录 Cookie 签名密钥

- 字符串，默认空；空时每次启动用 `crypto.randomBytes(32)` 生成临时值（首尾空格会被去掉）。
- 作用：给浏览器端登录 Cookie `dswc_session` 里 `{用户名, 过期时间}` 的负载做 HMAC-SHA256 签名，防止伪造；服务端用 `timingSafeEqual` 校验。
- 它**不是登录密码，也不加密任何通信**；浏览器和 PC 都拿不到这个值，它只留在中继进程里。
- 留空：中继每次重启都会换密钥，浏览器端旧登录全部失效，需要重新登录。
- 填固定的长随机串（推荐 `openssl rand -hex 32`，至少 32 字节随机）：重启中继后浏览器端保持登录。
- 修改这个值等价于让所有浏览器重新登录；长度没有硬限制，但越长越随机越好。

### sessionTtlDays：浏览器登录有效期

- 数字，默认 `30`，单位是**天**；可以写小数，例如 `7`、`0.5`（12 小时）、`1.5`（36 小时）。
- 合法范围：大于 0 且不超过 `3650`；最终写入 Cookie 的有效期至少 60 秒。
- 同时控制登录 Cookie `dswc_session` 的 `exp` 和 `Max-Age`，浏览器端到期后需要重新登录。
- **只影响新签发的登录 Cookie**：把有效期改小不会立刻让已经登录的浏览器掉线，旧 Cookie 仍按原过期时间有效；想立即让所有浏览器重新登录，请修改 `sessionSecret`（或清掉浏览器 Cookie）。
- 它不影响 PC 插件的连接，也不影响 `pluginToken`；和 `sessionSecret` 是两件不同的事：一个决定“登录能保持多久”，一个决定“Cookie 是否被篡改”。
- 旧配置没有这个字段时按 30 天处理；非法值（0、负数、非数字、超过 3650）会启动失败并指出来源。

### pluginToken：PC 插件实例令牌

- 字符串，默认空；可填任意字符（PC 插件连接时会做 URL 编码），首尾空格会被去掉。
- 作用：PC 插件连接中继的 `/ws/plugin?token=...` 时，中继用常量时间比较校验；只有匹配的客户端才能登记成一台「电脑」。
- 留空表示不校验：任何能访问中继的客户端都能注册一个实例，浏览器实例列表里会出现假电脑（控制不了你的 PC，但会干扰使用）。
- 填写后，必须在 DSH 插件设置页的「插件令牌」里填同一个值，否则 PC 一直显示未连接；修改后 PC 插件要同步修改并重连。
- 它只保护实例注册；浏览器端登录、浏览器到中继的 `/api/*` 和 `/ws/client` 仍然用 `username` / `password` 的登录 Cookie。
- v0.2 只走 `ws://` 明文，令牌会出现在 URL 查询串里，只能算额外一层门槛，链路安全仍要靠 VPN/内网或反向代理 TLS。

### 文件和加载行为

- 编码：UTF-8，带 BOM 也能读取；必须是 JSON 对象，不支持注释和尾逗号；字段名区分大小写。
- 未知字段会被忽略，并在启动日志里提示 `config: ignored unknown field ...`，便于发现拼写错误。
- 路径：默认是 `packages/relay/config.json`；`DSWC_CONFIG` 可以指向绝对路径，或相对当前工作目录的路径。
- 文件不存在：默认路径下继续用环境变量/默认值启动；`DSWC_CONFIG` 显式指定时按配置错误处理，退出码 1。
- JSON 解析失败、端口非法、密码为空：打印 `[dsh-web-control] 启动失败: ...`，以退出码 1 退出，不会带着错误配置启动。
- 优先级：同一字段 **文件 > 环境变量 > 默认值**，逐字段独立；启动日志的 `config:` 行会显示实际使用的文件。
- 修改后需要重启中继进程（systemd：`systemctl restart dsh-web-control-relay`）才生效。
- 权限：`chmod 600 config.json`；systemd 部署时文件要属于服务用户（`chown dsh-web-control:dsh-web-control config.json`），否则服务读不到。如果仓库会公开，不要把真实密码和令牌提交上去，可以改用环境变量，或在部署机上单独维护这个文件。

## 本地运行

Linux / macOS：

```bash
cd packages/relay
npm ci
# 编辑 config.json，至少修改 password
nano config.json
node server.js
```

Windows PowerShell：

```powershell
cd packages\relay
npm ci
notepad config.json
node server.js
```

默认监听 `0.0.0.0:7801`。浏览器打开 `http://127.0.0.1:7801/`，用配置文件里的 `username` / `password` 登录。

不想用配置文件时，也可以继续用环境变量：

```bash
DSWC_PASSWORD='换成一个强密码' node server.js
```

Windows PowerShell：

```powershell
$env:DSWC_PASSWORD = '换成一个强密码'
node server.js
```

同一局域网下让其他设备访问时，把 `127.0.0.1` 换成电脑的局域网 IP；如果打不开，检查 Windows 防火墙：

```powershell
New-NetFirewallRule -DisplayName "DSH Web Control 7801" -Direction Inbound -Protocol TCP -LocalPort 7801 -Action Allow
```

## 云服务器要求

- Linux x64/arm64，Node.js 20+（推荐 24）；
- 一个固定端口（默认 `7801`）可供浏览器访问；
- 不需要数据库，不需要持久化磁盘；
- 可选域名（仅在你准备做 HTTPS 代理时需要）。

如果云服务器在中国大陆，80/443 通常涉及 ICP 备案；`7801` 不是 80/443，但仍受云厂商安全组和当地网络策略影响。没有备案时可以用香港/新加坡节点。

## systemd 部署

以下假设仓库已上传到服务器，路径为 `/opt/dsh-web-control`。

```bash
sudo useradd --system --home /opt/dsh-web-control --shell /usr/sbin/nologin dsh-web-control
sudo mkdir -p /opt/dsh-web-control
sudo cp -r packages/relay /opt/dsh-web-control/
cd /opt/dsh-web-control/relay
sudo npm ci --omit=dev

sudo nano config.json          # 至少修改 password，可选 port / username / pluginToken
sudo chmod 600 config.json
sudo chown -R dsh-web-control:dsh-web-control /opt/dsh-web-control

sudo cp deploy/dsh-web-control-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-web-control-relay
sudo systemctl status dsh-web-control-relay
```

如果 Node 不在 `/usr/bin/node`，把 `deploy/dsh-web-control-relay.service` 里的 `ExecStart` 改成 `which node` 的结果。

配置文件也可以放在 `/etc/dsh-web-control/config.json`，再用 systemd drop-in 指定路径：

```bash
sudo systemctl edit dsh-web-control-relay
```

```ini
[Service]
Environment=DSWC_CONFIG=/etc/dsh-web-control/config.json
```

单元文件里保留了可选的 `EnvironmentFile=-/etc/dsh-web-control/relay.env`（前缀 `-` 表示文件不存在也能启动），所以旧的环境变量部署方式仍然可用；两种方式同时存在时，`config.json` 里写过的字段优先。

### 环境变量

不用配置文件时，可以用 `/etc/dsh-web-control/relay.env`：

```dotenv
PORT=7801
DSWC_USER=admin
DSWC_PASSWORD=换成一个强密码
DSWC_SECRET=换成一串随机长字符串
DSWC_SESSION_TTL_DAYS=30
DSWC_PLUGIN_TOKEN=
```

生成随机密钥：

```bash
openssl rand -hex 32
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSWC_CONFIG` | 无 | 配置文件路径；不设时读 `packages/relay/config.json` |
| `PORT` | `7801` | 监听端口，PC 和浏览器要一致 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DSWC_USER` | `admin` | 浏览器端登录用户名 |
| `DSWC_PASSWORD` | `dswc` | 浏览器端登录密码；**必须修改** |
| `DSWC_SECRET` | 每次启动随机 | 会话 Cookie 签名密钥；设置后重启中继浏览器端不用重新登录 |
| `DSWC_SESSION_TTL_DAYS` | `30` | 浏览器登录有效期（天），可写小数 |
| `DSWC_PLUGIN_TOKEN` | 空 | 可选的实例连接令牌，设置后 PC 也要填同一个值 |

> 环境变量只是配置文件的后备来源：同名字段在 `config.json` 里存在时以配置文件为准。旧版本的前缀是 `XDCTL_`。改名后中继**只认 `DSWC_`**：升级时把旧 env 文件里的变量名逐个替换，否则会退回默认密码 `dswc`，PC 也会因令牌为空重新登记。另外会话 Cookie 名从 `xd_session` 改成了 `dswc_session`，浏览器端需要重新登录一次。

### 防火墙与安全组

云厂商安全组和系统防火墙都要放行：

```bash
sudo ufw allow 7801/tcp
```

只放行 `7801` 和必要的 SSH；尽量把来源限制在你的常用网络，或通过 VPN 访问。

## Docker 部署

方式一：环境变量（原有方式）

```bash
cd deploy
DSWC_PASSWORD='换成一个强密码' \
DSWC_SECRET="$(openssl rand -hex 32)" \
docker compose up -d --build
```

方式二：配置文件

```bash
nano packages/relay/config.json          # 修改 password 等字段
# 取消 deploy/docker-compose.yml 里 volumes 两行的注释，然后启动
cd deploy
docker compose up -d --build
```

配置以只读方式挂载进容器（`../packages/relay/config.json` → `/app/config.json`），文件里写过的字段优先于 compose 的 `environment`；所以端口要以配置文件为准，并同步修改 `ports` 映射（默认是 `7801:7801`）。

`deploy/docker-compose.yml` 默认把 `7801` 映射到宿主机。容器只读根文件系统，中继不写入业务数据；挂载的配置以只读方式提供。

查看日志：

```bash
docker compose logs -f relay
```

## PC 端指向中继

在 DSH 的 **插件 → DSH Web Control 远程控制 → DSH Web Control 连接设置** 里填写：

- 中继服务器：云服务器公网 IP 或域名；
- 端口：`7801`；
- 如果中继设置了插件令牌，把同一个值填到「插件令牌」。

点 **保存并连接**。也可以用：

```text
/webctl <服务器IP>:7801
```

## 浏览器上验证

打开 `http://<服务器IP>:7801/`，用配置里的 `username` / `password`（配置文件或环境变量）登录，应该看到在线电脑。

## HTTPS / 反向代理说明

v0.2 的中继本身是 **HTTP**，PC 插件也只支持 `ws://`。可以这样做：

- 浏览器到中继：用 Caddy/Nginx 在 443 终止 TLS，并把 HTTP 和 WebSocket 升级转发到 `127.0.0.1:7801`；浏览器页面会自动使用 `wss://`；
- PC 到中继：仍然需要能访问中继的 `ws://7801`。可以只在 VPN/内网放行 7801，或给插件补 `wss` 支持。

在补 `wss` 之前，整体最稳妥的方式是用 **WireGuard / Tailscale** 等 VPN 把 PC、访问设备、中继放进同一个私有网络，而不是把 7801 裸暴露到公网。

## 升级与重启

```bash
cd /opt/dsh-web-control
sudo cp -r <新版本>/packages/relay ./relay
cd relay
sudo npm ci --omit=dev
sudo systemctl restart dsh-web-control-relay
```

- 插件会自动退避重连，不需要重新配置；
- 配置文件是 `relay/config.json`，升级前先备份；覆盖 `packages/relay` 不会删除或改写它；
- 设置了 `sessionSecret`（或 `DSWC_SECRET`）时，浏览器端登录状态在重启后保留；
- 未设置时，重启会更换 Cookie 密钥，浏览器端需要重新登录。

### 从 XDControl 改名前升级

旧版的目录、单元文件和变量前缀都带 `xdcontrol`，升级到本版时按下面三步搬一次即可：

```bash
# 1. 目录与 env 文件改名
sudo systemctl stop xdcontrol-relay
sudo mv /opt/xdcontrol /opt/dsh-web-control
sudo mv /etc/xdcontrol /etc/dsh-web-control
sudo sed -i 's/XDCTL_/DSWC_/g' /etc/dsh-web-control/relay.env

# 2. 换成新的单元文件
sudo cp deploy/dsh-web-control-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl disable --now xdcontrol-relay
sudo rm /etc/systemd/system/xdcontrol-relay.service

# 3. 重新起服务并确认
sudo systemctl enable --now dsh-web-control-relay
curl http://127.0.0.1:7801/healthz
```

搬迁后也可以改用 `config.json`：把旧 env 文件里的值填进配置文件的对应字段即可，配置文件优先于环境变量。

## 运维

- 健康检查：`curl http://127.0.0.1:7801/healthz`；
- systemd 日志：`journalctl -u dsh-web-control-relay -f`，启动时能看到 `config:` 行指向实际使用的配置文件；
- Docker 日志：`docker compose logs -f relay`；
- 中继没有数据库；备份 `/opt/dsh-web-control/relay/config.json`（或旧的 `/etc/dsh-web-control/relay.env`）即可；
- 实例列表和事件只存在内存中，中继重启后需要 PC 重新连接。

## 故障排查

| 现象 | 排查 |
|---|---|
| 浏览器打不开页面 | 安全组/ufw 是否放行端口；中继是否监听 `0.0.0.0`；云厂商是否封端口 |
| 登录一直失败 | 用户名/密码是否与配置一致（注意配置文件优先于环境变量）；重启后是否被 `sessionSecret` / `DSWC_SECRET` 影响 |
| 启动即退出，日志有「配置项 …」 | 按日志提示修 `config.json`：端口 1-65535、密码非空、JSON 合法；用 `DSWC_CONFIG` 指定的文件必须存在 |
| 改了 `config.json` 不生效 | 需要重启中继进程；systemd 用 `systemctl restart dsh-web-control-relay` |
| 配置改了但登录还是旧密码 | 配置文件里写过的字段会覆盖同名环境变量：看 `config:` 日志用的是哪个文件，以及文件里是否也写了 `password` |
| 页面能开但看不到电脑 | PC 插件是否连接；中继日志是否有 `plugin connected`；PC 填的 IP/端口是否正确 |
| PC 显示未连接 | 中继是否在跑；PC 到中继的网络；`pluginToken` 是否一致 |
| 浏览器显示电脑已离线 | 中继或 PC 重启；刷新页面重新选择实例 |
| 修改环境变量不生效 | systemd 需要 `systemctl restart dsh-web-control-relay` |
| 端口被占用 | `ss -ltnp \| grep <端口>`，改配置里的 `port` 并同步修改 PC 配置 |

## 安全清单

- [ ] 在 `config.json`（或 `DSWC_PASSWORD`）里设置强密码，不要使用默认 `dswc` 或 `change-me`；
- [ ] 设置 `sessionSecret`（或 `DSWC_SECRET`），让浏览器端登录状态跨重启保留；
- [ ] 按需设置 `sessionTtlDays`（默认 30 天），控制浏览器登录多久后需要重新登录；
- [ ] 如非必要不要裸暴露端口；优先 VPN/白名单；
- [ ] 需要多一层实例校验时设置 `pluginToken`（或 `DSWC_PLUGIN_TOKEN`），并在 PC 上填同一个值；
- [ ] 给 `config.json` 设 `chmod 600`，真实密码和令牌不要提交到公开仓库；
- [ ] 远程会话的权限由预设决定；选择完全权限时登录设备丢失等于电脑控制权丢失，给登录设备设置锁屏；
- [ ] 不用时在插件设置里关闭「启用远程控制」或执行 `/webctl off`。
