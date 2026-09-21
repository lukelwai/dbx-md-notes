/*
 * 端到端验证：真实 SDK 桥接 + 真实 storage.js + 真实 Go 侧车
 * ---------------------------------------------------------------------------
 * 之前几轮之所以没抓到 bug：端到端测试直接对侧车发 JSON-RPC，绕过了 JS 桥接层。
 * 这个脚本把【宿主源码里的官方 SDK 源串】原样抽出来在 vm 里跑，再模拟宿主的
 * dispatch（host.getContext / backend.invoke / 2MiB 载荷上限），最后加载真实的
 * ui/storage.js，走完整链路：ready -> context -> notes/ping -> notes/load -> notes/save。
 *
 * 用法: node _e2e_bridge.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";

const ROOT = "D:/core/web/dbx-pj/dbx-md-notes";
const HOST_SRC = "C:/Users/Luke-pc/AppData/Local/Temp/opencode/dbx-src/dbx-main/apps/desktop/src/lib/plugins/pluginHostBridge.ts";
const EXE = path.join(ROOT, "backend/dbx-plugin-mdnotes.exe");
const TMP = path.join(ROOT, "_e2e_tmp");
const STORAGE_DIR = path.join(TMP, "storage");
const DATA_DIR = path.join(TMP, "data");
const BRIDGE_PAYLOAD_LIMIT = 2 * 1024 * 1024;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 1) 从宿主源码抽出官方 SDK 源串 ---------- */
function extractSdkSource() {
  const src = fs.readFileSync(HOST_SRC, "utf8");
  const fnAt = src.indexOf("export function pluginSdkSource");
  const start = src.indexOf("return `", fnAt) + "return `".length;
  const end = src.indexOf("})();`;", start) + "})();".length;
  if (fnAt < 0 || start < fnAt || end <= start) throw new Error("无法定位 pluginSdkSource 模板");
  let code = src.slice(start, end);
  const subs = { PLUGIN_MESSAGE_SOURCE: "dbx-plugin", HOST_MESSAGE_SOURCE: "dbx-host", BRIDGE_VERSION: "1", serializedInitialTheme: "null" };
  code = code.replace(/\$\{(\w+)\}/g, (m, name) => {
    if (!(name in subs)) throw new Error("未知插值 " + name);
    return subs[name];
  });
  return code;
}

/* ---------- 2) 真实侧车（JSONL JSON-RPC） ---------- */
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const child = spawn(EXE, [], { env: { ...process.env, DBX_PLUGIN_DATA_DIR: DATA_DIR }, stdio: ["pipe", "pipe", "pipe"] });
let seq = 0;
const waiting = new Map();
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const entry = waiting.get(String(msg.id));
    if (!entry) continue;
    waiting.delete(String(msg.id));
    if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  }
});
child.stderr.on("data", (c) => process.stderr.write("[sidecar] " + c));
function sidecar(method, params) {
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
  });
}

/* ---------- 3) 插件侧 vm 环境 ---------- */
const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  JSON,
  Blob,
  URL,
  TextEncoder,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  origin: "null",           // 沙箱 iframe 的 opaque origin
};
context.window = context;
context.globalThis = context;

const docListeners = [];
context.document = {
  listeners: docListeners,
  visibilityState: "visible",
  documentElement: { style: { setProperty() {} }, dataset: {}, setAttribute() {}, getAttribute() { return null; } },
  addEventListener(type, fn) { docListeners.push({ type, fn }); },
  removeEventListener() {},
  dispatchEvent(ev) { docListeners.filter((l) => l.type === ev.type).forEach((l) => l.fn(ev)); return true; },
};

const winListeners = [];
context.addEventListener = (type, fn) => winListeners.push({ type, fn });
context.removeEventListener = () => {};
function emitToPlugin(msg) {
  const ev = { source: context.parent, data: msg };
  winListeners.filter((l) => l.type === "message").forEach((l) => l.fn(ev));
}

vm.createContext(context);

/* ---------- 4) 宿主侧 dispatch（照 pluginHostBridge.ts 的语义） ---------- */
const workbenchContext = { connectionId: "e2e-conn-1", connectionName: "MD 笔记" }; // 故意不带 storage_dir
context.parent = {
  postMessage(msg) {
    if (msg.type === "ready") {
      setTimeout(() => emitToPlugin({
        source: "dbx-host", version: 1, type: "init",
        pluginId: manifest.id, contributionId: "com.example.mdnotes.main",
        locale: "zh-CN", permissions: manifest.permissions, capabilities: {}, context: workbenchContext,
      }), 0);
      return;
    }
    if (msg.type !== "request") return;
    dispatch(msg).then(
      (result) => emitToPlugin({ source: "dbx-host", version: 1, type: "response", id: msg.id, result: result ?? null }),
      (err) => emitToPlugin({ source: "dbx-host", version: 1, type: "response", id: msg.id, error: err instanceof Error ? err.message : String(err) }),
    );
  },
};

async function dispatch(req) {
  const bytes = Buffer.byteLength(JSON.stringify(req.params ?? null));
  if (bytes > BRIDGE_PAYLOAD_LIMIT) throw new Error("Plugin bridge request is too large"); // 宿主同款限制
  const method = req.method;
  if (method === "host.getContext") return workbenchContext;
  if (method === "backend.invoke") {
    const input = req.params || {};
    if (typeof input.method !== "string") throw new Error("backend.invoke params must include method");
    return await sidecar(input.method, input.params ?? null);
  }
  throw new Error(`Unsupported plugin host method '${method}'`);
}

/* ---------- 5) 加载官方 SDK + 真实 storage.js ---------- */
vm.runInContext(extractSdkSource(), context, { filename: "dbx-plugin-sdk.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "ui/storage.js"), "utf8"), context, { filename: "storage.js" });

/* ---------- 6) 跑 ---------- */
const pass = [];
const fail = [];
function check(name, cond, extra) {
  (cond ? pass : fail).push(name + (extra ? "  |  " + extra : ""));
}

(async () => {
  const init = await sidecar("plugin/initialize", { host: { protocolVersions: [1] } });
  check("侧车身份与 manifest 一致",
    init.plugin.id === manifest.id && init.plugin.version === manifest.version,
    `${init.plugin.id}@${init.plugin.version} vs ${manifest.id}@${manifest.version}`);

  // 宿主连接流程：connection/connect 带 storage_dir（前端拿不到它，验证前端不依赖它）
  const conn = await sidecar("connection/connect", {
    connection: { id: "e2e-conn-1", name: "MD 笔记", config: { storage_dir: STORAGE_DIR } },
    connectionId: "e2e-conn-1",
  });
  check("connection/connect 拿到存储目录", conn.configured === true && conn.storagePath === STORAGE_DIR,
    "path=" + conn.storagePath);

  const S = context.MDNotes.storage;
  check("storage.js 已加载并暴露 MDNotes.storage", !!S && typeof S.init === "function");

  // 反面案例（回归护栏）：ready 的值是【上下文数据】，它没有 invoke。
  // 把 ready 的结果当 API 用，就是之前"笔记永远存不了"的根因。
  const readyValue = await context.window.dbxPlugin.ready;
  check("ready 的值是上下文数据、不含 invoke（反面案例）",
    readyValue && typeof readyValue.invoke === "undefined",
    "readyValue keys=" + Object.keys(readyValue).join(","));
  check("真正的 API 是 window.dbxPlugin 本身",
    typeof context.window.dbxPlugin.invoke === "function" && typeof context.window.dbxPlugin.request === "function");

  const res = await S.init();
  const st = S.status();
  check("init 不抛异常且返回结构完整", !!res && typeof res === "object", "keys=" + Object.keys(res).join(","));
  check("后端 = sidecar", st.backend === "sidecar", "backend=" + st.backend);
  check("可持久化", st.persistent === true);
  check("ok=true 且无错误", st.ok === true && !st.lastError, "lastError=" + st.lastError);
  check("侧车握手成功", st.sidecarAvailable === true, "sidecarError=" + st.sidecarError);
  check("读到实际存储目录（来自侧车）", st.storageDir === STORAGE_DIR, "storageDir=" + st.storageDir);
  check("dirConfigured=true", st.dirConfigured === true);
  check("connectionId 来自同步 context", st.connectionId === "e2e-conn-1", "connectionId=" + st.connectionId);

  // 写一篇真实笔记
  const snapshot = {
    version: 2,
    nodes: [
      { id: "f1", type: "folder", name: "工作", parentId: null, content: "", createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" },
      { id: "n1", type: "note", name: "重构验证", parentId: "f1", content: "# 重构验证\n\n存储链路已打通。\n", createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-21T00:00:00Z" },
    ],
    activeId: "n1", expanded: { f1: true }, view: "split",
  };
  const ok = await S.save(snapshot, false);
  check("save 返回成功", ok === true, "ok=" + ok + " lastError=" + S.status().lastError);

  const file = path.join(STORAGE_DIR, "工作/重构验证.md");
  const meta = path.join(STORAGE_DIR, ".mdnotes/meta.json");
  check("真实 .md 文件已落盘", fs.existsSync(file), file);
  check("meta.json 已落盘", fs.existsSync(meta), meta);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    check("笔记内容正确", text.includes("存储链路已打通"), JSON.stringify(text.slice(0, 40)));
  }

  // 回读
  const again = await S.reload();
  check("reload 回读到 2 个节点",
    !!(again.data && again.data.nodes && again.data.nodes.length === 2),
    "nodes=" + (again.data && again.data.nodes ? again.data.nodes.length : "null"));

  console.log("\n===== 通过 " + pass.length + " 项 =====");
  pass.forEach((p) => console.log("  PASS  " + p));
  if (fail.length) {
    console.log("\n===== 失败 " + fail.length + " 项 =====");
    fail.forEach((f) => console.log("  FAIL  " + f));
  }
  console.log("\n----- storage 诊断日志 -----");
  S.status().diag.forEach((l) => console.log("  " + l));
  console.log("\n----- 磁盘产物 -----");
  const walk = (d, pre = "") => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const fp = path.join(d, e.name);
    console.log("  " + pre + e.name + (e.isDirectory() ? "/" : "  (" + fs.statSync(fp).size + " B)"));
    if (e.isDirectory()) walk(fp, pre + "  ");
  });
  walk(STORAGE_DIR);

  child.kill();
  console.log("\nRESULT: " + (fail.length ? "FAIL" : "PASS"));
  process.exit(fail.length ? 1 : 0);
})().catch((e) => {
  console.error("harness error:", e);
  child.kill();
  process.exit(2);
});
