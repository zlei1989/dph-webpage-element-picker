'use strict'
// 探测系统已安装的 Chromium 系浏览器（优先级：Chrome > Edge > Chromium > Brave > Opera）
// 用法: node browser-probe.cjs <stateDir> [--list]
//   成功: stdout 输出一行 JSON { name, path, cached? }，exit 0
//   失败: stderr 输出原因，exit 1
// 绝不下载任何浏览器：只用 playwright-core 启动"已存在"的可执行文件做无头验证。
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const stateDir = process.argv[2]
const listOnly = process.argv.includes('--list')

// ---- 注册表 App Paths 查询（只读 reg.exe query）----
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
    } catch (err) {}
  }
  return null
}

// ---- 候选浏览器清单（注册表 + 常见安装目录，去重）----
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
function probeLaunch(pw, exe) {
  return new Promise((resolve) => {
    let ctxRef = null
    let udd = ''
    const timer = setTimeout(() => {
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
        resolve(false)
      } finally {
        try { fs.rmSync(udd, { recursive: true, force: true }) } catch (e) {}
      }
    })()
  })
}

// ---- 主流程 ----
async function main() {
  let pw
  try {
    pw = require('playwright-core')
  } catch (err) {
    console.error('probe: playwright-core 运行时未安装（应先在 ' + stateDir + '\\pw-node 完成安装）')
    process.exit(1)
  }

  const candidates = candidateList()
  if (listOnly) {
    for (const c of candidates) {
      console.error(c.name.padEnd(9) + ' | ' + (fs.existsSync(c.path) ? 'FOUND  ' : 'missing') + ' | ' + c.path)
    }
    process.exit(0)
  }

  // 缓存优先：上次探测成功且文件仍存在 → 直接返回（秒开，不再启动探测进程）
  const configFile = path.join(stateDir, 'browser-config.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (cfg && cfg.path && fs.existsSync(cfg.path)) {
      console.log(JSON.stringify({ name: cfg.name || 'Browser', path: cfg.path, cached: true }))
      return
    }
  } catch (err) {}

  const existing = candidates.filter((c) => fs.existsSync(c.path))
  if (existing.length === 0) {
    console.error('probe: 未检测到任何已安装的浏览器。')
    console.error('probe: 已检查: ' + (candidates.length ? candidates.map((c) => c.path).join(' | ') : '(无候选路径)'))
    console.error('probe: 请安装 Chrome 或 Edge 后重试。本插件不会自动下载任何浏览器。')
    process.exit(1)
  }

  for (const c of existing) {
    console.error('probe: 验证 ' + c.name + ' … ' + c.path)
    const ok = await probeLaunch(pw, c.path)
    if (ok) {
      try {
        fs.writeFileSync(configFile, JSON.stringify({
          name: c.name, path: c.path, probedAt: new Date().toISOString(),
        }))
      } catch (err) {}
      console.log(JSON.stringify({ name: c.name, path: c.path }))
      return
    }
    console.error('probe: ' + c.name + ' 无法启动，尝试下一个…')
  }
  console.error('probe: 所有检测到的浏览器都无法启动。已尝试: ' + existing.map((c) => c.path).join(' | '))
  process.exit(1)
}

main().catch((err) => {
  console.error('probe: ' + String((err && err.message) || err))
  process.exit(1)
})
