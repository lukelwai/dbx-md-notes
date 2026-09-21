# MD 笔记（Markdown Notes）

> DBX 插件 · 连接类型式的 Markdown 笔记工作台

把笔记做成 DBX 里的一个**连接类型**：新建「MD 笔记」连接 → 打开独立工作台（左侧目录树 + 右侧编辑器/实时预览）。
笔记落盘为**存储目录下的真实 `.md` 文件**，因此在 DBX 里能编辑，在 DBX 外也能用任何编辑器打开、能被 grep、能进 Git。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 目录树 | 文件夹 = 真实子目录；支持**拖拽移动**（含整棵子树）、重命名、右键菜单 |
| 编辑与预览 | 编辑/预览/分栏三视图；无依赖的 Markdown 渲染（标题、列表、表格、引用、任务列表、行内代码…） |
| SQL 高亮 | ` ```sql ` 代码块语法高亮，贴合 DBX 数据库场景 |
| 与表联动 | 「为表新建笔记」把当前连接/表上下文带进新笔记，自动生成字段表格骨架 |
| 搜索 | 标题 + 正文全文检索 |
| 导入/导出 | 导出单篇 `.md`、导出文件夹为 zip —— 走宿主原生「另存为」，**目录和文件名由你选** |
| 备份/恢复 | 一键备份全部（zip，含配置与目录树索引），可从备份**原样恢复**层级与标题 |
| 删除安全 | 删除进回收站而非销毁；多连接共用同一目录互不覆盖（见[数据安全](#数据安全)） |
| 文件系统 | 把笔记投影成 `mdnotes://` 虚拟文件系统，交给 DBX 通用文件管理器浏览/编辑 |
| 主题 | 跟随宿主明暗主题 |

**快捷键**：`Ctrl/Cmd+S` 保存 · `Ctrl/Cmd+N` 新建笔记 · `/` 聚焦搜索 · `Esc` 关闭弹窗。

---

## 安装（使用 .dbxp）

1. 打开 DBX → 设置 → 插件；
2. 安装 `dist/com.lwai.mdnotes-<版本>-windows-x64.dbxp`；
   若提示签名相关错误，先在插件页开启**「允许安装未签名开发包」**（本地开发渠道）；
3. 新建连接 → 连接类型选 **MD 笔记**；
4. 填写 **笔记存储目录**（有读写权限的绝对路径，可点右侧文件夹按钮选择）→ 测试连接；
5. 打开连接即进入工作台。状态栏（右下角）应显示「已保存到存储目录：…」，点它可看存储状态详情。

---

## 数据安全

插件的存储设计按「**一个目录可能被多个连接同时打开**」这个前提来做，三条硬规则：

- **删除只认显式指令**。保存采用「只删你显式删掉的东西」的语义：快照里没有的笔记会被**原样保留**，
  不会因为「这个连接没打开过它」而被清掉。所以同一个存储目录可以安全地被多个连接/多窗口同时使用，互不覆盖、互不删除。
- **删除进回收站**。删除笔记/文件夹时正文不会消失，而是移到 `<存储目录>/.mdnotes/trash/<时间戳>/`，可手动捞回。
  极端情况下（文件被占用等）宁可留下孤儿文件，也不做不可逆的删除。
- **读不到就不写回**。如果某篇笔记的正文文件读不到（被外部改名/移动/占用），界面会把它**冻结成只读**并提示，
  绝不会把空内容写回去覆盖磁盘上的正文。

---

## 存储模型

```
<笔记存储目录>/
├── 欢迎使用 MD 笔记.md        # 每篇笔记 = 一个真实 .md（文件名 = 标题）
├── 工作/                      # 每个文件夹 = 一个真实子目录
│   └── 重构验证.md
└── .mdnotes/                  # 插件的元数据（不参与目录树显示）
    ├── meta.json              # 结构索引：id / 标题 / 父子关系 / 路径 / 时间戳 + UI 状态（不含正文）
    ├── trash/<时间戳>/         # 删除的正文（可捞回）
    └── .write-probe           # 可写性探针
```

- **正文永远以 `.md` 为准**；`meta.json` 只记结构，丢了也能靠文件名+目录重建。
- 写盘一律「临时文件 + `rename`」原子替换；临时文件名带 `pid` 与序号，避免多实例互相覆盖。
- 保存时按内容 SHA-256 缓存判断「是否真的变了」，只重写有变化的笔记。

### 为什么正文不放在索引里

单体 `notes.json` 在数据量大时读写与损坏的风险都高；拆成真实文件后每条笔记独立、可外部编辑、可 diff、可被其它工具消费。

---

## 构建

需要 **Node 22+** 与 **Go 1.20+**（官方 Go SDK 已 vendor 进 `backend/dbxsdk`，**无需联网即可构建**）。

### 推荐：用仓库自带脚本（内建自检 + 精确 checksums）

```bash
# 1) 编译侧车
GOROOT=<go 根> <go> build -C backend -o dbx-plugin-mdnotes.exe .

# 2) 打包（会先跑静态自检，再生成 .dbxp 与同名 artifact.json）
node _buildpkg.js
# → dist/com.lwai.mdnotes-0.7.1-windows-x64.dbxp
```

`_buildpkg.js` 会：把 `manifest.entrypoints.backend.executable` 重写为包内真实路径
（`bin/windows-x64/dbx-plugin-mdnotes.exe`）、生成**精确覆盖每个文件**的 `checksums.json`、跳过 `_` 前缀文件。

> 也可以走官方 CLI（`npm install -g @dbx-app/plugin-cli` 后 `dbx-plugin dev` / `dbx-plugin package`），
> 其行为等价。注意 `dbx-plugin.toml` 的 `[package].include` **不要**包含 `bin/` —— 二进制由打包器注入。

> **不要手动设置 `GOROOT` 指向错目录**。Go 1.21+ 会自行定位；若升级 Go 后旧目录还在、环境变量没跟着改，
> 会出现 `package encoding/json is not in std` 这类全线报错 —— 见[排障](#排障)。

---

## 目录结构

```
dbx-md-notes/
├── manifest.json          # id / publisher / version、entrypoints、连接类型字段、本地化
├── dbx-plugin.toml        # [backend] language/directory/binary + [package] include
├── assets/plugin.svg
├── ui/                    # 前端（跑在沙箱 iframe 里，无磁盘/网络权限）
│   ├── index.html
│   ├── styles.css
│   ├── app.js             # 目录树（指针拖拽）、编辑器/预览、搜索、表联动、导出/备份/恢复
│   ├── markdown.js        # Markdown 渲染（无依赖）
│   ├── sql-highlight.js   # SQL 语法高亮
│   └── storage.js         # 存储层：唯一落盘通道 = 侧车；绝不静默退化
├── backend/
│   ├── go.mod             # module github.com/lwai/mdnotes（零外部依赖）
│   ├── main.go            # 侧车：笔记文件读写、索引、导出/备份/恢复、mdnotes:// 文件系统
│   ├── main_test.go       # 单测：重命名/移动、备份恢复往返、路径穿越拒绝、数据安全回归
│   └── dbxsdk/            # 官方 Go SDK 原样 vendor（见 dbxsdk/VENDOR.md）
├── dist/                  # 打包产物 *.dbxp（不进版本控制）
└── _*.{js,mjs,py}         # 验证工具链（`_` 前缀，不进包）
```

### 为什么 vendor 官方 SDK

`github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk` **没有发布到 Go 模块代理**（`go get` 报 `unknown revision`），
且其 `go.mod` 声明 `go 1.22`，独立引入会让低版本工具链无法构建。
因此把官方 `sdk.go` **逐字节**复制为 `backend/dbxsdk` 包，与本模块一起编译：只需 Go 1.20+，离线可构建。

SDK 负责三件容易写错的事：`plugin/initialize` 必须返回 `{protocolVersion, capabilities, plugin:{id,version}}`
（**id/version 必须与 manifest 完全一致，否则宿主直接丢弃侧车**）、每请求一个 goroutine、8MB 行缓冲。

---

## 验证工具链

改前端或打包相关代码后，**按顺序跑完这四层**：

```bash
NODE=<node 可执行文件>

"$NODE" _e2e_bridge.mjs   # 1) 桥接级：官方 SDK 源串在 vm 里跑 + 模拟宿主 dispatch + 真实 storage.js + 真实侧车
"$NODE" _e2e_ui.mjs       # 2) UI 级：真实 index.html 灌进 jsdom + 真实侧车（需 jsdom）
$PYTHON _domcheck.py      # 3) 静态：DOM 引用悬空、重复函数声明、关键元素缺失
"$NODE" _buildpkg.js && "$NODE" _verify.mjs   # 4) 打包（内建自检）+ 产物结构 / sha256 校验
```

各层能抓住什么：

- **`_e2e_bridge.mjs`** —— 桥接语义错用、侧车握手失败、导出/备份/恢复往返、**数据安全语义**（未知≠要删、显式删除进回收站、缺正文不写回）。
- **`_e2e_ui.mjs`** —— **唯一能抓住「界面启动即死」的一层**：一个缺失元素就能让所有按钮失效。也覆盖拖拽落盘、删除必须带 `deletedIds`。
- **`_domcheck.py`** —— `$("id").属性` 直接取值（元素缺失会抛 TypeError 连坐整页）、同层重复函数声明（后者静默覆盖前者）、关键元素齐备。
- **`_buildpkg.js` / `_verify.mjs`** —— 打包前四道闸门 + 包结构、`checksums.json` 精确覆盖、sha256 全匹配、关键代码标记。

> **只测后端测不出桥接 bug，只测桥接测不出「界面根本没启动」。四层都要跑。**
> jsdom 需装在隔离工作区，用 `DBX_NODE_WS` 指向其 `node_modules`。

---

## Sidecar RPC

| 方法 | 说明 |
| --- | --- |
| `plugin/initialize` | 由 SDK 处理，完成协议版本与身份校验 |
| `connection/test` | 校验存储目录可写，返回将写入的路径 |
| `connection/connect` / `disconnect` | 连接生命周期；`connect` 会从连接配置里吸收 `storage_dir` |
| `notes/ping` | 前端握手探测；报的版本**运行时读包内 manifest**（不用编译期常量，避免发版漂移） |
| `notes/probe` | 非破坏性可写性探测（只写 `.mdnotes/.write-probe`） |
| `notes/load` | 返回 `{data, path, dir, pending}`。**`data` 是外壳，笔记在 `data.nodes`**；正文读不到时该节点带 `contentMissing:true` 且**不含** `content` |
| `notes/save` | 写正文（未变则按 SHA-256 跳过）+ 原子替换索引。**只删 `deletedIds` 显式点名的节点**，其余不在快照里的节点原样保留；删除进回收站 |
| `notes/exportNote` | 导出单篇。默认返回 `{fileName, dataBase64}`（交宿主「另存为」）；`toDisk:true` 才写进存储目录 |
| `notes/backup` | 备份为 zip（正文 + `mdnotes-backup.json` + `.mdnotes/meta.json`）。默认返回字节 |
| `notes/restore` | 从备份 zip 恢复（`dryRun` 只回报）。拒绝路径穿越与非本插件备份；恢复前自动存 `pre-restore-*.zip` 快照 |
| `notes/setDir` / `notes/path` | 手动指定 / 查询存储目录 |
| `filesystem/list\|read\|write\|createDirectory\|delete\|rename` | 把笔记树投影成 `mdnotes://` 虚拟文件系统 |
| `contextMenu/com.lwai.mdnotes.newNoteForTable` | 记录表上下文到 `pending`，供「为表新建笔记」取用 |

> 侧车会**递归扫描**入参里的 `storage_dir / storageDir / storage_path / notes_dir …`，
> 不依赖宿主把配置塞在某个固定字段路径上。

---

## 排障

状态栏 → 点开「存储状态」，按下列几行定位：

| 现象 | 原因与处理 |
| --- | --- |
| 侧车进程：**未提供 invoke 桥接** | 前端没运行在 DBX 宿主里（例如直接用浏览器打开 `ui/index.html`）。属预期行为。 |
| 侧车进程：**Method not found: notes/ping** | `invoke` 通了但侧车没认出来 → 多为 `manifest.json` 的 `entrypoints.backend.executable` 与实际二进制名不一致，或 `dbx-plugin.toml` 缺 `[backend]` 导致后端从未被编译。 |
| 实际落盘目录：**（未读到）** | 宿主没把连接配置传进前端上下文。侧车仍会在 `connection/connect` 时自行吸收目录，**不影响保存**，只是 UI 显示不出来。 |
| 保存失败 + 权限类错误 | 存储目录不可写/不存在。换一个当前用户有权写入的目录。 |
| 笔记显示为**只读并提示「正文文件读不到」** | 该 `.md` 被外部改名/移动/占用。恢复文件本身即可；插件不会用空内容覆盖它。 |
| 想找回删掉的笔记 | 看 `<存储目录>/.mdnotes/trash/<时间戳>/`。 |
| Go 报 `package encoding/json is not in std` | `GOROOT` 指向了旧的 Go 目录。清掉 `GOROOT` 或指向当前安装。 |

---

## 已知边界

- UI 完全运行在沙箱里，**没有磁盘与网络权限**：所有落盘都经侧车，导出/备份必须借宿主的原生「另存为」。
- 连接参数（含 `storage_dir`）有 **2 MiB 上限**；从备份恢复时超过约 1.5 MB 的 zip 会被拒绝并提示手动解压。
- 同一目录被多个连接同时编辑时采用**后写覆盖**（last-write-wins），不做实时合并。
