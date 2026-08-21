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
 *
 * 日志：统一走模块级 logDebug/logInfo/logWarn/logError（带插件前缀）；
 * DEBUG 级生产默认关闭，设 `DSH_WE_DEBUG=1` 环境变量打开。
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

/** 日志统一前缀（便于在 harness 日志流中检索本插件条目）。 */
const LOG_PREFIX = '[dsh-webpage-element-picker]'
/** DEBUG 级开关：生产默认关闭，环境变量 `DSH_WE_DEBUG=1` 打开。 */
const DEBUG_ENABLED = typeof process !== 'undefined' && !!(process.env && process.env.DSH_WE_DEBUG)

/** DEBUG：分支走向、中间变量、循环关键节点（生产默认关闭）。 */
function logDebug(msg: string): void {
  if (DEBUG_ENABLED) console.debug(LOG_PREFIX + ' [DEBUG] ' + msg)
}
/** INFO：请求入口、关键状态变更、外部调用耗时。 */
function logInfo(msg: string): void {
  console.info(LOG_PREFIX + ' [INFO] ' + msg)
}
/** WARN：降级、重试、超时、配置缺失但可继续。 */
function logWarn(msg: string): void {
  console.warn(LOG_PREFIX + ' [WARN] ' + msg)
}
/** ERROR：业务异常、外部调用失败——必须带堆栈和业务上下文。 */
function logError(msg: string, err?: unknown): void {
  const e = err as Error | null | undefined
  const detail = e && e.stack ? e.stack : String((e && e.message) || err || '')
  console.error(LOG_PREFIX + ' [ERROR] ' + msg + (detail ? '\n' + detail : ''))
}

/** 挂在 /poll 上的长轮询等待者，直到有命令入队或超时。 */
interface PollWaiter {
  finish(cmd: unknown): void
}

/** 等待其 reply 事件的待处理 helper 请求。 */
interface RequestWaiter {
  resolve(ev: { ok: boolean; status?: PickerStatus; error?: string }): void
  reject(err: Error): void
  /** 发起时间戳：reply 到达或超时拒绝时计算往返耗时。 */
  at: number
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

  /** 包内 resources/ 目录（bundle 形态下的首选）；无法从 import.meta.url 推导时返回空串跳过。 */
  const pkgResourceDir = ((): string => {
    try {
      return fileURLToPath(new URL('../resources/', import.meta.url))
    } catch {
      return ''
    }
  })()
  let homeProbePromise: Promise<string> | null = null
  /**
   * 探测用户家目录（供旧版资源目录兜底）。
   * 经 harness subprocess 服务起子进程打印 home，而不是直接读本进程
   * process.env：保证与后续 spawn 出来的 helper 处于同一环境视图。
   * 结果经 homeProbePromise 缓存，全程只探测一次；失败返回空串（可继续）。
   */
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
          // 只取第一行输出（家目录路径），之后不再读
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
              // 进程退出但 stdout 未换行结尾时，用已收集的全部缓冲兜底
              if (buf.length === 0) finish('')
              else finish(buf.split('\n')[0].replace(/\r$/, '').trim())
            },
            () => finish(''),
          )
        })
      } catch {
        logDebug('家目录探测失败，跳过家目录资源候选（不影响包内资源解析）')
        return ''
      }
    })()
    return homeProbePromise
  }

  /**
   * 生成资源目录候选列表（按优先级排序）：
   * 包内 resources/ → 家目录旧版安装位（.dsh / .dph）→ 工作区目录。
   */
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

  /**
   * 选定资源目录：逐候选检查 4 个必需文件是否齐全（经沙箱 fs 服务），
   * 第一个齐全的候选胜出；全部缺失时报错并列出已尝试路径。
   */
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
      if (ok) {
        logInfo('资源目录: ' + c)
        return c
      }
      logDebug('资源候选不完整，跳过: ' + c)
    }
    throw new Error(
      '未找到页面元素选择器的资源目录（需要 4 个文件: ' + needFiles.join(' / ') + '；已尝试: ' + candidates.join(' | ') + '）',
    )
  }

  /**
   * 读取 helper 与 inspector 的源文本。
   * 不直接给 helper 传文件路径：bootstrap 可能运行在无沙箱读权限的位置，
   * 源文本稍后按行协议经 stdin 发送给 bootstrap，由它落盘到 %TEMP%。
   */
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

  /**
   * 向 helper 派发一条命令。
   * 有长轮询等待者则直推（实时性最好）；否则入队等下一次 /poll。
   * 队列截断到 100 条：helper 长时间不在线时防止内存无限膨胀。
   */
  const sendCommand = (cmd: unknown): void => {
    const c = cmd as { id?: unknown; method?: unknown }
    if (pollWaiters.length > 0) {
      pollWaiters.shift()!.finish(cmd)
      logDebug('命令直推长轮询: id=' + String(c.id) + ' method=' + String(c.method))
      return
    }
    commandQueue.push(cmd)
    if (commandQueue.length > 100) commandQueue.splice(0, commandQueue.length - 100)
    logDebug('命令入队等待 /poll: id=' + String(c.id) + ' method=' + String(c.method) + '（队列长度 ' + commandQueue.length + '）')
  }

  /**
   * 生成系统提示中的「页面元素列表」段落：每元素一行摘要（标签/文本/URL），
   * 末尾附 read_picked_element 工具用法；无元素时返回空串，不占用上下文。
   */
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

  // 注册系统提示动态上下文段：每次组装提示时回调 buildSummary 取最新注册表
  try {
    ctx.effect(() => systemPrompt.context({
      name: 'webpage-element-picker',
      order: 60,
      text: () => buildSummary(),
    }))
  } catch (err) {
    logError('系统提示上下文注册失败（页面元素列表将不会出现在系统提示中）', err)
  }

  // 注册动态工具：模型按 DOMn 编号读取元素完整信息
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
        logInfo('工具调用 read_picked_element: id=' + (id || '(空)'))
        if (!id) throw new Error('read_picked_element 需要参数 id（如 DOM1）')
        const entry = domRegistry.find((e) => e.id === id)
        if (!entry) {
          // 编号不存在：返回可用编号清单，便于模型自我纠正后重试
          logDebug('元素编号未命中: ' + id + '（当前可用 ' + domRegistry.length + ' 个）')
          return { ok: false, error: '未找到元素 ' + id + '，可用编号: ' + domRegistry.map((e) => e.id).join(', ') }
        }
        return { ok: true, id: entry.id, element: entry.payload }
      },
    }))
    logInfo('动态工具 read_picked_element 已注册')
  } catch (err) {
    logError('工具注册失败（模型将无法读取页面元素详情）', err)
  }

  /**
   * 处理 helper 经 /events 上报的事件：
   * reply 按 id 分发回请求等待者；其余事件驱动 status / domRegistry 状态机，
   * 状态由浏览器 UI 经 picker-status / picker-pull 轮询消费。
   */
  const handleEvent = (ev: HelperEvent): void => {
    if (!ev || typeof ev.type !== 'string') return
    if (ev.type === 'reply') {
      const w = waiters.get(ev.id)
      if (w) {
        waiters.delete(ev.id)
        logDebug('收到 reply: id=' + ev.id + ' ok=' + ev.ok + ' 耗时 ' + (Date.now() - w.at) + 'ms')
        if (ev.ok) w.resolve(ev)
        else w.reject(new Error(ev.error || '内置浏览器返回错误'))
      }
      return
    }
    if (ev.type === 'element-selected') {
      // 关键状态变更：注册新 DOMn 编号并入客户端轮询队列；
      // 两个容器都截断（200/100），防止长会话无限增长
      domCounter += 1
      const domId = 'DOM' + domCounter
      domRegistry.push({ id: domId, payload: ev.data || {} })
      if (domRegistry.length > 200) domRegistry = domRegistry.slice(-200)
      pending.push({ seq: ++lastSeq, domId: domId, payload: ev.data || {} })
      if (pending.length > 100) pending = pending.slice(-100)
      const p = (ev.data || {}) as DomElementPayload
      logInfo('页面元素已选中: ' + domId + ' ' + String(p.tagName || '?') + ' (' + String(p.pageUrl || '') + ')')
      return
    }
    if (ev.type === 'browser') {
      lastBrowserName = ev.name || '浏览器'
      logInfo('已探测到系统浏览器: ' + lastBrowserName)
      status = { state: 'starting', message: '正在启动 ' + lastBrowserName + '…', browser: lastBrowserName }
      return
    }
    if (ev.type === 'status') {
      logDebug('页面状态更新: ' + String(ev.url || ''))
      status = { state: 'open', url: ev.url, title: ev.title, browser: lastBrowserName }
      return
    }
    if (ev.type === 'injected') {
      logDebug('inspector 已注入: ' + String(ev.url || ''))
      status = { state: 'open', url: ev.url, title: ev.title, injected: true, browser: lastBrowserName }
      return
    }
    if (ev.type === 'mode-exited') {
      logInfo('选择模式已退出: ' + String(ev.url || ''))
      status = { state: 'open', url: ev.url, title: ev.title, modeExited: true, browser: lastBrowserName }
      return
    }
    if (ev.type === 'window-closed') {
      logInfo('浏览器窗口已关闭')
      status = { state: 'closed', message: '浏览器窗口已关闭，可重新点击打开按钮打开' }
      return
    }
    if (ev.type === 'helper-ready') {
      logInfo('浏览器已就绪' + (lastBrowserName ? '（' + lastBrowserName + '）' : ''))
      status = { state: 'ready', message: '浏览器已就绪' + (lastBrowserName ? '（' + lastBrowserName + '）' : ''), browser: lastBrowserName }
      return
    }
    if (ev.type === 'error') {
      logError('浏览器侧错误: ' + ev.message)
      status = { state: 'error', message: ev.message }
      return
    }
  }

  // 浏览器 UI 侧可调用的方法（POST /invoke 分发）。
  const handlers = new Map<string, Handler>()

  // 注册三条 HTTP 路由：/poll（helper 长轮询取命令）、/events（helper 事件上报）、
  // /invoke（浏览器 UI 调用入口）。数据通道不依赖子进程管道——Chromium 在
  // Windows 会关闭 stdin，所以命令/事件一律走 harness 自带 HTTP 路由。
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: '/dsh-webpage-element-picker/poll',
        handler: (req, res) => {
          // 队列非空：立即返回队首命令
          if (commandQueue.length > 0) {
            const cmd = commandQueue.shift()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(cmd))
            return
          }
          // 队列空：挂起为长轮询等待者。25s 心跳超时返回 null（helper 侧
          // 收到 null 后 250ms 再重连）；客户端断开连接时同样清理等待者
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
          logDebug('长轮询挂起（当前等待者 ' + pollWaiters.length + '）')
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
            // 1MB 上限防滥用：超出即丢弃整包（helper 是唯一调用方，载荷很小）
            if (body.length > 1000000) {
              overflow = true
              body = ''
              logWarn('事件载荷超过 1MB，已丢弃')
            }
          })
          req.on('end', () => {
            if (!overflow) {
              let msg: { event?: HelperEvent } | null = null
              try {
                msg = JSON.parse(body || '{}')
              } catch {
                // 忽略格式错误的载荷（helper 是唯一调用方，报错无意义）
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
            // 1MB 上限防滥用，同 /events
            if (body.length > 1000000) {
              overflow = true
              body = ''
              logWarn('调用载荷超过 1MB，已丢弃')
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
            // 请求入口日志：picker-status / picker-pull 是客户端 1.5s 轮询的
            // 高频只读方法，记 DEBUG 防刷屏；操作类方法记 INFO
            if (method === 'picker-status' || method === 'picker-pull') {
              logDebug('请求入口 /invoke: ' + method)
            } else {
              logInfo('请求入口 /invoke: ' + method + (method === 'picker-navigate' ? ' url=' + String(params.url || '') : ''))
            }
            const handler = handlers.get(method)
            if (!handler) {
              logWarn('未知调用方法: ' + (method || '(空)'))
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
                // 处理器异常：错误详情回给 UI 展示，同时本地留堆栈
                logError('调用 ' + method + ' 失败', err)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: String((err && (err as Error).message) || err) }))
              })
          })
        },
      }))
      logInfo('HTTP 路由已注册: /poll /events /invoke')
    } catch (err) {
      logError('路由注册失败（可能被本插件的另一个实例占用）', err)
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

  /**
   * 消费 bootstrap stdout 的行协议：首行 READY 表示 stdin 可写，
   * 随即回写资源载荷（helper + inspector 源码文本）；载荷发送后
   * 忽略后续所有行——helper 日志走 stderr，事件走 HTTP /events。
   */
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
            logDebug('收到 READY 握手，回写资源载荷（' + payloadText.length + ' 字符）')
            try {
              boot.stdin.write(payloadText)
            } catch (err) {
              logError('发送资源文件失败（helper 将收不到源码，启动会失败）', err)
            }
          }
        }
      }
    } catch {
      // stdout 已结束
      logDebug('helper stdout 流结束')
    }
  }

  /**
   * 取子进程 stderr 环形缓冲区的最后一个非空行（截断 300 字符），
   * 用于 helper 进程退出时的退出原因诊断。
   */
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
      logDebug('读取 helper stderr 尾部失败')
      return ''
    }
  }

  /**
   * 确保 helper 子进程已启动（单例）。
   * 已在运行直接复用；启动中复用同一 Promise，防止并发调用重复 spawn；
   * 启动失败写入 status 供 UI 轮询展示，并把异常抛回调用方。
   */
  const ensureHelper = async (): Promise<SubprocessHandleLike> => {
    if (handle !== null) return handle
    if (starting) {
      logDebug('helper 正在启动中，复用进行中的启动 Promise')
      return starting
    }
    starting = (async (): Promise<SubprocessHandleLike> => {
      try {
        const startedAt = Date.now()
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
        logDebug('启动参数: node=' + node + ' npmCli=' + npmCli + ' webPort=' + port)
        const boot = subprocess.spawn({
          argv: [node, resourceDir + '/bootstrap.cjs', launcher, String(port)],
          cwd: workspaceRoot,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 65536 } },
          graceMs: 3000,
        })
        handle = boot
        payloadSent = false
        lineBuf = ''
        logInfo('helper 子进程已启动（耗时 ' + (Date.now() - startedAt) + 'ms，后续 READY 握手与浏览器探测由 bootstrap 驱动）')
        boot.done.then((outcome) => {
          if (handle === boot) {
            handle = null
            const tail = stderrTail(boot)
            const detail = '浏览器进程已退出 (code ' + outcome.exitCode + ')' + (tail ? ' · ' + tail : '')
            // 退出码 0 多为用户正常关窗（INFO）；非零为异常退出（WARN，可重新打开）
            if (outcome.exitCode === 0) logInfo(detail)
            else logWarn(detail)
            status = { state: 'closed', message: detail }
            // 进程已死：所有等待 reply 的请求立即失败，避免挂到超时
            for (const [id, w] of Array.from(waiters)) {
              waiters.delete(id)
              w.reject(new Error('浏览器进程已退出'))
            }
          }
        }, () => {})
        readStdout(boot, payloadText)
        return boot
      } catch (err) {
        logError('启动 helper 失败（资源目录: ' + pkgResourceDir + '）', err)
        status = { state: 'error', message: String((err && (err as Error).message) || err) }
        throw err
      } finally {
        starting = null
      }
    })()
    return starting
  }

  /**
   * 发送一条命令并等待同 id 的 reply 事件（Promise 化）。
   * 超时（默认 60s，调用方可覆盖）自动清理等待者并拒绝，
   * 防止 helper 无响应时 Promise 永远挂起。
   */
  const request = (method: string, params: Record<string, unknown> | undefined, timeoutMs?: number): Promise<{ ok: boolean; status?: PickerStatus; error?: string }> => {
    const id = ++cmdSeq
    return new Promise((resolve, reject) => {
      if (handle === null) {
        reject(new Error('浏览器未运行'))
        return
      }
      waiters.set(id, { resolve, reject, at: Date.now() })
      sendCommand({ id: id, method: method, params: params || {} })
      timer.timeout(() => {
        const w = waiters.get(id)
        if (w) {
          waiters.delete(id)
          logWarn('命令超时: ' + method + '（id=' + id + '，' + (timeoutMs || 60000) + 'ms 未收到 reply）')
          w.reject(new Error(method + ' 超时'))
        }
      }, timeoutMs || 60000)
    })
  }

  /**
   * picker-navigate：把内嵌浏览器导航到指定网址。
   * 校验协议 → 确保 helper 已启动 → 发 open 命令；首次使用需安装
   * playwright-core 运行时 + 探测系统浏览器（约 10-30 秒），超时放宽到 120s。
   */
  const pickerNavigate: Handler = async (args) => {
    const url = String((args && args.url) || '')
    if (!/^https?:\/\//i.test(url)) {
      logDebug('网址校验未通过（需 http/https）: ' + url)
      return { ok: false, error: '网址需以 http:// 或 https:// 开头' }
    }
    try {
      await ensureHelper()
      const r = await request('open', { url: url }, 120000)
      return r && r.ok
        ? { ok: true, status: Object.assign({ state: 'open' as const }, r.status || { url: url }) }
        : { ok: false, error: (r && r.error) || '打开失败' }
    } catch (err) {
      logError('打开网址失败: ' + url, err)
      return { ok: false, error: String((err && (err as Error).message) || err) }
    }
  }

  /**
   * picker-reinject：在当前页面仅重新注入选择功能（不重新导航），
   * 用于登录等人工操作后恢复选择模式。
   */
  const pickerReinject: Handler = async () => {
    try {
      await ensureHelper()
      const r = await request('reinject', {}, 15000)
      return r && r.ok
        ? { ok: true, status: Object.assign({ state: 'open' as const }, r.status || {}) }
        : { ok: false, error: (r && r.error) || '重新注入失败' }
    } catch (err) {
      logError('重新注入失败', err)
      return { ok: false, error: String((err && (err as Error).message) || err) }
    }
  }

  /**
   * picker-status：查询当前状态。helper 不在线直接回本地缓存状态；
   * 在线则问 helper，问不动时回退本地缓存（降级，不报错给 UI）。
   */
  const pickerStatus: Handler = async () => {
    if (handle === null) return { ok: true, status: status }
    try {
      const r = await request('status', {}, 8000)
      return r && r.ok ? { ok: true, status: r.status } : { ok: true, status: status }
    } catch {
      // helper 状态查询失败：降级为本地缓存状态（UI 轮询高频，不宜报错）
      logDebug('helper 状态查询失败，降级为本地缓存状态')
      return { ok: true, status: status }
    }
  }

  /** picker-close：关闭浏览器窗口（尽力而为），本地状态立即置 closed。 */
  const pickerClose: Handler = async () => {
    if (handle !== null) {
      try {
        await request('close', {}, 5000)
      } catch {
        // 关闭是尽力而为
        logDebug('close 命令未获确认（helper 可能已退出），忽略')
      }
    }
    status = { state: 'closed', message: '浏览器窗口已关闭' }
    return { ok: true, status: status }
  }

  /**
   * picker-pull：客户端 1.5s 轮询的增量拉取——返回 afterSeq 之后新选中的
   * 元素列表 + 当前状态，游标语义保证不重复投递。
   */
  const pickerPull: Handler = async (args) => {
    const after = Number((args && args.afterSeq) || 0)
    const elements = pending
      .filter((e) => e.seq > after)
      .map((e) => ({ seq: e.seq, domId: e.domId, payload: e.payload }))
    if (elements.length) logDebug('picker-pull 投递 ' + elements.length + ' 个元素（afterSeq=' + after + '）')
    return { ok: true, elements: elements, status: status }
  }

  handlers.set('picker-navigate', pickerNavigate)
  handlers.set('picker-reinject', pickerReinject)
  handlers.set('picker-status', pickerStatus)
  handlers.set('picker-close', pickerClose)
  handlers.set('picker-pull', pickerPull)

  // 插件卸载清理：尽力关闭 helper 子进程（先礼后兵：stdin.end 再 terminate）
  ctx.effect(() => () => {
    if (handle) {
      try {
        if (handle.stdin) handle.stdin.end()
      } catch {
        // stdin 已关闭
      }
      handle.terminate()
      handle = null
      logInfo('插件卸载，helper 子进程已终止')
    }
  })
}
