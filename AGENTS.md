# AGENTS.md

本文件是项目实现约定的权威来源，动代码前先读。只写做对事需要的事实，不写背景故事。

## 项目定位

- 本地 TXT 小说管理与阅读器（悦读 / YueDuo）：**Tauri 2 + Rust 后端 + Vue 3 + TypeScript + CodeMirror 6** 前端，编辑器界面即阅读界面，视觉与交互对齐 VS Code / Chrome 标签。
- 功能基线是 NovelManager（Python + PySide6）；`YueDuo_old` 只作参考与坑警示，不照搬实现。
- 2026-11-20 起从 Electron 完成向 Tauri 的重构（方案与踩坑沉淀见 [.trae/documents/tauri-refactor-plan.md](.trae/documents/tauri-refactor-plan.md)）；Electron 版代码已删除，历史参考用 `git show a46ae4a:<electron/... 路径>`。

## 权限与数据边界

- 只读写项目目录与系统临时目录；其他目录（用户书库、`~/Library`、`/Applications`）先说明用途并取得授权。
- 验收书库 `/Users/Joey/Sites/Projects/小说` 已授权读写；已打包的 `/Applications/YueDuo.app` 及其数据一律不动。
- 测试在 `std::env::temp_dir()` 下构造数据并自清；不打印正文到对话。
- 数据目录：打包版用 `app_data_dir`（`~/Library/Application Support/com.yueduo.reader`）；开发态（debug 构建，`npm run dev`）用项目内 `.dev/user-data`（gitignore，与打包版配置/会话/索引完全隔离）；自动化验收用 `YUE_USER_DATA` env 隔离。首次启动（仅打包版）把 Electron 版 `~/Library/Application Support/YueDuo` 的 settings.json 与回落库一次性搬来（copy 不删源、`.migrated-from-electron` 标记幂等），不要删除旧目录；开发态跳过此迁移，用干净默认配置，不继承真实书库。

## 技术栈基线

- Tauri 2.12（tauri + tauri-plugin-dialog + tauri-plugin-single-instance）、rusqlite 0.32（bundled）、encoding_rs + chardetng、regex、trash、xattr、serde/serde_json、sha1；前端 Vue 3.5、TS（严格但 `noImplicitAny: false` 按历史口径保留，勿改）、Pinia 4、CodeMirror 6（`@codemirror/state`、`@codemirror/view`、`@codemirror/commands`）。
- Rust dev 档已开优化（本 crate O1 + 依赖 O3，见 Cargo.toml）：`tauri dev` 首次编译 1–3 分钟属正常，不要为编译速度退回零优化——解码/字数统计这类 CPU 路径在零优化下慢一个数量级，是「打开文件/扫描特别慢」的真凶。
- TS 锁 `^5.9.3`（5.x 末版），禁止 `latest`/`*`：TS 7 原生移植无编译 API，vue-tsc 依赖它。
- 新增依赖需主流稳定、说明理由并锁版本；依赖/构建/目录等全局变更先确认。

## 架构与目录

目录职责与关键数据流见 [.trae/documents/architecture.md](.trae/documents/architecture.md)，这里只留常驻约束。

| 目录                     | 职责                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/commands` | 按域收敛 IPC 参数（file/library/session/meta/convert/dialog/settings/app），调用 state/services，不写业务 |
| `src-tauri/src/services` | 纯 Rust 业务，可单测，不依赖 tauri 类型                                                                   |
| `src-tauri/src/state`    | AppState + 子模块（settings/db/library/books/bookmarks/session），rusqlite 仓储                           |
| `src-tauri/src/shell.rs` | 原生中文菜单；`theme.rs` 主题；`types.rs` shared/types.ts 的 serde 镜像                                   |
| `src/components`         | 只做 UI 与事件，不碰 IPC 细节                                                                             |
| `src/composables`        | 渲染层编排：标签、会话、编辑动作、书库切换                                                                |
| `src/editor`             | CodeMirror 6 引擎层：实例/Compartment 工厂、O(1) 判脏、视口裁剪高亮、纯编辑动作                           |
| `src/stores`             | 只存元信息与 UI 状态（Pinia），不存全文                                                                   |
| `src/ipc`                | `bridge.ts` 是渲染层唯一 IPC 出口                                                                         |
| `shared`                 | 两侧共用契约与规则（types.ts、findRules.json、metadataParser 等）                                         |

- **typed commands 契约**：command 名 = Rust fn 名（snake_case）；前端传 camelCase 参数 key 自动映射；错误统一 `Result<T, String>`，bridge.ts 转异常（前缀 `[command名]`）。**新增通道同步四处**：`commands/<域>.rs`、`src/ipc/bridge.ts`、`shared/types.ts`、`types.rs`（serde 镜像），并在 lib.rs 的 `generate_handler!` 注册。
- 渲染层只经 `src/ipc/bridge.ts` 调 typed invoke；禁止渲染层 import Node 模块或直接用 `@tauri-apps/api`（windowShow 等窗口能力也封装在 bridge.ts）。
- **command 一律 async**（跑线程池）：blocking 对话框/长任务绝不落主线程，否则「主线程自己等自己」死锁（首次迁移踩坑）。
- **主线程规则**：emit 事件经主线程事件循环派发到 WKWebView——事件回调里**绝不能同步长等**（等待会堵死事件派发，渲染层永远收不到，Electron 的 `webContents.send` 跨进程投递无此限制，不能照搬）；菜单勾选回写、窗口聚焦用 `run_on_main_thread`。
- **消息框按钮判定**：tauri-plugin-dialog 在所有平台把原生结果统一转成 `Custom(按钮文案)`（插件 desktop.rs），按文案匹配（`Yes/No/Ok` 枚举只作兜底），否则永远落到 default 分支。
- capabilities 最小权限：`src-tauri/capabilities/default.json`，新前端能力（如 window:show）逐条补；`core:default` 不含窗口显隐。
- 资源必须进 `bundle.resources`（tauri.conf.json）并配探测测试；**dev 态 resource_dir 不含资源**，运行时探测顺序：resource_dir → `CARGO_MANIFEST_DIR/../`（见 commands/convert.rs）。
- 全文字符串绝不进 Pinia/Vue reactive：store 只存 `TabMeta`，全文只在 CM6 `EditorState.doc`（`useTabLifecycle.ts` 的非 reactive `Map`）。
- 单 `EditorView` 实例 + 每标签不可变 `EditorState` + `view.setState()` 切换；禁止用 `:key` 重建编辑器实例（旧项目焦点/IME bug 根因）。
- 共用类型写 `shared/types.ts`（Rust 侧镜像 `types.rs`），不用裸 `any`；文件命名 services/composables/stores 用 camelCase、Vue 组件用 PascalCase、Rust 文件 snake_case；command 用 snake_case、事件用 `域:动作`。
- 单文件超 ~500 行拆分（state/ 已按域拆子模块的先例）。

## 数据库与书库

- 每个书库一份数据库：首选 `<书库根>/yueduo.db`；根目录不可写时回落 `app_data_dir/library-db/<sha1(realpath)[:16]>.db`（按库隔离，不许共用一份）。`relative_path` 相对书库根、不含根目录名。schema 迁移 `PRAGMA user_version` v1–v3，与 Electron 版逐字一致（数据双向兼容，可随时切回旧版）。
- rusqlite 连接包在 AppState 内（Mutex）；`with_active_db` 锁内同步执行——**勿在闭包里放长 I/O**（大文件读写走 services，不持锁）。enrich 扫描用独立线程 + 独立连接（WAL 多连接安全），AtomicBool 取消令牌 + 代际校验。
- 换库固定顺序：`library_open` 建新库 + 停扫描 + 读新会话（旧库仍活动）→ 渲染层存档旧会话（快照 + 驻留脏标签草稿写旧库）→ `library_activate` 切活动库（提交点）→ 恢复新会话；失败/取消用 `library_abort`，旧库必须仍可用。
- `session_tabs` 落盘口径：库内标签写 `book_id` + 相对路径（`path` 列），库外标签 `book_id` NULL + 绝对路径，空白标签两者为空；判定与路径换算只在 Rust 侧做（先 `realpath` 书库根与文件）。恢复时 `book_id` 优先按 `books.relative_path` 拼当前书库根，查不到或文件不存在退回会话里存的相对路径；仍不存在则保留标签并标记缺失，对账扫完再按 `book_id` 重试一次（`session_relocate`）。历史行不迁移，按绝对路径打开，下次落盘自然写成新格式。
- 路径比较前统一 `realpath`；保存先写临时文件再 `rename` 原子替换，保存后 inode 已变必须刷新 stat 缓存。
- 退出握手：`CloseRequested`（窗口存活）prevent_close → 发 `session:flush` → 渲染层 persist → `session_flush_done` 回执 → `run_on_main_thread` 关库 → `app.exit(0)`；`ExitRequested(Some(code))` 同款兜底；**绝不能挂 `ExitRequested(None)`**（窗口已销毁，渲染层无法回执）；3 秒超时强制放行；`FlushGate` 独立 manage（AppState 含 Connection 非 Sync，不能跨线程）。YUE_TEST 跳过握手。

## 文本与编码

- 工作编码 UTF-16LE；探测链复刻 Python `text_codec.py`（BOM 表 UTF-32 先于 UTF-16、无 BOM UTF-16 NUL 推断——chardetng 不识无 BOM UTF-16 且 had_errors=false，此层不可省、chardetng + GB18030 复核、fallback utf-8→gb18030→big5），换行归一 `\r\n`/`\r` → `\n`。
- `encoding_rs` 的 `UTF_16LE.encode()` 输出是 UTF-8——写出必须 `str::encode_utf16` 逐码元小端；chardetng 的 `gbk` 标签归一为 `gb18030`（同一解码器）。
- 大文本 IPC 走 `tauri::ipc::Response` 二进制帧（`[u32 headerLen][header JSON][UTF-16LE 正文]`，bridge.ts 拆帧）——不走 JSON 通道（省序列化/解析与全量拷贝，大书恢复速度的关键）。
- 回车补两个全角空格 `U+3000`，`Shift+回车` 只换行不缩进。
- 一键整理顺序固定：归一换行 → 繁转简（保护词→词组最长匹配→单字→ambiguous 保留）→ 全角转半角（`to_halfwidth` 规则）→ 按 `shared/findRules.json` 数组顺序执行 `tidyEnabled` 的规则。
- **findRules.json 是全项目唯一正则来源**（TS 薄类型导出 + Rust `include_str!` 嵌入同一份文件）：所有正则进查找下拉；`tidyEnabled: true` 严格按数组顺序用于一键整理；增删规则只改 JSON。Rust 只编译 tidyEnabled + to_halfwidth 模式（RE2 兼容无 lookahead，`fix_dialogue` 等纯查找规则不进 Rust）；JS `\uXXXX` 需转译为 regex crate 的 `\u{XXXX}`（services/find_rules.rs）。
- 替换模板展开（`$1`/`$&`/`$$`/`\n`/`\t`/`\\`）语义以 `shared/replaceTemplate.ts` 为准，Rust 侧 services/convert.rs 逐语义移植，两处改动必须同步。

## 数据约定

- **设置默认值单一源 = `shared/defaultSettings.json`**（TS `import` + Rust `include_str!` 嵌入同一份文件，仿 findRules.json 模式）：`DEFAULT_SETTINGS`（types.ts）与 `default_settings()`（types.rs）都只从该 JSON 读，改默认值只改 JSON，禁止在两侧各抄一份。Rust 侧解析失败 panic 快速暴露；cargo test `default_settings_from_shared_json` 锁默认值防漂移。
- 元数据：名称取前两行书名号内，否则文件名；作者取前十行 `作者：`，否则「佚名」；标签取前十行 `主题：`，否则目录名；评分 5 分制。书名识别只看**前两行**（titleLineIndex 限制）。
- 元数据写回用一次最小区间替换生成可撤销 TextEdit（**UTF-16 码元偏移**，编辑器统一偏移口径，Rust 侧 services/metadata_writer.rs 做码元↔字节换算），保留光标与未保存标记；applyEdit 按 B1 口径提交即同步 books（不等保存），不写文件。
- Finder 星级/注释走 `xattr` crate 直读写原始字节 + 手写 bplist00（与 python3 `plistlib.dumps(FMT_BINARY)` 逐字节一致，cargo test 有对照测试）：float marker `0x23` + 8 字节 BE double；字符串全 ASCII 走 `0x5X`，否则 UTF-16BE marker `0x60|字符数` 或 `0x6F`+2 字节字符数；trailer 32 字节；禁止 plist crate 的 `buildBinary`。写前读旧值，相同跳过。
- 注释写完再 `osascript`（argv 传路径与注释、不拼脚本，2 秒超时）让 Finder `set comment` 同步一次：Finder/Path Finder 显示的是 Spotlight 索引，raw xattr 会滞后甚至滞留旧值。`write_comment` 返回 `refreshed/written/skipped/failed`，同步失败记 warning 并返回 `written`，不阻塞保存。
- `last_read_at` 打开即写，阅读位置变化 60 秒防抖。

## CodeMirror 6 硬约束

- 单 `EditorView` 实例 + 每标签不可变 `EditorState`（非 reactive `Map`）+ `view.setState()` 切换，禁止用 `:key` 重建；`updateListener` 实时回写最新 `EditorState`；空态/加载态切共享只读空占位态（`tabIdField = null`）。
- 每次 `view.setState()` 前必须经 `syncStateCompartments()` 同步全局主题、字体、字号与锁定态（带 `addToHistory: false`）。
- 锁定阅读只用 `EditorState.readOnly.of(true)`，严禁 `EditorView.editable.of(false)`（否则失焦、空格翻页、选区复制全部失效）。
- O(1) 判脏走 `src/editor/dirtyState.ts`（`docVersionField` + `invertedEffects` 反向版本号），严禁调用 `doc.toString()` 对比。
- 查找高亮走 `src/editor/findDecorations.ts`（`ViewPlugin` 仅对 `view.visibleRanges` 二分裁剪挂 `Decoration.mark`）；查找替换由自绘 `FindReplaceBar` 接管 `Cmd+F`。
- 统一原生右键菜单走 `app_popup_menu`（剪切/复制/粘贴/全选混合预定义策略，撤销/恢复走自定义项）；顶部菜单撤消/恢复走 `cmd:undo`/`cmd:redo` 按焦点分流。
- 打包版 `src/main.ts` 的 `contextmenu` 放行规则必须排除 `.cm-editor` 内的 `[contenteditable="true"]`。

## 界面约定

- 颜色/间距/圆角/字号只在 `src/styles/theme.ts` 的 `LIGHT_COLORS`/`DARK_COLORS`/`METRICS`/`READING_*` 定义，经 CSS 变量（`--yd-*`）注入，组件不写死数值。
- 主题三态（light/dark/system）：Rust 侧 `set_theme` 设窗口 appearance（WKWebView 的 prefers-color-scheme 只跟随 NSWindow appearance，与 Electron nativeTheme 不同）；启动防闪白靠窗口 `visible:false` + `public/bootstrap-theme.js` 首帧底色 + 主题就绪后 `windowShow()`——色值必须与 theme.ts 的 `bg-1` 保持一致。
- 标签栏是自绘 Vue 组件：flare 8px 贝塞尔外展圆弧，当前标签底边与标签栏底边无缝；完整书名不裁切，溢出横向滚动。
- 正文：`fontSize: 15`、`lineHeight: 22`、页边距 20px，中文优先 PingFang SC。
- 左右两栏同宽，拖拽宽度夹 160–640，关闭时写入设置。

## 开发与验证

- 每写完一个文件立即 `npm run typecheck`（node + web 双侧），不要攒着跑；提交前 `npm run lint`。
- 开发用 `npm run dev`（= tauri dev）；Rust 单测是 services 的唯一口径：`cargo test --manifest-path /Users/Joey/Sites/Projects/YueDuo/src-tauri/Cargo.toml`（54+ 用例；`-- --ignored --nocapture` 跑真实书库编码回归）。
- 自动化验收：`YUE_USER_DATA=<隔离目录> YUE_TEST=1 npm run dev`——跳过确认框与退出握手、开发环境书库直接放行；数据目录用 `YUE_USER_DATA` 隔离。
- 开发环境书库确认：debug 构建下打开测试库（`/Users/Joey/Sites/Projects/小说`）以外的书库先弹确认（扫描会写 Finder 星级/注释），YUE_TEST 不弹。
- 单实例锁：tauri-plugin-single-instance，二次启动聚焦已有窗口（Rust 侧，无退出码语义）。
- 打包 `npm run tauri build`；dev 态 Dock 图标是 Tauri 默认属正常（debug 可执行无 Info.plist icon），打包版才带真实图标；打包后验证词表在包内（resource_dir 探测）。
- 被输入法接管的按键不会进入应用：macOS 中文输入法提交候选后会吞掉部分按键事件（如 Shift+Backspace），渲染层收不到 keydown。合并段落用能穿透输入法的 `Shift+Option+Backspace`；遇到「按键失效但代码看不出问题」，先怀疑输入法接管。
- 不提交 `out/`、`dist/`、`node_modules`、`src-tauri/target/`、`public/test/`、`.workbuddy/`；`package-lock.json` 的 `-diff` 属性勿去掉。

## 协作与提交

- 先读相关文件再改；只做被要求的改动，不顺带重构或格式化无关文件；不确定先问。
- 开发在 `dev` 分支，`master` 为默认分支，不直接推远端。
- 用户确认后提交：一次提交一件事，中文信息写「为什么」；提交前查无关改动、调试代码、敏感信息。
