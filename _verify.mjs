// 校验 .dbxp：条目、manifest.executable、checksums 精确覆盖 + sha256、关键代码标记
// 用法: node _verify.mjs [某个.dbxp]   不给参数时自动取 dist/ 下最新的那个，
// 并拿它和源码 manifest.json 的版本比对（防止「验的是旧包」这种假绿）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";

const ROOT = "D:/core/web/dbx-pj/dbx-md-notes";
const srcMani = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const srcVer = srcMani.version;
const f = process.argv[2] || (() => {
  const dir = path.join(ROOT, "dist");
  const cands = fs.readdirSync(dir).filter((n) => n.endsWith(".dbxp"))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!cands.length) { console.error("dist/ 下没有 .dbxp"); process.exit(2); }
  return path.join(dir, cands[0].n);
})();
console.log("校验包: " + f + "\n源码 manifest.version = " + srcVer + "\n");
const buf = fs.readFileSync(f);

function entries(b) {
  const out = [];
  const off = b.length - 22;
  if (b.readUInt32LE(off) !== 0x06054b50) throw new Error("not a zip");
  const count = b.readUInt16LE(off + 10);
  let p = b.readUInt32LE(off + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    out.push({
      name: b.slice(p + 46, p + 46 + nameLen).toString("utf8"),
      method: b.readUInt16LE(p + 10),
      csize: b.readUInt32LE(p + 20),
      usize: b.readUInt32LE(p + 24),
      lho: b.readUInt32LE(p + 42),
      madeBy: b.readUInt16LE(p + 4),        // 高字节 = 制作系统（3 = Unix）
      ext: b.readUInt32LE(p + 38),          // 外部属性：高 16 位 = Unix 权限
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
function read(e) {
  const nameLen = buf.readUInt16LE(e.lho + 26);   // 本地头：26=文件名长度, 28=扩展长度
  const extraLen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + e.csize);
  return e.method === 8 ? zlib.inflateRawSync(raw) : raw;
}

const es = entries(buf);
const has = (n) => es.some((e) => e.name === n);
const get = (n) => { const e = es.find((x) => x.name === n); return e ? read(e) : null; };

console.log("=== 包内条目 (" + es.length + ") ===");
es.forEach((e) => console.log("  " + e.name + "  (" + e.usize + " B)"));

const mani = JSON.parse(get("manifest.json").toString("utf8"));
const exeRel = mani.entrypoints.backend.executable;
const cks = JSON.parse(get("checksums.json").toString("utf8"));
const inPkg = es.map((e) => e.name).filter((n) => n !== "checksums.json" && n !== "signature.json").sort();
const listed = Object.keys(cks.files).sort();
const mismatch = [];
for (const e of es) {
  if (e.name === "checksums.json") continue;
  const h = crypto.createHash("sha256").update(read(e)).digest("hex");
  if (cks.files[e.name] !== h) mismatch.push(e.name);
}

// 从文件名解析 target（<id>-<version>-<target>.dbxp），据此校验 executable 的路径与扩展名。
// 只有 windows 目标带 .exe —— 对齐官方 CLI 的 executable_name()。
const baseName = path.basename(f);
const pkgPrefix = srcMani.id + "-" + srcMani.version + "-";
const pkgTarget = baseName.startsWith(pkgPrefix) && baseName.endsWith(".dbxp")
  ? baseName.slice(pkgPrefix.length, -".dbxp".length) : "";
const exeSuffix = pkgTarget.startsWith("windows") ? ".exe" : "";
const exeExpected = pkgTarget ? `bin/${pkgTarget}/dbx-plugin-mdnotes${exeSuffix}` : "";

/* ---- 把包内的侧车真的启动一次，用 JSON-RPC 问它三条 ----
 * 这是"包里的二进制确实具备新能力"的唯一可靠证明（见下方注释：grep 字符串不可靠）。
 * 但只能对**本机平台**的包执行：交叉编译出来的 darwin/linux 二进制在本机跑不了，
 * 那种情况标记为 skip ——「交叉编译只保证字节正确，真机冒烟仍要各平台各跑一次」。
 */
const HOST_TARGET = (() => {
  const osName = process.platform === "win32" ? "windows" : process.platform;   // darwin | linux | windows
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${osName}-${arch}`;
})();

function probePackagedSidecar() {
  const out = { ok: false, detail: "", versionOk: false, version: "", probeOk: false, probeDetail: "", aiOk: false, aiDetail: "", aiSetOk: false, aiSetDetail: "", skip: false };
  if (pkgTarget && pkgTarget !== HOST_TARGET) {
    out.skip = true;
    out.detail = `非本机平台（包=${pkgTarget} 本机=${HOST_TARGET}），无法执行 —— 需在该平台真机冒烟`;
    return out;
  }
  const exeBytes = get(exeRel);
  if (!exeBytes) { out.detail = "包内没有该 executable"; return out; }
  const base = path.join(os.tmpdir(), `dbx-verify-${process.pid}-${Date.now()}`);
  const exePath = base + (exeRel.endsWith(".exe") ? ".exe" : "");
  const dataDir = base + "-data";
  const storeDir = base + "-store";
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(exePath, exeBytes);
    if (!exeRel.endsWith(".exe")) { fs.chmodSync(exePath, 0o755); }
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: "1", method: "plugin/initialize", params: { host: { protocolVersions: [1] } } }),
      JSON.stringify({ jsonrpc: "2.0", id: "2", method: "notes/probe", params: { storage_dir: storeDir } }),
      JSON.stringify({ jsonrpc: "2.0", id: "3", method: "ai/config", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: "4", method: "ai/setConfig", params: { persist: false, model: "probe" } }),
    ].join("\n") + "\n";
    const r = spawnSync(exePath, [], {
      input, encoding: "utf8", timeout: 20000,
      env: { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir },
    });
    const replies = new Map();
    String(r.stdout || "").split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      try {
        const m = JSON.parse(line);
        if (m && m.id != null) { replies.set(String(m.id), m); }
      } catch { /* 非 JSON 行忽略 */ }
    });
    const init = replies.get("1");
    if (init && init.result && init.result.plugin) {
      out.ok = true;
      out.version = init.result.plugin.version;
      out.versionOk = out.version === mani.version;
    } else if (init && init.error) {
      out.detail = JSON.stringify(init.error).slice(0, 140);
    } else {
      out.detail = `没有回应（exit=${r.status} stderr=${String(r.stderr || "").slice(0, 140)}）`;
    }
    const pb = replies.get("2");
    out.probeOk = !!pb && !pb.error && !!(pb.result && pb.result.ok);
    out.probeDetail = pb
      ? (pb.error ? JSON.stringify(pb.error).slice(0, 100) : "ok dir=" + ((pb.result || {}).dir || ""))
      : "无响应";
    const ai = replies.get("3");
    out.aiOk = !!ai && !ai.error && !!(ai.result && typeof ai.result.ready === "boolean");
    out.aiDetail = ai
      ? (ai.error ? JSON.stringify(ai.error).slice(0, 100) : JSON.stringify(ai.result).slice(0, 140))
      : "无响应";
    const setCfg = replies.get("4");
    out.aiSetOk = !!setCfg && !setCfg.error && !!(setCfg.result && setCfg.result.model === "probe");
    out.aiSetDetail = setCfg
      ? (setCfg.error ? JSON.stringify(setCfg.error).slice(0, 100) : "model=" + (setCfg.result || {}).model)
      : "无响应";
    return out;
  } catch (e) {
    out.detail = String((e && e.message) || e);
    return out;
  } finally {
    for (const p of [exePath, dataDir, storeDir]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
    }
  }
}
const probeExe = probePackagedSidecar();

const checks = [
  ["manifest.version 与源码一致", mani.version === srcVer, mani.version + " vs " + srcVer],
  ["manifest.id 与源码一致（防「验的是旧 id 的包」）", mani.id === srcMani.id, mani.id + " vs " + srcMani.id],
  ["manifest.publisher 与源码一致", mani.publisher === srcMani.publisher, mani.publisher + " vs " + srcMani.publisher],
  ["文件名里的 target 合法", /^[a-z0-9-]{1,64}$/.test(pkgTarget), pkgTarget || "(解析不出 target)"],
  ["executable 指向 bin/<target>/<binary>[.exe]（windows 才带 .exe）",
    exeRel === exeExpected, exeRel + (exeExpected ? " vs " + exeExpected : "")],
  ["executable 在包内真实存在", has(exeRel)],
  ["checksums.algorithm = sha256", cks.algorithm === "sha256", cks.algorithm],
  ["checksums 精确覆盖包内文件", JSON.stringify(inPkg) === JSON.stringify(listed), "包内" + inPkg.length + " / 清单" + listed.length],
  ["全部 sha256 匹配", mismatch.length === 0, mismatch.join(",")],
  ["无 _ 前缀临时文件混入", !es.some((e) => /(^|\/)_/.test(e.name))],
  // Unix 权限位：宿主的 installer.rs 只在 entry.unix_mode() 有值时才 set_permissions，
  // 而 zip crate 在 external_attributes==0（或制作系统不是 Unix）时返回 None
  // → 解出来的文件是默认 0644 → **侧车没有可执行位，macOS/Linux 上起不来**。
  ["制作系统声明为 Unix（否则权限位被忽略）", es.every((e) => (e.madeBy >> 8) === 3),
    es.map((e) => e.madeBy >> 8).join(",")],
  ["可执行文件带 0755 权限位", (() => {
    const e = es.find((x) => x.name === exeRel);
    return !!e && ((e.ext >> 16) & 0o777) === 0o755;
  })(), (() => { const e = es.find((x) => x.name === exeRel); return e ? "0" + ((e.ext >> 16) & 0o777).toString(8) : "(无)"; })()],
  ["普通文件带 0644 权限位", es.filter((e) => e.name !== exeRel).every((e) => ((e.ext >> 16) & 0o777) === 0o644)],
];
const st = get("ui/storage.js").toString("utf8");
// 注意：不要再拿"二进制里有没有某个字符串"当判据 —— Go 会合并/拆分行内字符串数据，
// 短字面量（如 ai/status）不保证连续出现，grep 会给出假的 FAIL/PASS。
// 要证明"包里的侧车确实有这个能力"，用下面的 probePackagedSidecar() 真跑一次。
const ap = get("ui/app.js").toString("utf8");
const ix = get("ui/index.html").toString("utf8");
const cs = get("ui/styles.css").toString("utf8");
const apCode = ap.replace(/\/\*[\s\S]*?\*\//g, "");   // 去注释再扫描
// 判据与 _buildpkg.js 一致：`$("id").` 只在该 id 真实存在时才算安全
const liveIds = new Set([...ix.replace(/<!--[\s\S]*?-->/g, "").matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const dangling = [...new Set([...apCode.matchAll(/\$\("([^"]+)"\)\s*\./g)].map((m) => m[1]))]
  .filter((id) => !liveIds.has(id));
checks.push(
  ["storage.js 以 window.dbxPlugin 为 API", st.includes("window.dbxPlugin")],
  ["storage.js 不再把 ready 的值当 API", !/resolve\(\s*\w+\s*\|\|/.test(st)],
  ["storage.js 用 invoke(method, params, {timeoutMs})", /invoke\(method,\s*payload,\s*\{\s*timeoutMs/.test(st)],
  ["storage.js 用 request('host.getContext') 兜底", st.includes('request("host.getContext"')],
  ["storage.js 含会话内存后端（不伪装持久）", st.includes("memoryBackend")],
  ["storage.js 导出诊断报告与看门狗", st.includes("report: report") && st.includes("看门狗")],
  ["置顶诊断条已下线（HTML 里无可用 #diag-bar）", !liveIds.has("diag-bar")],
  ["app.js 开关 SHOW_DIAG_BAR=false", /var\s+SHOW_DIAG_BAR\s*=\s*false/.test(apCode)],
  ["app.js 开关 SHOW_DIAG_LOG_IN_MODAL=false（弹窗日志隐藏）",
    /var\s+SHOW_DIAG_LOG_IN_MODAL\s*=\s*false/.test(apCode)],
  ["诊断代码保留，便于日后一行放出来",
    ap.includes("verdictText") && ix.includes('id="diag-bar"') && ap.includes("SHOW_DIAG_LOG_IN_MODAL)")],
  ["styles.css 保留诊断条样式（复用）", cs.includes(".diag-bar") && cs.includes(".diag-log")],
  ["导入功能已下线（HTML 里无可用 #btn-import-md / #file-input）",
    !liveIds.has("btn-import-md") && !liveIds.has("file-input")],
  ["app.js 开关 ENABLE_IMPORT=false", /var\s+ENABLE_IMPORT\s*=\s*false/.test(apCode)],
  ["导入代码保留，便于一行放出来", ap.includes("function handleImport(") && ap.includes("function pickImportFiles(")],
  ["app.js 没有重复的函数声明（后者会静默覆盖前者）",
    (() => {
      const seen = {};
      apCode.split(/\r?\n/).forEach((l) => {
        const m = /^  function (\w+)\s*\(/.exec(l);
        if (m) { seen[m[1]] = (seen[m[1]] || 0) + 1; }
      });
      return Object.keys(seen).filter((k) => seen[k] > 1).length === 0;
    })()],
  ["前端删除走显式 deletedIds（不再靠「不在快照里」推断删除）", ap.includes("deletedIds")],
  ["app.js 用安全绑定 click()/on()（缺失元素不再连坐）", apCode.includes("function on(id, evName, handler, optional)")],
  ["app.js 没有对缺失元素直接取属性", dangling.length === 0, dangling.join(",")],
  ["app.js 捕获页面级未处理异常", apCode.includes("unhandledrejection") && apCode.includes('window.addEventListener("error"')],
  ["app.js 不再用 dbxPlugin.ready 卡住启动", !/dbxPlugin\.ready\.then\(boot\)/.test(apCode)],
  ["app.js 保留存储诊断面板代码（开关关闭）", ap.includes("m-diag")],
  ["app.js 未持久化时不 seed 示例", ap.includes("res.firstRun && S.status().persistent")],
  ["storage.js 的 UI_VERSION 与 manifest 一致",
    (st.match(/var UI_VERSION = "([^"]+)"/) || [])[1] === srcVer,
    (st.match(/var UI_VERSION = "([^"]+)"/) || [])[1]],

  /* ---- AI 接入（v0.8.1：只用自配模型 + 右侧常驻栏，不依赖宿主内置 AI） ---- */
  ["不依赖宿主内置 AI（manifest 未声明 host.ai）",
    Array.isArray(mani.permissions) && !mani.permissions.includes("host.ai"), JSON.stringify(mani.permissions)],
  ["engines.dbx 未被 AI 抬高（老宿主也能装）",
    !!(mani.engines && !/>=\s*0\.6\.20/.test(String(mani.engines.dbx))), JSON.stringify(mani.engines)],
  [".dbx-store.json 的 permissions 与 manifest 一致（商店会比对）",
    (() => {
      try {
        const pub = JSON.parse(fs.readFileSync(path.join(ROOT, ".dbx-store.json"), "utf8"));
        return JSON.stringify(pub.permissions) === JSON.stringify(mani.permissions);
      } catch { return false; }
    })()],
  ["AI 配置字段齐全（含 ai_api_key 的 secret 绑定）",
    (() => {
      const cp = (mani.contributions || []).find((c) => c.type === "connection-provider");
      const f = (cp && cp.fields) || [];
      const by = (k) => f.find((x) => x.key === k);
      return !!by("ai_enabled") && !!by("ai_base_url") && !!by("ai_model") &&
        !!by("ai_api_key") && by("ai_api_key").binding === "secret";
    })()],
  ["有「测试 AI 连接」表单动作",
    (() => {
      const cp = (mani.contributions || []).find((c) => c.type === "connection-provider");
      return !!((cp && cp.actions) || []).find((a) => a.id === "test-ai");
    })()],
  ["AI 助手是右侧常驻栏（#ai-panel，不是弹窗）",
    ix.includes('id="ai-panel"') && ix.includes("data-ai=") && ap.includes("setAIPanelOpen")],
  ["AI 栏内可直接配置 / 更新模型（保存 / 测试 / 清除）",
    st.includes('"ai/setConfig"') && st.includes('"ai/config"') && st.includes('"ai/resetConfig"') &&
    ap.includes("submitAIConfig") && ap.includes("testAIConfig") && ap.includes("clearLocalAIConfig")],
  ["结果支持四种操作（插入到光标 / 替换选中 / 追加到末尾 / 复制）",
    ap.includes('{ op: "insert"') && ap.includes('{ op: "replace"') &&
    ap.includes('{ op: "append"') && ap.includes('{ op: "copy"')],
  ["三栏可拖动调整宽度（两条分隔条 + 偏好持久化）",
    ix.includes('id="gutter-side"') && ix.includes('id="gutter-ai"') &&
    ap.includes("bindGutter") && ap.includes("setPointerCapture") &&
    st.includes('"ui/setPrefs"') && st.includes('"ui/getPrefs"')],
  ["AI 调用走侧车（前端不直连模型）", st.includes('"ai/chat"') && st.includes('"ai/config"')],
  ["前端不再调用宿主内置 AI（openConversation / hostAISupported 已移除）",
    !ap.includes("hostAISupported") && !ap.includes("openConversation") && !st.includes("openConversation")],
  ["前端/包内没有硬编码的 API 密钥形态", !/sk-[A-Za-z0-9_-]{16,}/.test(ap + st)],

  /* ---- 包内二进制「真跑一次」（仅本机平台；跨平台包无法执行，标记为 SKIP） ---- */
  ["包内侧车能启动并完成 plugin/initialize", probeExe.ok, probeExe.detail, probeExe.skip ? "skip" : ""],
  ["包内侧车自报版本与 manifest 一致", probeExe.versionOk, probeExe.version, probeExe.skip ? "skip" : ""],
  ["包内侧车支持 notes/probe（写盘通道可用）", probeExe.probeOk, probeExe.probeDetail, probeExe.skip ? "skip" : ""],
  ["包内侧车支持 ai/config（AI 功能真的在包里）", probeExe.aiOk, probeExe.aiDetail, probeExe.skip ? "skip" : ""],
  ["包内侧车支持 ai/setConfig（面板改配置真的可用）", probeExe.aiSetOk, probeExe.aiSetDetail, probeExe.skip ? "skip" : ""],
);

console.log("=== 校验 ===");
let fails = 0;
let skips = 0;
for (const [name, ok, extra, mode] of checks) {
  if (mode === "skip") {
    skips++;
    console.log("  SKIP  " + name + (extra ? "  |  " + extra : ""));
    continue;
  }
  if (!ok) fails++;
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  |  " + extra : ""));
}
console.log("\nRESULT: " + (fails ? "FAIL(" + fails + ")" : "PASS") +
  (skips ? "（另有 " + skips + " 项因非本机平台跳过）" : ""));
process.exit(fails ? 1 : 0);
