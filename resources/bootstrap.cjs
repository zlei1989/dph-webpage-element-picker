'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const readline = require('readline')

const dir = path.join(os.tmpdir(), 'dsh-page-picker')
fs.mkdirSync(dir, { recursive: true })
// npx 模式：argv[2] = node 可执行的 npx 脚本入口（<nodeDir>/node_modules/npm/bin/npx-cli.js）
// 启动形状：node npx-cli.js --yes --cache <自有缓存目录> electron@40 <appDir> <port>
// 使用自有缓存目录：绕开用户级 npm 缓存配置（可能是无写权限的位置）
const npxCache = path.join(dir, 'npx-cache')
fs.mkdirSync(npxCache, { recursive: true })
const npxCli = process.argv[2]
const port = process.argv[3]
if (!npxCli) {
  console.error('bootstrap: missing npx cli script argument')
  process.exit(2)
}

process.stdout.write('READY\n')

let mode = 'payload'
let parts = []
let child = null

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (mode === 'payload') {
    if (line === '<<<DSH_END>>>') {
      const input = parts.join('\n')
      const marker = '<<<DSH_SPLIT>>>'
      const i = input.indexOf(marker)
      if (i < 0) {
        console.error('bootstrap: payload missing split marker')
        process.exit(2)
      }
      fs.writeFileSync(path.join(dir, 'helper-main.js'), input.slice(0, i))
      fs.writeFileSync(path.join(dir, 'inspector.js'), input.slice(i + marker.length))
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'dsh-page-picker',
        main: 'helper-main.js',
        version: '1.0.0',
      }))
      const args = ['--yes', '--cache', npxCache, 'electron@40', dir]
      if (port) args.push(port)
      // 覆盖 Electron 二进制镜像：用户级 .npmrc 可能指向已停服的镜像（如 npm.taobao.org）。
      // @electron/get 的优先级是 npm_config_electron_mirror > ELECTRON_MIRROR，
      // 而 npm 会把 .npmrc 注入生命周期环境，所以必须同时设置两者（环境变量形式的
      // npm_config_* 优先级高于 .npmrc 文件）。
      child = cp.spawn(process.execPath, [npxCli, ...args], {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
          ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
          npm_config_electron_mirror: 'https://npmmirror.com/mirrors/electron/',
        }),
      })
      child.on('error', (err) => {
        console.error('bootstrap: npx spawn failed: ' + err.message)
        process.exit(3)
      })
      child.on('exit', (code) => { process.exit(code == null ? 1 : code) })
      child.stdout.on('data', (d) => { process.stdout.write(d) })
      child.stderr.on('data', (d) => { process.stderr.write(d) })
      mode = 'pump'
    } else {
      parts.push(line)
    }
    return
  }
  // stdin of electron is closed by Chromium on Windows; nothing to pump
})

rl.on('close', () => {})
