/**
 * dsh-webpage-element-picker — Client 半边（已安装包 bundle 入口）。
 *
 * 在 `conversation.input.left` 槽位注册一个十字图标按钮。点击后打开
 * "添加页面元素"对话框：将内嵌系统浏览器导航到某个 URL，用注入的
 * inspector 选择页面元素，并在输入框草稿中插入 `[标签][DOMn]` 引用式
 * 占位符——模型通过 host 侧的 read_picked_element 工具按需读取完整
 * 元素详情。
 *
 * 本模块是包的 `./client` bundle 主体：tsup（tsup.config.ts）将其
 * 打包（external `react`——浏览器模块表通过注入的 `require` 提供），
 * 包裹在 web boot 握手中（`window.__ModuleLoader__.load({id, factory})`）。
 * 它通过 harness webserver 的 /dsh-webpage-element-picker/invoke 路由
 * （同源 fetch）与 host 半边通信。
 */

import { React, h } from './react'
import type { ClientCtx, PickerEntryProps } from './services'
import type { InvokeResult, PendingElement, PickerStatus } from '../shared/types'

const PLUGIN_ID = 'dsh-webpage-element-picker'
const INVOKE_PATH = '/dsh-webpage-element-picker/invoke'

const STYLE_CSS =
  '.dsh-we-icon-btn { background: transparent; border: none; color: #9a9aa6; padding: 5px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }' +
  '.dsh-we-icon-btn:hover { background: rgba(255,255,255,0.08); color: #d8d8e0; }' +
  '.dsh-we-icon-btn:disabled { opacity: 0.5; cursor: default; }'

/** 调用 host 半边的 picker-* 处理器（POST 到 harness webserver 路由）。 */
function hostCall(method: string, params?: Record<string, unknown>): Promise<InvokeResult> {
  const base = typeof window !== 'undefined' && window.location && window.location.origin ? window.location.origin : ''
  return fetch(base + INVOKE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: method, params: params || {} }),
  }).then((res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json() as Promise<InvokeResult>
  })
}

function shortText(s: unknown): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > 10 ? t.slice(0, 10) + '…' : t
}

function labelOf(p: Record<string, unknown>): string {
  if (p.textContent) return shortText(p.textContent)
  const attrs = (p.attributes || {}) as Record<string, string>
  const keys = ['aria-label', 'placeholder', 'alt', 'title', 'value']
  for (const key of keys) {
    if (attrs[key]) return shortText(attrs[key])
  }
  const tag = String(p.tagName || '?')
  if (p.id) return tag + '#' + String(p.id)
  const cls = String(p.className || '').trim().split(/\s+/).slice(0, 2).join('.')
  if (cls) return tag + '.' + cls
  return tag
}

function placeholderLine(item: PendingElement): string {
  const p = (item.payload || {}) as Record<string, unknown>
  const id = item.domId || 'DOM'
  const label = labelOf(p)
  if (!label || label === '?') return '[' + id + ']'
  return '[' + label + '][' + id + ']'
}

const S: Record<string, React.CSSProperties> = {
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

function crosshairIcon(el: typeof h): React.ReactNode {
  return el(
    'svg',
    {
      width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round',
    },
    el('circle', { cx: 12, cy: 12, r: 7 }),
    el('line', { x1: 12, y1: 2, x2: 12, y2: 6 }),
    el('line', { x1: 12, y1: 18, x2: 12, y2: 22 }),
    el('line', { x1: 2, y1: 12, x2: 6, y2: 12 }),
    el('line', { x1: 18, y1: 12, x2: 22, y2: 12 }),
  )
}

function PickerEntry(props: PickerEntryProps): React.ReactNode {
  const el = h
  const input = props.useInput ? props.useInput(function (s) { return s }) : { draft: '' }
  const st = React.useState(function () { return { afterSeq: 0, draft: '' } })[0]
  st.draft = input.draft

  const openState = React.useState(false)
  const open = openState[0]
  const setOpen = openState[1]
  const urlState = React.useState('')
  const urlText = urlState[0]
  const setUrlText = urlState[1]
  const busyState = React.useState(false)
  const busy = busyState[0]
  const setBusy = busyState[1]
  const statusState2 = React.useState<PickerStatus | null>(null)
  const status = statusState2[0]
  const setStatus = statusState2[1]
  const noticeState = React.useState('')
  const notice = noticeState[0]
  const setNotice = noticeState[1]
  const statusState = status ? status.state : null

  const showNotice = function (text: string): void {
    setNotice(text)
    window.setTimeout(function () {
      setNotice(function (cur) { return cur === text ? '' : cur })
    }, 5000)
  }

  const insertElements = function (elements: PendingElement[]): void {
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

  React.useEffect(function () {
    if (!open && statusState !== 'open') return
    let cancelled = false
    const poll = function (): void {
      hostCall('picker-pull', { afterSeq: st.afterSeq })
        .then(function (res) {
          if (cancelled || !res) return
          if (res.status) setStatus(res.status)
          const elements = res.elements || []
          if (elements.length) {
            insertElements(elements)
            if (open) showNotice('已添加 ' + elements.length + ' 个页面元素到输入框')
          }
        })
        .catch(function () {
          // 内置浏览器尚未就绪，继续轮询
        })
    }
    poll()
    const intervalId = window.setInterval(poll, 1500)
    return function () {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [open, statusState])

  const onConfirm = function (): void {
    const url = String(urlText || '').split('\n').map(function (s) { return s.trim() }).filter(Boolean)[0] || ''
    if (!url) {
      showNotice('请先输入网址')
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      showNotice('网址需以 http:// 或 https:// 开头')
      return
    }
    setBusy(true)
    hostCall('picker-navigate', { url: url })
      .then(function (res) {
        if (res && res.ok) {
          setStatus(Object.assign({ state: 'open' as const }, res.status || { url: url }))
          setOpen(false)
        } else {
          showNotice('打开失败：' + ((res && res.error) || '未知错误'))
        }
      })
      .catch(function (err) {
        showNotice('打开失败：' + String((err && err.message) || err))
      })
      .finally(function () {
        setBusy(false)
      })
  }

  const onReinject = function (): void {
    setBusy(true)
    hostCall('picker-reinject', {})
      .then(function (res) {
        if (res && res.ok) {
          setStatus(Object.assign({ state: 'open' as const }, res.status || status))
          showNotice('已重新注入选择功能')
        } else {
          showNotice('重新注入失败：' + ((res && res.error) || '未知错误'))
        }
      })
      .catch(function (err) {
        showNotice('重新注入失败：' + String((err && err.message) || err))
      })
      .finally(function () {
        setBusy(false)
      })
  }

  const browserLabel = status && status.browser ? '浏览器: ' + status.browser + ' · ' : ''
  const tooltip = status
    ? status.message ||
      (status.state === 'open'
        ? browserLabel + '已打开: ' + (status.title || status.url || '') +
          (status.modeExited ? ' · 选择模式已退出（点击图标可重新打开）' : status.injected ? ' · 已注入选择功能' : '')
        : '')
    : ''
  const buttonTitle = tooltip || '打开浏览器并选择页面元素'

  const renderDialog = function (): React.ReactNode {
    return el(
      'div',
      {
        style: S.backdrop,
        onMouseDown: function (e: React.MouseEvent) {
          if (e.target === e.currentTarget) setOpen(false)
        },
      },
      el(
        'div',
        { style: S.panel },
        el(
          'div',
          { style: S.header },
          el('div', { style: S.title }, '添加页面元素'),
          el('button', { onClick: function () { setOpen(false) }, style: S.closeBtn }, '×'),
        ),
        el(
          'div',
          { style: S.body },
          el('textarea', {
            value: urlText,
            onChange: function (e: React.ChangeEvent<HTMLTextAreaElement>) { setUrlText(e.target.value) },
            rows: 4,
            placeholder: '输入网址（每行一个，使用第一行），例如：\nhttps://example.com',
            style: S.textarea,
          }),
          status
            ? el(
                'div',
                { style: S.statusLine },
                '状态：' +
                  (status.message ||
                    (status.state === 'open'
                      ? browserLabel + '已打开 ' + (status.url || '') +
                        (status.modeExited ? ' · 选择模式已退出' : status.injected ? ' · 已注入选择功能' : '')
                      : status.state === 'ready'
                        ? '浏览器已就绪'
                        : status.state)),
              )
            : null,
          notice ? el('div', { style: S.notice }, notice) : null,
          el(
            'div',
            { style: S.hint },
            '提示：在页面中点击元素，再点「添加到对话」，即可在输入框插入 [标签][DOMn] 引用式占位符；完整元素信息由模型按需通过 read_picked_element 工具读取。浏览器使用系统已安装的 Chrome/Edge 等（自动探测，绝不下载）；首次打开需安装约 13MB 的 playwright-core 运行时（不含浏览器）并探测系统浏览器，之后秒开。需要登录时：先点页面右下角的「选择模式」悬浮按钮（或按 ` 键）暂停选择，登录完成后回到这里点「仅重新注入」即可在当前页面恢复选择功能；如需回到输入的网址则点「打开」。',
          ),
        ),
        el(
          'div',
          { style: S.footer },
          el('button', { onClick: function () { setOpen(false) }, style: S.ghostBtn }, '关闭'),
          el('button', { onClick: onReinject, disabled: busy, style: S.ghostBtn }, '仅重新注入'),
          el('button', { onClick: onConfirm, disabled: busy, style: S.primaryBtn }, busy ? '打开中…' : '打开'),
        ),
      ),
    )
  }

  return el(
    React.Fragment,
    null,
    el(
      'button',
      {
        className: 'dsh-we-icon-btn',
        onClick: function () {
          setOpen(true)
          setNotice('')
        },
        title: buttonTitle,
        'aria-label': '添加页面元素',
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
      },
      crosshairIcon(el),
    ),
    open ? renderDialog() : null,
  )
}

function apply(ctx: ClientCtx): void {
  ctx.effect(function () {
    let tag: HTMLStyleElement | null = null
    if (typeof document !== 'undefined') {
      tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.textContent = STYLE_CSS
      document.head.appendChild(tag)
    }
    return function () {
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
    }
  }, 'dsh-webpage-element-picker: styles')

  ctx.effect(function () {
    return ctx.slots.inject('conversation.input.left', function () {
      return ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: PLUGIN_ID,
          order: 0,
        },
        PickerEntry as (props: Record<string, unknown>) => unknown,
      )
    })
  }, 'dsh-webpage-element-picker: slot registration')
}

module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply: apply,
}
