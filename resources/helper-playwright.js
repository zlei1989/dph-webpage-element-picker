'use strict'
// DSH 页面元素选择插件：浏览器侧（Playwright 版，驱动系统已安装浏览器）
// 运行形态：node helper-playwright.js <port> <browserPath> <browserName>
// 命令与事件走 DSH HTTP 服务器（协议与旧 Electron 版完全一致），页面脚本 inspector.js 零改动。
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const base = 'http://127.0.0.1:' + String(process.argv[2] || '3080')
const browserPath = process.argv[3] || ''
const browserName = process.argv[4] || 'Browser'

const profileDir = path.join(__dirname, 'profile-' + String(browserName || 'browser')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'browser')

let ctx = null
let mainPage = null
const popups = new Set()
let inspectorCode = ''
let openAttempt = 0
let lastInjectAt = 0
let autoInject = true

function postEvent(ev) {
  try {
    fetch(base + '/dsh-webpage-element-picker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: ev }),
    }).catch(() => {})
  } catch (err) {
    try { process.stderr.write('POST-FAIL: ' + String((err && err.message) || err) + '\n') } catch (e) {}
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function pollCommands() {
  while (true) {
    try {
      const res = await fetch(base + '/dsh-webpage-element-picker/poll', { signal: AbortSignal.timeout(30000) })
      const text = await res.text()
      if (text && text !== 'null') {
        let cmd
        try { cmd = JSON.parse(text) } catch (err) { cmd = null }
        if (cmd && cmd.id !== undefined) handle(cmd).catch(() => {})
      }
      await sleep(250)
    } catch (err) {
      await sleep(500)
    }
  }
}

// ---- inspector 注入（等价旧版 executeJavaScript）----
async function inject(page) {
  if (!page || page.isClosed()) return false
  const now = Date.now()
  if (now - lastInjectAt < 400) return false
  lastInjectAt = now
  try {
    await page.evaluate('(function () { try { if (typeof window.__dsh_we_cleanup__ === "function") window.__dsh_we_cleanup__() } catch (e) {} return true })()')
  } catch (err) {}
  try {
    await page.evaluate(inspectorCode)
  } catch (err) { return false }
  try {
    postEvent({ type: 'injected', url: page.url(), title: await page.title() })
  } catch (err) {}
  return true
}

// ---- console 桥接（__DSH_WE__: 前缀，与 inspector.js 约定）----
function onConsole(message) {
  const text = String(message.text())
  if (text.indexOf('__DSH_WE__:') !== 0) return
  try {
    const data = JSON.parse(text.slice('__DSH_WE__:'.length))
    if (data && data.action === 'add-to-chat') {
      autoInject = false
      postEvent({ type: 'element-selected', data: data })
    } else if (data && data.action === 'exit-mode') {
      autoInject = false
      postEvent({ type: 'mode-exited', url: data.pageUrl, title: data.pageTitle })
    }
  } catch (err) {}
}

async function rehook(page) {
  if (!autoInject) return
  if (!page || page.isClosed()) return
  const u = page.url()
  if (!/^https?:/i.test(u) && !/^file:/i.test(u)) return
  let active = false
  try {
    active = (await page.evaluate('typeof window.__dsh_we_active__ !== "undefined"')) === true
  } catch (err) {}
  if (!active) inject(page)
}

function attachPage(page, isMain) {
  page.on('console', onConsole)

  page.on('domcontentloaded', () => rehook(page))

  page.on('load', () => {
    const u = page.url()
    if (!isMain && u !== 'about:blank' && !/^https?:/i.test(u) && !/^file:/i.test(u)) {
      // 弹窗只允许 http/https/file（等价旧版 setWindowOpenHandler 的 deny 策略）
      page.close().catch(() => {})
      return
    }
    if (/^https?:/i.test(u) || /^file:/i.test(u)) {
      page.title().then((title) => postEvent({ type: 'status', url: page.url(), title: title })).catch(() => {})
    }
    rehook(page)
  })

  page.on('close', () => {
    if (isMain && mainPage === page) {
      mainPage = null
      postEvent({ type: 'window-closed' })
    } else {
      popups.delete(page)
    }
  })

  page.on('crash', () => postEvent({ type: 'error', message: '页面进程崩溃' }))
}

async function ensureBrowser() {
  if (ctx) return ctx
  if (!browserPath) throw new Error('browserPath 为空')
  const c = await chromium.launchPersistentContext(profileDir, {
    executablePath: browserPath,
    headless: false,
    viewport: { width: 1200, height: 820 },
  })
  ctx = c
  c.on('page', (page) => {
    if (!mainPage) {
      mainPage = page
      attachPage(page, true)
      return
    }
    popups.add(page)
    attachPage(page, false)
  })
  c.on('close', () => {
    ctx = null
    mainPage = null
    popups.clear()
    postEvent({ type: 'window-closed' })
  })
  // 启动时已有初始 about:blank 页面（可能早于 'page' 事件监听器）
  const first = c.pages()[0] || await c.newPage()
  if (!mainPage) {
    mainPage = first
    attachPage(first, true)
  }
  postEvent({ type: 'browser', name: browserName, path: browserPath })
  postEvent({ type: 'helper-ready' })
  return c
}

async function handle(cmd) {
  const id = cmd.id
  const reply = (obj) => { postEvent(Object.assign({ type: 'reply', id: id }, obj)) }
  try {
    if (cmd.method === 'open') {
      const url = String((cmd.params && cmd.params.url) || '')
      if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
        return reply({ ok: false, error: 'invalid url: ' + url })
      }
      autoInject = true
      await ensureBrowser()
      if (!mainPage || mainPage.isClosed()) {
        await ctx.newPage() // 'page' 事件里会设置 mainPage 并挂载处理
        if (!mainPage) return reply({ ok: false, error: '创建页面失败' })
      }
      const page = mainPage
      const attempt = ++openAttempt
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 45000 })
        if (attempt !== openAttempt) return
        reply({ ok: true, status: { state: 'open', url: page.url(), title: await page.title() } })
        inject(page)
      } catch (err) {
        if (attempt !== openAttempt) return
        reply({ ok: false, error: '页面加载失败: ' + String((err && err.message) || err).slice(0, 200) })
      }
      return
    }
    if (cmd.method === 'reinject') {
      if (!mainPage || mainPage.isClosed()) return reply({ ok: false, error: 'no window' })
      autoInject = true
      inject(mainPage)
      reply({ ok: true, status: { state: 'open', url: mainPage.url(), title: await mainPage.title() } })
      return
    }
    if (cmd.method === 'status') {
      if (!mainPage || mainPage.isClosed()) return reply({ ok: true, status: { closed: true } })
      let title = ''
      try { title = await mainPage.title() } catch (err) {}
      reply({ ok: true, status: { state: 'open', url: mainPage.url(), title: title } })
      return
    }
    if (cmd.method === 'close') {
      if (mainPage && !mainPage.isClosed()) mainPage.close().catch(() => {})
      for (const w of [...popups]) { if (w && !w.isClosed()) w.close().catch(() => {}) }
      reply({ ok: true })
      return
    }
    if (cmd.method === 'quit') {
      reply({ ok: true })
      setTimeout(async () => {
        try { if (ctx) await ctx.close() } catch (err) {}
        process.exit(0)
      }, 60)
      return
    }
    reply({ ok: false, error: 'unknown method: ' + cmd.method })
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err) })
  }
}

;(async () => {
  try {
    inspectorCode = fs.readFileSync(path.join(__dirname, 'inspector.js'), 'utf8')
  } catch (err) {
    postEvent({ type: 'error', message: 'inspector.js missing: ' + err.message })
  }
  try {
    await ensureBrowser()
    void pollCommands()
  } catch (err) {
    postEvent({ type: 'error', message: '浏览器启动失败: ' + String((err && err.message) || err).slice(0, 300) })
    process.exit(4)
  }
})()
