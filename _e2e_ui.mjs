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
 *   - 存储后端是否真握手成功、日志里有没有 [FAIL]（日志取自 S.status().diag）
 *   - 置顶诊断条确实已下线（上线形态）
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
const SAVED_DIR = path.join(TMP, "saved");   // 模拟「用户在原生另存为对话框里选的目录」
const BRIDGE_PAYLOAD_LIMIT = 2 * 1024 * 1024;
const CONN_ID = "e2e-ui-conn-1";

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SAVED_DIR, { recursive: true });

/** 递归找某个文件名，返回绝对路径 */
function findPath(root, name) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const fp = path.join(root, e.name);
    if (e.isDirectory()) {
      const hit = findPath(fp, name);
      if (hit) return hit;
    } else if (e.name === name) {
      return fp;
    }
  }
  return "";
}

/** 极简 zip 中央目录读取（只为断言包内条目名） */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip：找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录签名不对 @" + off);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    out.push(buf.slice(off + 46, off + 46 + nameLen).toString("utf8"));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

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

  // 模拟宿主原生「另存为」：把字节写到 SAVED_DIR（= 用户选定的目录），返回 {path}
  const saveCalls = [];
  function hostSaveFile(options, data) {
    if (data === null || data === undefined) return null; // 宿主在用户取消时 resolve null
    let u8;
    try { u8 = new Uint8Array(data); } catch { throw new Error("host.saveFile requires binary data"); }
    const name = String((options && options.fileName) || "unnamed.bin");
    const target = path.join(SAVED_DIR, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(u8));
    saveCalls.push({
      fileName: name,
      contentType: (options && options.contentType) || "",
      bytes: u8.byteLength,
      path: target,
    });
    return Promise.resolve({ path: target });
  }

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
    saveFile: hostSaveFile,
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
  window.__saveCalls = saveCalls;
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
// 置顶诊断条已下线（SHOW_DIAG_BAR=false），日志只存在于存储层：S.status().diag
const diagText = () => {
  const s = window.MDNotes && window.MDNotes.storage;
  if (!s) return "";
  const st = s.status();
  return (st.diag && st.diag.length) ? st.diag.join("\n") : "";
};
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
  const s = window.MDNotes && window.MDNotes.storage;
  if (!s) return false;
  const st = s.status();
  return st.backend !== "unknown" || diagText().includes("[FAIL]");
}, 20000, "存储初始化给出最终结论");
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

/* ---------- 3) 置顶诊断条已下线（上线形态），状态栏胶囊仍在 ---------- */
check("置顶诊断条不在页面上（已下线）", !$("diag-bar") && !$("diag-log"));
check("#main 的第一个子节点是工具栏（不再被诊断条占位）",
  ($("main").firstElementChild || {}).className === "toolbar",
  "实际：" + ($("main").firstElementChild || {}).className);
check("状态栏胶囊仍在且标题正确",
  !!$("store-status") && $("store-text").textContent.includes("已保存到存储目录"),
  $("store-text").textContent);

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
check("弹窗里默认【不】显示逐步诊断日志（上线收口）",
  !$("modal").textContent.includes("存储诊断日志"));
$("modal").querySelectorAll("button").length
  && [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "关闭").click();
check("状态弹窗能关闭", $("modal").hidden === true);

/* ---------- 8) 诊断能力仍在（只是不上屏） ---------- */
check("诊断报告仍可生成（含环境快照，供排障）",
  S.report().includes("--- 环境 ---") && S.report().includes("typeof window.dbxPlugin"),
  "");
check("诊断日志仍完整保留在存储层（只是不上屏）",
  diagText().includes("前端 boot 开始") && diagText().includes("侧车握手 notes/ping"),
  diagLines().slice(-2).join(" ;; "));
check("历史诊断入口未泄漏到页面（无 diag-toggle/复制诊断按钮）",
  !$("diag-toggle") && !$("diag-copy") && !$("diag-detail"));

/* ---------- 9) 侧栏底部不再重复显示存储位置（存储状态弹窗是唯一出口） ---------- */
check("侧栏底部不再显示存储路径（.foot-loc 已移除）",
  !$("side-foot").querySelector(".foot-loc")
    && !$("side-foot").textContent.includes(STORAGE_DIR),
  JSON.stringify($("side-foot").textContent));
check("侧栏底部仍保留统计信息（不是整块被删掉）",
  /篇笔记/.test($("side-foot").textContent) && !!$("side-foot").querySelector(".foot-stat"),
  $("side-foot").textContent);

/* ---------- 10) 目录树拖拽（本次报障点之一：拖不动） ---------- */
// 根因：rowEl 里遗留 draggable="true" → 元素可原生拖拽 → 浏览器抢走手势、发 pointercancel
// 掐断指针拖拽，并显示禁止光标。先做 DOM 级护栏，再真正模拟一次「把笔记拖进文件夹」。
const fire = (el, type, props) => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props || {});
  el.dispatchEvent(ev);
  return ev;
};

const initialNodes = [...doc.querySelectorAll("#tree .node")];
check("目录树里有节点（前置条件）", initialNodes.length > 0, "节点数=" + initialNodes.length);
check("目录树节点都不再声明 draggable（否则原生拖拽会掐掉指针拖拽）",
  initialNodes.every((el) => !el.hasAttribute("draggable")),
  initialNodes.map((el) => el.getAttribute("draggable")).join(",") || "（都没有，正确）");
check("目录树节点都带 data-id（拖拽靠它算落点）",
  initialNodes.every((el) => !!el.getAttribute("data-id")));
{
  const cssText = fs.readFileSync(path.join(ROOT, "ui/styles.css"), "utf8");
  check(".drag-ghost 有 pointer-events:none（否则命中测试会打到幽灵自己）",
    /\.drag-ghost\s*\{[^}]*pointer-events:\s*none/.test(cssText));
  check(".node 有 touch-action:none（防止指针被滚动手势抢走）",
    /\.node\s*\{[^}]*touch-action:\s*none/.test(cssText));
}

// jsdom 没有布局，elementFromPoint 不可用；替换成「坐标 → 测试指定的元素」。
// 这样测的是我们自己的拖拽状态机，而不是浏览器的命中测试。
let hitEl = null;
doc.elementFromPoint = () => hitEl;

// 建一个文件夹当拖拽目标
const FOLDER_NAME = "拖拽目标目录";
$("btn-new-folder").click();
await sleep(50);
const folderInput = $("modal") && $("modal").querySelector("input");
check("「新建文件夹」弹窗能打开", !!folderInput);
if (folderInput) {
  folderInput.value = FOLDER_NAME;
  [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "创建").click();
  await sleep(700);
}
const folderRow = [...doc.querySelectorAll("#tree .node")].find(
  (el) => el.getAttribute("data-type") === "folder" && el.textContent.includes(FOLDER_NAME));
check("文件夹已出现在目录树", !!folderRow,
  [...doc.querySelectorAll("#tree .node")].map((e) => e.textContent).join(" | "));

// 目标笔记：第 6 节刚在根目录建的「未命名笔记」
const dragRow = [...doc.querySelectorAll("#tree .node")].find(
  (el) => el.getAttribute("data-type") === "note" && el.textContent.includes("未命名笔记"));
check("待拖拽的笔记在目录树里", !!dragRow);

if (folderRow && dragRow) {
  hitEl = dragRow;
  fire(dragRow, "pointerdown", { button: 0, clientX: 10, clientY: 10 });
  // 只挪 2px：仍在点击阈值内，不应进入拖拽（否则单击就没法选中了）
  fire(doc, "pointermove", { clientX: 12, clientY: 12 });
  check("位移未超阈值时不进入拖拽（点击仍可选中）",
    !doc.body.classList.contains("dragging-active"));

  hitEl = folderRow;
  fire(doc, "pointermove", { clientX: 60, clientY: 60 });
  const ghost = doc.querySelector(".drag-ghost");
  check("超过阈值后进入拖拽态（生成拖拽幽灵 + 抓取光标）",
    doc.body.classList.contains("dragging-active") && !!ghost,
    "dragging-active=" + doc.body.classList.contains("dragging-active") + " ghost=" + !!ghost);
  check("悬停在文件夹上时给出放置高亮", folderRow.classList.contains("drop-target"));
  const pv = ghost ? window.getComputedStyle(ghost).pointerEvents : "";
  check("拖拽幽灵不吃指针事件", pv === "none" || pv === "", "pointer-events=" + JSON.stringify(pv));

  fire(doc, "pointerup", { clientX: 60, clientY: 60 });
  await sleep(900); // 等 debounce 落盘
  check("拖拽结束后拖拽态清理干净",
    !doc.body.classList.contains("dragging-active")
      && !doc.querySelector(".drag-ghost")
      && !doc.querySelector(".node.drop-target"));

  const movedPath = findPath(STORAGE_DIR, "未命名笔记.md");
  check("笔记真的被移动到目标文件夹下（拖拽落盘生效）",
    !!movedPath && path.basename(path.dirname(movedPath)) === FOLDER_NAME,
    movedPath || "（没找到）");
}

/* ---------- 11) 导出 / 备份走宿主「另存为」（可自选目录） ---------- */
const saveCalls = window.__saveCalls;
check("storage.js 识别到宿主 saveFile 能力", S.hasHostSave() === true);
check("工具栏有「恢复备份…」按钮", !!$("btn-restore-zip"));
check("恢复用的 zip 文件选择器存在", !!$("backup-input"));

// 导出：先选中一篇笔记
const anyNote = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
anyNote.click();
await sleep(50);
$("btn-export-md").click();
await sleep(600);
const exCall = saveCalls.find((c) => c.contentType === "text/markdown");
check("「导出 .md」弹宿主另存为（带 text/markdown 类型）", !!exCall,
  saveCalls.map((c) => c.fileName + ":" + c.contentType).join(" | ") || "（没有调用）");
check("导出的 .md 落在「用户所选目录」",
  !!exCall && fs.existsSync(exCall.path) && exCall.path.startsWith(SAVED_DIR),
  exCall ? exCall.path : "（无）");

// 备份
$("btn-backup-zip").click();
await sleep(900);
const bkCall = saveCalls.find((c) => c.contentType === "application/zip");
check("「备份 zip」弹宿主另存为（带 application/zip 类型）", !!bkCall, bkCall ? bkCall.fileName : "（没有调用）");
check("备份 zip 落在「用户所选目录」",
  !!bkCall && fs.existsSync(bkCall.path) && bkCall.path.startsWith(SAVED_DIR),
  bkCall ? bkCall.path : "（无）");
if (bkCall && fs.existsSync(bkCall.path)) {
  const names = zipEntries(fs.readFileSync(bkCall.path));
  check("备份包含配置 mdnotes-backup.json", names.includes("mdnotes-backup.json"), names.join(", "));
  check("备份包含目录树索引 .mdnotes/meta.json", names.includes(".mdnotes/meta.json"));
  check("备份条目名用正斜杠", !names.some((n) => n.includes("\\")));
  check("备份成功后弹窗说明了「含配置」与如何恢复",
    $("modal").hidden === false && /含配置|恢复/.test($("modal").textContent),
    $("modal").textContent.slice(0, 80));
  [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "关闭").click();
}

/* ---------- 12) 从备份恢复（完整 UI 流程，含确认框） ---------- */
if (bkCall && fs.existsSync(bkCall.path)) {
  const zipBuf = fs.readFileSync(bkCall.path);

  // 先把现场搞坏：改标题 → 磁盘上的文件改名
  const victim = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
  victim.click();
  await sleep(50);
  const goodName = $("title").value;
  $("title").value = "被改坏的名字";
  fire($("title"), "input");
  fire($("title"), "blur");
  await sleep(900);
  check("现场已破坏（标题改名成功）", !!findPath(STORAGE_DIR, "被改坏的名字.md"),
    findPath(STORAGE_DIR, "被改坏的名字.md") || "（没改成）");

  // 走 UI：给隐藏的 file input 塞一个真实 File，触发 change
  const zipFile = new window.File([new Uint8Array(zipBuf)], path.basename(bkCall.path), { type: "application/zip" });
  const input = $("backup-input");
  Object.defineProperty(input, "files", { value: [zipFile], configurable: true });
  fire(input, "change");
  await waitFor(() => $("modal").hidden === false && $("modal").textContent.includes("确认恢复"), 8000, "恢复确认框");
  check("选择备份后弹出恢复确认框（含包内信息）",
    $("modal").hidden === false && $("modal").textContent.includes("确认恢复")
      && $("modal").textContent.includes("篇笔记"),
    $("modal").textContent.slice(0, 120) || "（没有弹窗）");

  const startBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "开始恢复");
  check("确认框有「开始恢复」按钮", !!startBtn);
  if (startBtn) {
    startBtn.click();
    await waitFor(() => $("modal").hidden === false && $("modal").textContent.includes("恢复完成"), 10000, "恢复完成");
    check("恢复完成并回报结果",
      $("modal").textContent.includes("恢复完成"), $("modal").textContent.slice(0, 120));
    check("恢复后磁盘上原文件名回来了", !!findPath(STORAGE_DIR, goodName + ".md"),
      goodName + ".md -> " + (findPath(STORAGE_DIR, goodName + ".md") || "（没回来）"));
    check("恢复后目录树里的标题也复原",
      [...doc.querySelectorAll("#tree .node")].some((el) => el.textContent.includes(goodName)),
      "期望含 " + JSON.stringify(goodName)
        + " · 树=[" + [...doc.querySelectorAll("#tree .node")].map((e) => e.textContent).join(" | ") + "]"
        + " · 磁盘meta节点=" + (() => {
          try {
            const m = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, ".mdnotes/meta.json"), "utf8"));
            return m.nodes.map((n) => n.type + ":" + n.name).join(" | ");
          } catch (e) { return "(读不到 meta: " + e.message + ")"; }
        })()
        + " · 磁盘文件=" + (function w(d, pre = "") {
          return fs.readdirSync(d, { withFileTypes: true }).map((e) =>
            e.isDirectory() ? w(path.join(d, e.name), pre + e.name + "/") : pre + e.name).join(" | ");
        })(STORAGE_DIR));
    check("恢复前留下了退路快照（pre-restore-*.zip）",      fs.readdirSync(STORAGE_DIR).some((f) => f.startsWith("pre-restore-")),
      fs.readdirSync(STORAGE_DIR).join(", "));
    [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "关闭").click();
  }
}

/* ---------- 汇总 ---------- */
console.log("\n===== 通过 " + pass.length + " 项 =====");
pass.forEach((p) => console.log("  PASS  " + p));
if (fail.length) {
  console.log("\n===== 失败 " + fail.length + " 项 =====");
  fail.forEach((f) => console.log("  FAIL  " + f));
}
console.log("\n----- 页面状态（诊断条已下线，日志取自存储层） -----");
console.log("  status : " + $("store-text").textContent);
console.log("  backend: " + st.backend + " · dir=" + st.storageDir + " · lastError=" + (st.lastError || "无"));
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
