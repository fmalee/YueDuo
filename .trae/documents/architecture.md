# 悦读 / YueDuo 架构地图

面向「要改某类东西，先看哪几个文件」的查表文档。路径均相对仓库根。
约定与硬约束以 [AGENTS.md](../../AGENTS.md) 为准，这里只描述「东西在哪、怎么连起来」。

## 0. 一句话分层

- `src-tauri/src/` Rust 后端：文件与编码、SQLite、Finder 扩展属性、原生对话框、应用菜单、主题；`services/` 纯 Rust、不依赖 tauri 类型。
- `src/` 渲染层：Vue 组件 + composables 编排 + Pinia 元信息 + Monaco；零 Node 能力（与 Electron 版相同，原样迁移）。
- `shared/`：两侧共用的契约与规则（TS 与 Rust 经 findRules.json/types 镜像对齐），不许 import 任一侧运行时。
- 跨进程唯一通道：typed commands（`bridge.ts` → `@tauri-apps/api` invoke → `commands/` 各域）+ 四个事件订阅。

## 1. 目录树（文件级）

```
YueDuo/
├── package.json                  npm 脚本（dev=tauri dev / typecheck / lint / build:web）；dependencies 为空，运行时零 npm 包
├── vite.config.ts                渲染层构建（含 Monaco 中文标点行宽插件，自 electron.vite 迁移）
├── tsconfig.json                 TS 工程引用入口
├── tsconfig.node.json            vite 配置 + shared 的 TS 编译范围
├── tsconfig.web.json             渲染层 + shared 的 TS 编译范围（noImplicitAny:false，见 AGENTS.md）
├── eslint.config.mjs             lint 规则
├── AGENTS.md                     项目实现约定（每轮常驻注入）
├── README.md                     使用说明
├── resources/
│   └── dicts/                    简繁转换词表（st/ts 字表词表、keep/ambiguous）→ bundle.resources 带入 .app
├── public/
│   ├── bootstrap-theme.js        首帧主题引导（同步外链脚本，CSP 'self' 放行）
│   └── test/                     大文件验收样本（gitignore，不入库）
├── shared/
│   ├── types.ts                  跨进程共享类型与常量（Rust 侧镜像 src-tauri/src/types.rs）
│   ├── metadataParser.ts         书名/作者/标签解析（渲染层引用；Rust 侧在 services/metadata.rs）
│   ├── findRules.json            查找/整理规则表（唯一来源：TS 薄导出 + Rust include_str! 嵌入）
│   ├── findRules.ts              findRules.json 的类型导出
│   ├── replaceTemplate.ts        替换串转义与分组展开的共用入口（Rust 侧在 services/convert.rs）
│   ├── crossLineSearch.ts        全文跨行正则匹配（Monaco 逐行 find 的补充）
│   └── librarySearch.ts          命令面板检索、字段加权与排序
│
├── src-tauri/
│   ├── Cargo.toml                Rust 依赖（rusqlite bundled / encoding_rs / regex / xattr / trash 等）+ dev 优化档
│   ├── tauri.conf.json           窗口（visible:false）、bundle（图标、词表 resources）、dev/build 命令
│   ├── capabilities/default.json 最小权限（core:default + dialog + window:allow-show）
│   └── src/
│       ├── main.rs               进程入口（调 lib::run）
│       ├── lib.rs                Builder：插件注册、setup（数据目录/搬家/菜单/主题）、退出握手、RunEvent 分发
│       ├── shell.rs              原生中文菜单：单选组（外观/字体/字号/预载）、点击转 app:menuCommand、勾选回写
│       ├── theme.rs              set_theme 三态应用 + ThemeChanged 推送 theme:updated
│       ├── types.rs              shared/types.ts 的 serde 镜像（camelCase）+ 白名单常量
│       ├── commands/             按域 typed async commands（对应原 electron/ipc）
│       │   ├── app.rs            app_sync_menu_state（侧栏显隐回写菜单勾选，run_on_main_thread）
│       │   ├── convert.rs        简繁、全角半角、一键整理（词表目录双路径探测）
│       │   ├── dialog.rs         原生对话框：关闭三选一、选/存文件、删除确认、报错、选书库
│       │   ├── file.rs           文本读写（readText 走二进制 Response）、stat、改名、废纸篓、reveal、草稿读写
│       │   ├── library.rs        活动书库状态、换库三步、目录/列表查询、评分、元数据同步、章节与书签
│       │   ├── meta.rs           元数据读取与写回、评分读写（库内写库+Finder，库外只写 Finder）
│       │   ├── session.rs        会话 persist/restore/relocate/flushDone
│       │   └── settings.rs       settings_get/set（落盘后同步窗口主题并推送权威值）
│       ├── state/                AppState 子模块（rusqlite 仓储）
│       │   ├── db.rs             建库、user_version 迁移 v1–v3（SQL 与 Electron 版逐字一致）、WAL
│       │   ├── library.rs        每书库一份库：根目录 realpath、sha1 回落命名、prepare/commit/abort
│       │   ├── books.rs          books 表：列表/评分/最近阅读/元数据/改名/删除/标签评分
│       │   ├── bookmarks.rs      bookmarks 表：当前书书签与全库分组
│       │   ├── session.rs        session_tabs/session_state 落盘、恢复、按 book_id 重定位、草稿
│       │   └── settings.rs       settings.json 读写、逐字段归一化
│       ├── state.rs              AppState + FlushGate（退出握手槽，独立 manage）+ Electron userData 搬家
│       └── services/             纯 Rust 业务（可单测，不依赖 tauri 类型）
│           ├── codec.rs          编码探测链、解码、换行归一、encode_for_write
│           ├── files.rs          read_text / stat / write_text（tmp+rename 原子替换）
│           ├── metadata.rs       元数据解析、split_tags、find_topic
│           ├── metadata_writer.rs 正文前 10 行最小替换写回（UTF-16 码元偏移）+ 应用 TextEdit
│           ├── text.rs           章节标题行提取
│           ├── scanner.rs        目录列举、全库扫描入库（独立线程运行）、单文件 ingest
│           ├── reconcile.rs      扫描后对账：移动合并、连续零匹配删库
│           ├── convert.rs        简繁（词表 trie）、全角半角、一键整理管线 + 替换模板展开
│           ├── find_rules.rs     findRules.json 解析 + JS 正则转译（\uXXXX → \u{XXXX}）
│           └── finder.rs         Finder 星级/注释：bplist00 手写 + xattr 直读写 + osascript 同步
│
├── src/                          （前端与 Electron 版相同，原样迁移）
│   ├── index.html                渲染层 HTML 入口（含 bootstrap-theme.js 引导）
│   ├── main.ts                   Vue 挂载、Pinia、先初始化设置再 mount → windowShow
│   ├── App.vue                   根布局 + 全局编排（菜单命令、快捷键安装、会话初始化、换库、缺失标签重连）
│   ├── monaco.ts                 Monaco 单例、纯文本 editor 选项、字体、主题、accessibilitySupport:'off'
│   ├── monaco/cjkWrapStrings.ts  中文标点按全角处理的行宽补丁（由 Vite 插件接管）
│   ├── assets/base.css           基础样式与 CSS 变量分层
│   ├── assets/main.css           应用主体样式
│   ├── ipc/bridge.ts             渲染层唯一 IPC 出口：typed invoke、每通道类型化函数、事件订阅、windowShow
│   ├── styles/theme.ts           主题 token（颜色/间距/字号）与 --yd-* 注入
│   ├── stores/                   tabs / library / settings / reader（职责同前，不变）
│   ├── composables/              useTabs / useTabLifecycle / useEditorSetup / useEditorCommands /
│   │                             useEditorKeybindings / useEditorViewState / useLineCommands /
│   │                             useSession / useLibrarySwitch / useMetadataEdit / useRatingGesture /
│   │                             useChapters / useBookmarks / useBookmarkDrift / useLibraryBookmarks /
│   │                             useCommandPalette / useStatusMessage / useStatusMetrics
│   └── components/               EditorHost / TabBar / Sidebar(+) / MetadataBar / RightPanel(+) /
│                                 FindReplaceBar / CommandPalette / StatusBar（职责同前，不变）
└── .trae/documents/
    ├── tauri-refactor-plan.md    重构方案与踩坑沉淀（重构完成后归档）
    └── architecture.md           本文件
```

## 2. 关键数据流

### 2.1 IPC：一次 invoke 的完整链路

```
组件 / composable
  → src/ipc/bridge.ts            类型化函数（invoke('command 名', { camelCase 参数 })）
  → @tauri-apps/api/core invoke  tauri IPC（大文本走 tauri::ipc::Response 二进制帧）
  → commands/<域>.rs             typed async command（fn 名即 command 名）
  → state/ 或 services/          业务
  ← Result<T, String>（Err 经 bridge.ts 转异常，前缀 [command名]）
```

**新增一个通道要同步四处**：

1. `commands/<域>.rs`（或新建域文件）：`#[tauri::command] pub async fn ...`
2. `src-tauri/src/lib.rs` 的 `generate_handler!`：注册命令
3. `src/ipc/bridge.ts`：对应的类型化函数（渲染层只从这里调）
4. `shared/types.ts` + `src-tauri/src/types.rs`：新类型两侧镜像（serde camelCase）

**Rust → 渲染层的推送通道**（`app.emit`，bridge.ts 按固定名订阅）：

| 通道 | 方向与用途 | 发送点 |
| --- | --- | --- |
| `theme:updated` | 生效主题变化（system 模式随系统切换） | `theme.rs` + `commands/settings.rs` |
| `session:flush` | 关窗/退出前要求渲染层落盘 | `lib.rs begin_flush_then_exit()` |
| `library:scanProgress` | enrich 扫描进度（每 10 个文件） | `commands/library.rs` 扫描线程 |
| `app:menuCommand` | 菜单/快捷键动作转交渲染层 | `shell.rs` |

**退出握手时序**（与 Electron 版 before-quit 语义对齐，实现不同）：

```
红点/关闭窗口菜单 → WindowEvent::CloseRequested（窗口存活）
  → api.prevent_close()
  → begin_flush_then_exit：emit session:flush（立即返回，不阻塞主线程！）
  → 渲染层 flushForQuit(): 书签漂移 → 最近阅读时间戳 → 快照 → 并行写驻留脏标签草稿
  → session_flush_done 命令 signal FlushGate
  → 后台线程 wait 返回 → run_on_main_thread → shutdown（WAL checkpoint）→ app.exit(0)
Cmd+Q / app.exit → RunEvent::ExitRequested(Some) → prevent_exit → 同款异步握手
  → 完成后 app.exit(0) 再次触发（handled → 放行）→ RunEvent::Exit
超时 3 秒强制放行；YUE_TEST 跳过握手；ExitRequested(None)（窗口已销毁）直接放行
```

### 2.2 编辑器：单实例 + 每标签一个 model

（前端与 Electron 版一致）

- 实例：`EditorHost.vue` 创建唯一 `IStandaloneCodeEditor`（`useEditorSetup.createReaderEditor`），全应用只此一个。
- 模型：`useTabLifecycle.ts` 的模块级 `Map<tabId, ModelEntry>`，**非 reactive**；全文只存在 `monaco.editor.ITextModel`，Pinia 只存 `TabMeta`。
- 切换：`editor.setModel(entry.model)`，禁止用 `:key` 重建实例。
- dirty：`model.getAlternativeVersionId()` 与基线比较，O(1)；保存后 `resetBaseline`。
- LRU：驻留集合 = 当前标签 + `lastFocusedAt` 最新的 `preloadCount` 个；卸载前把 dirty 全文与 viewState 经 `file_write_draft` 写库，再 `dispose()`，标签元信息保留。
- 打开：`useTabs.openFile` → `file_read_text`（Rust 解码，**二进制 Response 帧拆包**）→ `createTabModel` → 激活 → `setModel`。同一文件用 `statCache`（inode 优先、realPath 兜底）去重。
- 保存：`useEditorCommands.saveActive` 即时 `model.getValue()` → `file_write_text`（临时文件 + rename，保存钩子同步 Finder 注释）→ 刷新 stat、清草稿、同步元数据到库（`library_sync_metadata`，不做全库重扫）。
- 编辑相关事件：`yueduo:findReplace`、`yueduo:convert`、`yueduo:tabRelocated` 由 `App.vue` / 菜单派发，`EditorHost` 监听执行。

### 2.3 会话落盘与恢复

**落盘**

1. 标签增删、切换、滚动 → `useSession.schedulePersist()` 2 秒防抖；进度与光标存模块级 `Map`，不进响应式。
2. `session_persist` → `state/session.rs persist_session` 写 `session_tabs` + `session_state`。
3. 库内标签写 `book_id` + 相对路径，库外写绝对路径 + `book_id NULL`；判定在 Rust 侧（渲染层只传绝对路径）。

**恢复**

1. `App.vue` 初始化 → `restoreSession()` → `session_restore`。
2. 库内标签按 `books.relative_path` 拼当前书库根；查不到或文件不存在 → 保留标签并标 `missing`。
3. `applyRestoredSession` 重置渲染层再灌入标签元信息；正文懒加载，草稿按 `tabId` 懒读。
4. 后台 enrich 扫完 → `retryMissingTabs()` → `session_relocate` 按 `book_id` 重算路径，只重试一次。

**换库**（`useLibrarySwitch`，顺序固定）

```
library_open（Rust 建新库 + 停扫描 + 读新会话，旧库仍活动）
→ archiveSessionForSwitch（书签/时间戳落盘 → 快照 → 驻留脏标签草稿，写进旧库）
→ library_activate（提交点：关旧库、切新库）
→ applyRestoredSession（清空旧 model，灌入新库会话）
任一失败 → library_abort（只关新库，旧库继续可用）
```

### 2.4 书库扫描、对账与单文件入库

- 启动：`lib.rs` setup 里 `AppState::new` 按设置的书库根打开 `<根>/yueduo.db`，不可写时回落 `app_data_dir/library-db/<sha1[:16]>.db`；渲染层用 `library_current` 读取状态。
- 惰性浏览：`library_fast_scan` → `scanner::list_directory`，只读一层，不碰数据库。
- 全库补全：`library_enrich` → **独立线程 + 独立 SQLite 连接**（WAL 多连接安全，不占主锁；单飞去重 EnrichResultSlot）→ `scanner::scan_library`（解码 + 解析元数据 + 写 `books`，每 10 个推送进度）→ `reconcile::reconcile_library` 对账；AtomicBool 取消令牌 + 代际校验，被换库中止的扫描不做对账。
- 对账：直命中重置 `miss_count`；疑似移动用「标题+文件名 / 文件名+大小 / 标题+字数」匹配，旧 `id` 接手新路径以保留评分、进度、书签；连续零匹配达到阈值才删记录；空扫描结果直接返回，避免把全库误删。
- 单文件入库：保存或另存为后 `library_sync_metadata` → `scanner::ingest_file`，路径判定与相对路径换算都在这里（先 realpath 书库根与文件），命中更新、未命中插入。
- 评分：库内 `books.rating` + Finder 星级 xattr；库外只写文件 xattr。读评分同理分流。

### 2.5 设置读写与菜单同步

- 启动：`src/main.ts` 先 `settings.init()`（`settings_get`）再 mount → `windowShow()`；主题 token 首帧前注入（`public/bootstrap-theme.js` 先于一切渲染按 prefers-color-scheme 铺底色）。
- 读写：`settings_get/set` → `state/settings.rs`（`app_data_dir/settings.json`，逐字段归一化，坏值/旧字段回落）；`set` 落盘后同步窗口主题（`set_theme`）并推送权威值。
- 主题：`theme.rs` 三态应用——light/dark 锁定，system 恢复跟随系统；`WindowEvent::ThemeChanged` 推 `theme:updated`（渲染层以推送为权威值）。
- 菜单动作：`shell.rs` 点击 → `emit app:menuCommand` → `App.vue runMenuCommand` 按当前 active 标签分发。
- 菜单勾选：侧栏显隐变化 → `app_sync_menu_state` → `shell.rs` 经 `run_on_main_thread` 回写 `checked`，键盘与菜单两条路径一致。
- 快捷键：`useEditorKeybindings` 统一收口（全局捕获阶段 + 编辑器 scope），焦点在输入框时放行；菜单与快捷键都只转交意图。

## 3. 速查索引

| 想改什么 | 先看这些文件 |
| --- | --- |
| 加一个 IPC 通道 | `src-tauri/src/commands/<域>.rs`、`lib.rs`（generate_handler）、`src/ipc/bridge.ts`、`shared/types.ts` + `types.rs` |
| 改文件读写 / 编码 | `commands/file.rs`、`services/codec.rs`、`services/files.rs`、`services/metadata_writer.rs` |
| 改标签行为（打开/关闭/保存/改名） | `composables/useTabs.ts`、`components/TabBar.vue`、`composables/useTabLifecycle.ts` |
| 改编辑器选项 / 主题 / 字体 | `src/monaco.ts`、`composables/useEditorSetup.ts`、`styles/theme.ts` |
| 改快捷键 | `composables/useEditorKeybindings.ts`、`composables/useLineCommands.ts`、`src-tauri/src/shell.rs` |
| 改 LRU / 草稿 / 会话 | `composables/useTabLifecycle.ts`、`useEditorViewState.ts`、`useSession.ts`、`state/session.rs` |
| 改元数据解析 / 写回 | `shared/metadataParser.ts`、`services/metadata.rs`、`services/metadata_writer.rs`、`commands/meta.rs`、`components/MetadataBar.vue` |
| 改书库扫描 / 对账 | `services/scanner.rs`、`services/reconcile.rs`、`commands/library.rs` |
| 改换库流程 | `composables/useLibrarySwitch.ts`、`state/library.rs`、`commands/library.rs`、`composables/useSession.ts` |
| 改数据库表 / 迁移 | `state/db.rs`（追加新版本，不改旧版本；SQL 与 Electron 版逐字对齐） |
| 改书库列表 / 评分 / 标签 | `state/books.rs`、`stores/library.ts`、`components/sidebar/*` |
| 改书签漂移 / 章节 | `composables/useBookmarkDrift.ts`、`state/bookmarks.rs`、`services/text.rs` |
| 改查找替换 / 一键整理规则 | `shared/findRules.json`（唯一来源）、`shared/replaceTemplate.ts`、`shared/crossLineSearch.ts`、`services/find_rules.rs`、`services/convert.rs`、`components/FindReplaceBar.vue` |
| 改简繁 / 全角半角 | `services/convert.rs`、`commands/convert.rs`、`resources/dicts/` |
| 改 Finder 星级 / 注释 | `services/finder.rs`、`commands/meta.rs`、`commands/library.rs`、`commands/file.rs` |
| 改应用菜单 / 菜单勾选 | `src-tauri/src/shell.rs`、`src/App.vue`（`runMenuCommand`）、`commands/app.rs` |
| 改设置项 | `shared/types.ts`（`AppSettings`/`DEFAULT_SETTINGS`）+ `types.rs`、`state/settings.rs`、`stores/settings.ts`、`shell.rs` |
| 改主题颜色 / 间距 | `styles/theme.ts`、`assets/base.css`（首帧底色另见 `public/bootstrap-theme.js`） |
| 改退出握手 | `lib.rs`（CloseRequested / ExitRequested 分支）、`state.rs`（FlushGate）、`composables/useSession.ts`（flushForQuit） |
| 加验收测试 | `src-tauri/src/services/*.rs` 的 `#[cfg(test)]`（cargo test） |

## 4. 动手前的六条红线

- 渲染层不 import Node 模块、不直接用 `@tauri-apps/api`；路径拼接、文件判定都在 Rust 侧。
- 全文不进 Pinia / Vue reactive；只经 `useTabLifecycle` 的非响应式 `Map` 与 Monaco model。
- 不重建 Monaco 实例：单实例 + `setModel()` 切换。
- `shared/findRules.json` 的数组顺序就是整理顺序，增删规则只改这一处（TS/Rust 共用）。
- command 一律 async；事件回调里绝不同步长等（emit 依赖主线程循环派发，见 AGENTS.md 主线程规则）。
- 消息框自定义按钮按 `Custom(文案)` 判定结果（插件统一转换，`Yes/No/Ok` 只作兜底）。
