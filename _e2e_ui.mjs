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
import http from "node:http";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { createRequire } from "node:module";
/**
 * 删除测试临时目录 —— 直接 fs.rmSync，就这一行。
 * 本机沙箱对「逐个文件删除」有接管：unlinkSync/rmdirSync 循环几百个文件就卡死十几分钟，
 * cmd rd 反而比 fs.rmSync 慢一个数量级（实测 300 个小文件：rmSync 3.7s / cmd 41s）。
 * 别再加 spawnSync（对任何 exe 直接 EBUSY）或逐文件循环。
 */
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不该让用例失败 */ }
}

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

removeTree(TMP);   // 见本文件内的 removeTree
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

/** 解出 zip 里每个条目的字节（自己生成的包，只处理 deflate/store） */
function zipContents(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip：找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录签名不对 @" + off);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString("utf8");
    // 本地头里的名称/扩展字段长度可能与中央目录不同 —— 必须按本地头再算一次数据起点
    const lnl = buf.readUInt16LE(lho + 26);
    const lel = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnl + lel;
    const raw = buf.slice(start, start + compSize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
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
/** notes/save 的入参流水（断言「删除是否显式声明了 deletedIds」这类协议语义） */
const saveCallsLog = [];
function sidecar(method, params) {
  const id = String(++seq);
  if (method === "notes/save") { saveCallsLog.push(params || {}); }
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
  // jsdom 没实现 createObjectURL / revokeObjectURL（真实宿主里是浏览器原生的）。
  // 补一个最小可用的：让「侧车取字节 → 包成 blob: → 赋给 img.src」这条真实路径能被断言到。
  if (!window.URL.createObjectURL) {
    let blobN = 0;
    window.URL.createObjectURL = () => "blob:jsdom/" + (++blobN);
    window.URL.revokeObjectURL = () => {};
  }
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

/* ---------- 11) 工具栏结构（两个固定按钮 + 「更多」折叠） ---------- */
const saveCalls = window.__saveCalls;
check("storage.js 识别到宿主 saveFile 能力", S.hasHostSave() === true);

{
  const right = doc.querySelector(".toolbar-right");
  const topBtns = [...right.children].filter((el) => el.tagName === "BUTTON").map((b) => b.id);
  check("工具栏只固定显示「插入 SQL 块」和「AI 助手」两个动作",
    topBtns.join(",") === "btn-insert-sql,btn-ai", topBtns.join(",") || "（无）");
  check("低频动作都收进「更多」下拉（导出/备份/恢复/为表新建）",
    ["btn-table-note", "btn-export-md", "btn-backup-zip", "btn-restore-zip"]
      .every((id) => $("more-menu").contains($(id))),
    [...$("more-menu").querySelectorAll("button")].map((b) => b.id).join(","));
  check("「更多」菜单默认收起", $("more-menu").hidden === true);
  check("恢复用的 zip 文件选择器存在", !!$("backup-input"));

  $("btn-more").click();
  await sleep(30);
  check("点「更多」展开菜单并标记 aria-expanded",
    $("more-menu").hidden === false && $("btn-more").getAttribute("aria-expanded") === "true",
    "hidden=" + $("more-menu").hidden);
  fire(doc.body, "click");
  await sleep(30);
  check("点空白处收起「更多」菜单",
    $("more-menu").hidden === true && $("btn-more").getAttribute("aria-expanded") === "false",
    "hidden=" + $("more-menu").hidden);

  $("btn-more").click();
  await sleep(30);
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(30);
  check("Esc 收起「更多」菜单", $("more-menu").hidden === true, "hidden=" + $("more-menu").hidden);
}

/* ---------- 11b) 导出 / 备份走宿主「另存为」（可自选目录） ---------- */
// 导出：先选中一篇笔记，再从「更多」里点（顺便验证点完菜单会自动收起）
const anyNote = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
anyNote.click();
await sleep(50);
$("btn-more").click();
await sleep(30);
$("btn-export-md").click();
await sleep(600);
check("点菜单项执行动作后菜单自动收起", $("more-menu").hidden === true, "hidden=" + $("more-menu").hidden);
const exCall = saveCalls.find((c) => c.contentType === "text/markdown");
check("「导出 .md」弹宿主另存为（带 text/markdown 类型）", !!exCall,
  saveCalls.map((c) => c.fileName + ":" + c.contentType).join(" | ") || "（没有调用）");
check("导出的 .md 落在「用户所选目录」",
  !!exCall && fs.existsSync(exCall.path) && exCall.path.startsWith(SAVED_DIR),
  exCall ? exCall.path : "（无）");

// 备份（同样从「更多」进入）
$("btn-more").click();
await sleep(30);
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
  check("恢复确认框也报图片数量（备份是否完整一眼可见）",
    /张图片/.test($("modal").textContent),
    ($("modal").textContent.match(/包含：[^\n]*/) || ["（找不到包含行）"])[0]);

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

/* ---------- 13) 删除必须显式声明 deletedIds（后端只认显式删除，不再「不在快照里就删」） ---------- */
{
  const countMd = () => (function w(d) {
    return fs.readdirSync(d, { withFileTypes: true }).reduce((sum, e) => {
      if (e.isDirectory()) { return e.name === ".mdnotes" ? sum : sum + w(path.join(d, e.name)); }
      return sum + (e.name.endsWith(".md") ? 1 : 0);
    }, 0);
  })(STORAGE_DIR);

  const before = countMd();
  const beforeSaves = saveCallsLog.length;

  const victim = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
  check("删除用例：目录树里有可删的笔记", !!victim);
  if (victim) {
    victim.click();
    await sleep(30);
    $("btn-delete").click();
    await waitFor(() => $("modal").hidden === false && /确定删除/.test($("modal").textContent), 4000, "删除确认框");
    const okBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "删除");
    check("删除确认框有「删除」按钮", !!okBtn, $("modal").textContent.slice(0, 60));
    if (okBtn) {
      okBtn.click();
      await sleep(600);
      const saved = saveCallsLog.slice(beforeSaves).reverse()
        .find((p) => p.data && Array.isArray(p.data.deletedIds) && p.data.deletedIds.length > 0);
      check("删除时把节点 id 放进 deletedIds（否则后端不会删）", !!saved,
        "最近一次 save 的 deletedIds=" + JSON.stringify((saveCallsLog[saveCallsLog.length - 1] || {}).data
          && (saveCallsLog[saveCallsLog.length - 1].data || {}).deletedIds));
      check("删除后磁盘上的 .md 少了一个", countMd() === before - 1, before + " -> " + countMd());

      const trashRoot = path.join(STORAGE_DIR, ".mdnotes", "trash");
      const trashCount = fs.existsSync(trashRoot)
        ? (function w(d) {
          return fs.readdirSync(d, { withFileTypes: true }).reduce((sum, e) =>
            e.isDirectory() ? sum + w(path.join(d, e.name)) : sum + (e.name.endsWith(".md") ? 1 : 0), 0);
        })(trashRoot)
        : 0;
      check("被删的正文进了回收站（可捞回，不是销毁）", trashCount >= 1, "trash 里的 .md 数=" + trashCount);
    }
  }
}

/* ---------- 14) AI 助手：右侧常驻栏（不是弹窗）· 默认聊天模式 · 配置走弹框 · 三栏拖拽 ---------- */
{
  const cssNum = (name) => parseInt($("app").style.getPropertyValue(name), 10) || 0;
  const dragGutter = async (el, dx) => {
    fire(el, "pointerdown", { button: 0, clientX: 500, clientY: 300 });
    fire(doc, "pointermove", { clientX: 500 + dx, clientY: 300 });
    fire(doc, "pointerup", { clientX: 500 + dx, clientY: 300 });
    await sleep(80);   // 让偏好落盘的 promise 走完
  };

  check("工具栏有「AI 助手」按钮", !!$("btn-ai"));
  check("AI 栏初始收起", $("ai-panel").hidden === true && $("app").getAttribute("data-ai") === "off",
    "data-ai=" + $("app").getAttribute("data-ai"));
  check("两条分隔条都在（目录|笔记、笔记|AI）", !!$("gutter-side") && !!$("gutter-ai"));
  check("默认宽度写进了 CSS 变量", cssNum("--side-w") > 0 && cssNum("--ai-w") > 0,
    cssNum("--side-w") + " / " + cssNum("--ai-w"));

  // 必须选一篇「有内容」的笔记：空笔记会被正确拦下（"这条笔记还没有内容"）
  const aiNote = [...doc.querySelectorAll("#tree .node")].find((el) =>
    el.getAttribute("data-type") === "note" && /欢迎使用|DBX 使用心得|重构验证/.test(el.textContent));
  check("AI 用例：目录树里有带内容的笔记", !!aiNote,
    [...doc.querySelectorAll("#tree .node")].map((e) => e.textContent).join(" | "));

  if ($("btn-ai") && aiNote) {
    aiNote.click();
    await sleep(40);
    $("btn-ai").click();
    await waitFor(() => $("ai-panel").hidden === false, 6000, "AI 栏");

    check("点「AI 助手」打开的是右侧常驻栏，而不是弹窗",
      $("ai-panel").hidden === false && $("app").getAttribute("data-ai") === "on" && $("modal").hidden === true,
      "data-ai=" + $("app").getAttribute("data-ai") + " · modal.hidden=" + $("modal").hidden);

    // --- 默认是聊天模式：不出现分析对象、不出现任务标签 ---
    check("默认是「聊天」模式", $("aip-view-chat").classList.contains("active") &&
      !$("aip-view-create").classList.contains("active"),
      "chat=" + $("aip-view-chat").className + " create=" + $("aip-view-create").className);
    check("聊天模式下不显示分析对象与任务（#aip-create-only 收起）",
      $("aip-create-only").hidden === true);
    check("聊天模式的按钮文案是「发送」", $("aip-go").textContent === "发送", $("aip-go").textContent);
    check("聊天模式的空态提示指向「创作」", /创作/.test($("aip-log").textContent), $("aip-log").textContent.slice(0, 80));

    // --- 配置走弹框，不再占用聊天区 ---
    await sleep(500);   // 等 ai/config 回来
    check("未配置 AI：自动弹出配置弹框（省得用户猜为什么点不动）", $("ai-cfg-modal").hidden === false);
    check("聊天区里没有内嵌的配置表单（已改为弹框）",
      !doc.querySelector("#aip-scroll #aip-cfg") && !doc.getElementById("aip-baseurl"));
    check("配置弹框字段齐备（地址 / 模型 / 密钥 / 记住密钥 / 人设 / 超时 / 上限）",
      ["aic-enabled", "aic-provider", "aic-baseurl", "aic-modelinput", "aic-key",
        "aic-remember", "aic-sysprompt", "aic-timeout", "aic-maxchars"].every((id) => !!$(id)),
      ["aic-enabled", "aic-provider", "aic-baseurl", "aic-modelinput", "aic-key",
        "aic-remember", "aic-sysprompt", "aic-timeout", "aic-maxchars"].filter((id) => !$(id)).join(",") || "齐全");
    check("配置弹框有 保存 / 测试连接 / 清除本机配置",
      !!$("aic-save") && !!$("aic-test") && !!$("aic-clear"));
    check("未配置时状态行指路到 ⚙ 配置", /⚙/.test($("aip-status").textContent), $("aip-status").textContent);
    $("aic-cancel").click();
    await sleep(60);
    check("「取消」能关掉配置弹框", $("ai-cfg-modal").hidden === true);
    $("aip-cfg-toggle").click();
    await sleep(60);
    check("点右上角 ⚙ 也能打开配置弹框", $("ai-cfg-modal").hidden === false);
    $("aic-cancel").click();
    await sleep(60);

    // --- 切到创作模式：分析对象 + 任务标签才出现 ---
    $("aip-view-create").click();
    await sleep(80);
    check("切到「创作」后出现分析对象与任务",
      $("aip-create-only").hidden === false && !$("aip-view-create").classList.contains("active") === false);
    check("创作模式有任务切换（分析/润色/续写/提问）",
      ["分析", "润色", "续写", "提问"].every((t) =>
        [...$("aip-tabs").querySelectorAll("button")].some((b) => b.textContent === t)),
      [...$("aip-tabs").querySelectorAll("button")].map((b) => b.textContent).join(" | "));

    // --- 分析对象：必须可切换、可清除，并显示将要发送的内容 ---
    check("分析对象区显示对象与字数",
      /《.+》/.test($("aip-target").textContent) && /字/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));
    check("对象区带内容预览（能看出将要发什么出去）",
      !!$("aip-target").querySelector(".aip-target-preview"));
    check("四种对象来源都在（自动跟随 / 选中内容 / 整篇笔记 / 清除）",
      ["aip-mode-auto", "aip-mode-selection", "aip-mode-note", "aip-mode-none"].every((id) => !!$(id)));
    check("创作模式默认「自动跟随」", $("aip-mode-auto").classList.contains("active"));

    $("aip-mode-note").click();
    await sleep(60);
    check("切到「整篇笔记」后对象摘要随之变化（可变更）",
      $("aip-mode-note").classList.contains("active") && /整篇笔记/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));

    $("aip-mode-none").click();
    await sleep(60);
    check("「清除」后对象被清空并明说不发送笔记正文",
      $("aip-mode-none").classList.contains("active") && /已清除/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));

    $("aip-mode-auto").click();
    await sleep(60);
    check("切回「自动跟随」后对象恢复",
      $("aip-mode-auto").classList.contains("active") && /字/.test($("aip-target").textContent),
      $("aip-target").textContent.slice(0, 120));

    // --- 切回聊天模式：创作区整体收起 ---
    $("aip-view-chat").click();
    await sleep(80);
    check("切回「聊天」后分析对象与任务整体收起", $("aip-create-only").hidden === true);

    // --- 三栏拖拽 ---
    const aiBefore = cssNum("--ai-w");
    await dragGutter($("gutter-ai"), -60);        // AI 栏在右侧 → 往左拖 = 变宽
    const aiAfter = cssNum("--ai-w");
    check("拖动 AI 分隔条能改宽度", aiAfter === aiBefore + 60, aiBefore + " -> " + aiAfter);

    const sideBefore = cssNum("--side-w");
    await dragGutter($("gutter-side"), 40);
    const sideAfter = cssNum("--side-w");
    check("拖动目录区分隔条能改宽度", sideAfter === sideBefore + 40, sideBefore + " -> " + sideAfter);
    check("拖动改的是目录区、没连带改 AI 栏", cssNum("--ai-w") === aiAfter);

    await dragGutter($("gutter-ai"), 2000);
    check("宽度被钳到下限（拖过头不会把 AI 栏拖没）", cssNum("--ai-w") === 280, String(cssNum("--ai-w")));

    fire($("gutter-ai"), "dblclick", {});
    await sleep(80);
    check("双击分隔条复位到默认宽度", cssNum("--ai-w") === 400, String(cssNum("--ai-w")));

    check("宽度偏好落到了插件数据目录（不进笔记目录）",
      fs.existsSync(path.join(DATA_DIR, "prefs.json")) &&
      !fs.existsSync(path.join(STORAGE_DIR, "prefs.json")),
      "data/prefs.json=" + fs.existsSync(path.join(DATA_DIR, "prefs.json")));
    const prefsWritten = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "prefs.json"), "utf8")); } catch { return {}; }
    })();
    check("偏心里含两条宽度与面板开关",
      typeof prefsWritten.sidebarWidth === "number" && typeof prefsWritten.aiWidth === "number" &&
      prefsWritten.aiPanelOpen === true, JSON.stringify(prefsWritten));

    // --- 收起 ---
    $("aip-close").click();
    await sleep(80);
    check("点 ✕ 收起 AI 栏（列宽归 0）",
      $("ai-panel").hidden === true && $("app").getAttribute("data-ai") === "off",
      "data-ai=" + $("app").getAttribute("data-ai"));

    $("btn-ai").click();
    await sleep(120);
    const prefsReopen = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "prefs.json"), "utf8")); } catch { return {}; }
    })();
    check("面板开合状态被记住", prefsReopen.aiPanelOpen === true, JSON.stringify(prefsReopen));
    check("重开后仍是「聊天」模式（默认模式不持久，符合预期）",
      $("aip-view-chat").classList.contains("active") && $("aip-create-only").hidden === true);
  }
}

/* ---------- 15) 真链路：假模型 → 真侧车 → 面板 → 编辑器 → 磁盘 ---------- */
// 这一节走完整链路：起一个假模型服务，接上侧车，分别验证
//   创作模式：结果带四个写回操作，能写进编辑器并落盘；
//   聊天模式：请求不带笔记正文，条目只带「复制」。
{
  const MARK = "AI_WRITE_BACK_MARK";
  const modelSrv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        model: "fake-e2e",
        choices: [{ message: { content: MARK } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
  });
  await new Promise((r) => modelSrv.listen(0, "127.0.0.1", r));
  const port = modelSrv.address().port;

  await sidecar("connection/connect", {
    connection: {
      id: CONN_ID, name: "AI.MD 笔记",
      config: { storage_dir: STORAGE_DIR },
      external_config: {
        ai_enabled: true, ai_provider: "openai",
        ai_base_url: `http://127.0.0.1:${port}/v1`, ai_model: "fake-e2e",
      },
      connection_secrets: { ai_api_key: "sk-e2e-secret-123456" },
    },
    connectionId: CONN_ID,
  });

  // 收起再打开 = 强制重新拉一次配置（面板只在打开与显式操作时刷新）
  if (!$("ai-panel").hidden) { $("btn-ai").click(); await sleep(80); }
  $("btn-ai").click();
  await sleep(600);
  check("配置就绪后标题显示模型名", /fake-e2e/.test($("aip-model").textContent), $("aip-model").textContent);
  check("配置就绪后不再自动弹配置框（已配好就没必要打扰）", $("ai-cfg-modal").hidden === true);

  // ---- 聊天模式：不带笔记正文 ----
  check("默认在聊天模式", $("aip-create-only").hidden === true);
  check("聊天模式没写内容时不能发送", $("aip-go").disabled === true);
  $("aip-input").value = "你好，请用一句话介绍你自己。";
  fire($("aip-input"), "input", {});
  await sleep(200);
  check("写下内容后「发送」可用", $("aip-go").disabled === false, $("aip-status").textContent);
  $("aip-go").click();
  await waitFor(() => $("aip-log").textContent.indexOf(MARK) >= 0, 10000, "聊天结果");
  {
    const entries = [...$("aip-log").querySelectorAll(".aip-entry")];
    const last = entries[entries.length - 1];
    const btns = [...last.querySelectorAll("button")].map((b) => b.textContent);
    check("聊天条目头标为「聊天 / 不带笔记内容」",
      /聊天/.test(last.textContent) && /不带笔记内容/.test(last.textContent),
      last.textContent.slice(0, 60));
    check("聊天结果只有「复制」，没有写回按钮（写回属于创作）",
      btns.length === 1 && btns[0] === "复制", btns.join(" | "));
  }

  // ---- 创作模式：四个写回操作 ----
  $("aip-view-create").click();
  await sleep(120);
  check("切到创作模式后出现对象与任务", $("aip-create-only").hidden === false);
  await waitFor(() => $("aip-go").disabled === false, 6000, "创作模式可发送");

  const editor = $("editor");
  const before = String(editor.value || "");
  const entriesBefore = $("aip-log").querySelectorAll(".aip-entry").length;
  $("aip-go").click();
  // 注意：不能只等 MARK —— 上一条聊天结果里已经有它了（waitFor 会立刻返回，pop() 拿到的是旧条目）
  await waitFor(() => {
    const es = [...$("aip-log").querySelectorAll(".aip-entry")];
    const last = es[es.length - 1];
    return es.length > entriesBefore && !!last &&
      last.querySelectorAll("button").length > 0 && last.textContent.indexOf(MARK) >= 0;
  }, 10000, "创作结果");
  const entryBtns = [...$("aip-log").querySelectorAll(".aip-entry")].pop().querySelectorAll("button");
  const opTexts = [...entryBtns].map((b) => b.textContent);
  check("创作结果带四个操作按钮",
    ["插入到光标", "替换选中", "追加到末尾", "复制"].every((t) => opTexts.includes(t)), opTexts.join(" | "));

  const copyBtn = [...entryBtns].find((b) => b.textContent === "复制");
  if (copyBtn) {
    copyBtn.click();
    await sleep(80);
    check("「复制」不修改正文", String(editor.value || "") === before);
  }

  const appendBtn = [...entryBtns].find((b) => b.textContent === "追加到末尾");
  if (appendBtn) {
    appendBtn.click();
    await sleep(400);
    const after = String(editor.value || "");
    check("「追加到末尾」把结果写进了编辑器",
      after.indexOf(MARK) >= 0 && after.length > before.length && after.indexOf(before) === 0,
      JSON.stringify(after.slice(-30)));

    const hit = (function walk(dir) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          const r = walk(p);
          if (r) { return r; }
        } else if (e.name.endsWith(".md")) {
          try { if (fs.readFileSync(p, "utf8").indexOf(MARK) >= 0) { return p; } } catch { /* ignore */ }
        }
      }
      return "";
    })(STORAGE_DIR);
    check("写回后立刻落盘（磁盘上能找到该内容）", !!hit, hit ? path.relative(STORAGE_DIR, hit) : "未找到");

    editor.selectionStart = editor.selectionEnd = 0;
    const insertBtn = [...entryBtns].find((b) => b.textContent === "插入到光标");
    if (insertBtn) {
      insertBtn.click();
      await sleep(300);
      check("「插入到光标」插到光标处（开头）",
        String(editor.value || "").indexOf(MARK) === 0,
        JSON.stringify(String(editor.value || "").slice(0, 24)));
    }

    editor.selectionStart = editor.selectionEnd = 0;
    const replaceBtn = [...entryBtns].find((b) => b.textContent === "替换选中");
    if (replaceBtn) {
      replaceBtn.click();
      await sleep(120);
      check("无选区时「替换选中」被拦下并提示（不误改正文）",
        /没有选中内容/.test($("toast").textContent) && $("modal").hidden === true,
        "toast=" + $("toast").textContent);

      const src = String(editor.value || "");
      editor.selectionStart = 0;
      editor.selectionEnd = 5;
      replaceBtn.click();
      await waitFor(() => $("modal").hidden === false, 3000, "替换确认框");
      check("有选区时先弹确认框（显示将被替换的内容）",
        /确认替换选中的内容/.test($("modal").textContent), $("modal").textContent.slice(0, 120));
      const okBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "替换");
      check("确认框里有「替换」按钮", !!okBtn);
      if (okBtn) {
        okBtn.click();
        await sleep(400);
        const replaced = String(editor.value || "");
        // 选区是 [0,5)，结果应精确替换掉这 5 个字符（用前后拼接算出期望值，别用 includes 猜）
        check("确认后完成替换（选区被结果取代）",
          replaced === MARK + src.slice(5),
          JSON.stringify(replaced.slice(0, 30)) + " vs " + JSON.stringify((MARK + src.slice(5)).slice(0, 30)));
      }
    }
  }
  modelSrv.close();
}

/* ---------- 16) 导入 .md（v0.8.7 恢复并增强） ---------- */
{
  const menu = $("more-menu");
  const btn = $("btn-import-md");
  check("「更多」菜单里有「导入 .md」", !!btn && !!menu && menu.contains(btn));
  check("两个导入选择器都在（选文件 / 选文件夹）", !!$("file-input") && !!$("dir-input"));
  check("「选文件夹」用 webkitdirectory（才能拿到相对路径）",
    !!$("dir-input") && $("dir-input").hasAttribute("webkitdirectory"));

  // 点入口先问一句「选文件还是选文件夹」
  btn.click();
  await sleep(60);
  const m = $("modal");
  check("点「导入 .md」先弹出选择方式",
    m.hidden === false && /导入 Markdown 笔记/.test(m.textContent), m.textContent.slice(0, 50));
  check("选择方式里有「选择文件…」与「选择文件夹…」",
    ["选择文件…", "选择文件夹…"].every((t) =>
      [...m.querySelectorAll("button")].some((b) => b.textContent === t)),
    [...m.querySelectorAll("button")].map((b) => b.textContent).join(" | "));
  // 不该再承诺「拖到目录树/编辑器」—— 沙箱里 HTML5 拖放拿不到 dataTransfer.files，做不到的事不要写
  check("导入说明里不再承诺拖放导入（做不到的事不写）",
    !/拖到|拖动|拖拽|拖进/.test(m.textContent), m.textContent.slice(0, 90));
  const cancelBtn = [...m.querySelectorAll("button")].find((b) => b.textContent === "取消");
  cancelBtn.click();
  await sleep(30);
  check("点「取消」关掉弹框", $("modal").hidden === true);

  // jsdom 里点隐藏 input 不会弹系统选择框，所以直接喂 FileList（等价于用户选完文件）
  const mkFile = (name, text, rel) => {
    const f = new window.File([text], name, { type: "text/markdown" });
    Object.defineProperty(f, "webkitRelativePath", { value: rel || "" });
    return f;
  };
  const fRoot = mkFile("读书笔记.md", "# 读书笔记\n\n第一条。", "读书笔记.md");
  const fA = mkFile("a.md", "# 子目录笔记 A\n\nA 的正文。", "我的笔记/子目录/a.md");
  const fB = mkFile("b.md", "这篇没有一级标题。", "我的笔记/子目录/b.md");
  const fi = $("file-input");
  Object.defineProperty(fi, "files", { value: [fRoot, fA, fB], configurable: true });
  fi.dispatchEvent(new window.Event("change"));
  await waitFor(() => $("modal").hidden === false && /导入 \.md 文件/.test($("modal").textContent),
    4000, "导入弹框");

  const im = $("modal");
  check("导入弹框统计了文件数", /共 3 个文件/.test(im.textContent), im.textContent.slice(0, 60));
  check("导入弹框提示会按相对路径重建目录", /重建目录结构/.test(im.textContent));
  check("导入弹框有目标文件夹选择", !!im.querySelector("select"));
  check("导入弹框有三种冲突策略（跳过 / 自动改名 / 覆盖）",
    ["跳过（保留现有）", "自动改名", "覆盖内容"].every((t) => im.textContent.indexOf(t) >= 0));
  const titles = [...im.querySelectorAll(".import-row input")].map((i) => i.value);
  check("每个文件一行标题，默认取首个一级标题（没有则用文件名）",
    titles.length === 3 && titles[0] === "读书笔记" && titles[1] === "子目录笔记 A" && titles[2] === "b",
    titles.join(" | "));
  check("嵌套文件的相对路径有展示出来",
    [...im.querySelectorAll(".import-rel")].some((e) => e.textContent.indexOf("我的笔记/子目录/a.md") >= 0),
    [...im.querySelectorAll(".import-rel")].map((e) => e.textContent).join(" | ") || "（无）");

  // 选「自动改名」→ 开始导入
  const renameRadio = [...im.querySelectorAll('input[name="import-policy"]')]
    .find((r) => r.value === "rename");
  renameRadio.checked = true;
  renameRadio.dispatchEvent(new window.Event("change"));
  [...im.querySelectorAll("button")].find((b) => b.textContent === "开始导入").click();
  await waitFor(() => $("modal").hidden === true, 4000, "导入完成");
  await sleep(600);   // 等 persist 真的落到侧车

  const names = [...doc.querySelectorAll("#tree .node")].map((e) => e.textContent);
  check("根级笔记已导入", names.some((t) => /读书笔记/.test(t)), names.join(" | "));
  check("嵌套目录被重建（我的笔记 / 子目录）",
    names.some((t) => /我的笔记/.test(t)) && names.some((t) => /子目录/.test(t)), names.join(" | "));

  // 关键：磁盘上真的有这些 .md（不是只在内存里）
  const walkAll = (d) => {
    const out = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) out.push(...walkAll(p)); else out.push(p);
    }
    return out;
  };
  const diskFiles = walkAll(STORAGE_DIR);
  const rels = diskFiles.map((p) => path.relative(STORAGE_DIR, p).split(path.sep).join("/"));
  check("导入的 .md 真的落盘了", rels.some((p) => /读书笔记\.md$/.test(p)), rels.join(" | "));
  check("嵌套目录也在磁盘上重建了",
    rels.some((p) => /我的笔记\/子目录\/(a|b)\.md$/.test(p)), rels.join(" | "));
}

/* ---------- 17) 粘贴图片 → 落盘 assets/ → 预览显示 ---------- */
{
  // 渲染器先过一遍纯函数断言（快、稳）
  const md = window.MDNotes && window.MDNotes.renderMarkdown;
  check("渲染器把 assets/ 相对路径渲染成 img 占位",
    typeof md === "function" && /<img class="md-img" data-src="assets\/x\.png"/.test(md("![](assets/x.png)")));
  check("外链图片降级成文字提示（沙箱 CSP 加载不了，别留破图）",
    /md-img-ext/.test(md("![](https://example.com/a.png)")) && !/<img/.test(md("![](https://example.com/a.png)")));

  const note = [...doc.querySelectorAll("#tree .node")]
    .find((el) => el.getAttribute("data-type") === "note");
  check("图片用例：目录树里有笔记可选中", !!note);
  if (note) {
    note.click();
    await sleep(80);
    const ed = $("editor");
    const beforeVal = String(ed.value || "");
    ed.selectionStart = beforeVal.length;
    ed.selectionEnd = beforeVal.length;

    // 1×1 PNG：小到不会走 canvas 压缩（IMG_SMALL 以内），字节可逐字比对
    const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    const pngBytes = Buffer.from(pngB64, "base64");
    const file = new window.File([pngBytes], "shot.png", { type: "image/png" });

    // 模拟粘贴：clipboardData.items 里躺着一个 image/png
    const ev = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] },
    });
    ed.dispatchEvent(ev);

    const inserted = await waitFor(
      () => /!\[[^\]]*\]\(assets\/[^)]+\.png\)/.test(String(ed.value || "")), 8000, "图片插入正文");
    const mRel = /\(((?:assets\/)[^)]+\.png)\)/.exec(String(ed.value || ""));
    const rel = mRel ? mRel[1] : "";
    check("粘贴图片会在光标处插入 Markdown 引用", inserted, rel || "（没插入）");
    check("默认粘贴被拦下（不会把一大串 data: URL 塞进正文）",
      String(ed.value || "").indexOf("data:image") < 0);
    check("原正文没被覆盖（新内容追加在末尾）",
      beforeVal === "" || String(ed.value || "").indexOf(beforeVal) === 0);

    await sleep(500);
    const assetPath = rel ? path.join(STORAGE_DIR, rel.split("/").join(path.sep)) : "";
    check("图片字节真的写进了 <存储目录>/assets/",
      rel !== "" && fs.existsSync(assetPath),
      rel ? path.relative(STORAGE_DIR, assetPath) : "（没拿到相对路径）");
    if (assetPath && fs.existsSync(assetPath)) {
      // 图片是二进制：写入必须是精确字节（base64 解码错了会悄悄坏图）
      check("落盘内容与原始 PNG 逐字节一致（base64 往返没错）",
        fs.readFileSync(assetPath).equals(pngBytes),
        fs.statSync(assetPath).size + "B vs " + pngBytes.length + "B");
    }

    const gotImg = await waitFor(() => !!doc.querySelector("#preview img.md-img"), 6000, "预览图片");
    const img = doc.querySelector("#preview img.md-img");
    check("预览把占位换成真图片（src=blob:）",
      gotImg && !!img && /^blob:/.test(img.src || ""), img ? img.src : "（无 img）");
    check("换完之后不再残留 data-src（否则样式会当它是占位）",
      !!img && !img.hasAttribute("data-src"));

    // 文件不在 → 降级成可点击占位，而不是破图
    ed.value = "![丢了](assets/nope-does-not-exist.png)";
    ed.dispatchEvent(new window.Event("input", { bubbles: true }));
    const fell = await waitFor(() => !!doc.querySelector("#preview .md-img-missing"), 6000, "缺图降级");
    check("图片缺失时降级成可点击占位（不留破图）", fell,
      (doc.querySelector("#preview").textContent || "").slice(0, 60));
  }
}

/* ---------- 18) 备份必须带上图片目录（assets/），恢复要能还原 ---------- */
{
  // 前置：第 17 节已经粘贴过一张图，磁盘上应该有 <storage>/assets/*.png
  const assetsDir = path.join(STORAGE_DIR, "assets");
  const diskAssets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  check("前置条件：assets/ 里已有一张粘贴进来的图", diskAssets.length > 0, diskAssets.join(" | "));

  // 走 UI：更多 → 备份 zip（宿主「另存为」把字节交给 saveCalls）
  $("btn-more").click();
  await sleep(30);
  $("btn-backup-zip").click();
  await sleep(1200);

  const zipCall = saveCalls.filter((c) => c.contentType === "application/zip").pop();
  check("备份走的是宿主另存为", !!zipCall && fs.existsSync(zipCall.path),
    zipCall ? zipCall.path : "（没有调用）");

  let entries = new Map();
  if (zipCall && fs.existsSync(zipCall.path)) {
    entries = zipContents(fs.readFileSync(zipCall.path));
  }

  const assetEntries = [...entries.keys()].filter((n) => n.startsWith("assets/"));
  check("备份包里带上了 assets/ 图片目录",
    assetEntries.length >= diskAssets.length,
    "包内 assets 条目=" + (assetEntries.join(", ") || "（一个都没有）")
      + " · 磁盘上=" + diskAssets.join(", "));

  // 逐字节比对：图片是二进制，写进去时被截断/转码都会悄悄坏掉
  let same = 0, diff = [];
  for (const name of diskAssets) {
    const inZip = entries.get("assets/" + name);
    const onDisk = fs.readFileSync(path.join(assetsDir, name));
    if (inZip && inZip.equals(onDisk)) { same++; } else { diff.push(name); }
  }
  check("包内图片与磁盘上的图片逐字节一致",
    diskAssets.length > 0 && diff.length === 0,
    same + "/" + diskAssets.length + " 一致" + (diff.length ? "，不一致：" + diff.join(",") : ""));

  // 备份成功弹窗要报出图片数量（否则用户从包外无法判断备份是否完整）
  check("备份成功弹窗报出图片数量",
    $("modal").hidden === false && /张图片/.test($("modal").textContent),
    ($("modal").textContent.match(/包含：[^\n]*/) || ["（没有弹窗）"])[0]);
  const closeBk = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "关闭");
  if (closeBk) { closeBk.click(); await sleep(100); }

  // ---- 恢复要把图片放回来：先把 assets/ 整个删掉，再从上面那份包恢复 ----
  if (zipCall && diskAssets.length > 0) {
    const zipBuf = fs.readFileSync(zipCall.path);
    fs.rmSync(assetsDir, { recursive: true, force: true });
    check("现场已破坏（assets/ 被整个删掉）", !fs.existsSync(assetsDir));

    const zipFile = new window.File([new Uint8Array(zipBuf)], path.basename(zipCall.path),
      { type: "application/zip" });
    const input = $("backup-input");
    Object.defineProperty(input, "files", { value: [zipFile], configurable: true });
    fire(input, "change");
    await waitFor(() => $("modal").hidden === false && /确认恢复/.test($("modal").textContent),
      8000, "恢复确认框");
    const goBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "开始恢复");
    check("恢复确认框里能看到「将一并恢复图片」",
      /张图片|一并恢复/.test($("modal").textContent),
      $("modal").textContent.slice(0, 120));
    if (!goBtn) { console.log("  （没找到「开始恢复」按钮，跳过恢复断言）"); }
    else {
      goBtn.click();
      await waitFor(() => $("modal").hidden === false && /恢复完成/.test($("modal").textContent),
        10000, "恢复完成");
      check("恢复完成并回报了图片数量",
        /张图片/.test($("modal").textContent), $("modal").textContent.slice(0, 100));

      const back = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
      check("恢复后 assets/ 里的图片回来了", back.length >= diskAssets.length,
        "恢复后=" + (back.join(", ") || "（空）") + " · 原来=" + diskAssets.join(", "));
      let ok = 0;
      for (const name of diskAssets) {
        const p = path.join(assetsDir, name);
        if (fs.existsSync(p) && entries.get("assets/" + name).equals(fs.readFileSync(p))) { ok++; }
      }
      check("恢复回来的图片逐字节一致", ok === diskAssets.length, ok + "/" + diskAssets.length);

      // 正文里的引用要还能解析到图（否则预览会显示「图片缺失」）
      const note = [...doc.querySelectorAll("#tree .node")].find((el) => el.getAttribute("data-type") === "note");
      if (note) {
        note.click();
        await sleep(600);
        const missing = doc.querySelectorAll("#preview .md-img-missing").length;
        const shown = doc.querySelectorAll("#preview img.md-img").length;
        check("恢复后预览里没有「图片缺失」占位", missing === 0,
          "缺失占位=" + missing + " · 正常图片=" + shown);
      }
      const closeBtn = [...$("modal").querySelectorAll("button")].find((b) => b.textContent === "关闭");
      if (closeBtn) { closeBtn.click(); await sleep(100); }
    }
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
