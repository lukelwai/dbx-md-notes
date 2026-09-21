package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

func call(t *testing.T, method string, params any) any {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	res, perr := (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, method, raw, nil)
	if perr != nil {
		t.Fatalf("%s error: %s", method, perr.Message)
	}
	return res
}

func TestSaveLoadRenameMove(t *testing.T) {
	dir := t.TempDir()

	snap := map[string]any{
		"version":   2,
		"activeId":  "n2",
		"expanded":  map[string]bool{"n1": true},
		"view":      "split",
		"nodes": []map[string]any{
			{"id": "n1", "type": "folder", "name": "示例", "parentId": nil, "content": "", "createdAt": "c", "updatedAt": "u"},
			{"id": "n2", "type": "note", "name": "欢迎使用", "parentId": nil, "content": "# hello", "createdAt": "c", "updatedAt": "u"},
			{"id": "n3", "type": "note", "name": "子笔记", "parentId": ptr("n1"), "content": "child body", "createdAt": "c", "updatedAt": "u"},
		},
	}
	call(t, "notes/save", map[string]any{"data": snap, "storage_dir": dir})

	// 文件应真实落盘
	rootNote := filepath.Join(dir, "欢迎使用.md")
	childNote := filepath.Join(dir, "示例", "子笔记.md")
	if _, err := os.Stat(rootNote); err != nil {
		t.Fatalf("root note file missing: %v", err)
	}
	if _, err := os.Stat(childNote); err != nil {
		t.Fatalf("child note file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".mdnotes", "meta.json")); err != nil {
		t.Fatalf("meta.json missing: %v", err)
	}

	// meta.json 不得包含正文
	metaBytes, _ := os.ReadFile(filepath.Join(dir, ".mdnotes", "meta.json"))
	if contains(string(metaBytes), "child body") || contains(string(metaBytes), "# hello") {
		t.Fatalf("meta.json must NOT contain note content, got:\n%s", metaBytes)
	}

	// load 应读回正文
	loadRes := call(t, "notes/load", map[string]any{"storage_dir": dir}).(map[string]any)
	data := loadRes["data"].(map[string]any)
	nodes := data["nodes"].([]map[string]any)
	if len(nodes) != 3 {
		t.Fatalf("expected 3 nodes, got %d", len(nodes))
	}
	byID := map[string]map[string]any{}
	for _, n := range nodes {
		m := n
		byID[m["id"].(string)] = m
	}
	if byID["n3"]["content"].(string) != "child body" {
		t.Fatalf("child content mismatch: %q", byID["n3"]["content"])
	}
	if byID["n2"]["file"].(string) != "欢迎使用.md" {
		t.Fatalf("n2 file path wrong: %q", byID["n2"]["file"])
	}

	// 重命名 n2 -> 文件应改名
	snap2 := cloneSnap(snap)
	for _, n := range snap2["nodes"].([]any) {
		m := n.(map[string]any)
		if m["id"] == "n2" {
			m["name"] = "欢迎(改)"
		}
	}
	call(t, "notes/save", map[string]any{"data": snap2, "storage_dir": dir})
	if _, err := os.Stat(filepath.Join(dir, "欢迎(改).md")); err != nil {
		t.Fatalf("renamed file missing: %v", err)
	}
	if _, err := os.Stat(rootNote); err == nil {
		t.Fatalf("old file should be gone after rename")
	}

	// 移动 n3 到根目录（parentId=nil）
	snap3 := cloneSnap(snap)
	for _, n := range snap3["nodes"].([]any) {
		m := n.(map[string]any)
		if m["id"] == "n3" {
			m["parentId"] = nil
		}
	}
	call(t, "notes/save", map[string]any{"data": snap3, "storage_dir": dir})
	if _, err := os.Stat(filepath.Join(dir, "子笔记.md")); err != nil {
		t.Fatalf("moved child file missing at root: %v", err)
	}
	if _, err := os.Stat(childNote); err == nil {
		t.Fatalf("old child path should be gone after move")
	}

	// 删除 n2 后文件应被移除
	snap4 := cloneSnap(snap)
	kept := []map[string]any{}
	for _, n := range snap4["nodes"].([]any) {
		m := n.(map[string]any)
		if m["id"] != "n2" {
			kept = append(kept, m)
		}
	}
	snap4["nodes"] = kept
	call(t, "notes/save", map[string]any{"data": snap4, "storage_dir": dir})
	if _, err := os.Stat(filepath.Join(dir, "欢迎(改).md")); err == nil {
		t.Fatalf("deleted note file should be gone")
	}
}

// seedLibrary 在 dir 下铺一份两篇笔记 + 一个文件夹的库，返回备份用的节点期望值。
func seedLibrary(t *testing.T, dir string) {
	t.Helper()
	snap := map[string]any{
		"version":  2,
		"activeId": "a",
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "示例", "parentId": nil, "content": "", "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "A笔记", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "B笔记", "parentId": ptr("f1"), "content": "bbb", "createdAt": "c", "updatedAt": "u"},
		},
	}
	call(t, "notes/save", map[string]any{"data": snap, "storage_dir": dir})
}

func zipNames(t *testing.T, raw []byte) []string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("zip 解析失败：%v", err)
	}
	out := []string{}
	for _, f := range zr.File {
		out = append(out, f.Name)
	}
	return out
}

// 默认（toDisk=false）应把字节交回前端，由宿主的原生另存为对话框落盘 —— 不能自己写盘。
func TestBackupReturnsBytesWithConfig(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	res := call(t, "notes/backup", map[string]any{"storage_dir": dir}).(map[string]any)
	if res["ok"] != true {
		t.Fatalf("backup 失败：%v", res)
	}
	for _, k := range []string{"fileName", "dataBase64", "bytes", "count", "folders", "storageDir", "version"} {
		if _, ok := res[k]; !ok {
			t.Fatalf("backup 结果缺少 %q：%v", k, res)
		}
	}
	if _, ok := res["path"]; ok {
		t.Fatalf("默认不应写盘，不该有 path：%v", res)
	}
	if res["count"].(int) != 2 || res["folders"].(int) != 1 {
		t.Fatalf("计数不对：count=%v folders=%v", res["count"], res["folders"])
	}

	raw, err := base64.StdEncoding.DecodeString(res["dataBase64"].(string))
	if err != nil {
		t.Fatalf("dataBase64 不是合法 base64：%v", err)
	}
	joined := strings.Join(zipNames(t, raw), "\n")
	// 配置随包走：元信息 + 目录树索引；只备份正文会恢复出一堆没名字没层级的孤儿文件。
	for _, want := range []string{backupInfoName, backupMetaEntry, "A笔记.md", "示例/B笔记.md"} {
		if !contains(joined, want) {
			t.Fatalf("备份包缺少 %s，实际条目：\n%s", want, joined)
		}
	}
}

// toDisk=true 是宿主没有 saveFile 时的兜底：照旧写进存储目录并回显路径。
func TestBackupToDiskWritesZip(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	res := call(t, "notes/backup", map[string]any{"storage_dir": dir, "toDisk": true}).(map[string]any)
	if res["ok"] != true {
		t.Fatalf("backup(toDisk) 失败：%v", res)
	}
	path, _ := res["path"].(string)
	if path == "" {
		t.Fatalf("toDisk=true 应回显路径：%v", res)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("备份 zip 没落盘：%v", err)
	}
	if !strings.HasSuffix(path, ".zip") {
		t.Fatalf("备份文件名应为 .zip：%s", path)
	}
}

// 导出单篇：默认返回字节（自选目录），toDisk=true 才写进存储目录。
func TestExportNoteModes(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	res := call(t, "notes/exportNote", map[string]any{"id": "a", "storage_dir": dir}).(map[string]any)
	if res["fileName"] != "A笔记.md" {
		t.Fatalf("导出文件名不对：%v", res["fileName"])
	}
	b, err := base64.StdEncoding.DecodeString(res["dataBase64"].(string))
	if err != nil || string(b) != "aaa" {
		t.Fatalf("导出内容不对：%v %q", err, b)
	}
	if _, ok := res["path"]; ok {
		t.Fatalf("默认导出不应写盘：%v", res)
	}

	d := call(t, "notes/exportNote", map[string]any{"id": "a", "storage_dir": dir, "toDisk": true}).(map[string]any)
	if p, _ := d["path"].(string); p == "" {
		t.Fatalf("toDisk=true 应回显路径：%v", d)
	}
}

// 备份 → 恢复到另一个目录，正文、层级、索引全部复原。
func TestRestoreRoundTrip(t *testing.T) {
	src := t.TempDir()
	seedLibrary(t, src)
	b64 := call(t, "notes/backup", map[string]any{"storage_dir": src}).(map[string]any)["dataBase64"].(string)

	dst := t.TempDir()
	call(t, "notes/save", map[string]any{
		"storage_dir": dst,
		"data": map[string]any{
			"version": 2,
			"nodes": []map[string]any{
				{"id": "z", "type": "note", "name": "旧笔记", "parentId": nil, "content": "zzz", "createdAt": "c", "updatedAt": "u"},
			},
		},
	})

	// dryRun 只回报，不落盘
	dry := call(t, "notes/restore", map[string]any{"storage_dir": dst, "dataBase64": b64, "dryRun": true}).(map[string]any)
	if dry["dryRun"] != true || dry["notes"].(int) != 2 || dry["folders"].(int) != 1 {
		t.Fatalf("dryRun 结果不对：%v", dry)
	}
	if _, err := os.Stat(filepath.Join(dst, "A笔记.md")); err == nil {
		t.Fatalf("dryRun 不应写盘")
	}

	out := call(t, "notes/restore", map[string]any{"storage_dir": dst, "dataBase64": b64}).(map[string]any)
	if out["ok"] != true {
		t.Fatalf("restore 失败：%v", out)
	}
	if safety, _ := out["safetyPath"].(string); safety == "" {
		t.Fatalf("恢复前应留下安全备份：%v", out)
	} else if _, err := os.Stat(safety); err != nil {
		t.Fatalf("安全备份文件不存在：%v", err)
	}

	if b, err := os.ReadFile(filepath.Join(dst, "A笔记.md")); err != nil || string(b) != "aaa" {
		t.Fatalf("根笔记正文没恢复：%v %q", err, b)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "示例", "B笔记.md")); err != nil || string(b) != "bbb" {
		t.Fatalf("子目录笔记没恢复：%v %q", err, b)
	}

	loadRes := call(t, "notes/load", map[string]any{"storage_dir": dst}).(map[string]any)
	nodes := loadRes["data"].(map[string]any)["nodes"].([]map[string]any)
	if len(nodes) != 3 {
		t.Fatalf("恢复后节点数应为 3，实际 %d：%v", len(nodes), nodes)
	}
	var child *map[string]any
	for i := range nodes {
		if nodes[i]["id"] == "b" {
			child = &nodes[i]
		}
	}
	if child == nil {
		t.Fatalf("恢复后找不到 id=b：%v", nodes)
	}
	if (*child)["content"].(string) != "bbb" {
		t.Fatalf("恢复后正文没接上：%q", (*child)["content"])
	}
	// parentId 是 *string（可空），层级必须复原到 f1 上
	pid, ok := (*child)["parentId"].(*string)
	if !ok || pid == nil || *pid != "f1" {
		t.Fatalf("恢复后层级没接上：parentId=%v", (*child)["parentId"])
	}
}

// 普通 zip（没有本插件的索引）必须被拒绝，否则误喂一个 zip 就能把库写坏。
func TestRestoreRejectsForeignZip(t *testing.T) {
	var sb strings.Builder
	zw := zip.NewWriter(&writerCapture{&sb})
	w, _ := zw.Create("hello.txt")
	_, _ = w.Write([]byte("hi"))
	_ = zw.Close()
	b64 := base64.StdEncoding.EncodeToString([]byte(sb.String()))

	raw, _ := json.Marshal(map[string]any{"storage_dir": t.TempDir(), "dataBase64": b64})
	if _, perr := (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, "notes/restore", raw, nil); perr == nil {
		t.Fatalf("缺少 meta.json 的普通 zip 必须被拒绝")
	}
}

// 备份包是外部输入，路径穿越条目必须被挡在写盘之前。
func TestRestoreRejectsPathTraversal(t *testing.T) {
	var sb strings.Builder
	zw := zip.NewWriter(&writerCapture{&sb})
	if w, e := zw.Create("../../evil.md"); e == nil {
		_, _ = w.Write([]byte("pwn"))
	}
	if w, e := zw.Create(backupMetaEntry); e == nil {
		_, _ = w.Write([]byte(`{"version":2,"nodes":[]}`))
	}
	_ = zw.Close()
	b64 := base64.StdEncoding.EncodeToString([]byte(sb.String()))

	dir := t.TempDir()
	raw, _ := json.Marshal(map[string]any{"storage_dir": dir, "dataBase64": b64})
	if _, perr := (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, "notes/restore", raw, nil); perr == nil {
		t.Fatalf("含 ../../ 的条目必须被拒绝")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "evil.md")); err == nil {
		t.Fatalf("绝不能写出存储目录之外")
	}
}

func TestSafeRelPath(t *testing.T) {
	for _, s := range []string{"", "/abs.md", "C:/x.md", `..\evil.md`, "a/../../b.md", "../x", "."} {
		if got, ok := safeRelPath(s); ok {
			t.Fatalf("应拒绝 %q，却放行成 %q", s, got)
		}
	}
	good := map[string]string{"a.md": "a.md", "示例/b.md": "示例/b.md", "./a.md": "a.md", "a//b.md": "a/b.md"}
	for in, want := range good {
		got, ok := safeRelPath(in)
		if !ok || got != want {
			t.Fatalf("safeRelPath(%q) = %q,%v；期望 %q", in, got, ok, want)
		}
	}
}

func cloneSnap(s map[string]any) map[string]any {
	b, _ := json.Marshal(s)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func ptr(s string) *string { return &s }

// ---------------- 数据安全回归（2026-09-21 事故：重复选同一个目录建连接，笔记被清空） ----------------

func metaNames(t *testing.T, dir string) map[string]string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, ".mdnotes", "meta.json"))
	if err != nil {
		t.Fatalf("读 meta 失败：%v", err)
	}
	var m struct {
		Nodes []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("解析 meta 失败：%v", err)
	}
	out := map[string]string{}
	for _, n := range m.Nodes {
		out[n.ID] = n.Name
	}
	return out
}

// 在任意子目录里按文件名找文件（回收站里的副本也能找到）
func findByName(t *testing.T, root, name string) string {
	t.Helper()
	hit := ""
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || hit != "" {
			return nil
		}
		if d.Name() == name {
			hit = p
		}
		return nil
	})
	return hit
}

func twoNotesSnapshot() map[string]any {
	return map[string]any{
		"version":  2,
		"activeId": "a",
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "示例", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "A笔记", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "B笔记", "parentId": ptr("f1"), "content": "bbb", "createdAt": "c", "updatedAt": "u"},
		},
	}
}

// 一个目录被两个连接同时用时，后保存的一方带的是「旧快照」（不含对方新建的笔记）。
// 旧实现把「不在快照里」当成「要删」，于是那些笔记被从磁盘上真删掉。
// 新语义：未知 ≠ 要删，只有显式 deletedIds 才删。
func TestSavePreservesNodesMissingFromSnapshot(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	// 模拟另一实例新增第 4 个节点
	withNew := twoNotesSnapshot()
	withNew["nodes"] = append(withNew["nodes"].([]map[string]any), map[string]any{
		"id": "new", "type": "note", "name": "新增笔记", "parentId": nil,
		"content": "new body", "createdAt": "c", "updatedAt": "u",
	})
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": withNew})

	// 旧快照（只有 3 个节点）保存 —— 绝不能把「新增笔记」删掉
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": twoNotesSnapshot()})

	if b, err := os.ReadFile(filepath.Join(dir, "新增笔记.md")); err != nil || string(b) != "new body" {
		t.Fatalf("未被声明删除的笔记被清掉了：err=%v content=%q", err, b)
	}
	if _, ok := metaNames(t, dir)["new"]; !ok {
		t.Fatalf("索引里也应保留该节点：%v", metaNames(t, dir))
	}
}

// 显式声明删除的节点：从索引里去掉，正文进回收站（可捞回），不是硬删。
func TestSaveDeletesOnlyExplicitAndGoesToTrash(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	s := twoNotesSnapshot()
	delete(s, "activeId")
	// 只留 a 和 f1，并显式声明删 b
	s["nodes"] = []map[string]any{
		{"id": "f1", "type": "folder", "name": "示例", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
		{"id": "a", "type": "note", "name": "A笔记", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
	}
	s["deletedIds"] = []string{"b"}
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": s})

	names := metaNames(t, dir)
	if _, ok := names["b"]; ok {
		t.Fatalf("已声明删除的节点仍在索引里：%v", names)
	}
	if _, err := os.Stat(filepath.Join(dir, "示例", "B笔记.md")); err == nil {
		t.Fatalf("原位置不应还有该文件")
	}
	trashed := findByName(t, filepath.Join(dir, ".mdnotes", "trash"), "B笔记.md")
	if trashed == "" {
		t.Fatalf("删除应进回收站而不是销毁，但在 .mdnotes/trash 下找不到")
	}
	if b, err := os.ReadFile(trashed); err != nil || string(b) != "bbb" {
		t.Fatalf("回收站里的正文应完好：err=%v content=%q", err, b)
	}
	// a 不受影响
	if _, err := os.Stat(filepath.Join(dir, "A笔记.md")); err != nil {
		t.Fatalf("未涉及删除的笔记不该被影响：%v", err)
	}
}

// 快照里不带 content = 「这次别动正文」。
// 绝不能当成「用户把正文清空了」，否则任何一次读失败都会把磁盘上的正文清掉。
func TestSaveWithoutContentKeepsFileContent(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	// 只改名，不带 content 字段
	s := map[string]any{
		"version": 2,
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "示例", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "A笔记改名", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "B笔记", "parentId": ptr("f1"), "createdAt": "c", "updatedAt": "u"},
		},
	}
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": s})

	b, err := os.ReadFile(filepath.Join(dir, "A笔记改名.md"))
	if err != nil {
		t.Fatalf("改名后文件应存在：%v", err)
	}
	if string(b) != "aaa" {
		t.Fatalf("不带 content 的保存把正文改掉了：%q（应为 aaa）", b)
	}
}

// 正文文件读不到时：load 必须标记 contentMissing，而不是回一个空串
// （空串会被前端当作「正文就是空的」原样保存，等于把笔记清空）。
func TestLoadMarksMissingContentInsteadOfEmpty(t *testing.T) {
	dir := t.TempDir()
	seedLibrary(t, dir)

	if err := os.Remove(filepath.Join(dir, "A笔记.md")); err != nil {
		t.Fatalf("准备缺失文件失败：%v", err)
	}
	res := call(t, "notes/load", map[string]any{"storage_dir": dir}).(map[string]any)
	nodes := res["data"].(map[string]any)["nodes"].([]map[string]any)
	var a map[string]any
	for _, n := range nodes {
		if n["id"] == "a" {
			a = n
		}
	}
	if a == nil {
		t.Fatalf("找不到节点 a")
	}
	if a["contentMissing"] != true {
		t.Fatalf("正文读不到时必须标记 contentMissing，实际：%v", a)
	}
	if _, has := a["content"]; has {
		t.Fatalf("正文读不到时不应返回 content 字段（空串会被写回覆盖磁盘）：%v", a["content"])
	}

	// 把这份「没带正文」的快照存回去：不能凭空造出一个空文件
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2,
		"nodes": []map[string]any{
			{"id": "f1", "type": "folder", "name": "示例", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "a", "type": "note", "name": "A笔记", "parentId": nil, "createdAt": "c", "updatedAt": "u"},
			{"id": "b", "type": "note", "name": "B笔记", "parentId": ptr("f1"), "createdAt": "c", "updatedAt": "u"},
		},
	}})
	if _, err := os.Stat(filepath.Join(dir, "A笔记.md")); err == nil {
		t.Fatalf("不应因为「没带正文」就造出一个空文件")
	}
	// 没被动的 B 仍完好
	if b, err := os.ReadFile(filepath.Join(dir, "示例", "B笔记.md")); err != nil || string(b) != "bbb" {
		t.Fatalf("B 笔记应完好：err=%v %q", err, b)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
