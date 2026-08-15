'use strict'
console.log('DRIVE-START')
// simulate a user picking #target, then click the injected 添加到对话 button
setTimeout(function () {
  var el = document.getElementById('target')
  console.log('DRIVE-EL-FOUND ' + Boolean(el))
  if (!el) return
  var r = el.getBoundingClientRect()
  var ev = new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0
  })
  el.dispatchEvent(ev)
  console.log('DRIVE-POINTERDOWN-DISPATCHED')
}, 2500)
var tries = 0
var iv = setInterval(function () {
  var b = document.querySelector('[data-dsh-pe-add]')
  var selected = window.__dsh_pe_test_state__ && window.__dsh_pe_test_state__() === 'selected'
  if (b && selected) { console.log('DRIVE-CLICK-ADD'); b.click(); clearInterval(iv); return }
  if (++tries > 60) { console.log('DRIVE-GAVE-UP selected=' + String(window.__dsh_pe_test_state__ && window.__dsh_pe_test_state__())); clearInterval(iv) }
}, 250)
