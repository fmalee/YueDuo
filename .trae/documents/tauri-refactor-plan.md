# YueDuo Electron → Tauri 高质量重构执行方案

> 2026-11-20 制定，同日开始实施。本文件是重构期间的行为准则与进度存档（防意外），
> 重构完成后其内容并入 AGENTS.md 与 architecture.md，届时本文件可归档。
> 现阶段权威口径：本文档 + AGENTS.md（其中 Electron 专属章节已作废，见 §八）。

## 一、重构目的与已确认决策

**目的**：利用 Tauri 架构节约内存（方便常驻）、优化性能与项目结构、减少应用体积
（实测 ≈100MB+ → ≈18MB，无 Node 进程）。

**老李已拍板的决策（2026-11-20）**：
1. IPC 层采用**按域 typed commands**（弃首次迁移的单一 string dispatch）：Rust 侧编译期
   检查参数与返回；`bridge.ts` 是唯一需要改写的前端文件，composables/stores 零改动。
2. 关闭未保存标签三选一（保存/放弃/取消）用**前端自绘浮层**（复用主题 token 的浮层样式），
   不用 tauri-plugin-dialog 的英文三按钮。
3. **P0 脚手架立起后立即移除 Electron 全部产物**（dev 分支，不推远端，可从 git 历史回退）。

**新增功能预约（重构后单独派任务，不影响架构）**：标签右键「移动文本」——本质是
`file:rename` 的跨目录泛化（磁盘移动 + books.relative_path 身份重写 + TabMeta/stat 刷新），
会话落盘/草稿/对账现有机制天然覆盖。P1 实现 files service 时将「重定位」做成 rename/move
共用的单一函数预留接口。

## 二、目标架构与目录结构

```
YueDuo/
├── src/                     # Vue 前端，结构不变（components/composables/stores/ipc/styles）
│   └── ipc/bridge.ts        # 唯一改写：@tauri-apps/api 的 typed invoke + listen
├── src-tauri/
│   ├── Cargo.toml / tauri.conf.json / capabilities/default.json / icons/
│   └── src/
│       ├── main.rs / lib.rs / shell.rs        # 壳：建窗、退出握手、单实例、主题、菜单
│       ├── types.rs                           # shared/types.ts 的 serde 镜像（camelCase）
│       ├── theme.rs                           # 主题三态应用与推送
│       ├── commands/                          # 按域 typed async commands（对应原 ipc/ 各域）
│       │   ├── file.rs library.rs session.rs meta.rs convert.rs
│       │   └── dialog.rs settings.rs app.rs
│       ├── state.rs + state/                  # AppState、db 迁移、会话、换库、仓储（大文件拆子模块）
│       └── services/                          # 纯 Rust 业务（可单测、不依赖 tauri 类型）
│           ├── codec.rs files.rs scanner.rs reconcile.rs convert.rs
│           ├── finder.rs metadata.rs text.rs find_rules.rs dialog.rs paths.rs
├── shared/                  # TS 侧契约源：types.ts、findRules.json、metadataParser 等
├── resources/dicts/         # → tauri.conf.json bundle.resources 带入 .app
```

**命名与契约约定**：
- command 名 = Rust fn 名（snake_case）；前端传 camelCase 参数 key，Tauri 自动映射。
- 错误契约：Rust `Result<T, String>`，bridge.ts 包装成 `[command] message` 异常抛出，
  上层 composable 的 catch 行为与 Electron 版一致。
- 新增通道同步三处：`commands/<域>.rs`、`src/ipc/bridge.ts`、`shared/types.ts`（Rust 侧镜像 types.rs）。
- 事件沿用原 4 个通道名：`theme:updated`、`session:flush`、`library:scanProgress`、`app:menuCommand`。

## 三、分阶段任务（P0–P5）

### P0 — Tauri 壳与契约底座 ✅ 已完成（2026-11-20）
- src-tauri 脚手架、根 vite.config.ts（Monaco CJK wrap 插件 + optimizeDeps 排除清单迁移）。
- types.rs 契约镜像 + AppState + rusqlite(bundled) 迁移 v1–v3（SQL 与 Electron 版逐字一致，
  数据双向兼容，可随时切回 Electron 版）。
- **数据目录一次性搬家**：`~/Library/Application Support/YueDuo` → app_data_dir
  （com.yueduo.reader）。copy 不删源，`.migrated-from-electron` 标记幂等；回落库文件名
  sha1 前 16 位与 Electron 版一致（示例基准：`/Users/Joey/Sites/Projects/小说` →
  `eacbfff748c6637c.db`）。`YUE_USER_DATA` env 覆盖（自动化验收隔离）。
- bridge.ts 全量改写；useTabs 两处旧式调用改类型化函数；monaco.ts 加
  `accessibilitySupport: 'off'`（WKWebView 输入抖动修复）。
- 主题域（提前自 P3）：`theme.rs` 用 `window.set_theme()` 设窗口外观——WKWebView 的
  prefers-color-scheme 只跟随 NSWindow appearance（默认 aqua=浅色），不像 Electron
  nativeTheme 会自动跟随系统；light/dark 锁定，system 走 set_theme(None) +
  WindowEvent::ThemeChanged 推送。settings:set 落盘后同步 apply + emit。
- 图标：src-tauri/icons/{icon.icns,icon.png,icon.ico}，md5 与原 build/ 一致（真实项目图标）。
- **移除**：electron/、electron.vite.config.ts、electron-builder.yml、build/、scripts/、
  全部 Electron 运行时依赖（dependencies 置空）。
- 验证：cargo check ✅、cargo test 5/5 ✅、typecheck node+web ✅、build:web ✅、lint ✅、
  老李真机：窗口/界面/设置通路正常 ✅（深色问题 → theme 域已修复待复测）。

### P1 — 文件与编码域（阅读主链路）✅ 核心完成（2026-11-21）
- `codec.rs`：四层探测链（BOM（UTF-32 先于 UTF-16）→ NUL 判无 BOM UTF-16 字节序 →
  chardetng + GB18030 复核 → fallback utf-8→gb18030→big5）；encode 用 `str::encode_utf16`
  逐码元小端输出（**不能用 encoding_rs 的 UTF_16LE.encode**，其 output 是 UTF-8）。
  修正 TS 版缺口：UTF-16/32 BOM 的 canDecode 按 BOM 端序回环（iconv 恒 LE，BE 文件会降级）。
  chardetng 的 `gbk` 标签归一为 `gb18030`（encoding_rs 同一解码器，显示与历史一致）。
- `files.rs`：readText（**tauri::ipc::Response 二进制帧**：`[u32 headerLen][header JSON][UTF-16LE 正文]`，
  前端 TextDecoder 拆帧——省掉两侧 JSON parse/serialize 与 UTF-8→UTF-16 全量转换拷贝，
  大书恢复提速的关键）、writeText（tmp+rename 原子替换，保存后返回新 stat 供刷新缓存）、stat。
- rename/trash/reveal/draft 读写顺延到 P2（需书库身份同步/会话存储接入）。
- 验收：cargo test 17/17 ✅（BOM/无 BOM/BE/UTF-32/GB18030/乱字节兜底/原子替换/inode 刷新）；
  **真实书库回归 87 本零坏书** ✅（82 BOM UTF-16 + 5 NUL 判定，release 2.66s）；typecheck ✅、
  build:web ✅、lint ✅。真机待验证：打开/保存一本大书对比体感。

### P2 — 会话与书库域 ✅ 核心完成（2026-11-21，与 P3 菜单提前一并落地）
- 书库域 21 个命令全量：换库三步 open/activate/abort（顺序固定）、fastScan、
  **enrich 独立线程 + 独立 SQLite 连接**（WAL 多连接安全，不占主锁；单飞去重用
  EnrichResultSlot（Condvar 广播）；AtomicBool 取消 + 代际校验，被中止的扫描不对账）、
  history/allBooks/following/tags/booksByTag/rated/setTagRating/markRead/bookByPath/
  setBookRating（Finder xattr 待 P3）/syncMetadata（ingest 单文件入库）/chapters/书签五件套。
- 会话域：persist/restore/relocate/flushDone；draft 读写接 session_tabs 两列。
- 文件域收尾：rename（改名 + books 身份同步，失败只记日志交给对账）、trash（trash crate +
  删库记录）、reveal（macOS open -R）。
- dialog 域：tauri-plugin-dialog（async command 线程池调用，无主线程死锁）；
  **confirmClose 用 YesNoCancelCustom 实现中文三按钮**（保存/放弃更改/取消）——优于首次
  迁移的英文按钮；自绘浮层方案保留为 P3 可选优化。YUE_TEST 自动放行 confirmTrash。
- services：scanner（numeric-aware 排序；缺拼音序，目录树顺序可能与 Electron 有细微差异，
  后续可补 ICU collator）、reconcile（三规则移动识别 + 阈值删除 + 空扫描保护）、
  metadata/text（章节）。
- **原生中文菜单提前落地**（shell.rs）：应用/文件/编辑/显示/窗口/帮助六菜单，
  muda 预定义项（undo/cut/copy/paste/select_all/hide/services/about/quit/fullscreen/
  minimize/bring_all_to_front）+ 自定义命令项 + CheckMenuItem 手动单选组（外观/字体/
  字号/预载数量）+ 缩放 set_zoom 自实现 + devtools/reload；「关闭窗口」自定义项避开
  预定义 close_window 的 Cmd+W 冲突。菜单点击 emit app:menuCommand；syncMenuState
  经 run_on_main_thread 回写勾选。省略项：朗读、粘贴并匹配样式。
- state.rs 按域拆子模块：settings/db/library/books/bookmarks/session（落实文件拆分原则）。
- 验收：cargo test 31/31 ✅（含对账三规则回归、换库事务、会话/草稿往返、扫描入库）、
  typecheck ✅、lint ✅；前端零改动（bridge.ts 契约早已备齐）。
- P3 剩余：退出握手（ExitRequested → session:flush → flushDone → 放行）、Finder xattr、
  简繁/全角转换与 tidy、单实例锁、打包验收。

### P3 — 集成域
- 原生中文菜单（对齐 electron/menu.ts 的命令与单选/复选组；menuCommand 事件；syncMenuState 回写）。
- 对话框（全部 async command 防主线程死锁——tauri-plugin-dialog 的 blocking_* 内部
  sync_channel(0)，同步 command 在主线程会自己等自己）；confirmClose 用前端自绘浮层。
- Finder 元数据：`xattr` crate 直读写（免 spawn）+ osascript 同步 Finder 注释（Spotlight
  索引口径）；bplist00 手写（Python plistlib 风格 marker，**不能用 plist crate 的 buildBinary**）。
- 简繁转换：OpenCC 词表（bundle.resources map 形式 `{ "../resources/dicts": "dicts" }` +
  resource_dir 探测注入 + ignored 回归测试）；保护词→词组最长匹配→单字→ambiguous 保留。
- **findRules 单一规则源**（老李 2026-11-20 强调，务必遵守）：
  - `shared/findRules.json` 是**全项目唯一正则来源**（TS 类型导出 + Rust `include_str!` 嵌入）；
  - 列出的**所有正则**用于编辑器查找的正则下拉列表；
  - `tidyEnabled: true` 的正则**严格按数组顺序**用于一键整理；
  - 一键整理 = 繁体转简体 + 全角转半角（匹配集也取自 findRules 的 to_halfwidth 规则）+
    tidyEnabled 正则逐一替换（替换串展开语义与 TS expandReplacement 一致：`$1`/`$&`/`\n` 等）；
  - 加 Rust↔Electron 历史行为的逐字节对照测试防漂移。
- 验收：按首次迁移真机清单全项复测（对话框/读写/菜单/主题/握手/Finder/Cmd+Z/简繁/输入法）。

### P4 — 清理与文档
- AGENTS.md 重写（§八要点）、architecture.md 更新为 Tauri 版、README 更新。

### P5 — 打包与性能验收
- `tauri build`（app + dmg）；单实例锁（tauri-plugin-single-instance）；
  YUE_TEST 等验收模式（env 判定）；同场景内存/启动恢复耗时对照报告。

## 四、风险与已规避坑（首次迁移报告沉淀 + 本次新增）

| 风险/坑 | 状态 |
| --- | --- |
| blocking dialog 主线程死锁（command 必须 async，菜单/主题更新 run_on_main_thread） | P3 遵守 |
| 大文本 IPC 走 JSON 的序列化/解析开销（CJK-UTF-8 3 字节/字 vs UTF-16 2 字节/字，另有两侧行列全量拷贝）→ Response 二进制 + TextDecoder utf-16le | ✅ P1 已落地 |
| chardetng 不识无 BOM UTF-16（误判 windows-1252 且 had_errors=false）→ NUL 判层不可省 | P1 |
| encoding_rs `UTF_16LE.encode()` output 是 UTF-8 → 必须逐码元 encode_utf16 | P1 |
| bplist00 必须 Python plistlib 风格手写 | P3 |
| WKWebView 无 EditContext：Monaco `accessibilitySupport:'off'` | ✅ P0 已带 |
| 简繁词表必须 bundle.resources + 探测测试 | P3 |
| WKWebView prefers-color-scheme 只跟随 NSWindow appearance → set_theme 显式设置 | ✅ P0 已修 |
| userData 目录不一致 → 一次性搬家（copy 不删源、幂等标记） | ✅ P0 已修 |
| enrich 同步阻塞 UI / 抢启动 I/O → spawn_blocking + 取消令牌 + 延迟触发 | P2 |
| xattr crate 与 xattr CLI 行为差异（本次新引入）→ 字节级往返单测 | P3 |
| tsconfig：monaco 深层 JS 导入无 .d.ts，靠 `noImplicitAny: false`（旧 toolkit 预设同款） | ✅ 已内联 |
| `tauri dev` 零优化构建：解码/字数统计/换行归一比 release 慢一个数量级（大书打开与全库扫描「特别慢」的真凶，对照 V8 JIT）→ dev 档本 crate O1 + 依赖 O3 | ✅ 已修（真机反馈） |
| 启动主题闪烁（深→浅→深）：WKWebView 默认白底，在页面加载到 applyTheme 之间露出 → 窗口 `visible:false` + bootstrap-theme.js 同步首帧底色 + 主题就绪后 `windowShow()`（capability 补 core:window:allow-show） | ✅ 已修（真机反馈） |

## 五、AGENTS.md 调整要点（P4 执行）

- **作废**（Electron 专属）：依赖分区/asar/externalizeDeps、better-sqlite3 N-API 与
  verify:native、electron-builder 打包、CJS 主进程约束、ELECTRON_RENDERER_URL dev 判定、
  before-input-event 输入法排查法、preload 三处同步规则。
- **保留原文**：数据库与书库全部口径、文本与编码、数据约定、Monaco 硬约束（追加
  accessibilitySupport: 'off' 与 WKWebView 特有说明）、界面约定、协作与提交。
- **改写**：目录表 electron/ → src-tauri/（commands 不写业务、services 纯 Rust 可单测）；
  「新增 IPC 通道同步三处」→ commands/bridge/types；「渲染层禁止 import Node 模块」→
  渲染层只经 bridge.ts 调 typed invoke；findRules 唯一正则来源表述并入。
- **新增**：Tauri 纪律——command 一律 async、主线程规则（run_on_main_thread）、
  资源必须 bundle.resources 并配测试、capabilities 最小权限、cargo test 是 services
  单测唯一口径、单文件超 ~500 行拆分、Bash 下 zsh 的 `()`/cd 持久化坑注意。

## 六、P0 关键事实备忘（写代码时需要）

- Bash 工具：`cd X && cmd` 的 cd 不跨调用保持 → 用绝对路径 / `--manifest-path`；
  zsh 会把未加引号 sed 表达式里的 `()` 当语法 → 多行替换用 Edit 工具。
- `String` 字段不能进 Rust `const` → `default_settings()` 函数替代 DEFAULT_SETTINGS 常量。
- 回落库命名：sha1(root) 十六进制**前 16 位** + `.db`。
- 测试隔离：`std::env::temp_dir().join(format!("yueduo-p0-{tag}-{pid}-{ms}"))`，用完删除。
- dev 态 Dock 图标是 Tauri 默认（debug 可执行无 Info.plist icon），打包后的 .app 才带真实图标。
