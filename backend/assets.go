package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

/*
图片资源（粘贴 / 拖入的图片）
============================================================================
设计取舍：**落成真实文件，markdown 里只写相对路径** `assets/xxx.png`。

为什么不内嵌 base64：
  - 一张截图 base64 后体积涨 1/3，塞进 .md 会让整篇笔记的读写都变重
    （我们整库是一次性快照读写，还受 2 MiB 桥接上限约束）；
  - 外部编辑器（VS Code / Obsidian）打开就是一堆乱码，用户根本没法维护；
  - 相对路径方案天然可移植：备份 zip 带上 assets/ 目录，换台机器照样看得到图。

为什么必须走侧车：沙箱前端没有磁盘权限（CSP default-src 'none'，且 window.origin
是 opaque origin），**唯一落盘通道就是侧车**。前端只负责把压缩后的字节交给它。
*/

const (
	// maxAssetBytes：前端压缩后仍可能很大。与「侧车单行 JSON 上限」对齐 —— 字节走
	// base64 传输，8MB 已经是 4/3 膨胀后的量级。
	maxAssetBytes = 8 * 1024 * 1024
	assetsDirName = "assets"
)

// assetExtByMime：白名单。只放这些类型，避免前端把任意文件塞进 assets/。
var assetExtByMime = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

func assetsDir() string { return filepath.Join(notesDir(), assetsDirName) }

type putAssetParams struct {
	Mime       string `json:"mime"`
	DataBase64 string `json:"dataBase64"`
	// Name 只用于日志，不作为文件名 —— 文件名由时间戳 + 内容哈希生成，
	// 否则用户粘贴一个叫 "../../x" 的文件名就成了路径穿越的面。
	Name string `json:"name"`
}

// notes/putAsset：把前端压缩后的图片写进 <storage_dir>/assets/。
// 返回 { relPath, bytes, sha256, mime }；relPath 就是要写进 markdown 的相对路径。
func putAssetHandler(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p putAssetParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, badParams("invalid params: %v", err)
	}
	mime := strings.ToLower(strings.TrimSpace(p.Mime))
	ext, ok := assetExtByMime[mime]
	if !ok {
		return nil, badParams("unsupported image type '%s'（只支持 png / jpeg / gif / webp）", p.Mime)
	}
	if strings.TrimSpace(p.DataBase64) == "" {
		return nil, badParams("missing image data")
	}
	raw, err := base64.StdEncoding.DecodeString(p.DataBase64)
	if err != nil {
		return nil, badParams("image data is not valid base64: %v", err)
	}
	if len(raw) == 0 {
		return nil, badParams("image data is empty")
	}
	if len(raw) > maxAssetBytes {
		return nil, badParams("image is too large: %d bytes（上限 %d）", len(raw), maxAssetBytes)
	}
	if !dirConfigured() {
		// 没配存储目录时 notesDir() 会退到一个隐藏的默认目录里。写进去用户永远找不到，
		// 不如直接说清楚，让前端提示「先配置存储目录」。
		return nil, badParams("storage directory is not configured")
	}

	sum := sha256.Sum256(raw)
	name := fmt.Sprintf("%s-%s%s", time.Now().Format("20060102-150405"), hex.EncodeToString(sum[:4]), ext)
	rel := filepath.ToSlash(filepath.Join(assetsDirName, name))
	if err := writeAtomic(filepath.Join(assetsDir(), name), raw); err != nil {
		sidecarTrace("notes/putAsset FAILED " + err.Error())
		return nil, failed(-32003, fmt.Errorf("write asset failed: %w", err))
	}
	sidecarTrace(fmt.Sprintf("notes/putAsset ok %s bytes=%d", rel, len(raw)))
	return map[string]any{
		"relPath": rel,
		"bytes":   len(raw),
		"sha256":  hex.EncodeToString(sum[:]),
		"mime":    mime,
	}, nil
}

type getAssetParams struct {
	RelPath string `json:"relPath"`
	Path    string `json:"path"`
}

// notes/getAsset：按相对路径读回图片字节（预览用）。
// 只允许 assets/ 下的相对路径 —— 这是防目录穿越的正面战场，见 safeAssetRel。
func getAssetHandler(params json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p getAssetParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, badParams("invalid params: %v", err)
	}
	rel, err := safeAssetRel(firstNonEmpty(p.RelPath, p.Path))
	if err != nil {
		return nil, badParams("%v", err)
	}
	abs := filepath.Join(notesDir(), filepath.FromSlash(rel))
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		return nil, badParams("asset not found: %s", rel)
	}
	if st.Size() > maxAssetBytes {
		return nil, badParams("asset is too large: %d bytes（上限 %d）", st.Size(), maxAssetBytes)
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, failed(-32003, fmt.Errorf("read asset failed: %w", err))
	}
	return map[string]any{
		"relPath":   rel,
		"mime":      mimeByExt(filepath.Ext(abs)),
		"bytes":     len(b),
		"dataBase64": base64.StdEncoding.EncodeToString(b),
	}, nil
}

// mimeByExt：扩展名 → MIME。读回时文件就在自己目录里， sniff 一整张图反而浪费，
// 按扩展名给就够了；给不出就退回 application/octet-stream。
func mimeByExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	}
	return "application/octet-stream"
}

/*
safeAssetRel 归一化并校验「图片相对路径」。

规则（每条都对应一种真实攻击面）：
  - 只接受 `assets/...` 开头，段数 ≥2；
  - 反斜杠统一成正斜杠后再校验（`..\..\x` 在 Windows 上就是穿越）；
  - 任何一段都不允许 `..` / `.` / 空 —— 空段意味着 `//` 或首尾 `/`；
  - 拒绝绝对路径、盘符（`C:`）、以及以 `/` 开头的路径。
*/
func safeAssetRel(rel string) (string, error) {
	r := strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	if r == "" {
		return "", fmt.Errorf("asset path is empty")
	}
	if strings.HasPrefix(r, "/") || filepath.IsAbs(r) || strings.Contains(r, ":") {
		return "", fmt.Errorf("asset path must be relative: %s", rel)
	}
	parts := strings.Split(r, "/")
	for _, seg := range parts {
		if seg == "" || seg == "." || seg == ".." {
			return "", fmt.Errorf("unsafe asset path: %s", rel)
		}
	}
	if parts[0] != assetsDirName || len(parts) < 2 {
		return "", fmt.Errorf("asset path must start with '%s/': %s", assetsDirName, rel)
	}
	return strings.Join(parts, "/"), nil
}

/*
isImageAssetRel 判定「这个压缩包条目是不是一张可以解出来的图片」。

从备份恢复时用：**备份包是不可信输入**，不能因为条目名以 `assets/` 开头就照单全收 ——
否则一个改了扩展名的包就能往 assets/ 里解出 .exe / .sh / 覆盖用的 .md。
路径规则复用 safeAssetRel，扩展名另过一遍白名单。
*/
func isImageAssetRel(rel string) bool {
	if _, err := safeAssetRel(rel); err != nil {
		return false
	}
	return mimeByExt(filepath.Ext(rel)) != "application/octet-stream"
}
