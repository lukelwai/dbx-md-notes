package main

import (
	"os"
	"path/filepath"
	"testing"
)

/* ============================================================
 * 打开应用自动归位（notes/reconcile）
 * ------------------------------------------------------------
 * 事故背景：用户在存储目录里手动丢 / 拷贝 .md 文件、或从别处迁移进来的库，
 * 这些文件在磁盘上真实存在、却没登记进 .mdnotes/meta.json 索引 ——
 * 于是「打开应用」时这些笔记「凭空消失」看不到。
 * reconcile 在启动时扫描存储目录，把真实存在的 .md 按所在目录层级自动补登进索引。
 * ============================================================ */

/* dropFile 在 dir 下按相对路径写一份真实文件。 */
func dropFile(t *testing.T, dir, rel, content string) string {
	t.Helper()
	abs := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatalf("造目录 %s：%v", filepath.Dir(abs), err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatalf("写 %s：%v", abs, err)
	}
	return abs
}

/* nodeByName 从 load 结果里按名字找节点。 */
func nodeByName(data map[string]any, name string) map[string]any {
	nodes, _ := data["nodes"].([]map[string]any)
	for _, n := range nodes {
		if n["name"] == name {
			return n
		}
	}
	return nil
}

/* nodeByID 从 load 结果里按 id 找节点（folder 没有 file 字段，只能用 id 串层级）。 */
func nodeByID(data map[string]any, id string) map[string]any {
	nodes, _ := data["nodes"].([]map[string]any)
	for _, n := range nodes {
		if n["id"] == id {
			return n
		}
	}
	return nil
}

/* 磁盘上真实存在、但没登记进索引的 .md，打开时应自动补登，并按目录层级归位。 */
func TestReconcileAddsOrphanNotesByLocation(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)

	// 先只登记一篇索引笔记（这会真实写出「A笔记.md」+ meta.json）
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version":  2,
		"activeId": "a",
		"nodes": []map[string]any{
			{"id": "a", "type": "note", "name": "A笔记", "parentId": nil, "content": "aaa", "createdAt": "c", "updatedAt": "u"},
		},
	}})

	// 手动在磁盘上丢几篇「没登记」的 .md，分布在不同目录
	dropFile(t, dir, "extra.md", "# 散落的笔记\n\n正文")
	dropFile(t, dir, "Topics/sub.md", "# 子目录里的\n\n正文")
	dropFile(t, dir, "Topics/Deep/deep.md", "# 更深一层\n\n正文")

	res := call(t, "notes/reconcile", map[string]any{}).(map[string]any)
	if asF64(res["added"]) != 3 {
		t.Fatalf("应补登 3 篇，实际 added=%v", res["added"])
	}
	if folders, ok := res["addedFolders"].([]map[string]any); !ok || len(folders) != 2 {
		t.Fatalf("应自动建 2 个文件夹（Topics、Topics/Deep），实际 addedFolders=%v", res["addedFolders"])
	}

	data := res["data"].(map[string]any)
	// 1 篇原索引笔记 + 3 篇补登 + 2 个自动建的文件夹 = 6
	if len(data["nodes"].([]map[string]any)) != 6 {
		t.Fatalf("节点总数应为 6，实际 %d", len(data["nodes"].([]map[string]any)))
	}
	// 正文要真从磁盘读回（不是空壳）
	if n := nodeByName(data, "extra"); n == nil {
		t.Fatalf("散落笔记没归位")
	} else if _, ok := n["content"].(string); !ok || n["content"].(string) == "" {
		t.Fatalf("散落笔记正文没从磁盘读回：%v", n["content"])
	}
	// 子目录笔记要挂在 Topics 文件夹下
	sub := nodeByName(data, "sub")
	if sub == nil {
		t.Fatalf("子目录笔记没被归位")
	}
	pidSub, _ := sub["parentId"].(*string)
	if pidSub == nil {
		t.Fatalf("子目录笔记没有父文件夹：%v", sub)
	}
	fldTopics := nodeByID(data, *pidSub)
	if fldTopics == nil || fldTopics["type"] != "folder" || fldTopics["name"] != "Topics" {
		t.Fatalf("子目录笔记没挂到 Topics 文件夹：%v", fldTopics)
	}
	// 更深层：deep 应挂在 Topics/Deep 文件夹下，而该文件夹挂在 Topics 下
	deep := nodeByName(data, "deep")
	if deep == nil {
		t.Fatalf("深层笔记没被归位")
	}
	pidDeep, _ := deep["parentId"].(*string)
	if pidDeep == nil {
		t.Fatalf("深层笔记没有父文件夹：%v", deep)
	}
	fldDeep := nodeByID(data, *pidDeep)
	if fldDeep == nil || fldDeep["type"] != "folder" || fldDeep["name"] != "Deep" {
		t.Fatalf("深层笔记没挂到 Topics/Deep 文件夹：%v", fldDeep)
	}
	if gp, ok := fldDeep["parentId"].(*string); !ok || gp == nil || *gp != fldTopics["id"] {
		t.Fatalf("Topics/Deep 文件夹没挂到 Topics 下：%v", fldDeep["parentId"])
	}
	// 磁盘文件也都在原位（reconcile 不碰正文、不移动文件）
	for _, rel := range []string{"extra.md", "Topics/sub.md", "Topics/Deep/deep.md"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			t.Fatalf("reconcile 不应移动/删除磁盘文件 %s：%v", rel, err)
		}
	}
}

/* 幂等：同一批文件再跑一次 reconcile，不应重复加入。 */
func TestReconcileIdempotent(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2, "nodes": []map[string]any{
			{"id": "a", "type": "note", "name": "A", "parentId": nil, "content": "a", "createdAt": "c", "updatedAt": "u"},
		},
	}})
	dropFile(t, dir, "loose.md", "x")

	first := call(t, "notes/reconcile", map[string]any{}).(map[string]any)
	if asF64(first["added"]) != 1 {
		t.Fatalf("首次应补登 1 篇，实际 %v", first["added"])
	}
	second := call(t, "notes/reconcile", map[string]any{}).(map[string]any)
	if asF64(second["added"]) != 0 {
		t.Fatalf("第二次应 0 新增（幂等），实际 %v", second["added"])
	}
}

/* 内部目录与隐藏文件必须跳过：.mdnotes/、assets/ 里的 .md，以及 .hidden.md。 */
func TestReconcileSkipsInternalAndHidden(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2, "nodes": []map[string]any{
			{"id": "a", "type": "note", "name": "A", "parentId": nil, "content": "a", "createdAt": "c", "updatedAt": "u"},
		},
	}})
	// 这些都不该被当成笔记
	dropFile(t, dir, ".mdnotes/draft.md", "索引目录里的")
	dropFile(t, dir, "assets/draft.md", "图片库里的")
	dropFile(t, dir, ".hidden.md", "隐藏文件")

	res := call(t, "notes/reconcile", map[string]any{}).(map[string]any)
	if asF64(res["added"]) != 0 {
		t.Fatalf("内部目录/隐藏文件的 .md 不该被补登，实际 added=%v", res["added"])
	}
}

/* 非 markdown 文件（如 .txt）必须跳过。 */
func TestReconcileSkipsNonMarkdown(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2, "nodes": []map[string]any{
			{"id": "a", "type": "note", "name": "A", "parentId": nil, "content": "a", "createdAt": "c", "updatedAt": "u"},
		},
	}})
	dropFile(t, dir, "readme.txt", "这是说明文档不是笔记")

	res := call(t, "notes/reconcile", map[string]any{}).(map[string]any)
	if asF64(res["added"]) != 0 {
		t.Fatalf(".txt 不该被当成笔记，实际 added=%v", res["added"])
	}
}

/* 存储目录未配置时不能崩，应原样返回、added=0。 */
func TestReconcileRequiresConfiguredDir(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2, "nodes": []map[string]any{
			{"id": "a", "type": "note", "name": "A", "parentId": nil, "content": "a", "createdAt": "c", "updatedAt": "u"},
		},
	}})
	dropFile(t, dir, "orphan.md", "x")

	// 清掉当前目录（模拟未配置），reconcile 必须不报错、不扫描
	dirMu.Lock()
	currentDir = ""
	dirMu.Unlock()

	res := call(t, "notes/reconcile", map[string]any{}).(map[string]any)
	if asF64(res["added"]) != 0 {
		t.Fatalf("未配置目录时不应扫描补登，实际 added=%v", res["added"])
	}
	if res["skipped"] != true {
		t.Fatalf("未配置目录时应标记 skipped=true，实际 %v", res["skipped"])
	}
	// 还原，避免影响同包其它用例
	setDir(dir)
}
