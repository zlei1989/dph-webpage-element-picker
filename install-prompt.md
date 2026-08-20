# 安装指令（粘贴给 DSH 会话的 agent）

前置：把本仓库 `resources/` 下的四个文件（bootstrap.cjs、helper-playwright.js、inspector.js、browser-probe.cjs）放到以下任意一个目录（插件按顺序查找，命中即用；browser-probe.cjs 负责探测系统已安装浏览器，绝不下载）：
  1. `~/.dsh/_dsh-webpage-element-picker/`（DSH 家目录，默认）
  2. `~/.dph/_dsh-webpage-element-picker/`
  3. `<DSH 工作区>/_dsh-webpage-element-picker/`（兜底）

然后在 DSH 网页 GUI 中新建一个 `cordis` 预设的会话，把下面整段内容发给 agent：

---- 从这里开始复制 ----
请帮我定义并运行「页面元素选择」插件。定义用 cordis_define（kind: new，idPrefix 自选如 pagep），之后用 run 模式激活。激活后如果出现审批卡请允许。
Host 代码开始：
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
Host 代码结束
Client 代码开始：
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const timer = ctx.get('timer')
    const el = React.createElement

    styles.insert(
      '.dsh-we-icon-btn { background: transparent; border: none; color: #9a9aa6; padding: 5px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }' +
      '.dsh-we-icon-btn:hover { background: rgba(255,255,255,0.08); color: #d8d8e0; }' +
      '.dsh-we-icon-btn:disabled { opacity: 0.5; cursor: default; }'
    )

    const shortText = (s) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim()
      if (!t) return ''
      return t.length > 10 ? t.slice(0, 10) + '…' : t
    }

    const labelOf = (p) => {
      if (p.textContent) return shortText(p.textContent)
      const attrs = p.attributes || {}
      const keys = ['aria-label', 'placeholder', 'alt', 'title', 'value']
      for (const k of keys) {
        if (attrs[k]) return shortText(attrs[k])
      }
      const tag = String(p.tagName || '?')
      if (p.id) return tag + '#' + p.id
      const cls = String(p.className || '').trim().split(/\s+/).slice(0, 2).join('.')
      if (cls) return tag + '.' + cls
      return tag
    }

    const placeholderLine = (item) => {
      const p = item.payload || {}
      const id = item.domId || 'DOM'
      const label = labelOf(p)
      if (!label || label === '?') return '[' + id + ']'
      return '[' + label + '][' + id + ']'
    }

    const S = {
      backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      panel: { width: 560, maxWidth: '92vw', background: '#1b1b22', border: '1px solid #34343e', borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #2a2a33' },
      title: { color: '#e6e6eb', fontSize: 14, fontWeight: 600 },
      closeBtn: { background: 'none', border: 'none', color: '#8b8b96', fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
      body: { padding: 16, display: 'flex', flexDirection: 'column', gap: 10 },
      textarea: { width: '100%', boxSizing: 'border-box', background: '#121218', color: '#e6e6eb', border: '1px solid #34343e', borderRadius: 8, padding: 10, fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', minHeight: 84, lineHeight: 1.5 },
      statusLine: { color: '#9fd0ff', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      notice: { color: '#f5c56b', fontSize: 12 },
      hint: { color: '#8b8b96', fontSize: 11, lineHeight: 1.6 },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid #2a2a33' },
      ghostBtn: { background: 'transparent', color: '#c9c9d1', border: '1px solid #34343e', borderRadius: 8, padding: '6px 14px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
      primaryBtn: { background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 16px', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
    }

    const crosshairIcon = el('svg', {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round',
    },
      el('circle', { cx: 12, cy: 12, r: 7 }),
      el('line', { x1: 12, y1: 2, x2: 12, y2: 6 }),
      el('line', { x1: 12, y1: 18, x2: 12, y2: 22 }),
      el('line', { x1: 2, y1: 12, x2: 6, y2: 12 }),
      el('line', { x1: 18, y1: 12, x2: 22, y2: 12 }),
    )

    function PickerEntry(props) {
      const input = props.useInput ? props.useInput((s) => s) : { draft: '' }
      const [st] = React.useState(() => ({ afterSeq: 0, draft: '' }))
      st.draft = input.draft

      const [open, setOpen] = React.useState(false)
      const [urlText, setUrlText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [notice, setNotice] = React.useState('')
      const statusState = status ? status.state : null

      const showNotice = (text) => {
        setNotice(text)
        if (timer) timer.timeout(() => setNotice((cur) => (cur === text ? '' : cur)), 5000)
      }

      const insertElements = (elements) => {
        let draft = st.draft
        for (const item of elements) {
          draft += (draft ? '\n' : '') + placeholderLine(item)
        }
        if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
          props.inputActions.setDraft(draft)
        }
        st.draft = draft
        if (elements.length) st.afterSeq = elements[elements.length - 1].seq
      }

      React.useEffect(() => {
        if (!open && statusState !== 'open') return
        let cancelled = false
        const poll = async () => {
          try {
            const res = await host.call('picker-pull', { afterSeq: st.afterSeq })
            if (cancelled || !res) return
            if (res.status) setStatus(res.status)
            const elements = res.elements || []
            if (elements.length) {
              insertElements(elements)
              if (open) showNotice('已添加 ' + elements.length + ' 个页面元素到输入框')
            }
          } catch (err) {
            // 内置浏览器尚未就绪，继续轮询
          }
        }
        poll()
        let stop = null
        if (timer) stop = timer.interval(poll, 1500)
        return () => {
          cancelled = true
          if (stop) stop()
        }
      }, [open, statusState])

      const onConfirm = async () => {
        const url = String(urlText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
        if (!url) { showNotice('请先输入网址'); return }
        if (!/^https?:\/\//i.test(url)) { showNotice('网址需以 http:// 或 https:// 开头'); return }
        setBusy(true)
        try {
          const res = await host.call('picker-navigate', { url: url })
          if (res && res.ok) {
            setStatus(Object.assign({ state: 'open' }, res.status || { url: url }))
            setOpen(false)
          } else {
            showNotice('打开失败：' + ((res && res.error) || '未知错误'))
          }
        } catch (err) {
          showNotice('打开失败：' + String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }

      const onReinject = async () => {
        setBusy(true)
        try {
          const res = await host.call('picker-reinject', {})
          if (res && res.ok) {
            setStatus(Object.assign({ state: 'open' }, res.status || status))
            showNotice('已重新注入选择功能')
          } else {
            showNotice('重新注入失败：' + ((res && res.error) || '未知错误'))
          }
        } catch (err) {
          showNotice('重新注入失败：' + String((err && err.message) || err))
        } finally {
          setBusy(false)
        }
      }

      const browserLabel = status && status.browser ? '浏览器: ' + status.browser + ' · ' : ''
      const tooltip = status
        ? (status.message ||
            (status.state === 'open'
              ? browserLabel + '已打开: ' + (status.title || status.url || '') +
                (status.modeExited ? ' · 选择模式已退出（点击图标可重新打开）' : (status.injected ? ' · 已注入选择功能' : ''))
              : ''))
        : ''
      const buttonTitle = tooltip || '打开浏览器并选择页面元素'

      const renderDialog = () => el('div', {
        style: S.backdrop,
        onMouseDown: (e) => { if (e.target === e.currentTarget) setOpen(false) },
      },
        el('div', { style: S.panel },
          el('div', { style: S.header },
            el('div', { style: S.title }, '添加页面元素'),
            el('button', { onClick: () => setOpen(false), style: S.closeBtn }, '×'),
          ),
          el('div', { style: S.body },
            el('textarea', {
              value: urlText,
              onChange: (e) => setUrlText(e.target.value),
              rows: 4,
              placeholder: '输入网址（每行一个，使用第一行），例如：\nhttps://example.com',
              style: S.textarea,
            }),
            status ? el('div', { style: S.statusLine },
              '状态：' + (status.message ||
                (status.state === 'open' ? browserLabel + '已打开 ' + (status.url || '') +
                  (status.modeExited ? ' · 选择模式已退出' : (status.injected ? ' · 已注入选择功能' : '')) :
                  status.state === 'ready' ? '浏览器已就绪' : status.state))
            ) : null,
            notice ? el('div', { style: S.notice }, notice) : null,
            el('div', { style: S.hint },
              '提示：页面中点击元素后点「添加到对话」即可在输入框中插入 [标签][DOMn] 引用式占位符；完整元素信息由模型按需通过 read_picked_element 工具读取。浏览器使用系统已安装的 Chrome/Edge 等（自动探测，绝不下载），首次打开需安装约 13MB 运行时并探测浏览器，之后秒开。登录页面时先点击页面右下角「选择模式」暂停，登录完成后回到这里再次点击「打开」，即可重新打开页面并注入选择功能。'
            ),
          ),
          el('div', { style: S.footer },
            el('button', { onClick: () => setOpen(false), style: S.ghostBtn }, '关闭'),
            el('button', { onClick: onReinject, disabled: busy, style: S.ghostBtn }, '仅重新注入'),
            el('button', { onClick: onConfirm, disabled: busy, style: S.primaryBtn }, busy ? '打开中…' : '打开'),
          ),
        ),
      )

      return el(React.Fragment, null,
        el('button', {
          className: 'dsh-we-icon-btn',
          onClick: () => { setOpen(true); setNotice('') },
          title: buttonTitle,
          'aria-label': '添加页面元素',
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
        }, crosshairIcon),
        open ? renderDialog() : null,
      )
    }

    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'dsh-webpage-element-picker', order: 0 },
      (props) => el(PickerEntry, props),
    ))
  },
}
Client 代码结束
---- 复制到这里结束 ----

完成标准：输入框工具行出现十字图标；图标 tooltip 显示「打开浏览器并选择页面元素」。
