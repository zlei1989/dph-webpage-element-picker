/**
 * 跨 host ↔ helper ↔ 浏览器 UI 边界的共享类型定义。
 *
 * host 半边和 client 半边运行在不同的程序中（Node 与 web shell），通过
 * harness webserver 路由（/poll、/events、/invoke）以纯 JSON 交换这些值。
 * 这里没有任何运行时的跨端导入——本文件在两端都仅用于类型。
 */

/** 报告给浏览器 UI 的选择器生命周期状态。 */
export interface PickerStatus {
  state: 'idle' | 'starting' | 'open' | 'ready' | 'closed' | 'error'
  message?: string
  url?: string
  title?: string
  browser?: string
  injected?: boolean
  modeExited?: boolean
}

/**
 * 一个被选中的页面元素，由注入的 inspector 脚本上报。
 * 已知字段之外可能还有其他字段（HTML、CSS 路径、rect 等），会原样
 * 透传给模型（通过 read_picked_element 工具）。
 */
export interface DomElementPayload {
  tagName?: string
  id?: string
  className?: string
  textContent?: string
  attributes?: Record<string, string>
  pageUrl?: string
  [key: string]: unknown
}

/** 注册表条目：对话中引用的 DOMn id 及其载荷。 */
export interface DomRegistryEntry {
  id: string
  payload: DomElementPayload
}

/** 排入客户端轮询队列的已选元素（单调递增序号）。 */
export interface PendingElement {
  seq: number
  domId: string
  payload: DomElementPayload
}

/** helper 子进程 POST 到 /events 的事件。 */
export type HelperEvent =
  | { type: 'reply'; id: number; ok: boolean; error?: string; status?: PickerStatus }
  | { type: 'element-selected'; data?: DomElementPayload }
  | { type: 'browser'; name?: string }
  | { type: 'status'; url?: string; title?: string }
  | { type: 'injected'; url?: string; title?: string }
  | { type: 'mode-exited'; url?: string; title?: string }
  | { type: 'window-closed' }
  | { type: 'helper-ready' }
  | { type: 'error'; message: string }

/** /invoke 方法供浏览器 UI 调用的结果信封。 */
export interface InvokeResult {
  ok: boolean
  error?: string
  status?: PickerStatus
  elements?: PendingElement[]
}
