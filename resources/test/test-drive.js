'use strict'
// 冒烟测试页面脚本（由 test-page.html 引用）：模拟用户操作——
// 延时向 #target 派发 pointerdown 触发 inspector 选中，然后轮询等待
// 「添加到对话」按钮出现并点击，全程用 DRIVE-* 控制台输出标记进度
// （driver.cjs 经 helper 的 console 桥/页面事件间接验证选择链路）。
console.log('DRIVE-START')
// 模拟用户选择 #target，然后点击注入的「添加到对话」按钮
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
  var b = document.querySelector('[data-dsh-we-add]')
  var selected = window.__dsh_we_test_state__ && window.__dsh_we_test_state__() === 'selected'
  if (b && selected) { console.log('DRIVE-CLICK-ADD'); b.click(); clearInterval(iv); return }
  if (++tries > 60) { console.log('DRIVE-GAVE-UP selected=' + String(window.__dsh_we_test_state__ && window.__dsh_we_test_state__())); clearInterval(iv) }
}, 250)
