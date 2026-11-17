/* Viewport-emulation smoke test and screenshots for the web UI.
 *
 * Prerequisite: a headless Edge/Chrome with CDP on port 9223, for example:
 *   msedge --headless=new --remote-debugging-port=9223 --remote-allow-origins=* \
 *          --user-data-dir=%TEMP%\edge-dswc-cdp about:blank
 *
 * Env:
 *   XD_OPEN_FIRST=1        open an existing session instead of creating one
 *   DSWC_SESSION_MATCH=Bash  pick the session row containing this text
 *   XD_WORKSPACE_MATCH=... pick a workspace in the new-chat sheet
 *   XD_FONT_ONLY=1         stop after checking form font sizes
 *   XD_SHOT=name           output file base name
 */
import { promises as fs } from 'node:fs'
import { WebSocket } from 'ws'

const CDP = process.env.CDP || 'http://127.0.0.1:9223'
const APP = process.env.XD_BASE || 'http://127.0.0.1:7801'
const OUT = process.env.OUT || 'D:/Products/dsh-web-control/docs'

const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})

let nextId = 0
const pending = new Map()
ws.on('message', data => {
  const message = JSON.parse(data.toString())
  if (message.id && pending.has(message.id)) {
    const call = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) call.reject(new Error(message.error.message))
    else call.resolve(message.result)
  }
})

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'evaluate failed')
  }
  return result.result?.value
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = `${OUT}/${name}.png`
  await fs.writeFile(file, Buffer.from(data, 'base64'))
  console.log('shot', file)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.clearBrowserCache')
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await send('Page.navigate', { url: APP })
await sleep(1500)

const login = await evaluate(`fetch('/api/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: ${JSON.stringify(process.env.DSWC_PASS || 'dswc')} })
}).then(r => r.status)`)
console.log('login status', login)
await evaluate('location.reload()')
await sleep(2200)
await shot('ui-instances')

const hasCard = await evaluate("document.querySelectorAll('.card').length")
console.log('instance cards', hasCard)
if (!hasCard) {
  console.log('no instance card; aborting UI flow')
  ws.close()
  process.exit(2)
}

await evaluate("document.querySelector('.card').click()")
await sleep(1500)
await shot('ui-console')
const tree = await evaluate(`(() => ({
  workspaces: document.querySelectorAll('.ws').length,
  sessions: document.querySelectorAll('.session').length
}))()`)
console.log('tree', tree)

if (process.env.XD_OPEN_FIRST) {
  const sessions = await evaluate("document.querySelectorAll('.session').length")
  console.log('sessions', sessions)
  if (sessions > 0) {
    const match = process.env.DSWC_SESSION_MATCH || ''
    if (match) {
      const clicked = await evaluate(`(() => {
        const row = [...document.querySelectorAll('.session')].find(el => el.textContent.includes(${JSON.stringify(match)}));
        if (!row) return false;
        row.click();
        return true;
      })()`)
      console.log('matched session', clicked)
    } else {
      await evaluate("document.querySelector('.session').click()")
    }
    await sleep(2500)
    await shot(process.env.XD_SHOT || 'ui-existing-chat')
    const kinds = await evaluate(`(() => ({
      turns: document.querySelectorAll('.turn').length,
      folds: document.querySelectorAll('.turn-process').length,
      tools: document.querySelectorAll('.tool').length,
      replies: document.querySelectorAll('.msg.assistant').length,
      inputs: document.querySelectorAll('.msg.user').length
    }))()`)
    console.log('existing chat', kinds)
  }
  ws.close()
  process.exit(0)
}

const match = process.env.XD_WORKSPACE_MATCH || ''
const picked = await evaluate(`(() => {
  const groups = [...document.querySelectorAll('.ws')];
  const group = ${match ? `groups.find(el => el.textContent.includes(${JSON.stringify(match)}))` : 'groups[0]'};
  const add = group?.querySelector('.ws-add');
  if (add) { add.click(); return 'workspace'; }
  const empty = document.getElementById('empty-new-chat');
  if (empty) { empty.click(); return 'empty'; }
  return false;
})()`)
console.log('create via', picked)
await sleep(3000)
await shot('ui-chat-empty')

if (process.env.XD_FONT_ONLY) {
  const fonts = await evaluate(`(() => ({
    input: getComputedStyle(document.getElementById('input')).fontSize,
    reasoning: getComputedStyle(document.getElementById('reasoning')).fontSize
  }))()`)
  console.log('form fonts', fonts)
  ws.close()
  process.exit(0)
}

const text = process.env.XD_TEXT || '只回复一句话：浏览器端正常'
await evaluate(`(() => {
  const input = document.getElementById('input');
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('send').click();
  return true;
})()`)
await sleep(2000)

let done = false
const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  done = await evaluate(`(() => {
    const summary = document.querySelector('.turn-process > summary')?.textContent || '';
    return /已处理|已停止|处理失败|达到输出上限|已阻止/.test(summary) || !!document.querySelector('.turn-end.error');
  })()`)
  if (done) break
  await sleep(1000)
}
console.log('turn finished', done)
await sleep(500)
await shot('ui-chat')
const summary = await evaluate(`(() => {
  const bubbles = [...document.querySelectorAll('.msg.assistant .text')].map(el => el.textContent.trim());
  const model = document.getElementById('model-label').textContent;
  return {
    bubbles: bubbles.slice(-3),
    model,
    markdown: {
      blocks: document.querySelectorAll('.text.markdown').length,
      headings: document.querySelectorAll('.text.markdown h1, .text.markdown h2, .text.markdown h3').length,
      lists: document.querySelectorAll('.text.markdown ul li, .text.markdown ol li').length,
      code: document.querySelectorAll('.text.markdown pre code').length,
      table: document.querySelectorAll('.text.markdown table').length
    }
  };
})()`)
console.log('ui summary', summary)

ws.close()
process.exit(done ? 0 : 3)
