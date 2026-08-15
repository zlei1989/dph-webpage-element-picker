'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const base = 'http://127.0.0.1:' + String(process.argv[2] || '3080')

let mainWin = null
const popups = new Set()
let inspectorCode = ''
let openAttempt = 0
let lastInjectAt = 0
let autoInject = true

function postEvent(ev) {
  try {
    fetch(base + '/dsh-page-picker/events', {
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
      const res = await fetch(base + '/dsh-page-picker/poll', { signal: AbortSignal.timeout(30000) })
      const text = await res.text()
      if (text && text !== 'null') {
        let cmd
        try { cmd = JSON.parse(text) } catch (err) { cmd = null }
        if (cmd && cmd.id !== undefined) handle(cmd)
      }
      await sleep(250)
    } catch (err) {
      await sleep(500)
    }
  }
}

function safeExec(wc, code) {
  return wc.executeJavaScript(code).catch(() => undefined)
}

function inject(wc) {
  if (!wc || wc.isDestroyed()) return Promise.resolve(false)
  const now = Date.now()
  if (now - lastInjectAt < 400) return Promise.resolve(false)
  lastInjectAt = now
  return safeExec(wc, '(function () { try { if (typeof window.__dsh_pe_cleanup__ === "function") window.__dsh_pe_cleanup__() } catch (e) {} return true })()')
    .then(() => safeExec(wc, inspectorCode))
    .then(() => {
      if (wc && !wc.isDestroyed()) {
        postEvent({ type: 'injected', url: wc.getURL(), title: wc.getTitle() })
      }
      return true
    })
}

function trackWindow(win, isMain) {
  const wc = win.webContents

  wc.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:/i.test(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false,
              partition: 'persist:dsh-page-picker',
            },
          },
        }
      }
    } catch (err) {}
    return { action: 'deny' }
  })

  win.webContents.on('did-create-window', (childWin) => {
    trackWindow(childWin, false)
    popups.add(childWin)
  })

  wc.on('console-message', (_event, ...args) => {
    let message = ''
    if (args.length >= 2 && typeof args[1] === 'string') message = args[1]
    else if (args[0] && typeof args[0] === 'object' && args[0].message !== undefined) message = String(args[0].message)
    if (message.indexOf('__DSH_PE__:') === 0) {
      try {
        const data = JSON.parse(message.slice('__DSH_PE__:'.length))
        if (data && data.action === 'add-to-chat') {
          autoInject = false
          postEvent({ type: 'element-selected', data: data })
        } else if (data && data.action === 'exit-mode') {
          autoInject = false
          postEvent({ type: 'mode-exited', url: data.pageUrl, title: data.pageTitle })
        }
      } catch (err) {}
    }
  })

  const rehook = () => {
    if (!autoInject) return
    if (!wc || wc.isDestroyed()) return
    safeExec(wc, 'typeof window.__dsh_pe_active__ !== "undefined"')
      .then((active) => { if (active !== true) inject(wc) })
  }

  wc.on('dom-ready', () => {
    postEvent({ type: 'status', url: wc.getURL(), title: wc.getTitle() })
    rehook()
  })
  wc.on('did-finish-load', () => {
    postEvent({ type: 'status', url: wc.getURL(), title: wc.getTitle() })
    rehook()
  })
  wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    postEvent({ type: 'error', message: '页面加载失败 [' + code + '] ' + desc + ' ' + validatedURL })
  })

  win.on('closed', () => {
    if (isMain) {
      mainWin = null
      postEvent({ type: 'window-closed' })
    } else {
      popups.delete(win)
    }
  })
}

function handle(cmd) {
  const id = cmd.id
  const reply = (obj) => { postEvent(Object.assign({ type: 'reply', id: id }, obj)) }
  try {
    if (cmd.method === 'open') {
      const url = String((cmd.params && cmd.params.url) || '')
      if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
        return reply({ ok: false, error: 'invalid url: ' + url })
      }
      autoInject = true
      if (!mainWin || mainWin.isDestroyed()) {
        mainWin = new BrowserWindow({
          width: 1200,
          height: 820,
          title: 'DSH 页面元素选择',
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            partition: 'persist:dsh-page-picker',
          },
        })
        trackWindow(mainWin, true)
      }
      const wc = mainWin.webContents
      const attempt = ++openAttempt
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wc.removeListener('did-finish-load', onDone)
        wc.removeListener('did-fail-load', onFail)
        if (result.ok && wc && !wc.isDestroyed()) inject(wc)
        reply(result)
      }
      const onDone = () => { if (attempt === openAttempt) finish({ ok: true, status: { state: 'open', url: wc.getURL(), title: wc.getTitle() } }) }
      const onFail = (_e, code, desc) => {
        if (attempt === openAttempt) finish({ ok: false, error: '页面加载失败 [' + code + '] ' + desc })
      }
      wc.once('did-finish-load', onDone)
      wc.once('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
        if (!isMainFrame || code === -3) return
        onFail(_e, code, desc)
      })
      const timer = setTimeout(() => onDone(), 45000)
      wc.loadURL(url).catch((err) => {
        if (attempt === openAttempt) finish({ ok: false, error: String((err && err.message) || err) })
        else clearTimeout(timer)
      })
      return
    }
    if (cmd.method === 'reinject') {
      if (!mainWin || mainWin.isDestroyed()) return reply({ ok: false, error: 'no window' })
      autoInject = true
      inject(mainWin.webContents)
      reply({ ok: true, status: { state: 'open', url: mainWin.webContents.getURL(), title: mainWin.webContents.getTitle() } })
      return
    }
    if (cmd.method === 'status') {
      if (!mainWin || mainWin.isDestroyed()) return reply({ ok: true, status: { closed: true } })
      reply({ ok: true, status: { state: 'open', url: mainWin.webContents.getURL(), title: mainWin.webContents.getTitle() } })
      return
    }
    if (cmd.method === 'close') {
      if (mainWin && !mainWin.isDestroyed()) mainWin.close()
      for (const w of [...popups]) { if (w && !w.isDestroyed()) w.close() }
      reply({ ok: true })
      return
    }
    if (cmd.method === 'quit') {
      reply({ ok: true })
      setTimeout(() => app.quit(), 60)
      return
    }
    reply({ ok: false, error: 'unknown method: ' + cmd.method })
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err) })
  }
}

app.whenReady().then(() => {
  try {
    inspectorCode = fs.readFileSync(path.join(__dirname, 'inspector.js'), 'utf8')
  } catch (err) {
    postEvent({ type: 'error', message: 'inspector.js missing: ' + err.message })
  }
  postEvent({ type: 'helper-ready' })
  void pollCommands()
})

app.on('window-all-closed', () => { /* keep alive: protocol lives on HTTP polling */ })
