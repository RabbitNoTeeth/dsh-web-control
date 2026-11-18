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
      relayList: { display: 'grid', gap: 10 },
      relayCard: {
        display: 'grid',
        gap: 10,
        padding: 12,
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: 10,
      },
      relayCardActive: {
        borderColor: 'rgba(31,111,235,.8)',
        background: 'rgba(31,111,235,.08)',
      },
      relayHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flexWrap: 'wrap',
      },
      relayTitle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 650 },
      relayGrid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 110px', gap: 10 },
      smallDanger: {
        padding: '6px 10px',
        borderRadius: 7,
        border: '1px solid rgba(248,81,73,.4)',
        background: 'transparent',
        color: '#f85149',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
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
          const active = (value.relays || []).find(relay => relay.id === value.activeRelayId)
          setDraft(value)
          setStatus(value.connected
            ? `已连接：${active?.name || '中继'}`
            : value.enabled === false ? '远程控制已关闭' : '未连接')
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

      const relays = Array.isArray(draft.relays) && draft.relays.length > 0
        ? draft.relays
        : [{ id: 'default', name: '默认中继', relayHost: '', relayPort: 7801, pluginToken: '' }]
      const activeRelayId = relays.some(relay => relay.id === draft.activeRelayId)
        ? draft.activeRelayId
        : relays[0].id
      const activeRelay = relays.find(relay => relay.id === activeRelayId)
      const enabled = draft.enabled !== false
      const connected = draft.connected === true
      const update = (key, value) => setDraft(current => ({ ...current, [key]: value }))
      const selectRelay = id => {
        update('activeRelayId', id)
        setStatus('已选择中继，点「保存并连接」后切换')
      }
      const updateRelay = (id, key, value) => setDraft(current => ({
        ...current,
        relays: (current.relays || []).map(relay =>
          relay.id === id ? { ...relay, [key]: value } : relay),
      }))
      const addRelay = () => setDraft(current => {
        const list = current.relays || []
        return {
          ...current,
          relays: [
            ...list,
            {
              id: `relay_${Math.random().toString(36).slice(2, 10)}`,
              name: `中继 ${list.length + 1}`,
              relayHost: '',
              relayPort: 7801,
              pluginToken: '',
            },
          ],
        }
      })
      const removeRelay = id => setDraft(current => {
        const list = (current.relays || []).filter(relay => relay.id !== id)
        if (list.length === 0) return current
        return {
          ...current,
          relays: list,
          activeRelayId: current.activeRelayId === id ? list[0].id : current.activeRelayId,
        }
      })

      async function save() {
        setBusy(true)
        setStatus('保存中…')
        try {
          const value = await call('config.set', {
            enabled,
            activeRelayId,
            relays: relays.map(relay => ({
              id: relay.id,
              name: relay.name,
              relayHost: relay.relayHost,
              relayPort: Number(relay.relayPort) || 7801,
              pluginToken: relay.pluginToken,
            })),
            instanceName: draft.instanceName,
            defaultCwd: draft.defaultCwd,
          })
          const savedActive = (value.relays || []).find(relay => relay.id === value.activeRelayId)
          setDraft(value)
          setStatus(value.enabled === false
            ? '已关闭远程控制'
            : `已保存，正在连接「${savedActive?.name || '中继'}」…`)
          setTimeout(async () => {
            try {
              const latest = await call('config.get', {})
              const latestActive = (latest.relays || []).find(relay => relay.id === latest.activeRelayId)
              setDraft(current => ({ ...current, connected: latest.connected, instanceId: latest.instanceId }))
              setStatus(latest.connected
                ? `已连接：${latestActive?.name || '中继'}`
                : latest.enabled === false ? '远程控制已关闭' : '未连接，请检查当前中继的地址和端口')
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

      return h('section', { style: styles.section },
        h('h2', { style: styles.title }, 'DSH Web Control 连接设置'),
        h('p', { style: styles.lead },
          '可以保存多个中继配置，插件只会连接标记为「当前使用」的那一个；切换后点保存并连接。在任意浏览器打开对应中继页面即可控制这台电脑。'),

        h('label', { style: styles.row },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: event => update('enabled', event.target.checked),
          }),
          '启用远程控制',
        ),

        h('div', { style: styles.relayList },
          relays.map(relay => h('div', {
            key: relay.id,
            style: {
              ...styles.relayCard,
              ...(relay.id === activeRelayId ? styles.relayCardActive : {}),
            },
          },
            h('div', { style: styles.relayHead },
              h('label', { style: styles.row },
                h('input', {
                  type: 'radio',
                  name: 'dsh-web-control-active-relay',
                  checked: relay.id === activeRelayId,
                  disabled: busy,
                  onChange: () => selectRelay(relay.id),
                }),
                h('span', { style: styles.relayTitle }, relay.name || '未命名中继'),
                relay.id === activeRelayId
                  ? h('span', { style: { fontSize: 11, opacity: 0.55, fontWeight: 400 } }, '当前使用')
                  : null,
              ),
              relays.length > 1 ? h('button', {
                type: 'button',
                style: styles.smallDanger,
                disabled: busy,
                onClick: () => removeRelay(relay.id),
              }, '删除') : null,
            ),

            h(Field, { label: '配置名称', hint: '仅用于区分，例如「本地调试」「云中继」' },
              h('input', {
                style: styles.input,
                type: 'text',
                value: relay.name || '',
                placeholder: '默认中继',
                onChange: event => updateRelay(relay.id, 'name', event.target.value),
              }),
            ),

            h('div', { style: styles.relayGrid },
              h(Field, { label: '中继服务器', hint: 'IP 或域名，可带 http:// 前缀' },
                h('input', {
                  style: styles.input,
                  type: 'text',
                  value: relay.relayHost || '',
                  placeholder: '1.2.3.4',
                  onChange: event => updateRelay(relay.id, 'relayHost', event.target.value),
                }),
              ),
              h(Field, { label: '端口', hint: '默认 7801' },
                h('input', {
                  style: styles.input,
                  type: 'number',
                  min: 1,
                  max: 65535,
                  value: String(relay.relayPort ?? 7801),
                  onChange: event => updateRelay(relay.id, 'relayPort', event.target.value),
                }),
              ),
            ),

            h(Field, { label: '插件令牌', hint: '可选；与当前中继的 DSWC_PLUGIN_TOKEN 一致' },
              h('input', {
                style: styles.input,
                type: 'password',
                value: relay.pluginToken || '',
                placeholder: '留空表示不校验',
                onChange: event => updateRelay(relay.id, 'pluginToken', event.target.value),
              }),
            ),
          )),
        ),

        h('div', { style: styles.actions },
          h('button', {
            type: 'button',
            style: styles.secondary,
            disabled: busy,
            onClick: addRelay,
          }, '添加中继'),
        ),

        h(Field, { label: '电脑名称', hint: '留空使用主机名；所有中继共用' },
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

        h('div', { style: styles.status },
          h('span', {
            style: {
              ...styles.dot,
              background: connected ? '#3fb950' : enabled ? '#d29922' : '#8b949e',
            },
          }),
          h('span', null, status || (connected
            ? `已连接：${activeRelay?.name || '中继'}`
            : enabled ? '未连接' : '远程控制已关闭')),
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
