// 校验 .dbxp：条目、manifest.executable、checksums 精确覆盖 + sha256、关键代码标记
// 用法: node _verify.mjs [某个.dbxp]   不给参数时自动取 dist/ 下最新的那个，
// 并拿它和源码 manifest.json 的版本比对（防止「验的是旧包」这种假绿）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const ROOT = "D:/core/web/dbx-pj/dbx-md-notes";
const srcVer = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
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

const checks = [
  ["manifest.version 与源码一致", mani.version === srcVer, mani.version + " vs " + srcVer],
  ["executable 指向 bin/windows-x64/*.exe", /^bin\/windows-x64\/dbx-plugin-mdnotes\.exe$/.test(exeRel), exeRel],
  ["executable 在包内真实存在", has(exeRel)],
  ["checksums.algorithm = sha256", cks.algorithm === "sha256", cks.algorithm],
  ["checksums 精确覆盖包内文件", JSON.stringify(inPkg) === JSON.stringify(listed), "包内" + inPkg.length + " / 清单" + listed.length],
  ["全部 sha256 匹配", mismatch.length === 0, mismatch.join(",")],
  ["无 _ 前缀临时文件混入", !es.some((e) => /(^|\/)_/.test(e.name))],
];
const st = get("ui/storage.js").toString("utf8");
const exeStr = (get(exeRel) || Buffer.alloc(0)).toString("latin1");
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
  ["打包的侧车含「显式删除」语义（deletedIds 结构标签）", exeStr.includes("deletedIds")],
  ["打包的侧车含回收站语义（trash）", exeStr.includes("trash")],
  ["app.js 用安全绑定 click()/on()（缺失元素不再连坐）", apCode.includes("function on(id, evName, handler, optional)")],
  ["app.js 没有对缺失元素直接取属性", dangling.length === 0, dangling.join(",")],
  ["app.js 捕获页面级未处理异常", apCode.includes("unhandledrejection") && apCode.includes('window.addEventListener("error"')],
  ["app.js 不再用 dbxPlugin.ready 卡住启动", !/dbxPlugin\.ready\.then\(boot\)/.test(apCode)],
  ["app.js 保留存储诊断面板代码（开关关闭）", ap.includes("m-diag")],
  ["app.js 未持久化时不 seed 示例", ap.includes("res.firstRun && S.status().persistent")],
  ["storage.js 的 UI_VERSION 与 manifest 一致",
    (st.match(/var UI_VERSION = "([^"]+)"/) || [])[1] === srcVer,
    (st.match(/var UI_VERSION = "([^"]+)"/) || [])[1]],
);

console.log("=== 校验 ===");
let fails = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) fails++;
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  |  " + extra : ""));
}
console.log("\nRESULT: " + (fails ? "FAIL(" + fails + ")" : "PASS"));
process.exit(fails ? 1 : 0);
