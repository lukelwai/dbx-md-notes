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
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	dbxpluginsdk "github.com/example/mdnotes/dbxsdk"
)

// 必须与 manifest.json 的 id / version 完全一致，否则宿主判定 Sidecar 身份不匹配并丢弃。
const (
	pluginID      = "com.example.mdnotes"
	pluginVersion = "0.5.5" // 仅作兜底；运行时以包内 manifest.json 的版本为准（见 resolveMetadata）
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
		return map[string]any{
			"ok": true, "plugin": pluginID, "version": pluginVersion,
			"storagePath": notesDir(),
			"configured":  dirConfigured(),
		}, nil

	case "notes/path":
		return map[string]any{"path": metaPath(), "dir": notesDir(), "configured": dirConfigured()}, nil

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
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return exportNote(p.ID)

	case "notes/backup":
		var p struct {
			Scope string `json:"scope"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return backupNotes(p.Scope)

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

	case "contextMenu/com.example.mdnotes.newNoteForTable":
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
var contentHashes = map[string]string{}

func contentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return fmt.Sprintf("%x", h)
}

// isUnchanged 返回 true 表示磁盘上的文件内容与 content 一致（无需重写）。
func isUnchanged(id, abs, hs string) bool {
	hashMu.Lock()
	if c, ok := contentHashes[id]; ok && c == hs {
		hashMu.Unlock()
		return true
	}
	hashMu.Unlock()
	if data, err := os.ReadFile(abs); err == nil {
		if contentHash(string(data)) == hs {
			hashMu.Lock()
			contentHashes[id] = hs
			hashMu.Unlock()
			return true
		}
	}
	return false
}

func writeContent(id, abs, content string) error {
	if err := writeAtomic(abs, []byte(content)); err != nil {
		return err
	}
	hashMu.Lock()
	contentHashes[id] = contentHash(content)
	hashMu.Unlock()
	return nil
}

// ---------------- 笔记快照（前端传入） ----------------

type snapNode struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	Name      string  `json:"name"`
	ParentID  *string `json:"parentId"`
	Content   string  `json:"content"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

type snap struct {
	Version  int             `json:"version"`
	Nodes    []snapNode      `json:"nodes"`
	ActiveID string          `json:"activeId"`
	Expanded map[string]bool `json:"expanded"`
	View     string          `json:"view"`
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
	for _, n := range s.Nodes {
		inByID[n.ID] = n
	}

	// 1) 删除：在 prev 中、不在 incoming 中的节点
	incomingSet := map[string]bool{}
	for _, n := range s.Nodes {
		incomingSet[n.ID] = true
	}
	var delNotes, delFolders []MetaNode
	for _, old := range prev.Nodes {
		if !incomingSet[old.ID] {
			if old.Type == "note" {
				delNotes = append(delNotes, old)
			} else {
				delFolders = append(delFolders, old)
			}
		}
	}
	for _, n := range delNotes {
		_ = os.Remove(filepath.Join(root, n.File))
	}
	for _, n := range delFolders {
		_ = os.RemoveAll(filepath.Join(root, n.File))
	}

	// 2) 笔记：新建/移动文件 + 仅内容变化时写盘
	result := []MetaNode{}
	for _, n := range s.Nodes {
		if n.Type != "note" {
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
		hs := contentHash(n.Content)
		if !isUnchanged(n.ID, absTarget, hs) {
			if err := writeContent(n.ID, absTarget, n.Content); err != nil {
				return err
			}
		}
		mn.File = toRel(root, absTarget)
		result = append(result, mn)
	}

	// 3) 文件夹：新建/移动目录（子项已在第 2 步自行落到新位置，这里只需清理旧空目录）
	for _, n := range s.Nodes {
		if n.Type != "folder" {
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
			_ = os.RemoveAll(filepath.Join(root, old.File))
			mn.File = rel
		} else {
			mn.File = old.File
		}
		result = append(result, mn)
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
				node["content"] = ""
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

func exportNote(id string) (any, *dbxpluginsdk.PluginError) {
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
	dst := absUnique(filepath.Join(root, sanitizeName(node.Name)+".md"))
	if dst != src {
		data, err := os.ReadFile(src)
		if err != nil {
			return nil, failed(-32004, fmt.Errorf("read note: %w", err))
		}
		if err := writeAtomic(dst, data); err != nil {
			return nil, failed(-32004, fmt.Errorf("export note: %w", err))
		}
	}
	return map[string]any{"ok": true, "path": dst, "name": node.Name}, nil
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

func backupNotes(scope string) (any, *dbxpluginsdk.PluginError) {
	m := loadMeta()
	root := notesDir()

	var notes []MetaNode
	if scope == "" {
		for _, n := range m.Nodes {
			if n.Type == "note" {
				notes = append(notes, n)
			}
		}
	} else {
		inc := subtreeIDs(m, scope)
		for _, n := range m.Nodes {
			if n.Type == "note" && inc[n.ID] {
				notes = append(notes, n)
			}
		}
	}

	// 构建 zip（内存）
	var buf []byte
	func() {
		var sb strings.Builder
		zw := zip.NewWriter(&writerCapture{&sb})
		for _, n := range notes {
			data, err := os.ReadFile(filepath.Join(root, n.File))
			if err != nil {
				data = []byte("")
			}
			w, e := zw.Create(n.File)
			if e != nil {
				continue
			}
			_, _ = w.Write(data)
		}
		_ = zw.Close()
		buf = []byte(sb.String())
	}()
	if len(buf) == 0 {
		return nil, failed(-32005, fmt.Errorf("nothing to backup"))
	}

	var filename string
	if scope != "" {
		var name string
		for _, n := range m.Nodes {
			if n.ID == scope {
				name = n.Name
				break
			}
		}
		filename = sanitizeName(name) + ".zip"
	} else {
		now := time.Now()
		filename = fmt.Sprintf("md-notes-backup-%04d%02d%02d-%02d%02d.zip",
			now.Year(), now.Month(), now.Day(), now.Hour(), now.Minute())
	}
	dst := absUnique(filepath.Join(root, filename))
	if err := writeAtomic(dst, buf); err != nil {
		return nil, failed(-32005, fmt.Errorf("write backup: %w", err))
	}
	return map[string]any{"ok": true, "path": dst, "count": len(notes)}, nil
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

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
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
