# 悦读 / YueDuo 架构地图

面向「要改某类东西，先看哪几个文件」的查表文档。路径均相对仓库根。
约定与硬约束以 [AGENTS.md](../../AGENTS.md) 为准，这里只描述「东西在哪、怎么连起来」。

## 0. 一句话分层

- `electron/` 主进程：文件、SQLite、Finder 扩展属性、原生对话框、应用菜单；`services/` 纯 Node、不 import Electron。
- `src/` 渲染层：Vue 组件 + composables 编排 + Pinia 元信息 + Monaco；零 Node 能力。
- `shared/`：两侧共用的纯函数与跨进程类型，不许 import 任一侧运行时。
- `electron/preload.ts`：唯一跨进程通道，暴露 `window.yue.invoke` 与四个订阅。

## 1. 目录树（文件级）

```
YueDuo/
├── package.json                  依赖分区（运行时 dependencies / 其余 devDependencies）与 npm 脚本
├── electron.vite.config.ts       主进程 / preload / 渲染层三份构建配置 + Monaco 中文标点插件
├── electron-builder.yml          打包目标、asar 过滤、Electron 语言包
├── tsconfig.json                 TS 工程引用入口
├── tsconfig.node.json            主进程 + shared 的 TS 编译范围
├── tsconfig.web.json             渲染层 + shared 的 TS 编译范围
├── eslint.config.mjs             lint 规则
├── AGENTS.md                     项目实现约定（每轮常驻注入）
├── README.md                     使用说明
├── resources/
│   ├── icon.png                  打包图标
│   └── dicts/                    简繁转换词表（st/ts 字表词表、keep/ambiguous）
├── public/test/                  大文件验收样本（gitignore，不入库）
│
├── electron/
│   ├── main.ts                   应用入口：单实例锁、userData 隔离、建窗、初始化 IPC/菜单/主题/书库、退出握手
│   ├── devEnv.ts                 开发态判定、开发默认书库根、按开发态取默认库路径
│   ├── menu.ts                   构建应用菜单、把菜单点击转成 app:menuCommand、同步勾选状态
│   ├── preload.ts                contextBridge 暴露 yue.invoke（域白名单）与四个订阅通道
│   ├── preload.d.ts              window.yue 的全局类型声明
│   ├── ipc/
│   │   ├── registry.ts           handle() 统一注册器（ok/data|error）+ IPC_DOMAINS 白名单
│   │   ├── index.ts              各域 handler 汇聚注册：channel → 实现（新增通道只改这里 + 实现文件）
│   │   ├── app.ts                app:syncMenuState —— 渲染层侧栏显隐回写菜单勾选
│   │   ├── file.ts               文本读写、stat、改名、废纸篓、Finder 显示、草稿读写
│   │   ├── dialog.ts             原生对话框：关闭三选一、选/存文件、删除确认、报错、选书库
│   │   ├── library.ts            活动书库状态、换库三步、目录/列表查询、评分、元数据同步、章节与书签
│   │   ├── meta.ts               元数据读取与写回、评分读写（库内写库+Finder，库外只写 Finder）
│   │   ├── session.ts            会话 persist/restore/relocate/flushDone + 主进程发起 flush 握手
│   │   ├── settings.ts           settings:get/set，写入后切换 nativeTheme.themeSource
│   │   ├── theme.ts              初始化与切换 themeSource，向渲染层推送 theme:updated
│   │   ├── convert.ts            简繁、全角半角、一键整理的 IPC 包装
│   │   └── native.ts             native:sanity —— 在 Electron 内真实 require better-sqlite3 冒烟
│   └── services/
│       ├── database.ts           建库、user_version 迁移、活动连接切换、WAL 收尾
│       ├── libraryDatabase.ts    每书库一份库：根目录解析、userData 回落、prepare/commit/abort
│       ├── bookRepository.ts     books 表：列表/评分/最近阅读/元数据/改名/删除/标签评分
│       ├── bookmarkRepository.ts bookmarks 表：当前书书签与全库分组
│       ├── sessionStore.ts       session_tabs/session_state 落盘、恢复、按 book_id 重定位
│       ├── draftStore.ts         草稿全文 + viewState 落库（LRU 卸载与退出补写）
│       ├── settingsStore.ts      settings.json 读写、坏值/旧字段回落
│       ├── libraryScanner.ts     目录列举、全库扫描入库、单文件 ingest
│       ├── reconcile.ts          扫描后对账：移动合并、连续零匹配删库
│       ├── metadataParser.ts     主进程侧元数据解析出口（实现复用 shared/metadataParser）
│       ├── metadataWriter.ts     正文前 10 行最小替换写回 + 应用 TextEdit
│       ├── chapterParser.ts      章节标题行提取
│       ├── textCodec.ts          编码探测、解码、换行归一、写回编码
│       ├── textConvert.ts        全角转半角（只按规则表 to_halfwidth）
│       ├── chineseConvert.ts     简繁转换（词表 + 保护词/多义字）
│       └── finderMetadata.ts     Finder 星级/注释的 bplist xattr 读写
│
├── shared/
│   ├── types.ts                  跨进程共享类型与常量（IPC 契约、TabMeta、LibraryBook、默认设置）
│   ├── metadataParser.ts         书名/作者/标签解析（渲染层与主进程同一份正则）
│   ├── findRules.ts              查找/一键整理规则表（唯一来源，数组顺序即整理顺序）
│   ├── replaceTemplate.ts        替换串转义与分组展开的共用入口
│   ├── crossLineSearch.ts        全文跨行正则匹配（Monaco 逐行 find 的补充）
│   └── librarySearch.ts          命令面板检索、字段加权与排序
│
├── src/
│   ├── index.html                渲染层 HTML 入口
│   ├── main.ts                   Vue 挂载、Pinia、先初始化设置再 mount
│   ├── App.vue                   根布局 + 全局编排（菜单命令、快捷键安装、会话初始化、换库、缺失标签重连）
│   ├── env.d.ts                  Vite 类型引用
│   ├── monaco.ts                 Monaco 单例、纯文本 editor 选项、字体、主题
│   ├── monaco/cjkWrapStrings.ts  中文标点按全角处理的行宽补丁（由 Vite 插件接管）
│   ├── assets/base.css           基础样式与 CSS 变量分层
│   ├── assets/main.css           应用主体样式
│   ├── ipc/bridge.ts             渲染层唯一 IPC 出口：invoke 包装、每个通道的类型化函数、订阅
│   ├── styles/theme.ts           主题 token（颜色/间距/字号）与 --yd-* 注入
│   ├── stores/
│   │   ├── tabs.ts               标签元信息（TabMeta）与 UI 状态，只存元信息不存全文
│   │   ├── library.ts            书库根、左栏列表、扫描进度、最近阅读防抖、评分筛选
│   │   ├── settings.ts           设置状态、持久化、主题应用与推送订阅
│   │   └── reader.ts             阅读锁定与翻页状态（不跨会话持久化）
│   ├── composables/
│   │   ├── useTabs.ts            标签打开/新建/切换/关闭/保存/改名/删除编排
│   │   ├── useTabLifecycle.ts    Monaco model 注册表（非响应式 Map）、dirty 基线、LRU 卸载与草稿
│   │   ├── useEditorSetup.ts     创建唯一编辑器实例、阅读字体、只读与右键动作注册
│   │   ├── useEditorCommands.ts  保存、转换、一键整理（全文只在读写瞬间取自 model）
│   │   ├── useEditorKeybindings.ts 全局/编辑器键位表与分发（焦点在输入框时放行）
│   │   ├── useEditorViewState.ts 驻留集合计算、定时 LRU 兜底、视图状态存取
│   │   ├── useLineCommands.ts    纯文本编辑动作：缩进换行、行下插入、删到行首、翻页
│   │   ├── useSession.ts         会话快照/恢复、进度与光标 Map、退出握手、换库存档
│   │   ├── useLibrarySwitch.ts   换库编排：open → 存档旧会话 → activate → 恢复新会话
│   │   ├── useMetadataEdit.ts    元数据栏提交：最小可撤销编辑 + 同步库
│   │   ├── useRatingGesture.ts   评分「再点同分清零」手势判定
│   │   ├── useChapters.ts        当前书章节状态与刷新
│   │   ├── useBookmarks.ts       当前书书签状态（增删以主进程返回为准）
│   │   ├── useBookmarkDrift.ts   编辑后书签行号按行数差量平移与防抖回写
│   │   ├── useLibraryBookmarks.ts 全库书签分组状态
│   │   ├── useCommandPalette.ts  Cmd+P 书库快照与内存过滤
│   │   ├── useStatusMessage.ts   状态栏临时提示（模块级，任何组件可触发）
│   │   └── useStatusMetrics.ts   状态栏数字：光标行、总行数、字数
│   └── components/
│       ├── EditorHost.vue        单 Monaco 实例宿主：挂 model、视图恢复、右键菜单、查找/转换事件、标题跟随
│       ├── TabBar.vue            自绘标签栏、flare 圆弧、横向滚动、右键菜单
│       ├── Sidebar.vue           左栏壳：五页切换与拖拽宽度
│       ├── sidebar/SidebarEdit.vue      打开中的标签列表（顺序同标签栏，可拖动排序）
│       ├── sidebar/SidebarShelf.vue     书架惰性目录树（只读文件系统）
│       ├── sidebar/SidebarBookList.vue  书库书籍行列表（打开、评分、筛选）
│       ├── sidebar/SidebarTags.vue      标签列表与标签下钻
│       ├── sidebar/SidebarRating.vue    评分筛选页
│       ├── sidebar/StarRating.vue       五星评分控件
│       ├── MetadataBar.vue       书名/作者/标签/评分四项编辑与双向同步
│       ├── RightPanel.vue        右栏壳：章节/书签/历史三页与拖拽宽度
│       ├── right/ChapterPage.vue        章节列表 + 当前书书签
│       ├── right/BookmarkList.vue       当前书书签列表与跳转
│       ├── right/LibraryBookmarkPage.vue 全库书签按书分组
│       ├── FindReplaceBar.vue    自绘查找替换栏（单行 + 跨行正则）
│       ├── CommandPalette.vue    Cmd+P 检索浮层
│       └── StatusBar.vue         底部状态栏：编码、行列、字数、临时提示
│
└── scripts/
    ├── cdp-eval.mjs              通过 CDP 9222 在页面执行 JS
    ├── cdp-shot.mjs              通过 CDP 截图（视觉验收）
    ├── test-convert.ts           简繁/全角/一键整理用例
    ├── test-find-rules.ts        规则表内容、顺序与默认开关
    ├── test-finder-metadata.ts   Finder 星级/注释 xattr 往返
    ├── test-library-search.ts    命令面板检索与排序
    ├── test-library-switch.ts    换库、每库一份数据库、会话随库隔离
    ├── test-metadata-writer.ts   前 10 行写回的最小替换区间
    ├── test-right-panel.ts       章节提取与书签增删
    ├── test-session-paths.ts     会话路径落盘/恢复/换库/重定位
    └── test-text-codec.ts        编码探测与写回编码
```

## 2. 关键数据流

### 2.1 IPC：一次 invoke 的完整链路

```
组件 / composable
  → src/ipc/bridge.ts            类型化函数 + ipcInvoke
  → window.yue.invoke            preload 暴露
  → preload.ts DOMAINS 前缀校验
  → ipcMain.handle              registry.ts 的 handle() 包装
  → ipc/index.ts 注册表中的实现
  → electron/ipc/<域>.ts        参数收敛
  → electron/services/<域>.ts   纯 Node 业务
  ← { ok: true, data } | { ok: false, error }
```

**新增一个通道要同步四处**（AGENTS.md 说三处，另加实现文件本身）：

1. `electron/ipc/registry.ts` 的 `IPC_DOMAINS`：新域前缀才需要，已有域跳过。
2. `electron/preload.ts` 的 `DOMAINS`：与上表保持一致（当前 10 个前缀）。
3. `electron/ipc/index.ts` 的 `registerIpcHandlers()`：`handle('域:动作', ...)`。
4. `src/ipc/bridge.ts`：对应的类型化函数（渲染层只从这里调）。

当前域前缀：`app:`、`file:`、`library:`、`session:`、`meta:`、`finder:`、`convert:`、`dialog:`、`native:`、`settings:`。
注意 `finder:` 只是白名单占位，目前没有注册通道；Finder xattr 实际走 `meta:readRating/applyRating` 与 `library:setBookRating`。

**主进程 → 渲染层的推送通道**（不走 invoke 白名单，preload 里按固定名订阅）：

| 通道 | 方向与用途 | 发送点 |
| --- | --- | --- |
| `theme:updated` | 生效主题变化 | `ipc/theme.ts` |
| `session:flush` | 关窗/退出前要求渲染层落盘 | `ipc/session.ts requestRendererFlush()` |
| `library:scanProgress` | enrich 扫描进度 | `ipc/library.ts enrichLibrary()` |
| `app:menuCommand` | 菜单/快捷键动作转交渲染层 | `menu.ts` |

### 2.2 编辑器：单实例 + 每标签一个 model

- 实例：`EditorHost.vue` 创建唯一 `IStandaloneCodeEditor`（`useEditorSetup.createReaderEditor`），全应用只此一个。
- 模型：`useTabLifecycle.ts` 的模块级 `Map<tabId, ModelEntry>`，**非 reactive**；全文只存在 `monaco.editor.ITextModel`，Pinia 只存 `TabMeta`。
- 切换：`editor.setModel(entry.model)`，禁止用 `:key` 重建实例。
- dirty：`model.getAlternativeVersionId()` 与 `ModelEntry.baselineVersionId` 比较，O(1)，不读全文；保存后 `resetBaseline`。
- 视图：切标签前 `saveViewState`，切回 `restoreViewState`；启动恢复的视口/光标在 `useSession.applyRestoredView` 消费一次。
- LRU：驻留集合 = 当前标签 + `lastFocusedAt` 最新的 `preloadCount` 个；`useEditorViewState` 在切换时同步计算并每 5 分钟兜底。卸载前把 dirty 全文与 viewState 经 `file:writeDraft` 写库，再 `dispose()`，标签元信息保留。
- 竞态：卸载单飞 `unloadInFlight`、重载单飞 `reloadInFlight`、换库代际 `epoch`；异步结果发现代际变了直接放弃。
- 打开：`useTabs.openFile` → `file:readText`（主进程解码）→ `createTabModel` → 激活 → `setModel`。同一文件用 `statCache`（inode 优先、realPath 兜底）去重。
- 保存：`useEditorCommands.saveActive` 即时 `model.getValue()` → `file:writeText`（临时文件 + rename）→ 刷新 stat、清草稿、同步元数据到库（`library:syncMetadata`，不做全库重扫）。
- 标题：正文前 10 行书名号优先，变更时节流更新标签标题；blank 标签用首行。
- 编辑相关事件：`yueduo:findReplace`、`yueduo:convert`、`yueduo:tabRelocated` 由 `App.vue` / 菜单派发，`EditorHost` 监听执行。

### 2.3 会话落盘与恢复

**落盘**

1. 标签增删、切换、滚动 → `useSession.schedulePersist()` 2 秒防抖；进度（视口顶部行）与光标行列存模块级 `Map`，不进响应式。
2. `session:persist` → `ipc/session.ts sessionPersist` → `services/sessionStore.persistSession` 写 `session_tabs` + `session_state`。
3. 库内标签写 `book_id` + 相对路径，库外写绝对路径 + `book_id NULL`；判定在主进程（`useSession` 只传绝对路径）。

**退出/关窗握手**

```
main window 'close' / app 'before-quit'
  → e.preventDefault()
  → requestRendererFlush() 发 session:flush
  → 渲染层 flushForQuit(): 书签漂移 → 最近阅读时间戳 → 快照 → 并行写驻留脏标签草稿
  → session:flushDone
  → 主进程放行 close/quit → will-quit 里 shutdownLibrary()（关库、WAL checkpoint）
```

草稿与快照分开 try：任一草稿失败不影响快照，也不阻塞 `flushDone`。

**恢复**

1. `App.vue` 初始化 → `restoreSession()` → `session:restore` → `loadSession()`。
2. 库内标签按 `books.relative_path` 拼当前书库根；查不到或文件不存在 → 保留标签并标 `missing`。
3. `applyRestoredSession` 重置渲染层（解绑 model、清注册表、清 Map）再灌入标签元信息；正文由 `EditorHost` 激活时懒加载，草稿按 `tabId` 从当前库懒读。
4. 后台 enrich 扫完 → `App.vue` 监听 `library.scanning` → `retryMissingTabs()` → `session:relocate` 按 `book_id` 重算路径，只重试一次。

**换库**（`useLibrarySwitch`，顺序固定）

```
library:open（主进程建新库 + 停扫描 + 读新会话，旧库仍活动）
→ archiveSessionForSwitch（书签/时间戳落盘 → 快照 → 驻留脏标签草稿，写进旧库）
→ library:activate（提交点：关旧库、切新库）
→ applyRestoredSession（清空旧 model，灌入新库会话）
任一失败 → library:abort（只关新库，旧库继续可用）
```

### 2.4 书库扫描、对账与单文件入库

- 启动：`main.ts` 在 `registerIpcHandlers` 之后调用 `initActiveLibrary()`；`LibraryDatabaseManager.init()` 按设置里的书库根打开 `<根>/yueduo.db`，不可写时回落 `userData/library-db/<根哈希>.db`。建窗后渲染层用 `library:current` 读取状态。
- 惰性浏览：`library:fastScan` → `libraryScanner.listDirectory`，只读一层，不碰数据库（书架目录树）。
- 全库补全：`library:enrich` → `libraryScanner.scanLibrary`（解码 + 解析元数据 + 写 `books`，每 10 个推送进度）→ `reconcileLibrary` 对账。
- 对账：直命中重置 `miss_count`；疑似移动用「标题+文件名 / 文件名+大小 / 标题+字数」匹配，旧 `id` 接手新路径以保留评分、进度、书签；连续零匹配达到阈值才删记录；空扫描结果直接返回，避免把全库误删。
- 单文件入库：保存或另存为后 `library:syncMetadata` → `libraryScanner.ingestFile`，路径判定与相对路径换算都在这里（先 realpath 书库根与文件），命中更新、未命中插入，无需全库重扫。
- 评分：库内 `books.rating` + Finder 星级 xattr；库外只写文件 xattr。读评分同理分流。

### 2.5 设置读写与菜单同步

- 启动：`src/main.ts` 先 `settings.init()`（`settings:get`）再 mount，主题 token 首帧前注入，避免闪白。
- 读写：`settings:get/set` → `services/settingsStore`（`userData/settings.json`，写临时文件再 rename）；`set` 与旧值合并，部分字段不会重置其余设置。
- 主题：`settings:set` 里 `applyThemeSource(appearance)` 切 `nativeTheme.themeSource`，`ipc/theme.ts` 再推 `theme:updated`；渲染层以主进程推送为权威值。
- 菜单动作：`menu.ts` 点击 → `webContents.send('app:menuCommand', payload)` → `App.vue runMenuCommand` 按当前 active 标签分发（保存/关闭/打开/书库/外观/预载/关闭按钮等）。
- 菜单勾选：侧栏显隐变化 → `app:syncMenuState` → `menu.syncMenuState()` 回写 `checked`，键盘与菜单两条路径一致。
- 快捷键：`useEditorKeybindings` 统一收口（全局捕获阶段 + 编辑器 scope），焦点在输入框时放行；菜单与快捷键都只转交意图。

## 3. 速查索引

| 想改什么 | 先看这些文件 |
| --- | --- |
| 加一个 IPC 通道 | `ipc/index.ts`、`preload.ts`、`ipc/registry.ts`（新域才改）、`src/ipc/bridge.ts`、对应 `ipc/<域>.ts` |
| 改文件读写 / 编码 | `ipc/file.ts`、`services/textCodec.ts`、`services/metadataWriter.ts` |
| 改标签行为（打开/关闭/保存/改名） | `composables/useTabs.ts`、`components/TabBar.vue`、`composables/useTabLifecycle.ts` |
| 改编辑器选项 / 主题 / 字体 | `src/monaco.ts`、`composables/useEditorSetup.ts`、`styles/theme.ts` |
| 改快捷键 | `composables/useEditorKeybindings.ts`、`composables/useLineCommands.ts`、`electron/menu.ts` |
| 改 LRU / 草稿 / 会话 | `composables/useTabLifecycle.ts`、`composables/useEditorViewState.ts`、`composables/useSession.ts`、`services/sessionStore.ts`、`services/draftStore.ts` |
| 改元数据解析 / 写回 | `shared/metadataParser.ts`、`services/metadataWriter.ts`、`ipc/meta.ts`、`components/MetadataBar.vue` |
| 改书库扫描 / 对账 | `services/libraryScanner.ts`、`services/reconcile.ts`、`ipc/library.ts` |
| 改换库流程 | `composables/useLibrarySwitch.ts`、`services/libraryDatabase.ts`、`ipc/library.ts`、`composables/useSession.ts` |
| 改数据库表 / 迁移 | `services/database.ts`（`MIGRATIONS`，追加新版本，不改旧版本） |
| 改书库列表 / 评分 / 标签 | `services/bookRepository.ts`、`stores/library.ts`、`components/sidebar/*` |
| 改书签漂移 / 章节 | `composables/useBookmarkDrift.ts`、`services/bookmarkRepository.ts`、`services/chapterParser.ts` |
| 改查找替换 / 一键整理规则 | `shared/findRules.ts`、`shared/replaceTemplate.ts`、`shared/crossLineSearch.ts`、`services/tidy.ts`、`components/FindReplaceBar.vue` |
| 改简繁 / 全角半角 | `services/chineseConvert.ts`、`services/textConvert.ts`、`resources/dicts/` |
| 改 Finder 星级 / 注释 | `services/finderMetadata.ts`、`ipc/meta.ts`、`ipc/library.ts` |
| 改应用菜单 / 菜单勾选 | `electron/menu.ts`、`src/App.vue`（`runMenuCommand`）、`ipc/app.ts` |
| 改设置项 | `shared/types.ts`（`AppSettings`/`DEFAULT_SETTINGS`）、`services/settingsStore.ts`、`stores/settings.ts`、`electron/menu.ts` |
| 改主题颜色 / 间距 | `styles/theme.ts`、`assets/base.css` |
| 加验收脚本 | `scripts/test-*.ts`（纯 Node，`tsx` 运行） |

## 4. 动手前的四条红线

- 渲染层不 import Node 模块；路径拼接、文件判定都在主进程。
- 全文不进 Pinia / Vue reactive；只经 `useTabLifecycle` 的非响应式 `Map` 与 Monaco model。
- 不重建 Monaco 实例：单实例 + `setModel()` 切换。
- `shared/findRules.ts` 的数组顺序就是整理顺序，增删规则只改这一处。
