'use strict'
// DSH 页面元素选择插件：bootstrap（Playwright 版，使用系统已安装浏览器）
// 协议不变：stdout 输出 'READY' → 读 stdin 载荷（helper-playwright.js + inspector.js）
//           → 写入 %TEMP%\dsh-webpage-element-picker → 安装 playwright-core → 探测浏览器 → 启动 helper
// argv[2] = npm cli 脚本入口（<nodeDir>/node_modules/npm/bin/npm-cli.js）
// argv[3] = DSH web 服务器端口
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

const npmCli = process.argv[2]
const port = process.argv[3]
if (!npmCli) {
  console.error('bootstrap: missing npm cli script argument')
  process.exit(2)
}
if (!fs.existsSync(npmCli)) {
  console.error('bootstrap: npm cli not found: ' + npmCli)
  process.exit(2)
}

process.stdout.write('READY\n')

// PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 双保险：任何 playwright 相关进程都不允许下载浏览器
const env = Object.assign({}, process.env, {
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  NODE_PATH: path.join(pwNode, 'node_modules'),
  npm_config_cache: npmCache,
  npm_config_ignore_scripts: 'true',
})

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
      if (code === 0) resolve({ stdout: out, stderr: err })
      else reject(new Error('exit code ' + code + ' · ' + err.slice(-400)))
    })
  })
}

let started = false
async function start(helperCode, inspectorCode) {
  if (started) return
  started = true

  fs.writeFileSync(path.join(dir, 'helper-playwright.js'), helperCode)
  fs.writeFileSync(path.join(dir, 'inspector.js'), inspectorCode)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-webpage-element-picker',
    main: 'helper-playwright.js',
    version: '2.0.0',
  }))
  // 清理旧版（Electron 时代）遗留文件，避免混淆
  try { fs.rmSync(path.join(dir, 'helper-main.js'), { force: true }) } catch (err) {}
  try { fs.rmSync(path.join(dir, 'browser-probe.cjs'), { force: true }) } catch (err) {}

  await ensurePlaywright()
  const browser = await probeBrowser()
  console.error('bootstrap: 使用浏览器 ' + browser.name + '（' + browser.path + '）')
  spawnHelper(browser)
}

async function ensurePlaywright() {
  const marker = path.join(pwNode, 'node_modules', 'playwright-core', 'package.json')
  if (fs.existsSync(marker)) return
  console.error('bootstrap: 首次安装 playwright-core 运行时（约 13MB，仅一次，不下载任何浏览器）…')
  try {
    const r = await runAndWait([
      process.execPath, npmCli,
      'install', '--prefix', pwNode,
      '--no-save', '--no-audit', '--no-fund', '--no-package-lock',
      '--ignore-scripts', '--loglevel=error',
      'playwright-core@' + PW_VERSION,
    ], { cwd: dir, env: env }, 240000)
    if (r.stderr) console.error('bootstrap: npm 输出: ' + r.stderr.slice(-600))
  } catch (err) {
    throw new Error('无法安装 playwright-core 运行时（请检查网络后重试）: ' + String((err && err.message) || err))
  }
  if (!fs.existsSync(marker)) {
    throw new Error('playwright-core 安装后未找到: ' + marker)
  }
}

async function probeBrowser() {
  const probePath = path.join(__dirname, 'browser-probe.cjs')
  if (!fs.existsSync(probePath)) {
    throw new Error('资源目录缺少 browser-probe.cjs（请与 bootstrap.cjs 一起部署）')
  }
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
  return info
}

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
  child.on('error', (err) => {
    console.error('bootstrap: helper spawn failed: ' + err.message)
    process.exit(3)
  })
  child.on('exit', (code) => { process.exit(code == null ? 1 : code) })
  child.stdout.on('data', (d) => { process.stdout.write(d) })
  child.stderr.on('data', (d) => { process.stderr.write(d) })
}

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
      console.error('bootstrap: payload missing split marker')
      process.exit(2)
    }
    start(input.slice(0, i), input.slice(i + marker.length)).catch((err) => {
      console.error('bootstrap: ' + String((err && err.message) || err))
      process.exit(1)
    })
  } else {
    parts.push(line)
  }
})

rl.on('close', () => {})
