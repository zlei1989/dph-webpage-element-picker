'use strict'
const { spawn, execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')

const here = __dirname
const root = path.join(here, '..')
const npmCli = process.argv[2]
const out = { events: [], errors: [], exitCode: null }
const log = (m) => { console.log('[driver] ' + m) }

const payload =
  fs.readFileSync(path.join(root, 'helper-playwright.js'), 'utf8') +
  '\n<<<DSH_SPLIT>>>\n' +
  fs.readFileSync(path.join(root, 'inspector.js'), 'utf8') +
  '\n<<<DSH_END>>>\n'

// ---- 模拟 DSH host 插件侧：长轮询命令队列 + 事件捕获
const pendingCommands = []
const pollWaiters = []

const server = http.createServer((req, res) => {
  const pathname = (req.url || '').split('?')[0]
  if (pathname === '/dsh-webpage-element-picker/poll') {
    if (pendingCommands.length > 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(pendingCommands.shift()))
      return
    }
    let finished = false
    const finish = (cmd) => {
      if (finished) return
      finished = true
      clearTimeout(t)
      const idx = pollWaiters.indexOf(entry)
      if (idx >= 0) pollWaiters.splice(idx, 1)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(cmd === null ? 'null' : JSON.stringify(cmd))
    }
    const entry = { finish }
    pollWaiters.push(entry)
    const t = setTimeout(() => finish(null), 25000)
    req.on('close', () => finish(null))
    return
  }
  if (pathname === '/dsh-webpage-element-picker/events') {
    let body = ''
    req.on('data', (d) => { body += String(d) })
    req.on('end', () => {
      try {
        const msg = JSON.parse(body)
        out.events.push(msg.event)
        if (msg.event && msg.event.type === 'helper-ready') {
          log('helper-ready received, sending open command')
          sendCommand({ id: 1, method: 'open', params: { url: 'file:///' + path.join(here, 'test-page.html').replace(/\\/g, '/') } })
          setTimeout(() => {
            try {
              const w = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + path.join(here, 'check-windows.ps1') + '"', { encoding: 'utf8', windowsHide: true, timeout: 15000 })
              out.windows = String(w).trim()
            } catch (e) {
              out.windows = 'window check failed: ' + String(e.message)
            }
          }, 6000)
          setTimeout(() => { sendCommand({ id: 9, method: 'status', params: {} }) }, 9000)
          setTimeout(() => { sendCommand({ id: 10, method: 'reinject', params: {} }) }, 10000)
          setTimeout(() => {
            fs.writeFileSync(path.join(here, 'result.json'), JSON.stringify(out, null, 2))
            log('dumping result.json and killing tree')
            try { child.kill() } catch (e) {}
            server.close()
            setTimeout(() => process.exit(0), 500)
          }, 18000)
        }
      } catch (e) {
        out.errors.push('event parse fail: ' + body.slice(0, 200))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    return
  }
  res.writeHead(404)
  res.end()
})

function sendCommand(cmd) {
  if (pollWaiters.length > 0) {
    pollWaiters.shift().finish(cmd)
  } else {
    pendingCommands.push(cmd)
  }
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  log('mock DSH server on 127.0.0.1:' + port)
  log('spawning bootstrap with npm-cli: ' + npmCli)
  const child = spawn(process.execPath, [path.join(root, 'bootstrap.cjs'), npmCli, String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  let phase = 'wait-ready'
  child.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (!line) continue
      if (phase === 'wait-ready' && line === 'READY') {
        phase = 'live'
        log('READY received, sending payload')
        child.stdin.write(payload)
      } else if (phase === 'live') {
        out.errors.push('unexpected stdout line: ' + line.slice(0, 200))
      }
    }
  })
  child.stderr.on('data', (d) => {
    const s = String(d).slice(-500)
    out.errors.push('stderr: ' + s)
  })
  child.on('error', (err) => { out.errors.push('spawn error: ' + err.message) })
  child.on('exit', (code) => {
    out.exitCode = code
    fs.writeFileSync(path.join(here, 'result.json'), JSON.stringify(out, null, 2))
  })

  // 整体安全兜底：永不挂起（首次 npx 下载可能耗时数分钟）
  setTimeout(() => {
    fs.writeFileSync(path.join(here, 'result.json'), JSON.stringify(out, null, 2))
    log('SAFETY dump: helper never became ready, killing tree')
    try { child.kill() } catch (e) {}
    server.close()
    setTimeout(() => process.exit(0), 500)
  }, 300000)
})
