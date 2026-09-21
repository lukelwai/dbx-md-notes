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
const SAVED_DIR = path.join(TMP, "saved");   // 模拟「用户在原生另存为对话框里选的目录」
const BRIDGE_PAYLOAD_LIMIT = 2 * 1024 * 1024;

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SAVED_DIR, { recursive: true });

/** 跨 realm 取字节：插件在 vm realm 里造 ArrayBuffer，host 侧 instanceof 判不出来 */
function toU8(v) {
  if (!v) return null;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v.byteLength === "number" && typeof v.slice === "function") return new Uint8Array(v);
  return null;
}

/** 极简 zip 中央目录读取（只为断言包内条目名，不解析内容） */
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
  if (method === "host.saveFile") {
    // 照 pluginHostBridge.ts 的 host.saveFile 分支：字节优先来自 transfer，其次 dataBase64
    const input = req.params || {};
    let data = toU8(req.data);
    if (!data && typeof input.dataBase64 === "string") data = new Uint8Array(Buffer.from(input.dataBase64, "base64"));
    if (!data) throw new Error("host.saveFile requires transferred binary data or dataBase64");
    if (data.byteLength > 512 * 1024 * 1024) throw new Error("Plugin save payload exceeds 512 MiB");
    // 这里代表「宿主弹原生对话框、用户选目录并确认」——直接用 fileName 落到 SAVED_DIR
    const target = path.join(SAVED_DIR, String(input.fileName || "unnamed.bin"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(data));
    return { path: target };
  }
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

  // 反面护栏：版本必须来自运行时读包内 manifest，不能是编译期常量（发版必漂移）
  const ping = await sidecar("notes/ping", {});
  check("侧车 ping 报的版本与 manifest 一致（防常量漂移）",
    ping.version === manifest.version, `${ping.version} vs ${manifest.version}`);

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

  /* ---------- 导出 / 备份：必须走宿主「另存为」，让用户自选目录 ---------- */
  check("storage.js 识别到宿主 saveFile 能力", S.hasHostSave() === true);

  const ex = await S.invoke("notes/exportNote", { id: "n1" });
  check("导出默认返回字节、不自己写盘",
    typeof ex.dataBase64 === "string" && ex.path === undefined, "fileName=" + ex.fileName);
  const exr = await S.saveFile(ex.fileName, "text/markdown", ex.dataBase64);
  check("导出走宿主另存为成功", exr.ok === true, exr.error);
  const exPath = path.join(SAVED_DIR, "重构验证.md");
  check("导出的 .md 落在「用户所选目录」", fs.existsSync(exPath), exPath);
  if (fs.existsSync(exPath)) {
    check("导出内容正确", fs.readFileSync(exPath, "utf8").includes("存储链路已打通"));
  }

  const bk = await S.invoke("notes/backup", {});
  check("备份返回字节 + 配置（不写进存储目录）",
    typeof bk.dataBase64 === "string" && bk.path === undefined && !!bk.storageDir && bk.count === 1,
    `count=${bk.count} folders=${bk.folders} bytes=${bk.bytes}`);
  const bkr = await S.saveFile(bk.fileName, "application/zip", bk.dataBase64);
  check("备份走宿主另存为成功", bkr.ok === true, bkr.error);
  const zipPath = path.join(SAVED_DIR, bk.fileName);
  check("备份 zip 落在「用户所选目录」", fs.existsSync(zipPath), zipPath);

  // 备份包里必须同时有「配置」和「目录树索引」，否则恢复出来只是一堆孤儿文件
  const names = zipEntries(fs.readFileSync(zipPath));
  check("备份包含配置 mdnotes-backup.json", names.includes("mdnotes-backup.json"), names.join(", "));
  check("备份包含目录树索引 .mdnotes/meta.json", names.includes(".mdnotes/meta.json"));
  check("备份包含正文", names.some((n) => n.endsWith("重构验证.md")));
  check("备份条目名用正斜杠（不是 Windows 反斜杠）", !names.some((n) => n.includes("\\")));

  /* ---------- 恢复：把备份灌回去 ---------- */
  const b64 = fs.readFileSync(zipPath).toString("base64");
  const dir = await S.invoke("notes/restore", { dataBase64: b64, dryRun: true });
  check("恢复 dryRun 回报包内容",
    dir.dryRun === true && dir.notes === 1 && dir.folders === 1,
    `notes=${dir.notes} folders=${dir.folders} ver=${dir.backup && dir.backup.version}`);
  check("dryRun 不改动磁盘", fs.existsSync(file));

  // 先把现场搞坏（改名一篇笔记），再恢复，验证真的能回到备份时的状态
  const broken = JSON.parse(JSON.stringify(snapshot));
  broken.nodes[1].name = "被改坏的名字";
  await S.save(broken, false);
  const brokenPath = path.join(STORAGE_DIR, "工作/被改坏的名字.md");
  check("现场已破坏（改名生效）", fs.existsSync(brokenPath), brokenPath);

  const rst = await S.invoke("notes/restore", { dataBase64: b64 });
  check("恢复成功", rst.ok === true);
  check("恢复后原文件名回来了", fs.existsSync(file), file);
  check("恢复前留下了退路快照",
    !!rst.safetyPath && fs.existsSync(rst.safetyPath), rst.safetyPath || "(无)");

  const after = await S.reload();
  check("恢复后回读到 2 个节点",
    !!(after.data && after.data.nodes && after.data.nodes.length === 2),
    "nodes=" + (after.data && after.data.nodes ? after.data.nodes.length : "null"));
  if (after.data && after.data.nodes) {
    const n1 = after.data.nodes.find((n) => n.id === "n1");
    check("恢复后笔记名与正文都复原",
      !!n1 && n1.name === "重构验证" && String(n1.content || "").includes("存储链路已打通"),
      n1 ? n1.name : "(找不到 n1)");
  }

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
