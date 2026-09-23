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
| **AI 助手** | **右侧常驻栏**（不是弹窗），可接入任意第三方模型（OpenAI 兼容 / Anthropic / Ollama）做**分析、润色、续写、问答**；结果可插入/替换/追加/复制，且**可在栏内直接改模型配置**（见 [AI 助手](#ai-助手)） |
| 可调栏宽 | 目录区 / 笔记区 / AI 区之间可**拖动分隔条**调宽，双击复位；宽度记在本机（见 [AI 助手](#ai-助手)） |
| 删除安全 | 删除进回收站而非销毁；多连接共用同一目录互不覆盖（见[数据安全](#数据安全)） |
| 文件系统 | 把笔记投影成 `mdnotes://` 虚拟文件系统，交给 DBX 通用文件管理器浏览/编辑 |
| 主题 | 跟随宿主明暗主题 |

**快捷键**：`Ctrl/Cmd+S` 保存 · `Ctrl/Cmd+N` 新建笔记 · `Ctrl/Cmd+I` 开合 AI 助手栏 · （AI 栏聚焦时）`Ctrl/Cmd+Enter` 执行当前任务 · `/` 聚焦搜索 · `Esc` 关闭弹窗。

---

## AI 助手

AI 助手是**右侧一栏常驻面板**（不是弹窗）：展开后左侧照常编辑笔记，右侧累积对话记录，
每条结果都留着，随时可以再插入/替换/复制。模型调用**全部由插件后端（Go 侧车）发起**，
请求与密钥不经过插件前端，也不写入笔记目录。

### 配置（两种方式，改哪儿都行）

**方式一：在连接里配（初始值）** —— 编辑「MD 笔记」连接 → 勾选 **启用 AI 功能** → 填写：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| AI 服务提供方 | `OpenAI 兼容` | 绝大多数国产模型与自建网关都兼容 OpenAI 协议 |
| API 地址 | `https://api.deepseek.com/v1` | 服务根地址，不含 `/chat/completions`；Ollama 用 `http://127.0.0.1:11434/v1` |
| 模型名称 | `deepseek-chat` | 按服务方文档填，如 `gpt-4o-mini`、`qwen2.5:7b` |
| API 密钥 | `sk-…` | 存在 DBX 的密钥存储里，**只发给插件后端**；Ollama 本地模型可留空 |
| 自定义人设 / 超时 / 上限 | — | 均可选：默认人设、60 秒超时、单次送入 12000 字符 |

填完点 **「测试 AI 连接」**：它会用当前表单里的参数（**不必先保存**）发一次最小请求，直接在表单里回显
「连接成功：deepseek-chat（openai）· 耗时 812 ms」或「鉴权失败（HTTP 401）：API 密钥无效」。

**方式二：在 AI 栏里改（更快，不用回去改连接）** —— 点 AI 栏右上角的 **⚙** 展开配置区，
改完点「保存」即长期有效，点「测试连接」可以先试再存。三层优先级：

```
AI 栏里保存的（本机）  >  连接里的配置  >  内置默认值
```

所以：**只用连接配的人什么都不用管**；在栏里改过的人会被标出「本机配置已覆盖连接配置」，
点 **「清除本机配置」** 就能一键回到「以连接配置为准」。

> **密钥怎么存**：本机配置写在插件私有数据目录 `ai-config.json`（不在笔记目录里）。
> 密钥**默认只在本次会话有效**；只有勾选 **「在本机记住密钥」** 后才会写进该文件（Unix 上权限 `0600`）。
> 共享电脑上不建议勾选 —— 更好的做法是把密钥留在连接里（走 DBX 的密钥存储）。

### 使用

- 入口：工具栏 **「AI 助手」**（或 `Ctrl/Cmd+I`），以及笔记右键菜单里的 `AI 分析 / AI 润色 / AI 续写 / 问 AI`。
- 四个任务：**分析**（要点/待办/矛盾）、**润色**（保持原意与 Markdown 结构）、**续写**（末尾接着写）、**提问**（针对当前笔记答疑）。
- **处理范围**：编辑器里**选中的文本优先**，没有选中则用当前笔记全文。不会自动发送整个笔记库。
- 结果操作（每条结果各有一组）：
  - `插入到光标` —— 光标处插入，**不删除任何已有正文**（若有选区，会先确认，因为那等价于替换）
  - `替换选中` —— **先弹确认框**（显示范围、行数变化与被替换内容预览）
  - `追加到末尾`
  - `复制`
- 结果来自另一篇笔记时，写入前会再确认一次；写回后立即落盘。
- 超过「单次送入上限」会自动截断，结果上会如实标注「已截断至 N 字」，不会假装处理了全文。
- 面板宽度、开合状态记在插件数据目录（`prefs.json`），**双击分隔条**复位默认宽度。

### 隐私与安全

- **密钥不出后端**：走宿主给后端的生命周期通道下发（或本机配置），插件前端拿不到；不进日志，错误信息里会被脱敏成 `***`。
- **默认最小范围**：只发送选中内容或当前笔记；发送前你可以先在编辑器里选中要处理的段落。
- **出网说明**：请求由插件后端直接发往你填的 API 地址（所以不依赖 `host.network` 权限，也不受沙箱 CORS 限制）。
  请只填写你信任的服务地址 —— 笔记正文会离开本机。
- 断网 / 超时 / 鉴权失败都会给出可读中文提示，并记录在存储诊断日志里。

### 为什么不接 DBX 内置 AI

宿主提供 `host.ai` 权限（`dbxPlugin.ai.openConversation`），但它**只负责开一个带数据快照的对话，
不返回模型回复、不暴露模型配置** —— 做不了「AI 结果写回笔记」这件核心事。
而权限声明是**静态**的，声明 `host.ai` 会把最低宿主抬到 0.6.20、并让更早的版本在**安装阶段直接拒绝整个包**。
为一个用不上的入口把所有老用户挡在门外不值，所以本插件**刻意不依赖它**（打包脚本有闸门防止日后被加回来）。

---

## 安装（使用 .dbxp）

> 需要 **DBX ≥ 0.5.68**。插件只声明 `host.filesystem` 一个权限，AI 全部走自配模型/侧车直连，
> 不依赖新宿主的 `host.ai` —— 所以老宿主也能装、能升级。

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
（`bin/<target>/dbx-plugin-mdnotes[.exe]`，**只有 windows 目标带 `.exe`**）、生成**精确覆盖每个文件**的 `checksums.json`、
跳过 `_` 前缀文件，并给包内条目写上 **Unix 权限位**。

> **为什么必须写权限位**：宿主安装器在 macOS/Linux 上会按 zip 条目的 unix mode 调 `set_permissions`；
> 而 zip 读取库在 `external_attributes == 0`（或「制作系统」不是 Unix）时**返回 None**，宿主就会跳过设权限 ——
> 解出来的侧车是 `0644`、**没有可执行位，根本起不来**。官方打包器给 `bin/<target>/` 下的文件 `0755`、其余 `0644`，
> 本仓库的打包脚本照做，`_verify.mjs` 也加了对应断言。

> 也可以走官方 CLI（`npm install -g @dbx-app/plugin-cli` 后 `dbx-plugin dev` / `dbx-plugin package`），
> 其行为等价。注意 `dbx-plugin.toml` 的 `[package].include` **不要**包含 `bin/` —— 二进制由打包器注入。

### 一次产出全部平台（含 `release-candidates.json`）

官方 CLI **只按当前宿主平台打包**，显式指定别的 `--target` 会被拒绝
（`Native plugin target 'X' does not match build host 'Y'; run this package command on the target platform`）；
官方文档给的多平台做法是在 CI 上开平台矩阵、各自构建，再合并出 `release-candidates.json`。

本插件的侧车是**纯 Go、无 cgo**，可以直接交叉编译，因此本地一条命令就能出全套：

```bash
node _release.mjs                       # 默认 windows-x64 + darwin-arm64 + linux-x64
node _release.mjs windows-x64 linux-x64 # 也可以只做指定平台
```

它依次做四件事：交叉编译侧车（`CGO_ENABLED=0 GOOS/GOARCH=...`，产物落在 `_xbuild/`）→ 逐平台打包
→ 逐包校验（`_verify.mjs`）→ 汇总出：

```
dist/<id>-<version>-<target>.dbxp            未签名候选包（上传到 Release / CDN / 对象存储）
dist/<id>-<version>-<target>.artifact.json   该包的 target / url / sha256 / size
dist/release-candidates.json                 plugin 元信息 + 全部平台 artifacts（dbx-store 同步用）
```

> **`release-candidates.json` 里的 `sha256` 绑定确切字节**：改完代码重新构建后必须重新生成它，
> 并上传**同一批** `.dbxp`。官方发布后的资产不允许覆盖，任何字节变化都要递增版本号重新走审核。

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
├── dist/                  # 打包产物 *.dbxp / *.artifact.json / release-candidates.json（不进版本控制）
├── _xbuild/               # 交叉编译出的 darwin/linux 侧车（不进版本控制）
└── _*.{js,mjs,py}         # 验证与发布工具链（`_` 前缀，不进包）
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
"$NODE" _buildpkg.js && "$NODE" _verify.mjs   # 4) 打包（内建自检）+ 产物结构 / sha256 / 权限位校验
```

要一次出全平台候选包与 `release-candidates.json`，直接跑 `_release.mjs`（它内部会调用上面第 4 步）。

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
| `ai/config` | 当前生效的 AI 配置与来源（**不含密钥**，只有 `hasKey` / `keyFrom` / `overridden` / `missing`） |
| `ai/setConfig` | 由 AI 栏更新配置（`persist:false` 只改内存）。密钥默认不落盘，勾选「记住密钥」才写 `ai-config.json` |
| `ai/resetConfig` | 清除本机（AI 栏）保存的配置，回到「以连接配置为准」 |
| `ai/test` | 用给定参数（或当前配置）发一次最小请求，**不修改生效配置** |
| `ai/chat` | `{task, text, instruction}` → `{content, model, usage, truncated, sentChars, latencyMs}`；由侧车直连模型 |
| `ui/getPrefs` / `ui/setPrefs` | 界面偏好（面板宽度、AI 栏开合），存 `<插件数据目录>/prefs.json`；键白名单 + 数值钳制 |
| `connection/action` | 连接表单自定义动作。目前只有 `test-ai`（用**未保存的表单值**发一次最小请求） |
| `filesystem/list\|read\|write\|createDirectory\|delete\|rename` | 把笔记树投影成 `mdnotes://` 虚拟文件系统 |
| `contextMenu/com.lwai.mdnotes.newNoteForTable` | 记录表上下文到 `pending`，供「为表新建笔记」取用 |

> 侧车会**递归扫描**入参里的 `storage_dir / storageDir / storage_path / notes_dir …`，
> 不依赖宿主把配置塞在某个固定字段路径上。

**AI 配置的两层与取值顺序**（`backend/ai.go`）：

```
aiConn  ← connection/connect|action 带来的 ai_* 与 connection_secrets.ai_api_key（易失，每次 connect 前清空）
aiLocal ← AI 栏「保存」写入（持久化到 <插件数据目录>/ai-config.json）
生效值 = 默认值 → aiConn 逐字段覆盖 → aiLocal 逐字段覆盖非空值
```

`ui/setPrefs` 会被调用两次（读盘后归一化一次、合并写入前再一次），所以数值解析必须同时认
`float64`（JSON 解出）与 `int`（已归一化）—— 只认 `float64` 会把第二次的键当坏值丢掉，静默丢配置。

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
| **AI 尚未配置完整（还缺：…）** | AI 栏顶部会直接列出缺哪几项，点 ⚙ 展开配置区填写；也可回到连接设置里填。 |
| **鉴权失败（HTTP 401）** | 密钥错误或没有该模型的权限。用配置区的「测试连接」直接复验（不必先保存）。 |
| **找不到接口（HTTP 404）** | API 地址通常要带版本路径，如 `https://api.deepseek.com/v1`（插件会自动补 `/chat/completions`）。 |
| **AI 请求超时** | 慢模型把「单次超时」调到 120–300 秒。 |
| **改了连接里的 AI 配置但没生效** | AI 栏里保存过本机配置（它优先于连接）。点配置区的「清除本机配置」即可回到连接配置。 |
| **AI 栏拖不宽 / 拖了没反应** | 每栏有最小宽度（目录 180px、AI 280px）与上限 720px；双击分隔条复位。 |
| 想找回删掉的笔记 | 看 `<存储目录>/.mdnotes/trash/<时间戳>/`。 |
| Go 报 `package encoding/json is not in std` | `GOROOT` 指向了旧的 Go 目录。清掉 `GOROOT` 或指向当前安装。 |

---

## 已知边界

- **要求 DBX ≥ 0.5.68**。插件只声明 `host.filesystem`；**刻意不依赖** `host.ai`（理由见
  [为什么不接 DBX 内置 AI](#为什么不接-dbx-内置-ai)），所以升级插件不需要先升级 DBX。
- UI 完全运行在沙箱里，**没有磁盘与网络权限**：所有落盘都经侧车，导出/备份必须借宿主的原生「另存为」。
- AI 请求由**侧车**发出（不走前端），因此不需要 `host.network` 权限，也不受沙箱 CORS 限制。
- 连接参数（含 `storage_dir`）有 **2 MiB 上限**；从备份恢复时超过约 1.5 MB 的 zip 会被拒绝并提示手动解压。
- 同一目录被多个连接同时编辑时采用**后写覆盖**（last-write-wins），不做实时合并。
- **AI 栏的对话是单轮的**：每次任务只发送「选中内容 / 当前笔记 + 你的额外要求」，不把上一轮回复回灌给模型。
- **面板宽度与开合状态是本机偏好**（`prefs.json`），多个连接共用；不同机器的宽度互不影响。
- 多个连接共用同一存储目录时，**AI 配置按连接各自独立**（连接密钥只在各自侧车进程的内存里）；
  在 AI 栏里保存的「本机配置」则是**全机共用**的。
