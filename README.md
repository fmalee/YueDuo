# 悦读 / YueDuo

本地 TXT 小说管理与阅读器：编辑器界面即阅读界面。标签栏、单 Monaco 实例、每标签一个 model，视觉与交互对齐 VS Code / Chrome。

这份 README 面向「未来的自己和协作者」，只写怎么跑起来、环境怎么隔离、数据放在哪。实现约定与硬约束以 [AGENTS.md](AGENTS.md) 为准，目录职责与数据流见 [.trae/documents/architecture.md](.trae/documents/architecture.md)，这里不重复展开。

## 技术栈

| 层 | 选型 | 版本 |
| --- | --- | --- |
| 桌面运行时 | Tauri 2（Rust 后端 + 系统 WebView，无 Node 进程） | 2.12.x |
| 后端语言 | Rust（edition 2021） | ≥1.90 |
| 渲染层 | Vue 3 + Pinia | 3.5.x / 4.1.x |
| 类型 | TypeScript（严格模式，`noImplicitAny: false`） | 5.9.x |
| 编辑器 | Monaco Editor | 0.57.x |
| 存储 | rusqlite（bundled SQLite，同步 API + 完整事务） | 0.32.x |

TypeScript 锁在 `^5.9.3`（5.x 末版）不是随手写的：npm 上 `latest` 已是 7.0.2，TS 7 是原生移植，不提供 `lib/typescript.js` 编译 API，而 vue-tsc / Volar 的 SFC 类型检查依赖这个 API。因此禁止把版本写成 `latest`、`*` 或 `>=5.9`。

2026-11-20 起从 Electron 完成向 Tauri 的重构：前端（Vue/Monaco/composables/stores）原样迁移，主进程以 Rust 重写；Electron 版代码已删除，历史参考用 `git show a46ae4a:<路径>`。

## 常用命令

```bash
npm install            # 安装前端依赖（dependencies 为空，运行时零 npm 包）
npm run dev            # 开发模式：tauri dev（改 Rust 后重编译 1–3 分钟属正常，dev 档已开优化）
npm run build          # 先 typecheck，再 tauri build（app + dmg）
npm run typecheck      # tsc 检查 vite 配置/shared，vue-tsc 检查渲染层
npm run lint           # eslint --cache .
npm run format         # prettier --write .
```

Rust 侧检查与测试（services 单测的唯一口径）：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml                    # 54+ 用例
cargo test  --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture   # 真实书库编码回归
```

## 开发环境隔离

- 数据目录：`app_data_dir`（`~/Library/Application Support/com.yueduo.reader`）。需要指到别处（自动化验收隔离）设 `YUE_USER_DATA=<目录>`。
- 首次启动自动把 Electron 版数据（`~/Library/Application Support/YueDuo` 的 settings.json 与回落库）搬过来：copy 不删源、标记幂等；旧目录原样保留，随时可切回 Electron 版（git 历史 `a46ae4a`）。
- `YUE_TEST=1`：自动化验收。跳过删除确认框与退出握手、开发环境书库确认直接放行；配合 `YUE_USER_DATA` 指向临时目录。
- 开发环境书库确认：debug 构建下打开测试库（`/Users/Joey/Sites/Projects/小说`）以外的书库先弹确认——扫描会写 Finder 星级与注释，避免调试改动正式数据。
- 单实例锁：tauri-plugin-single-instance，二次启动聚焦已有窗口。

## 打包

`npm run build`（= typecheck + `tauri build`，产出 `.app` 与 `.dmg`）：

- 词表经 `bundle.resources` 进包（运行时从 `resource_dir/dicts` 探测；开发态回落仓库根）。
- dev 态 Dock 图标是 Tauri 默认属正常现象（debug 可执行无 Info.plist icon），打包版带真实图标。
- 签名与公证配置待补（当前仅本机构建运行）。

## 数据位置

- 每个书库一份数据库：首选 `<书库根>/yueduo.db`，`relative_path` 相对书库根。
- 书库根不可写时回落到 `<app_data_dir>/library-db/<sha1(realpath)[:16]>.db`，按库隔离，不共用。
- 设置写在 `<app_data_dir>/settings.json`（逐字段归一化，坏值回落）。
- 会话标签、阅读进度、草稿全文都在当前书库的数据库里；换库会切到新库的会话。
- schema 迁移用 `PRAGMA user_version`（v1–v3，SQL 与 Electron 版逐字一致），数据双向兼容。

## 项目结构

```
src-tauri/  Rust 后端：commands/ 按域收敛 IPC 参数，services/ 纯业务（不依赖 tauri 类型），
            state/ SQLite 仓储，shell.rs 菜单，theme.rs 主题
shared/     两侧共用契约与规则（findRules.json 唯一正则来源，TS 与 Rust 共读）
src/        渲染层：components/ + composables/ + stores/ + ipc/bridge.ts（原样迁移自 Electron 版）
resources/  简繁转换词表（经 bundle.resources 进包）
```

- 跨进程唯一通道：`src/ipc/bridge.ts` 的 typed commands（command 名 = Rust fn 名），渲染层不 import Node 模块、不直接用 `@tauri-apps/api`。
- 全文只存在 Monaco model（`useTabLifecycle` 的非响应式 `Map`），Pinia 只存标签元信息。
- 主题颜色/间距只在 `src/styles/theme.ts` 定义，经 `--yd-*` CSS 变量注入。
- 目录级职责、IPC 链路、退出握手、会话落盘/恢复、书库扫描与对账等细节，见 [.trae/documents/architecture.md](.trae/documents/architecture.md)；开发约定、Tauri 纪律、数据库与 Monaco 硬约束见 [AGENTS.md](AGENTS.md)。

## 开发流程

- 在 `dev` 分支开发，`master` 为默认分支，不直接推远端。
- 每写完一个文件立即 `npm run typecheck`；Rust 改动后 `cargo check` → `cargo test`；提交前跑 `npm run lint`。
- 一次提交一件事，中文提交信息写「为什么」；不提交 `out/`、`dist/`、`node_modules`、`src-tauri/target/`、`public/test/`、`.workbuddy/`。
