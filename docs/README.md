# DSH Web Control 文档

| 文档 | 内容 |
|---|---|
| [INSTALL.md](INSTALL.md) | 在 DSH 中安装、启用、更新、卸载插件 |
| [DEPLOY.md](DEPLOY.md) | 本地运行、config.json 配置、云服务器 systemd/Docker 部署、环境变量、安全与故障排查 |
| [USAGE.md](USAGE.md) | PC 端配置、浏览器端登录/工作区树/新建对话/Markdown/安全提醒 |
| [PLAN.md](PLAN.md) | 早期设计草案（WSS/PWA、推送、E2E 等未实现，不代表当前能力） |

## 一分钟理解

```text
浏览器 ──HTTP/WS──► 中继（你的云服务器，默认 7801）
                              ▲
                              │ PC 主动出站 WS（v0.2 为 ws:// 明文）
                              │
                     Windows PC：DSH Desktop + DSH Web Control 插件
```

- PC 不需要公网 IP，不需要端口映射；
- 中继只转发消息，不保存对话内容；
- 插件在 DSH 的「插件 → DSH Web Control 远程控制」页面里配置；
- 浏览器通过工作区树查看会话，点工作区右侧「+」新建对话。

## 版本

当前为 `v0.2`：个人自用、HTTP + 用户名密码、无端到端加密。远程会话可按预设选择只读 / 工作区可写 / 完全权限，请先阅读 [USAGE.md](USAGE.md) 的安全提醒。
