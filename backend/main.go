// DBX MD 笔记 —— 原生侧车（Go，纯标准库 + 官方 Go SDK）
//
// 存储模型（v2 起）：
//   - 每条笔记 = 存储目录下的真实 .md 文件（按「文件夹层级/标题.md」落盘）
//   - 每个文件夹 = 存储目录下的真实子目录
//   - 结构/索引 = 存储目录下的 .mdnotes/meta.json（仅 id/名称/父子关系/路径/时间戳 + UI 状态，不含正文）
//
// 为什么这样拆：
//   - 单一 notes.json 在数据量大时读写/损坏风险高；拆成真实文件后每条笔记独立、可在外部编辑器直接打开、可被 grep。
//   - notes/save 只重写「内容有变化」的笔记文件（内容哈希缓存），其余保持不动，写入放大可控。
//
// 持久化通道：插件 UI 跑在 sandboxed iframe 中，唯一可靠的落盘通道是
// dbxPlugin.invoke(...) → 本进程写磁盘。前端不碰磁盘。
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

// 必须与 manifest.json 的 id / version 完全一致，否则宿主判定 Sidecar 身份不匹配并丢弃。
const (
	pluginID      = "com.lwai.mdnotes"
	pluginVersion = "0.7.1" // 仅作兜底；运行时以包内 manifest.json 的版本为准（见 resolveMetadata）
)

type plugin struct {
	mutex       sync.Mutex
	connections map[string]struct{}
}

type RPCError = dbxpluginsdk.PluginError

func badParams(format string, args ...any) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(-32602, fmt.Sprintf(format, args...))
}

func failed(code int, err error) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(code, err.Error())
}

// ---------------- 请求分发 ----------------

func (plugin *plugin) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	_ *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	if method != "notes/save" {
		absorbParams(params)
	}

	var values map[string]any
	if len(params) > 0 {
		if err := json.Unmarshal(params, &values); err != nil {
			return nil, badParams("Invalid request parameters")
		}
	} else {
		values = map[string]any{}
	}

	switch method {
	case "connection/test":
		where := notesDir()
		if err := os.MkdirAll(where, 0o755); err != nil {
			return map[string]any{"success": false, "message": "无法写入笔记存储目录：" + err.Error()}, nil
		}
		return map[string]any{
			"success": true,
			"message": "MD 笔记已就绪，笔记将保存为存储目录下的真实 .md 文件与子文件夹。",
		}, nil

	case "connection/connect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		plugin.connections[connectionID] = struct{}{}
		plugin.mutex.Unlock()
		// absorbParams（Handle 入口已调用）会递归扫描 storage_dir；这里再补一刀，
		// 覆盖 config 以字符串形态传入的场景。
		if d := connDirFromValues(values); d != "" {
			setDir(d)
		}
		_ = os.MkdirAll(notesDir(), 0o755)
		_ = os.MkdirAll(metaDir(), 0o755)
		sidecarTrace(fmt.Sprintf("connection/connect id=%s configured=%v dir=%s",
			connectionID, dirConfigured(), notesDir()))
		// 首次连接：把重构前的 notes.json 迁移成真实 .md 文件，避免老笔记"消失"。
		tryMigrate()
		return map[string]any{
			"success":     true,
			"storagePath": notesDir(),
			"configured":  dirConfigured(),
		}, nil

	case "connection/disconnect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		delete(plugin.connections, connectionID)
		plugin.mutex.Unlock()
		return map[string]any{"success": true}, nil

	case "notes/ping":
		// 版本必须报 resolveMetadata()（运行时读包内 manifest）而不是编译期常量 ——
		// 常量会在发版时漂移，而 ping 的版本是前端和测试用来判断"跑的是不是新代码"的依据。
		return map[string]any{
			"ok": true, "plugin": pluginID, "version": resolveMetadata().Version,
			"storagePath": notesDir(),
			"configured":  dirConfigured(),
		}, nil

	case "notes/path":
		return map[string]any{"path": metaPath(), "dir": notesDir(), "configured": dirConfigured()}, nil

	case "notes/probe":
		// 轻量可写性探测：只往 .mdnotes/ 写一个探针文件，不碰索引、不碰正文。
		// 前端启动时用它替代「保存一次完整快照」——后者会把该实例的旧快照推成权威状态，
		// 在多实例共用同一目录时就是数据被回滚/删除的触发点。
		if err := os.MkdirAll(metaDir(), 0o755); err != nil {
			return map[string]any{"ok": false, "dir": notesDir(), "error": err.Error()}, nil
		}
		probe := filepath.Join(metaDir(), ".write-probe")
		if err := os.WriteFile(probe, []byte(time.Now().Format(time.RFC3339)), 0o644); err != nil {
			return map[string]any{"ok": false, "dir": notesDir(), "error": err.Error()}, nil
		}
		return map[string]any{"ok": true, "dir": notesDir(), "configured": dirConfigured()}, nil

	case "notes/setDir":
		var p struct {
			Dir        string `json:"dir"`
			StorageDir string `json:"storage_dir"`
			Connection struct {
				ID string `json:"id"`
			} `json:"connection"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		dir := firstNonEmpty(p.Dir, p.StorageDir)
		if strings.TrimSpace(dir) == "" {
			return nil, badParams("dir is empty")
		}
		setDir(dir)
		_ = os.MkdirAll(notesDir(), 0o755)
		_ = os.MkdirAll(metaDir(), 0o755)
		return map[string]any{"ok": true, "path": metaPath(), "dir": notesDir()}, nil

	case "notes/load":
		return notesLoad()

	case "notes/save":
		var p struct {
			Data       json.RawMessage `json:"data"`
			StorageDir string          `json:"storage_dir"`
			Dir        string          `json:"dir"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		if dir := firstNonEmpty(p.StorageDir, p.Dir); dir != "" {
			setDir(dir)
		}
		if len(p.Data) == 0 {
			return nil, badParams("missing data")
		}
		if err := saveNotes(p.Data); err != nil {
			sidecarTrace(fmt.Sprintf("notes/save FAILED dir=%s bytes=%d err=%v", notesDir(), len(p.Data), err))
			return nil, failed(-32002, fmt.Errorf("save failed: %w", err))
		}
		sidecarTrace(fmt.Sprintf("notes/save ok dir=%s bytes=%d", notesDir(), len(p.Data)))
		return map[string]any{"ok": true, "path": metaPath(), "dir": notesDir()}, nil

	case "notes/exportNote":
		var p struct {
			ID string `json:"id"`
			// ToDisk=false（默认）：把字节交回前端，由宿主原生「另存为」对话框落盘，
			// 用户可自选目录。ToDisk=true：老行为，直接写进笔记存储目录（宿主没有
			// saveFile 能力时的兜底）。
			ToDisk bool `json:"toDisk"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return exportNote(p.ID, p.ToDisk)

	case "notes/backup":
		var p struct {
			Scope  string `json:"scope"`
			ToDisk bool   `json:"toDisk"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return backupNotes(p.Scope, p.ToDisk)

	case "notes/restore":
		var p struct {
			DataBase64 string `json:"dataBase64"`
			DryRun     bool   `json:"dryRun"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return restoreNotes(p.DataBase64, p.DryRun)

	case "filesystem/list":
		return callFs(fsList, params)
	case "filesystem/read":
		return callFs(fsRead, params)
	case "filesystem/write":
		return callFs(fsWrite, params)
	case "filesystem/createDirectory":
		return callFs(fsCreateDirectory, params)
	case "filesystem/delete":
		return callFs(fsDelete, params)
	case "filesystem/rename":
		return callFs(fsRename, params)

	case "contextMenu/com.lwai.mdnotes.newNoteForTable":
		return handleNewNoteForTable(params)

	default:
		return nil, dbxpluginsdk.MethodNotFound(method)
	}
}

type fsMethod func(json.RawMessage) (any, error)

func callFs(fn fsMethod, params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	res, err := fn(params)
	if err != nil {
		return nil, failed(-32003, err)
	}
	return res, nil
}

func requestConnectionID(values map[string]any) (string, *dbxpluginsdk.PluginError) {
	connection, _ := values["connection"].(map[string]any)
	if connectionID, _ := connection["id"].(string); connectionID != "" {
		return connectionID, nil
	}
	if connectionID, _ := values["connectionId"].(string); connectionID != "" {
		return connectionID, nil
	}
	return "", badParams("Missing connection id")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ---------------- 存储目录 ----------------

var dirMu sync.Mutex
var currentDir string

var dirKeys = map[string]bool{
	"storage_dir":  true,
	"storageDir":   true,
	"storage_path": true,
	"storagePath":  true,
	"notes_dir":    true,
	"notesDir":     true,
	"notesdir":     true,
	"notes_dirs":   true,
}

func dataDir() string {
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_DATA_DIR")); d != "" {
		return d
	}
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_SPACE")); d != "" {
		return d
	}
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		return filepath.Join(base, "dbx", "plugins", pluginID)
	}
	return filepath.Join(".", "data")
}

func metaDir() string  { return filepath.Join(notesDir(), ".mdnotes") }
func metaPath() string { return filepath.Join(metaDir(), "meta.json") }

// sidecarTrace 追加一行诊断记录到 <dataDir>/sidecar-trace.log（best-effort，永不阻断业务）。
//
// 为什么需要它：侧车是否被宿主真正拉起、是否收到过 storage_dir、有没有走到 notes/save，
// 只有侧车自己知道。出问题时这行日志能一句话定位环节，避免再从 UI 侧盲猜。
// 超过 64KB 时整体清空，防止无限增长。
func sidecarTrace(msg string) {
	path := filepath.Join(dataDir(), "sidecar-trace.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 64*1024 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = fmt.Fprintf(f, "%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
}

func loadConfig() {
	b, err := os.ReadFile(filepath.Join(dataDir(), "config.json"))
	if err != nil {
		return
	}
	var c map[string]any
	if json.Unmarshal(b, &c) != nil {
		return
	}
	if v, ok := c["storage_dir"].(string); ok && strings.TrimSpace(v) != "" {
		currentDir = strings.TrimSpace(v)
	}
}

func setDir(d string) {
	d = strings.TrimSpace(d)
	if d == "" {
		return
	}
	dirMu.Lock()
	same := currentDir == d
	currentDir = d
	dirMu.Unlock()
	if same {
		return
	}
	if err := os.MkdirAll(dataDir(), 0o755); err == nil {
		if b, e := json.Marshal(map[string]any{"storage_dir": d}); e == nil {
			_ = os.WriteFile(filepath.Join(dataDir(), "config.json"), b, 0o644)
		}
	}
}

func absorbDir(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if dirKeys[k] {
				if s, ok := val.(string); ok && strings.TrimSpace(s) != "" {
					setDir(s)
				}
			}
		}
		for _, val := range t {
			absorbDir(val)
		}
	case []any:
		for _, item := range t {
			absorbDir(item)
		}
	}
}

func absorbParams(raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return
	}
	absorbDir(v)
}

func notesDir() string {
	dirMu.Lock()
	d := currentDir
	dirMu.Unlock()
	if strings.TrimSpace(d) == "" {
		return dataDir()
	}
	return d
}

// dirConfigured 报告是否真有用户指定的存储目录（而非回退到隐藏的默认 dataDir）。
// 前端据此判断是否要弹出「未配置存储目录」的醒目告警。
func dirConfigured() bool {
	dirMu.Lock()
	d := currentDir
	dirMu.Unlock()
	return strings.TrimSpace(d) != ""
}

// connDirFromValues 从 connection/connect 的参数里尽可能稳健地取出 storage_dir。
// 覆盖：顶层 storage_dir、config/external_config/connection 嵌套对象，以及 config 以
// 字符串形式传入（"storage_dir=..." 或 JSON 串）的情况。absorbParams 已做递归扫描，
// 这里作为补充，避免宿主以非预期形态传递时静默丢失目录。
func connDirFromValues(values map[string]any) string {
	cands := []any{
		values["storage_dir"], values["storageDir"],
		values["config"], values["external_config"], values["connection"],
	}
	for _, c := range cands {
		if c == nil {
			continue
		}
		switch t := c.(type) {
		case string:
			s := strings.TrimSpace(t)
			if s != "" && !strings.ContainsAny(s, "={}:") {
				return s
			}
			// 形如 "storage_dir=D:\notes&name=..."
			if i := strings.Index(t, "storage_dir="); i >= 0 {
				rest := t[i+len("storage_dir="):]
				if e := strings.IndexAny(rest, "&\""); e >= 0 {
					rest = rest[:e]
				}
				if v := strings.TrimSpace(rest); v != "" {
					return v
				}
			}
		case map[string]any:
			for _, k := range []string{"storage_dir", "storageDir", "storage_path", "storagePath", "notes_dir", "notesDir"} {
				if v, ok := t[k].(string); ok && strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			}
		}
	}
	return ""
}

// tryMigrate 把重构前的 notes.json（单一文件，存的就是前端快照）迁移成新的
// 「真实 .md 文件 + .mdnotes/meta.json」模型。仅当 meta.json 还不存在时触发，
// 避免重复迁移；任何解析/写入错误都跳过，绝不因此阻断正常启动。
func tryMigrate() {
	if metaExists() {
		return
	}
	seen := map[string]bool{}
	for _, base := range []string{dataDir(), notesDir()} {
		old := filepath.Join(base, "notes.json")
		if seen[old] {
			continue
		}
		seen[old] = true
		b, err := os.ReadFile(old)
		if err != nil {
			continue
		}
		var s snap
		if json.Unmarshal(b, &s) != nil || len(s.Nodes) == 0 {
			continue
		}
		if err := saveNotes(b); err != nil {
			continue
		}
		_ = os.Rename(old, old+".migrated")
		return
	}
}

// ---------------- 元数据结构 ----------------

type MetaNode struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"` // "folder" | "note"
	Name      string  `json:"name"`
	ParentID  *string `json:"parentId"`
	CreatedAt string  `json:"createdAt,omitempty"`
	UpdatedAt string  `json:"updatedAt,omitempty"`
	File      string  `json:"file"` // 相对存储目录的路径：笔记 "x.md"，文件夹 "x"
}

type Meta struct {
	Version  int             `json:"version"`
	Nodes    []MetaNode      `json:"nodes"`
	ActiveID string          `json:"activeId,omitempty"`
	Expanded map[string]bool `json:"expanded,omitempty"`
	View     string          `json:"view,omitempty"`
}

func loadMeta() Meta {
	b, err := os.ReadFile(metaPath())
	if err != nil {
		return Meta{Version: 2, Nodes: []MetaNode{}}
	}
	var m Meta
	if json.Unmarshal(b, &m) != nil {
		return Meta{Version: 2, Nodes: []MetaNode{}}
	}
	if m.Nodes == nil {
		m.Nodes = []MetaNode{}
	}
	return m
}

func metaExists() bool {
	_, err := os.Stat(metaPath())
	return err == nil
}

func saveMeta(m Meta) error {
	if m.Version == 0 {
		m.Version = 2
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(metaPath(), b)
}

// ---------------- 文件名工具 ----------------

func sanitizeName(name string) string {
	s := strings.TrimSpace(name)
	if s == "" {
		s = "untitled"
	}
	repl := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_",
		"\"", "_", "<", "_", ">", "_", "|", "_")
	s = repl.Replace(s)
	s = strings.Trim(s, ". ")
	if s == "" {
		s = "untitled"
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// absUnique 返回 abs 不存在时的原值；若存在则追加 " (2)" 等后缀。
func absUnique(abs string) string {
	if _, err := os.Stat(abs); os.IsNotExist(err) {
		return abs
	}
	ext := filepath.Ext(abs)
	base := abs[:len(abs)-len(ext)]
	for i := 2; ; i++ {
		cand := base + " (" + strconv.Itoa(i) + ")" + ext
		if _, err := os.Stat(cand); os.IsNotExist(err) {
			return cand
		}
	}
}

func toRel(root, abs string) string {
	r, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.Base(abs)
	}
	return r
}

// ---------------- 内容哈希缓存（避免重复写盘） ----------------

var hashMu sync.Mutex

// contentHashes 的 key 是【文件的绝对路径】，不是节点 id。
//
// 用 id 做 key 会漏掉一个真实场景：用户把「笔记存储目录」改到新目录之后，同一个 id 的笔记在
// 新目录里根本还不存在，但缓存仍记着「这个 id 的内容没变」→ 保存时整个跳过写盘 → 笔记在新目录
// 里凭空消失。按路径做 key 才符合「同一个文件、内容没变」这句话的真实语义。
var contentHashes = map[string]string{}

func contentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", h)
}

// isUnchanged 返回 true 表示 abs 处的文件内容与 content 一致（无需重写）。
func isUnchanged(abs, hs string) bool {
	hashMu.Lock()
	if c, ok := contentHashes[abs]; ok && c == hs {
		hashMu.Unlock()
		return true
	}
	hashMu.Unlock()
	if data, err := os.ReadFile(abs); err == nil {
		if contentHash(string(data)) == hs {
			hashMu.Lock()
			contentHashes[abs] = hs
			hashMu.Unlock()
			return true
		}
	}
	return false
}

func writeContent(abs, content string) error {
	if err := writeAtomic(abs, []byte(content)); err != nil {
		return err
	}
	hashMu.Lock()
	contentHashes[abs] = contentHash(content)
	hashMu.Unlock()
	return nil
}

// ---------------- 笔记快照（前端传入） ----------------

type snapNode struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Name     string  `json:"name"`
	ParentID *string `json:"parentId"`
	// Content 用指针：nil = 「这次没带正文」，后端绝不写盘。
	//
	// 为什么不用 string：string 的零值是空串，与「用户真的把正文清空了」无法区分。
	// 一旦前端因为某个文件读不到而拿不到正文，快照里就会是一个空串，
	// 保存时把磁盘上的正文覆盖成空 —— 这就是「笔记内容被清空」的机制。
	// 用指针后，「省略字段」本身就能表达"别动它"，不需要额外标志位配合。
	Content   *string `json:"content"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type snap struct {
	Version int        `json:"version"`
	Nodes   []snapNode `json:"nodes"`
	// DeletedIDs 是前端【显式】声明要删的节点 id（删除文件夹时含其全部子节点）。
	//
	// 绝不能把「不在 Nodes 里」当成删除：一个存储目录可能同时被多个连接/实例使用，
	// 旧实例手里的快照天然缺少对方刚建的笔记，而它一保存就会把那些笔记删掉
	// （2026-09-21 事故：重复用同一个目录建连接 → 一部分笔记被清空）。
	// 语义改成「未知 ≠ 要删」后，这种行为就不可能再发生。
	DeletedIDs []string        `json:"deletedIds"`
	ActiveID   string          `json:"activeId"`
	Expanded   map[string]bool `json:"expanded"`
	View       string          `json:"view"`
}

// computeRelPath 由父子链推导相对路径（文件名已 sanitize）。
func computeRelPath(n snapNode, byID map[string]snapNode) string {
	var segs []string
	pid := n.ParentID
	guard := 0
	for pid != nil && guard < 64 {
		p, ok := byID[*pid]
		if !ok {
			break
		}
		segs = append([]string{sanitizeName(p.Name)}, segs...)
		pid = p.ParentID
		guard++
	}
	name := sanitizeName(n.Name)
	if n.Type == "note" {
		return filepath.Join(append(segs, name+".md")...)
	}
	return filepath.Join(segs...)
}

// trashPath 给出「回收站」里的目标路径。
//
// 删除一律不硬删：先移到 <storage_dir>/.mdnotes/trash/<时间戳>/<原相对路径>。
// 这样任何一次误删（旧快照、并发实例、以后的逻辑 bug）都还能捞回来，
// 代价只是磁盘上多一份历史副本。
func trashPath(root, rel string) string {
	stamp := time.Now().Format("20060102-150405")
	return filepath.Join(root, ".mdnotes", "trash", stamp, rel)
}

func saveNotes(raw json.RawMessage) error {
	var s snap
	if err := json.Unmarshal(raw, &s); err != nil {
		return err
	}
	if s.Nodes == nil {
		s.Nodes = []snapNode{}
	}
	root := notesDir()
	if err := os.MkdirAll(metaDir(), 0o755); err != nil {
		return err
	}

	prev := loadMeta()
	prevByID := map[string]MetaNode{}
	for _, n := range prev.Nodes {
		prevByID[n.ID] = n
	}
	inByID := map[string]snapNode{}
	incomingSet := map[string]bool{}
	for _, n := range s.Nodes {
		inByID[n.ID] = n
		incomingSet[n.ID] = true
	}
	deletedSet := map[string]bool{}
	for _, id := range s.DeletedIDs {
		deletedSet[id] = true
	}

	// 1) 删除：只处理前端【显式】声明要删的 id，且一律移入回收站而非硬删。
	//
	// 这里以前是「凡是不在快照里的节点就删文件」，语义上等于把「我没见过」当成
	// 「用户要删」—— 一个存储目录被两个连接同时打开时，后打开的那个实例只要保存一次
	// （打开工作台就会保存），就会把对方新建的笔记从磁盘上删掉。
	// 现在：未知 ≠ 要删；真要删必须显式说。
	trashed := 0
	seenTrashDir := false
	for id := range deletedSet {
		old, ok := prevByID[id]
		if !ok || strings.TrimSpace(old.File) == "" {
			continue
		}
		abs := filepath.Join(root, old.File)
		if _, err := os.Stat(abs); err != nil {
			continue // 磁盘上本来就没有，不必处理
		}
		dst := trashPath(root, old.File)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			continue
		}
		if err := os.Rename(abs, dst); err != nil {
			// 移不动就【不删】：宁可留下一个孤儿文件，也不做不可逆的销毁。
			sidecarTrace(fmt.Sprintf("notes/save trash FAILED rel=%s err=%v（已保留原文件）", old.File, err))
			continue
		}
		trashed++
		seenTrashDir = true
	}
	if seenTrashDir {
		sidecarTrace(fmt.Sprintf("notes/save trashed=%d dir=%s", trashed, filepath.Join(root, ".mdnotes", "trash")))
	}

	// 2) 笔记：新建/移动文件 + 仅内容变化时写盘
	result := []MetaNode{}
	for _, n := range s.Nodes {
		if n.Type != "note" || deletedSet[n.ID] {
			continue
		}
		mn := MetaNode{ID: n.ID, Type: "note", Name: n.Name, ParentID: n.ParentID, CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt}
		rel := computeRelPath(n, inByID)
		absTarget := filepath.Join(root, rel)
		old, existed := prevByID[n.ID]
		if !existed {
			absTarget = absUnique(absTarget)
			_ = os.MkdirAll(filepath.Dir(absTarget), 0o755)
		} else if rel != old.File {
			absTarget = absUnique(filepath.Join(root, rel))
			_ = os.MkdirAll(filepath.Dir(absTarget), 0o755)
			_ = os.Rename(filepath.Join(root, old.File), absTarget)
		}
		mn.File = toRel(root, absTarget)
		// Content == nil：这次没带正文（前端没读到 / 不打算改）→ 绝不用空内容覆盖磁盘。
		if n.Content != nil {
			hs := contentHash(*n.Content)
			if !isUnchanged(absTarget, hs) {
				if err := writeContent(absTarget, *n.Content); err != nil {
					return err
				}
			}
		}
		result = append(result, mn)
	}

	// 3) 文件夹：新建/移动目录（子项已在第 2 步自行落到新位置，这里只需清理旧空目录）
	for _, n := range s.Nodes {
		if n.Type != "folder" || deletedSet[n.ID] {
			continue
		}
		mn := MetaNode{ID: n.ID, Type: "folder", Name: n.Name, ParentID: n.ParentID, CreatedAt: n.CreatedAt, UpdatedAt: n.UpdatedAt}
		rel := computeRelPath(n, inByID)
		old, existed := prevByID[n.ID]
		if !existed {
			_ = os.MkdirAll(filepath.Join(root, rel), 0o755)
			mn.File = rel
		} else if rel != old.File {
			_ = os.MkdirAll(filepath.Join(root, rel), 0o755)
			// os.Remove 只删空目录；若里面还留着被保留（未在快照里）的子节点就删不掉 —— 这正是我们要的。
			_ = os.Remove(filepath.Join(root, old.File))
			mn.File = rel
		} else {
			mn.File = old.File
		}
		result = append(result, mn)
	}

	// 4) 保留：既不在快照里、也没被显式删除的节点，原样留着。
	//    它们通常是「另一个连接/实例里刚建的」——本实例没见过，不等于用户想删。
	preserved := 0
	for _, old := range prev.Nodes {
		if incomingSet[old.ID] || deletedSet[old.ID] {
			continue
		}
		result = append(result, old)
		preserved++
	}

	if preserved > 0 {
		sidecarTrace(fmt.Sprintf("notes/save preserved=%d（快照里没带、但未声明删除，保持原样）", preserved))
	}

	newMeta := Meta{Version: s.Version, ActiveID: s.ActiveID, Expanded: s.Expanded, View: s.View, Nodes: result}
	return saveMeta(newMeta)
}

func notesLoad() (any, *dbxpluginsdk.PluginError) {
	tryMigrate()
	m := loadMeta()
	if len(m.Nodes) == 0 && !metaExists() {
		// 首次运行：还没有任何数据，让前端去放示例笔记
		return map[string]any{
			"data":   nil,
			"path":   metaPath(),
			"dir":    notesDir(),
			"ok":     true,
			"configured": dirConfigured(),
			"pending": takePending(),
		}, nil
	}
	nodes := []map[string]any{}
	for _, mn := range m.Nodes {
		node := map[string]any{
			"id":        mn.ID,
			"type":      mn.Type,
			"name":      mn.Name,
			"parentId":  mn.ParentID,
			"createdAt": mn.CreatedAt,
			"updatedAt": mn.UpdatedAt,
		}
		if mn.Type == "note" {
			if data, err := os.ReadFile(filepath.Join(notesDir(), mn.File)); err == nil {
				node["content"] = string(data)
			} else {
				// 读不到正文时【绝不能】回一个空串：前端会把空串当作"这篇笔记的正文"
				// 原样保存回去，磁盘上的正文就被清空了。这里明确标记 missing，
				// 前端据此既不显示为可编辑的空笔记、也不会把空内容写回。
				node["contentMissing"] = true
				sidecarTrace(fmt.Sprintf("notes/load 正文读不到（已冻结，不会写回）：rel=%s err=%v", mn.File, err))
			}
			node["file"] = mn.File
		}
		nodes = append(nodes, node)
	}
	return map[string]any{
		"data": map[string]any{
			"version":   m.Version,
			"nodes":     nodes,
			"activeId":  m.ActiveID,
			"expanded":  m.Expanded,
			"view":      m.View,
		},
		"path":   metaPath(),
		"dir":    notesDir(),
		"ok":     true,
		"configured": dirConfigured(),
		"pending": takePending(),
	}, nil
}

// ---------------- 导出 / 备份 ----------------

// exportNote 导出单篇笔记。
//
// toDisk=false（默认）：返回 {name, fileName, dataBase64}，前端交给宿主的原生「另存为」
// 对话框写盘 —— 这样用户能自己选目录和文件名，而不是被塞进笔记存储目录。
// toDisk=true：老行为，在笔记存储目录里生成一份 .md 副本来回显路径（兜底用）。
func exportNote(id string, toDisk bool) (any, *dbxpluginsdk.PluginError) {
	if id == "" {
		return nil, badParams("missing id")
	}
	m := loadMeta()
	var node *MetaNode
	for i := range m.Nodes {
		if m.Nodes[i].ID == id && m.Nodes[i].Type == "note" {
			node = &m.Nodes[i]
			break
		}
	}
	if node == nil {
		return nil, badParams("note not found: " + id)
	}
	root := notesDir()
	src := filepath.Join(root, node.File)
	data, err := os.ReadFile(src)
	if err != nil {
		return nil, failed(-32004, fmt.Errorf("read note: %w", err))
	}
	fileName := sanitizeName(node.Name) + ".md"

	if !toDisk {
		return map[string]any{
			"ok":         true,
			"name":       node.Name,
			"fileName":   fileName,
			"dataBase64": base64.StdEncoding.EncodeToString(data),
			"bytes":      len(data),
		}, nil
	}

	dst := absUnique(filepath.Join(root, fileName))
	if dst != src {
		if err := writeAtomic(dst, data); err != nil {
			return nil, failed(-32004, fmt.Errorf("export note: %w", err))
		}
	}
	return map[string]any{"ok": true, "path": dst, "name": node.Name, "fileName": fileName}, nil
}

func subtreeIDs(m Meta, rootID string) map[string]bool {
	inc := map[string]bool{rootID: true}
	changed := true
	round := 0
	for changed && round < 64 {
		changed = false
		round++
		for _, n := range m.Nodes {
			if n.ParentID != nil && inc[*n.ParentID] && !inc[n.ID] {
				inc[n.ID] = true
				changed = true
			}
		}
	}
	return inc
}

// ---------------- 备份包格式 ----------------
//
// 包内布局与磁盘布局 1:1，所以恢复就是一次朴素复制，不需要任何映射表：
//
//	mdnotes-backup.json    备份元信息（版本 / 导出时间 / 当时的存储目录 / 计数）
//	.mdnotes/meta.json     目录树索引（结构、名称、展开状态）
//	<真实 .md 相对路径>     正文，与 meta.json 的 file 字段逐字对应
//
// 只备份正文而不备份索引，恢复出来就是一堆没有名字和层级的孤儿文件 —— 所以索引必须随包走。
const backupInfoName = "mdnotes-backup.json"
const backupMetaEntry = ".mdnotes/meta.json"

// backupInfo 是随备份包一起走的「配置」，供恢复时确认这份包从哪来、能不能用。
type backupInfo struct {
	Schema     string `json:"schema"`
	PluginID   string `json:"pluginId"`
	Version    string `json:"version"`
	ExportedAt string `json:"exportedAt"`
	StorageDir string `json:"storageDir"`
	Scope      string `json:"scope,omitempty"`
	Notes      int    `json:"notes"`
	Folders    int    `json:"folders"`
	MetaFile   string `json:"metaFile"`
}

// buildBackupZip 在内存里构造备份包。notes 是要打包的笔记节点，scope 为空表示整库。
func buildBackupZip(root string, m Meta, notes []MetaNode, folders int, scope string) []byte {
	var sb strings.Builder
	zw := zip.NewWriter(&writerCapture{&sb})

	info := backupInfo{
		Schema:     "dbx-md-notes/backup@1",
		PluginID:   pluginID,
		Version:    resolveMetadata().Version,
		ExportedAt: time.Now().Format(time.RFC3339),
		StorageDir: root,
		Scope:      scope,
		Notes:      len(notes),
		Folders:    folders,
		MetaFile:   backupMetaEntry,
	}
	if b, e := json.MarshalIndent(info, "", "  "); e == nil {
		if w, e2 := zw.Create(backupInfoName); e2 == nil {
			_, _ = w.Write(b)
		}
	}
	if b, e := os.ReadFile(metaPath()); e == nil {
		if w, e2 := zw.Create(backupMetaEntry); e2 == nil {
			_, _ = w.Write(b)
		}
	}
	for _, n := range notes {
		data, err := os.ReadFile(filepath.Join(root, n.File))
		if err != nil {
			data = []byte("")
		}
		// zip 条目名一律用正斜杠（zip 规范），Windows 的 filepath.Join 会给出反斜杠。
		w, e := zw.Create(filepath.ToSlash(n.File))
		if e != nil {
			continue
		}
		_, _ = w.Write(data)
	}
	_ = zw.Close()
	return []byte(sb.String())
}

func backupFileName(m Meta, scope string) string {
	if scope != "" {
		for _, n := range m.Nodes {
			if n.ID == scope {
				return sanitizeName(n.Name) + ".zip"
			}
		}
	}
	now := time.Now()
	return fmt.Sprintf("md-notes-backup-%04d%02d%02d-%02d%02d.zip",
		now.Year(), now.Month(), now.Day(), now.Hour(), now.Minute())
}

// backupNotes 构造备份包。toDisk=false（默认）把字节交回前端，由宿主的原生「另存为」
// 对话框落盘（用户可自选目录）；toDisk=true 则写进笔记存储目录并回显路径（兜底）。
func backupNotes(scope string, toDisk bool) (any, *dbxpluginsdk.PluginError) {
	m := loadMeta()
	root := notesDir()

	var inc map[string]bool
	if scope != "" {
		inc = subtreeIDs(m, scope)
	}
	var notes []MetaNode
	folders := 0
	for _, n := range m.Nodes {
		if scope != "" && !inc[n.ID] {
			continue
		}
		if n.Type == "note" {
			notes = append(notes, n)
		} else {
			folders++
		}
	}
	if len(notes) == 0 && folders == 0 {
		return nil, failed(-32005, fmt.Errorf("nothing to backup"))
	}

	buf := buildBackupZip(root, m, notes, folders, scope)
	if len(buf) == 0 {
		return nil, failed(-32005, fmt.Errorf("nothing to backup"))
	}
	filename := backupFileName(m, scope)

	if toDisk {
		dst := absUnique(filepath.Join(root, filename))
		if err := writeAtomic(dst, buf); err != nil {
			return nil, failed(-32005, fmt.Errorf("write backup: %w", err))
		}
		return map[string]any{"ok": true, "path": dst, "dir": root, "count": len(notes)}, nil
	}
	return map[string]any{
		"ok":         true,
		"fileName":   filename,
		"dataBase64": base64.StdEncoding.EncodeToString(buf),
		"bytes":      len(buf),
		"count":      len(notes),
		"folders":    folders,
		"storageDir": root,
		"version":    resolveMetadata().Version,
	}, nil
}

// ---------------- 从备份恢复 ----------------

// safeRelPath 把 zip 内的条目名规范化为「相对存储目录的安全路径」。
// 备份包是可以被替换的输入，必须当不可信数据对待：绝对路径、盘符、`..` 一律拒绝。
func safeRelPath(name string) (string, bool) {
	n := strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	if n == "" || strings.HasPrefix(n, "/") {
		return "", false
	}
	if len(n) >= 2 && n[1] == ':' {
		return "", false // "C:/..." 之类
	}
	out := make([]string, 0, 8)
	for _, p := range strings.Split(n, "/") {
		switch p {
		case "", ".":
			continue
		case "..":
			return "", false
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return "", false
	}
	return strings.Join(out, "/"), true
}

// insideRoot 把相对路径解析为绝对路径，并确认它没有跳出 root。
func insideRoot(root, rel string) (string, bool) {
	abs := filepath.Join(root, filepath.FromSlash(rel))
	r, err := filepath.Rel(root, abs)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) {
		return "", false
	}
	if filepath.IsAbs(r) {
		return "", false
	}
	return abs, true
}

// restoreNotes 从备份 zip 恢复笔记与配置。
//
// dryRun=true 只解析并回报包里有什么（供 UI 先让用户确认），不落盘。
//
// 安全设计：
//  1. 逐条校验 entry 路径（见 safeRelPath / insideRoot），拒绝跳出存储目录的条目；
//  2. 限制条目数与解压总量，避免 zip bomb；
//  3. 必须含 .mdnotes/meta.json，否则不认这个包（避免误喂普通 zip 把库写坏）；
//  4. 覆盖前自动把当前状态另存一份 pre-restore-*.zip，恢复错了还能退回去；
//  5. 恢复后清空内容哈希缓存，否则后续保存会因为「缓存说没变」而跳过写盘。
func restoreNotes(dataBase64 string, dryRun bool) (any, *dbxpluginsdk.PluginError) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataBase64))
	if err != nil {
		return nil, badParams("备份内容不是合法 base64：%v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, badParams("这不是一个有效的 zip 备份包：%v", err)
	}

	const maxEntries = 20000
	const maxTotal = uint64(256) << 20 // 解压后总量上限 256 MiB
	const maxFile = uint64(32) << 20   // 单个文件上限 32 MiB
	if len(zr.File) > maxEntries {
		return nil, badParams("备份包条目过多（%d）", len(zr.File))
	}

	root := notesDir()
	type item struct {
		zipName string
		rel     string
	}
	var items []item
	var metaBytes []byte
	var info backupInfo
	var total uint64

	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rel, ok := safeRelPath(f.Name)
		if !ok {
			return nil, badParams("备份包含不安全的路径，已拒绝：%s", f.Name)
		}
		if _, ok := insideRoot(root, rel); !ok {
			return nil, badParams("备份包路径越界，已拒绝：%s", f.Name)
		}
		total += f.UncompressedSize64
		if total > maxTotal {
			return nil, badParams("备份包解压后体积过大，已拒绝")
		}
		if f.UncompressedSize64 > maxFile {
			return nil, badParams("备份包内单个文件过大：%s", f.Name)
		}

		switch rel {
		case backupInfoName:
			if rc, e := f.Open(); e == nil {
				b, _ := io.ReadAll(io.LimitReader(rc, 1<<20))
				_ = rc.Close()
				_ = json.Unmarshal(b, &info)
			}
			continue // 元信息只用于回显，不落盘
		case backupMetaEntry:
			rc, e := f.Open()
			if e != nil {
				return nil, failed(-32006, fmt.Errorf("read backup index: %w", e))
			}
			metaBytes, _ = io.ReadAll(io.LimitReader(rc, int64(maxFile)))
			_ = rc.Close()
			continue
		}
		if !strings.HasSuffix(strings.ToLower(rel), ".md") {
			continue // 只接受 .md 正文；其余条目忽略，避免把杂七杂八的东西写进库
		}
		items = append(items, item{zipName: f.Name, rel: rel})
	}

	if len(metaBytes) == 0 {
		return nil, badParams("这不是「MD 笔记」的备份包（缺少 %s）", backupMetaEntry)
	}
	var bm Meta
	if err := json.Unmarshal(metaBytes, &bm); err != nil {
		return nil, badParams("备份包里的索引已损坏：%v", err)
	}
	// 备份可能来自另一个操作系统：索引里的路径分隔符按当前平台归一化，
	// 否则「Windows 备份 → macOS 恢复」会得到一批文件名里带反斜杠的怪文件。
	migrated := false
	for i := range bm.Nodes {
		if bm.Nodes[i].File == "" {
			continue
		}
		fixed := filepath.FromSlash(strings.ReplaceAll(bm.Nodes[i].File, "\\", "/"))
		if fixed != bm.Nodes[i].File {
			bm.Nodes[i].File = fixed
			migrated = true
		}
	}
	if migrated {
		if b, e := json.MarshalIndent(bm, "", "  "); e == nil {
			metaBytes = b
		}
	}
	notes, folders := 0, 0
	for _, n := range bm.Nodes {
		if n.Type == "note" {
			notes++
		} else {
			folders++
		}
	}

	if dryRun {
		return map[string]any{
			"ok": true, "dryRun": true, "info": info,
			"files": len(items), "notes": notes, "folders": folders,
			"storageDir": root,
		}, nil
	}

	// 覆盖前先把当前状态存一份，恢复错了能退回去。
	safety := ""
	if metaExists() {
		cur := loadMeta()
		var cnotes []MetaNode
		cf := 0
		for _, n := range cur.Nodes {
			if n.Type == "note" {
				cnotes = append(cnotes, n)
			} else {
				cf++
			}
		}
		if len(cnotes) > 0 {
			b := buildBackupZip(root, cur, cnotes, cf, "")
			p := absUnique(filepath.Join(root, "pre-restore-"+time.Now().Format("20060102-150405")+".zip"))
			if err := writeAtomic(p, b); err == nil {
				safety = p
			}
		}
	}

	byName := map[string]*zip.File{}
	for _, f := range zr.File {
		byName[f.Name] = f
	}

	written := 0
	for _, it := range items {
		f := byName[it.zipName]
		if f == nil {
			continue
		}
		abs, ok := insideRoot(root, it.rel)
		if !ok {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return nil, failed(-32006, fmt.Errorf("create dir: %w", err))
		}
		rc, e := f.Open()
		if e != nil {
			return nil, failed(-32006, fmt.Errorf("open entry %s: %w", it.zipName, e))
		}
		data, e := io.ReadAll(io.LimitReader(rc, int64(maxFile)))
		_ = rc.Close()
		if e != nil {
			return nil, failed(-32006, fmt.Errorf("read entry %s: %w", it.zipName, e))
		}
		if e := writeAtomic(abs, data); e != nil {
			return nil, failed(-32006, fmt.Errorf("restore %s: %w", it.rel, e))
		}
		written++
	}

	// 索引最后写：正文全就位了再切换索引，中途失败至少不会出现「索引指向不存在的文件」。
	if err := os.MkdirAll(metaDir(), 0o755); err != nil {
		return nil, failed(-32006, fmt.Errorf("create meta dir: %w", err))
	}
	if err := writeAtomic(metaPath(), metaBytes); err != nil {
		return nil, failed(-32006, fmt.Errorf("restore index: %w", err))
	}

	// 磁盘上的正文刚被外部改写，哈希缓存必须作废，否则后续保存会跳过写盘。
	hashMu.Lock()
	contentHashes = map[string]string{}
	hashMu.Unlock()

	sidecarTrace(fmt.Sprintf("notes/restore ok dir=%s files=%d notes=%d safety=%s",
		root, written, notes, safety))
	return map[string]any{
		"ok": true, "files": written, "notes": notes, "folders": folders,
		"storageDir": root, "safetyPath": safety, "backup": info,
	}, nil
}

// writerCapture 把 zip 写入内存（strings.Builder 仅作字节容器）。
type writerCapture struct{ w *strings.Builder }

func (c *writerCapture) Write(p []byte) (int, error) { return c.w.Write(p) }

// ---------------- 待处理上下文（表 -> 新建笔记）----------------

var pendingMu sync.Mutex
var pendingContext any

func setPending(v any) {
	pendingMu.Lock()
	pendingContext = v
	pendingMu.Unlock()
}

func takePending() any {
	pendingMu.Lock()
	defer pendingMu.Unlock()
	v := pendingContext
	pendingContext = nil
	return v
}

// ---------------- 文件系统协议（mdnotes://，基于真实文件）----------------
//
// 存储目录即虚拟文件系统的根；.mdnotes 内部目录被隐藏。所有写操作同步更新 meta.json，
// 保证工作台目录树与文件管理器看到的内容一致。

func splitURI(uri string) ([]string, error) {
	s := uri
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	} else if i := strings.Index(s, ":/"); i >= 0 {
		s = s[i+2:]
	}
	s = strings.Trim(s, "/")
	if s == "" {
		return nil, nil
	}
	segs := strings.Split(s, "/")
	for _, seg := range segs {
		if seg == ".." || seg == "" {
			return nil, fmt.Errorf("invalid path")
		}
	}
	return segs, nil
}

func entryOf(name, rel, kind string, size int, ct string) map[string]any {
	e := map[string]any{"name": name, "uri": "mdnotes:/" + rel, "kind": kind}
	if kind == "file" {
		e["size"] = size
		if ct != "" {
			e["contentType"] = ct
		}
	}
	return e
}

func fsList(params json.RawMessage) (any, error) {
	var p struct {
		URI string `json:"uri"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	root := notesDir()
	dir := root
	if len(segs) > 0 {
		dir = filepath.Join(append([]string{root}, segs...)...)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, e := range entries {
		if e.Name() == ".mdnotes" {
			continue
		}
		rel := filepath.Join(append(segs, e.Name())...)
		if e.IsDir() {
			out = append(out, entryOf(e.Name(), rel, "directory", 0, ""))
		} else if strings.EqualFold(filepath.Ext(e.Name()), ".md") {
			info, _ := e.Info()
			sz := 0
			if info != nil {
				sz = int(info.Size())
			}
			out = append(out, entryOf(e.Name(), rel, "file", sz, "text/markdown"))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return fmt.Sprint(out[i]["name"]) < fmt.Sprint(out[j]["name"])
	})
	return map[string]any{"entries": out}, nil
}

func fsRead(params json.RawMessage) (any, error) {
	var p struct {
		URI      string `json:"uri"`
		MaxBytes int    `json:"maxBytes"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("not a file")
	}
	name := segs[len(segs)-1]
	if !strings.EqualFold(filepath.Ext(name), ".md") {
		return nil, fmt.Errorf("only .md files can be read")
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	truncated := false
	if p.MaxBytes > 0 && len(data) > p.MaxBytes {
		data = data[:p.MaxBytes]
		truncated = true
	}
	rel := filepath.Join(segs...)
	syncMetaFile(rel, string(data))
	return map[string]any{
		"dataBase64":  base64.StdEncoding.EncodeToString(data),
		"contentType": "text/markdown",
		"truncated":   truncated,
	}, nil
}

func fsWrite(params json.RawMessage) (any, error) {
	var p struct {
		URI        string `json:"uri"`
		DataBase64 string `json:"dataBase64"`
		Create     bool   `json:"create"`
		Overwrite  bool   `json:"overwrite"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("cannot write root")
	}
	name := segs[len(segs)-1]
	if !strings.EqualFold(filepath.Ext(name), ".md") {
		return nil, fmt.Errorf("only .md files can be written")
	}
	raw, err := base64.StdEncoding.DecodeString(p.DataBase64)
	if err != nil {
		return nil, fmt.Errorf("invalid dataBase64: %v", err)
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	rel := filepath.Join(segs...)
	_, statErr := os.Stat(abs)
	if statErr == nil && !p.Overwrite && !p.Create {
		return map[string]any{"success": false, "message": "target exists, overwrite not requested"}, nil
	}
	if statErr != nil && !p.Create && !p.Overwrite {
		return map[string]any{"success": false, "message": "file not found, create not requested"}, nil
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	if err := writeAtomic(abs, raw); err != nil {
		return nil, err
	}
	syncMetaFile(rel, string(raw))
	nm := filepath.Base(rel)
	return map[string]any{
		"success": true,
		"entry":   entryOf(nm, rel, "file", len(raw), "text/markdown"),
	}, nil
}

func fsCreateDirectory(params json.RawMessage) (any, error) {
	var p struct {
		URI string `json:"uri"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("cannot create root")
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	rel := filepath.Join(segs...)
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	syncMetaDir(rel)
	nm := filepath.Base(rel)
	return map[string]any{"success": true, "entry": entryOf(nm, rel, "directory", 0, "")}, nil
}

func fsDelete(params json.RawMessage) (any, error) {
	var p struct {
		URI       string `json:"uri"`
		Recursive bool   `json:"recursive"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	segs, err := splitURI(p.URI)
	if err != nil {
		return nil, err
	}
	if len(segs) == 0 {
		return nil, fmt.Errorf("cannot delete root")
	}
	root := notesDir()
	abs := filepath.Join(append([]string{root}, segs...)...)
	rel := filepath.Join(segs...)
	info, statErr := os.Stat(abs)
	if statErr != nil {
		return map[string]any{"success": false, "message": "not found"}, nil
	}
	if info.IsDir() {
		if !p.Recursive {
			entries, _ := os.ReadDir(abs)
			for _, en := range entries {
				if en.Name() == ".mdnotes" {
					continue
				}
				return map[string]any{"success": false, "message": "directory not empty"}, nil
			}
		}
		if err := os.RemoveAll(abs); err != nil {
			return nil, err
		}
		removeMetaUnder(rel, true)
	} else {
		if err := os.Remove(abs); err != nil {
			return nil, err
		}
		removeMetaUnder(rel, false)
	}
	return map[string]any{"success": true}, nil
}

func fsRename(params json.RawMessage) (any, error) {
	var p struct {
		SourceURI string `json:"sourceUri"`
		TargetURI string `json:"targetUri"`
		Overwrite bool   `json:"overwrite"`
	}
	if e := json.Unmarshal(params, &p); e != nil {
		return nil, e
	}
	srcSegs, err := splitURI(p.SourceURI)
	if err != nil || len(srcSegs) == 0 {
		return nil, fmt.Errorf("invalid source")
	}
	dstSegs, err := splitURI(p.TargetURI)
	if err != nil || len(dstSegs) == 0 {
		return nil, fmt.Errorf("invalid target")
	}
	root := notesDir()
	srcAbs := filepath.Join(append([]string{root}, srcSegs...)...)
	dstAbs := filepath.Join(append([]string{root}, dstSegs...)...)
	srcRel := filepath.Join(srcSegs...)
	// 目标若是已存在的目录，则把源移入其中
	if dstInfo, e := os.Stat(dstAbs); e == nil && dstInfo.IsDir() {
		dstAbs = filepath.Join(dstAbs, filepath.Base(srcAbs))
	}
	if _, e := os.Stat(dstAbs); e == nil && !p.Overwrite {
		return map[string]any{"success": false, "message": "target exists"}, nil
	}
	if err := os.MkdirAll(filepath.Dir(dstAbs), 0o755); err != nil {
		return nil, err
	}
	if err := os.Rename(srcAbs, dstAbs); err != nil {
		return nil, err
	}
	dstRel := toRel(root, dstAbs)
	renameMeta(srcRel, dstRel)
	nm := filepath.Base(dstRel)
	kind := "directory"
	if !strings.EqualFold(filepath.Ext(nm), ".md") {
		kind = "directory"
	} else {
		kind = "file"
	}
	return map[string]any{"success": true, "entry": entryOf(nm, dstRel, kind, 0, "text/markdown")}, nil
}

// ---------------- meta 与文件系统的双向同步 ----------------

func parentIDOf(rel string) *string {
	d := filepath.Dir(rel)
	if d == "." || d == "" || d == string(filepath.Separator) {
		return nil
	}
	root := notesDir()
	m := loadMeta()
	for i := range m.Nodes {
		if m.Nodes[i].File == d {
			id := m.Nodes[i].ID
			return &id
		}
	}
	_ = root
	return nil
}

func nameFromFile(rel string) string {
	base := filepath.Base(rel)
	return strings.TrimSuffix(base, filepath.Ext(base))
}

func syncMetaFile(rel, content string) {
	m := loadMeta()
	found := false
	for i := range m.Nodes {
		if m.Nodes[i].File == rel && m.Nodes[i].Type == "note" {
			m.Nodes[i].Name = nameFromFile(rel)
			m.Nodes[i].UpdatedAt = time.Now().Format(time.RFC3339)
			found = true
			break
		}
	}
	if !found {
		id := newID()
		m.Nodes = append(m.Nodes, MetaNode{
			ID:        id,
			Type:      "note",
			Name:      nameFromFile(rel),
			ParentID:  parentIDOf(rel),
			CreatedAt: time.Now().Format(time.RFC3339),
			UpdatedAt: time.Now().Format(time.RFC3339),
			File:      rel,
		})
		_ = content
	}
	_ = saveMeta(m)
}

func syncMetaDir(rel string) {
	m := loadMeta()
	for i := range m.Nodes {
		if m.Nodes[i].File == rel && m.Nodes[i].Type == "folder" {
			m.Nodes[i].Name = filepath.Base(rel)
			return
		}
	}
	m.Nodes = append(m.Nodes, MetaNode{
		ID:        newID(),
		Type:      "folder",
		Name:      filepath.Base(rel),
		ParentID:  parentIDOf(rel),
		CreatedAt: time.Now().Format(time.RFC3339),
		UpdatedAt: time.Now().Format(time.RFC3339),
		File:      rel,
	})
	_ = saveMeta(m)
}

func removeMetaUnder(rel string, isDir bool) {
	m := loadMeta()
	kept := m.Nodes[:0]
	for _, n := range m.Nodes {
		if isDir {
			if n.File == rel || strings.HasPrefix(n.File, rel+"/") {
				continue
			}
		} else {
			if n.File == rel {
				continue
			}
		}
		kept = append(kept, n)
	}
	m.Nodes = kept
	_ = saveMeta(m)
}

func renameMeta(srcRel, dstRel string) {
	m := loadMeta()
	for i := range m.Nodes {
		if m.Nodes[i].File == srcRel {
			m.Nodes[i].File = dstRel
			m.Nodes[i].Name = nameFromFile(dstRel)
			m.Nodes[i].ParentID = parentIDOf(dstRel)
		} else if strings.HasPrefix(m.Nodes[i].File, srcRel+"/") {
			m.Nodes[i].File = dstRel + m.Nodes[i].File[len(srcRel):]
		}
	}
	_ = saveMeta(m)
}

func newID() string {
	return fmt.Sprintf("n%d%x", time.Now().UnixNano(), rand.Uint32())
}

// ---------------- 右键联动：为此表/视图新建笔记 ----------------

func handleNewNoteForTable(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p struct {
		Connection struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"connection"`
		Object struct {
			Name    string `json:"name"`
			Type    string `json:"type"`
			Columns []struct {
				Name string `json:"name"`
				Type string `json:"type"`
			} `json:"columns"`
		} `json:"object"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, badParams("invalid params: %v", err)
	}

	tableName := firstNonEmpty(p.Object.Name, p.Connection.Name, p.Connection.ID)
	cols := make([]map[string]string, 0, len(p.Object.Columns))
	for _, c := range p.Object.Columns {
		cols = append(cols, map[string]string{"name": c.Name, "type": c.Type})
	}

	setPending(map[string]any{
		"tableName":  tableName,
		"objectType": firstNonEmpty(p.Object.Type, "table"),
		"columns":    cols,
		"at":         time.Now().UnixMilli(),
	})

	return map[string]any{
		"success": true,
		"message": "已记录表：" + tableName + "，打开 MD 笔记工作台后将自动预填模板。",
	}, nil
}

// ---------------- 原子写 ----------------

var tmpSeq uint64

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// tmp 名必须唯一：同一个存储目录可能被多个侧车实例同时写（重复建「同一个目录」的连接），
	// 共用一个固定名（path+".tmp"）会让两个进程互相覆盖对方的半成品，
	// 甚至把对方的半截内容 rename 成正式文件 —— 索引损坏的后果可能是整库被误删。
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), atomic.AddUint64(&tmpSeq, 1))
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// resolveMetadata 构造启动时向宿主宣告的身份。
//
// 关键：包内 manifest.json 的版本优先于常量。宿主在两者不一致时会拒绝握手
// （Sidecar identity does not match manifest），而版本号是随每次发版变化的
// —— 硬编码常量一旦忘记同步，侧车就会被整体丢弃，表现为「UI 里什么都存不了」。
// 从可执行文件所在目录向上找 manifest.json，找到且 id 匹配就采用它的版本。
// （同 dbx-plugin-NintyAPI 的 resolveMetadata 做法。）
func resolveMetadata() dbxpluginsdk.Metadata {
	caps := []string{"connections", "notes", "filesystem"}
	fallback := dbxpluginsdk.Metadata{ID: pluginID, Version: pluginVersion, Capabilities: caps}
	exe, err := os.Executable()
	if err != nil {
		return fallback
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 6; i++ {
		data, readErr := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if readErr == nil {
			var m struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			}
			// 只有 id 与本插件一致的 manifest 才有权改写版本，避免误读宿主目录里的别的 manifest。
			if json.Unmarshal(data, &m) == nil && m.ID == pluginID && strings.TrimSpace(m.Version) != "" {
				fallback.Version = strings.TrimSpace(m.Version)
			}
			return fallback
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return fallback
}

func main() {
	loadConfig()
	_ = os.MkdirAll(dataDir(), 0o755)
	cwd, _ := os.Getwd()
	sidecarTrace(fmt.Sprintf("start pid=%d dataDir=%s configured=%v dir=%s cwd=%s",
		os.Getpid(), dataDir(), dirConfigured(), notesDir(), cwd))

	metadata := resolveMetadata()
	server := dbxpluginsdk.NewServer(metadata, &plugin{connections: map[string]struct{}{}})
	if err := server.Serve(); err != nil {
		fmt.Fprintf(os.Stderr, "[mdnotes] %v\n", err)
		os.Exit(1)
	}
}
