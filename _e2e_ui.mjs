/*
 * UI 级端到端验证：真实 index.html + 真实 app.js + 真实 storage.js + 真实 Go 侧车
 * ============================================================================
 * 为什么需要这一层：
 *   2026-09-21 的事故是 —— index.html 里 #btn-copy-sql 被注释掉了，而 app.js 的
 *   bindEvents 仍写 `$("btn-copy-sql").onclick = ...` → TypeError → bindEvents 在开头
 *   中断 → boot() 整个没跑 → 按钮全死、状态永远停在 unknown、笔记从不落盘。
 *   后端的 e2e（_e2e_bridge.mjs）和桥接层的 e2e 都是**全绿**的，因为它们压根不加载
 *   app.js。所以必须再加一层「真的把 index.html 跑起来」的测试。
 *
 * 本脚本用 jsdom 加载真实 index.html（连 <script src> 一起执行），在 beforeParse 里
 * 注入一个与宿主 bridge 语义一致的假 dbxPlugin（ready / context / invoke / request /
 * onContext），invoke 走真实 Go 侧车的 JSON-RPC。断言聚焦在：
 *   - boot 是否走完、按钮是否真的可点（不是「绑定被静默跳过」）
 *   - 置顶诊断条是否给出正确结论、日志里有没有 [FAIL]
 *   - 笔记是否真的以 .md 落到磁盘
 *
 * 用法: node _e2e_ui.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const NODE_WS = "C:/Users/Luke-pc/.workbuddy/binaries/node/workspace/package.json";
const require = createRequire(NODE_WS);
const { JSDOM } = require("jsdom");

const ROOT = "D:/core/web/dbx-pj/dbx-md-notes";
const EXE = path.join(ROOT, "backend/dbx-plugin-mdnotes.exe");
const TMP = path.join(ROOT, "_e2e_ui_tmp");
const STORAGE_DIR = path.join(TMP, "storage");
const DATA_DIR = path.join(TMP, "data");
const BRIDGE_PAYLOAD_LIMIT = 2 * 1024 * 1024;
const CONN_ID = "e2e-ui-conn-1";

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

/* ---------------- 真实侧车 ---------------- */
const child = spawn(EXE, [], {
  env: { ...process.env, DBX_PLUGIN_DATA_DIR: DATA_DIR },
  stdio: ["pipe", "pipe", "pipe"],
});
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

/* ---------------- 假宿主桥接（与官方 SDK 语义一致） ---------------- */
const workbenchContext = { connectionId: CONN_ID, connectionName: "MD 笔记" }; // 故意不带 storage_dir
const hostLog = [];

async function hostDispatch(method, params) {
  const bytes = Buffer.byteLength(JSON.stringify(params ?? null));
  if (bytes > BRIDGE_PAYLOAD_LIMIT) throw new Error("Plugin bridge request is too large");
  hostLog.push(method);
  if (method === "host.getContext") return workbenchContext;
  if (method === "backend.invoke") {
    const input = params || {};
    if (typeof input.method !== "string") throw new Error("backend.invoke params must include method");
    return await sidecar(input.method, input.params ?? null);
  }
  throw new Error(`Unsupported plugin host method '${method}'`);
}

function installBridge(window) {
  const ctxListeners = [];
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  const api = {
    ready,
    // 真实 SDK：ready 的值是【上下文数据】，且 context 是同步可读的
    get context() { return workbenchContext; },
    get locale() { return "zh-CN"; },
    get theme() { return "light"; },
    get capabilities() { return {}; },
    invoke(method, params, opts) {
      const limit = (opts && opts.timeoutMs) || 30000;
      return Promise.race([
        hostDispatch("backend.invoke", { method, params }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(method + " 超时")), limit)),
      ]);
    },
    request(method, params) { return hostDispatch(method, params); },
    notify() {},
    onContext(fn) { ctxListeners.push(fn); },
    onInit(fn) { ctxListeners.push(fn); },
  };
  window.dbxPlugin = api;
  // 模拟宿主异步塞入 init：ready resolve 出的是纯上下文数据（不含 invoke）
  setTimeout(() => { resolveReady(workbenchContext); }, 0);

  // jsdom 缺失的浏览器 API 兜底
  window.Element.prototype.scrollIntoView = function () {};
  window.document.execCommand = () => false;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.__hostLog = hostLog;
  window.__testErrors = [];
  window.addEventListener("error", (e) => window.__testErrors.push(String(e.message || e)));
}

/* ---------------- 跑起来 ---------------- */
const dom = await JSDOM.fromFile(path.join(ROOT, "ui/index.html"), {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  beforeParse: installBridge,
});
const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (cond()) return true; } catch { /* ignore */ }
    await sleep(50);
  }
  console.error(`[timeout] 等待「${what}」超过 ${ms}ms`);
  return false;
}

const pass = [];
const fail = [];
function check(name, cond, extra) {
  (cond ? pass : fail).push(name + (extra ? "  |  " + extra : ""));
}
const diagText = () => ($("diag-log") ? $("diag-log").textContent : "");
const diagLines = () => diagText().split("\n").filter(Boolean);

/* 先让侧车进入正常状态（宿主连接流程） */
await sidecar("plugin/initialize", { host: { protocolVersions: [1] } });
const conn = await sidecar("connection/connect", {
  connection: { id: CONN_ID, name: "MD 笔记", config: { storage_dir: STORAGE_DIR } },
  connectionId: CONN_ID,
});

/* 等 UI 起来 */
await waitFor(() => window.MDNotes && window.MDNotes.storage, 6000, "storage.js 加载");
await waitFor(() => {
  const bar = $("diag-bar");
  return bar && (bar.getAttribute("data-sev") === "ok" || diagText().includes("[FAIL]"));
}, 20000, "诊断条给出最终结论");
await sleep(600); // 等 persist(false) / seed 落盘

const S = window.MDNotes.storage;
const st = S.status();

/* ---------- 1) 启动链路 ---------- */
check("storage.js 暴露 MDNotes.storage", !!S && typeof S.init === "function");
check("boot 已触发", diagText().includes("前端 boot 开始"));
check("UI 初始化走完（没有被异常中断）", diagText().includes("[ OK ] 前端 UI 就绪"), "");
check("存储 init 被调用并跑完",
  /侧车调用 notes\/ping[\s\S]*\[ OK \]/.test(diagText()) || diagText().includes("侧车握手 notes/ping"),
  "");
check("启动期没有 [FAIL]",
  diagLines().filter((l) => l.includes("[FAIL]")).length === 0,
  diagLines().filter((l) => l.includes("[FAIL]")).join(" ;; ") || "无");

/* ---------- 2) 回归护栏：缺失元素不再连坐 ---------- */
const bindLines = diagLines().filter((l) => /绑定 \w+ → #/.test(l));
check("缺失元素只记一条（可选）日志，且不中断其它绑定",
  bindLines.length === 1 && bindLines[0].includes("#btn-copy-sql") && bindLines[0].includes("[ .. ]"),
  bindLines.join(" ;; ") || "（没有绑定日志）");
check("界面 JS 没有未捕获错误",
  window.__testErrors.length === 0, window.__testErrors.join(" ;; "));

/* ---------- 3) 置顶诊断条的结论 ---------- */
const bar = $("diag-bar");
check("诊断条在页面最上方且可见", !!bar && bar.hidden === false);
check("诊断条位置在 #main 的第一个子节点",
  $("main").firstElementChild === bar, "实际：" + ($("main").firstElementChild || {}).id);
check("诊断条判为正常（data-sev=ok）", bar.getAttribute("data-sev") === "ok",
  "data-sev=" + bar.getAttribute("data-sev"));
check("诊断条结论直说「正在落盘到」",
  $("diag-verdict").textContent.includes("笔记正在落盘到"), $("diag-verdict").textContent);
check("诊断条摘要含后端/桥接/侧车/目录",
  /后端 sidecar/.test($("diag-summary").textContent)
  && /桥接 已连接/.test($("diag-summary").textContent)
  && /侧车 已握手/.test($("diag-summary").textContent)
  && $("diag-summary").textContent.includes(STORAGE_DIR.replace(/\\/g, "\\")),
  $("diag-summary").textContent);
check("状态栏胶囊也同步为已保存",
  $("store-text").textContent.includes("已保存到存储目录"), $("store-text").textContent);

/* ---------- 4) storage 状态 ---------- */
check("后端 = sidecar", st.backend === "sidecar", "backend=" + st.backend);
check("可持久化 + ok", st.persistent === true && st.ok === true, "lastError=" + st.lastError);
check("侧车握手成功", st.sidecarAvailable === true, "sidecarError=" + st.sidecarError);
check("落盘目录来自侧车", st.storageDir === STORAGE_DIR, "storageDir=" + st.storageDir);
check("dirConfigured=true", st.dirConfigured === true);

/* ---------- 5) 真的落盘了 ---------- */
const meta = path.join(STORAGE_DIR, ".mdnotes/meta.json");
check("meta.json 已落盘", fs.existsSync(meta), meta);
const mdFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) walk(fp);
    else if (e.name.endsWith(".md")) mdFiles.push(path.relative(STORAGE_DIR, fp));
  }
})(STORAGE_DIR);
check("示例笔记以真实 .md 落盘", mdFiles.length >= 2, mdFiles.join(" | ") || "（无）");

/* ---------- 6) 按钮真的可点（不是被静默跳过） ---------- */
const treeBefore = $("tree").textContent;
$("btn-new-note").click();
await sleep(800); // 等 debounce 落盘
check("「新建笔记」按钮生效", $("tree").textContent.includes("未命名笔记")
  && $("tree").textContent !== treeBefore,
  $("tree").textContent.slice(0, 60));
const newFile = mdFiles.some((f) => f.includes("未命名笔记"))
  || fs.existsSync(path.join(STORAGE_DIR, "未命名笔记.md"));
check("新建的笔记也落盘了", newFile, mdFiles.join(" | "));
check("save 后诊断日志有新记录",
  diagText().includes("侧车调用 notes/save"), diagLines().slice(-3).join(" ;; "));

$("btn-table-note").click();
check("「为表新建笔记」弹窗能打开", $("table-modal").hidden === false);
$("tn-cancel").click();
check("弹窗能关闭", $("table-modal").hidden === true);

/* ---------- 7) 状态胶囊能点开（本次报障点之一） ---------- */
$("store-status").click();
await sleep(50);
check("点状态栏胶囊能打开「存储状态」弹窗",
  $("modal").hidden === false && $("modal").textContent.includes("存储状态"),
  $("modal").textContent.slice(0, 60));
check("弹窗里带逐步诊断日志", $("modal").textContent.includes("存储诊断日志"));
$("modal").querySelectorAll("button").length
  && [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "关闭").click();
check("状态弹窗能关闭", $("modal").hidden === true);

/* ---------- 8) 诊断条交互 ---------- */
const logWasHidden = $("diag-log").hidden;
$("diag-toggle").click();
await sleep(20);
check("「收起/展开日志」按钮生效", $("diag-log").hidden === !logWasHidden,
  "before=" + logWasHidden + " after=" + $("diag-log").hidden);
check("诊断报告可生成（含环境快照）",
  S.report().includes("--- 环境 ---") && S.report().includes("typeof window.dbxPlugin"),
  "");

/* ---------- 汇总 ---------- */
console.log("\n===== 通过 " + pass.length + " 项 =====");
pass.forEach((p) => console.log("  PASS  " + p));
if (fail.length) {
  console.log("\n===== 失败 " + fail.length + " 项 =====");
  fail.forEach((f) => console.log("  FAIL  " + f));
}
console.log("\n----- 页面置顶诊断条内容 -----");
console.log("  verdict: " + $("diag-verdict").textContent);
console.log("  summary: " + $("diag-summary").textContent);
console.log("  status : " + $("store-text").textContent);
diagLines().forEach((l) => console.log("  " + l));
console.log("\n----- 磁盘产物 -----");
(function walk(d, pre = "") {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, e.name);
    console.log("  " + pre + e.name + (e.isDirectory() ? "/" : "  (" + fs.statSync(fp).size + " B)"));
    if (e.isDirectory()) walk(fp, pre + "  ");
  }
})(STORAGE_DIR);

window.close();
child.kill();
console.log("\nRESULT: " + (fail.length ? "FAIL" : "PASS"));
process.exit(fail.length ? 1 : 0);
