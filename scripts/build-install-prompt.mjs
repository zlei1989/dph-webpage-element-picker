// 从 plugin/host.js + plugin/client.js 生成 install-prompt.md（安装指令，粘贴给 DSH agent 用）
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const host = readFileSync(join(root, 'plugin', 'host.js'), 'utf8').trimEnd()
const client = readFileSync(join(root, 'plugin', 'client.js'), 'utf8').trimEnd()

const md = [
  '# 安装指令（粘贴给 DSH 会话的 agent）',
  '',
  '前置：把本仓库 `resources/` 下的三个文件（bootstrap.cjs、helper-main.js、inspector.js）放到以下任意一个目录（插件按顺序查找，命中即用）：',
  '  1. `~/.dsh/_dsh-page-picker/`（DSH 家目录，默认）',
  '  2. `~/.dph/_dsh-page-picker/`',
  '  3. `<DSH 工作区>/_dsh-page-picker/`（兜底）',
  '',
  '然后在 DSH 网页 GUI 中新建一个 `cordis` 预设的会话，把下面整段内容发给 agent：',
  '',
  '---- 从这里开始复制 ----',
  '请帮我定义并运行「页面元素选择」插件。定义用 cordis_define（kind: new，idPrefix 自选如 pagep），之后用 run 模式激活。激活后如果出现审批卡请允许。',
  'Host 代码开始：',
  host,
  'Host 代码结束',
  'Client 代码开始：',
  client,
  'Client 代码结束',
  '---- 复制到这里结束 ----',
  '',
  '完成标准：输入框工具行出现十字图标；图标 tooltip 显示「打开内置浏览器并选择页面元素」。',
].join('\n')

writeFileSync(join(root, 'install-prompt.md'), md + '\n')
console.log('install-prompt.md generated')
