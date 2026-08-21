// DSH 页面元素选择插件：页面内 inspector（由 helper 经 page.evaluate 注入执行）。
// 职责：悬停高亮 → 点选锁定 → 「添加到对话」→ 采集元素数据（选择器/DOM路径/
//       属性/位置尺寸/HTML 片段）回传；支持暂停/恢复与退出清理。
// 通信协议：console.log('__DSH_WE__:' + JSON) 是唯一数据通道（helper 的
//           console 桥按前缀截取），因此本脚本严禁用 console.log 输出其他内容；
//           DEBUG 日志走 console.debug（无前缀、不会误触发桥接），默认关闭，
//           在页面里执行 sessionStorage.__dsh_we_debug__='1' 后重新注入可打开。
// 生命周期：注入即激活（__dsh_we_active__ 防重入）；exitMode/cleanupAll 移除
//           全部事件监听与注入 DOM；暴露 __dsh_we_cleanup__ 供再次注入前先清理。
(function () {
  'use strict'
  if (window.__dsh_we_active__) return
  window.__dsh_we_active__ = true

  var DEBUG = false
  try { DEBUG = sessionStorage.getItem('__dsh_we_debug__') === '1' } catch (e) {}
  /** DEBUG：选择流程分支走向（默认关闭；console.debug 不带协议前缀，桥接不会截获）。 */
  function logDebug(msg) { if (DEBUG) console.debug('[dsh-we] ' + msg) }

  function setStyle(el, s) { for (var k in s) el.style[k] = s[k] }

  /* ---- 悬浮高亮覆盖层（跟随悬停元素，蓝框） ---- */
  var ov = document.createElement('div')
  ov.setAttribute('data-dsh-we', 'ov')
  setStyle(ov, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483640', border: '2px solid #3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', borderRadius: '3px', display: 'none' })

  /* ---- 悬浮标签（显示标签名与尺寸） ---- */
  var lb = document.createElement('div')
  lb.setAttribute('data-dsh-we', 'lb')
  setStyle(lb, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483640', backgroundColor: '#3b82f6', color: '#fff', fontSize: '11px', fontFamily: 'monospace', padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap', display: 'none' })

  /* ---- 操作栏（点选后出现：添加到对话 / 取消） ---- */
  var ab = document.createElement('div')
  ab.setAttribute('data-dsh-we', 'ab')
  setStyle(ab, { position: 'fixed', zIndex: '2147483642', background: '#1e1e1e', borderRadius: '6px', display: 'none', flexDirection: 'row', alignItems: 'center', gap: '4px', padding: '4px 6px', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' })
  var btnAdd = document.createElement('button')
  btnAdd.setAttribute('data-dsh-we-add', '1')
  setStyle(btnAdd, { background: '#2d2d2d', color: '#fff', fontSize: '12px', border: 'none', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' })
  btnAdd.textContent = '添加到对话'
  var btnCancel = document.createElement('button')
  setStyle(btnCancel, { background: '#2d2d2d', color: '#fff', fontSize: '12px', border: 'none', borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', whiteSpace: 'nowrap' })
  btnCancel.textContent = '取消'
  ab.appendChild(btnAdd)
  ab.appendChild(btnCancel)

  /* ---- 暂停/恢复悬浮按钮（右下角常驻入口） ---- */
  var chip = document.createElement('div')
  chip.setAttribute('data-dsh-we', 'chip')
  setStyle(chip, { position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483642', background: '#1e1e1e', color: '#fff', fontSize: '12px', fontFamily: 'system-ui,sans-serif', borderRadius: '16px', padding: '5px 12px', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.5)', userSelect: 'none' })
  chip.textContent = '⌖ 选择模式：开启（点击暂停，或按 `）'
  chip.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); togglePause() })

  var state = 'hover'
  var selEl = null
  var selData = null
  var paused = false

  document.documentElement.appendChild(ov)
  document.documentElement.appendChild(lb)
  document.documentElement.appendChild(ab)
  document.documentElement.appendChild(chip)

  /* ---- 数据采集 ---- */

  /**
   * 生成元素的 CSS 选择器：有 id 直接用 #id；否则沿父链向上最多 5 层，
   * 每段拼 tag.class1.class2（过滤下划线开头的工具类名），同标签兄弟
   * 多于 1 个时补 :nth-child 消歧，遇带 id 祖先即收敛。
   */
  function cSel(el) {
    if (el.id) return '#' + CSS.escape(el.id)
    var ps = [], nd = el
    while (nd && nd !== document.body && ps.length < 5) {
      var sg = nd.tagName.toLowerCase()
      if (nd.id) { ps.unshift('#' + CSS.escape(nd.id)); break }
      if (typeof nd.className === 'string' && nd.className.trim()) {
        var cls = nd.className.trim().split(/\s+/).filter(function (c) { return c.charAt(0) !== '_' }).slice(0, 2)
        if (cls.length) sg += '.' + cls.map(function (c) { return CSS.escape(c) }).join('.')
      }
      var pa = nd.parentElement
      if (pa) {
        var sibs = Array.prototype.filter.call(pa.children, function (c) { return c.tagName === nd.tagName })
        if (sibs.length > 1) sg += ':nth-child(' + (sibs.indexOf(nd) + 1) + ')'
      }
      ps.unshift(sg)
      nd = nd.parentElement
    }
    return ps.join(' > ')
  }

  /**
   * 生成人类可读的 DOM 路径：沿父链向上最多 8 层，
   * 每段为 `tag 类名（前 3 个）`，供模型理解元素在文档中的位置。
   */
  function domPath(el) {
    var parts = [], node = el, depth = 0
    while (node && node.nodeType === 1 && depth < 8) {
      var seg = node.tagName.toLowerCase()
      if (typeof node.className === 'string') {
        var cls = node.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ')
        if (cls) seg += ' ' + cls
      }
      parts.unshift(seg)
      node = node.parentElement
      depth++
    }
    return parts.join(' > ')
  }

  /**
   * 采集元素属性：固定的语义白名单（role/name/type/href/placeholder/
   * value/aria-label/title/alt/src）+ 最多 3 个 data-* 属性。
   */
  function collectAttrs(el) {
    var o = {}
    var keys = ['role', 'name', 'type', 'href', 'placeholder', 'value', 'aria-label', 'title', 'alt', 'src']
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i]
      var v = el.getAttribute(k)
      if (v != null && v !== '') o[k] = v
    }
    var dataKeys = []
    for (var j = 0; j < el.attributes.length && dataKeys.length < 3; j++) {
      var a = el.attributes[j]
      if (a.name.indexOf('data-') === 0 && !(a.name in o)) dataKeys.push(a.name)
    }
    for (var m = 0; m < dataKeys.length; m++) o[dataKeys[m]] = el.getAttribute(dataKeys[m])
    return o
  }

  /**
   * 文本去重并截断：折叠空白后，检测"整串由两半相同文本拼接"的重复
   * 模式（站点常见的 SEO 文本重复），重复则取一半；最长保留 500 字符。
   */
  function dedupe(raw) {
    var t = (raw || '').replace(/\s+/g, ' ').trim()
    if (!t) return ''
    var n = t.length
    for (var half = Math.floor(n / 2); half >= 2; half--) {
      if (t.slice(0, half) === t.slice(half, half * 2)) return t.slice(0, half).trim()
    }
    return t.slice(0, 500)
  }

  /** 汇总元素完整数据包（经 element-selected 事件透传给模型的载荷）。 */
  function collectData(el) {
    var rect = el.getBoundingClientRect()
    return {
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      textContent: dedupe(el.innerText || el.textContent || ''),
      cssSelector: cSel(el),
      domPath: domPath(el),
      attributes: collectAttrs(el),
      boundingRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      outerHTML: el.outerHTML.length > 800 ? el.outerHTML.slice(0, 800) + '...' : el.outerHTML,
      pageUrl: location.href,
      pageTitle: document.title,
      time: new Date().toISOString()
    }
  }

  /** 经 console 桥回传数据（协议：`__DSH_WE__:` 前缀 + JSON，勿改前缀）。 */
  function sendData(data) {
    console.log('__DSH_WE__:' + JSON.stringify(data))
  }

  /** 判断是否为本插件注入的 UI 元素（悬停/点选需排除自身）。 */
  function isOurEl(el) {
    return !!(el && el.closest && el.closest('[data-dsh-we]'))
  }

  /* ---- UI 辅助函数 ---- */

  /**
   * 操作栏定位：默认放在选中元素下方，下方放不下翻转到上方，
   * 再不行贴顶；水平方向同理向右溢出时左收，保证全程可见。
   */
  function positionAb(rect) {
    var abH = 36, margin = 6
    var top = rect.top + rect.height + margin
    if (top + abH > window.innerHeight - margin) top = rect.top - abH - margin
    if (top < 0) top = margin
    var measuredW = ab.offsetWidth || 0
    var abW = Math.min(Math.max(measuredW, 200), window.innerWidth - margin * 2)
    var left = rect.left
    if (left + abW > window.innerWidth - margin) left = window.innerWidth - abW - margin
    if (left < margin) left = margin
    ab.style.left = left + 'px'
    ab.style.top = top + 'px'
  }

  function showAb(el) {
    ab.style.display = 'flex'
    positionAb(el.getBoundingClientRect())
  }

  /** 点选锁定：覆盖层换成橙色边框定格在选中元素上，隐藏悬停标签。 */
  function lockOverlay(el) {
    var r = el.getBoundingClientRect()
    setStyle(ov, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', border: '2px solid #f59e0b' })
    lb.style.display = 'none'
  }

  /** 回到悬停态：清空选中数据并隐藏全部浮层。 */
  function returnToHover() {
    state = 'hover'
    selEl = null
    selData = null
    ab.style.display = 'none'
    ov.style.display = 'none'
    lb.style.display = 'none'
  }

  /* ---- 事件处理 ---- */

  /** 悬停高亮：mousemove 时用 elementFromPoint 取光标下元素并移动覆盖层/标签。 */
  function onMM(e) {
    if (paused || state !== 'hover') return
    var el = document.elementFromPoint(e.clientX, e.clientY)
    if (!el || isOurEl(el)) { ov.style.display = 'none'; lb.style.display = 'none'; return }
    var r = el.getBoundingClientRect()
    setStyle(ov, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', border: '2px solid #3b82f6' })
    lb.textContent = '<' + el.tagName.toLowerCase() + '> ' + Math.round(r.width) + 'x' + Math.round(r.height)
    lb.style.display = 'block'
    lb.style.left = r.left + 'px'
    lb.style.top = Math.max(0, r.top - 22) + 'px'
  }

  /**
   * 点选：pointerdown 捕获阶段拦截（阻止页面自身交互），hover 态选中
   * 并锁定元素；selected 态再点页面任意处则放弃当前选中回到 hover。
   */
  function onPD(e) {
    if (paused) return
    if (e.button === 2) return
    if (isOurEl(e.target)) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    var target = document.elementFromPoint(e.clientX, e.clientY)
    if (!target || isOurEl(target)) return
    if (state === 'hover') {
      selEl = target
      selData = collectData(target)
      state = 'selected'
      logDebug('选中元素: <' + selData.tagName + '> ' + selData.cssSelector)
      lockOverlay(target)
      showAb(target)
    } else {
      returnToHover()
    }
  }

  /** 选择模式下吞掉页面的 mouseup/pointerup/click，防止触发页面自身行为。 */
  function onBlockUp(e) {
    if (paused || isOurEl(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  /** 选择模式下的键盘：` 暂停/恢复，Escape 退出选择模式。 */
  function onKD(e) {
    if (e.key === '`') {
      e.preventDefault()
      e.stopPropagation()
      togglePause()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      exitMode()
    }
  }

  /** 暂停态下唯一保留的键盘监听：` 恢复（其余监听已摘除）。 */
  function onBacktick(e) {
    if (e.key === '`') {
      e.preventDefault()
      e.stopPropagation()
      togglePause()
    }
  }

  function togglePause() {
    if (paused) resume()
    else pause()
  }

  /**
   * 暂停选择：摘除全部拦截监听（页面恢复可交互，供登录等人工操作），
   * 只留 ` 键恢复入口；清空选中态并隐藏浮层。
   */
  function pause() {
    paused = true
    document.removeEventListener('mousemove', onMM, true)
    document.removeEventListener('pointerdown', onPD, true)
    document.removeEventListener('mouseup', onBlockUp, true)
    document.removeEventListener('pointerup', onBlockUp, true)
    document.removeEventListener('click', onBlockUp, true)
    document.removeEventListener('keydown', onKD, true)
    document.addEventListener('keydown', onBacktick, true)
    ov.style.display = 'none'
    lb.style.display = 'none'
    ab.style.display = 'none'
    document.documentElement.style.cursor = ''
    chip.textContent = '⌖ 选择模式：已暂停（点击恢复，或按 `）'
    state = 'hover'
    selEl = null
    selData = null
    logDebug('选择模式已暂停')
  }

  /** 恢复选择：重新挂载全部监听，光标换成十字准星。 */
  function resume() {
    paused = false
    document.removeEventListener('keydown', onBacktick, true)
    document.addEventListener('mousemove', onMM, true)
    document.addEventListener('pointerdown', onPD, true)
    document.addEventListener('mouseup', onBlockUp, true)
    document.addEventListener('pointerup', onBlockUp, true)
    document.addEventListener('click', onBlockUp, true)
    document.addEventListener('keydown', onKD, true)
    document.documentElement.style.cursor = 'crosshair'
    chip.textContent = '⌖ 选择模式：开启（点击暂停，或按 `）'
    logDebug('选择模式已恢复')
  }

  /* ---- 按钮 ---- */

  /** 「添加到对话」：把选中数据包桥接给 helper，然后退出选择模式。 */
  btnAdd.addEventListener('click', function (e) {
    e.stopPropagation()
    if (!selEl || !selData) return
    var data = {}
    for (var k in selData) data[k] = selData[k]
    data.action = 'add-to-chat'
    logDebug('回传元素数据: <' + data.tagName + '> ' + data.cssSelector)
    sendData(data)
    exitMode()
  })

  /** 「取消」：放弃当前选中，回到悬停态。 */
  btnCancel.addEventListener('click', function (e) {
    e.stopPropagation()
    returnToHover()
  })

  /* ---- 操作栏按钮的悬浮样式 ---- */
  ;[btnAdd, btnCancel].forEach(function (b) {
    b.addEventListener('mouseenter', function () { b.style.background = '#3d3d3d' })
    b.addEventListener('mouseleave', function () { b.style.background = '#2d2d2d' })
  })

  /* ---- 首次运行提示（每会话一次，3 秒淡出） ---- */
  try {
    if (!sessionStorage.getItem('__dsh_we_hint__')) {
      sessionStorage.setItem('__dsh_we_hint__', '1')
      var th = document.createElement('div')
      setStyle(th, { position: 'fixed', bottom: '64px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483643', background: 'rgba(30,30,30,0.92)', color: '#fff', fontSize: '12px', fontFamily: 'system-ui,sans-serif', padding: '7px 16px', borderRadius: '20px', pointerEvents: 'none', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,0.45)', transition: 'opacity 0.4s' })
      th.textContent = '🔍 页面元素选择已开启 · 点击元素后点「添加到对话」 · 按 ` 暂停'
      document.documentElement.appendChild(th)
      setTimeout(function () { th.style.opacity = '0' }, 2600)
      setTimeout(function () { if (th.parentNode) th.parentNode.removeChild(th) }, 3000)
    }
  } catch (err) {}

  /* ---- 激活：挂载全部监听（捕获阶段），光标换成十字准星 ---- */
  document.addEventListener('mousemove', onMM, true)
  document.addEventListener('pointerdown', onPD, true)
  document.addEventListener('mouseup', onBlockUp, true)
  document.addEventListener('pointerup', onBlockUp, true)
  document.addEventListener('click', onBlockUp, true)
  document.addEventListener('keydown', onKD, true)
  document.documentElement.style.cursor = 'crosshair'

  /* ---- 退出选择模式：通知 host，然后移除所有元素 ---- */
  function exitMode() {
    try {
      logDebug('退出选择模式')
      sendData({ action: 'exit-mode', pageUrl: location.href, pageTitle: document.title })
    } catch (err) {}
    cleanupAll()
  }

  /* ---- 清理 ---- */
  window.__dsh_we_test_state__ = function () { return state }
  /** 全量清理：摘除监听、移除注入 DOM、恢复光标、删除全局标记（供退出与重复注入前调用）。 */
  function cleanupAll() {
    document.removeEventListener('mousemove', onMM, true)
    document.removeEventListener('pointerdown', onPD, true)
    document.removeEventListener('mouseup', onBlockUp, true)
    document.removeEventListener('pointerup', onBlockUp, true)
    document.removeEventListener('click', onBlockUp, true)
    document.removeEventListener('keydown', onKD, true)
    document.removeEventListener('keydown', onBacktick, true)
    var els = [ov, lb, ab, chip]
    for (var i = 0; i < els.length; i++) {
      if (els[i].parentNode) els[i].parentNode.removeChild(els[i])
    }
    document.documentElement.style.cursor = ''
    delete window.__dsh_we_active__
    delete window.__dsh_we_cleanup__
    delete window.__dsh_we_test_state__
    logDebug('inspector 已清理')
  }
  window.__dsh_we_cleanup__ = cleanupAll
})()
