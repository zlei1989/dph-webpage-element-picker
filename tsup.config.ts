import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'tsup'

// 从 cwd 读取 manifest，而非 import.meta.url：tsup 会将此配置重新打包
// 到一个临时 .mjs 文件中运行，所以 import.meta.url 指向的是那个临时文件，
// 而非此源文件。在 `npm run build` 下，process.cwd() 是包根目录。
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Client bundle 包裹：每个 `dsh.client` 包的 `./client` 导出必须使用的
// 闭包工厂格式。浏览器 loader 从其模块表回答平台模块（react）的 `require`，
// 并读取 `module.exports` 作为插件表面。
const CLIENT_BANNER = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`
const CLIENT_FOOTER = `
    return module.exports;
  },
});
`

export default defineConfig([
  // ---- host 半边：打包 TS → ESM，由 profile loader 作为包 main 加载。
  // 仅导入 node 内置模块，无外部依赖保留。 ----
  {
    name: 'host',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    outExtension: () => ({ js: '.js' }),
    clean: true,
    sourcemap: false,
    dts: false,
  },
  // ---- client 半边：打包 TS → CJS，包裹在 loader 握手中 -------
  // react 是浏览器模块表在运行时提供的平台模块；
  // 其余所有内容由打包器内联。
  {
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2020',
    external: ['react'],
    outExtension: () => ({ js: '.js' }),
    clean: false,
    sourcemap: false,
    dts: false,
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
    // 源码中的 `module.exports = {}` 是 loader 契约（上面的包裹
    // 提供了局部 `var module`）；静默该警告。
    esbuildOptions: (options) => {
      options.logOverride = { 'commonjs-variable-in-esm': 'silent' }
    },
  },
])
