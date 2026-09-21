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
sidecar（invoke → Go 侧车 → 真实 .md 文件 + 索引落盘到你指定的目录）
  → memory（明确告警「不会落盘」，绝不假装成功）
```

> 沙箱里 `localStorage` 也不可用，而且**刻意不做静默退化**：退化会让故障表现成
> 「这次能存、下次打开就没了」这种最难查的形态。存储不可持久化时，界面直接告诉你。

`storage.js` 里额外做了 **opaque origin 探测**：只有在非沙箱环境才会显示「选择笔记目录…」按钮，
因此在 DBX 里不会再出现一个点了必报错的按钮。

### 笔记存在哪

在「新建连接 → MD 笔记」表单里填 **`笔记存储目录`**（必填）。笔记是**存储目录下的真实文件**：
每篇笔记一个 `.md`，每个文件夹一个真实子目录；目录树索引单独放在 `<存储目录>/.mdnotes/meta.json`
（只存层级/标题/顺序，不含正文，正文永远以 `.md` 为准）。
侧车写盘一律「临时文件 + rename」原子替换，并把目录记住（`config.json`），下次启动直接复用。

导出、备份都走宿主的原生「另存为」对话框，**目录和文件名由你自己选**；
备份包是个 zip，除正文外还带 `mdnotes-backup.json`（版本 / 导出时间 / 原存储目录）和
`.mdnotes/meta.json`（目录树层级），所以可以从备份一键恢复出原来的层级和标题。

### 删除与数据安全

- 在界面里删除笔记/文件夹时，正文**不会被销毁**，而是移到 `<存储目录>/.mdnotes/trash/<时间戳>/` 下（可手动捞回）。
- 保存采用「**只删你显式删掉的东西**」语义：快照里没有的笔记会被**原样保留**，不会因为「这个连接没打开过它」而被清掉。
  因此**同一个存储目录可以被多个连接同时打开**，互不覆盖、互不删除。
- 如果某篇笔记的正文文件读不到（被外部改名/移动/占用），界面会把它**冻结成只读**并提示 —— 绝不会把空内容写回覆盖掉磁盘上的正文。

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
│   ├── app.js               # 目录树（含指针拖拽）、编辑器/预览、搜索、主题、表联动、导入导出/备份恢复
│   ├── markdown.js          # Markdown 渲染（无依赖）
│   ├── sql-highlight.js     # SQL 语法高亮
│   └── storage.js           # 存储层：sidecar 优先，失败必上抛
├── backend/
│   ├── go.mod               # module github.com/example/mdnotes，零外部依赖
│   ├── main.go
│   ├── main_test.go         # 备份/恢复往返、路径穿越拒绝、哈希缓存 等单测
│   └── dbxsdk/              # 官方 Go SDK 原样 vendor（见 dbxsdk/VENDOR.md）
├── dist/                    # 打包产物 *.dbxp（不进版本控制）
└── _*.{js,mjs,py}           # 验证工具链（`_` 前缀，不进包，见下）
```

### 验证工具链

改动前端或打包相关代码后，按顺序跑这四层（**只测后端测不出桥接 bug，只测桥接测不出"界面启动即死"**）：

```bash
node _domcheck.py           # 1) 静态：DOM 引用悬空 / 关键元素缺失
node _buildpkg.js           # 2) 打包（内建四道自检 + 精确 checksums）
node _verify.mjs            # 3) 包结构 + sha256 + 关键代码标记
node _e2e_bridge.mjs        # 4a) 桥接级：官方 SDK 源串 + 真实 storage.js + 真实侧车
node _e2e_ui.mjs            # 4b) UI 级：真实 index.html 跑在 jsdom 里（需 jsdom）
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
| `notes/load` | 返回 `{data, path, dir, pending}`，`pending` 是右键「为此表新建笔记」的待处理上下文，取走即清空。**注意 `data` 是外壳**：笔记内容在 `data.nodes` |
| `notes/save` | 把正文写成 `.md`（内容未变则按 SHA-256 缓存跳过）+ 原子替换索引 `.mdnotes/meta.json` |
| `notes/exportNote` | 导出单篇。默认返回 `{fileName, dataBase64}`（交宿主「另存为」）；`toDisk:true` 才写进存储目录 |
| `notes/backup` | 备份为 zip。默认返回字节；`toDisk:true` 才写盘。包内含正文 + `mdnotes-backup.json` + `.mdnotes/meta.json` |
| `notes/restore` | 从备份 zip 恢复（`dryRun` 只回报）。拒绝路径穿越、拒绝非本插件备份，恢复前自动存 `pre-restore-*.zip` 快照 |
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
