package main

// SQLite 索引层专项测试：迁移 / 版本号 / 乐观锁 / 备份恢复兼容。

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

// indexSnapshot 生成当前库的「可移植 JSON 索引快照」字节，供构造备份包用。
func indexSnapshot(t *testing.T) []byte {
	t.Helper()
	b, err := json.MarshalIndent(loadMeta(), "", "  ")
	if err != nil {
		t.Fatalf("序列化索引快照失败：%v", err)
	}
	return b
}

func minimalSnap(name, content string) map[string]any {
	return map[string]any{
		"version": 2, "activeId": "n1", "view": "split",
		"nodes": []map[string]any{{
			"id": "n1", "type": "note", "name": name, "parentId": nil,
			"content": content, "createdAt": "c", "updatedAt": "u",
		}},
	}
}

func metaNodeByID(m Meta, id string) *MetaNode {
	for i := range m.Nodes {
		if m.Nodes[i].ID == id {
			return &m.Nodes[i]
		}
	}
	return nil
}

// 旧 meta.json 必须在首次开库时一次性导入 SQLite，且保留原文件作为回退。
func TestMigrateLegacyMetaJSON(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)
	_ = os.MkdirAll(metaDir(), 0o755)

	legacy := Meta{
		Version: 2, ActiveID: "old1", View: "split",
		Expanded: map[string]bool{"f1": true},
		Nodes: []MetaNode{
			{ID: "f1", Type: "folder", Name: "旧文件夹", File: "旧文件夹"},
			{ID: "old1", Type: "note", Name: "老笔记", File: "旧文件夹/老笔记.md", ParentID: ptr("f1")},
		},
	}
	b, _ := json.MarshalIndent(legacy, "", "  ")
	if err := os.WriteFile(legacyMetaPath(), b, 0o644); err != nil {
		t.Fatalf("写旧索引失败：%v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "旧文件夹"), 0o755); err != nil {
		t.Fatalf("建旧目录失败：%v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "旧文件夹", "老笔记.md"), []byte("# 老正文"), 0o644); err != nil {
		t.Fatalf("写旧正文失败：%v", err)
	}

	m := loadMeta()
	if len(m.Nodes) != 2 {
		t.Fatalf("迁移后应有 2 个节点，实际 %d", len(m.Nodes))
	}
	if n := metaNodeByID(m, "old1"); n == nil || n.File != "旧文件夹/老笔记.md" {
		t.Fatalf("老笔记没被正确导入：%v", n)
	} else if n.Version != 1 || n.State != "migrated" {
		t.Fatalf("迁移节点应 version=1/state=migrated，实际 version=%d state=%s", n.Version, n.State)
	}
	if m.ActiveID != "old1" || !m.Expanded["f1"] {
		t.Fatalf("UI 状态没随迁移带过来：activeId=%s expanded=%v", m.ActiveID, m.Expanded)
	}
	if _, err := os.Stat(legacyMetaPath()); err != nil {
		t.Fatalf("迁移后旧 meta.json 应保留作回退：%v", err)
	}
	// 幂等：再读一次不能重复插入
	if again := loadMeta(); len(again.Nodes) != 2 {
		t.Fatalf("重复开库导致重复迁移：%d 个节点", len(again.Nodes))
	}
	// 正文仍从真实 .md 读回
	res := call(t, "notes/load", map[string]any{"storage_dir": dir}).(map[string]any)
	data := res["data"].(map[string]any)
	for _, n := range data["nodes"].([]map[string]any) {
		if n["id"] == "old1" && n["content"] != "# 老正文" {
			t.Fatalf("迁移后正文读回不对：%v", n["content"])
		}
	}
}

// 每次成功写入 rev+1；只有真被改动的节点 version 递增，未动的保持不变。
func TestRevAndNodeVersionIncrement(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)

	r1 := call(t, "notes/save", map[string]any{"storage_dir": dir, "data": minimalSnap("A", "内容一")}).(map[string]any)
	if r1["ok"] != true || asI64(r1["rev"]) < 2 {
		t.Fatalf("首次保存应返回递增的 rev：%v", r1)
	}
	m1 := loadMeta()
	n1 := metaNodeByID(m1, "n1")
	if n1 == nil || n1.Version != 1 || n1.State != "created" {
		t.Fatalf("新建节点应 version=1/state=created：%v", n1)
	}

	// 改正文（正文不入库，靠 Dirty 让 version 递增）
	r2 := call(t, "notes/save", map[string]any{"storage_dir": dir, "data": minimalSnap("A", "内容二")}).(map[string]any)
	if asI64(r2["rev"]) <= asI64(r1["rev"]) {
		t.Fatalf("rev 没有递增：%v -> %v", r1["rev"], r2["rev"])
	}
	m2 := loadMeta()
	if n2 := metaNodeByID(m2, "n1"); n2 == nil || n2.Version != 2 || n2.State != "edited" {
		t.Fatalf("编辑后应 version=2/state=edited：%v", n2)
	}

	// 内容完全不变再存一次：rev 仍 +1（一次写入），但节点 version 不该动
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": minimalSnap("A", "内容二")})
	m3 := loadMeta()
	if n3 := metaNodeByID(m3, "n1"); n3 == nil || n3.Version != 2 {
		t.Fatalf("没改动的节点 version 不应递增：%v", n3)
	}
}

// 乐观锁：拿着过期 baseRev 的保存必须被整体拒绝，且磁盘正文不能被旧快照覆盖。
func TestOptimisticLockRejectsStaleSave(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)

	first := call(t, "notes/save", map[string]any{"storage_dir": dir, "data": minimalSnap("A", "原始")}).(map[string]any)
	baseRev := asI64(first["rev"])

	// 模拟「另一个实例」写入（不带 baseRev = 无锁路径）
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": minimalSnap("A", "对方的新内容")})

	// 本实例拿着旧 baseRev 保存 → 必须拒绝，且不碰磁盘
	stale := minimalSnap("A", "我这边基于旧快照的修改")
	stale["baseRev"] = baseRev
	res := call(t, "notes/save", map[string]any{"storage_dir": dir, "data": stale}).(map[string]any)
	if res["conflict"] != true || res["ok"] != false {
		t.Fatalf("过期保存必须返回 conflict：%v", res)
	}
	if asI64(res["currentRev"]) <= asI64(res["baseRev"]) {
		t.Fatalf("冲突详情里的 currentRev 应领先于 baseRev：%v", res)
	}
	changed, _ := res["changed"].([]map[string]any)
	if len(changed) == 0 {
		t.Fatalf("冲突详情应列出被对方改动的节点：%v", res)
	}
	// 正文必须还是对方的，绝不能被旧快照盖掉
	body, err := os.ReadFile(filepath.Join(dir, "A.md"))
	if err != nil || string(body) != "对方的新内容" {
		t.Fatalf("冲突保存竟然改写了磁盘正文：%q err=%v", body, err)
	}
	// 重新载入拿到新 rev 后，保存应恢复成功
	reloaded := call(t, "notes/load", map[string]any{"storage_dir": dir}).(map[string]any)
	fresh := minimalSnap("A", "基于最新状态的修改")
	fresh["baseRev"] = asI64(reloaded["rev"])
	ok := call(t, "notes/save", map[string]any{"storage_dir": dir, "data": fresh}).(map[string]any)
	if ok["ok"] != true || ok["conflict"] == true {
		t.Fatalf("刷新 rev 后应能正常保存：%v", ok)
	}
}

// 不带 baseRev 的旧前端 / 探针仍能写入（兼容退化路径）。
func TestSaveWithoutBaseRevStillWorks(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)
	res := call(t, "notes/save", map[string]any{"storage_dir": dir, "data": minimalSnap("A", "内容")}).(map[string]any)
	if res["ok"] != true {
		t.Fatalf("不带 baseRev 的保存不该被拦：%v", res)
	}
}

// 新格式备份包（index.json）可恢复，且恢复后 rev 继续递增、不回退。
func TestRestoreNewFormatIndexIntoSQLite(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": minimalSnap("A", "备份时的内容")})

	bk := call(t, "notes/backup", map[string]any{"storage_dir": dir}).(map[string]any)
	zipBytes, _ := base64.StdEncoding.DecodeString(bk["dataBase64"].(string))
	zr, _ := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	found := false
	for _, f := range zr.File {
		if f.Name == backupIndexEntry {
			found = true
		}
	}
	if !found {
		t.Fatalf("新备份包必须含 %s", backupIndexEntry)
	}

	before := loadMeta().Rev
	rr := call(t, "notes/restore", map[string]any{
		"storage_dir": dir,
		"dataBase64":  bk["dataBase64"],
	}).(map[string]any)
	if rr["ok"] != true || asI64(rr["rev"]) <= before {
		t.Fatalf("恢复后 rev 必须继续递增（不能回退到备份里的旧值）：before=%d res=%v", before, rr)
	}
	if m := loadMeta(); metaNodeByID(m, "n1") == nil {
		t.Fatalf("恢复后索引没写进 SQLite：%v", m)
	}
}

// 老备份包（backup@1 的 .mdnotes/meta.json）必须仍能恢复。
func TestRestoreLegacyBackupMetaJSON(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)

	legacyBytes, _ := json.Marshal(Meta{
		Version: 2, ActiveID: "old1", View: "split",
		Nodes: []MetaNode{{ID: "old1", Type: "note", Name: "老备份", File: "老备份.md"}},
	})
	var sb bytes.Buffer
	zw := zip.NewWriter(&sb)
	if w, e := zw.Create(backupMetaEntryLegacy); e == nil {
		_, _ = w.Write(legacyBytes)
	}
	if w, e := zw.Create("老备份.md"); e == nil {
		_, _ = w.Write([]byte("# 来自老备份"))
	}
	_ = zw.Close()

	res := call(t, "notes/restore", map[string]any{
		"storage_dir": dir,
		"dataBase64":  base64.StdEncoding.EncodeToString(sb.Bytes()),
	}).(map[string]any)
	if res["ok"] != true {
		t.Fatalf("老备份包恢复失败：%v", res)
	}
	m := loadMeta()
	if metaNodeByID(m, "old1") == nil {
		t.Fatalf("老备份的节点没导入 SQLite：%v", m)
	}
	body, err := os.ReadFile(filepath.Join(dir, "老备份.md"))
	if err != nil || string(body) != "# 来自老备份" {
		t.Fatalf("老备份正文没恢复：%q err=%v", body, err)
	}
}

// 缺少索引条目的普通 zip 仍应被拒绝。
func TestRestoreRejectsZipWithoutIndex(t *testing.T) {
	var sb bytes.Buffer
	zw := zip.NewWriter(&sb)
	if w, e := zw.Create("hello.txt"); e == nil {
		_, _ = w.Write([]byte("hi"))
	}
	_ = zw.Close()
	raw, _ := json.Marshal(map[string]any{
		"storage_dir": t.TempDir(),
		"dataBase64":  base64.StdEncoding.EncodeToString(sb.Bytes()),
	})
	if _, perr := (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, "notes/restore", raw, nil); perr == nil {
		t.Fatalf("无索引的普通 zip 必须被拒绝")
	}
}

// 首次运行判定不能只看 notes.db 在不在磁盘上：loadMeta() 会顺手建空库，
// 而 notes/reconcile 恰恰在 notesLoad() 之前就调了 loadMeta()。
// 回归：0.8.13 前因此把全新目录误判成「已有数据」，示例笔记再也不生成。
func TestStoreHasDataFirstRunSemantics(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)

	if storeHasData() {
		t.Fatalf("全新目录不该被判成已有数据")
	}
	// 复现 reconcile 的调用顺序：先建空库，再问「是不是首次运行」。
	_ = loadMeta()
	if !metaExists() {
		t.Fatalf("loadMeta 应已建库（这正是回归场景）")
	}
	if storeHasData() {
		t.Fatalf("只有空库、从未写过索引，仍应判为首次运行")
	}
	pl, perr := notesLoad()
	if perr != nil {
		t.Fatalf("notesLoad 失败：%v", perr)
	}
	m := pl.(map[string]any)
	if m["data"] != nil {
		t.Fatalf("首次运行应返回 data=nil 让前端放示例笔记，实际 %v", m["data"])
	}

	// 真正写过一次索引后，即使后来把笔记全删空，也不能再回到首次运行，
	// 否则用户每打开一次插件示例笔记就会被塞回来。
	if err := saveMeta(Meta{Version: 2, Nodes: []MetaNode{
		{ID: "n1", Type: "note", Name: "一篇笔记", File: "一篇笔记.md"},
	}}); err != nil {
		t.Fatalf("saveMeta 失败：%v", err)
	}
	if !storeHasData() {
		t.Fatalf("写过索引后应被判为已有数据")
	}
	if err := saveMeta(Meta{Version: 2, Nodes: []MetaNode{}}); err != nil {
		t.Fatalf("删空失败：%v", err)
	}
	pl2, perr2 := notesLoad()
	if perr2 != nil {
		t.Fatalf("删空后 notesLoad 失败：%v", perr2)
	}
	if pl2.(map[string]any)["data"] == nil {
		t.Fatalf("删空笔记后不应重新回到首次运行（否则每次打开都会塞回示例）")
	}
}

func asI64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	}
	return 0
}
