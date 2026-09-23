// AI 接入：把笔记交给第三方模型做分析 / 润色 / 续写 / 问答。
//
// 为什么走侧车而不是前端：
//   - 插件 UI 在沙箱里没有网络，前端直连要声明 host.network:https://origin（≤8 个、仅 HTTPS、
//     不允许路径/通配符、仍受 CORS），而第三方网关常带自定义路径 —— 侧车网络不受这些限制。
//   - 连接密钥只会被宿主补齐给「后端生命周期请求」（connection/test|connect|action），
//     前端只有 connectionId。所以密钥只能在侧车用，也绝不允许进日志 / 错误信息 / 前端响应。
//
// 为什么不用宿主的 host.ai（内置 AI 面板）：
//   那个接口只是「打开一个带数据快照的对话」，既不返回模型回复、也不暴露模型配置，
//   做不了「AI 结果写回笔记」这件核心事；而权限声明是静态的，旧宿主遇到未知权限会在
//   安装阶段直接拒绝 —— 等于为一个用不上的入口把 <0.6.20 的用户全挡在门外。
//
// 配置分两层（本文件的核心设计）：
//   aiConn  —— 连接参数带来的（external_config.ai_* / connection_secrets.ai_api_key），易失；
//              每次 connection/connect 前清空重填，disconnect 时清空。
//   aiLocal —— 用户在「AI 助手栏 → 配置」里改的，持久化到 <dataDir>/ai-config.json。
//   生效值 = 连接层打底 → 本机层逐字段覆盖非空值。
//   于是：连接里配好的人什么都不用管；在面板里改过的人不必回去改连接；面板里「清除本机配置」
//   一键回到「以连接配置为准」。
//
// 密钥的边界（安全底线）：
//   默认只在内存里。只有当用户在面板里显式勾选「在本机记住密钥」时，才会写进
//   <dataDir>/ai-config.json（0600，插件私有目录，不在笔记存储目录里）。
//   无论哪种情况，密钥都不会出现在日志、错误信息、RPC 响应（只回 hasKey 布尔）与笔记文件里。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

const (
	aiDefaultProvider   = "openai"
	aiDefaultTimeoutSecs = 60
	aiMinTimeoutSecs     = 5
	aiMaxTimeoutSecs     = 300
	aiDefaultMaxChars    = 12000
	aiMinMaxChars        = 500
	aiMaxMaxChars        = 200000
	aiMaxResponseBytes   = 4 << 20 // 单次响应体上限，防止被超大响应拖垮
)

// aiSettings 是一层配置。Enabled 用指针是为了区分「没提这件事」（nil）与「明确关闭」（false）。
type aiSettings struct {
	Enabled      *bool  `json:"enabled,omitempty"`
	Provider     string `json:"provider,omitempty"`
	BaseURL      string `json:"baseUrl,omitempty"`
	Model        string `json:"model,omitempty"`
	APIKey       string `json:"apiKey,omitempty"`
	SystemPrompt string `json:"systemPrompt,omitempty"`
	TimeoutSecs  int    `json:"timeoutSecs,omitempty"`
	MaxChars     int    `json:"maxChars,omitempty"`
}

// aiConfigFile 是本机层落盘的样子。
type aiConfigFile struct {
	aiSettings
	Version     int    `json:"version"`
	RememberKey bool   `json:"rememberKey,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
}

var (
	aiMu           sync.RWMutex
	aiConn         aiSettings // 连接层（易失）
	aiLocal        aiSettings // 本机层（面板保存，可持久化）
	aiLocalHasFile bool       // 本机是否已有保存的 AI 配置
	aiRememberKey  bool       // 本机文件里是否包含密钥
	aiLoaded       bool       // 是否已尝试从磁盘读取本机层
)

func aiConfigPath() string { return filepath.Join(dataDir(), "ai-config.json") }

/* ---------------- 本机层的读写 ---------------- */

func loadAIConfigFromDisk() {
	aiMu.Lock()
	defer aiMu.Unlock()
	aiLoaded = true

	b, err := os.ReadFile(aiConfigPath())
	if err != nil {
		return
	}
	var f aiConfigFile
	if json.Unmarshal(b, &f) != nil {
		// 文件损坏时当作没有，不阻断启动（下次保存会覆盖掉）
		sidecarTrace("ai-config.json 解析失败，已忽略")
		return
	}
	aiLocal = f.aiSettings
	aiRememberKey = f.RememberKey && f.APIKey != ""
	aiLocalHasFile = true
	sidecarTrace(fmt.Sprintf("ai-config 已加载 provider=%s model=%s hasKey=%v",
		aiLocal.Provider, aiLocal.Model, aiLocal.APIKey != ""))
}

// ensureAILoaded 懒加载：生产环境 main() 会先调一次；测试直接跑 Handler 时靠这里兜住。
func ensureAILoaded() {
	aiMu.RLock()
	done := aiLoaded
	aiMu.RUnlock()
	if done {
		return
	}
	loadAIConfigFromDisk()
}

// saveAILocalLocked 把本机层写盘。**只在调用方已持有 aiMu 时使用**。
// remember=false 时不写密钥（同时把文件里旧的密钥一并抹掉）。
func saveAILocalLocked(remember bool) error {
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	out := aiConfigFile{aiSettings: aiLocal, Version: 1,
		RememberKey: remember && aiLocal.APIKey != "", UpdatedAt: time.Now().Format(time.RFC3339)}
	if !out.RememberKey {
		out.APIKey = ""
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	path := aiConfigPath()
	if err := writeAtomic(path, append(b, '\n')); err != nil {
		return err
	}
	// 密钥在里面，权限收紧（Windows 上基本是 no-op，Unix 上有效）
	_ = os.Chmod(path, 0o600)
	return nil
}

/* ---------------- 生效值 ---------------- */

// applyOver 用 src 的非空字段覆盖 dst（连接层打底、本机层覆盖，就是靠这个函数叠出来的）。
func applyOver(dst *aiSettings, src aiSettings) {
	if src.Enabled != nil {
		v := *src.Enabled
		dst.Enabled = &v
	}
	if src.Provider != "" {
		dst.Provider = src.Provider
	}
	if src.BaseURL != "" {
		dst.BaseURL = src.BaseURL
	}
	if src.Model != "" {
		dst.Model = src.Model
	}
	if src.APIKey != "" {
		dst.APIKey = src.APIKey
	}
	if src.SystemPrompt != "" {
		dst.SystemPrompt = src.SystemPrompt
	}
	if src.TimeoutSecs > 0 {
		dst.TimeoutSecs = src.TimeoutSecs
	}
	if src.MaxChars > 0 {
		dst.MaxChars = src.MaxChars
	}
}

// aiMergeLocked 计算生效值。**只在调用方已持有 aiMu（读或写）时使用**。
func aiMergeLocked() aiSettings {
	out := aiSettings{Provider: aiDefaultProvider, TimeoutSecs: aiDefaultTimeoutSecs, MaxChars: aiDefaultMaxChars}
	applyOver(&out, aiConn)
	applyOver(&out, aiLocal)
	if out.TimeoutSecs <= 0 {
		out.TimeoutSecs = aiDefaultTimeoutSecs
	}
	if out.MaxChars <= 0 {
		out.MaxChars = aiDefaultMaxChars
	}
	if out.Provider == "" {
		out.Provider = aiDefaultProvider
	}
	return out
}

func aiEffective() aiSettings {
	ensureAILoaded()
	aiMu.RLock()
	defer aiMu.RUnlock()
	return aiMergeLocked()
}

// aiSnapshot 保留这个名字给日志与测试用：返回当前生效值。
func aiSnapshot() aiSettings { return aiEffective() }

func aiIsEnabled(c aiSettings) bool { return c.Enabled != nil && *c.Enabled }

/* ---------------- 从连接参数吸收（连接层） ---------------- */

var aiConnKeys = map[string]bool{
	"ai_enabled": true, "ai_provider": true, "ai_base_url": true, "ai_model": true,
	"ai_api_key": true, "ai_system_prompt": true, "ai_timeout_secs": true, "ai_max_chars": true,
}

// lookupKeys 在任意嵌套的 map/数组里按 key 名找值（与 storage_dir 的取法一致，容错优先）。
func lookupKeys(v any, keys map[string]bool, out map[string]any) {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if keys[k] {
				if _, seen := out[k]; !seen {
					out[k] = val
				}
			}
		}
		for _, val := range t {
			lookupKeys(val, keys, out)
		}
	case []any:
		for _, item := range t {
			lookupKeys(item, keys, out)
		}
	}
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case json.Number:
		return t.String()
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%v", t)
	case int:
		return fmt.Sprintf("%d", t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	}
	return ""
}

func asBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		return s == "true" || s == "1" || s == "yes" || s == "on"
	case float64:
		return t != 0
	}
	return false
}

func asInt(v any, def, min, max int) int {
	n := 0
	switch t := v.(type) {
	case float64:
		n = int(t)
	case int:
		n = t
	case string:
		_, err := fmt.Sscanf(strings.TrimSpace(t), "%d", &n)
		if err != nil {
			return def
		}
	default:
		return def
	}
	return clampInt(n, def, min, max)
}

// absorbAIConfig 从连接参数里吸收 AI 配置，只写连接层（易失），不落盘。
func absorbAIConfig(values map[string]any) {
	if len(values) == 0 {
		return
	}
	found := map[string]any{}
	lookupKeys(values, aiConnKeys, found)
	if len(found) == 0 {
		return
	}

	aiMu.Lock()
	defer aiMu.Unlock()
	if v, ok := found["ai_enabled"]; ok {
		b := asBool(v)
		aiConn.Enabled = &b
	}
	if v, ok := found["ai_provider"]; ok {
		if p := normalizeProvider(asString(v)); p != "" {
			aiConn.Provider = p
		}
	}
	if v, ok := found["ai_base_url"]; ok {
		if s := asString(v); s != "" {
			aiConn.BaseURL = s
		}
	}
	if v, ok := found["ai_model"]; ok {
		if s := asString(v); s != "" {
			aiConn.Model = s
		}
	}
	if v, ok := found["ai_api_key"]; ok {
		// 空串不覆盖已有密钥：用户编辑连接时留空表示"不改密码"。
		if s := asString(v); s != "" {
			aiConn.APIKey = s
		}
	}
	if v, ok := found["ai_system_prompt"]; ok {
		if s := asString(v); s != "" {
			aiConn.SystemPrompt = s
		}
	}
	if v, ok := found["ai_timeout_secs"]; ok {
		aiConn.TimeoutSecs = clampInt(asInt(v, aiDefaultTimeoutSecs, aiMinTimeoutSecs, aiMaxTimeoutSecs),
			aiDefaultTimeoutSecs, aiMinTimeoutSecs, aiMaxTimeoutSecs)
	}
	if v, ok := found["ai_max_chars"]; ok {
		aiConn.MaxChars = clampInt(asInt(v, aiDefaultMaxChars, aiMinMaxChars, aiMaxMaxChars),
			aiDefaultMaxChars, aiMinMaxChars, aiMaxMaxChars)
	}
}

func normalizeProvider(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "openai", "anthropic", "ollama":
		return strings.ToLower(strings.TrimSpace(s))
	}
	return ""
}

func clampInt(n, def, min, max int) int {
	if n <= 0 {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}

// resetAIConn 断开连接时清掉连接层（本机层是用户在本机的选择，保留）。
func resetAIConn() {
	aiMu.Lock()
	aiConn = aiSettings{}
	aiMu.Unlock()
}

// resetAIConfig 清空内存里的两层，并标记"已加载"以避免再去读本机文件。
// 仅供测试与内部使用 —— 它不会删除本机文件。
func resetAIConfig() {
	aiMu.Lock()
	defer aiMu.Unlock()
	aiConn = aiSettings{}
	aiLocal = aiSettings{}
	aiLocalHasFile = false
	aiRememberKey = false
	aiLoaded = true
}

/* ---------------- 状态与配置视图 ---------------- */

// aiConfigView 给前端的完整配置视图。**永远不含密钥本体**，只有 hasKey 布尔。
func aiConfigView() map[string]any {
	ensureAILoaded()
	aiMu.RLock()
	eff := aiMergeLocked()
	conn, local := aiConn, aiLocal
	hasFile, remember := aiLocalHasFile, aiRememberKey
	aiMu.RUnlock()

	missing := []string{}
	if !aiIsEnabled(eff) {
		missing = append(missing, "enabled")
	}
	if eff.BaseURL == "" {
		missing = append(missing, "baseUrl")
	}
	if eff.Model == "" {
		missing = append(missing, "model")
	}
	if eff.Provider != "ollama" && eff.APIKey == "" {
		missing = append(missing, "apiKey")
	}

	// 哪些字段是被本机（面板）配置顶掉的 —— 界面据此提示「清除本机配置」可回到连接配置
	overridden := []string{}
	if local.Enabled != nil {
		overridden = append(overridden, "enabled")
	}
	if local.Provider != "" {
		overridden = append(overridden, "provider")
	}
	if local.BaseURL != "" {
		overridden = append(overridden, "baseUrl")
	}
	if local.Model != "" {
		overridden = append(overridden, "model")
	}
	if local.SystemPrompt != "" {
		overridden = append(overridden, "systemPrompt")
	}
	if local.TimeoutSecs > 0 {
		overridden = append(overridden, "timeoutSecs")
	}
	if local.MaxChars > 0 {
		overridden = append(overridden, "maxChars")
	}
	keyFrom := ""
	if local.APIKey != "" {
		keyFrom = "local"
		overridden = append(overridden, "apiKey")
	} else if conn.APIKey != "" {
		keyFrom = "connection"
	}

	out := map[string]any{
		"enabled":        aiIsEnabled(eff),
		"provider":       eff.Provider,
		"baseUrl":        eff.BaseURL,
		"model":          eff.Model,
		"systemPrompt":   eff.SystemPrompt,
		"timeoutSecs":    eff.TimeoutSecs,
		"maxChars":       eff.MaxChars,
		"hasKey":         eff.APIKey != "",
		"keyFrom":        keyFrom,
		"keyOnDisk":      remember,
		"rememberKey":    remember,
		"hasLocalConfig": hasFile,
		"overridden":     overridden,
		"ready":          len(missing) == 0,
		"missing":        missing,
		"dataDir":        dataDir(),
	}
	return out
}

/* ---------------- 请求构造 ---------------- */

const aiDefaultSystem = "你是一位严谨的中文技术写作助手，服务于数据库工程师。回答直接、具体、不寒暄；" +
	"不要复述原文，不要输出与请求无关的建议。"

func aiTaskPrompt(task, text, instruction string) (system, user string) {
	switch task {
	case "analyze":
		return aiDefaultSystem,
			"请分析下面这篇笔记，输出：\n1) 3–6 条要点（每条一行，用 - 开头）\n2) 其中需要跟进的事项（没有就写\"无\"）\n3) 内容里相互矛盾或与事实明显不符之处（没有就写\"无\"）\n\n笔记正文：\n\n" + text
	case "polish":
		extra := ""
		if instruction != "" {
			extra = "\n额外要求：" + instruction
		}
		return aiDefaultSystem,
			"请润色下面的 Markdown 笔记：保持原意、保持 Markdown 结构与代码块不变，改善语句通顺度与用词准确度，" +
				"不要增删事实，不要加解释。**只输出润色后的正文本身**。" + extra + "\n\n笔记正文：\n\n" + text
	case "continue":
		extra := ""
		if instruction != "" {
			extra = "（写作方向：" + instruction + "）"
		}
		return aiDefaultSystem,
			"下面是一篇 Markdown 笔记，请在末尾自然地续写下去" + extra +
				"，保持原有风格与 Markdown 结构。**只输出续写的内容本身**，不要重复已有内容，不要加解释。\n\n已有内容：\n\n" + text
	case "ask":
		q := instruction
		if q == "" {
			q = "这篇笔记讲了什么？"
		}
		return aiDefaultSystem,
			"根据下面的笔记回答我的问题；笔记里没有的信息就直说没有，不要编造。\n\n问题：" + q + "\n\n笔记正文：\n\n" + text
	default:
		return aiDefaultSystem, text
	}
}

func aiEndpoint(c aiSettings) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if base == "" {
		return "", fmt.Errorf("未配置 API 地址")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("API 地址不是合法的 URL：%s", c.BaseURL)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("API 地址只支持 http/https")
	}
	path := strings.TrimRight(u.Path, "/")
	if c.Provider == "anthropic" {
		switch {
		case strings.HasSuffix(path, "/messages"):
		case strings.HasSuffix(path, "/v1"):
			path += "/messages"
		default:
			path += "/v1/messages"
		}
	} else {
		switch {
		case strings.HasSuffix(path, "/chat/completions"):
		case strings.HasSuffix(path, "/v1"):
			path += "/chat/completions"
		default:
			path += "/v1/chat/completions"
		}
	}
	u.Path = path
	return u.String(), nil
}

func redact(s string, c aiSettings) string {
	if c.APIKey != "" && len(c.APIKey) >= 8 {
		s = strings.ReplaceAll(s, c.APIKey, "***")
	}
	return s
}

// truncateChars 按字符（rune）截断，避免截出半个 UTF-8。
func truncateChars(s string, limit int) (string, bool) {
	if limit <= 0 || utf8.RuneCountInString(s) <= limit {
		return s, false
	}
	r := []rune(s)
	return string(r[:limit]), true
}

type aiResult struct {
	Content   string
	Model     string
	PromptTok int
	OutTok    int
	Truncated bool
	SentChars int
}

// aiCall 用给定的配置（而不是全局）发一次请求 —— 配置由调用方决定，
// 「测试连接」因此可以在不改动生效配置的前提下试一套未保存的参数。
func aiCall(reqText aiRequest, maxTokens int, c aiSettings) (*aiResult, error) {
	if !aiIsEnabled(c) {
		return nil, fmt.Errorf("AI 功能未启用：请在连接设置或 AI 助手栏的配置里勾选「启用 AI 功能」")
	}
	if c.Model == "" {
		return nil, fmt.Errorf("未配置模型名称")
	}
	endpoint, err := aiEndpoint(c)
	if err != nil {
		return nil, err
	}

	system := c.SystemPrompt
	if system == "" {
		system = aiTaskPromptSystem(reqText.Task)
	}
	text, truncated := truncateChars(reqText.Text, c.MaxChars)

	var body map[string]any
	headers := map[string]string{"Content-Type": "application/json"}

	if c.Provider == "anthropic" {
		body = map[string]any{
			"model":      c.Model,
			"max_tokens": maxTokens,
			"system":     system,
			"messages":   []map[string]any{{"role": "user", "content": aiTaskPromptUser(reqText, text)}},
		}
		if c.APIKey == "" {
			return nil, fmt.Errorf("未配置 API 密钥")
		}
		headers["x-api-key"] = c.APIKey
		headers["anthropic-version"] = "2023-06-01"
	} else {
		body = map[string]any{
			"model":      c.Model,
			"max_tokens": maxTokens,
			"messages": []map[string]any{
				{"role": "system", "content": system},
				{"role": "user", "content": aiTaskPromptUser(reqText, text)},
			},
		}
		if c.Provider != "ollama" {
			if c.APIKey == "" {
				return nil, fmt.Errorf("未配置 API 密钥")
			}
			headers["Authorization"] = "Bearer " + c.APIKey
		}
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("构造请求失败：%v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(c.TimeoutSecs)*time.Second)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("构造请求失败：%v", err)
	}
	for k, v := range headers {
		httpReq.Header.Set(k, v)
	}

	client := &http.Client{Timeout: time.Duration(c.TimeoutSecs) * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("请求超时（%d 秒）：模型没有在限定时间内响应，可在 AI 助手栏的配置里调大超时", c.TimeoutSecs)
		}
		return nil, fmt.Errorf("连接模型服务失败：%s", redact(err.Error(), c))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, aiMaxResponseBytes))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s", aiHTTPError(resp.StatusCode, raw, c))
	}

	out := &aiResult{Truncated: truncated, SentChars: utf8.RuneCountInString(text)}
	if c.Provider == "anthropic" {
		var r struct {
			Model   string `json:"model"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Usage struct {
				Input  int `json:"input_tokens"`
				Output int `json:"output_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, fmt.Errorf("无法解析模型返回：%s", redact(snippet(raw), c))
		}
		for _, part := range r.Content {
			if part.Type == "text" || part.Type == "" {
				out.Content += part.Text
			}
		}
		out.Model, out.PromptTok, out.OutTok = r.Model, r.Usage.Input, r.Usage.Output
	} else {
		var r struct {
			Model   string `json:"model"`
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
				Text string `json:"text"`
			} `json:"choices"`
			Usage struct {
				Prompt     int `json:"prompt_tokens"`
				Completion int `json:"completion_tokens"`
			} `json:"usage"`
			Error any `json:"error"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, fmt.Errorf("无法解析模型返回：%s", redact(snippet(raw), c))
		}
		if len(r.Choices) > 0 {
			out.Content = r.Choices[0].Message.Content
			if out.Content == "" {
				out.Content = r.Choices[0].Text
			}
		}
		out.Model, out.PromptTok, out.OutTok = r.Model, r.Usage.Prompt, r.Usage.Completion
	}
	out.Content = strings.TrimSpace(out.Content)
	if out.Content == "" {
		return nil, fmt.Errorf("模型返回了空内容")
	}
	return out, nil
}

func aiTaskPromptSystem(task string) string {
	s, _ := aiTaskPrompt(task, "", "")
	return s
}

func aiTaskPromptUser(req aiRequest, text string) string {
	_, u := aiTaskPrompt(req.Task, text, req.Instruction)
	return u
}

// snippet 给错误信息带一点响应体上下文，但不泄漏密钥。
func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 300 {
		s = s[:300] + "…"
	}
	if s == "" {
		return "(空响应)"
	}
	return s
}

func aiHTTPError(status int, body []byte, c aiSettings) string {
	detail := snippet(body)
	switch status {
	case 401, 403:
		return fmt.Sprintf("鉴权失败（HTTP %d）：API 密钥无效或没有权限。%s", status, redact(detail, c))
	case 404:
		return fmt.Sprintf("找不到接口（HTTP 404）：请检查 API 地址是否正确（需要包含 /v1 之类的版本路径）。%s", redact(detail, c))
	case 429:
		return fmt.Sprintf("被限流（HTTP 429）：请求过于频繁或额度用尽。%s", redact(detail, c))
	}
	if status >= 500 {
		return fmt.Sprintf("模型服务异常（HTTP %d）：稍后重试。%s", status, redact(detail, c))
	}
	return fmt.Sprintf("请求失败（HTTP %d）：%s", status, redact(detail, c))
}

/* ---------------- RPC ---------------- */

type aiRequest struct {
	Task        string `json:"task"`
	Text        string `json:"text"`
	Instruction string `json:"instruction"`
}

func aiChatHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var req aiRequest
	if e := json.Unmarshal(raw, &req); e != nil {
		return nil, badParams("invalid params: %v", e)
	}
	if strings.TrimSpace(req.Text) == "" {
		return nil, badParams("缺少要处理的正文")
	}
	switch req.Task {
	case "analyze", "polish", "continue", "ask":
	default:
		return nil, badParams("不支持的 AI 任务：%s", req.Task)
	}
	cfg := aiEffective()
	started := time.Now()
	maxTokens := 2048
	if req.Task == "analyze" || req.Task == "continue" {
		maxTokens = 1600
	}
	res, err := aiCall(req, maxTokens, cfg)
	if err != nil {
		sidecarTrace("ai/chat FAILED task=" + req.Task + " model=" + cfg.Model + " err=" + err.Error())
		return nil, failed(-32010, err)
	}
	sidecarTrace(fmt.Sprintf("ai/chat ok task=%s model=%s chars=%d truncated=%v ms=%d",
		req.Task, res.Model, res.SentChars, res.Truncated, time.Since(started).Milliseconds()))
	return map[string]any{
		"content":   res.Content,
		"model":     res.Model,
		"usage":     map[string]any{"promptTokens": res.PromptTok, "completionTokens": res.OutTok},
		"truncated": res.Truncated,
		"sentChars": res.SentChars,
		"latencyMs": time.Since(started).Milliseconds(),
	}, nil
}

// setConfigParams 只处理"传了的字段"，没传的保持原样（面板里的密码框留空 = 不改密钥）。
type setConfigParams struct {
	Enabled      *bool   `json:"enabled"`
	Provider     *string `json:"provider"`
	BaseURL      *string `json:"baseUrl"`
	Model        *string `json:"model"`
	APIKey       string  `json:"apiKey"`
	ClearKey     bool    `json:"clearKey"`
	SystemPrompt *string `json:"systemPrompt"`
	TimeoutSecs  *int    `json:"timeoutSecs"`
	MaxChars     *int    `json:"maxChars"`
	RememberKey  *bool   `json:"rememberKey"`
	Persist      *bool   `json:"persist"`
}

// aiSetConfigHandler 更新本机层。persist=false 时只改内存（不落盘）。
func aiSetConfigHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p setConfigParams
	if e := json.Unmarshal(raw, &p); e != nil {
		return nil, badParams("invalid params: %v", e)
	}
	ensureAILoaded()

	aiMu.Lock()
	if p.Enabled != nil {
		v := *p.Enabled
		aiLocal.Enabled = &v
	}
	if p.Provider != nil {
		if v := normalizeProvider(*p.Provider); v != "" {
			aiLocal.Provider = v
		}
	}
	if p.BaseURL != nil {
		aiLocal.BaseURL = strings.TrimSpace(*p.BaseURL)
	}
	if p.Model != nil {
		aiLocal.Model = strings.TrimSpace(*p.Model)
	}
	if p.SystemPrompt != nil {
		aiLocal.SystemPrompt = *p.SystemPrompt
	}
	if p.TimeoutSecs != nil {
		aiLocal.TimeoutSecs = clampInt(*p.TimeoutSecs, aiDefaultTimeoutSecs, aiMinTimeoutSecs, aiMaxTimeoutSecs)
	}
	if p.MaxChars != nil {
		aiLocal.MaxChars = clampInt(*p.MaxChars, aiDefaultMaxChars, aiMinMaxChars, aiMaxMaxChars)
	}
	if p.ClearKey {
		aiLocal.APIKey = ""
	} else if k := strings.TrimSpace(p.APIKey); k != "" {
		aiLocal.APIKey = k
	}
	remember := aiRememberKey
	if p.RememberKey != nil {
		remember = *p.RememberKey
	}
	// 连接参数里已经有密钥、用户又在面板里填了新的，就默认按"记住"处理？不 ——
	// 落盘与否必须由用户显式勾选决定，不做隐式推断。
	persist := p.Persist == nil || *p.Persist
	var saveErr error
	if persist {
		if saveErr = saveAILocalLocked(remember); saveErr == nil {
			aiLocalHasFile = true
			aiRememberKey = remember && aiLocal.APIKey != ""
		}
	}
	keyOnDisk := aiRememberKey
	model := aiLocal.Model
	aiMu.Unlock()

	if saveErr != nil {
		sidecarTrace("ai/setConfig 保存失败：" + saveErr.Error())
		return nil, failed(-32011, fmt.Errorf("保存 AI 配置失败：%v", saveErr))
	}
	sidecarTrace(fmt.Sprintf("ai/setConfig ok persist=%v enabled=%v model=%s hasKey=%v keyOnDisk=%v",
		persist, p.Enabled != nil && *p.Enabled, model, p.APIKey != "", keyOnDisk))
	out := aiConfigView()
	out["saved"] = persist
	return out, nil
}

// aiResetConfigHandler 清掉本机层（含磁盘文件），回到「以连接配置为准」。
func aiResetConfigHandler() (any, *dbxpluginsdk.PluginError) {
	ensureAILoaded()
	aiMu.Lock()
	aiLocal = aiSettings{}
	aiLocalHasFile = false
	aiRememberKey = false
	aiMu.Unlock()
	if err := os.Remove(aiConfigPath()); err != nil && !os.IsNotExist(err) {
		return nil, failed(-32011, fmt.Errorf("删除本机 AI 配置失败：%v", err))
	}
	sidecarTrace("ai/resetConfig ok")
	out := aiConfigView()
	out["saved"] = true
	return out, nil
}

// testParams 允许「测试一组还没保存的参数」：留空的字段沿用当前生效值。
type testParams struct {
	Enabled      *bool  `json:"enabled"`
	Provider     string `json:"provider"`
	BaseURL      string `json:"baseUrl"`
	Model        string `json:"model"`
	APIKey       string `json:"apiKey"`
	SystemPrompt string `json:"systemPrompt"`
	TimeoutSecs  int    `json:"timeoutSecs"`
}

// aiTestHandler 用给定参数（留空则用当前生效配置）发一次最小请求。
// **不修改生效配置** —— 测坏了不会把用户原本能用的配置搞坏。
func aiTestHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p testParams
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}
	cfg := aiEffective()
	ov := aiSettings{Enabled: p.Enabled, Provider: normalizeProvider(p.Provider),
		BaseURL: strings.TrimSpace(p.BaseURL), Model: strings.TrimSpace(p.Model),
		APIKey: strings.TrimSpace(p.APIKey), SystemPrompt: p.SystemPrompt, TimeoutSecs: p.TimeoutSecs}
	applyOver(&cfg, ov)

	if !aiIsEnabled(cfg) {
		return map[string]any{"success": false, "message": "AI 功能未启用：请勾选「启用 AI 功能」"}, nil
	}
	if cfg.BaseURL == "" || cfg.Model == "" {
		return map[string]any{"success": false, "message": "请先填写 API 地址与模型名称"}, nil
	}
	started := time.Now()
	res, err := aiCall(aiRequest{Task: "ask", Text: "ping", Instruction: "只回复两个字：正常"}, 32, cfg)
	if err != nil {
		sidecarTrace("ai/test FAILED err=" + err.Error())
		return map[string]any{"success": false, "message": err.Error()}, nil
	}
	model := res.Model
	if model == "" {
		model = cfg.Model
	}
	return map[string]any{
		"success": true,
		"message": fmt.Sprintf("连接成功：%s（%s）· 耗时 %d ms · 返回：%s",
			model, cfg.Provider, time.Since(started).Milliseconds(), snippet([]byte(res.Content))),
	}, nil
}

// aiTest 供连接表单的「测试 AI 连接」动作使用：用当前已吸收的连接参数试一次。
func aiTest() (any, *dbxpluginsdk.PluginError) { return aiTestHandler(nil) }
