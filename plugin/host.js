return {
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      console.error('[page-picker] subprocess 服务不可用')
      return
    }
    const webServer = ctx.get('webServer')
    if (webServer === undefined) {
      console.error('[page-picker] webServer 服务不可用')
      return
    }
    const timer = ctx.get('timer')
    const policy = ctx.get('sandboxPolicy')
    const workspaceRoot = policy ? policy.workspaceRoot : undefined
    if (!workspaceRoot) {
      console.error('[page-picker] sandboxPolicy 服务不可用，无法定位工作区')
      return
    }

    let handle = null
    let starting = null
    let payloadSent = false
    let cmdSeq = 0
    const waiters = new Map()
    let lastSeq = 0
    let pending = []
    let status = { state: 'idle', message: '浏览器未启动' }
    let lineBuf = ''
    let lastBrowserName = ''

    let domCounter = 0
    let domRegistry = []

    // ---- 资源目录解析：支持把 resources/ 放到 DSH 家目录（~/.dsh 或 ~/.dph），工作区兜底 ----
    let homeProbePromise = null
    const discoverHome = () => {
      if (homeProbePromise) return homeProbePromise
      homeProbePromise = (async () => {
        try {
          const node = await subprocess.resolveExecutable('node')
          const probe = subprocess.spawn({
            argv: [node, '-e', "console.log(process.env.USERPROFILE || process.env.HOME || '')"],
            cwd: workspaceRoot,
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
            graceMs: 3000,
          })
          return await new Promise((resolve) => {
            let buf = ''
            let done = false
            const finish = (v) => { if (!done) { done = true; resolve(v) } }
            probe.stdout.on('data', (d) => {
              buf += String(d)
              const i = buf.indexOf('\n')
              if (i >= 0) finish(buf.slice(0, i).replace(/\r$/, '').trim())
            })
            probe.done.then(() => {
              if (buf.length === 0) finish('')
              else finish(buf.split('\n')[0].replace(/\r$/, '').trim())
            }, () => finish(''))
          })
        } catch (err) {
          return ''
        }
      })()
      return homeProbePromise
    }

    const resourceDirCandidates = async () => {
      const dirs = []
      const home = await discoverHome()
      if (home) {
        dirs.push(home + '/.dsh/_dsh-webpage-element-picker')
        dirs.push(home + '/.dph/_dsh-webpage-element-picker')
      }
      dirs.push(workspaceRoot + '/_dsh-webpage-element-picker')
      return dirs
    }

    const resolveResourceDir = async () => {
      const fs = ctx.get('fs')
      if (fs === undefined) throw new Error('fs 服务不可用')
      const needFiles = ['bootstrap.cjs', 'helper-playwright.js', 'inspector.js', 'browser-probe.cjs']
      const candidates = await resourceDirCandidates()
      for (const c of candidates) {
        let ok = true
        for (const name of needFiles) {
          try {
            const target = await fs.resolve(c + '/' + name)
            const info = await fs.stat(target)
            if (!info) { ok = false; break }
          } catch (err) { ok = false; break }
        }
        if (ok) return c
      }
      throw new Error('未找到页面元素选择器的资源目录（需要 4 个文件: ' + needFiles.join(' / ') + '；已尝试: ' + candidates.join(' | ') + '）')
    }

    const loadResources = async (resourceDir) => {
      const fs = ctx.get('fs')
      if (fs === undefined) throw new Error('fs 服务不可用')
      const readFile = async (name) => {
        const target = await fs.resolve(resourceDir + '/' + name)
        return await fs.readText(target)
      }
      return {
        helper: await readFile('helper-playwright.js'),
        inspector: await readFile('inspector.js'),
      }
    }

    const pollWaiters = []
    const commandQueue = []

    const sendCommand = (cmd) => {
      if (pollWaiters.length > 0) {
        pollWaiters.shift().finish(cmd)
        return
      }
      commandQueue.push(cmd)
      if (commandQueue.length > 100) commandQueue.splice(0, commandQueue.length - 100)
    }

    const buildSummary = () => {
      if (domRegistry.length === 0) return ''
      const lines = ['页面元素列表（用户消息中的 [DOMn] 占位符与下列编号一一对应）：']
      for (const e of domRegistry) {
        const p = e.payload || {}
        const parts = [String(p.tagName || '?')]
        if (p.id) parts.push('#' + p.id)
        if (p.textContent) parts.push('“' + String(p.textContent).slice(0, 40) + '”')
        lines.push(e.id + '=' + parts.join(' ') + ' (' + (p.pageUrl || '') + ')')
      }
      lines.push('需要某个元素的完整信息（HTML/CSS选择器/属性/位置尺寸）时，调用 read_picked_element 工具，参数如 {"id":"DOM1"}。')
      return lines.join('\n')
    }

    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt) {
      try {
        ctx.effect(() => systemPrompt.context({
          name: 'webpage-element-picker',
          order: 60,
          text: () => buildSummary(),
        }))
      } catch (err) {
        console.error('[page-picker] 系统提示上下文注册失败: ' + String((err && err.message) || err))
      }
    }

    try {
      ctx.effect(() => harness.registerTool(ctx, harness.defineTool({
        name: 'read_picked_element',
        description: '读取「添加页面元素」功能从内置浏览器中选中的页面元素完整信息（HTML、CSS选择器、DOM路径、属性、位置尺寸、页面URL等）。系统提示中的页面元素列表给出了可用的 DOM 编号，用户消息中的 [DOMn] 占位符与之一一对应；需要元素细节时按编号读取。',
        parameters: {
          id: { type: 'string', required: true, description: 'DOM 编号，如 DOM1（见系统提示中的页面元素列表）' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          const id = String((args && args.id) || '')
          const entry = domRegistry.find((e) => e.id === id)
          if (!entry) {
            return { ok: false, error: '未找到元素 ' + id + '，可用编号: ' + domRegistry.map((e) => e.id).join(', ') }
          }
          return { ok: true, id: entry.id, element: entry.payload }
        },
      })))
    } catch (err) {
      console.error('[page-picker] 工具注册失败: ' + String((err && err.message) || err))
    }

    const handleEvent = (ev) => {
      if (!ev || typeof ev.type !== 'string') return
      if (ev.type === 'reply') {
        const w = waiters.get(ev.id)
        if (w) {
          waiters.delete(ev.id)
          if (ev.ok) w.resolve(ev)
          else w.reject(new Error(ev.error || '内置浏览器返回错误'))
        }
        return
      }
      if (ev.type === 'element-selected') {
        domCounter += 1
        const domId = 'DOM' + domCounter
        domRegistry.push({ id: domId, payload: ev.data || {} })
        if (domRegistry.length > 200) domRegistry = domRegistry.slice(-200)
        pending.push({ seq: ++lastSeq, domId: domId, payload: ev.data || {} })
        if (pending.length > 100) pending = pending.slice(-100)
        return
      }
      if (ev.type === 'browser') { lastBrowserName = ev.name || '浏览器'; status = { state: 'starting', message: '正在启动 ' + lastBrowserName + '…', browser: lastBrowserName }; return }
      if (ev.type === 'status') { status = { state: 'open', url: ev.url, title: ev.title, browser: lastBrowserName }; return }
      if (ev.type === 'injected') { status = { state: 'open', url: ev.url, title: ev.title, injected: true, browser: lastBrowserName }; return }
      if (ev.type === 'mode-exited') { status = { state: 'open', url: ev.url, title: ev.title, modeExited: true, browser: lastBrowserName }; return }
      if (ev.type === 'window-closed') { status = { state: 'closed', message: '浏览器窗口已关闭，可重新点击打开按钮打开' }; return }
      if (ev.type === 'helper-ready') { status = { state: 'ready', message: '浏览器已就绪' + (lastBrowserName ? '（' + lastBrowserName + '）' : ''), browser: lastBrowserName }; return }
      if (ev.type === 'error') {
        console.error('[page-picker] 浏览器错误: ' + ev.message)
        status = { state: 'error', message: ev.message }
        return
      }
    }

    ctx.effect(() => {
      const disposers = []
      try {
        disposers.push(webServer.register({
          kind: 'exact',
          path: '/dsh-webpage-element-picker/poll',
          handler: (req, res) => {
            if (commandQueue.length > 0) {
              const cmd = commandQueue.shift()
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(cmd))
              return
            }
            let finished = false
            let timeoutDisposer = null
            const entry = {
              finish: (cmd) => {
                if (finished) return
                finished = true
                if (timeoutDisposer) timeoutDisposer()
                const idx = pollWaiters.indexOf(entry)
                if (idx >= 0) pollWaiters.splice(idx, 1)
                try {
                  res.writeHead(200, { 'Content-Type': 'application/json' })
                  res.end(cmd === null ? 'null' : JSON.stringify(cmd))
                } catch (err) {}
              },
            }
            if (timer) timeoutDisposer = timer.timeout(() => entry.finish(null), 25000)
            pollWaiters.push(entry)
            req.on('close', () => entry.finish(null))
          },
        }))
        disposers.push(webServer.register({
          kind: 'exact',
          path: '/dsh-webpage-element-picker/events',
          handler: (req, res) => {
            let body = ''
            let overflow = false
            req.on('data', (d) => {
              if (overflow) return
              body += String(d)
              if (body.length > 1000000) { overflow = true; body = '' }
            })
            req.on('end', () => {
              if (!overflow) {
                let msg = null
                try { msg = JSON.parse(body || '{}') } catch (err) {}
                if (msg && msg.event) handleEvent(msg.event)
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end('{}')
            })
          },
        }))
      } catch (err) {
        console.error('[page-picker] 路由注册失败（可能被本插件的另一个实例占用）: ' + String((err && err.message) || err))
      }
      return () => {
        for (const d of disposers) {
          try { d() } catch (err) {}
        }
      }
    })

    const readStdout = async (boot, payloadText) => {
      try {
        if (!boot || !boot.stdout) return
        for await (const chunk of boot.stdout) {
          lineBuf += String(chunk)
          let i
          while ((i = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, i).replace(/\r$/, '')
            lineBuf = lineBuf.slice(i + 1)
            if (!line) continue
            if (!payloadSent && line === 'READY') {
              payloadSent = true
              try { boot.stdin.write(payloadText) } catch (err) {
                console.error('[page-picker] 发送资源文件失败: ' + String((err && err.message) || err))
              }
            }
          }
        }
      } catch (err) {}
    }

    const stderrTail = (boot) => {
      try {
        const c = boot.collected && boot.collected.stderr
        if (!c) return ''
        const read = c.readFrom(0)
        const lines = String(read.text || '').split('\n').map((s) => s.trim()).filter(Boolean)
        return lines.length ? lines[lines.length - 1].slice(0, 300) : ''
      } catch (err) {
        return ''
      }
    }

    const ensureHelper = async () => {
      if (handle !== null) return handle
      if (starting) return starting
      starting = (async () => {
        try {
          const resourceDir = await resolveResourceDir()
          const res = await loadResources(resourceDir)
          const payloadText = res.helper + '\n<<<DSH_SPLIT>>>\n' + res.inspector + '\n<<<DSH_END>>>\n'
          const node = await subprocess.resolveExecutable('node')
          // npm 安装 playwright-core 运行时（首次数秒，无浏览器下载）后启动系统浏览器；
          // 使用 npm-cli.js 脚本入口而不是 npm.cmd，避免 Windows 下 spawn .cmd 的限制
          const npmCli = node.replace(/[^\\/]+$/, 'node_modules/npm/bin/npm-cli.js')
          let launcher = null
          try {
            await subprocess.resolveExecutable(npmCli)
            launcher = npmCli
          } catch (err) {}
          if (!launcher) throw new Error('未找到 npm 的脚本入口（' + npmCli + '），请确认 Node.js 安装完整')
          const port = (typeof webServer.port === 'number' && webServer.port > 0) ? webServer.port : 0
          if (port === 0) throw new Error('DSH web 服务器端口不可用')
          const boot = subprocess.spawn({
            argv: [node, resourceDir + '/bootstrap.cjs', launcher, String(port)],
            cwd: workspaceRoot,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
            graceMs: 3000,
          })
          handle = boot
          payloadSent = false
          lineBuf = ''
          boot.done.then((outcome) => {
            if (handle === boot) {
              handle = null
              const tail = stderrTail(boot)
              status = { state: 'closed', message: '浏览器进程已退出 (code ' + outcome.exitCode + ')' + (tail ? ' · ' + tail : '') }
              for (const [id, w] of Array.from(waiters)) {
                waiters.delete(id)
                w.reject(new Error('浏览器进程已退出'))
              }
            }
          }, () => {})
          readStdout(boot, payloadText)
          return boot
        } catch (err) {
          status = { state: 'error', message: String((err && err.message) || err) }
          throw err
        } finally {
          starting = null
        }
      })()
      return starting
    }

    const request = (method, params, timeoutMs) => {
      const id = ++cmdSeq
      return new Promise((resolve, reject) => {
        if (handle === null) {
          reject(new Error('浏览器未运行'))
          return
        }
        waiters.set(id, { resolve: resolve, reject: reject })
        sendCommand({ id: id, method: method, params: params || {} })
        if (timer) {
          timer.timeout(() => {
            const w = waiters.get(id)
            if (w) {
              waiters.delete(id)
              w.reject(new Error(method + ' 超时'))
            }
          }, timeoutMs || 60000)
        }
      })
    }

    ctx.effect(() => harness.handle('picker-navigate', async (args) => {
      const url = String((args && args.url) || '')
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: '网址需以 http:// 或 https:// 开头' }
      try {
        await ensureHelper()
        // 首次使用需安装 playwright-core 运行时 + 探测系统浏览器（约 10-30 秒），放宽超时
        const r = await request('open', { url: url }, 120000)
        return (r && r.ok)
          ? { ok: true, status: Object.assign({ state: 'open' }, r.status || { url: url }) }
          : { ok: false, error: (r && r.error) || '打开失败' }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    }))

    ctx.effect(() => harness.handle('picker-reinject', async () => {
      try {
        await ensureHelper()
        const r = await request('reinject', {}, 15000)
        return (r && r.ok)
          ? { ok: true, status: Object.assign({ state: 'open' }, r.status || {}) }
          : { ok: false, error: (r && r.error) || '重新注入失败' }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    }))

    ctx.effect(() => harness.handle('picker-status', async () => {
      if (handle === null) return { ok: true, status: status }
      try {
        const r = await request('status', {}, 8000)
        return (r && r.ok) ? { ok: true, status: r.status } : { ok: true, status: status }
      } catch (err) {
        return { ok: true, status: status }
      }
    }))

    ctx.effect(() => harness.handle('picker-close', async () => {
      if (handle !== null) {
        try { await request('close', {}, 5000) } catch (err) {}
      }
      status = { state: 'closed', message: '浏览器窗口已关闭' }
      return { ok: true, status: status }
    }))

    ctx.effect(() => harness.handle('picker-pull', async (args) => {
      const after = Number((args && args.afterSeq) || 0)
      const elements = pending
        .filter((e) => e.seq > after)
        .map((e) => ({ seq: e.seq, domId: e.domId, payload: e.payload }))
      return { ok: true, elements: elements, status: status }
    }))

    ctx.effect(() => () => {
      if (handle) {
        try {
          if (handle.stdin) handle.stdin.end()
        } catch (err) {}
        handle.terminate()
        handle = null
      }
    })
  },
}
