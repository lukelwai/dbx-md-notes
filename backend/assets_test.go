package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

/* 造一个「图片」：侧车不 sniff 内容，只看字节，所以用可辨认的假数据即可。 */
func fakeImg(tag string) []byte {
	return []byte("FAKEIMG:" + tag + ":" + strings.Repeat("x", 64))
}

/* asF64：侧车返回值在同进程里是 int、过 JSON 后是 float64，两种都得认。 */
func asF64(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	}
	return -1
}

func putAsset(t *testing.T, mime string, data []byte) (map[string]any, *dbxpluginsdk.PluginError) {
	t.Helper()
	res, perr := callRaw(t, "notes/putAsset", map[string]any{
		"mime":       mime,
		"dataBase64": base64.StdEncoding.EncodeToString(data),
		"name":       "whatever.png",
	})
	if perr != nil {
		return nil, perr
	}
	return res.(map[string]any), nil
}

func TestAssetPutGetRoundtrip(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)

	img := fakeImg("roundtrip")
	res, perr := putAsset(t, "image/png", img)
	if perr != nil {
		t.Fatalf("putAsset error: %s", perr.Message)
	}
	m := res
	rel, _ := m["relPath"].(string)
	if !strings.HasPrefix(rel, "assets/") || !strings.HasSuffix(rel, ".png") {
		t.Fatalf("relPath 形状不对：%q", rel)
	}
	// 同进程调用不过 JSON，数值是 int；走桥接时才是 float64 —— 两种都要认
	if asF64(m["bytes"]) != float64(len(img)) {
		t.Fatalf("bytes 不对：%v", m["bytes"])
	}
	// 文件名里必须带内容哈希前缀：同一张图重复粘贴得到同一个名字，不会堆一堆重复文件
	if !strings.Contains(rel, "-") {
		t.Fatalf("文件名缺少时间戳-哈希结构：%q", rel)
	}

	// 真实落盘
	abs := filepath.Join(dir, filepath.FromSlash(rel))
	if st, err := os.Stat(abs); err != nil || st.Size() != int64(len(img)) {
		t.Fatalf("文件没落盘或大小不对：%v size=%d", err, st.Size())
	}

	// 读回
	got, gerr := callRaw(t, "notes/getAsset", map[string]any{"relPath": rel})
	if gerr != nil {
		t.Fatalf("getAsset error: %s", gerr.Message)
	}
	gm := got.(map[string]any)
	raw, err := base64.StdEncoding.DecodeString(gm["dataBase64"].(string))
	if err != nil {
		t.Fatalf("base64 解码失败：%v", err)
	}
	if string(raw) != string(img) {
		t.Fatalf("读回的字节与写入不一致")
	}
	if gm["mime"].(string) != "image/png" {
		t.Fatalf("mime 不对：%v", gm["mime"])
	}
}

func TestAssetSameContentSameName(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)

	img := fakeImg("dedupe")
	r1, e1 := putAsset(t, "image/png", img)
	r2, e2 := putAsset(t, "image/png", img)
	if e1 != nil || e2 != nil {
		t.Fatalf("putAsset 失败：%v %v", e1, e2)
	}
	// 同一秒内两次粘贴：时间戳相同 → 靠哈希前缀才能区分；不同秒则名字不同。
	// 无论哪种都不该报错，且都必须是 assets/ 下的合法相对路径。
	for _, r := range []map[string]any{r1, r2} {
		if _, err := safeAssetRel(r["relPath"].(string)); err != nil {
			t.Fatalf("生成了不合法的相对路径：%v", err)
		}
	}
}

func TestAssetPathTraversalRejected(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	// 放一个"敏感"文件在存储目录根部，穿越读取必须失败
	if err := os.WriteFile(filepath.Join(dir, "secret.md"), []byte("top secret"), 0o644); err != nil {
		t.Fatalf("造 secret.md 失败：%v", err)
	}

	bad := []string{
		"../secret.md",
		"assets/../secret.md",
		"assets/../../secret.md",
		`assets\..\secret.md`, // Windows 反斜杠也是穿越
		"/etc/passwd",
		"C:/Windows/win.ini",
		"assets/",
		"assets",
		"secret.md",
		"assets//x.png",
		"./assets/x.png",
		"",
	}
	for _, rel := range bad {
		if _, perr := callRaw(t, "notes/getAsset", map[string]any{"relPath": rel}); perr == nil {
			t.Fatalf("路径 %q 应该被拒绝，却读成功了", rel)
		}
	}

	// 正面：合法路径仍然读得到
	res, perr := putAsset(t, "image/png", fakeImg("ok"))
	if perr != nil {
		t.Fatalf("putAsset 失败：%s", perr.Message)
	}
	rel := res["relPath"].(string)
	if _, gerr := callRaw(t, "notes/getAsset", map[string]any{"relPath": rel}); gerr != nil {
		t.Fatalf("合法路径读不回来：%s", gerr.Message)
	}
}

func TestAssetTypeAndSizeGuards(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)

	// 类型白名单
	if _, perr := putAsset(t, "application/x-msdownload", []byte("MZ...")); perr == nil {
		t.Fatalf("非图片类型应该被拒绝")
	}
	if _, perr := putAsset(t, "", []byte("x")); perr == nil {
		t.Fatalf("空 mime 应该被拒绝")
	}
	// 空数据
	if _, perr := putAsset(t, "image/png", nil); perr == nil {
		t.Fatalf("空图片数据应该被拒绝")
	}
	// 超大
	big := make([]byte, maxAssetBytes+1)
	if _, perr := putAsset(t, "image/png", big); perr == nil {
		t.Fatalf("超过上限应该被拒绝")
	}
	// 合法小图仍然成功
	if _, perr := putAsset(t, "image/jpeg", fakeImg("jpg")); perr != nil {
		t.Fatalf("jpeg 应该被接受：%s", perr.Message)
	}
}

func TestAssetRequiresConfiguredDir(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir) // 测完还原，避免影响同包的其它用例

	// 清掉当前目录：此时 notesDir() 会退到隐藏的默认目录，必须明确报错而不是悄悄写进去
	dirMu.Lock()
	currentDir = ""
	dirMu.Unlock()

	if _, perr := putAsset(t, "image/png", fakeImg("nodir")); perr == nil {
		t.Fatalf("未配置存储目录时应该拒绝，而不是写进用户找不到的目录")
	}
}

/* ============================================================
 * 备份 / 恢复 与图片资源
 * ------------------------------------------------------------
 * 事故背景：图片能粘贴进笔记，但「备份」只打包了 .md 与索引，**漏了 assets/** ——
 * 于是备份出来的库每张图都变成「图片缺失」。这里把两条路都锁死。
 * ============================================================ */

/* zipEntries 把备份字节解成 {条目名: 内容}。 */
func zipEntries(t *testing.T, raw []byte) map[string][]byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("备份不是合法 zip：%v", err)
	}
	out := map[string][]byte{}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, e := f.Open()
		if e != nil {
			t.Fatalf("打开条目 %s：%v", f.Name, e)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		out[f.Name] = b
	}
	return out
}

/* backupToBytes 走真实 RPC 备份整库，返回 zip 字节。 */
func backupToBytes(t *testing.T, scope string) []byte {
	t.Helper()
	res := call(t, "notes/backup", map[string]any{"scope": scope})
	m := res.(map[string]any)
	b64, _ := m["dataBase64"].(string)
	if b64 == "" {
		t.Fatalf("备份没有回传字节：%v", m)
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("备份不是合法 base64：%v", err)
	}
	return raw
}

/* seedNoteWithImages 造一篇正文引用两张图的笔记，并真的把图写进 assets/。
 * 返回 {相对路径: 字节}。 */
func seedNoteWithImages(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	setDir(dir)
	imgs := map[string][]byte{"p1": fakeImg("p1"), "p2": fakeImg("p2")}
	rels := map[string]string{}
	for tag, data := range imgs {
		m, perr := putAsset(t, "image/png", data)
		if perr != nil {
			t.Fatalf("putAsset(%s)：%s", tag, perr.Message)
		}
		rels[tag] = m["relPath"].(string)
	}
	body := "# 带图的笔记\n\n![一](" + rels["p1"] + ")\n\n![二](" + rels["p2"] + ")\n"
	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2, "activeId": "n-img",
		"nodes": []map[string]any{
			{"id": "n-img", "type": "note", "name": "带图的笔记", "parentId": nil,
				"content": body, "createdAt": "c", "updatedAt": "u"},
			{"id": "n-plain", "type": "note", "name": "没图的笔记", "parentId": nil,
				"content": "# 没图\n\n纯文字。", "createdAt": "c", "updatedAt": "u"},
		},
	}})
	out := map[string][]byte{}
	for tag, rel := range rels {
		out[rel] = imgs[tag]
	}
	return out
}

// 整库备份必须带上 assets/ 下的每一张图（正文引用的 + 暂时没人引用的都要带）。
func TestBackupIncludesAllAssets(t *testing.T) {
	dir := t.TempDir()
	rels := seedNoteWithImages(t, dir)
	// 再放一张「没被任何正文引用」的图：整库备份也必须带（可能马上要用/临时没引用）
	orphan, perr := putAsset(t, "image/gif", fakeImg("orphan"))
	if perr != nil {
		t.Fatalf("putAsset(orphan)：%s", perr.Message)
	}
	rels[orphan["relPath"].(string)] = fakeImg("orphan")

	entries := zipEntries(t, backupToBytes(t, ""))

	for rel, data := range rels {
		got, ok := entries[rel]
		if !ok {
			t.Fatalf("备份里缺少图片 %s；实际条目有：%v", rel, keysOf(entries))
		}
		if !bytes.Equal(got, data) {
			t.Fatalf("图片 %s 内容不一致：%d vs %d 字节", rel, len(got), len(data))
		}
	}
	// 元信息里要能看出带了几张图（漏了它，用户无法从包外判断备份是否完整）
	infoRaw, ok := entries[backupInfoName]
	if !ok {
		t.Fatalf("备份缺少 %s", backupInfoName)
	}
	if !strings.Contains(string(infoRaw), `"assets": 3`) {
		t.Fatalf("备份元信息没记图片数量：%s", string(infoRaw))
	}
}

// 只备份单篇时，只带这篇引用到的图 —— 不能把整个图片库塞进去。
func TestBackupScopedIncludesOnlyReferencedAssets(t *testing.T) {
	dir := t.TempDir()
	setDir(dir)
	defer setDir(dir)

	mine := putAssetOnly(t, "image/png", fakeImg("mine"))
	stranger := putAssetOnly(t, "image/png", fakeImg("stranger"))

	call(t, "notes/save", map[string]any{"storage_dir": dir, "data": map[string]any{
		"version": 2, "activeId": "n-a",
		"nodes": []map[string]any{
			{"id": "n-a", "type": "note", "name": "引用了一张图", "parentId": nil,
				"content": "# 引用了一张图\n\n![我](" + mine + ")\n", "createdAt": "c", "updatedAt": "u"},
			{"id": "n-b", "type": "note", "name": "没引用", "parentId": nil,
				"content": "# 没引用\n\n纯文字。\n", "createdAt": "c", "updatedAt": "u"},
		},
	}})

	entries := zipEntries(t, backupToBytes(t, "n-a"))

	if _, ok := entries[mine]; !ok {
		t.Fatalf("单篇备份应带上它引用的图 %s；实际：%v", mine, keysOf(entries))
	}
	if _, ok := entries[stranger]; ok {
		t.Fatalf("单篇备份不该带上没人引用的图：%s", stranger)
	}
	if _, ok := entries["引用了一张图.md"]; !ok {
		t.Fatalf("单篇备份应包含正文；实际：%v", keysOf(entries))
	}
}

// 备份 → 恢复 的完整往返：**换一个空目录恢复，图片要原样回来**。
func TestRestoreBringsAssetsBack(t *testing.T) {
	src := t.TempDir()
	rels := seedNoteWithImages(t, src)
	raw := backupToBytes(t, "")
	b64 := base64.StdEncoding.EncodeToString(raw)

	dst := t.TempDir()
	setDir(dst)
	defer setDir(dst)
	// 让目标目录先有内容：恢复前会自动存一份 pre-restore 安全快照
	dstOld := putAssetOnly(t, "image/png", fakeImg("dst-old"))
	call(t, "notes/save", map[string]any{"storage_dir": dst, "data": map[string]any{
		"version": 2, "activeId": "n-old",
		"nodes": []map[string]any{{"id": "n-old", "type": "note", "name": "旧笔记", "parentId": nil,
			"content": "# 旧\n\n![旧](" + dstOld + ")\n", "createdAt": "c", "updatedAt": "u"}},
	}})

	res := call(t, "notes/restore", map[string]any{"dataBase64": b64})
	m := res.(map[string]any)
	if n := asF64(m["assets"]); int(n) != len(rels) {
		t.Fatalf("恢复回报的图片数不对：%v（期望 %d）", m["assets"], len(rels))
	}

	for rel, want := range rels {
		abs := filepath.Join(dst, filepath.FromSlash(rel))
		got, err := os.ReadFile(abs)
		if err != nil {
			t.Fatalf("恢复后找不到图片 %s：%v", rel, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("恢复后的图片 %s 内容不一致：%d vs %d 字节", rel, len(got), len(want))
		}
	}
	// 正文也要在（顺带确认别的条目没被这次改动影响）
	if _, err := os.Stat(filepath.Join(dst, "带图的笔记.md")); err != nil {
		t.Fatalf("恢复后正文缺失：%v", err)
	}
	// 安全快照必须也带图，否则「恢复错了退回去」会退成一个缺图的库
	sp, _ := m["safetyPath"].(string)
	if sp == "" {
		t.Fatalf("目标目录原本有内容，却没有生成 pre-restore 安全快照：%v", m)
	}
	se := zipEntries(t, mustRead(t, sp))
	if _, ok := se[dstOld]; !ok {
		t.Fatalf("pre-restore 安全快照里没有原来的图片 %s（退回去也会缺图）；快照条目：%v",
			dstOld, keysOf(se))
	}
}

// 备份包是不可信输入：assets/ 下塞非图片扩展名，不能解出来。
func TestRestoreIgnoresNonImageUnderAssets(t *testing.T) {
	dst := t.TempDir()
	setDir(dst)
	defer setDir(dst)

	call(t, "notes/save", map[string]any{"storage_dir": dst, "data": map[string]any{
		"version": 2, "activeId": "n1",
		"nodes": []map[string]any{{"id": "n1", "type": "note", "name": "N", "parentId": nil,
			"content": "x", "createdAt": "c", "updatedAt": "u"}},
	}})

	zipBytes := craftZip(t, map[string][]byte{
		backupMetaEntry:          mustRead(t, metaPath()),
		"assets/ok.png":          fakeImg("ok"),
		"assets/evil.exe":        []byte("MZ fake binary"),
		"assets/sneaky.md":       []byte("# 假装是笔记"),
		"assets/inner/note.txt":  []byte("txt"),
	})
	call(t, "notes/restore", map[string]any{"dataBase64": base64.StdEncoding.EncodeToString(zipBytes)})

	if _, err := os.Stat(filepath.Join(dst, "assets", "ok.png")); err != nil {
		t.Fatalf("合法图片应该被恢复：%v", err)
	}
	for _, bad := range []string{"assets/evil.exe", "assets/sneaky.md", "assets/inner/note.txt"} {
		if _, err := os.Stat(filepath.Join(dst, filepath.FromSlash(bad))); err == nil {
			t.Fatalf("不该把 %s 解出来（备份包是不可信输入）", bad)
		}
	}
}

// 包内图片超过 8 MiB 上限（与 putAsset/getAsset 一致）→ 明确报错，不静默写盘。
func TestRestoreRejectsOversizedAsset(t *testing.T) {
	dst := t.TempDir()
	setDir(dst)
	defer setDir(dst)

	call(t, "notes/save", map[string]any{"storage_dir": dst, "data": map[string]any{
		"version": 2, "activeId": "n1",
		"nodes": []map[string]any{{"id": "n1", "type": "note", "name": "N", "parentId": nil,
			"content": "x", "createdAt": "c", "updatedAt": "u"}},
	}})

	big := make([]byte, maxAssetBytes+1024)
	zipBytes := craftZip(t, map[string][]byte{
		backupMetaEntry:  mustRead(t, metaPath()),
		"assets/big.png": big,
	})
	if _, perr := callRaw(t, "notes/restore", map[string]any{
		"dataBase64": base64.StdEncoding.EncodeToString(zipBytes)}); perr == nil {
		t.Fatalf("超限图片应该被拒绝")
	}
	if _, err := os.Stat(filepath.Join(dst, "assets", "big.png")); err == nil {
		t.Fatalf("被拒绝的包不该留下任何图片")
	}
}

/* ---------- 小工具 ---------- */

func putAssetOnly(t *testing.T, mime string, data []byte) string {
	t.Helper()
	m, perr := putAsset(t, mime, data)
	if perr != nil {
		t.Fatalf("putAsset：%s", perr.Message)
	}
	return m["relPath"].(string)
}

func craftZip(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var sb strings.Builder
	zw := zip.NewWriter(&writerCapture{&sb})
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("造 zip 条目 %s：%v", name, err)
		}
		_, _ = w.Write(data)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("关闭 zip：%v", err)
	}
	return []byte(sb.String())
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("读 %s：%v", p, err)
	}
	return b
}

func keysOf(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
