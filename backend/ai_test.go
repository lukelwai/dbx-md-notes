package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	dbxpluginsdk "github.com/lwai/mdnotes/dbxsdk"
)

func callRaw(t *testing.T, method string, params any) (any, *dbxpluginsdk.PluginError) {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return (&plugin{}).Handle(dbxpluginsdk.RequestContext{}, method, raw, nil)
}

// connectParams 构造宿主真实下发的生命周期参数形状：
// {provider:{...}, connection:{external_config:{...}, connection_secrets:{...}}, runtime:{...}}
func connectParams(dir string, ai map[string]any, key string) map[string]any {
	ec := map[string]any{"storage_dir": dir}
	for k, v := range ai {
		ec[k] = v
	}
	conn := map[string]any{"id": "c-ai", "name": "MD 笔记", "external_config": ec}
	if key != "" {
		conn["connection_secrets"] = map[string]any{"ai_api_key": key}
	}
	return map[string]any{"provider": map[string]any{"id": "com.lwai.mdnotes.conn"}, "connection": conn,
		"connectionId": "c-ai", "runtime": map[string]any{"host": "127.0.0.1", "port": 0}}
}

func enableAI(t *testing.T, base, model, provider, key string, extra map[string]any) {
	t.Helper()
	resetAIConfig()
	ai := map[string]any{"ai_enabled": true, "ai_provider": provider, "ai_base_url": base, "ai_model": model}
	for k, v := range extra {
		ai[k] = v
	}
	absorbAIConfig(map[string]any{"connection": map[string]any{
		"external_config":    ai,
		"connection_secrets": map[string]any{"ai_api_key": key},
	}})
}

func fakeModel(t *testing.T, status int, body string, seen *http.Request, seenBody *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = *r
		}
		if seenBody != nil {
			b, _ := io.ReadAll(r.Body)
			*seenBody = string(b)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

const openAIJSON = `{"model":"fake-1","choices":[{"message":{"content":"润色后的正文"}}],` +
	`"usage":{"prompt_tokens":12,"completion_tokens":7}}`

func TestAIChatOpenAICompatible(t *testing.T) {
	var gotReq http.Request
	var gotBody string
	srv := fakeModel(t, 200, openAIJSON, &gotReq, &gotBody)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", "sk-secret-1234567890", nil)

	res, perr := callRaw(t, "ai/chat", map[string]any{"task": "polish", "text": "原文", "instruction": "更简洁"})
	if perr != nil {
		t.Fatalf("ai/chat 失败：%s", perr.Message)
	}
	out := res.(map[string]any)
	if out["content"] != "润色后的正文" {
		t.Fatalf("正文不对：%v", out["content"])
	}
	if gotReq.URL.Path != "/v1/chat/completions" {
		t.Fatalf("路径不对：%s", gotReq.URL.Path)
	}
	if gotReq.Header.Get("Authorization") != "Bearer sk-secret-1234567890" {
		t.Fatalf("鉴权头不对：%q", gotReq.Header.Get("Authorization"))
	}
	if !strings.Contains(gotBody, "润色") || !strings.Contains(gotBody, "更简洁") {
		t.Fatalf("提示词没带上任务与额外要求：%s", gotBody)
	}
	usage := out["usage"].(map[string]any)
	if usage["promptTokens"] != 12 || usage["completionTokens"] != 7 {
		t.Fatalf("usage 解析不对：%v", usage)
	}
}

func TestAIChatAnthropic(t *testing.T) {
	var gotReq http.Request
	srv := fakeModel(t, 200, `{"model":"claude-x","content":[{"type":"text","text":"分析结果"}],`+
		`"usage":{"input_tokens":3,"output_tokens":4}}`, &gotReq, nil)
	enableAI(t, srv.URL, "claude-x", "anthropic", "sk-ant-1234567890", nil)

	res, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "正文"})
	if perr != nil {
		t.Fatalf("ai/chat 失败：%s", perr.Message)
	}
	if res.(map[string]any)["content"] != "分析结果" {
		t.Fatalf("正文不对：%v", res)
	}
	if gotReq.URL.Path != "/v1/messages" {
		t.Fatalf("路径不对：%s", gotReq.URL.Path)
	}
	if gotReq.Header.Get("x-api-key") == "" || gotReq.Header.Get("anthropic-version") == "" {
		t.Fatalf("Anthropic 必需头缺失：%v", gotReq.Header)
	}
}

// 鉴权失败时必须给出可读中文，并且**不能把密钥回显到错误信息里**。
func TestAIChatAuthErrorRedactsKey(t *testing.T) {
	const key = "sk-super-secret-value-9999"
	srv := fakeModel(t, 401, `{"error":{"message":"invalid api key sk-super-secret-value-9999"}}`, nil, nil)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", key, nil)

	_, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "正文"})
	if perr == nil {
		t.Fatalf("401 应该报错")
	}
	if !strings.Contains(perr.Message, "鉴权失败") {
		t.Fatalf("错误信息不够可读：%s", perr.Message)
	}
	if strings.Contains(perr.Message, key) {
		t.Fatalf("错误信息泄漏了密钥：%s", perr.Message)
	}
}

func TestAIChatRejectsNonJSON(t *testing.T) {
	srv := fakeModel(t, 200, "<html>gateway error</html>", nil, nil)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", "sk-1234567890", nil)
	_, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "正文"})
	if perr == nil || !strings.Contains(perr.Message, "无法解析") {
		t.Fatalf("非 JSON 应给出可读错误，实际：%v", perr)
	}
}

func TestAIChatTruncatesLongText(t *testing.T) {
	var gotBody string
	srv := fakeModel(t, 200, openAIJSON, nil, &gotBody)
	enableAI(t, srv.URL+"/v1", "fake-1", "openai", "sk-1234567890", map[string]any{"ai_max_chars": 500})

	long := strings.Repeat("字", 1200)
	res, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": long})
	if perr != nil {
		t.Fatalf("ai/chat 失败：%s", perr.Message)
	}
	out := res.(map[string]any)
	if out["truncated"] != true {
		t.Fatalf("应标记已截断：%v", out)
	}
	if int(out["sentChars"].(int)) != 500 {
		t.Fatalf("送入应被截到 500 字符：%v", out["sentChars"])
	}
	if strings.Contains(gotBody, strings.Repeat("字", 1000)) {
		t.Fatalf("超长正文没有被截断")
	}
}

func TestAIChatRejectsUnknownTask(t *testing.T) {
	enableAI(t, "http://127.0.0.1:1/v1", "m", "openai", "sk-1234567890", nil)
	if _, perr := callRaw(t, "ai/chat", map[string]any{"task": "hack", "text": "x"}); perr == nil {
		t.Fatalf("未知任务应被拒")
	}
	if _, perr := callRaw(t, "ai/chat", map[string]any{"task": "analyze", "text": "  "}); perr == nil {
		t.Fatalf("空正文应被拒")
	}
}

func TestAIStatusReportsMissing(t *testing.T) {
	resetAIConfig()
	st := aiConfigView()
	if st["ready"] != false || st["enabled"] != false {
		t.Fatalf("未配置时应 ready=false：%v", st)
	}
	enableAI(t, "http://127.0.0.1:1/v1", "m", "openai", "", nil)
	st = aiConfigView()
	if st["ready"] != false || st["hasKey"] != false {
		t.Fatalf("缺密钥时应 ready=false：%v", st)
	}
	// Ollama 不需要密钥
	enableAI(t, "http://127.0.0.1:11434/v1", "qwen", "ollama", "", nil)
	if st = aiConfigView(); st["ready"] != true {
		t.Fatalf("ollama 无密钥也应 ready：%v", st)
	}
}

// 连接动作「测试 AI 连接」：参数里带的是**未保存的表单值**，也要能用。
func TestConnectionActionTestAI(t *testing.T) {
	resetAIConfig()
	srv := fakeModel(t, 200, openAIJSON, nil, nil)
	res, err := callRaw(t, "connection/action", map[string]any{
		"action": map[string]any{"id": "test-ai"},
		"connection": map[string]any{
			"external_config": map[string]any{
				"ai_enabled": true, "ai_provider": "openai",
				"ai_base_url": srv.URL + "/v1", "ai_model": "fake-1",
			},
			"connection_secrets": map[string]any{"ai_api_key": "sk-1234567890"},
		},
	})
	if err != nil {
		t.Fatalf("connection/action 失败：%s", err.Message)
	}
	out := res.(map[string]any)
	if out["success"] != true || !strings.Contains(out["message"].(string), "连接成功") {
		t.Fatalf("测试连接应成功：%v", out)
	}
	// 未启用 / 未知动作
	if _, err := callRaw(t, "connection/action", map[string]any{"action": map[string]any{"id": "nope"}}); err == nil {
		t.Fatalf("未知动作应报错")
	}
	resetAIConfig()
	res2, _ := callRaw(t, "connection/action", map[string]any{"action": map[string]any{"id": "test-ai"}})
	if res2.(map[string]any)["success"] != false {
		t.Fatalf("未启用时应返回 success=false：%v", res2)
	}
}

// connectAIConn 只填连接层（不清本机层）：用于验证「重连不会冲掉面板里的改动」。
func connectAIConn(t *testing.T, base, model, provider, key string) {
	t.Helper()
	resetAIConn()
	absorbAIConfig(map[string]any{"connection": map[string]any{
		"external_config": map[string]any{"ai_enabled": true, "ai_provider": provider,
			"ai_base_url": base, "ai_model": model},
		"connection_secrets": map[string]any{"ai_api_key": key},
	}})
}

/* ---------------- 分层配置：连接层 / 本机层 ---------------- */

// 面板保存的配置逐字段覆盖连接参数；「清除本机配置」后回到连接参数。
func TestAIConfigLocalOverridesConnection(t *testing.T) {
	t.Setenv("DBX_PLUGIN_DATA_DIR", t.TempDir())
	resetAIConfig()
	connectAIConn(t, "http://127.0.0.1:1/v1", "conn-model", "openai", "sk-conn-1234567890")
	if got := aiEffective().Model; got != "conn-model" {
		t.Fatalf("连接层未生效：%s", got)
	}

	res, perr := callRaw(t, "ai/setConfig", map[string]any{"model": "panel-model", "persist": true})
	if perr != nil {
		t.Fatalf("ai/setConfig 失败：%s", perr.Message)
	}
	if res.(map[string]any)["model"] != "panel-model" {
		t.Fatalf("返回值未反映新配置：%v", res)
	}
	eff := aiEffective()
	if eff.Model != "panel-model" {
		t.Fatalf("本机层应覆盖 model：%s", eff.Model)
	}
	if eff.BaseURL != "http://127.0.0.1:1/v1" || eff.APIKey != "sk-conn-1234567890" {
		t.Fatalf("未改动的字段应沿用连接层：%+v", eff)
	}

	// 重连（宿主每次打开工作台都会 connect）不该把面板里的改动冲掉
	connectAIConn(t, "http://127.0.0.1:1/v1", "conn-model", "openai", "sk-conn-1234567890")
	if got := aiEffective().Model; got != "panel-model" {
		t.Fatalf("重连后本机层应仍优先：%s", got)
	}

	// 清除本机配置 → 回到连接参数
	if _, perr := callRaw(t, "ai/resetConfig", map[string]any{}); perr != nil {
		t.Fatalf("ai/resetConfig 失败：%s", perr.Message)
	}
	if got := aiEffective().Model; got != "conn-model" {
		t.Fatalf("清除后应回到连接配置：%s", got)
	}
}

// 安全底线（默认）：面板里填的密钥只在内存，不落盘；显式勾选「在本机记住密钥」后才写文件。
func TestAIPanelKeyNotOnDiskUnlessRemembered(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("DBX_PLUGIN_DATA_DIR", dataDir)
	resetAIConfig()
	const key = "sk-panel-key-abcdef123456"

	if _, e := callRaw(t, "ai/setConfig", map[string]any{
		"enabled": true, "provider": "openai", "baseUrl": "http://127.0.0.1:1/v1",
		"model": "panel-model", "apiKey": key, "persist": true,
	}); e != nil {
		t.Fatalf("setConfig 失败：%s", e.Message)
	}
	cfgPath := filepath.Join(dataDir, "ai-config.json")
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("配置文件应已生成：%v", err)
	}
	if strings.Contains(string(b), key) {
		t.Fatalf("默认不该把密钥写进磁盘：%s", b)
	}
	if aiEffective().APIKey != key {
		t.Fatalf("会话内密钥应可用")
	}
	// 非密钥字段必须已经落盘
	if !strings.Contains(string(b), "panel-model") {
		t.Fatalf("非密钥字段应落盘：%s", b)
	}

	// 显式勾选后才落盘
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"rememberKey": true, "persist": true}); e != nil {
		t.Fatalf("setConfig 失败：%s", e.Message)
	}
	b, err = os.ReadFile(cfgPath)
	if err != nil || !strings.Contains(string(b), key) {
		t.Fatalf("勾选后应把密钥落盘：%v / %s", err, b)
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(cfgPath); st != nil && st.Mode().Perm() != 0o600 {
			t.Fatalf("含密钥的配置文件权限应为 0600，实际 %o", st.Mode().Perm())
		}
	}

	// 模拟重启：内存清空后从磁盘恢复
	resetAIConfig()
	loadAIConfigFromDisk()
	if got := aiEffective(); got.APIKey != key || got.Model != "panel-model" {
		t.Fatalf("重启后应从磁盘恢复配置：%+v", got)
	}
	if v := aiConfigView(); v["keyOnDisk"] != true || v["keyFrom"] != "local" {
		t.Fatalf("状态应标明密钥来自本机：%v", v)
	}

	// 清除本机配置：文件删掉、本机层清空
	if _, e := callRaw(t, "ai/resetConfig", map[string]any{}); e != nil {
		t.Fatalf("resetConfig 失败：%s", e.Message)
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Fatalf("清除后配置文件应被删除：%v", err)
	}
	if aiEffective().APIKey != "" {
		t.Fatalf("清除后不该还有密钥")
	}
}

// 「测试连接」用未保存的参数试，但**不得改动**当前生效配置。
func TestAITestDoesNotMutateConfig(t *testing.T) {
	t.Setenv("DBX_PLUGIN_DATA_DIR", t.TempDir())
	srv := fakeModel(t, 200, openAIJSON, nil, nil)
	resetAIConfig()
	enableAI(t, "http://127.0.0.1:1/v1", "keep-model", "openai", "sk-keep-1234567890", nil)

	res, perr := callRaw(t, "ai/test", map[string]any{
		"enabled": true, "provider": "openai",
		"baseUrl": srv.URL + "/v1", "model": "other-model", "apiKey": "sk-other-1234567890",
	})
	if perr != nil {
		t.Fatalf("ai/test 失败：%s", perr.Message)
	}
	if res.(map[string]any)["success"] != true {
		t.Fatalf("测试应成功：%v", res)
	}
	eff := aiEffective()
	if eff.Model != "keep-model" || eff.BaseURL != "http://127.0.0.1:1/v1" {
		t.Fatalf("ai/test 不该改动生效配置：%+v", eff)
	}
	if _, err := os.Stat(filepath.Join(os.Getenv("DBX_PLUGIN_DATA_DIR"), "ai-config.json")); !os.IsNotExist(err) {
		t.Fatalf("ai/test 不该写盘：%v", err)
	}
}

// 面板改配置时没传的字段保持原样（密码框留空 = 不改密钥）。
func TestAISetConfigPartialUpdate(t *testing.T) {
	t.Setenv("DBX_PLUGIN_DATA_DIR", t.TempDir())
	resetAIConfig()
	if _, e := callRaw(t, "ai/setConfig", map[string]any{
		"enabled": true, "provider": "anthropic", "baseUrl": "http://127.0.0.1:1/v1",
		"model": "m1", "apiKey": "sk-keep-me-1234567890", "timeoutSecs": 30, "persist": true,
	}); e != nil {
		t.Fatalf("setConfig 失败：%s", e.Message)
	}
	// 只改模型，不传密钥
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"model": "m2", "persist": true}); e != nil {
		t.Fatalf("setConfig 失败：%s", e.Message)
	}
	eff := aiEffective()
	if eff.Model != "m2" || eff.APIKey != "sk-keep-me-1234567890" || eff.Provider != "anthropic" || eff.TimeoutSecs != 30 {
		t.Fatalf("未传的字段应保持原样：%+v", eff)
	}
	// clearKey 显式清掉
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"clearKey": true, "persist": true}); e != nil {
		t.Fatalf("setConfig 失败：%s", e.Message)
	}
	if aiEffective().APIKey != "" {
		t.Fatalf("clearKey 应清掉密钥")
	}
	// 非法 provider 被忽略（不写入垃圾值）
	if _, e := callRaw(t, "ai/setConfig", map[string]any{"provider": "hack", "persist": true}); e != nil {
		t.Fatalf("setConfig 失败：%s", e.Message)
	}
	if aiEffective().Provider != "anthropic" {
		t.Fatalf("非法 provider 应被忽略：%s", aiEffective().Provider)
	}
}

/* ---------------- UI 偏好 ---------------- */

func TestPrefsWhitelistAndClamp(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("DBX_PLUGIN_DATA_DIR", dataDir)
	if _, e := callRaw(t, "ui/setPrefs", map[string]any{"prefs": map[string]any{
		"sidebarWidth": 300, "aiWidth": 99999, "aiPanelOpen": true, "evil": "x",
	}}); e != nil {
		t.Fatalf("ui/setPrefs 失败：%s", e.Message)
	}
	res, e := callRaw(t, "ui/getPrefs", map[string]any{})
	if e != nil {
		t.Fatalf("ui/getPrefs 失败：%s", e.Message)
	}
	p := res.(map[string]any)["prefs"].(map[string]any)
	if p["sidebarWidth"] != 300 {
		t.Fatalf("sidebarWidth 应保留：%v", p["sidebarWidth"])
	}
	if p["aiWidth"] != 720 {
		t.Fatalf("超范围的宽度应被钳到 720：%v", p["aiWidth"])
	}
	if _, ok := p["evil"]; ok {
		t.Fatalf("白名单外的键不该被写入：%v", p)
	}
	if _, ok := p["aiPanelOpen"]; !ok {
		t.Fatalf("aiPanelOpen 应保留：%v", p)
	}
	// 低于下限 → 180；且部分更新不丢掉已有键
	if _, e := callRaw(t, "ui/setPrefs", map[string]any{"prefs": map[string]any{"aiWidth": 10}}); e != nil {
		t.Fatalf("ui/setPrefs 失败：%s", e.Message)
	}
	res, _ = callRaw(t, "ui/getPrefs", map[string]any{})
	p = res.(map[string]any)["prefs"].(map[string]any)
	if p["aiWidth"] != 180 || p["sidebarWidth"] != 300 {
		t.Fatalf("钳制/合并结果不对：%v", p)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "prefs.json")); err != nil {
		t.Fatalf("prefs.json 应存在：%v", err)
	}
}

// **安全底线**：密钥不得出现在数据目录或笔记目录的任何文件里。
func TestAISecretNeverTouchesDisk(t *testing.T) {
	const key = "sk-must-not-be-persisted-42"
	dataDir := t.TempDir()
	storageDir := t.TempDir()
	t.Setenv("DBX_PLUGIN_DATA_DIR", dataDir)
	resetAIConfig()

	if _, err := callRaw(t, "connection/connect", connectParams(storageDir, map[string]any{
		"ai_enabled": true, "ai_provider": "openai",
		"ai_base_url": "http://127.0.0.1:1/v1", "ai_model": "m",
	}, key)); err != nil {
		t.Fatalf("connect 失败：%s", err.Message)
	}
	// 顺手落一次笔记，确认常规写入路径也带不出密钥
	if _, err := callRaw(t, "notes/save", map[string]any{"data": map[string]any{
		"version": 2, "nodes": []map[string]any{
			{"id": "n1", "type": "note", "name": "标题", "parentId": nil, "content": "正文",
				"createdAt": "c", "updatedAt": "u"},
		},
	}}); err != nil {
		t.Fatalf("save 失败：%s", err.Message)
	}

	for _, root := range []string{dataDir, storageDir} {
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return nil
			}
			if strings.Contains(string(b), key) {
				t.Fatalf("密钥被写进了磁盘文件：%s", p)
			}
			return nil
		})
	}
	// 断开连接后内存里也不该留下密钥
	if _, err := callRaw(t, "connection/disconnect", map[string]any{"connectionId": "c-ai"}); err != nil {
		t.Fatalf("disconnect 失败：%s", err.Message)
	}
	if aiSnapshot().APIKey != "" {
		t.Fatalf("断开连接后仍残留密钥")
	}
}
