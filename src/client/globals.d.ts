/**
 * 浏览器 bundle 的运行时全局变量。Client 半边以 CJS 闭包形式发布，
 * 包裹在 web boot 握手中（`window.__ModuleLoader__.load`）：
 * React 通过注入的 `require` 到达，握手中的 `module.exports` 是
 * loader 读取的内容。在此声明，以便严格类型检查能识别它们。
 */

declare function require(id: string): any
declare var module: { exports: Record<string, unknown> }
declare var exports: Record<string, unknown>
