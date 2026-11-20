# YueDuo Electron → Tauri 高质量重构执行方案

> 2026-11-20 制定，同日开始实施。本文件是重构期间的行为准则与进度存档（防意外），
> 重构完成后其内容并入 AGENTS.md 与 architecture.md，届时本文件可归档。
> 现阶段权威口径：本文档 + AGENTS.md（其中 Electron 专属章节已作废，见 §五）。
> 进度基线：commit `d9612cc`（dev 分支）。P0–P2 已完成并真机验收通过，待办见 §三 P3–P5
> 与 §七 续接指南。

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

### P3 — 集成域（待办，按 P3.1→P3.6 顺序执行）

> 进度基线：commit `d9612cc`（dev 分支，2026-11-21）。P3 前端契约**已全部备齐**
> （bridge.ts + shared/types.ts + 组件调用都在），以下任务只写 Rust 侧；
> bridge.ts 中已声明但 Rust 未注册的命令共 8 个 = P3.1 + P3.2 的全部工作量。

**P3.1 convert 域（4 命令）✅ 已完成（2026-11-21）**
- 缺失命令：`convert_to_halfwidth` / `convert_to_simplified` / `convert_to_traditional` /
  `convert_tidy`（bridge.ts 的 convertToHalfwidth/ToSimplified/ToTraditional/Tidy 已在调，
  菜单链路已通，注册后即整体生效）。
- 新文件：`services/find_rules.rs`、`services/convert.rs`、`commands/convert.rs`。
- **findRules 单一规则源**（老李 2026-11-20 强调，务必遵守）：
  - 把 `shared/findRules.ts` 改造成 `shared/findRules.json`（数组顺序即整理顺序）+ 薄 TS
    类型导出（`resolveJsonModule`），引用方 `src/components/FindReplaceBar.vue`（查找正则
    下拉列表用全部规则）保持语义不变；
  - Rust 侧 `include_str!("../../../shared/findRules.json")` 嵌入（注意从
    `src-tauri/src/services/` 起算的相对路径是三级 `../`），serde 解析成
    `Vec<FindRule>{ pattern, flags, replacement, description, tidy_enabled }`；
  - 所有规则进查找下拉（前端现状已如此）；`tidyEnabled: true` 严格按数组顺序用于一键整理；
  - 一键整理 = 繁转简 + 全角转半角（匹配集取 findRules 的 to_halfwidth 规则）+
    tidyEnabled 逐一替换；替换串展开语义与 TS expandReplacement 一致（`$1`/`$&`/`\n`），
    参考 `git show a46ae4a:shared/replaceTemplate.ts` 与 `electron/services/tidy.ts`；
  - 加 Rust↔Electron 逐字节对照测试防漂移（用 findRules 里的每条规则构造样例）。
- 简繁词表：`resources/dicts/`（ts/st_characters、ts/st_phrases、keep、ambiguous）。
  tauri.conf.json `bundle.resources` 加 `"../resources/dicts": "dicts"`；**dev 态
  resource_dir 不含资源** → 探测顺序：resource_dir/dicts → CARGO_MANIFEST_DIR/../resources/dicts。
  转换流水线对齐 `git show a46ae4a:electron/services/chineseConvert.ts`（保护词 keep →
  词组 phrases 最长匹配 → 单字 characters → ambiguous 保留）。
- 正则库注意：tidyEnabled 规则均为 RE2 兼容语法（无 lookahead），regex crate 可直接用。
- **落地纪要**：findRules.ts→JSON 用 node 从 TS 原文求值生成（非手抄）；Rust 侧
  `translate_pattern` 把 JS `\uXXXX` 转 regex crate 的 `\u{XXXX}`；替换模板展开
  （unescape + 分组）逐语义移植 TS replaceTemplate；tidy 的 JS gm 空匹配前进语义、
  文末幻影行加缩进均已用 node 复现原版验证为一致后写进测试断言；regex 只编译
  tidyEnabled + to_halfwidth 模式（无 lookahead，fix_dialogue 等纯查找规则不进 Rust）。
  验证：cargo test 42/42（新增 find_rules 4 + convert 7）、typecheck/lint/build 全绿。

**P3.2 meta 域（4 命令）✅ 已完成（2026-11-21）**
- 缺失命令：`meta_read` / `meta_apply_edit` / `meta_read_rating` / `meta_apply_rating`。
- 语义（对齐 `git show a46ae4a:electron/ipc/meta.ts`）：
  - `meta_read(path)`：读磁盘 → decode_bytes → `parse_metadata`（services/metadata.rs
    已有），库外/未入库文件的元数据栏首屏用；
  - `meta_apply_edit(path, text, field, value)`：**渲染层传当前正文**（可能是未保存内容），
    主进程只在内存算最小区间替换（port `electron/services/metadataWriter.ts` 的
    rewriteHeader/applyTextEdit → TextEdit{范围+新文本}），返回
    `{ edit, updated, metadata }`；按写回后正文重解析并同步 books（不等保存，B1）；
    field=tags 时同步 Finder 注释（P3.3 完成前可 log-skip）；
  - `meta_read_rating(path)`：库内取 books.rating（inLibrary=true），库外取 Finder 星级
    （无则 0）；
  - `meta_apply_rating(path, rating)`：clamp 0–5；库内走 books 更新 + 文件星级 xattr；
    库外只写 xattr，`persisted=false` 时渲染层回退（不能假成功）。
- 新文件：`services/metadata_writer.rs`、`commands/meta.rs`；types 补
  MetadataTextEdit/MetadataEditResult/RatingReadResult/RatingWriteResult（shared/types.ts
  已有定义，镜像到 types.rs）。
- 书库身份判定复用 `books::relative_in_library` + `find_book_by_relative_path`。
- **落地纪要**：`services/metadata_writer.rs` 按行移植 rewriteHeader（UTF-16 码元偏移，
  `apply_text_edit` 内做 utf16→字节偏移换算）；测试验证了扩展区汉字偏移、缺行补入顺序
  （书名→作者紧随→标签紧随）、前缀裁剪、头末追加分支；注意 **titleLineIndex 只看前两行**
  是 JS 原版口径（第 10 行的《书名》不算 title 行）。applyEdit 的 tags→Finder 注释同步
  与库外评分 xattr 留 P3.3 接入点（当前 log-skip / persisted=false）。cargo test 49/49。

**P3.3 Finder 元数据（services/finder.rs）✅ 已完成（2026-11-21）**
- xattr 直读写（`xattr` crate，免 spawn）：星级 `com.apple.metadata:kMDItemStarRating`
  （bplist00 实数：float marker `0x23` + 8 字节 BE double）；注释
  `com.apple.metadata:kMDItemFinderComment`（bplist00 字符串：UTF-16BE marker
  `0x60|字符数`，字符数 ≥16 用 `0x6F` + 2 字节长度；trailer 32 字节）。
  **禁止 plist crate 的 buildBinary**（字节布局与 Finder 期待不一致）。
- 注释写完再 `osascript`（spawn，路径与注释走 argv 不拼脚本）让 Finder `set comment`
  同步 Spotlight 索引（raw xattr 显示滞后）；返回
  refreshed/written/skipped/failed，失败记 warning 不阻塞。
- 写前读旧值，相同跳过。字节级往返单测 + 与 CLI `xattr -px` 输出对照。
- 接入点：① P3.2 的 tags 同步与 applyRating；② `file_write_text` 成功后库内文件同步注释
  （AGENTS.md 保存链路口径，失败仅 warning）。
- **落地纪要**：xattr crate 直读写原始字节（等价原版 CLI 十六进制通道）；bplist00 手写
  构造以 **python3 plistlib.dumps(FMT_BINARY) 逐字节对照测试**为权威防漂移口径（测试
  内联 spawn python3，比 CLI 对照更强）；osascript 2s 超时用 spawn+try_wait 轮询实现。
  接入点三处全通：meta applyRating（库内+库外）、meta applyEdit tags、file_write_text
  保存钩子、library_set_book_rating。cargo test 54/54。

**P3.4 退出握手 ✅ 已完成（2026-11-21）**
- 语义（对齐 `git show a46ae4a:electron/ipc/session.ts`）：退出请求 → emit `session:flush`
  → 渲染层 persist 草稿后调 `session_flush_done`（命令已在 bridge.ts）→ 放行退出；
  超时 **3000ms** 强制放行（FLUSH_TIMEOUT_MS）。
- 实现：lib.rs `.run()` 的 `RunEvent::ExitRequested`：`api.prevent_exit()` + 发 flush +
  Condvar 等待 `session_flush_done`（AppState 加一个 flush 槽，参照 EnrichResultSlot）→
  超时或收到 → `std::process::exit` / `api.exit(0)`；先 `state.shutdown()`（checkpoint）。
- 渲染层监听 `session:flush` 的逻辑已存在（原 Electron 会话 composable），零改动。
- **落地纪要（关键口径修正）**：`ExitRequested(None)` 在**最后窗口 Destroyed 之后**才触发
  （tauri-runtime-wry 源码证实），渲染层已死无法回执——握手不能挂在那里。实际挂两处：
  ① `WindowEvent::CloseRequested`（红点/关闭窗口菜单，窗口存活）prevent_close → 握手 →
  `app.exit(0)`；② `ExitRequested(Some(code))`（Cmd+Q/app.exit，窗口存活）prevent_exit →
  握手 → 完成后 `app.exit(0)`（handled 标记防双路径二次握手）；YUE_TEST 跳过握手
  （对齐原版 quitFlushled）。
- **真机反馈修正（2026-11-21，老李验证发现）**：初版在 run 回调里**同步**等回执——
  Tauri 的 emit 经主线程事件循环派发到 WKWebView，同步等待把主线程堵死 3 秒，事件根本
  发不出去（Electron 的 webContents.send 跨进程投递不依赖此循环，WKWebView 这套不行）。
  修正为异步握手：prevent 后立即返回，`FlushGate` 拆成独立 managed state（AppState 含
  rusqlite Connection 非 Sync，不能跨线程），后台线程等回执，完成后 run_on_main_thread
  → shutdown + app.exit(0)。

**P3.5 单实例锁 ✅ 已完成（2026-11-21）**：tauri-plugin-single-instance，Builder 首位注册；
second-instance → run_on_main_thread → show + set_focus。

**P3.6 验收**：按首次迁移真机清单全项复测——对话框/读写/菜单/主题/握手/Finder 星级注释/
Cmd+Z/简繁/一键整理/输入法；对照 Electron 版跑同书库同操作。

### P4 — 清理与文档 ✅ 已完成（2026-11-21）
- AGENTS.md 重写（§五要点全落实：作废 Electron 章节、Tauri 纪律新增——主线程规则/
  消息框 Custom 文案判定/资源探测/capabilities/dev 优化档/握手口径）、architecture.md
  重写为 Tauri 版（目录树、IPC 链路、退出握手时序、速查索引、六条红线）、README.md
  重写（Tauri 技术栈/命令/数据位置/打包）。本文件保留至 P5 完成后归档。

### P5 — 打包与性能验收 ✅ 已完成（2026-11-21）
- `npm run build` 产出 `.app`（22 MB）与 DMG（8.7 MB 压缩）。注意：`--bundles dmg`
  过程会清掉 `bundle/macos/YueDuo.app`，两个都要时先跑 dmg 再跑 `--bundles app`；
  DMG 的 hdiutil 需挂载 /Volumes，普通沙箱环境被拦（要豁免执行）。
- 打包验证：词表 8 个文件在 `Contents/Resources/dicts/`（bundle.resources 生效）、
  图标 icns 就位、identifier com.yueduo.reader、二进制 20MB。
- 实测数据：打包版启动恢复会话后稳定 RSS ≈ 400 MB（含全部恢复标签的 Monaco model
  全文 + preloadCount 预载）；Electron 版同场景无存档基线（已删），双进程 V8+Node
  典型 400–600MB+；体积 Electron 100MB+ → 22MB。启动/大书打开耗时对照以真机体感
  验收为准（dev 档优化后已达 Electron 同级）。
- YUE_TEST 验收模式与 CDP 脚本：Electron 专用形态随 scripts/ 删除（services 由
  cargo test 覆盖）；YUE_TEST 现语义 = 跳过确认框与退出握手 + YUE_USER_DATA 隔离。

**重构至此全部完成**：P0–P5 收官。本文件转入存档状态，日常开发以 AGENTS.md +
architecture.md 为权威口径。

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
| 消息框按钮映射：tauri-plugin-dialog 在所有平台都把原生结果转为 `Custom(按钮文案)`（desktop.rs 统一转换），按 `Yes/No/Ok` 枚举匹配恒落 default → 「放弃更改/保存/移到废纸篓」全部失效当「取消」。改按 `Custom(文案)` 匹配 + 原生值兜底（confirm_close/trash/dev_library 三处） | ✅ 已修（真机反馈） |

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

## 七、续接指南（新会话/新模型从这里开始）

**第一步**：读本文件（全文）+ AGENTS.md（注意其中 Electron 专属章节已作废）。
不需要读历史对话——本文档 + 代码即全部上下文。

**当前状态快照（2026-11-21，commit `d9612cc`）**：
- P0–P2 完成且真机验收通过（老李确认：窗口/主题/书库/打开文件/扫描/菜单均正常）。
- Rust 已注册 45 个 command（settings 2 / app 2 / file 7 / library 21 / session 4 / dialog 若干，
  见 lib.rs 的 generate_handler）。
- **bridge.ts 已声明、Rust 未注册的命令 = P3 全部缺口**：convert 域 4 个 + meta 域 4 个。
  注册前点击对应菜单/按钮会走 reject 报「命令未实现」。
- 退出握手（session:flush / session_flush_done）前端侧已就绪，Rust 侧 ExitRequested 未接。
- 工作树干净（除 .workbuddy/ 本地日志，已 gitignore）。

**常用命令**：
- 开发：`npm run dev`（= tauri dev；改 Rust 后重编译 1–3 分钟属正常）
- Rust 检查/测试：`cargo check --manifest-path /Users/Joey/Sites/Projects/YueDuo/src-tauri/Cargo.toml`
  与 `cargo test --manifest-path ...`（31 个用例；`-- --ignored --nocapture` 跑真实书库
  87 本编码回归，需已授权的验收书库在位）
- 前端：`npm run typecheck`（node+web 双侧）、`npm run lint`、`npm run build:web`

**关键文件地图**：
- IPC 契约三方：`src/ipc/bridge.ts`（前端唯一出口）↔ `src-tauri/src/types.rs`（serde 镜像）
  ↔ `src-tauri/src/commands/*.rs`；新命令三处同步 + lib.rs generate_handler 注册。
- 状态层：`src-tauri/src/state.rs` + `state/`（settings/db/library/books/bookmarks/session）；
  DB 操作都走 `state.with_active_db`（锁内同步执行，勿放长 I/O）。
- 业务层：`services/`（codec/files/scanner/reconcile/metadata/text），纯 Rust 可单测。

**Electron 原版参考**（已从工作树删除，git 历史可读，父提交 `a46ae4a`）：
- `git show a46ae4a:electron/ipc/meta.ts`、`electron/services/metadataWriter.ts`（P3.2）
- `git show a46ae4a:electron/services/finderMetadata.ts`（P3.3，bplist00 字节细节在此）
- `git show a46ae4a:electron/services/chineseConvert.ts`、`textConvert.ts`、`tidy.ts`（P3.1）
- `git show a46ae4a:electron/ipc/session.ts`（P3.4 握手）、`shared/replaceTemplate.ts`
- 首次 Tauri 迁移踩坑记录：
  `/Users/Joey/Sites/Projects/YueDuo-tauri/.trae/documents/tauri-migration-status.md`
  （其中「复刻时的关键事实」与「真机反馈与修复记录」仍有参考价值）

**纪律**：每完成一个文件跑 `npm run typecheck`；Rust 改动后 `cargo check` → `cargo test`；
提交前 `npm run lint`；单文件超 ~500 行拆分；新依赖需说明理由并锁版本；大型改动先在此
文档登记再动手。
