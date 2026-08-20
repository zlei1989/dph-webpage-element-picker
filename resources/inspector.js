(function () {
  'use strict'
  if (window.__dsh_we_active__) return
  window.__dsh_we_active__ = true

  function setStyle(el, s) { for (var k in s) el.style[k] = s[k] }

  /* ---- hover overlay ---- */
  var ov = document.createElement('div')
  ov.setAttribute('data-dsh-we', 'ov')
  setStyle(ov, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483640', border: '2px solid #3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', borderRadius: '3px', display: 'none' })

  /* ---- hover label ---- */
  var lb = document.createElement('div')
  lb.setAttribute('data-dsh-we', 'lb')
  setStyle(lb, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483640', backgroundColor: '#3b82f6', color: '#fff', fontSize: '11px', fontFamily: 'monospace', padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap', display: 'none' })

  /* ---- action bar ---- */
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

  /* ---- pause/resume chip ---- */
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

  /* ---- data collection ---- */
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

  function dedupe(raw) {
    var t = (raw || '').replace(/\s+/g, ' ').trim()
    if (!t) return ''
    var n = t.length
    for (var half = Math.floor(n / 2); half >= 2; half--) {
      if (t.slice(0, half) === t.slice(half, half * 2)) return t.slice(0, half).trim()
    }
    return t.slice(0, 500)
  }

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

  function sendData(data) {
    console.log('__DSH_WE__:' + JSON.stringify(data))
  }

  function isOurEl(el) {
    return !!(el && el.closest && el.closest('[data-dsh-we]'))
  }

  /* ---- UI helpers ---- */
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

  function lockOverlay(el) {
    var r = el.getBoundingClientRect()
    setStyle(ov, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', border: '2px solid #f59e0b' })
    lb.style.display = 'none'
  }

  function returnToHover() {
    state = 'hover'
    selEl = null
    selData = null
    ab.style.display = 'none'
    ov.style.display = 'none'
    lb.style.display = 'none'
  }

  /* ---- handlers ---- */
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
      lockOverlay(target)
      showAb(target)
    } else {
      returnToHover()
    }
  }

  function onBlockUp(e) {
    if (paused || isOurEl(e.target)) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }

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
  }

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
  }

  /* ---- buttons ---- */
  btnAdd.addEventListener('click', function (e) {
    e.stopPropagation()
    if (!selEl || !selData) return
    var data = {}
    for (var k in selData) data[k] = selData[k]
    data.action = 'add-to-chat'
    sendData(data)
    exitMode()
  })

  btnCancel.addEventListener('click', function (e) {
    e.stopPropagation()
    returnToHover()
  })

  /* ---- hover styles for bar buttons ---- */
  ;[btnAdd, btnCancel].forEach(function (b) {
    b.addEventListener('mouseenter', function () { b.style.background = '#3d3d3d' })
    b.addEventListener('mouseleave', function () { b.style.background = '#2d2d2d' })
  })

  /* ---- first-run toast ---- */
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

  /* ---- activation ---- */
  document.addEventListener('mousemove', onMM, true)
  document.addEventListener('pointerdown', onPD, true)
  document.addEventListener('mouseup', onBlockUp, true)
  document.addEventListener('pointerup', onBlockUp, true)
  document.addEventListener('click', onBlockUp, true)
  document.addEventListener('keydown', onKD, true)
  document.documentElement.style.cursor = 'crosshair'

  /* ---- exit selection mode: notify the host, then remove everything ---- */
  function exitMode() {
    try {
      sendData({ action: 'exit-mode', pageUrl: location.href, pageTitle: document.title })
    } catch (err) {}
    cleanupAll()
  }

  /* ---- cleanup ---- */
  window.__dsh_we_test_state__ = function () { return state }
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
  }
  window.__dsh_we_cleanup__ = cleanupAll
})()
