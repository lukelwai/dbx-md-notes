package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	dbxpluginsdk "github.com/example/mdnotes/dbxsdk"
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

func TestBackupWritesZip(t *testing.T) {
	dir := t.TempDir()
	snap := map[string]any{
		"version": 2,
		"nodes": []map[string]any{
			{"id": "a", "type": "note", "name": "A笔记", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
		},
	}
	call(t, "notes/save", map[string]any{"data": snap, "storage_dir": dir})
	res := call(t, "notes/backup", map[string]any{"storage_dir": dir}).(map[string]any)
	if res["ok"] != true {
		t.Fatalf("backup failed: %v", res)
	}
	path := res["path"].(string)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("backup zip missing: %v", err)
	}
}

func cloneSnap(s map[string]any) map[string]any {
	b, _ := json.Marshal(s)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

func ptr(s string) *string { return &s }

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
