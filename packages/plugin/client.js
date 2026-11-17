window.__ModuleLoader__.load({
  id: '@local/dsh-web-control',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PACKAGE_NAME = '@local/dsh-web-control'

    let app

    const styles = {
      section: {
        marginTop: 24,
        paddingTop: 20,
        borderTop: '1px solid rgba(127,127,127,.28)',
        display: 'grid',
        gap: 14,
        maxWidth: 640,
      },
      title: { margin: 0, fontSize: 16, fontWeight: 650 },
      lead: { margin: 0, opacity: 0.65, fontSize: 12, lineHeight: 1.6 },
      field: { display: 'grid', gap: 6, fontSize: 13 },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'rgba(127,127,127,.08)',
        color: 'inherit',
        font: 'inherit',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
      actions: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      primary: {
        padding: '8px 16px',
        borderRadius: 8,
        border: 0,
        background: '#1f6feb',
        color: '#fff',
        font: 'inherit',
        fontWeight: 600,
        cursor: 'pointer',
      },
      secondary: {
        padding: '8px 14px',
        borderRadius: 8,
        border: '1px solid rgba(127,127,127,.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      status: { fontSize: 12, opacity: 0.75, display: 'flex', gap: 6, alignItems: 'center' },
      dot: { width: 8, height: 8, borderRadius: 999 },
    }

    function subjectPackage(subject) {
      const pkg = subject?.pkg
      if (typeof pkg === 'string') return pkg
      if (pkg && typeof pkg === 'object') return pkg.name || pkg.packageName
      if (typeof subject?.id === 'string') return subject.id
      return undefined
    }

    function isOurPage(subject) {
      const name = subjectPackage(subject)
      return typeof name === 'string' && name.startsWith(PACKAGE_NAME)
    }

    async function call(endpoint, payload) {
      const result = await app.connection.rpc.call('/webctl', endpoint, payload)
      if (!result || result.ok !== true) {
        throw new Error(result?.error?.message || '请求失败')
      }
      return result.value
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { style: styles.field },
        h('span', null, label),
        children,
        hint ? h('span', { style: { opacity: 0.55, fontSize: 11 } }, hint) : null,
      )
    }

    function Settings({ subject }) {
      const [draft, setDraft] = React.useState(null)
      const [status, setStatus] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const value = await call('config.get', {})
          setDraft(value)
          setStatus(value.connected ? '已连接中继' : value.enabled === false ? '远程控制已关闭' : '未连接')
        } catch (error) {
          setStatus(`读取配置失败：${error.message}`)
        }
      }, [])

      React.useEffect(() => {
        if (isOurPage(subject)) void load()
      }, [subject, load])

      if (!isOurPage(subject)) return null

      if (!draft) {
        return h('section', { style: styles.section },
          h('h2', { style: styles.title }, 'DSH Web Control 连接设置'),
          h('p', { style: styles.lead }, status || '读取配置…'),
        )
      }

      const update = (key, value) => setDraft(current => ({ ...current, [key]: value }))

      async function save() {
        setBusy(true)
        setStatus('保存中…')
        try {
          const value = await call('config.set', {
            enabled: draft.enabled !== false,
            relayHost: draft.relayHost,
            relayPort: Number(draft.relayPort) || 7801,
            instanceName: draft.instanceName,
            defaultCwd: draft.defaultCwd,
            pluginToken: draft.pluginToken,
          })
          setDraft(value)
          setStatus(value.enabled === false ? '已关闭远程控制' : '已保存，正在连接中…')
          setTimeout(async () => {
            try {
              const latest = await call('config.get', {})
              setDraft(current => ({ ...current, connected: latest.connected, instanceId: latest.instanceId }))
              setStatus(latest.connected ? '已连接中继' : latest.enabled === false ? '远程控制已关闭' : '未连接，请检查地址和端口')
            } catch {
              // Keep the saved message; the next manual refresh can retry.
            }
          }, 1500)
        } catch (error) {
          setStatus(`保存失败：${error.message}`)
        } finally {
          setBusy(false)
        }
      }

      const enabled = draft.enabled !== false
      const connected = draft.connected === true

      return h('section', { style: styles.section },
        h('h2', { style: styles.title }, 'DSH Web Control 连接设置'),
        h('p', { style: styles.lead },
          '插件会主动连接这个中继；在任意浏览器打开中继页面即可控制这台电脑。保存后立即生效，无需重启 DSH。'),

        h('label', { style: styles.row },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: event => update('enabled', event.target.checked),
          }),
          '启用远程控制',
        ),

        h(Field, { label: '中继服务器', hint: 'IP 或域名，例如 1.2.3.4；可带 http:// 前缀' },
          h('input', {
            style: styles.input,
            type: 'text',
            value: draft.relayHost || '',
            placeholder: '1.2.3.4',
            onChange: event => update('relayHost', event.target.value),
          }),
        ),

        h(Field, { label: '端口', hint: '默认 7801' },
          h('input', {
            style: styles.input,
            type: 'number',
            min: 1,
            max: 65535,
            value: String(draft.relayPort ?? 7801),
            onChange: event => update('relayPort', event.target.value),
          }),
        ),

        h(Field, { label: '电脑名称', hint: '留空使用主机名' },
          h('input', {
            style: styles.input,
            type: 'text',
            value: draft.instanceName || '',
            placeholder: '我的电脑',
            onChange: event => update('instanceName', event.target.value),
          }),
        ),

        h(Field, { label: '默认目录（不选工作区时）', hint: '留空时跟随 DSH 工作区；例如 D:\\Projects\\demo' },
          h('input', {
            style: styles.input,
            type: 'text',
            value: draft.defaultCwd || '',
            placeholder: 'D:\\Projects\\demo',
            onChange: event => update('defaultCwd', event.target.value),
          }),
        ),

        h(Field, { label: '插件令牌', hint: '可选；与中继的 DSWC_PLUGIN_TOKEN 一致' },
          h('input', {
            style: styles.input,
            type: 'password',
            value: draft.pluginToken || '',
            placeholder: '留空表示不校验',
            onChange: event => update('pluginToken', event.target.value),
          }),
        ),

        h('div', { style: styles.status },
          h('span', {
            style: {
              ...styles.dot,
              background: connected ? '#3fb950' : enabled ? '#d29922' : '#8b949e',
            },
          }),
          h('span', null, status || (connected ? '已连接中继' : '未连接')),
          draft.instanceId ? h('span', { style: { opacity: 0.5 } }, `· ${draft.instanceId}`) : null,
        ),

        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: { ...styles.primary, opacity: busy ? 0.6 : 1 },
            disabled: busy,
            onClick: () => void save(),
          }, busy ? '保存中…' : '保存并连接'),
          h('button', {
            type: 'button',
            style: styles.secondary,
            disabled: busy,
            onClick: () => void load(),
          }, '刷新状态'),
        ),
      )
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        app = ctx
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register({
            name: 'plugins.detail.section',
            id: 'dsh-web-control-settings',
            order: 10,
          }, Settings),
        )
      },
    }
  },
})
