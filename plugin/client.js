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
