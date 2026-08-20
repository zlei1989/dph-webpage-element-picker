/**
 * dsh-webpage-element-picker — Host 半边（已安装包入口）。
 *
 * 一个普通的 Cordis 插件模块（ESM），由 profile loader 作为
 * `dsh-webpage-element-picker` 行加载。它提供：
 *   - `read_picked_element` 工具（通过 ctx.tools.register）
 *   - 每元素一行的动态上下文段（ctx.systemPrompt.context）
 *   - harness webserver 上的 HTTP 路由：/poll + /events 供内嵌浏览器
 *     helper 使用，/invoke 供浏览器 UI 使用
 *   - helper 子进程生命周期（node bootstrap.cjs + playwright-core）
 *
 * 模块级 `inject` 是唯一的门控：Cordis 会保持此插件 PENDING 状态，
 * 直到下方所有 provider 都 ACTIVE——没有它的话，`apply` 会在 profile
 * 加载时与服务纤程竞态，`ctx.get(...)`（严格模式）会返回 undefined。
 * 全部七个服务随 web profile 出货（@deepseek-ai/dsh-base
 * + @deepseek-ai/dsh-web-app）。切勿添加 `export default apply`：Loader 的
 * unwrapExports（`exports.default ?? exports`）会把模块坍缩为裸函数并
 * 丢弃 inject。
 *
 * 资源（bootstrap.cjs / helper-playwright.js / inspector.js /
 * browser-probe.cjs）优先按包内路径解析，同时保留旧版
 * `~/.dsh/_dsh-webpage-element-picker` 和工作区兜底路径以增强健壮性。
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {
  FsFace,
  SandboxPolicyFace,
  SubprocessFace,
  SubprocessHandleLike,
  SystemPromptFace,
  TimerFace,
  ToolsFace,
  WebServerFace,
} from './services'
import type {
  DomElementPayload,
  DomRegistryEntry,
  HelperEvent,
  InvokeResult,
  PendingElement,
  PickerStatus,
} from '../shared/types'

export const name = 'dsh-webpage-element-picker'

/** 必需服务：Cordis 会保持此纤程挂起，直到所有服务激活。 */
export const inject = ['subprocess', 'webServer', 'sandboxPolicy', 'fs', 'tools', 'systemPrompt', 'timer']

/** 挂在 /poll 上的长轮询等待者，直到有命令入队或超时。 */
interface PollWaiter {
  finish(cmd: unknown): void
}

/** 等待其 reply 事件的待处理 helper 请求。 */
interface RequestWaiter {
  resolve(ev: { ok: boolean; status?: PickerStatus; error?: string }): void
  reject(err: Error): void
}

type Handler = (params: Record<string, unknown>) => Promise<InvokeResult>

export function apply(ctx: Context): void {
  const subprocess = ctx.get('subprocess') as SubprocessFace
  const webServer = ctx.get('webServer') as WebServerFace
  const timer = ctx.get('timer') as TimerFace
  const fs = ctx.get('fs') as FsFace
  const tools = ctx.get('tools') as ToolsFace
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptFace
  const workspaceRoot = (ctx.get('sandboxPolicy') as SandboxPolicyFace).workspaceRoot as string

  let handle: SubprocessHandleLike | null = null
  let starting: Promise<SubprocessHandleLike> | null = null
  let payloadSent = false
  let cmdSeq = 0
  const waiters = new Map<number, RequestWaiter>()
  let lastSeq = 0
  let pending: PendingElement[] = []
  let status: PickerStatus = { state: 'idle', message: '浏览器未启动' }
  let lineBuf = ''
  let lastBrowserName = ''

  let domCounter = 0
  let domRegistry: DomRegistryEntry[] = []

  // ---- 资源目录解析：包内 resources/ 优先（bundle 形态），家目录/工作区兜底 ----
  const pkgResourceDir = ((): string => {
    try {
      return fileURLToPath(new URL('../resources/', import.meta.url))
    } catch {
      return ''
    }
  })()
  let homeProbePromise: Promise<string> | null = null
  const discoverHome = (): Promise<string> => {
    if (homeProbePromise) return homeProbePromise
    homeProbePromise = (async (): Promise<string> => {
      try {
        const node = await subprocess.resolveExecutable('node')
        const probe = subprocess.spawn({
          argv: [node, '-e', "console.log(process.env.USERPROFILE || process.env.HOME || '')"],
          cwd: workspaceRoot,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
          graceMs: 3000,
        })
        return await new Promise<string>((resolve) => {
          let buf = ''
          let done = false
          const finish = (v: string): void => {
            if (!done) {
              done = true
              resolve(v)
            }
          }
          ;(async () => {
            for await (const chunk of probe.stdout) {
              buf += String(chunk)
              const i = buf.indexOf('\n')
              if (i >= 0) {
                finish(buf.slice(0, i).replace(/\r$/, '').trim())
                break
              }
            }
          })().catch(() => finish(''))
          probe.done.then(
            () => {
              if (buf.length === 0) finish('')
              else finish(buf.split('\n')[0].replace(/\r$/, '').trim())
            },
            () => finish(''),
          )
        })
      } catch {
        return ''
      }
    })()
    return homeProbePromise
  }

  const resourceDirCandidates = async (): Promise<string[]> => {
    const dirs: string[] = []
    if (pkgResourceDir) dirs.push(pkgResourceDir)
    const home = await discoverHome()
    if (home) {
      dirs.push(home + '/.dsh/_dsh-webpage-element-picker')
      dirs.push(home + '/.dph/_dsh-webpage-element-picker')
    }
    dirs.push(workspaceRoot + '/_dsh-webpage-element-picker')
    return dirs
  }

  const resolveResourceDir = async (): Promise<string> => {
    const needFiles = ['bootstrap.cjs', 'helper-playwright.js', 'inspector.js', 'browser-probe.cjs']
    const candidates = await resourceDirCandidates()
    for (const c of candidates) {
      let ok = true
      for (const name of needFiles) {
        try {
          const target = await fs.resolve(c + '/' + name)
          const info = await fs.stat(target)
          if (!info) {
            ok = false
            break
          }
        } catch {
          ok = false
          break
        }
      }
      if (ok) return c
    }
    throw new Error(
      '未找到页面元素选择器的资源目录（需要 4 个文件: ' + needFiles.join(' / ') + '；已尝试: ' + candidates.join(' | ') + '）',
    )
  }

  const loadResources = async (resourceDir: string): Promise<{ helper: string; inspector: string }> => {
    const readFile = async (name: string): Promise<string> => {
      const target = await fs.resolve(resourceDir + '/' + name)
      return await fs.readText(target)
    }
    return {
      helper: await readFile('helper-playwright.js'),
      inspector: await readFile('inspector.js'),
    }
  }

  const pollWaiters: PollWaiter[] = []
  const commandQueue: unknown[] = []

  const sendCommand = (cmd: unknown): void => {
    if (pollWaiters.length > 0) {
      pollWaiters.shift()!.finish(cmd)
      return
    }
    commandQueue.push(cmd)
    if (commandQueue.length > 100) commandQueue.splice(0, commandQueue.length - 100)
  }

  const buildSummary = (): string => {
    if (domRegistry.length === 0) return ''
    const lines = ['页面元素列表（用户消息中的 [DOMn] 占位符与下列编号一一对应）：']
    for (const e of domRegistry) {
      const p = e.payload || {}
      const parts = [String(p.tagName || '?')]
      if (p.id) parts.push('#' + p.id)
      if (p.textContent) parts.push('“' + String(p.textContent).slice(0, 40) + '”')
      lines.push(e.id + '=' + parts.join(' ') + ' (' + (p.pageUrl || '') + ')')
    }
    lines.push(
      '需要某个元素的完整信息（HTML/CSS选择器/属性/位置尺寸）时，调用 read_picked_element 工具，参数如 {"id":"DOM1"}。',
    )
    return lines.join('\n')
  }

  try {
    ctx.effect(() => systemPrompt.context({
      name: 'webpage-element-picker',
      order: 60,
      text: () => buildSummary(),
    }))
  } catch (err) {
    console.error('[dsh-webpage-element-picker] 系统提示上下文注册失败: ' + String((err && (err as Error).message) || err))
  }

  try {
    ctx.effect(() => tools.register({
      name: 'read_picked_element',
      description:
        '读取「添加页面元素」功能从内置浏览器中选中的页面元素完整信息（HTML、CSS选择器、DOM路径、属性、位置尺寸、页面URL等）。系统提示中的页面元素列表给出了可用的 DOM 编号，用户消息中的 [DOMn] 占位符与之一一对应；需要元素细节时按编号读取。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'DOM 编号，如 DOM1（见系统提示中的页面元素列表）' },
        },
        required: ['id'],
      },
      output: {
        schema: {},
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args: unknown): Promise<unknown> {
        const id = String((args && (args as { id?: unknown }).id) || '')
        if (!id) throw new Error('read_picked_element 需要参数 id（如 DOM1）')
        const entry = domRegistry.find((e) => e.id === id)
        if (!entry) {
          return { ok: false, error: '未找到元素 ' + id + '，可用编号: ' + domRegistry.map((e) => e.id).join(', ') }
        }
        return { ok: true, id: entry.id, element: entry.payload }
      },
    }))
  } catch (err) {
    console.error('[dsh-webpage-element-picker] 工具注册失败: ' + String((err && (err as Error).message) || err))
  }

  const handleEvent = (ev: HelperEvent): void => {
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
    if (ev.type === 'browser') {
      lastBrowserName = ev.name || '浏览器'
      status = { state: 'starting', message: '正在启动 ' + lastBrowserName + '…', browser: lastBrowserName }
      return
    }
    if (ev.type === 'status') {
      status = { state: 'open', url: ev.url, title: ev.title, browser: lastBrowserName }
      return
    }
    if (ev.type === 'injected') {
      status = { state: 'open', url: ev.url, title: ev.title, injected: true, browser: lastBrowserName }
      return
    }
    if (ev.type === 'mode-exited') {
      status = { state: 'open', url: ev.url, title: ev.title, modeExited: true, browser: lastBrowserName }
      return
    }
    if (ev.type === 'window-closed') {
      status = { state: 'closed', message: '浏览器窗口已关闭，可重新点击打开按钮打开' }
      return
    }
    if (ev.type === 'helper-ready') {
      status = { state: 'ready', message: '浏览器已就绪' + (lastBrowserName ? '（' + lastBrowserName + '）' : ''), browser: lastBrowserName }
      return
    }
    if (ev.type === 'error') {
      console.error('[dsh-webpage-element-picker] 浏览器错误: ' + ev.message)
      status = { state: 'error', message: ev.message }
      return
    }
  }

  // 浏览器 UI 侧可调用的方法（POST /invoke 分发）。
  const handlers = new Map<string, Handler>()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
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
          let timeoutDisposer: (() => void) | null = null
          const entry: PollWaiter = {
            finish: (cmd) => {
              if (finished) return
              finished = true
              if (timeoutDisposer) timeoutDisposer()
              const idx = pollWaiters.indexOf(entry)
              if (idx >= 0) pollWaiters.splice(idx, 1)
              try {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(cmd === null ? 'null' : JSON.stringify(cmd))
              } catch {
                // 响应已关闭
              }
            },
          }
          timeoutDisposer = timer.timeout(() => entry.finish(null), 25000)
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
            if (body.length > 1000000) {
              overflow = true
              body = ''
            }
          })
          req.on('end', () => {
            if (!overflow) {
              let msg: { event?: HelperEvent } | null = null
              try {
                msg = JSON.parse(body || '{}')
              } catch {
                // 忽略格式错误的载荷
              }
              if (msg && msg.event) handleEvent(msg.event)
            }
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{}')
          })
        },
      }))
      // 浏览器 UI 的调用入口：POST { method, params } → 执行 handlers → JSON 结果。
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/dsh-webpage-element-picker/invoke',
        handler: (req, res) => {
          let body = ''
          let overflow = false
          req.on('data', (d) => {
            if (overflow) return
            body += String(d)
            if (body.length > 1000000) {
              overflow = true
              body = ''
            }
          })
          req.on('end', () => {
            let msg: { method?: unknown; params?: unknown } | null = null
            try {
              msg = JSON.parse(body || '{}')
            } catch {
              // 忽略格式错误的载荷
            }
            const method = msg && typeof msg.method === 'string' ? msg.method : ''
            const params = (msg && typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>
            const handler = handlers.get(method)
            if (!handler) {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: '未知方法: ' + method }))
              return
            }
            Promise.resolve()
              .then(() => handler(params))
              .then((result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(result))
              })
              .catch((err: unknown) => {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: String((err && (err as Error).message) || err) }))
              })
          })
        },
      }))
    } catch (err) {
      console.error(
        '[dsh-webpage-element-picker] 路由注册失败（可能被本插件的另一个实例占用）: ' + String((err && (err as Error).message) || err),
      )
    }
    return () => {
      for (const d of disposers) {
        try {
          d()
        } catch {
          // 尽力清理
        }
      }
    }
  })

  const readStdout = async (boot: SubprocessHandleLike, payloadText: string): Promise<void> => {
    try {
      if (!boot || !boot.stdout) return
      for await (const chunk of boot.stdout) {
        lineBuf += String(chunk)
        let i: number
        while ((i = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, i).replace(/\r$/, '')
          lineBuf = lineBuf.slice(i + 1)
          if (!line) continue
          if (!payloadSent && line === 'READY') {
            payloadSent = true
            try {
              boot.stdin.write(payloadText)
            } catch (err) {
              console.error('[dsh-webpage-element-picker] 发送资源文件失败: ' + String((err && (err as Error).message) || err))
            }
          }
        }
      }
    } catch {
      // stdout 已结束
    }
  }

  const stderrTail = (boot: SubprocessHandleLike): string => {
    try {
      const c = boot.collected && boot.collected.stderr
      if (!c) return ''
      const read = c.readFrom(0)
      const lines = String(read.text || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      return lines.length ? lines[lines.length - 1].slice(0, 300) : ''
    } catch {
      return ''
    }
  }

  const ensureHelper = async (): Promise<SubprocessHandleLike> => {
    if (handle !== null) return handle
    if (starting) return starting
    starting = (async (): Promise<SubprocessHandleLike> => {
      try {
        const resourceDir = await resolveResourceDir()
        const res = await loadResources(resourceDir)
        const payloadText = res.helper + '\n<<<DSH_SPLIT>>>\n' + res.inspector + '\n<<<DSH_END>>>\n'
        const node = await subprocess.resolveExecutable('node')
        // npm 安装 playwright-core 运行时（首次数秒，无浏览器下载）后启动系统浏览器；
        // 使用 npm-cli.js 脚本入口而不是 npm.cmd，避免 Windows 下 spawn .cmd 的限制
        const npmCli = node.replace(/[^\\/]+$/, 'node_modules/npm/bin/npm-cli.js')
        let launcher: string | null = null
        try {
          await subprocess.resolveExecutable(npmCli)
          launcher = npmCli
        } catch {
          // 继续到下方的显式报错
        }
        if (!launcher) throw new Error('未找到 npm 的脚本入口（' + npmCli + '），请确认 Node.js 安装完整')
        const port = typeof webServer.port === 'number' && webServer.port > 0 ? webServer.port : 0
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
        status = { state: 'error', message: String((err && (err as Error).message) || err) }
        throw err
      } finally {
        starting = null
      }
    })()
    return starting
  }

  const request = (method: string, params: Record<string, unknown> | undefined, timeoutMs?: number): Promise<{ ok: boolean; status?: PickerStatus; error?: string }> => {
    const id = ++cmdSeq
    return new Promise((resolve, reject) => {
      if (handle === null) {
        reject(new Error('浏览器未运行'))
        return
      }
      waiters.set(id, { resolve, reject })
      sendCommand({ id: id, method: method, params: params || {} })
      timer.timeout(() => {
        const w = waiters.get(id)
        if (w) {
          waiters.delete(id)
          w.reject(new Error(method + ' 超时'))
        }
      }, timeoutMs || 60000)
    })
  }

  const pickerNavigate: Handler = async (args) => {
    const url = String((args && args.url) || '')
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '网址需以 http:// 或 https:// 开头' }
    try {
      await ensureHelper()
      // 首次使用需安装 playwright-core 运行时 + 探测系统浏览器（约 10-30 秒），放宽超时
      const r = await request('open', { url: url }, 120000)
      return r && r.ok
        ? { ok: true, status: Object.assign({ state: 'open' as const }, r.status || { url: url }) }
        : { ok: false, error: (r && r.error) || '打开失败' }
    } catch (err) {
      return { ok: false, error: String((err && (err as Error).message) || err) }
    }
  }

  const pickerReinject: Handler = async () => {
    try {
      await ensureHelper()
      const r = await request('reinject', {}, 15000)
      return r && r.ok
        ? { ok: true, status: Object.assign({ state: 'open' as const }, r.status || {}) }
        : { ok: false, error: (r && r.error) || '重新注入失败' }
    } catch (err) {
      return { ok: false, error: String((err && (err as Error).message) || err) }
    }
  }

  const pickerStatus: Handler = async () => {
    if (handle === null) return { ok: true, status: status }
    try {
      const r = await request('status', {}, 8000)
      return r && r.ok ? { ok: true, status: r.status } : { ok: true, status: status }
    } catch {
      return { ok: true, status: status }
    }
  }

  const pickerClose: Handler = async () => {
    if (handle !== null) {
      try {
        await request('close', {}, 5000)
      } catch {
        // 关闭是尽力而为
      }
    }
    status = { state: 'closed', message: '浏览器窗口已关闭' }
    return { ok: true, status: status }
  }

  const pickerPull: Handler = async (args) => {
    const after = Number((args && args.afterSeq) || 0)
    const elements = pending
      .filter((e) => e.seq > after)
      .map((e) => ({ seq: e.seq, domId: e.domId, payload: e.payload }))
    return { ok: true, elements: elements, status: status }
  }

  handlers.set('picker-navigate', pickerNavigate)
  handlers.set('picker-reinject', pickerReinject)
  handlers.set('picker-status', pickerStatus)
  handlers.set('picker-close', pickerClose)
  handlers.set('picker-pull', pickerPull)

  ctx.effect(() => () => {
    if (handle) {
      try {
        if (handle.stdin) handle.stdin.end()
      } catch {
        // stdin 已关闭
      }
      handle.terminate()
      handle = null
    }
  })
}
