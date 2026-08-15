# dsh-webpage-element-picker

DSH（DeepSeek Harness）动态插件：在对话输入框工具行提供一个十字图标按钮，打开内置 Electron 浏览器、注入元素选择脚本，把选中的页面元素以 `[标签][DOMn]` 引用式占位符加入输入框，完整信息由模型按需通过 `read_picked_element` 工具读取。

## 特性

- 输入框工具行纯图标入口（`conversation.input.left`），状态信息显示在 tooltip
- 内置 Electron 浏览器（**零安装**：通过 `npx --yes electron@40` 自动下载到自有缓存，首次约 1-3 分钟，之后秒开）
- 页面注入元素选择脚本：悬浮高亮 → 点击锁定 → 「添加到对话」；`` ` `` 键或页面右下角按钮可暂停/恢复（登录场景）；Esc 退出选择模式
- 选中元素后输入框插入 markdown 引用式占位符：`[提交订单][DOM1]`（标签取元素文本/无障碍属性/tag#id，最长 10 字）
- Host 注册动态工具 `read_picked_element`：模型按编号读取完整元素信息（HTML/CSS选择器/DOM路径/属性/位置尺寸/URL）
- 系统提示注入一行一元素的摘要清单（极小），把占位符与元素信息关联
- 登录态持久化（独立 partition），登录后可重新「打开」跳转+注入

## 安装

适用对象：DSH（本仓库部署形态）的 `cordis` 预设会话。需要机器有 **Node.js（含 npm/npx）** 和到 npm 源的网络。

1. 放置 `resources/`（三个文件：`bootstrap.cjs`、`helper-main.js`、`inspector.js`）。插件按以下顺序自动查找，命中即用，无需改代码：
   - `~/.dsh/_dsh-page-picker/`（DSH 家目录，默认）
   - `<DSH 工作区>/_dsh-page-picker/`（兜底）
2. 打开 DSH 网页 GUI，新建 `cordis` 预设会话。
3. 运行 `node scripts/build-install-prompt.mjs` 生成 `install-prompt.md`（或直接使用仓库里的版本），把整段内容发给该会话的 agent。
4. agent 会执行 `cordis_define` + `cordis_run`；在审批卡上点允许。
5. 输入框工具行出现十字图标即安装完成。

## 使用

1. 点击十字图标 → 「添加页面元素」对话框输入网址 → 「打开」（成功后对话框自动隐藏）。
2. 在浏览器页面中点击元素 → 「添加到对话」→ 输入框插入 `[标签][DOMn]`；选择模式随即退出。
3. 继续输入你的问题（如「把 [提交订单][DOM1] 改成红色」）并发送。
4. 模型需要细节时自动调用 `read_picked_element` 工具读取完整数据。
5. 登录场景：页面右下角「选择模式」暂停 → 登录 → 回到对话框点「打开」重新跳转+注入。

## 目录结构

```
plugin/
  host.js        # 插件 Host 半（cordis_define 的 code.host）
  client.js      # 插件 Client 半（code.client）
resources/       # 运行时资源（三个文件：bootstrap.cjs / helper-main.js / inspector.js）
  test/          # 冒烟测试（driver + CSP 测试页 + 窗口可见性检查）
scripts/
  build-install-prompt.mjs  # 由 plugin/*.js 生成 install-prompt.md
install-prompt.md  # 发给 DSH agent 的安装指令
```

## 架构

```
DSH Host(插件) ──subprocess──▶ node bootstrap.cjs ──npx──▶ electron(helper-main.js)
      │  ▲ 命令长轮询 /dsh-page-picker/poll                        │
      │  └── 事件 POST  /dsh-page-picker/events ◀──────────────────┘
      ├─ systemPrompt.context：DOMn 摘要清单
      ├─ harness.registerTool：read_picked_element
      └─ harness.handle：picker-navigate/reinject/status/close/pull
DSH Client(插件) ── conversation.input.left 图标 ── host.call ──▶ Host
```

浏览器与 DSH 之间不依赖进程管道传递数据（Electron 在 Windows 上会关闭 stdin），命令与事件都走 DSH 自带 HTTP 服务器上的两条路由。

## 已知限制

- 动态插件存在于会话/进程内：DSH 重启后需重新 define + run（重新执行 install-prompt.md 即可）。
- 目标平台为 Windows（Electron 桌面窗口）；macOS/Linux 未验证。
- 严格 CSP 页面（`style-src` 禁内联样式）上高亮框的视觉效果会被浏览器拦截，但选择逻辑不受影响。
- 同一 DSH 进程内多个会话同时运行本插件时，HTTP 路由存在占用冲突（后者注册失败并告警）。
- 首次打开需要下载 Electron（约 100-200MB），插件已把打开超时放宽到 4 分钟。

## License

MIT
