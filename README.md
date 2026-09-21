# MD 笔记（Markdown Notes）— DBX 笔记插件

以**连接类型**的方式进入独立的 Markdown 笔记工作台：左侧目录树、右侧编辑器 + 实时预览双视图，内置
**SQL 代码块语法高亮**（贴合 DBX 数据库场景），支持与数据库表联动新建设计笔记。

---

## 1. 持久化架构（重要）

插件 UI 运行在 **sandboxed iframe** 里，这点决定了存储怎么做：

| 通道 | 在 DBX 沙箱内是否可用 |
| --- | --- |
| `localStorage` / `sessionStorage` | 不保证可用（opaque origin 时直接抛错） |
| `IndexedDB` | 同上 |
| `showDirectoryPicker`（File System Access API） | **被拒绝**：`Sandboxed documents aren't allowed to show a file picker` |
| `window.dbxPlugin.invoke()` → **侧车写磁盘** | ✅ 唯一可靠通道 |

所以本插件的后端优先级是：

```
sidecar（invoke → Go 侧车 → notes.json 落盘到你指定的目录）
  → localStorage（本地浏览器预览时的兜底）
  → sessionStorage
  → memory（明确告警，不假装成功）
```

`storage.js` 里额外做了 **opaque origin 探测**：只有在非沙箱环境才会显示「选择笔记目录…」按钮，
因此在 DBX 里不会再出现一个点了必报错的按钮。

### 笔记存在哪

在「新建连接 → MD 笔记」表单里填 **`笔记存储目录`**（必填），侧车会把笔记写成该目录下的
`notes.json`（临时文件 + rename 原子替换）。同时它也会把目录记住（`config.json`），下次启动直接复用。

---

## 2. 安装与构建

需要 Node 22+ 与 Go **1.20+**（因为官方 SDK 已 vendor 进本仓库，无需拉外部模块，可离线构建）。已在 Go 1.20.6 / 1.25.0 上验证通过。

> **不要手动设置 `GOROOT`**（Go 1.21+ 会自行定位）。升级 Go 后若旧目录还在、环境变量没跟着改，
> 会出现 `package encoding/json is not in std` 这类全线报错——见 [§5 排障](#5-排障)。

```bash
# 安装 CLI（只需一次）
npm install -g @dbx-app/plugin-cli

cd dbx-md-notes
dbx-plugin dev     # 本地调试（会编译 Go 后端）
dbx-plugin package # 输出 .dbxp
```

> `dbx-plugin.toml` 里的 `[backend]` 段是 CLI 编译后端的关键；`[package].include` **不要**包含 `bin/`——
> CLI 会把自己编译出的产物注入包里。

然后在 DBX 里：

1. 设置 → 插件 → 安装 `.dbxp`；
2. 新建连接 → 选择 **MD 笔记** 类型；
3. 填写 **笔记存储目录**（有读写权限的绝对路径）→ 测试连接；
4. 打开连接即进入笔记工作台，右下角状态栏应显示「已保存到笔记存储目录：…」。

---

## 3. 目录结构

```
dbx-md-notes/
├── manifest.json            # 仅声明 entrypoints.backend.executable（transport 字段在 manifest v1 已废弃）
├── dbx-plugin.toml          # [backend] language/directory/binary + [package] include
├── assets/plugin.svg
├── ui/
│   ├── index.html
│   ├── styles.css
│   ├── app.js               # 目录树、编辑器/预览、搜索、主题、表联动、导入导出
│   ├── markdown.js          # Markdown 渲染（无依赖）
│   ├── sql-highlight.js     # SQL 语法高亮
│   └── storage.js           # 存储层：sidecar 优先，失败必上抛
└── backend/
    ├── go.mod               # module github.com/example/mdnotes，零外部依赖
    ├── main.go
    └── dbxsdk/              # 官方 Go SDK 原样 vendor（见 dbxsdk/VENDOR.md）
```

### 为什么要 vendor 官方 SDK

`github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk` **没有发布到 Go 模块代理**（`go get` 报
`unknown revision`），且其 `go.mod` 声明 `go 1.22`，独立引入会让低版本工具链无法构建。
因此把官方 `sdk.go` **逐字节**复制为 `backend/dbxsdk` 包，与本模块一起编译：只需 Go 1.20+，离线可构建。
（参考项目的 Rust SDK 也是同样的 vendor 做法。）

SDK 负责三件容易写错的事：`plugin/initialize` 必须返回
`{protocolVersion, capabilities, plugin:{id,version}}`（id/version 必须与 manifest 一致，否则宿主丢弃侧车）、
每请求一个 goroutine、8MB 行缓冲。

---

## 4. Sidecar RPC

| 方法 | 说明 |
| --- | --- |
| `plugin/initialize` | 由 SDK 处理，完成协议版本与身份校验 |
| `connection/test` | 校验存储目录可写，返回将写入的路径 |
| `connection/connect` / `disconnect` | 连接生命周期；`connect` 会从连接配置里吸收 `storage_dir` |
| `notes/ping` | 前端握手探测（确认侧车真的活着） |
| `notes/load` | 返回 `{data, path, dir, pending}`，`pending` 是右键「为此表新建笔记」的待处理上下文，取走即清空 |
| `notes/save` | 写 `notes.json`（原子替换） |
| `notes/setDir` / `notes/path` | 手动指定 / 查询目录 |
| `filesystem/list|read|write|createDirectory|delete|rename` | 把笔记树投影成 `mdnotes://` 虚拟文件系统 |
| `contextMenu/com.example.mdnotes.newNoteForTable` | 记录表上下文到 `pending` |

> Sidecar 会递归扫描入参里的 `storage_dir / storageDir / storage_path / notes_dir …`，
> 不依赖宿主把配置塞在某个固定字段路径上。

---

## 5. 排障

状态栏 → 点开「存储状态」，按这几行排查：

| 现象 | 原因与处理 |
| --- | --- |
| 侧车进程：**不可用 —— 未提供 invoke 桥接** | 插件前端没运行在 DBX 宿主里（例如直接用浏览器打开 `ui/index.html`）。属预期。 |
| 侧车进程：**不可用 —— Method not found: notes/ping** | `invoke` 通了但侧车没认出来 → 多半 `manifest.json` 的 `entrypoints.backend.executable` 与实际二进制名不一致，或 `dbx-plugin.toml` 缺 `[backend]` 导致后端从未被编译。 |
| 实际落盘目录：**（未读到）** | 宿主没有把连接配置传进前端上下文。侧车仍会在 `connection/connect` 时自行吸收目录，所以不影响保存；只是 UI 显示不出来。 |
| 保存失败 + 权限类错误 | 存储目录不可写 / 不存在。改一个当前用户有权写入的目录，或重新 `dbx-plugin package` 后重启 DBX。 |

### 构建期：`package XXX is not in std (…\go\src\XXX)`

`dbx-plugin package` 编译后端时报出一长串 `package encoding/json is not in std`、`package bufio is not in std`，
末尾跟着 `cannot find package`——**这不是代码问题，是 Go 装坏了/指错了**。

根因是环境变量 `GOROOT` 指向了一个不存在或不完整的 Go 目录。Go 会去 `$GOROOT/src` 找标准库，
那个目录没有标准库，于是所有 std 包全部报 "not in std"，模块解析也随之失败。

自查与修复（Windows）：

```powershell
go env GOROOT          # 看它到底指向哪
Test-Path "$((go env GOROOT))\src\encoding\json"   # False 就是错的方向
where.exe go           # 看实际调用的是哪个 go.exe
```

三种改法，任选其一：

```powershell
# 1) 用户级覆盖（不需管理员，推荐）
[Environment]::SetEnvironmentVariable("GOROOT", "D:\apply\go1.25", "User")

# 2) 直接删掉 GOROOT（Go 1.21+ 最佳实践，需管理员）
[Environment]::SetEnvironmentVariable("GOROOT", $null, "Machine")

# 3) 临时生效（仅当前终端）
$env:GOROOT = "D:\apply\go1.25"
```

同时确认 PATH 里 `…\go\bin` 指向的是新 Go 的目录。改完**重开一个终端**再执行
`go env GOROOT` 与 `dbx-plugin package` 验证。

---

## 6. 已知约束

- 官方 `context-menu` 贡献点的 `menu` 只支持 `"connection"`（挂在连接上），因此「为此表新建笔记」
  目前通过表侧的右键项 → Siddecar `pending` → 前端自动生成模板的方式完成。
- `filesystem-provider` 依赖宿主发起 `filesystem/*` 调用；若你的 DBX 版本尚未使用它，
  笔记照样通过 `notes/*` 正常存取，只是不会出现在通用文件管理器里。
