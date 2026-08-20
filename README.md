# dsh-webpage-element-picker

DSH（DeepSeek Harness）动态插件：在对话输入框工具行提供一个十字图标按钮，打开内置 Electron 浏览器、注入元素选择脚本，把选中的页面元素以 `[标签][DOMn]` 引用式占位符加入输入框，完整信息由模型按需通过 `read_picked_element` 工具读取。

## 特性

- 输入框工具行纯图标入口（`conversation.input.left`），状态信息显示在 tooltip
- 使用系统已安装的浏览器（自动探测 Chrome > Edge > Chromium > Brave > Opera，**绝不下载任何浏览器**）：通过 `npm` 安装约 13MB 的 `playwright-core` 运行时（仅一次），之后秒开
- 页面注入元素选择脚本：悬浮高亮 → 点击锁定 → 「添加到对话」；`` ` `` 键或页面右下角按钮可暂停/恢复（登录场景）；Esc 退出选择模式
- 选中元素后输入框插入 markdown 引用式占位符：`[提交订单][DOM1]`（标签取元素文本/无障碍属性/tag#id，最长 10 字）
- Host 注册动态工具 `read_picked_element`：模型按编号读取完整元素信息（HTML/CSS选择器/DOM路径/属性/位置尺寸/URL）
- 系统提示注入一行一元素的摘要清单（极小），把占位符与元素信息关联
- 登录态持久化（独立浏览器 profile），登录后可重新「打开」跳转+注入

## 安装

适用对象：DSH（本仓库部署形态）的 `web` profile。需要机器有 **Node.js（含 npm）**、到 npm 源的网络，以及系统已安装 **Chrome / Edge / Chromium / Brave / Opera 之一**（Windows）。

### 构建

本仓库是 TypeScript 源码 + tsup 构建的组合包（`lib/` 为构建产物，不入库，克隆后需先构建）：

```sh
pnpm install
pnpm build        # tsup：src/host → lib/index.js（ESM），src/client → lib/client.js（loader 包裹）
```

`pnpm watch` 可持续构建；`pnpm test` 跑 `tsc --noEmit` 类型检查。

### 长期安装：bundle + profile

本仓库是符合 DSH **组合包（bundle）** 格式的 npm 包：

- `package.json` 声明 `dsh.bundle`（`cordis.patch.yml` 配置层）与 `dsh.client`（浏览器半 `exports["./client"]`）；
- host 半 `src/host/index.ts`（构建为 `lib/index.js`）是原生 Cordis 插件，`inject` 声明的七个服务就绪后才运行；client 半 `src/client/index.ts`（构建为 `lib/client.js`，`window.__ModuleLoader__.load` 工厂，唯一外部依赖 `react`）；
- `cordis.patch.yml` 插入一行 `name: dsh-webpage-element-picker`，同一行同时被 Loader（host 半）和 client-modules 扫描（浏览器半）使用。

在插件 checkout 内执行（`dsh` CLI 与 pnpm 需在 PATH 上）：

```sh
pnpm install && pnpm build   # 首次，或修改 src/ 后
pnpm dsh plugin --profile web add .
```

首次执行会自动初始化 `web` profile（若缺失）并把本包加入 `$DSH_HOME/profiles/web` 的 `dsh.profile.bundles` 层栈（`dsh plugin` 检测到 `dsh.bundle` 声明后自动追加）。随后**重启** `dsh web` 进程，输入框工具行即出现十字图标。

- 验证层已生效：`pnpm dsh --profile web --dump-config` 应出现 `# == dsh-webpage-element-picker` 层与 `webpage-element-picker` 行。
- 卸载：`pnpm dsh plugin --profile web remove dsh-webpage-element-picker`。
- 修改 `src/` 后需重跑 `pnpm build` 再重启 `dsh web`（client-modules 按 bundle rev 缓存，仅 HMR 开发模式可热更）。
- 无 npm 发布也可分发：`pnpm build && pnpm pack` 出 tarball 后 `pnpm dsh plugin --profile web add ./dsh-webpage-element-picker-<ver>.tgz`。

## 使用

1. 点击十字图标 → 「添加页面元素」对话框输入网址 → 「打开」（成功后对话框自动隐藏）。
2. 在浏览器页面中点击元素 → 「添加到对话」→ 输入框插入 `[标签][DOMn]`；选择模式随即退出。
3. 继续输入你的问题（如「把 [提交订单][DOM1] 改成红色」）并发送。
4. 模型需要细节时自动调用 `read_picked_element` 工具读取完整数据。
5. 登录场景：页面右下角「选择模式」悬浮按钮（或按 ` 键）暂停 → 登录 → 回到对话框点「仅重新注入」在当前页面恢复选择（如需回到输入的网址则点「打开」重新跳转+注入）。

## 目录结构

```
src/
  host/
    index.ts       # Host 半：原生 Cordis 插件（子进程/路由/工具/系统提示），构建为 lib/index.js
    services.ts    # Host 侧服务接口（subprocess/webServer/fs/tools/…，type-only）
  client/
    index.ts       # Client 半：conversation.input.left 十字图标 + 对话框，构建为 lib/client.js
    services.ts    # Client 侧服务接口（slots/输入框标准 props，type-only）
    react.ts       # 由注入 require 取得 react 的唯一入口
    globals.d.ts   # 浏览器 bundle 的运行时全局（require/module/exports）声明
  shared/
    types.ts       # host ↔ client 经 HTTP 交换的状态/事件形状（type-only）
resources/         # 运行时资源（四个文件：bootstrap.cjs / helper-playwright.js / inspector.js / browser-probe.cjs）
  test/            # 冒烟测试（driver + CSP 测试页 + 窗口可见性检查）
tsup.config.ts     # 双入口构建：host→ESM，client→CJS+loader 包裹
tsconfig.json
cordis.patch.yml   # bundle 配置层：插入 name: dsh-webpage-element-picker 行
```

## 架构

```
DSH Host(插件) ──subprocess──▶ node bootstrap.cjs
      │                             ├─ npm install playwright-core@固定版本（自有缓存，无浏览器下载）
      │                             ├─ browser-probe.cjs：探测系统浏览器（Chrome>Edge>Chromium>Brave>Opera，
      │                             │   无头启动验证，结果缓存 browser-config.json；全失败→报错退出，绝不下载）
      │                             └─▶ node helper-playwright.js（playwright-core 驱动系统浏览器）
      │  ▲ 命令长轮询 /dsh-webpage-element-picker/poll                        │
      │  └── 事件 POST  /dsh-webpage-element-picker/events ◀──────────────────┘
      ├─ ctx.tools.register：read_picked_element
      ├─ ctx.systemPrompt.context：DOMn 摘要清单
      └─ POST /dsh-webpage-element-picker/invoke：picker-navigate/reinject/status/close/pull
DSH Client(插件) ── conversation.input.left 图标 ── fetch /invoke ──▶ Host
```

浏览器与 DSH 之间不依赖进程管道传递数据（Chromium 在 Windows 上会关闭 stdin），命令与事件都走 DSH 自带 HTTP 服务器上的路由：helper 用 `/poll`（长轮询）+ `/events`，浏览器 UI 用 `/invoke`（同源 fetch，复用同一命令队列与应答关联）。

## 已知限制

- bundle 形态跨 DSH 重启持久（`dsh.profile.bundles` 层）。
- 目标平台为 Windows；需要系统已安装 Chrome/Edge/Chromium/Brave/Opera 之一。原生 Firefox 无法被 Playwright 驱动，不在支持列表；macOS/Linux 未验证。
- 严格 CSP 页面（`style-src` 禁内联样式）上高亮框的视觉效果会被浏览器拦截，但选择逻辑不受影响。
- 同一 DSH 进程内多个 profile/实例同时运行本插件时，HTTP 路由存在占用冲突（后者注册失败并告警）。
- 首次打开需要联网安装 playwright-core 运行时（约 13MB，仅一次）；无网络或系统无浏览器时会给出明确报错。

## License

MIT
