# 悦读 / YueDuo

本地 TXT 小说管理与阅读器：编辑器界面即阅读界面。标签栏、单 Monaco 实例、每标签一个 model，视觉与交互对齐 VS Code / Chrome。

这份 README 面向「未来的自己和协作者」，只写怎么跑起来、环境怎么隔离、数据放在哪。实现约定与硬约束以 [AGENTS.md](AGENTS.md) 为准，目录职责与数据流见 [.trae/documents/architecture.md](.trae/documents/architecture.md)，这里不重复展开。

## 技术栈

| 层 | 选型 | 版本 |
| --- | --- | --- |
| 桌面运行时 | Electron（内置 Node 24 / ABI 150） | 45.3.3 |
| 渲染层 | Vue 3 + Pinia | 3.5.x / 4.1.x |
| 类型 | TypeScript（严格模式） | 5.9.3 |
| 编辑器 | Monaco Editor | 0.57.x |
| 存储 | better-sqlite3（N-API 预编译） | 13.2.x |
| 构建 | electron-vite 6 + Vite 8 + electron-builder 26 | — |

TypeScript 锁在 `^5.9.3`（5.x 末版）不是随手写的：npm 上 `latest` 已是 7.0.2，TS 7 是原生移植，包内只有 `lib/version.cjs` 与 `unstable/*`，不提供 `lib/typescript.js` 编译 API，而 vue-tsc / Volar 的 SFC 类型检查依赖这个 API；ts 6.0.x 仍带 API 但属过渡桥，typescript-eslint 8.73 的 peer 也只到 `<6.1.0`。因此禁止把版本写成 `latest`、`*` 或 `>=5.9`。

## 常用命令

```bash
npm install            # 安装依赖；postinstall 会跑 install-electron 与 electron-builder install-app-deps
npm run dev            # 开发模式：electron-vite dev，起 Vite dev server 并启动 Electron
npm run build          # 先 typecheck（node + web），再 electron-vite build 产出 out/
npm run typecheck      # tsc 检查主进程/preload/shared，vue-tsc 检查渲染层
npm run lint           # eslint --cache .
npm run verify:native  # 在 Electron 进程内真实 require better-sqlite3 并建表插查
npm run format         # prettier --write .
```

打包时先 `npm run build`，再按平台出包：`npm run build:mac` 跟随本机架构（Intel 出 x64，Apple Silicon 出 arm64），`build:mac:x64` / `build:mac:arm64` 显式指定架构；`build:win`、`build:linux` 同理。只想验证打包结构可用 `npm run build:unpack`（输出目录未压缩的 app）。`npm start` 是 `electron-vite preview`，预览已构建产物。

纯 Node 验收脚本在 `scripts/test-*.ts`，用 `npx tsx scripts/test-xxx.ts` 直接跑，测试数据在脚本内构造，不需要 Electron。

## 开发环境隔离

开发态与打包版的数据完全分开，避免调试时写坏正式书库：

- 存在 `ELECTRON_RENDERER_URL` 即判定为开发态（Electron 45 从 `node_modules` 启动时 `app.isPackaged` 会误报 `true`，不能拿它判断）。
- 开发态 `userData` 固定指向项目内 `.dev/user-data`（已 gitignore、不进包），打包版仍用系统默认 `userData`。
- 需要把设置与数据库指到别处时，设 `YUE_USER_DATA=<目录>`；自动化验收用它指向临时目录。
- 开发态未设置书库根时默认打开 `/Users/Joey/Sites/Projects/小说`（复制出来的测试库）；打包版默认为空，由用户选择。切到其它路径会先弹确认，因为扫描会写 Finder 星级/注释。
- `YUE_TEST=1 npm run dev`：自动化验收模式。不显示窗口、不进 Dock、不抢前台，删除确认框直接放行，关窗 flush 完成后直接退出。配合 `YUE_DEBUG=1` 开 CDP 9222，用 `scripts/cdp-eval.mjs` / `scripts/cdp-shot.mjs` 执行 JS 与截图。
- 单实例锁：已有实例在跑时，再次启动会静默退出（退出码 0）。「改完主进程起不来」先查有没有残留进程；electron-vite 只重建 `out/main`，不重启 Electron，改主进程后要整个实例重启。

## 打包与签名

配置在 [electron-builder.yml](electron-builder.yml)：

- macOS 用 ad-hoc 签名（`identity: '-'`），`hardenedRuntime: false`、`notarize: false`，只保证本机运行，不需要开发者证书，也不做公证。
- Electron 语言包只保留 `en` 与 `zh_CN`，Framework 里其余 `.lproj` 约 17M 在打包时剔除。
- better-sqlite3 的预编译产物按目标架构裁剪：配置里保留 macOS 的 x64/arm64 两份 prebuild，打包后由 [build/afterPack.mjs](build/afterPack.mjs) 按 `context.arch` 删掉不匹配的那份。所以 Intel 与 Apple Silicon 上都直接 `npm run build:mac` 即可，包内只有 `darwin-<arch>.node` 一份；其它平台的 prebuild 与源码不进包。dmg 文件名不带架构，同一目录先后构建两个架构会互相覆盖，想同时留两份用 `--dir`（分别落在 `dist/mac` 与 `dist/mac-arm64`）。
- `npmRebuild: false`：better-sqlite3 13.x 自带 N-API 预编译，不需要 rebuild；升级 Electron 或 better-sqlite3 后跑 `npm run verify:native`。

## 数据位置

- 每个书库一份数据库：首选 `<书库根>/yueduo.db`，`relative_path` 相对书库根。
- 书库根不可写时回落到 `<userData>/library-db/<realpath 哈希>.db`，按库隔离，不共用。
- 设置写在 `<userData>/settings.json`（先写临时文件再 rename）。
- 会话标签、阅读进度、草稿全文都在当前书库的数据库里；换库会切到新库的会话。

## 项目结构

```
electron/   主进程：ipc/ 按域收敛参数，services/ 纯 Node 业务（不 import Electron）
shared/     两侧共用纯函数与跨进程类型
src/        渲染层：components/ + composables/ + stores/ + ipc/bridge.ts
scripts/    纯 Node 验收脚本与 CDP 工具
resources/  打包图标与简繁转换词表
```

- 跨进程唯一通道：preload 通过 `contextBridge` 暴露 `window.yue.invoke`，渲染层只经 `src/ipc/bridge.ts` 调用，渲染层不 import Node 模块。
- 全文只存在 Monaco model（`useTabLifecycle` 的非响应式 `Map`），Pinia 只存标签元信息。
- 主题颜色/间距只在 `src/styles/theme.ts` 定义，经 `--yd-*` CSS 变量注入。
- 目录级职责、IPC 链路、会话落盘/恢复、书库扫描与对账等细节，见 [.trae/documents/architecture.md](.trae/documents/architecture.md)；开发约定、依赖分区、数据库与 Monaco 硬约束见 [AGENTS.md](AGENTS.md)。

## 开发流程

- 在 `dev` 分支开发，`master` 为默认分支，不直接推远端。
- 每写完一个文件立即 `npm run typecheck`，提交前跑 `npm run lint`。
- 一次提交一件事，中文提交信息写「为什么」；不提交 `out/`、`dist/`、`node_modules`、`public/test/`。
