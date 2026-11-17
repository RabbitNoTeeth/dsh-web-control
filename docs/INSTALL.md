# 安装插件

本文只讲 DSH 侧的插件安装与更新。中继服务的部署见 [DEPLOY.md](DEPLOY.md)，浏览器端和 PC 的日常使用见 [USAGE.md](USAGE.md)。

## 前置条件

- DSH Desktop `0.2.x`（当前验证版本 `0.2.2-rc.3`）。
- 本仓库的 `packages/plugin` 目录。
- 一个已经启动的中继（可以先用本机 `127.0.0.1:7801`，见 [DEPLOY.md](DEPLOY.md)）。
- 浏览器与中继网络互通。

插件本身**不需要构建，也没有 npm 依赖**；`index.js` 是 Host 半侧，`client.js` 是设置页的 Client 半侧。

## 插件目录

```text
packages/plugin/
  package.json          # dsh.bundle + dsh.client 声明
  cordis.patch.yml      # 插入 dsh-web-control 这一行
  index.js              # Host：中继连接、会话、模型、权限、配置路由
  client.js             # Client：插件详情页底部的连接设置表单
  locale/               # 插件标题和描述
  docs/DETAIL.md        # DSH 插件详情页说明
  icon.svg
```

## 安装方式一：DSH 界面（推荐）

1. 打开 DSH 左侧的 **插件**；
2. 点右上角 **添加插件**；
3. 选择 **本地目录**，选中 `packages/plugin`（必须选中包含 `package.json` 的这一层，不要选单个文件）；
4. 在「已安装插件」里出现 **DSH Web Control 远程控制** 后，确认右侧开关为开启；
5. **刷新一次 DSH 页面**（或重启 DSH），让 Client 半侧加载，插件详情页底部才会出现「DSH Web Control 连接设置」。

插件安装后默认是启用的。如果暂时不想连接中继，可以在设置表单里取消「启用远程控制」，或把插件开关关掉。

## 安装方式二：开发者 / Agent

如果使用 DSH 的插件管理能力，可以把 `packages/plugin` 的绝对路径交给 `plugin_manager` 的 `install_bundle`。它会把本地目录链接进当前 profile 的 `node_modules`，并写入 bundle 列表。

不建议手动修改 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 或 `package.json`；使用 DSH 的插件管理入口，升级和卸载才会被正确记录。

## 首次配置

1. 打开 **插件** → **DSH Web Control 远程控制**；
2. 滚动到页面底部的 **DSH Web Control 连接设置**；
3. 填写：

| 字段 | 说明 |
|---|---|
| 启用远程控制 | 关闭后插件不连接中继 |
| 中继服务器 | 云服务器 IP 或域名，例如 `1.2.3.4` |
| 端口 | 默认 `7801` |
| 电脑名称 | 中继页面上显示的名字，留空使用主机名 |
| 默认目录（不选工作区时） | 没有工作区时新建对话使用的目录 |
| 插件令牌 | 可选，与中继的插件令牌一致（`config.json` 的 `pluginToken` 或 `DSWC_PLUGIN_TOKEN`） |

4. 点 **保存并连接**；
5. 状态行显示「已连接中继 · inst_xxx」即成功。

也可以用 DSH 对话里的快捷命令，两种方式写同一份配置：

```text
/webctl 1.2.3.4:7801
/webctl status
/webctl cwd D:\Projects\demo
/webctl token <令牌>
/webctl off
```

配置保存在 `$DSH_HOME/dsh-web-control.json`（Windows 通常是 `C:\Users\<你>\.dsh\dsh-web-control.json`）。

> **从旧版本升级**：插件之前叫 XDControl，配置文件名是 `xdcontrol.json`，快捷命令是 `/xdcontrol`。新版首次加载时会自动读取旧配置并写成 `dsh-web-control.json`，旧文件保留不动；命令统一改成 `/webctl`，旧命令不再响应。中继侧的环境变量前缀也从 `XDCTL_` 改成了 `DSWC_`，见 [DEPLOY.md](DEPLOY.md#环境变量)。

## 验证

- 插件页状态显示已连接；
- 中继的 `http://<中继IP>:7801/healthz` 返回 `{"ok":true,"instances":1}`；
- 浏览器打开中继页面，能看到对应的电脑卡片；
- 点进去能看到按工作区分组的会话树。

## 更新插件

1. 用新版本覆盖 `packages/plugin` 下的文件；
2. 在 **插件** 页把 **DSH Web Control 远程控制** 关掉再打开（加载新的 Host 代码）；
3. 刷新 DSH 页面（加载新的 Client 设置页）；
4. 如果替换的是已安装的包而不是当前链接目录，按 DSH 提示重启一次。

修改 `index.js` 后，仅刷新页面不会加载新的 Host 代码；修改 `client.js` 后，刷新页面即可。

## 卸载插件

1. **插件** → **DSH Web Control 远程控制** → **卸载**；
2. 可选：删除 `$DSH_HOME/dsh-web-control.json`，避免下次安装沿用旧配置；
3. 如果不再使用远程控制，停掉中继服务（见 [DEPLOY.md](DEPLOY.md)）。

## 常见安装问题

**插件列表里没有 DSH Web Control**

- 确认选择的是 `packages/plugin` 目录，而不是仓库根目录或 `index.js`；
- 查看插件页的诊断信息；如果是导入失败，确认 `package.json` 的 `exports` 和 `dsh` 字段没有被改坏。

**插件已安装，但页面底部没有「DSH Web Control 连接设置」**

- 这是 Client 半侧还没加载：刷新 DSH 页面；仍然没有就重启 DSH；
- 确认插件开关是开启的；
- 确认 `client.js` 存在，并且 `package.json` 里有 `dsh.client` 和 `./client` 导出。

**保存后状态一直未连接**

- 检查中继地址、端口、协议（v0.2 只支持 `ws://`，填 IP/域名即可，不要填 `wss://`）；
- 检查中继进程是否在跑、防火墙/安全组是否放行；
- 如果中继设置了插件令牌，PC 的「插件令牌」要填同一个值；
- 看中继日志是否有 `plugin connected`。
