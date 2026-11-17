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
- [ ] **2.7** 书签系统：右键「添加书签」、点击跳转、全库书签页按书分组
- [ ] **2.8** `metadataWriter`：名称/作者/标签写回正文前 10 行（缺失按书名→作者→标签补行），生成**最小可撤销 TextEdit**（一次最小区间替换、保光标、触发未保存标记），再同步库
- [ ] **2.9** 元数据栏：**位于编辑器下方、状态栏上方**（旧项目方案）；编辑名称/作者/标签/评分四项，点击即改、回车上屏、失焦取消；星星「再点同分清零」手势
- [ ] **2.10** `finderMetadata`：星级 `kMDItemStarRating` 双向同步（扫描读入、改分写出）；**Finder 注释写入时机：`metadataWriter` 修改主题时 + 文本保存时**；无主题跳过；**写入前先读旧注释，内容相同也跳过**（减少写操作，防破坏文件）
- [ ] **2.11** 最近阅读：打开即写 `last_read_at`，位置变化 60 秒防抖
- [ ] **2.12** `Cmd+P` 快速检索：唤出读库快照、120ms 防抖内存过滤（书名/作者/标签）、空输入按最近阅读、回车打开 Esc 关闭
- [ ] **2.13** 换库流程：建新库 → 停扫描 → 存档旧会话 → 切活动库 → 恢复新会话；路径统一 `realpath` 后比较

### 阶段 3：编辑体验打磨与交付

- [ ] **3.1** **自绘查找替换栏 `FindReplaceBar`**（弃用 Monaco 内置 find widget 与 overlay hack，交互照 Python `find_replace_bar.py`）：
  - 触发：`editor.addCommand` 接管 `Cmd+F` / `Cmd+Option+F`（替换模式），内置 find widget 永不触发
  - 匹配：`model.findMatches(pattern, null, isRegex, matchCase, null, false, -1)` 全量查询（100ms 防抖）；「当前序号 / 总数」按当前光标位置二分定位，无匹配置灰
  - 跳转：Enter / Shift+Enter 上/下一个（`setSelection` + `revealRangeInCenter`）
  - 全部替换：`pushUndoStop` + `executeEdits` 一次批量替换（可撤销）
  - 高亮：`createDecorationsCollection` 标记全部匹配（当前项高亮更强；匹配数 > 5000 时仅标可视区附近）
  - **常用正则下拉**：纯 Vue 组件（规则从 Python `tidy_rules.py` 迁移：提取章节目录/多余空行/多个空格/非法字符/对话内容/全角字母数字等），选中即填入查找框（替换框一并填入规则自带 replacement），无私有 API、无轮询、无 DOM 定位 hack
  - 交互：Esc 关闭并返焦点编辑器；查找框改动实时刷新计数
- [ ] **3.2** 简繁转换 + 一键整理：OpenCC 主进程服务；右键「转换」组（全角转半角/简转繁/繁转简，选区优先、可撤销）；一键整理固定顺序（UTF-16LE → 全角化 → 删段末不可见字符 → 繁转简 → 规则正则替换）
- [ ] **3.3** 正文操作：回车补两个全角空格 `U+3000`（Shift+回车只换行）、锁定阅读（空格翻页）
- [ ] **3.4** 标签拖动排序：编辑器标签页左右拖动（VS Code 逻辑），拖动落点插入，`session_tabs.position` 同步
- [ ] **3.5** 标签右键菜单：保存/关闭类复用文件菜单、重命名（同步磁盘与库身份）、删除移废纸篓（`shell.trashItem`）、Finder 显示（`shell.showItemInFolder`）
- [ ] **3.6** electron-builder 打包（ad-hoc 签名，只保证本机运行）
- [x] **3.7** 新项目 `AGENTS.md`：继承 YueDuo_old 坑清单中仍然成立的部分 + 本次架构约定。**已提前落地**（提交 `671d5be`，根目录 85 行，含实装版本/权限边界/架构/IPC/Monaco 硬约束/数据与界面约定）；后续会话按它执行即可，无需重建。

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
