# YueDuo 重构方案（NovelManager → Electron + Vue 3 + Monaco）

## 一、背景

- **功能基线**：`/Users/Joey/Sites/Projects/NovelManager`（Python + PySide6，约 7800 行）。以它的 `AGENTS.md`「功能现状」为基础验收清单，并整合用户新增需求。
- **失败尝试**：`/Users/Joey/Sites/Projects/YueDuo_old`（6133 行）。以 Python 原版为准绳逐项翻译，YueDuo_old 只作参考与坑警示，不照搬。
- **本次目标**：在空白项目 `/Users/Joey/Sites/Projects/YueDuo` 重写。
- 用户已确认：参照 Python 重写 services、渲染层全新架构、全新数据库 schema、分阶段验收、依赖全部用最新稳定版（版本冲突/不稳定等客观因素才降级）。

## 二、YueDuo_old 的三个根因教训（新架构必须规避）

1. **标签切换用 `:key` 重建 Monaco 实例** → 焦点/IME 状态错乱（Enter 失效、跳固定标签、中文打不上屏的根因，4 轮修复失败）。
   ✅ 新方案：**单 Monaco 实例 + 每标签一个 model + `editor.setModel()` 切换**（VS Code 同款）。undo 栈随 model 天然隔离，切标签用 `saveViewState()/restoreViewState()` 恢复光标与滚动位置，焦点永不丢失。
2. **全文内容存进 Pinia reactive** → 几 MB 字符串走 Vue 响应式，每次击键触发 `emit → store → prop` 全链路。
   ✅ 新方案：全文只存在 Monaco model 里，store 只存元信息。保存/持久化时才 `model.getValue()`。
3. **职责混杂 + 逻辑重复**（App.vue 626 行全编排、正则数据硬编码在组件、解析逻辑主进程渲染层各一份）。
   ✅ 新方案：所有解析/转换逻辑只在主进程 services，渲染层零业务逻辑；App.vue 只做布局，交互逻辑进 composables。

## 三、技术栈与骨架

| 项           | 选型                                                                  | 要点                                                                                                                                     |
| ------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 脚手架       | `npm create electron-vite@latest`                                     | Electron 最新稳定版（`npm view electron version` 实查）+ ESM 主进程；禁止 `__dirname`/`__filename`                                       |
| 前端         | Vue 3 + TS 严格模式 + Pinia（均最新稳定版）                           | stores 只存元信息与 UI 状态                                                                                                              |
| 编辑器       | Monaco 最新 + `vite-plugin-monaco-editor`                             | 唯一 worker 加载路径；API 使用前 grep 类型声明确认存在                                                                                   |
| 数据库       | better-sqlite3 最新（仅主进程）                                       | `npx prebuild-install --arch=<arm64/x64>`（对应最新 Electron ABI，先查 `process.versions.modules`），禁止 npm rebuild / electron-rebuild |
| 编码         | iconv-lite                                                            | 复刻 Python `text_codec.py` 探测链                                                                                                       |
| 简繁         | OpenCC（四表 + keep/ambiguous，从 `NovelManager/assets/dicts/` 拷贝） | 策略照 Python：保护词 → 词组最长匹配 → 单字 → 多义字保留                                                                                 |
| Finder xattr | spawn `xattr` + 手写 Python plistlib 风格 bplist00                    | float marker `0x23`、NSString UTF-16BE marker、32 字节 trailer                                                                           |
| 打包         | electron-builder                                                      | 阶段 3 再做                                                                                                                              |

**版本基线（2026-11-17 npm 实查最新稳定版）**：Electron 45.3.3、Vue 3.5.45、Monaco 0.57.0、better-sqlite3 13.2.0、Pinia 4.1.0、Vite 8.3.8、electron-vite 6.0.0。客观冲突（如 electron-vite 对 Vite 8 的 peer 限制）按用户规则适当降级，并在提交信息说明原因。

**Monaco worker 加载修正**：`vite-plugin-monaco-editor` 停更于 1.1.0（CJS，Vite 8 兼容风险），改用 Vite 原生 `?worker` 导入（`monaco-editor/esm/vs/editor/editor.worker?worker`，纯文本场景只需 editor worker）。仍遵守铁律：worker 只走这一条路径，不配 `MonacoEnvironment.getWorkerUrl`、不用 AMD loader；若 `?worker` 路径失败再回退插件方案。

**本机环境**：Intel Mac（x86_64）——prebuild-install 必须 `--arch=x64 --runtime=electron --target=<实际安装的 Electron 版本>`。

### 目录结构

```
YueDuo/
├── electron/
│   ├── main.ts / preload.ts
│   ├── ipc/            # 按域分 handler：file / library / session / convert / finder / dialog
│   └── services/       # 纯 Node 可单测：database / textCodec / scanner / reconcile /
│                       #   metadataParser / metadataWriter / chapterParser /
│                       #   chineseConvert / tidy / finderMetadata / bookIdentity / sessionStore
├── src/
│   ├── App.vue         # 只做三栏 + 状态栏布局
│   ├── components/     # TabBar / EditorHost / LeftSidebar / RightPanel / MetadataBar /
│   │                   #   StatusBar / CommandPalette / StarRating / SectionTitle / FindReplaceBar
│   ├── composables/    # useEditorCommands / useTabs / useTabLifecycle / useSession /
│   │                   #   useLibrary / useFindReplace
│   ├── stores/         # tabs / library / settings（无全文内容）
│   ├── styles/theme.ts # LIGHT/DARK/METRICS/READING_* token → CSS 变量
│   └── ipc/bridge.ts   # 唯一 IPC 出口
├── shared/types.ts
└── assets/dicts/ + icons/   # 从 NovelManager 拷贝
```

### IPC 契约（全部 `ipcRenderer.invoke` → `{ok:true,data}` | `{ok:false,error}`）

| 通道                                                              | 入参                   | 返回                | 用途                                              |
| ----------------------------------------------------------------- | ---------------------- | ------------------- | ------------------------------------------------- |
| `file:readText`                                                   | `path`                 | `{text, encoding}`  | 打开/按需重载标签（textCodec 探测+转换+换行归一） |
| `file:writeText`                                                  | `path, text`           | `{encoding}`        | 保存（UTF-16LE + 临时文件替换）                   |
| `file:stat`                                                       | `path`                 | `{ino, size}`       | 同文件去重（inode）                               |
| `library:open`                                                    | `root?`                | `{root, dbCreated}` | 打开/切换书库（realpath 归一 + 建库）             |
| `library:fastScan`                                                | —                      | 目录树 + 文件清单   | 秒开目录树                                        |
| `library:enrich`                                                  | —                      | 进度事件            | 后台补元数据 + 对账                               |
| `library:books` / `:tags` / `:history`…                           | 过滤参数               | 列表                | 各管理页查询                                      |
| `session:restore` / `session:persist`                             | — / 会话对象           | 会话对象 / void     | 会话读写                                          |
| `meta:applyEdit`                                                  | `path, {field, value}` | `{textEdit}`        | 元数据写回（返回最小可撤销编辑区间）              |
| `finder:getRating` / `:setRating` / `:getComment` / `:setComment` | path (+值)             | 值/void             | xattr 读写（写前读旧值，相同跳过）                |
| `convert:s2t` / `:t2s` / `:tidy`                                  | `text`                 | `{text}`            | 主进程转换                                        |
| `dialog:chooseLibrary` / `:confirmClose` 等                       | —                      | 用户选择            | 原生对话框                                        |

## 四、全新数据库 schema（v1）

放**书库根目录** `yueduo.db`（随库搬迁；无库回落 userData）。
**关键约定：`relative_path` 相对书库根目录、不含书库总目录名**（书库根 = `/Users/Joey/Sites/Projects/小说` 时存 `金庸/笑傲江湖.txt`）。

```sql
books(id, relative_path TEXT UNIQUE NOT NULL, filename, title, author, tags,
      rating 0-5, word_count, size_bytes, progress_line, encoding, last_read_at,
      created_at, updated_at)
bookmarks(id, book_id FK CASCADE, line > 0, note, created_at, UNIQUE(book_id, line))
tag_ratings(tag PK, rating 0-5, updated_at)
session_state(id=1, active_tab_id)
session_tabs(id, position, book_id NULLABLE, path, title, progress_line,
             dirty, draft BLOB, view_state TEXT, last_focused_at)
```

- 增量迁移：`PRAGMA user_version` + 缺列 ALTER，建表语句只对新库生效。
- WAL 模式；better-sqlite3 同步 API 单连接。

### 书籍身份对账（reconcile）算法

扫描入库后执行，三步：

1. **直命中**：库内记录按 `relative_path` 在本次扫描结果中找到 → 正常更新元数据（word_count/size/编码）。
2. **移动识别**（未直命中的记录）：在本次扫描的「未匹配新文件」中做综合评分匹配：
   - 候选条件（任一）：`title` 相等 且 `filename` 相等；或 `filename` 相等 且 `|size_bytes 差| / size ≤ 5%`；或 `title` 相等 且字数差 ≤ 2%
   - **唯一候选** → 判定为移动，更新 `relative_path`（id/评分/进度/书签全保留）
   - 多候选或零候选 → 挂起，`miss_count += 1`
3. **删除清理**：`miss_count ≥ 2`（连续两次扫描零匹配）→ 删除记录（书签随 FK CASCADE）。
   - 对账结果写入 `reconcile_log`（内存级日志，UI 可查：「已识别移动 N 本 / 疑似删除 N 本」），删除操作先列出清单。

## 五、分阶段任务清单（编号供逐项细化讨论）

### 阶段 0：脚手架（✅ 2026-11-17 完成）

- [x] **0.1** electron-vite 6 + Electron 45.3.3 + Vue 3.5 + TS 严格 + ESLint，可构建可运行。
- [x] **0.2** Monaco 0.57 经 `?worker` 接入，大文件配置见 `src/monaco.ts`；4.8MB 一次性 `setValue` 249ms。
- [x] **0.3** better-sqlite3 13.2 主进程 external + `verify:native`，Electron 内真实建表插查通过（零 rebuild）。
- [x] **0.4** 单实例锁 + contextIsolation/contextBridge + IPC 统一 `{ok, data|error}`；`YUE_TEST` 无窗验收可用。

> **阶段 0 保留的坑与技术决策（可检索）**
> - **脚手架**：`@quick-start/create-electron`（`create-electron-vite` 无 electron 模板）；目录 `electron/`（main/preload/ipc）+ `src/`（renderer，publicDir→根 `public/`）。
> - **Monaco 子路径**：0.57 写 `monaco-editor/editor/editor.api`（不带 `esm/vs`；主入口注册 90+ 语言太重）。
> - **`isPackaged` 误判**：Electron 45 macOS 从 node_modules 启动时 `is.dev` 不可信，改判 `ELECTRON_RENDERER_URL` 是否存在。
> - **better-sqlite3**：13.2 内置 N-API prebuilds（darwin-x64.node），无需 prebuild-install；`ELECTRON_RUN_AS_NODE=1` 真实 require 验证。
> - **验收**：502 万字符 `setValue`+`setModel` 253ms；`native:sanity` 全链路 OK。

### 阶段 1：核心编辑器闭环（焦点 bug 在此架构下天然不存在）

- [x] **1.1** `textCodec` 完成：逐行翻译 Python `text_codec.py`（BOM 表 UTF-32 先于 UTF-16、无 BOM UTF-16 字节序推断、chardet + GB18030 复核、fallback 链 utf-8→gb18030→big5、换行归一、去残留 BOM），真实样本 12/12 通过，9.7MB 全文探测解码 29ms；实现见 `electron/services/textCodec.ts`，测试见 `scripts/test-text-codec.ts`。
- [x] **1.2** `EditorHost` 完成：单 Monaco 实例 + model 注册表（非 reactive）+ `setModel`/`saveViewState`/`restoreViewState`，Pinia 只存标签元信息；`file:readText` 已接 textCodec，真实书库双标签验收（`YUE_TABS_OK`）通过；实现见 `src/components/EditorHost.vue`、`src/composables/useTabLifecycle.ts`、`src/stores/tabs.ts`。
- [x] **1.3** dirty 追踪完成：`getAlternativeVersionId()` 对比载入基线（O(1)）；LRU 卸载重载后以 draft 为基线（哨兵 -1：重载草稿内容的 model isDirty 恒真直到保存，undo 栈为空无撤销回基线路径）；见 `src/composables/useTabLifecycle.ts`。
- [x] **1.4** 保存完成：`file:writeText`（UTF-16LE、临时文件写 + rename 替换，同目录失败退系统 tmp）；保存后重置基线、清 dirty、清 draft、stat 缓存刷新（rename 后 inode 已变）；CDP 验收 dirty→保存→重读含标记通过；见 `electron/ipc/file.ts`、`src/composables/useEditorCommands.ts`。
- [x] **1.5** `TabBar` 完成：Chrome 圆弧标签（SVG 月牙填充 + 贝塞尔弧描边复刻 `FlaredTabBar`，flare=8/k≈4.42，首尾标签留落点边距）；完整书名不裁切（无 max-width，溢出滚动）；`Cmd+N` 新建、关闭确认（dirty 才弹 `dialog:confirmClose` 三选一）、dirty 黑点；见 `src/components/TabBar.vue`、`src/composables/useTabs.ts`、`electron/ipc/dialog.ts`。
- [x] **1.6** 同文件单标签完成：两层去重——path 快查（免重复大文件读取）+ `file:stat` inode 优先/realPath 兜底（stat 缓存独立于 model 生命周期，LRU 卸载不影响去重；保存 rename 换 inode 后 stat 刷新）；见 `src/composables/useTabs.ts`、`useTabLifecycle.ts` 的 statCache。
- [x] **1.7** **上百标签驻留与按需渲染完成**，CDP 真实书库 28 标签验收全绿：
  - model 注册表（`useTabLifecycle`，非 reactive）：`Map<tabId, {model, viewState, loadedAt, baselineVersionId}>`
  - 驻留集合：当前 + `lastFocusedAt` 前 10（`PRELOAD_COUNT=10`，1.9 接 settings）；28 标签实测驻留精确收敛 11
  - 卸载：切换时同步计算 + 5 分钟定时兜底；dirty → `file:writeDraft`（全文+viewState 经 IPC 存主进程内存级草稿，**1.8 迁 SQLite session_tabs，IPC 不变**）→ dispose；卸载前复查驻留（在途切回则保留，竞态防护）；验收卸载后草稿含修改全文
  - 重载：加载态遮罩 → draft/text 二路 → 完成者校验（激活代际 seq + activeTabId 双检，重载中切走直接让位）；验收点已卸载标签重载内容一致、dirty 哨兵保持、保存清草稿
  - 恢复会话预载：1.8 接（session_tabs 驱动）
  - 注：快速连续切换时中间标签跳过加载（完成者校验预期行为），驻留集合是上限资格而非强制全载
  - 实现见 `src/composables/useTabLifecycle.ts`（unloadModel/reloadModel/waitUnloadSettled）、`src/components/EditorHost.vue`（activateEditorFor/scheduleEviction）、`electron/services/draftStore.ts`
- [x] **1.8** 会话恢复完成（`6f23e0b`）：`session:persist`/`session:restore` 落 `session_tabs`（顺序/active/progress_line/dirty/last_focused_at）与 `session_state`；draft/view_state 经 `file:writeDraft` 写同一行（IPC 契约不变）；标签增删/切换/滚动 2 秒防抖，关窗与 `before-quit` 握手阻塞等待落盘；progress_line 取视口顶部行，恢复用 `setScrollTop(getTopForLineNumber())` 顶部对齐；退出前为驻留未卸载的脏标签补写草稿，重启后按 draft 恢复并保持 dirty。验收（临时 userData）：两次重启顺序/active/顶部行一致，滚动 2 秒同步，关窗后 WAL 清零，`YUE_TABS_OK` 未回归。见 `electron/services/sessionStore.ts`、`electron/ipc/session.ts`、`src/composables/useSession.ts`
- [x] **1.9** 设置持久化（userData 下 JSON）：外观、侧栏宽度、书库根目录、预载数量、关闭按钮常驻。**最小切片已落地**（`903f6ad`）：外观三态已持久化，settings 服务与 `settings` IPC 域已存在。**已完成剩余字段**：`AppSettings` 扩为五个字段（`shared/types.ts` 的 `DEFAULT_SETTINGS` 为两侧共用默认值），`settingsStore.normalize` 逐字段校验——侧栏宽度夹 160–640、预载数量夹 0–20、书库根目录仅接受字符串、关闭常驻仅接受布尔，缺字段只回落该字段默认值（旧 settings.json 升级不整体重置）；主进程写回先与旧值合并，避免局部载荷把其他设置重置；渲染层 store 统一 `snapshot()`+`persist()`，所有 setter 都写完整对象。消费侧：侧栏右缘拖拽条（松手才落盘）→ `sidebarWidth`；`setPreloadCount()` 注入 LRU 驻留集合，设置变化立即 `scheduleEviction()` 收敛；TabBar 按 `closeButtonAlwaysVisible` 决定关闭按钮常驻或仅 hover/当前标签显示；书库根目录经 `dialog:chooseLibrary` 选择并持久化，阶段 2 起作为书库根消费。**验收**（临时 userData + CDP + tsx 单测）：拖拽 240→360、越界夹到 160/640；预载 0 时驻留由 2 收敛到 1；关闭常驻关闭后非当前标签 `opacity:0`、当前标签 1，重开恢复；书库路径写入并显示；重启后五字段与标签/主题全部恢复；脏数据夹取与损坏 JSON 回落默认值通过。
- [x] **1.10** 主题 token + 浅/深/跟随系统 + 状态栏完成：token 唯一定义在 `src/styles/theme.ts`（`LIGHT_COLORS`/`DARK_COLORS`/`METRICS`/`READING`，注入 `--yd-*`，TabBar 六个无定义变量与全部写死色收回）；主进程 `nativeTheme.themeSource` 为唯一判定口径，`nativeTheme.on('updated')` 经 preload `onThemeUpdated` 推送 `theme:updated`；Monaco 双主题与 token 同源；状态栏显示文件名/完整路径（目录收缩=中间省略，tooltip 全路径）/编码/字数/`行 x / y`，字数与行数走 `getValueLength`/`getLineCount`（O(1)）；外观持久化由 1.9 最小切片提供。**验收口径**：字数按 `getValueLength()` 的字符数（含换行）；LRU 重载后不回读外部改动过的编码。见 `src/styles/theme.ts`、`src/stores/settings.ts`、`src/components/StatusBar.vue`、`src/composables/useStatusMetrics.ts`、`electron/ipc/theme.ts`
- [x] **1.11** **左栏「编辑」页**（VS Code 资源管理器逻辑）：列当前打开的全部文本（顺序同标签页），点击切换标签，条目显示 dirty 圆点/完整名称，右键关闭/关闭其他；左栏共六页（编辑/书架/历史/追更/标签/评分）。**已完成**：`src/components/Sidebar.vue`（列表顺序即 store 顺序、点击切换、dirty 圆点、名称省略但 tooltip 全名、右键菜单「关闭/关闭其他」，右键先激活该条）；App 布局改为 header → workspace（Sidebar + TabBar/编辑器列）→ StatusBar；侧栏尺寸/字号入 `METRICS` 并注入 `--yd-sidebar-*`。**验收**（临时 userData + CDP）：点击左栏切标签生效、编辑后圆点同步、右键菜单两项、关闭其他只留目标、关闭空白标签无对话框；深色切换后侧栏与编辑器同源 token 跟随。其余五页属 2.5。
- [x] **1.12** 阶段验收：真实书库打开多本大 TXT，编辑/保存/切标签/重启恢复 50+ 标签场景，全程无焦点丢失与 IME 异常。**自动化部分已通过**（临时 userData + 真实书库只读）：57 个标签（含 2 个自动打开）9.3s 开完，驻留收敛到 11（预载 10 + 当前）；56 次逐标签切换无加载失败、驻留不涨；编辑→保存→回读含标记且落盘 UTF-16LE；制造 1 个脏标签并滚到 1200 行后重启，57 个标签顺序一致、dirty 保留、该标签首个可见行恰为 1200（顶部对齐）；正常关窗退出后无 `-wal`/`-shm`。**人工验收已通过（2026-11-17）**：用户实测切换标签后可直接输入、关窗重开后可直接输入、光标回到上次位置、中文候选框正常，焦点与 IME 两项均确认无异常，本项勾选完成。**焦点丢失已定位并修复**：标签栏/左栏条目是普通 div，点击时 mousedown 把正文输入面（Monaco `native-edit-context`）的焦点掉到 `body`；LRU 重载路径 `setModel(null)` 同样会失焦；`activateEditorFor` 两个分支和会话恢复路径都没有 `editor.focus()`。已在激活完成、切换同一标签、关闭标签后统一交还焦点（用户正在路径框/设置项等输入控件时不抢焦点）。复验：失焦后点标签栏/左栏切换、LRU 重载回来的标签、重启后点恢复的标签，`document.activeElement` 均回到编辑器内；CDP `Input.insertText` 不点正文直接输入，文字进入对应 model 并置 dirty。IME 候选框位置已由人工验收确认正常。**全局键盘监听核查**：当前仅三处 `window keydown`——`App.vue` 的 Cmd/Ctrl+N（`preventDefault` 后新建空白标签）、`EditorHost.vue` 的 Cmd/Ctrl+S（保存，编辑器内另有同键 addCommand）、`Sidebar.vue` 的 Escape（只清右键菜单），主进程无 `globalShortcut`/`before-input-event`，全仓无 Enter 监听。CDP 实测：焦点在正文按回车只插入换行、标签数与 active 不变；焦点在 body 按回车也不会打开或切换任何书，不存在旧项目「回车打开固定书」的监听。**重启后光标丢失已定位并修复**：会话快照原来只存 `progress_line`（视口顶部行），从不存光标；启动恢复的 `applyStoredView` 只滚到顶部行，`setModel` 默认把光标放在 (1,1)，所以重启后光标跑到第一行（LRU 重载那条路走草稿 viewState 的 cursorState，所以不丢；`focus()` 不会重置选区，不是原因）。修复：`session_tabs` 增 `cursor_line`/`cursor_column`（v2 迁移，旧库启动自动补列），`captureProgress` 同步抓光标、`session:persist` 落库、`restoreSession` 注入非 reactive 的 `restoredView`，标签首次激活一次性应用——先按 `progress_line` 顶部对齐，再 `setPosition` 回光标，最后 `revealPosition` 最小滚动兜底：光标在屏内就不动进度，只有落到屏外才滚到刚好可见（不居中跳屏）；旧库无光标字段时退回草稿 view_state。复验（临时 userData + 真实书库）：视口 3000 / 光标 3020:3 重启 → 光标 3020:3、视口顶部 3002（仅滚 2 行让光标可见）；视口 3000 / 光标 500（屏外）重启 → 光标 500:1、视口下落到 500 保证可见；脏标签（draft 全文 + 光标）重启后 dirty/正文/光标均保留；进程内切标签仍走 viewState，选区与焦点不回退。

### 阶段 2：书库与元数据

- [x] **2.1** `database` 服务：全新 schema 建表 + 增量迁移 + WAL。**已完成**：v3 迁移建 `books`/`bookmarks`/`tag_ratings`（`miss_count` 预留给 2.3 对账，`relative_path` 唯一、评分 0–5 CHECK、书签 `(book_id, line)` 唯一且随书 CASCADE），连接开启 `foreign_keys`、保持 WAL；纯 Node 脚本验过全新库建表、v2 旧库（真实 15 标签）增量迁移、约束/CASCADE 与重复启动幂等。
- [x] **2.2** `libraryScanner`：递归扫 `.txt`；两阶段（fastScan 先建目录树秒开，后台 enrich 补元数据）——此设计源自用户本人、Python 旧项目已有实现，以 Python 实现为准翻译。**已完成**：fastScan 即 `listDirectory` 一层一读（目录在前、TXT 在后、名称排序、断链跳过，不碰数据库与正文）；enrich 深度优先遍历、`realpath` 定身份（链接与真实文件只入一次）、解码 → 解析元数据 → 按 `relative_path` 直命中写库，每 10 个成功文件回调进度、支持取消，不可读文件跳过，重扫只更新扫描可得字段（评分/进度/最近阅读与 `miss_count` 不动，移动/删除留给 2.3）。元数据解析基线按依赖放在 `metadataParser.ts`，2.4 再做专项边界验收。真实书库验收：根层 34 项展开 1ms、85 本 enrich 约 2.9s 全部入库；合成库验过目录顺序、符号链接去重、UTF-16 探测、书名/作者/标签兜底、重扫保留评分与进度、取消提前停止。
- [x] **2.3** `reconcile` 服务：§四对账三步，含 `miss_count` 跟踪与对账日志。**已完成**：直命中清 `miss_count`；移动候选按「书名+文件名 / 同文件名且体积差 ≤5% / 同书名且字数差 ≤2%」任一匹配，只有唯一候选才合并（沿用旧 id，评分/进度/最近阅读/书签全保留，删掉扫描临时插入的新行），多候选不猜；零匹配 `miss_count + 1`，连续两轮才删除并先列清单，书签随 FK CASCADE；空扫描结果直接返回，避免根目录不可达时误删全库。对账日志内存级保存（`getReconcileLog`），UI 可查移动/疑似删除数。合成 8 组场景验过：移动三规则、多候选挂起、二次零匹配删除、书签保留与级联、空扫描保护。
- [x] **2.4** `metadataParser`：书名（前两行书名号，否则文件名）、作者（前十行 `作者：`，否则佚名）、标签（前十行 `主题：`，否则目录名）。**已完成**：与 Python `metadata_parser` 同口径，补 `findTopic`（取主题原文供 2.10 同步 Finder 注释）与 `Path.stem` 一致的后缀处理；验收覆盖书名行位（第 2 行命中、第 3 行不算、多书名号取首个、空书名回退）、作者/主题行首空白与全角冒号、第 10/11 行边界、空值回退、标签混合分隔符、字数排除全角空格、点文件等边界，并对真实书库 85 本逐本独立核对通过。
- [x] **2.5** 左栏五页共用打开流程：**书架**（资源管理器式惰性树：目录在上书在下、默认折叠）、**历史**（last_read_at 倒序）、**追更**（标签精确匹配「追更」）、**标签**（名称/数量/标签评分三列，点星改分、点标签列书）、**评分**（五星筛选、慢速再点同分取消、未筛选列前 100 本）。**已完成**：新增 `library` IPC 域（`open/fastScan/enrich/history/following/tags/booksByTag/rated/setTagRating`）与扫描进度推送（`library:scanProgress`，每 10 个成功文件一次）；`bookRepository.ts` 纯 Node 查询，标签用 `' '||tags||' '` 精确匹配（「追更中」不算「追更」），评分页未筛选 `LIMIT 100`、有筛选不设上限，标签按评分/数量/名称排序；左栏壳改为六页小标签（`Sidebar.vue`），编辑页拆到 `sidebar/SidebarEdit.vue`，书架 `SidebarShelf.vue` 一层一读、目录默认折叠、点击目录才展开，历史/追更/标签下钻/评分共用 `SidebarBookList.vue` 打开流程（`openFile` + `activateTab`，同标签也交还焦点），标签页 `SidebarTags.vue` 三列 + 点标签列书 + 点星改标签评分，评分页 `SidebarRating.vue` 五星筛选；「再点同分取消」手势抽到 `useRatingGesture.ts`（模块级判定表，重排/重建行不丢），阈值 500ms。**范围说明**：列表行只展示书星级，改书评分留给 2.9 元数据栏与 2.10 Finder 同步；数据库仍在 `userData`，按书库根建库/切库属 2.13，本步不迁库；启动沿用「列表秒读库 + 后台 enrich」，切换书库由设置入口触发。**验收**：服务层临时库 11 项全过（追更精确匹配、历史倒序、标签计数/评分置顶/取消保留行、按标签列书、评分 100 上限与筛选、绝对路径）；CDP 临时书库 + 临时 userData：书架默认折叠（丙/乙/甲三目录）→ 点甲展开出书 → 点书开标签，历史 2 本倒序、追更 1 本、标签 5 行三列、追更下钻 1 本、评分未筛选 3 本→筛 5 星 1 本→慢速再点取消回 3 本，标签评分 2→4→慢速再点取消 0，历史点书也能打开；160px 窄栏六标签自动换行、无横向溢出；typecheck（node/web）与 lint 全过。
- [x] **2.6** 右栏三页：**章节**（后台提取、保存后重提、点击跳转；章节占 2/3 书签 1/3）、**书签**（按行号、两行条目、摘要 15 字、光标空行顺延）、**历史**（最近阅读倒序）。**已完成**：`chapterParser.ts` 逐行套用 Python `EXTRACT_CHAPTERS` 同一正则（含行首缩进、第…章/回/节/卷/集/部/篇、序章/楔子/卷首/尾声/后记/番外），主进程 `library:chapters` 读文件解码后后台提取；`bookmarkRepository.ts` 纯 Node 实现按 `relative_path` 读写、未入库书籍补最小记录、同行 upsert、行号升序、`book_id` CASCADE；新增 `library:bookmarks/addBookmark/removeBookmark`，书库外文件只读返回空、写入明确报错。右栏 `RightPanel.vue` 三页小标签（章节/书签/历史，带数量），章节页 `right/ChapterPage.vue` 上 2/3 章节、下 1/3 本书书签，书签页与章节页共用 `right/BookmarkList.vue`（两行条目：行号 + 摘要；摘要取当前正文，超 15 字加省略号；添加时从光标行向下顺延到第一个非空行，同行不重复；点击跳转、悬停删除），历史页复用 `SidebarBookList.vue` 的最近阅读倒序。`useEditorCommands` 保存成功后调用 `refreshChaptersForPath`，按落盘正文重提当前书章节，不做全库重扫。宽度与左栏共用 `sidebarWidth`（保持同宽，拖拽夹 160–640，松手落盘）。**实测调整**：左栏原「历史」页与右栏历史页重复，已移除左栏页签，历史只保留右栏；标签栏原生横向滚动条改细并移到顶部（见 `0b5c52b`）。**范围说明**：2.6 先用书签面板底部「添加书签」按钮作为触发入口，编辑器右键添加与全库书签按书分组留给 2.7；编辑导致书签行号漂移的自动跟随不在本步。**验收**：服务脚本 `scripts/test-right-panel.ts` 11 项全过（章节 8 条/行号/缩进/不误匹配、书签排序/同行更新/补书籍记录/删除）；CDP 临时书库 + 临时 userData：打开 220 行测试书 → 章节 4 条（第1章/第2章/第3章/番外）→ 点「第3章 归途」光标到第 121 行；光标停第 6 行空行添加书签落到第 7 行，第 62 行长行摘要截为 15 字 + 省略号，点击回跳第 7 行、删除生效，书签页 2 条；右栏历史页显示「长篇测试」；在第 1 行插入「第4章 新章」保存后，章节 4→5 条且标签计数同步，无需重启；截图见 `/tmp/yue-26-right-panel.png`；typecheck（node/web）与 lint 全过。
- [x] **2.7** 书签系统：右键「添加书签」、点击跳转、全库书签页按书分组。**已完成**：编辑器右键新增「添加书签」（`editor.addAction`，分组 `bookmarks`；`editor.api` 精简入口不含菜单实现，显式引入 `contrib/contextmenu`，并在 `electron.vite.config.ts` 用 `optimizeDeps.exclude` 排除两个 monaco 子入口，避免预打包出两份 `MenuRegistry` 导致菜单为空），光标落在空行时顺延到下一非空行、同行不重复，结果经状态栏提示；`bookmarkRepository.ts` 增 `listLibraryBookmarks`（JOIN books，按 `relative_path`/文件名/行号排序聚合成组，书名空时退回文件名 stem）与 `replaceBookmarks`（事务内整本替换，过滤非法/重复行），IPC 增 `library:allBookmarks`/`library:replaceBookmarks`；右栏「书签」页改为全库分组 `right/LibraryBookmarkPage.vue`（组标题「书名（N）」默认展开、点组折叠、条目「第 N 行 · 摘要」摘要 18 字、点条目打开书并跳行），当前书书签仍留在章节页与 `BookmarkList.vue`。**行号漂移跟随**：`useBookmarkDrift.ts` 按行数差量 delta 调整——changed_line 之前不动，delta>0 其后 +delta，delta<0 落在删除区内的丢弃、其后 +delta，去重后 800ms 防抖整本 `replaceBookmarks` 回写；切标签与退出前 `flushBookmarkDrift` 立即落盘；落库后通知右栏当前书列表与全库分组一起刷新。**一并完成**：标签栏横向滚动条不滚动时自动隐藏（滚动/拖拽/悬停才显示，停手 900ms 淡出，绝对定位置顶、不改标签栏高度与标签位置，不写死尺寸颜色）。**验收**（临时书库 + 临时 userData + CDP 真实窗口）：右键菜单出现「添加书签」并通过真实左键点击落库第 65 行；全库分组两本书 `多情剑客无情剑（2）`/`笑傲江湖（2）`、摘要 18 字截断、点他书条目切到该书并定位第 30 行；书签 64/65 时首行插入 → 65/66，删除首行 → 64/65，删除书签所在行 → 该条丢弃、其后 -1，插入 3 行后立即切标签 700ms 内库已更新（flush），300ms 时库仍为旧值、1200ms 已更新（800ms 防抖）；滚动条 rest opacity 0 → 悬停 1 → 移开淡出 0 → 滚动后 300ms 仍显示、停手后 0，标签栏高度恒 34、滚动条贴顶。`scripts/test-right-panel.ts` 增全库分组与整体回写 6 项断言全过；typecheck（node/web）与 lint 全过。**实测调整**：全库书签页摘要过长会撑开 `.yd-panel`（横向 flex 项 `min-width:auto`），整页跟着横向滚动；已给 `.yd-panel` 补 `min-width:0`，条目按自身省略号固定截断，与章节页本书书签一致；章节页「书签」标题顶部离分割线过近，补 `--yd-panel-padding` 间距。
- [x] **2.8** `metadataWriter`：名称/作者/标签写回正文前 10 行（缺失按书名→作者→标签补行），生成**最小可撤销 TextEdit**（一次最小区间替换、保光标、触发未保存标记），再同步库。**已完成**：`metadataWriter.ts` 逐行对齐 Python `metadata_writer.rewrite_header`（前 10 行、书名只认前两行、缺失按书名→作者→标签补行、前后缀裁剪出最小字符区间、内容无变化返回 null 避免无意义 dirty）。**契约调整（已确认）**：`meta:applyEdit(path, text, field, value)` 额外携带编辑器当前正文——原方案只传 path，主进程若读磁盘，未保存修改时字符偏移会错位；主进程只在内存算区间，再按写回后的正文重解析并同步 `books`（B1：提交即同步、不等保存；文件不在活动书库时 `updated:false`）；渲染层 `useMetadataEdit` 负责空书名/空标签放弃、空作者落「佚名」，用 `pushUndoStop` 包住一次 `executeEdits` 应用（dirty 沿用 `getAlternativeVersionId` 追踪），`updated` 时刷新左栏列表。**验收**（临时库 + 临时 userData + CDP）：先制造未保存修改（第 150 行正文改写、第 1 行书名改为更长的「《旧书名增补》」、光标移到 160:3）再改书名 → 第 1 行精确变「《终书名》」且无旧文本残留（证明偏移按内存正文计算）、第 150 行修改保留、光标仍在 160:3、dirty 保留、一次撤销回到「《旧书名增补》」且正文修改不丢；提交后库内书名立即更新而磁盘仍为旧值；空作者→「佚名」、标签「科幻 星际」→「主题：科幻,星际」、空白书名放弃；保存后磁盘 UTF-16LE 头部三行正确、dirty 清除。`scripts/test-metadata-writer.ts` 29 项断言全过（含空正文、第 2 行书名、第 10 行边界、10 行头部末尾追加、`$` 原样保留、长正文其余逐字不变）；typecheck（node/web）与 lint 全过。
- [x] **2.9** 元数据栏：**位于编辑器下方、状态栏上方**（旧项目方案）；编辑名称/作者/标签/评分四项，点击即改、回车上屏、失焦取消；星星「再点同分清零」手势。**已完成**：新增 `src/components/MetadataBar.vue`，挂在 `App.vue` 编辑器列末尾（编辑器 `main` 之后、全局状态栏之前）；名称/作者/标签展示态点击变输入框、回车提交、失焦/Esc 丢弃草稿，提交只调 2.8 的 `useMetadataEdit().applyMetadataField`，因此仍是「主进程算最小替换区间 → `pushUndoStop` + 一次 `executeEdits`」同一条链路，空书名/空标签放弃、空作者落「佚名」也沿用 2.8 的渲染层约定；评分直接调 2.5 已有的 `library.setBookRating`（同一条库内评分 + Finder 星级写入），手势复用 `resolveRatingClick`（模块级判定表，500ms 后再点同分清零），未另开写入路径。**读取侧（只读新增）**：`library:bookByPath` 按当前路径取库记录（书名/作者/标签/评分与 book id），文件在库内时一次拿全；库外/尚未入库回退 `meta:read` 按磁盘正文解析，评分入口置灰并提示只对库内书籍开放。**样式**：`METRICS` 新增元数据栏高度/内边距/间距/字号/输入框内边距/圆角 token 并注入 `--yd-metadata-*`，组件不写死数值。**验收**（临时书库 + 临时 userData + CDP）：临时库入库后打开测试书，元数据栏显示「元数据测试 / 旧作者 / 科幻 星际 / 0 星」；点名称改「新书名」回车 → 第 1 行变「《新书名》」、展示同步、dirty 变 true、库内 title 立即更新；点作者输入后失焦 → 正文与库都不变；标签「玄幻 冒险」回车 → 第 3 行「主题：玄幻,冒险」且库 tags 更新；空作者回车 → 「作者：佚名」，空书名回车 → 放弃且展示保留；点第 4 颗星 → 展示 4 星、库 rating=4、文件 `com.apple.metadata:kMDItemStarRating` 为 4.0，隔 700ms 再点第 4 颗 → 展示 0 星、库 rating=0、xattr 清零，证明评分确实走 2.5 的双写链路。typecheck（node/web）与 lint 全过。
- [x] **2.10** `finderMetadata`：星级 `kMDItemStarRating` 双向同步（扫描读入、改分写出）；**Finder 注释写入时机：`metadataWriter` 修改主题时 + 文本保存时**；无主题跳过；**写入前先读旧注释，内容相同也跳过**（减少写操作，防破坏文件）。**已完成**：在 2.5 的 `finderMetadata.ts` 上扩展，不另建 bplist 模块——实数与字符串共用同一个「头 + 单对象 + 偏移表 + 32 字节 trailer」构造；注释严格对齐 `python3 plistlib.dumps(FMT_BINARY)`：全 ASCII 走 UTF-8 marker `0x5X/0x5F`（旧项目一律 UTF-16BE，与 Python 不一致，本次已纠正），含非 ASCII 走 UTF-16BE `0x6X/0x6F`，扩展长度用内联整数对象（`0x10/0x11/0x12/0x13`），偏移表宽度按「头+对象」总长取 1/2/4/8 字节。时机：`meta:applyEdit` 的 tags 提交（按内存正文 `findTopic`）与 `file:writeText` 保存后（按落盘正文）；无主题/空主题跳过，写前读旧注释相同跳过，失败静默不影响保存与库内元数据。星级双向沿用同一文件：扫描 `readFinderRating` 读入落库（非 macOS 用 COALESCE 保留库内值）、`writeFinderRating` 写出。**验收**：`scripts/test-finder-metadata.ts` 覆盖 12 组字符串（空串、ASCII 14/15/20/255/256/300 字、中文、emoji、中英混排、30000 字）与星级 0/1/2.5/3/4/5，构造字节与 Python plistlib 逐字节一致且可回读；临时文件真实 xattr 验过首次写入、读回、同值跳过、无主题/空主题跳过、非 ASCII、外部 Python 写入可读、星级读写与同值跳过；临时书库 enrich 读入星级 3 落库。CDP（临时库 + 临时 userData）：改标签「科幻 冒险」→ 第 3 行 `主题：科幻,冒险`、文件注释立即为 `科幻,冒险`（未保存）；外部写入旧注释后把主题改为「保存主题」再保存 → 注释同步为「保存主题」、dirty 清除。typecheck（node/web）与 lint 全过。
- [x] **2.9/2.10 补正**：元数据栏与文本双向同步，以正文为基准。解析实现从 `electron/services/metadataParser.ts` 抽到 `shared/metadataParser.ts`（纯 TS、无 Node 依赖），electron 侧只做 re-export，渲染层与主进程共用同一份正则与 `Path.stem` 口径；元数据栏直接监听活跃 model 的 `onDidChangeContent`，只取前 10 行本地解析（不读盘、不过 IPC），头部文本与上次相同则完全不刷新。正在栏内编辑的那一项保留草稿（以栏内为准），刷新只赋值 ref、不碰焦点；标签页切换/LRU 重载后 model 变化会重挂监听（借状态栏指标变化补挂）。库记录只保留评分与 bookId，文本三项不再读库。**验收**（临时库 + CDP）：正文把书名改为「正文改名」→ 栏内名称即时变；栏内改回「栏内书名」→ 正文第 1 行同步；正在栏内编辑标签时正文改书名 → 名称即时更新、标签草稿与焦点保持，回车提交后正文第 3 行变「主题：草稿标签」、Finder 注释同步。typecheck（node/web）与 lint 全过。
- [x] **2.10 补正（Finder 注释可见性）**：根因不在字节构造——Path Finder 二进制里 `setSpotlightCommentUsingTheFinder` 对应 AppleScript `set comment of item fileAlias to "%@"`，即让 Finder 自己写；Finder 简介不总是直接读 xattr（Spotlight 索引会滞后，Finder 缓存还可能长期停在旧值），raw `xattr` 写入后 `mdls` 常滞后 1–3 秒，若索引此前由 Finder 写过还会一直停在旧值，`mdimport` 对 mtime 未变的文件无效。对照实验：Finder AppleScript 写注释只改 `kMDItemFinderComment`（无额外属性），mtime 不变、ctime 变，bplist 字节与我们一致；同书 raw xattr（我们的服务与 `xattr -wx`）写入后 `mdls`/Finder 不立即变，删除属性后索引也会滞留旧值。修复：`writeFinderComment` 在 xattr 写成功后用 `osascript` 让 Finder 设置同一条注释同步索引（失败静默、保留 xattr）；实测写入后 `mdls` 与 Finder `comment` 立即为新值，mtime 仍未动。代价：首次可能触发 macOS「控制 Finder」授权，拒绝时退回异步索引路径；阶段 3 打包需在 Info.plist 写 `NSAppleEventsUsageDescription`。**转义与降级（已验）**：路径与注释都作为 osascript 的 argv 传入，不拼进脚本源码；断言覆盖双引号、反斜杠、换行、中文、emoji 与 `do shell script` 注入（注释和文件名各一组），全部原样落盘且无脚本被执行。`writeFinderComment` 返回 `refreshed | written | skipped | failed`：`written` 表示 xattr 已写但 Finder 同步失败（service 记 warning，不抛出），`failed` 表示 xattr 写失败；osascript 超时 2 秒，失败不阻塞保存主流程。`scripts/test-finder-metadata.ts` 覆盖 refreshed、降级 written、failed 三种状态。
- [x] **2.11** 最近阅读：打开即写 `last_read_at`，位置变化 60 秒防抖。**已完成**：对齐 Python `_READ_STAMP_DELAY_MS`，只在阅读位置变化后重置 60 秒计时，停住才写一次；打开/激活仍走 2.5 的立即写入（`library:markRead`），不新增 IPC。防抖在渲染层 `useLibraryStore`：模块级路径 Set + 单计时器（高频滚动不进 Vue 响应式），`EditorHost` 的 `onDidChangeCursorPosition` 与 `onDidScrollChange` 触发 `scheduleReadStamp`；切标签 `activateTab` 立即 `flushReadStamps`（同 Python `currentChanged`），退出 `flushForQuit` 在快照落盘前 flush（同 `aboutToQuit`），失败只记日志不阻塞退出。**范围说明**：`books.progress_line` 保持不写——Python 版同样只写 `session_tabs.progress_line`，本项目的阅读进度恢复走 1.8 会话快照，不再开第二套进度存储。**验收**（临时书库 + 临时 userData + CDP）：打开测试书即写 `last_read_at`；滚动后 +10s 库内不变、+65s 更新；30s 后再次滚动重置计时（距第一次 63s 仍不变、距第二次 65s 更新）；打开库外 txt 滚动 65s 不写库、不报错、不新增记录。typecheck（node/web）与 lint 全过。
- [x] **2.12** `Cmd+P` 快速检索：唤出读库快照、120ms 防抖内存过滤（书名/作者/标签）、空输入按最近阅读、回车打开 Esc 关闭。**口径（已确认）**：旧项目两套实现并不一致——Python `library_search` 是整串子串匹配 + 字段优先级，Vue 旧版才按空白切词但无字段排序；本步采用「切词 AND、每词逐字段匹配 + Python 字段优先级（书名全等 0 → 前缀 1 → 包含 2 → 作者 3 → 标签 4）求和排序，同分保持快照顺序」，空输入 20 条、查询封顶 50。**已完成**：`bookRepository.listAllBooks` 按 `last_read_at` 倒序读全量 → `library:allBooks`（未开库返回空列表）；`shared/librarySearch.ts` 负责快照条目预转换与内存过滤，主进程只读一次库；渲染层 `useCommandPalette` 唤出时读快照、模块级快照不进 Vue 响应式、输入 120ms 防抖，`CommandPalette.vue` 为 Teleport 浮层（↑↓ 选择、Enter 打开、Esc/点击遮罩关闭），`App.vue` 在捕获阶段接管 Cmd+P（避开 Monaco textarea），关闭后焦点交还正文；遮罩/阴影/面板尺寸全部新增 `--yd-palette-*` token。**验收**（临时书库 + 临时 userData + CDP）：空输入 20 条与库序一致，打开笑傲江湖、鹿鼎记后空输入按最近阅读排前；输入「金庸」50ms 仍为空态、190ms 出 15 条且作者命中（3 本）排在标签命中（12 本）之前；多词「金庸 佚名」只留 12 本同时命中作者与标签的书、同分保持快照顺序；回车打开鹿鼎记并关闭面板，Esc 关闭；编辑器内 Cmd+P 唤出、关闭后焦点回正文；截图 `/tmp/yue-212-palette.png`；`scripts/test-library-search.ts` 13 项断言全过；typecheck（node/web）与 lint 全过。
- [x] **2.13** 换库流程：建新库 → 停扫描 → 存档旧会话 → 切活动库 → 恢复新会话；路径统一 `realpath` 后比较。**已完成**：每书库一份数据库——首选 `<书库根>/yueduo.db`，根目录不可写时回落 `<userData>/library-db/<realpath 哈希>.db`（回落库也按库隔离，`database.ts` 拆出 `openDatabase/activate/swap`，新增 `libraryDatabase.ts` 管理活动库与待切换库）。启动由主进程在建窗前按设置打开活动库，渲染层 `library:current` 只读状态再恢复该库会话；换库拆成三步：`library:open`（建新库 + 读新会话 + 停 enrich，旧库仍活动）→ 渲染层 `archiveSessionForSwitch`（书签漂移/最近阅读 flush → 会话快照落旧库 → 驻留脏标签草稿写旧库）→ `library:activate`（先换全局引用再关旧连接，提交点不失败）→ `applyRestoredSession`（编辑器解绑 → 释放全部 model/身份缓存 → 灌入新库标签与进度）。任一步失败：`archive` 抛错或目录无效时 `library:abort` 只关新库，旧库仍是活动库；中止扫描跳过对账，避免半份结果把书误记缺失。`useTabLifecycle` 增加换库代际，旧库发出的异步重载/卸载在切换后自行放弃；`useBookmarkDrift` 换库时清空路径基线。**验收**：`scripts/test-library-switch.ts` 36 项断言全过（临时库 A/B：库文件在各自根、准备阶段旧库仍活动、切 B 后 A 的会话/草稿/书签不可见、切回 A 原样恢复且 B 数据不串、abort 与无效目录后 A 可继续写、只读根回落 userData 且重启命中同一文件）；CDP 临时书库 + 临时 userData 真实换库：A 打开甲书改脏 + 加书签 → 注入一次草稿写失败后切 B 返回 false、根仍 A、3 个标签与草稿/书签完好 → 重试切 B 成功且标签 0、A 草稿为 null、A 书签为空、库内只有乙书 → B 打开乙书改脏加书签 → 切回 A：3 标签（含甲书 dirty）恢复、草稿全文与甲库书签恢复，乙书草稿/书签/书目均不可见；无效目录切库保持 A 状态。退出后磁盘核对：A 库仅甲书 + 3 条会话（甲标签 draft 1416 字节）+ 1 条书签，B 库仅乙书 + 1 条会话（draft 1389 字节）+ 1 条书签，两库无交叉；typecheck（node/web）与 lint 全过。

### 阶段 3：编辑体验打磨与交付

- [x] **3.1** **自绘查找替换栏 `FindReplaceBar`**（弃用 Monaco 内置 find widget 与 overlay hack，交互照 Python `find_replace_bar.py`）：
  - **数据部分已完成**：规则表迁移到 `shared/findRules.ts`（`DEFAULT_RULES` 6 条 + 占位项「常用正则…」），作为 `AppSettings.rules` 经 1.9 settings 服务持久化/读取，其他设置项结构不变。**口径**：6 条与 Python `tidy_rules._RULES` 同序同内容（含「全角转半角」），多个空格规则仍替换为全角 `U+3000`。**开关**：旧版没有「是否进查找下拉」的字段（Python `SEARCH_RULES` 是手写元组、Vue 版是 6 条平铺数组），沿用旧版 `tidy_enabled` 的开关式命名与语义新增 `searchEnabled`（布尔、默认 true），仅 `to_halfwidth` 为 false（只进 3.2 的右键转换菜单）；`DEFAULT_FIND_RULES` 为其过滤子集，点击口径与 Python `SEARCH_RULES` 等价。`scripts/test-find-rules.ts` 直接调 python3 导出 `_RULES` + `SEARCH_RULES`，逐条比对内容并用开关过滤结果对齐下拉子集，另覆盖正则可用性、settings 读写与坏数据整组回落。
  - **UI 已完成**（本次提交）：`src/components/FindReplaceBar.vue` 挂在 `EditorHost` 的 `editor-wrap` 内，浮在编辑器右上角；两行结构，左侧折叠箭头纵向跨两行居中，`v-show` 收起替换行后只剩第一行。第一行输入框内右侧依次为大小写 `Aa`、全词 `ab`、正则 `.*`，框外依次为「第 N 项，共 N 项」、上一个、下一个、常用正则入口、关闭；第二行替换框内右侧为保留大小写 `aA`，框外为单个替换与全部替换图标（无「更多选项」按钮）。
  - **触发（用户新口径，覆盖旧方案）**：窗口 `keydown` 捕获阶段接管，`Cmd+F` 呼出且替换行收起，`Ctrl+Cmd+F` 呼出并直接展开替换行；内置 find widget 永不触发。打开时自动取选区文本，无选区取光标所在连续文字段（`\p{L}\p{N}_` 连续段，中文标点算边界，不用 Monaco 默认词分隔符），所在行没有内容时回退上次查找文本。
  - **匹配**：`model.findMatches(pattern, false, isRegex, matchCase, wholeWord ? wordSeparators : null, false, MATCH_LIMIT)` 全量查询（100ms 防抖）；`limitResultCount` 必须传大值，Monaco 内部按 `resultLen >= limit` 截断，传 `-1` 只会返回 1 条（实测踩坑）。「当前序号 / 总数」按光标位置二分定位，无匹配时上一个/下一个置灰。正则无效时先用 `new RegExp(pattern, 'gu')` 做同款语法校验（`findMatches` 对坏正则只返回空、不抛错），显示「正则无效」。
  - **跳转**：`model.findNextMatch` / `findPreviousMatch` 实现下一个/上一个，越界环绕；`Cmd+G` 下一个、`Shift+Cmd+G` 上一个；查找框内 Enter 下一个、Shift+Enter 上一个（对齐 Python）。
  - **替换**：`pushUndoStop` + `executeEdits`；替换框内 Enter 替换当前项、`Cmd+Enter` 全部替换（一次批量编辑，一次撤销整体恢复）；保留大小写按全大写/全小写/首字母大写三态换算；锁定阅读时替换被拒绝并提示「已锁定，无法替换文本」，查找仍可用。
  - **高亮**：`createDecorationsCollection` 标记全部匹配（当前项高亮更强；匹配数 > 5000 时仅标可视区 ±200 行附近）。
  - **常用正则面板**：入口占「更多选项」腾出的位置（第一行框外、下一个与关闭之间），点开后面板向下浮出、覆盖正文（含替换行），固定宽度不受查找框限制，每条显示规则名 + 一句说明；只列 `searchEnabled` 为真的 5 条，选中后把 pattern 填入查找框、规则自带 replacement 填入替换框，并开启正则开关。
  - **宽度拖拽**：左边缘手柄可拖拽调宽（`pointerdown` + window `pointermove`），右边缘固定在容器右侧、宽度变化只移动左边缘；夹在 `findBarMinWidth`–`findBarMaxWidth` 与容器宽度内；替换行收起/展开都能拖。
  - **交互**：Esc 优先收起规则面板，再按一次关闭查找栏并把焦点还给编辑器；查找框/开关改动实时刷新计数。
  - **验收**（临时文件 + 临时 userData + CDP 真实按键/鼠标）：选区 `hello` 自动填入并计 3 项（当前第 2 项）；光标在「心动」内自动填「心动」计 3 项；空行回退上次「心动」；大小写开关 3→1；全词开关「ello」1→0 且按钮置灰；无效正则显示「正则无效」；`Cmd+G` 依次 2→3→环绕 1，`Shift+Cmd+G` 回 3；单次替换后剩 2 项并环绕到第 1 项，一次 `Cmd+Z` 撤销；`Cmd+Enter` 全部替换为 0 项，一次撤销恢复 3 处；保留大小写 `hello`→`world` 得到 `World world` / `world` / `WORLD`；规则面板列 5 条、选中「提取章节目录」填入 pattern、正则开启且替换框清空；拖拽宽度 440→520（右缘固定 950，左缘 510→430）、再向右收窄 520→420（右缘仍 950，左缘 430→530），展开替换行后可继续拖；锁定后替换按钮禁用、Enter 提示「已锁定，无法替换文本」且正文不变；Esc 逐层关闭且焦点回正文。typecheck（node/web）与 lint 全过。
- [x] **3.2** 简繁转换 + 一键整理：OpenCC 主进程服务；右键「转换」组（全角转半角/简转繁/繁转简，选区优先、可撤销）；一键整理固定顺序（UTF-16LE → 全角化 → 删段末不可见字符 → 繁转简 → 规则正则替换）。**已完成**：词表从 Python 项目 `assets/dicts` 原样复制到 `resources/dicts`（`asarUnpack: resources/**` 已覆盖打包），`electron/services/chineseConvert.ts` 按 Python `chinese_convert.py` 移植（保护词 → 词组最长匹配 → 单字 → 多义字保留计数，按码位建树/匹配），`textConvert.ts` 只转全角字母数字加减号，`tidy.ts` 五步顺序复用 `shared/findRules.ts` 的 blank_lines/illegal_chars（单一规则源）；IPC `convert:*` 四通道 + `EditorHost` 右键组（选区优先，无选区转全文，`executeEdits` 一次替换，`pushUndoStop` 保证 Cmd+Z 一次回退，切换/改动检测后放弃写回）；`scripts/test-convert.ts` 直接跑旧项目 Python 实现逐样本比对，并覆盖多义字/保护词/全角边界/五步顺序；CDP 验收覆盖右键菜单四项、全文繁转简 + dirty + 单次撤销、一键整理预期文本、选区优先与状态栏文案。**不新增依赖**（沿用旧项目 OpenCC 词表方案，未引入 opencc 包）。
- [x] **3.3** 正文操作：回车补两个全角空格 `U+3000`（Shift+回车只换行）、锁定阅读（空格翻页）。**已完成**：`EditorHost` 用 `editor.addCommand` 接管回车与 Shift+回车（上下文 `editorTextFocus && !editorReadonly && !isComposing`，不干扰输入法组合）：普通回车插入 `\n` + 当前行行首缩进（半角空格 / 制表符 / 全角空格，同 Python `_INDENT_CHARS`），无缩进时补 `U+3000`×2；Shift+回车只插入 `\n`；`pushUndoStop` 包住一次 `executeEdits`，一次撤销即可回退整组回车+缩进。锁定阅读：新增 `stores/reader.ts`（`locked`，不跨会话持久化），状态栏右侧「锁定阅读」描边开关 + 「已锁定 · 空格翻页」提示（新增 `METRICS.statusLock*` token），`Cmd+L` 在 `App.vue` 捕获阶段全局开关（同 Python 视图菜单 Ctrl+L）；`EditorHost` 监听锁定 → `updateOptions({ readOnly })`、锁定时焦点交还正文，并注册空格 / Shift+空格翻页（上下文 `editorTextFocus && editorReadonly`）：按当前可视行数整页滚动、目标行贴顶（`getTopForLineNumber` + `setScrollTop`）、光标落到目标行首，状态栏「阅读到第 N 行」；锁定时右键菜单不再出现书签/转换项（沿用 `precondition: '!editorReadonly'`），元数据栏同步不可编辑（同 Python `metadata_bar.set_locked`），解锁后恢复；状态提示文案与 Python 一致（锁定/解锁 4000ms、翻页 2000ms）。**范围说明**：方案原文未指定锁定入口，**锁定阅读固定为状态栏开关 + `Cmd+L`（保留项，不视为多余绑定）**；顶部原生菜单只保留系统级菜单，不再加「视图」菜单与锁定项，避免入口重复；元数据栏随锁定只读是 Python 基线行为，一并纳入。**验收**（临时文件 + 临时 userData + CDP 真实按键）：全角缩进行回车 → 新行同为 `U+3000`×2、光标列 3；单半角空格缩进行 → 新行 1 个空格、光标列 2；无缩进行 → 新行 `U+3000`×2；Shift+回车 → 新行空串、光标列 1；`Cmd+Z` 一次撤销整组回车+缩进并回到原行末。点状态栏「锁定阅读」→ `checked`/`aria-pressed=true`、提示「已锁定 · 空格翻页」、状态栏「已锁定，空格向下翻页，Shift+空格向上翻页」、元数据栏进入锁定态；空格从第 1 行翻到第 29 行且顶部同为 29、提示「阅读到第 29 行」，Shift+空格回第 1 行；锁定态键入 X 正文不变；锁定态右键菜单无书签与转换四项；`Cmd+L` 解锁 → 按钮复位、提示「已解锁，可继续编辑」、键入 X 生效、空格恢复为输入空格、元数据栏可再次点击编辑。typecheck（node/web）与 lint 全过；3.1 查找栏未动工。
- [x] **3.4** 标签拖动排序：编辑器标签页左右拖动（VS Code 逻辑），拖动落点插入，`session_tabs.position` 同步。**已完成**：标签栏与左栏「编辑」页都能拖动排序，二者共用 `useTabsStore.moveTab(id, toIndex)`——`toIndex` 是去掉被拖项后的插入下标，由指针与其余条目的中点比较得出，被拖项自身不参与计算。标签栏横向拖动：按下后越过 4px 阈值才进入拖动（VS Code 同口径，小抖动仍算点击），落点画 2px 指示线，拖到视口左右 24px 内自动横向滚动，松手后 `moveTab` + `schedulePersist`，并用宏任务抑制随后的 click，避免拖动结束激活标签；左栏编辑页为纵向拖动，落点线用 `--yd-accent` 绝对定位在滚动内容坐标系，条目拖动时半透明、容器 `cursor: grabbing`，同样抑制 click 并交还编辑器焦点但不改变活动标签；右击标签/条目只弹菜单、不激活（`5e9d92b`）。顺序落库沿用 1.8 的 2 秒防抖 `session:persist`，`session_tabs.position` 按数组顺序重写，重启恢复顺序一致。尺寸只用既有 `--yd-*` token，未新增写死数值。**验收**：CDP 模拟左栏把「书三」拖到首位，左栏与标签栏顺序同时变为「书三 → 重生之心动 → 测试书名 → 书二-改」，`activeTabId` 保持不变、拖动后附带的 click 未激活条目；标签栏拖动落点、边缘自动滚动与松手插入位置一致（前述实现验收），重启后标签顺序与拖动结果一致；用户已实测验收通过。
- [x] **3.5** 标签右键菜单：保存/关闭类复用文件菜单、重命名（同步磁盘与库身份）、删除移废纸篓（`shell.trashItem`）、Finder 显示（`shell.showItemInFolder`）。**已完成**：标签右键菜单为「保存 / 关闭 / 关闭其他（仅剩 1 个时禁用）/ 关闭全部 / 重命名… / 删除… / 在 Finder 中显示」（无路径的空白标签禁用后三项），右键只弹菜单不切活动标签，菜单动作按被右击的 `tabId` 执行。**同源**：顶部「文件」菜单经 `app:menuCommand` 下发 `{command}`/`{command, value}`，`App.vue` 的 `runMenuCommand` 与右键菜单都调用 `useTabs` 的 `saveTab/closeTab/closeOtherTabs/closeAllTabs`，不存在第二套实现；打开、书库、外观、预载、关闭按钮常驻也走同一菜单通道。**重命名**：自绘浮层（Electron 无原生文本输入框，Enter 提交、Esc/点遮罩取消、错误就地展示），自动补 `.txt`、同目录 `existsSync` 查重；改名前后在活动书库根上算 `relative_path`，`renameBookRecord` 同步 `books.relative_path/filename` 且 id 不变（评分/书签/进度/最近阅读全保留），库外文件只改磁盘；成功后刷新标签 path/title/stat 缓存并 `persistSessionNow`，再通知目录树与库内列表重读。**删除**：`confirmTrash`（dirty 额外提醒）→ `flushBookmarkDrift` → `shell.trashItem` → `deleteBookRecord`（书签随 FK CASCADE）→ 关闭标签 → `persistSessionNow` → `notifyFilesChanged(removedBook)` 立即刷新左栏书架/追更/评分/标签与计数；库记录清理失败只记日志，磁盘已成功，下次扫描对账补齐。**Finder 显示**：`shell.showItemInFolder`，失败只记日志。**验收**：重命名后库内 `relative_path/filename` 已更新、重启与重扫都不会当新书；删除后文件在废纸篓可恢复，左栏各页与计数无需重启即更新；右键不激活标签、菜单作用于被右击项；`Cmd+S` 与右键「保存」走同一链路；用户已实测验收通过。
- [x] **3.6** electron-builder 打包（ad-hoc 签名，只保证本机运行）；Info.plist 补 `NSAppleEventsUsageDescription`（Finder 注释同步要控制 Finder，缺失会导致自动化授权无法弹窗）
  - **已完成**：`electron-builder.yml` 的 `mac` 显式 `identity: '-'` 走 ad-hoc 签名，`hardenedRuntime: false`（ad-hoc + 硬化运行会触发库校验而启动失败），`notarize: false`；`extendInfo` 由数组改为合法 map，并补 `NSAppleEventsUsageDescription`（「同步 Finder 注释需要控制 Finder 刷新一次索引。」），其余相机/麦克风/文稿/下载说明保留。产物：`dist/mac/yueduo.app`（x86_64、adhoc）、`dist/yueduo-1.0.0.dmg`（171M）、`dist/yueduo-1.0.0-mac.zip`（166M）。
  - **机器验收**：`plutil -p` 确认 `NSAppleEventsUsageDescription` 在 Info.plist；`codesign -dv` 显示 `Signature=adhoc`、`flags=0x2(adhoc)`、无 TeamIdentifier，`codesign --verify --deep --strict` 通过；用 `YUE_USER_DATA=/tmp/yueduo-36-ud` 启动打包版（隔离设置/库），`library:current` 指向临时库、扫描入库 1 本且书名/作者/标签解析正确，证明打包后的 better-sqlite3 与主进程链路可用。
  - **用户验收**：dmg 安装后的打包版能正常改写 Finder 星级/注释；首次改元数据时系统弹出「控制 Finder」自动化授权，允许后不再重复弹窗；`npm run dev` 使用项目内 `.dev/user-data` 与默认测试库，不会打开打包应用里的书库。
- [x] **3.7** 新项目 `AGENTS.md`：继承 YueDuo_old 坑清单中仍然成立的部分 + 本次架构约定。**已提前落地**（提交 `671d5be`，根目录 85 行，含实装版本/权限边界/架构/IPC/Monaco 硬约束/数据与界面约定）；后续会话按它执行即可，无需重建。
- [x] **3.8** 界面中文化（Monaco + 顶部原生菜单）与语言资源精简：
  - **Monaco NLS**：`src/monaco.ts` 在 `editor.api` 之前导入 `monaco-editor/nls/lang/zh-cn`（NLS 表是全局的，必须最先求值）；各调用点的英文原文即兜底，因此英文不需要单独语言文件。构建产物只有 zh-cn 文案，日/德/法/西/意/韩/波/葡/俄/土/繁体均未进入 chunk。
  - **右键菜单内置项**：精简入口只在 `SimpleEditorContext` 注册撤销/重做/全选，且剪贴板贡献不按选区置灰；`monaco.ts` 把撤销/重做/全选补进 `EditorContext`，并给剪切/复制/粘贴补 `precondition`（`canUndo`/`canRedo`/`editorHasSelection`/`!editorReadonly`），保留原有「添加书签」「转换」自定义项。验收：撤消/恢复随撤销栈置灰；无选区时剪切/复制置灰、有选区恢复；锁定时剪切/粘贴隐藏、复制仍按选区；命令面板（F1）文案为中文。
  - **语言资源精简**：`electron-builder.yml` 剔除 `monaco-editor/dev|min/vs/nls/lang/*`（AMD 分发形态，本项目不用）与 `esm/vs/nls/lang/` 下除 zh-cn 外的全部语言；打包 asar 内 `nls/lang` 只剩 `zh-cn.js`。
  - **顶部菜单**：新增 `electron/menu.ts`，用 `Menu.buildFromTemplate` 自建中文模板（文件/编辑/显示/窗口/帮助，macOS 含应用菜单）；行为全部走 `role`（加速键不变），label 显式中文，未给 label 的 role 项由 Electron 回落英文。验收：菜单栏显示「文件 编辑 显示 窗口 帮助」，编辑子项「撤消/恢复/剪切/复制/粘贴」为中文。
  - **口径**：Monaco NLS 与 Electron 原生菜单是两套机制，前者靠全局消息表，后者靠独立模板，互不影响；后续新增菜单项同样在 `electron/menu.ts` 里写中文 label。
- [x] **3.9** 打包体积盘点（**3.6 验收之后**再做）：按产物实际占用裁剪，先量再砍。重点三块：Electron 自带语言包（`*.lproj`）、Monaco 未使用的语言特性与 worker、better-sqlite3 非目标平台的预编译产物；先记录 asar/安装包体积与各项占比，再决定剔哪些，不凭猜测先删。
  - **裁剪前实测**：`.app` 495M、dmg 171M、zip 166M；`app.asar` 203M（`.dev` 98M、monaco-editor 93M、renderer-only 依赖约 2.8M、`out` 11M、`public/test` 4.9M、其余约 0.3M），`app.asar.unpacked` 28M（better-sqlite3：7 平台 prebuild 17M + sqlite3 源码 `deps` 9.9M），Framework 内语言包 60 个约 17.7M；`resources.pak` 13M、`icudtl.dat` 10M 属 Chromium 固定开销，不做处理。
  - **裁剪项（1–6 全做）**：排除 `.dev`（开发态 userData，Chromium 缓存 98M，且含开发库路径/草稿）、`.trae`、`2026-11-17`、`AGENTS.md`、`scripts`、`electron`、`shared` 等非运行文件；整包排除 `node_modules/monaco-editor`（renderer 已由 Vite 打包）与 `dompurify/marked/pinia`；排除 `public/test` 与 `out/renderer/test` 两份测试书；`electronLanguages: [en, zh_CN]` 剔除 Framework 其余 `.lproj`；better-sqlite3 去掉 `deps/src`，prebuild 只留 `darwin-x64.node`。
  - **裁剪后实测**：`.app` 266M（−229M，−46%）、dmg 122M（−49M，−29%）、zip 118M（−48M，−29%）；`app.asar` 7.3M、`app.asar.unpacked` 3.2M，asar 顶层只剩 `out/`、`resources/`、`package.json` 与主进程运行依赖；Framework 语言包 60 → 12 个（en/zh_CN 及变体），Framework 257M → 248M。
  - **验收**：裁剪后的包用隔离 userData 指向既有测试库启动，`library:current` 正常、`allBooks` 读出书目、`file:readText` 正确返回 UTF-8 正文，`native:sanity` 报告 better-sqlite3 13.2.0 加载执行正常（Electron 45.3.3 / ABI 150）；图标与 Finder 显示正常；用户已验收通过。注意：当前仅带 `darwin-x64` prebuild，将来出 arm64 包需把 `darwin-arm64.node` 加回（或按 arch 配置）。

## 六、验证方式

- 开发：`dev` 分支，中文提交信息写「为什么」；每步写完立即 `vue-tsc --noEmit`
- services 单测：纯 Node（`tsx` 脚本 / vitest + better-sqlite3 `:memory:`），不依赖 Electron API；测试数据脚本内构造
- **功能验证书库（用户已授权随意增删改）：`/Users/Joey/Sites/Projects/小说`**，指定样本：
  - `重生之心动.txt`、`娱乐之神级学习系统.txt`：有评分、无 Finder 注释
  - `我就是好莱坞.txt`：无评分、无注释
  - `风流小保安.txt`：有评分、有注释
  - 覆盖 Finder xattr 读/写/同值跳过三种路径验证；对账验证可在该库内移动/删除样本文件测试
- 端到端：`YUE_TEST=1 npm run dev`（窗口不显示、不抢前台）；注意单实例锁会让重复启动静默退出
- 阶段验收节点：0.2（大文件瞬开）、1.12（编辑器闭环 + 焦点/IME 无异常 + LRU）、2.x 完成后（书库全功能 + 对账）、3.6（打包产物）
- 阶段 1 完成后与用户确认焦点问题确实根治，再继续阶段 2

## 七、风险与既定解法（继承自 YueDuo_old 血泪，实施时遵守）

1. Monaco worker 404 → 只用 Vite 原生 `?worker` 路径（见 §三修正说明），不自己配 `MonacoEnvironment.getWorkerUrl`，也不用 AMD loader；装完先跑通再继续
2. 大文件禁止分片追加（分片慢 4 倍），一律一次性 `setValue`
3. 若回退 `vite-plugin-monaco-editor`（CJS 包）：ESM 下 `createRequire` 取 `.default`（装完先验证）
4. Monaco API 先 grep `editor.api.d.ts` 确认存在再用（新版本 API 有删改）
5. Finder xattr 只认 Python plistlib 格式 bplist00（`plist` 包会被 Finder 转成打不开的 0x98 格式）
6. native 模块成功与否只看 Electron 进程里真实 require，不看 rebuild 命令输出；Electron 升级后 ABI 变化需重新 prebuild-install
7. IPC handler 不抛裸异常（clone 失败变成不可读 reject）
8. 渲染进程禁止 import Node 模块与 better-sqlite3，一切走 bridge
