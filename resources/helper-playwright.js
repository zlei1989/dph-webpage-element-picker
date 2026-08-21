'use strict'
// DSH 页面元素选择插件：浏览器侧（Playwright 版，驱动系统已安装浏览器）
// 职责：长轮询 host 取命令 → 驱动系统浏览器执行（打开页面/注入 inspector/
//       查询状态/关窗）→ 把页面事件与命令回执经 HTTP 回传给 host。
// 运行形态：node helper-playwright.js <port> <browserPath> <browserName>
// 命令与事件走 DSH HTTP 服务器（协议与旧 Electron 版完全一致），页面脚本 inspector.js 零改动。
// 日志约定：走 stderr（经 bootstrap 透传，host 侧按 64KB 环形收集）；
//           DEBUG 级默认关闭，DSH_WE_DEBUG=1 打开（由 bootstrap env 透传）。
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const base = 'http://127.0.0.1:' + String(process.argv[2] || '3080')
const browserPath = process.argv[3] || ''
const browserName = process.argv[4] || 'Browser'

const DEBUG = process.env.DSH_WE_DEBUG === '1'
/** DEBUG：分支走向、命令参数、注入跳过依据等（生产默认关闭）。 */
function logDebug(msg) { if (DEBUG) process.stderr.write('helper: [DEBUG] ' + msg + '\n') }
/** INFO：命令入口、关键状态变更、外部调用耗时。 */
function logInfo(msg) { process.stderr.write('helper: [INFO] ' + msg + '\n') }
/** WARN：注入失败重试、事件上报失败等可继续的降级。 */
function logWarn(msg) { process.stderr.write('helper: [WARN] ' + msg + '\n') }
/** ERROR：业务异常、外部调用失败——带堆栈和业务上下文。 */
function logError(msg, err) {
  const detail = err ? String((err && err.stack) || err) : ''
  process.stderr.write('helper: [ERROR] ' + msg + (detail ? '\n' + detail : '') + '\n')
}

// 持久化 profile 目录（按浏览器名分目录）：登录态等站点数据跨会话保留
const profileDir = path.join(__dirname, 'profile-' + String(browserName || 'browser')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'browser')

let ctx = null
let mainPage = null
const popups = new Set()
let inspectorCode = ''
let openAttempt = 0
let lastInjectAt = 0
let autoInject = true

/**
 * 向 host 上报一个事件（POST /events，fire-and-forget）。
 * 上报失败只记 WARN 不抛出——host 暂不可达时浏览器侧仍可继续工作。
 */
function postEvent(ev) {
  try {
    fetch(base + '/dsh-webpage-element-picker/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: ev }),
    }).catch(() => {})
  } catch (err) {
    try { logWarn('事件上报失败: type=' + (ev && ev.type) + ' · ' + String((err && err.message) || err)) } catch (e) {}
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 长轮询循环：从 host /poll 取命令并分发执行。
 * 收到 null（25s 心跳超时）后 250ms 重连；网络错误 500ms 后重试——
 * 高频重试路径只记 DEBUG，避免 host 停服期间刷屏。
 */
async function pollCommands() {
  while (true) {
    try {
      const res = await fetch(base + '/dsh-webpage-element-picker/poll', { signal: AbortSignal.timeout(30000) })
      const text = await res.text()
      if (text && text !== 'null') {
        let cmd
        try { cmd = JSON.parse(text) } catch (err) { cmd = null }
        if (cmd && cmd.id !== undefined) {
          logDebug('收到命令: id=' + cmd.id + ' method=' + String(cmd.method))
          handle(cmd).catch(() => {})
        }
      }
      await sleep(250)
    } catch (err) {
      logDebug('poll 请求失败，500ms 后重试: ' + String((err && err.message) || err))
      await sleep(500)
    }
  }
}

// ---- inspector 注入（等价旧版 executeJavaScript）----
/**
 * 向页面注入 inspector.js：先调用旧副本的清理钩子（防重复注入叠加），
 * 再 evaluate 新副本。400ms 节流：rehook 在 domcontentloaded/load 双事件
 * 上都会触发，避免短时间重复注入。失败返回 false 并记 WARN（可继续，
 * 后续导航事件会再次尝试）。
 */
async function inject(page) {
  if (!page || page.isClosed()) return false
  const now = Date.now()
  if (now - lastInjectAt < 400) {
    logDebug('注入被节流（距上次 ' + (now - lastInjectAt) + 'ms）: ' + page.url())
    return false
  }
  lastInjectAt = now
  try {
    await page.evaluate('(function () { try { if (typeof window.__dsh_we_cleanup__ === "function") window.__dsh_we_cleanup__() } catch (e) {} return true })()')
  } catch (err) {
    logDebug('旧副本清理钩子调用失败（页面可能已跳转，可忽略）')
  }
  try {
    await page.evaluate(inspectorCode)
  } catch (err) {
    logWarn('inspector 注入失败: ' + page.url() + ' · ' + String((err && err.message) || err))
    return false
  }
  try {
    postEvent({ type: 'injected', url: page.url(), title: await page.title() })
  } catch (err) {}
  return true
}

// ---- console 桥接（__DSH_WE__: 前缀，与 inspector.js 约定）----
/**
 * 页面 console 桥：只认 `__DSH_WE__:` 前缀的 JSON 消息。
 * add-to-chat（用户点了「添加到对话」）与 exit-mode（退出选择模式）都会
 * 关闭 autoInject——用户已拿到结果或主动退出，不再自动重新注入。
 */
function onConsole(message) {
  const text = String(message.text())
  if (text.indexOf('__DSH_WE__:') !== 0) return
  try {
    const data = JSON.parse(text.slice('__DSH_WE__:'.length))
    if (data && data.action === 'add-to-chat') {
      logDebug('页面桥消息: add-to-chat（' + String(data.tagName || '?') + ' @ ' + String(data.pageUrl || '') + '）')
      autoInject = false
      postEvent({ type: 'element-selected', data: data })
    } else if (data && data.action === 'exit-mode') {
      logDebug('页面桥消息: exit-mode @ ' + String(data.pageUrl || ''))
      autoInject = false
      postEvent({ type: 'mode-exited', url: data.pageUrl, title: data.pageTitle })
    }
  } catch (err) {
    logDebug('页面桥消息解析失败（已忽略）: ' + text.slice(0, 120))
  }
}

/**
 * 导航后重挂 inspector：autoInject 开启且页面尚无活跃副本时注入。
 * 仅 http/https/file 页面注入（about:blank、chrome:// 等跳过）。
 */
async function rehook(page) {
  if (!autoInject) return
  if (!page || page.isClosed()) return
  const u = page.url()
  if (!/^https?:/i.test(u) && !/^file:/i.test(u)) {
    logDebug('跳过非 http/https/file 页面的重挂: ' + u)
    return
  }
  let active = false
  try {
    active = (await page.evaluate('typeof window.__dsh_we_active__ !== "undefined"')) === true
  } catch (err) {}
  if (!active) inject(page)
  else logDebug('页面已有活跃 inspector，跳过重挂: ' + u)
}

/**
 * 给页面挂载事件处理：console 桥、导航后重挂、弹窗策略、关闭/崩溃上报。
 * 弹窗（非主页面）只允许 http/https/file——等价旧版 setWindowOpenHandler
 * 的 deny 策略，其余协议直接关窗。
 */
function attachPage(page, isMain) {
  page.on('console', onConsole)

  page.on('domcontentloaded', () => rehook(page))

  page.on('load', () => {
    const u = page.url()
    if (!isMain && u !== 'about:blank' && !/^https?:/i.test(u) && !/^file:/i.test(u)) {
      // 弹窗只允许 http/https/file（等价旧版 setWindowOpenHandler 的 deny 策略）
      logInfo('拦截并关闭非 http/https/file 弹窗: ' + u)
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
      logInfo('主页面已关闭')
      postEvent({ type: 'window-closed' })
    } else {
      popups.delete(page)
    }
  })

  page.on('crash', () => {
    logError('页面进程崩溃: ' + page.url())
    postEvent({ type: 'error', message: '页面进程崩溃' })
  })
}

/**
 * 确保浏览器上下文已启动（单例）：以系统浏览器可执行文件 +
 * 持久化 profile 目录启动有头窗口；挂载主页面/弹窗/关闭事件。
 * 启动时可能已有初始 about:blank 页面（早于 'page' 事件监听器），需兼容。
 */
async function ensureBrowser() {
  if (ctx) return ctx
  if (!browserPath) throw new Error('browserPath 为空')
  logInfo('正在启动浏览器: ' + browserName + '（' + browserPath + '，profile: ' + profileDir + '）')
  const startedAt = Date.now()
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
    logInfo('浏览器上下文已关闭')
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
  logInfo('浏览器已就绪（耗时 ' + (Date.now() - startedAt) + 'ms）')
  return c
}

/**
 * 命令分发执行：open（导航并注入）/ reinject（仅重注）/ status（查询）/
 * close（关窗）/ quit（退出进程）。每条命令以 reply 事件回执（按 id 关联）。
 * status 是 host 侧 1.5s 轮询的高频命令，入口只记 DEBUG；其余记 INFO。
 */
async function handle(cmd) {
  const id = cmd.id
  const reply = (obj) => { postEvent(Object.assign({ type: 'reply', id: id }, obj)) }
  try {
    if (cmd.method === 'open') {
      const url = String((cmd.params && cmd.params.url) || '')
      logInfo('命令入口 open: ' + url)
      if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
        logDebug('open 网址校验未通过（需 http/https/file）: ' + url)
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
      const startedAt = Date.now()
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 45000 })
        // 导航期间又来了新的 open 命令：本次结果作废，不回执（竞态防护）
        if (attempt !== openAttempt) return
        reply({ ok: true, status: { state: 'open', url: page.url(), title: await page.title() } })
        logInfo('页面已打开: ' + page.url() + '（耗时 ' + (Date.now() - startedAt) + 'ms）')
        inject(page)
      } catch (err) {
        if (attempt !== openAttempt) return
        logError('页面加载失败: ' + url, err)
        reply({ ok: false, error: '页面加载失败: ' + String((err && err.message) || err).slice(0, 200) })
      }
      return
    }
    if (cmd.method === 'reinject') {
      logInfo('命令入口 reinject')
      if (!mainPage || mainPage.isClosed()) return reply({ ok: false, error: 'no window' })
      autoInject = true
      inject(mainPage)
      reply({ ok: true, status: { state: 'open', url: mainPage.url(), title: await mainPage.title() } })
      return
    }
    if (cmd.method === 'status') {
      logDebug('命令入口 status')
      if (!mainPage || mainPage.isClosed()) return reply({ ok: true, status: { closed: true } })
      let title = ''
      try { title = await mainPage.title() } catch (err) {}
      reply({ ok: true, status: { state: 'open', url: mainPage.url(), title: title } })
      return
    }
    if (cmd.method === 'close') {
      logInfo('命令入口 close')
      if (mainPage && !mainPage.isClosed()) mainPage.close().catch(() => {})
      for (const w of [...popups]) { if (w && !w.isClosed()) w.close().catch(() => {}) }
      reply({ ok: true })
      return
    }
    if (cmd.method === 'quit') {
      logInfo('命令入口 quit，即将退出进程')
      reply({ ok: true })
      setTimeout(async () => {
        try { if (ctx) await ctx.close() } catch (err) {}
        process.exit(0)
      }, 60)
      return
    }
    logWarn('未知命令: ' + String(cmd.method))
    reply({ ok: false, error: 'unknown method: ' + cmd.method })
  } catch (err) {
    logError('命令执行失败: ' + String(cmd && cmd.method), err)
    reply({ ok: false, error: String((err && err.message) || err) })
  }
}

// ---- 启动入口：读 inspector 源码 → 拉起浏览器 → 进入长轮询 ----
;(async () => {
  try {
    inspectorCode = fs.readFileSync(path.join(__dirname, 'inspector.js'), 'utf8')
  } catch (err) {
    logError('inspector.js missing', err)
    postEvent({ type: 'error', message: 'inspector.js missing: ' + err.message })
  }
  try {
    await ensureBrowser()
    void pollCommands()
  } catch (err) {
    logError('浏览器启动失败', err)
    postEvent({ type: 'error', message: '浏览器启动失败: ' + String((err && err.message) || err).slice(0, 300) })
    process.exit(4)
  }
})()
