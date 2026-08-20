/**
 * Host 侧服务契约——本插件从 harness host 服务消费的精确 API 表面。
 * 仅类型：实现位于用户的 harness 中（dsh-base / dsh-web-app bundle）；
 * 插件在 `inject` 中声明它们，Cordis 会保持纤程挂起直到每个 provider 激活。
 */

/** harness 子进程服务接受的 spawn 规格（最小子集）。 */
export interface SubprocessSpawnSpecLike {
  argv: string[]
  cwd: string
  stdio: {
    stdin: 'ignore' | 'pipe'
    stdout: 'ignore' | 'pipe'
    stderr: 'ignore' | { maxBytes: number }
  }
  graceMs: number
}

/** 有界已收集输出读取器（stderr 尾部诊断）。 */
export interface SubprocessCollectedReaderLike {
  readFrom(offset: number): { text?: string }
}

/** 由 harness 子进程服务管理的一个活跃子进程。 */
export interface SubprocessHandleLike {
  stdin: { write(chunk: string): unknown; end(): unknown }
  stdout: AsyncIterable<unknown>
  done: Promise<{ exitCode: number | null }>
  collected?: { stderr?: SubprocessCollectedReaderLike }
  terminate(): unknown
}

/** harness 子进程服务（`ctx.subprocess`）。 */
export interface SubprocessFace {
  resolveExecutable(command: string): Promise<string>
  spawn(spec: SubprocessSpawnSpecLike): SubprocessHandleLike
}

/** harness webserver 上的一条 HTTP 路由注册。 */
export interface WebRouteLike {
  kind: 'exact'
  path: string
  handler(req: WebRequestLike, res: WebResponseLike): void
}

/** 交给路由处理器的 Node 风格请求/响应对。 */
export interface WebRequestLike {
  on(event: 'data', cb: (chunk: unknown) => void): void
  on(event: 'end' | 'close', cb: () => void): void
}

export interface WebResponseLike {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

/** harness web 服务器（`ctx.webServer`）。 */
export interface WebServerFace {
  register(route: WebRouteLike): () => void
  port?: number
}

/** 沙箱策略服务（`ctx.sandboxPolicy`）——工作区根目录查询。 */
export interface SandboxPolicyFace {
  workspaceRoot?: string
}

/** 沙箱文件系统服务（`ctx.fs`），此处消费的接口。 */
export interface FsFace {
  resolve(path: string): Promise<string>
  stat(path: string): Promise<unknown>
  readText(path: string): Promise<string>
}

/** 工具注册表（`ctx.tools`）。 */
export interface ToolsFace {
  register(tool: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): unknown[] }
    execute(args: unknown): Promise<unknown>
  }): () => void
}

/** 系统提示服务（`ctx.systemPrompt`）。 */
export interface SystemPromptFace {
  context(decl: { name: string; order: number; text: () => string }): () => void
}

/** Cordis 定时器服务（`ctx.timer`）。 */
export interface TimerFace {
  timeout(cb: () => void, ms: number): () => void
}
