'use strict'
// 探测系统已安装的 Chromium 系浏览器（优先级：Chrome > Edge > Chromium > Brave > Opera）
// 用法: node browser-probe.cjs <stateDir> [--list]
//   成功: stdout 输出一行 JSON { name, path, cached? }，exit 0
//   失败: stderr 输出原因，exit 1
// 绝不下载任何浏览器：只用 playwright-core 启动"已存在"的可执行文件做无头验证。
// 日志约定：stdout 只保留给协议行（单行 JSON 结果）；日志一律走 stderr
//           并带级别前缀。DEBUG 级默认关闭，DSH_WE_DEBUG=1 打开。
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const stateDir = process.argv[2]
const listOnly = process.argv.includes('--list')

const DEBUG = process.env.DSH_WE_DEBUG === '1'
/** DEBUG：分支走向、候选清单等中间变量（生产默认关闭）。 */
function logDebug(msg) { if (DEBUG) process.stderr.write('probe: [DEBUG] ' + msg + '\n') }
/** INFO：关键状态变更、外部调用（无头验证）耗时。 */
function logInfo(msg) { process.stderr.write('probe: [INFO] ' + msg + '\n') }
/** WARN：单个候选验证失败等可继续的降级。 */
function logWarn(msg) { process.stderr.write('probe: [WARN] ' + msg + '\n') }
/** ERROR：业务异常——整体探测失败的原因与上下文。 */
function logError(msg) { process.stderr.write('probe: [ERROR] ' + msg + '\n') }

// ---- 注册表 App Paths 查询（只读 reg.exe query）----
/**
 * 从注册表 App Paths 读浏览器可执行文件路径。
 * 依次查 HKLM 64 位与 WOW6432Node 视图；键不存在时 reg.exe 报错属预期
 * 噪音（stdio 忽略 stderr），失败返回 null 继续走候选目录。
 */
function readAppPath(exe) {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe,
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe,
  ]
  for (const key of keys) {
    try {
      const out = cp.execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'], // 键不存在时 reg.exe 的报错是预期噪音
      })
      const m = out.match(/REG_SZ\s+(\S.*)$/m)
      if (m && m[1]) return m[1].trim()
    } catch (err) {
      logDebug('注册表查询未命中: ' + key)
    }
  }
  return null
}

// ---- 候选浏览器清单（注册表 + 常见安装目录，去重）----
/**
 * 组装候选清单：先注册表 App Paths，再常见安装目录（ProgramFiles /
 * ProgramFiles(x86) / LOCALAPPDATA），按优先级排列、按路径小写去重。
 * 测试钩子：DSH_WE_BROWSER_HINTS="路径1;路径2" 直接指定候选（跳过默认探测）。
 */
function candidateList() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const la = process.env.LOCALAPPDATA || ''

  // 测试钩子：DSH_WE_BROWSER_HINTS="路径1;路径2" 直接指定候选（跳过默认探测）
  const hints = process.env.DSH_WE_BROWSER_HINTS
  if (hints) {
    return hints.split(';').map((s) => s.trim()).filter(Boolean).map((p) => ({
      name: path.basename(p, path.extname(p)), path: p,
    }))
  }

  const defs = [
    ['Chrome', 'chrome.exe', [
      pf + '\\Google\\Chrome\\Application\\chrome.exe',
      pf86 + '\\Google\\Chrome\\Application\\chrome.exe',
      la + '\\Google\\Chrome\\Application\\chrome.exe',
    ]],
    ['Edge', 'msedge.exe', [
      pf86 + '\\Microsoft\\Edge\\Application\\msedge.exe',
      pf + '\\Microsoft\\Edge\\Application\\msedge.exe',
    ]],
    ['Chromium', 'chromium.exe', [
      la + '\\Chromium\\Application\\chrome.exe',
      pf + '\\Chromium\\Application\\chrome.exe',
    ]],
    ['Brave', 'brave.exe', [
      pf + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      pf86 + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      la + '\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ]],
    ['Opera', 'opera.exe', [
      la + '\\Programs\\Opera\\opera.exe',
      pf + '\\Opera\\opera.exe',
    ]],
  ]

  const out = []
  const seen = new Set()
  for (const [name, exe, paths] of defs) {
    const reg = readAppPath(exe)
    for (const p of [reg, ...paths]) {
      if (!p) continue
      const k = p.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ name: name, path: p })
    }
  }
  return out
}

// ---- 无头启动验证（10s 超时）----
/**
 * 用 playwright-core 无头拉起候选浏览器做活体验证：开页面 →
 * data: URL 导航 → evaluate 求值，全通过才算可用（10s 超时兜底）。
 * 验证用的临时 user-data-dir 在 finally 中清理，不残留。
 */
function probeLaunch(pw, exe) {
  return new Promise((resolve) => {
    let ctxRef = null
    let udd = ''
    const timer = setTimeout(() => {
      logDebug('无头验证超时（10s）: ' + exe)
      resolve(false)
      try { if (ctxRef) ctxRef.close().catch(() => {}) } catch (err) {}
    }, 10000)
    ;(async () => {
      try {
        udd = path.join(os.tmpdir(), 'dsh-we-probe-' + process.pid + '-' + Date.now())
        const ctx = await pw.chromium.launchPersistentContext(udd, {
          executablePath: exe,
          headless: true,
        })
        ctxRef = ctx
        const page = ctx.pages()[0] || await ctx.newPage()
        await page.goto('data:text/html,<title>dsh-we-probe</title>', { timeout: 8000 })
        await page.evaluate('1+1')
        await ctx.close()
        clearTimeout(timer)
        resolve(true)
      } catch (err) {
        clearTimeout(timer)
        try { if (ctxRef) await ctxRef.close().catch(() => {}) } catch (e) {}
        logDebug('无头验证失败: ' + exe + ' · ' + String((err && err.message) || err))
        resolve(false)
      } finally {
        try { fs.rmSync(udd, { recursive: true, force: true }) } catch (e) {}
      }
    })()
  })
}

// ---- 主流程 ----
/**
 * 主流程：加载 playwright-core → 组装候选 → 缓存命中直接返回 →
 * 逐候选无头验证 → 首个可用者写入缓存并输出协议行。
 * 任一环节失败：stderr 输出原因并以 exit 1 终止（绝不下载浏览器）。
 */
async function main() {
  let pw
  try {
    pw = require('playwright-core')
  } catch (err) {
    logError('playwright-core 运行时未安装（应先在 ' + stateDir + '\\pw-node 完成安装）')
    process.exit(1)
  }

  const candidates = candidateList()
  if (listOnly) {
    for (const c of candidates) {
      process.stderr.write(c.name.padEnd(9) + ' | ' + (fs.existsSync(c.path) ? 'FOUND  ' : 'missing') + ' | ' + c.path + '\n')
    }
    process.exit(0)
  }
  logDebug('候选浏览器 ' + candidates.length + ' 个: ' + candidates.map((c) => c.path).join(' | '))

  // 缓存优先：上次探测成功且文件仍存在 → 直接返回（秒开，不再启动探测进程）
  const configFile = path.join(stateDir, 'browser-config.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (cfg && cfg.path && fs.existsSync(cfg.path)) {
      logInfo('缓存命中，跳过无头验证: ' + (cfg.name || 'Browser') + '（' + cfg.path + '）')
      console.log(JSON.stringify({ name: cfg.name || 'Browser', path: cfg.path, cached: true }))
      return
    }
  } catch (err) {
    logDebug('浏览器缓存不可用（首次或已损坏），重新探测')
  }

  const existing = candidates.filter((c) => fs.existsSync(c.path))
  if (existing.length === 0) {
    logError('未检测到任何已安装的浏览器。')
    logError('已检查: ' + (candidates.length ? candidates.map((c) => c.path).join(' | ') : '(无候选路径)'))
    logError('请安装 Chrome 或 Edge 后重试。本插件不会自动下载任何浏览器。')
    process.exit(1)
  }

  for (const c of existing) {
    const startedAt = Date.now()
    logInfo('验证 ' + c.name + ' … ' + c.path)
    const ok = await probeLaunch(pw, c.path)
    if (ok) {
      try {
        fs.writeFileSync(configFile, JSON.stringify({
          name: c.name, path: c.path, probedAt: new Date().toISOString(),
        }))
      } catch (err) {
        logWarn('浏览器缓存写入失败（下次启动需重新无头验证，可继续）')
      }
      logInfo(c.name + ' 无头验证通过（耗时 ' + (Date.now() - startedAt) + 'ms）')
      console.log(JSON.stringify({ name: c.name, path: c.path }))
      return
    }
    logWarn(c.name + ' 无法启动，尝试下一个…')
  }
  logError('所有检测到的浏览器都无法启动。已尝试: ' + existing.map((c) => c.path).join(' | '))
  process.exit(1)
}

main().catch((err) => {
  logError(String((err && err.stack) || (err && err.message) || err))
  process.exit(1)
})
