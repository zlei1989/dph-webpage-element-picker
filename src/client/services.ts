/**
 * Client 侧服务契约——本插件从 harness web 半边消费的精确 API 表面。
 * 仅类型：运行时服务来自用户的 harness；槽位注册通过 `ctx.slots` 到达，
 * 框架将标准套件（`useInput`、`inputActions`）传递给槽位组件的 props。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 一条槽位注册描述符（conversation.input.left）。 */
export interface SlotRegistration {
  name: string
  id: string
  order: number
}

/** harness 槽位服务（`ctx.slots`），此处消费的接口。 */
export interface SlotsService {
  inject(name: string, callback: () => unknown): () => void
  register(registration: SlotRegistration, component: (props: Record<string, unknown>) => unknown): () => void
}

/** 对话输入框草稿存储，暴露给槽位组件。 */
export interface InputStateLike {
  draft: string
}

/** 通过槽位组件标准 props 传递的草稿变更方法。 */
export interface InputActionsLike {
  setDraft?(draft: string): void
}

/** 本插件在 conversation.input.left 槽位上读取的标准 props。 */
export interface PickerEntryProps {
  useInput?<T>(selector: (state: InputStateLike) => T): T
  inputActions?: InputActionsLike
}

/** Client 上下文：cordis 加上本插件注入的服务。 */
export type ClientCtx = Context & {
  slots: SlotsService
}
