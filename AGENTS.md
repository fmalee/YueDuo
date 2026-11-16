# AGENTS.md

本文件是项目实现约定的权威来源，动代码前先读。只写做对事需要的事实，不写背景故事。

## 项目定位

- 本地 TXT 小说管理与阅读器（悦读 / YueDuo）：Electron + Vue 3 + TypeScript + Monaco，编辑器界面即阅读界面，视觉与交互对齐 VS Code / Chrome 标签。
- 功能基线是 NovelManager（Python + PySide6）；`YueDuo_old` 只作参考与坑警示，不照搬实现。

## 权限与数据边界

- 只读写项目目录与系统临时目录；其他目录（用户书库、`~/Library`、`/Applications`）先说明用途并取得授权。
- 验收书库 `/Users/Joey/Sites/Projects/小说` 已授权读写；已打包的 `/Applications/YueDuo.app` 及其数据一律不动。
- 测试在临时目录构造数据，并用 `app.setPath('userData', tmpdir)` 隔离设置与数据库；不打印正文到对话。

## 技术栈基线（2026-11-17 实装版本）

- Electron 45.3.3（内置 Node 24.22.3 / ABI 150）、electron-vite 6、Vue 3.5、TS 严格模式、Pinia 4、Monaco 0.57、better-sqlite3 13.2、iconv-lite、chardet。
- 主进程由 electron-vite 打包为 CJS（`package.json` 无 `type: module`），`__dirname` 可用；不要按 ESM 约定改造主进程。
- 新增依赖需主流稳定、说明理由并锁版本；依赖/构建/目录等全局变更先确认。

## 架构与目录

- `electron/` 主进程：`ipc/` 按域分 handler（file/library/session/meta/finder/convert/dialog/native），`services/` 纯 Node 可单测、不 import Electron。
- `src/` 渲染层：`components/` + `composables/` + `stores/` + `ipc/bridge.ts`；渲染层零业务逻辑，只做 UI 与编排。
- 跨进程唯一通道：preload 用 `contextBridge` 暴露 `window.yue.invoke`，渲染层只经 `src/ipc/bridge.ts`；禁止渲染层 import Node 模块或 better-sqlite3。
- IPC 必须用 `electron/ipc/registry.ts` 的 `handle()` 注册，统一返回 `{ok:true,data}` / `{ok:false,error}`，禁止 handler 抛裸异常。
- 新增 IPC 域同步三处：`ipc/registry.ts` 的 `IPC_DOMAINS`、`preload.ts` 的 `DOMAINS`、`ipc/index.ts` 注册。
- 全文字符串绝不进 Pinia/Vue reactive：store 只存 `TabMeta`，全文只在 Monaco model（`useTabLifecycle.ts` 的非 reactive `Map`）。
- 单 Monaco 实例 + 每标签一个 model + `setModel()` 切换；禁止用 `:key` 重建编辑器实例（旧项目焦点/IME bug 根因）。
- 共用类型写 `shared/types.ts`，不用裸 `any`；文件命名 services/composables/stores 用 camelCase、Vue 组件用 PascalCase，IPC 通道用 `域:动作`。

## 数据库与书库

- 书库根目录接入后 `yueduo.db` 随库搬迁到书库根、不可写时回落 `userData`；当前阶段暂放 `userData`（`c453d87`）。`relative_path` 相对书库根、不含根目录名。
- 迁移用 `PRAGMA user_version` + 缺列 `ALTER TABLE`；建表语句只对新库生效；WAL 模式。
- better-sqlite3 只在主进程用；路径比较前统一 `realpath`。
- 换库顺序固定：建新库 → 停扫描 → 存档旧会话 → 切活动库 → 恢复新会话。

## 文本与编码

- 工作编码 UTF-16LE；探测链复刻 Python `text_codec.py`（BOM 表 UTF-32 先于 UTF-16、无 BOM UTF-16 推断、chardet + GB18030 复核、fallback utf-8→gb18030→big5），换行归一 `\r\n`/`\r` → `\n`。
- 保存先写临时文件再 `rename` 原子替换；保存后 inode 已变，必须刷新 stat 缓存。
- 回车补两个全角空格 `U+3000`，`Shift+回车` 只换行不缩进。
- 一键整理顺序固定：统一 UTF-16LE → 半角空格/制表符转全角 → 删段末不可见字符 → 繁转简 → 规则正则；规则只在 `electron/services/tidy.ts`。

## 数据约定

- 元数据：名称取前两行书名号内，否则文件名；作者取前十行 `作者：`，否则「佚名」；标签取前十行 `主题：`，否则目录名；评分 5 分制。
- 元数据写回用一次最小区间替换生成可撤销 TextEdit，保留光标与未保存标记，再同步库；评分只写库 + 文件星级。
- Finder 星级/注释只走 `spawn('xattr')` + Python plistlib 风格 bplist00：float marker `0x23` + 8 字节 BE double；字符串 UTF-16BE marker `0x60|字符数` 或 `0x6F`+2 字节字符数；trailer 32 字节；禁止 `plist` 包 `buildBinary`。写前读旧值，相同跳过。
- `last_read_at` 打开即写，阅读位置变化 60 秒防抖。

## Monaco 硬约束

- worker 只走 `src/monaco.ts` 的 Vite 原生 `?worker` 单一路径，纯文本只需 `editor.worker`；禁止 `MonacoEnvironment.getWorkerUrl` 与 AMD loader。
- 大文件禁止分片追加，一律一次性 `setValue`（4.8MB 约 250ms，分片慢 4 倍）。
- 纯文本必须关闭 `unicodeHighlight`、`renderWhitespace`、`bracketPairColorization`、`guides`、建议类、`stickyScroll`、`renderLineHighlight`，`wrappingStrategy: 'simple'`，显式 `fontFamily` 含 PingFang SC。
- dirty 用 `model.getAlternativeVersionId()` 与基线比较（O(1)）；不要为 dirty 读取全文，也不要监听全文。
- 用 Monaco API 前先 grep `node_modules/monaco-editor/esm/vs/editor/editor.api.d.ts` 确认存在。
- `monaco.editor.create()` 参数只在创建时生效，改配置必须重启；内置 find widget 不作为长期方案，阶段 3 由自绘 `FindReplaceBar` 接管 `Cmd+F`。
- LRU 卸载：写 draft 后复查驻留集再 dispose；重载用单飞 + 激活代际校验；草稿重载基线置 `-1` 以保持 dirty。

## 界面约定

- 颜色/间距/圆角/字号只在 `src/styles/theme.ts` 的 `LIGHT_COLORS`/`DARK_COLORS`/`METRICS`/`READING_*` 定义，经 CSS 变量（`--yd-*`）注入，组件不写死数值。
- 标签栏是自绘 Vue 组件（Monaco 不提供 DOM 标签栏）：flare 8px 贝塞尔外展圆弧，当前标签底边与标签栏底边无缝；完整书名不裁切，溢出横向滚动。
- 正文：`fontSize: 15`、`lineHeight: 22`、页边距 20px，中文优先 PingFang SC。
- 左右两栏同宽，拖拽宽度夹 160–640，关闭时写入设置。

## 开发与验证

- 每写完一个文件立即 `npm run typecheck`（node + web），不要攒着跑；提交前跑 `npm run lint`。
- 开发用 `npm run dev`；自动化验收用 `YUE_TEST=1 npm run dev`（不显窗、不进 Dock、不抢前台），`YUE_DEBUG=1` 开 CDP 9222，配 `scripts/cdp-eval.mjs` / `cdp-shot.mjs`。
- 单实例锁：已有实例时重复启动会静默退出（退出码 0），排查「起不来」先查这个。
- Electron 45 在 macOS 从 `node_modules` 启动时 `app.isPackaged` 为 true、`is.dev` 不可信；dev/生产以 `ELECTRON_RENDERER_URL` 是否存在判定。
- native 模块只看 Electron 进程内真实 `require` 与建表插查（`npm run verify:native`），不看 rebuild 输出；better-sqlite3 13.2 自带 N-API prebuild，不需要 `prebuild-install`、`npm rebuild` 或 `electron-rebuild`；升级 Electron 后先查 `process.versions.modules`。
- services 单测用纯 Node（`tsx` 脚本 / `better-sqlite3(':memory:')`），测试数据脚本内构造。
- 不提交 `out/`、`dist/`、`node_modules`、`public/test/`；`package-lock.json` 的 `-diff` 属性勿去掉。

## 协作与提交

- 先读相关文件再改；只做被要求的改动，不顺带重构或格式化无关文件；不确定先问。
- 开发在 `dev` 分支，`master` 为默认分支，不直接推远端。
- 用户确认后提交：一次提交一件事，中文信息写「为什么」；提交前查无关改动、调试代码、敏感信息。
