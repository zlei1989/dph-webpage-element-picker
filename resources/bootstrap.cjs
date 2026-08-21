'use strict'
// DSH 页面元素选择插件：bootstrap（Playwright 版，使用系统已安装浏览器）
// 职责：作为 host 插件与浏览器 helper 之间的引导层——接收源码载荷、
//       准备 playwright-core 运行时、探测系统浏览器、拉起 helper 并透传退出码。
// 协议不变：stdout 输出 'READY' → 读 stdin 载荷（helper-playwright.js + inspector.js）
//           → 写入 %TEMP%\dsh-webpage-element-picker → 安装 playwright-core → 探测浏览器 → 启动 helper
// argv[2] = npm cli 脚本入口（<nodeDir>/node_modules/npm/bin/npm-cli.js）
// argv[3] = DSH web 服务器端口
// 日志约定：stdout 只保留给协议行（'READY'）；日志一律走 stderr 并带级别
//           前缀（host 侧按 64KB 环形收集，进程退出时取尾行诊断）。
//           DEBUG 级默认关闭，DSH_WE_DEBUG=1 打开（会随 env 透传给 probe/helper）。
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const readline = require('readline')

const dir = path.join(os.tmpdir(), 'dsh-webpage-element-picker')
fs.mkdirSync(dir, { recursive: true })

// 自有缓存目录：绕开用户级 npm 缓存配置（可能是无写权限的位置，如 Program Files）
const npmCache = path.join(dir, 'npm-cache')
fs.mkdirSync(npmCache, { recursive: true })
const pwNode = path.join(dir, 'pw-node')
const PW_VERSION = '1.62.1'

const DEBUG = process.env.DSH_WE_DEBUG === '1'
/** DEBUG：分支走向、中间变量（生产默认关闭）。 */
function logDebug(msg) { if (DEBUG) process.stderr.write('bootstrap: [DEBUG] ' + msg + '\n') }
/** INFO：关键状态变更、外部调用耗时。 */
function logInfo(msg) { process.stderr.write('bootstrap: [INFO] ' + msg + '\n') }
/** WARN：降级、重试、可继续的异常输出。 */
function logWarn(msg) { process.stderr.write('bootstrap: [WARN] ' + msg + '\n') }
/** ERROR：业务异常、外部调用失败——带堆栈和业务上下文。 */
function logError(msg, err) {
  const detail = err ? String((err && err.stack) || err) : ''
  process.stderr.write('bootstrap: [ERROR] ' + msg + (detail ? '\n' + detail : '') + '\n')
}

const npmCli = process.argv[2]
const port = process.argv[3]
if (!npmCli) {
  logError('missing npm cli script argument (argv[2])')
  process.exit(2)
}
if (!fs.existsSync(npmCli)) {
  logError('npm cli not found: ' + npmCli)
  process.exit(2)
}

// 协议握手：告知 host「stdin 可以写载荷了」
process.stdout.write('READY\n')

// PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 双保险：任何 playwright 相关进程都不允许下载浏览器
const env = Object.assign({}, process.env, {
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  NODE_PATH: path.join(pwNode, 'node_modules'),
  npm_config_cache: npmCache,
  npm_config_ignore_scripts: 'true',
})

/**
 * spawn 一个子进程并等待退出：收集 stdout/stderr，超时杀进程并拒绝。
 * 用于 npm install 与 browser-probe 这类一次性外部调用。
 */
function runAndWait(argv, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(argv[0], argv.slice(1), Object.assign({
      stdio: ['ignore', 'pipe', 'pipe'],
    }, opts))
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch (e) {}
      reject(new Error('timed out after ' + timeoutMs + 'ms · ' + err.slice(-400)))
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 非零退出时附带 stderr 尾部，便于定位失败原因
      if (code === 0) resolve({ stdout: out, stderr: err })
      else reject(new Error('exit code ' + code + ' · ' + err.slice(-400)))
    })
  })
}

let started = false
/**
 * 主启动流程（幂等：started 标志防重复触发）：
 * 落盘源码载荷 → 确保 playwright-core 就位 → 探测系统浏览器 → 拉起 helper。
 */
async function start(helperCode, inspectorCode) {
  if (started) return
  started = true

  logDebug('载荷落盘: helper=' + helperCode.length + ' 字符, inspector=' + inspectorCode.length + ' 字符')
  fs.writeFileSync(path.join(dir, 'helper-playwright.js'), helperCode)
  fs.writeFileSync(path.join(dir, 'inspector.js'), inspectorCode)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-webpage-element-picker',
    main: 'helper-playwright.js',
    version: '2.0.0',
  }))
  // 清理旧版（Electron 时代）遗留文件，避免混淆
  try { fs.rmSync(path.join(dir, 'helper-main.js'), { force: true }) } catch (err) { logDebug('清理 helper-main.js 失败（可忽略）') }
  try { fs.rmSync(path.join(dir, 'browser-probe.cjs'), { force: true }) } catch (err) { logDebug('清理遗留 browser-probe.cjs 失败（可忽略）') }

  await ensurePlaywright()
  const browser = await probeBrowser()
  logInfo('使用浏览器 ' + browser.name + '（' + browser.path + '）')
  spawnHelper(browser)
}

/**
 * 确保 playwright-core 运行时安装到自有缓存（pw-node/）。
 * 以 package.json marker 文件判存，已装则秒过；未装则 npm install
 * （约 13MB，仅一次，PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 保证不下载浏览器）。
 */
async function ensurePlaywright() {
  const marker = path.join(pwNode, 'node_modules', 'playwright-core', 'package.json')
  if (fs.existsSync(marker)) {
    logDebug('playwright-core 已安装，跳过 npm install')
    return
  }
  logInfo('首次安装 playwright-core 运行时（约 13MB，仅一次，不下载任何浏览器）…')
  const startedAt = Date.now()
  try {
    const r = await runAndWait([
      process.execPath, npmCli,
      'install', '--prefix', pwNode,
      '--no-save', '--no-audit', '--no-fund', '--no-package-lock',
      '--ignore-scripts', '--loglevel=error',
      'playwright-core@' + PW_VERSION,
    ], { cwd: dir, env: env }, 240000)
    if (r.stderr) logWarn('npm 输出: ' + r.stderr.slice(-600))
  } catch (err) {
    throw new Error('无法安装 playwright-core 运行时（请检查网络后重试）: ' + String((err && err.message) || err))
  }
  if (!fs.existsSync(marker)) {
    throw new Error('playwright-core 安装后未找到: ' + marker)
  }
  logInfo('playwright-core 安装完成（耗时 ' + (Date.now() - startedAt) + 'ms）')
}

/**
 * 探测系统已安装的 Chromium 系浏览器：跑 browser-probe.cjs 子进程，
 * 解析其 stdout 最后一行 JSON（{ name, path }）；探测失败/结果无效均抛错。
 */
async function probeBrowser() {
  const probePath = path.join(__dirname, 'browser-probe.cjs')
  if (!fs.existsSync(probePath)) {
    throw new Error('资源目录缺少 browser-probe.cjs（请与 bootstrap.cjs 一起部署）')
  }
  logInfo('正在探测系统浏览器…')
  const startedAt = Date.now()
  let r
  try {
    r = await runAndWait([process.execPath, probePath, dir], { cwd: dir, env: env }, 180000)
  } catch (err) {
    throw new Error('浏览器探测失败: ' + String((err && err.message) || err))
  }
  const line = String(r.stdout).split('\n').map((s) => s.trim()).filter(Boolean).pop() || ''
  let info = null
  try { info = JSON.parse(line) } catch (err) {}
  if (!info || !info.path) throw new Error('浏览器探测结果无效: ' + line)
  logInfo('浏览器探测完成（' + info.name + '，耗时 ' + (Date.now() - startedAt) + 'ms' + (info.cached ? '，缓存命中' : '') + '）')
  return info
}

/**
 * 拉起 helper 子进程并透传其 stdio 与退出码：
 * bootstrap 自身的生命周期跟随 helper（helper 死 → bootstrap 退出 → host 感知）。
 */
function spawnHelper(browser) {
  const child = cp.spawn(process.execPath, [
    path.join(dir, 'helper-playwright.js'),
    String(port || ''),
    String(browser.path || ''),
    String(browser.name || 'Browser'),
  ], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env,
  })
  logInfo('helper 子进程已启动（端口参数: ' + String(port || '') + '）')
  child.on('error', (err) => {
    logError('helper spawn failed', err)
    process.exit(3)
  })
  child.on('exit', (code) => {
    logInfo('helper 已退出 (code ' + code + ')，bootstrap 跟随退出')
    process.exit(code == null ? 1 : code)
  })
  child.stdout.on('data', (d) => { process.stdout.write(d) })
  child.stderr.on('data', (d) => { process.stderr.write(d) })
}

// ---- stdin 载荷协议：按行拼接，<<<DSH_SPLIT>>> 分隔 helper/inspector 两份源码，
//      <<<DSH_END>>> 结束（Windows 上 Chromium 会关 stdin，但这里是 node 子进程，安全）----
let mode = 'payload'
let parts = []
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (mode !== 'payload') return
  if (line === '<<<DSH_END>>>') {
    mode = 'done'
    const input = parts.join('\n')
    const marker = '<<<DSH_SPLIT>>>'
    const i = input.indexOf(marker)
    if (i < 0) {
      logError('payload missing split marker ' + marker)
      process.exit(2)
    }
    start(input.slice(0, i), input.slice(i + marker.length)).catch((err) => {
      logError('启动失败', err)
      process.exit(1)
    })
  } else {
    parts.push(line)
  }
})

rl.on('close', () => {})
