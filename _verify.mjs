// 校验 .dbxp：条目、manifest.executable、checksums 精确覆盖 + sha256、关键代码标记
// 用法: node _verify.mjs [某个.dbxp]   不给参数时自动取 dist/ 下最新的那个，
// 并拿它和源码 manifest.json 的版本比对（防止「验的是旧包」这种假绿）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
/**
 * 删除测试临时目录 —— 直接 fs.rmSync，就这一行。
 * 本机沙箱对「逐个文件删除」有接管：unlinkSync/rmdirSync 循环几百个文件就卡死十几分钟，
 * cmd rd 反而比 fs.rmSync 慢一个数量级（实测 300 个小文件：rmSync 3.7s / cmd 41s）。
 * 别再加 spawnSync（对任何 exe 直接 EBUSY）或逐文件循环。
 */
function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不该让用例失败 */ }
}

/**
 * 执行子进程并等它结束 —— **只走异步 spawn**。
 * 本机沙箱里 spawnSync(<exe>) 对任何 exe 都立刻 EBUSY，探测用例会误报成「进程没回应」。
 * 返回 { code, signal, out, err, error }；报错时一定要把 error.message 打出来。
 */
function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env }); }
    catch (e) { resolve({ code: null, signal: null, out: "", err: String(e), error: e }); return; }
    let out = "", err = "", done = false, timer = null;
    const finish = (p) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(p); } };
    if (opts.timeoutMs) {
      timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ }
        finish({ code: null, signal: "TIMEOUT", out, err, error: new Error("timeout after " + opts.timeoutMs + "ms") }); }, opts.timeoutMs);
    }
    if (child.stdout) child.stdout.on("data", (c) => { out += c; });
    if (child.stderr) child.stderr.on("data", (c) => { err += c; });
    child.on("error", (e) => finish({ code: null, signal: null, out, err, error: e }));
    child.on("close", (code, signal) => finish({ code, signal, out, err }));
    if (child.stdin) {
      child.stdin.on("error", () => { /* 子进程提前退出时写 stdin 会 EPIPE */ });
      child.stdin.end(opts.input != null ? opts.input : undefined);
    }
  });
}

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

async function probePackagedSidecar() {
  const out = { ok: false, detail: "", versionOk: false, version: "", probeOk: false, probeDetail: "", aiOk: false, aiDetail: "", aiSetOk: false, aiSetDetail: "", assetOk: false, assetDetail: "", assetBkOk: false, assetBkDetail: "", saveOk: false, saveDetail: "", skip: false };
  if (pkgTarget && pkgTarget !== HOST_TARGET) {
    out.skip = true;
    out.detail = `非本机平台（包=${pkgTarget} 本机=${HOST_TARGET}），无法执行 —— 需在该平台真机冒烟`;
    return out;
  }
  const exeBytes = get(exeRel);
  if (!exeBytes) { out.detail = "包内没有该 executable"; return out; }
  // 落到【项目内】的临时目录，而不是 os.tmpdir()：
  // 本机沙箱里从系统 TEMP 直接执行新写入的 exe 会一直 EBUSY（CreateProcess 起不来），
  // 而项目目录下的二进制（backend/*.exe、_xbuild/*）执行是正常的 —— 两个 e2e 就是这么跑的。
  const base = path.join(ROOT, "_verify_tmp", `probe-${process.pid}`);
  const exePath = path.join(base, path.basename(exeRel));
  const dataDir = path.join(base, "data");
  const storeDir = path.join(base, "store");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(exePath, exeBytes);
    if (!exeRel.endsWith(".exe")) { fs.chmodSync(exePath, 0o755); }
    // ⚠️ **侧车是并发处理请求的**（实测回包顺序可以是 1,7,8,2,5），所以「先后依赖」的步骤
    // 不能塞进同一个进程的一次 stdin —— notes/save 还没落盘，notes/backup 就已经回
    // "nothing to backup" 了。凡是有依赖的步骤，各自起一次进程（目录在磁盘上，跨进程可见）。
    const env = { ...process.env, DBX_PLUGIN_DATA_DIR: dataDir };
    const send = (reqs) => runProcess(exePath, [], {
      env,
      input: reqs.map((r) => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n",
      timeoutMs: 60000,
    });
    const parse = (r) => {
      const replies = new Map();
      String(r.out || "").split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        try {
          const m = JSON.parse(line);
          if (m && m.id != null) { replies.set(String(m.id), m); }
        } catch { /* 非 JSON 行忽略 */ }
      });
      return replies;
    };
    // 刚写出来的二进制可能被杀软短暂锁住 → 带重试，且**必须异步 spawn**
    //（本机沙箱里 spawnSync 对任何 exe 都 EBUSY，会被误判成"侧车起不来"）
    const runOnce = async (reqs) => {
      let r = await send(reqs);
      for (let i = 0; i < 4 && r.error &&
           /EBUSY|EPERM|ETXTBSY|EACCES/.test(String(r.error.code || r.error.message)); i++) {
        await new Promise((res) => setTimeout(res, 500));
        r = await send(reqs);
      }
      return { r, replies: parse(r) };
    };

    const first = await runOnce([
      { id: "1", method: "plugin/initialize", params: { host: { protocolVersions: [1] } } },
      { id: "2", method: "notes/probe", params: { storage_dir: storeDir } },
      { id: "3", method: "ai/config", params: {} },
      { id: "4", method: "ai/setConfig", params: { persist: false, model: "probe" } },
    ]);
    const r = first.r;
    const replies = first.replies;
    const init = replies.get("1");
    if (init && init.result && init.result.plugin) {
      out.ok = true;
      out.version = init.result.plugin.version;
      out.versionOk = out.version === mani.version;
    } else if (init && init.error) {
      out.detail = JSON.stringify(init.error).slice(0, 140);
    } else {
      // 把进程本身的错误也报出来：失败原因（EBUSY / 超时 / 权限）与"侧车不回话"完全是两回事，
      // 只写 exit=null 会让人去查侧车，白费时间。
      const why = r.error ? ("进程启动/执行失败：" + r.error.message) : "没有回应";
      out.detail = `${why}（exit=${r.code} signal=${r.signal || "-"} stderr=${String(r.err || "").slice(0, 140)}）`;
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

    // 接下来三步**各有依赖，必须分次起进程**（见上面的并发说明）：
    // 写一篇笔记 → 存一张图 → 整库备份，包里必须带 assets/。
    // 这三件事的「在不在包里」无法靠 grep 判定，只有让包里的二进制真做一次才算证明。
    const save = await runOnce([{
      id: "s", method: "notes/save", params: { storage_dir: storeDir, data: {
        version: 2, activeId: "probe-n1",
        nodes: [{ id: "probe-n1", type: "note", name: "probe 笔记", parentId: null,
          content: "# probe\n\n用于验证备份链路。\n", createdAt: "c", updatedAt: "u" }],
      } },
    }]);
    const saveRep = save.replies.get("s");
    out.saveOk = !!saveRep && !saveRep.error && !!(saveRep.result && saveRep.result.ok);
    out.saveDetail = saveRep
      ? (saveRep.error ? JSON.stringify(saveRep.error).slice(0, 120) : "ok path=" + String((saveRep.result || {}).path || ""))
      : "无响应";

    const putRun = await runOnce([{
      id: "p", method: "notes/putAsset", params: {
        storage_dir: storeDir,
        mime: "image/png",
        // 1×1 PNG，够小够真
        dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
        name: "probe.png",
      },
    }]);
    const put = putRun.replies.get("p");
    out.assetOk = !!put && !put.error && !!(put.result && String(put.result.relPath || "").startsWith("assets/"));
    out.assetDetail = put
      ? (put.error ? JSON.stringify(put.error).slice(0, 120) : String((put.result || {}).relPath || ""))
      : "无响应";

    const bkRun = await runOnce([{ id: "b", method: "notes/backup", params: { storage_dir: storeDir } }]);
    const bk = bkRun.replies.get("b");
    if (!bk || bk.error) {
      out.assetBkOk = false;
      out.assetBkDetail = bk ? JSON.stringify(bk.error).slice(0, 120) : "无响应";
    } else {
      // zip 的条目名以明文存在于本地文件头里，直接在解码后的字节里找 `assets/` 即可。
      const raw = Buffer.from(String((bk.result || {}).dataBase64 || ""), "base64");
      const hasAsset = raw.includes(Buffer.from("assets/", "utf8"));
      out.assetBkOk = hasAsset && raw.length > 0;
      out.assetBkDetail = hasAsset
        ? `备份 ${raw.length}B，含 assets/ 条目（assets=${(bk.result || {}).assets}）`
        : `备份 ${raw.length}B 里没有 assets/ —— 图片没进包`;
    }
    return out;
  } catch (e) {
    out.detail = String((e && e.message) || e);
    return out;
  } finally {
    // 清理：把整个探测目录删掉（base 里包含 exe/data/store 三样）。
    // 不用 fs.rmSync：本机会被接管成"移到回收站"，慢且会抛。
    removeTree(base);
    removeTree(path.dirname(base));   // 顺手清掉空的 _verify_tmp
  }
}
const probeExe = await probePackagedSidecar();
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
const mkCode = get("ui/markdown.js").toString("utf8");
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
  /* ---- 导入 .md（v0.8.7 恢复并增强） ---- */
  ["导入入口已恢复（#btn-import-md / #file-input / #dir-input 都在）",
    liveIds.has("btn-import-md") && liveIds.has("file-input") && liveIds.has("dir-input")],
  ["app.js 开关 ENABLE_IMPORT=true", /var\s+ENABLE_IMPORT\s*=\s*true/.test(apCode)],
  ["导入支持「选文件夹」并会按相对路径重建目录",
    apCode.includes("webkitdirectory") || apCode.includes("webkitRelativePath")],
  ["导入弹框有冲突策略（跳过 / 自动改名 / 覆盖）",
    apCode.includes('"skip"') && apCode.includes('"rename"') && apCode.includes('"overwrite"')],
  ["导入会过滤非 Markdown（选文件夹时目录里所有文件都会送上来）",
    apCode.includes("function mdFilesOnly(")],
  /* ---- 图片（v0.8.7 新增） ---- */
  ["侧车提供图片读写 RPC（notes/putAsset / notes/getAsset）",
    st.includes('"notes/putAsset"') && st.includes('"notes/getAsset"')],
  ["编辑器支持粘贴 / 拖入图片",
    apCode.includes("bindEditorImageCapture") && apCode.includes("clipboardData")],
  ["拖放导入已下线（不再承诺做不到的事）",
    !apCode.includes("hasDroppableFile") &&
    apCode.includes("hasDroppableImage") &&
    !/拖到左侧目录树|也可以直接把文件拖到/.test(apCode)],
  ["备份/恢复提示都会报出图片数量",
    apCode.includes("张图片") && apCode.includes("r.assets")],
  ["图片落盘前会压缩（canvas，GIF 与小于阈值的除外）",
    apCode.includes("prepareImageForStore") && apCode.includes("toBlob")],
  ["渲染器把 assets/ 相对路径渲染成 <img data-src>（外链降级）",
    mkCode.includes('class="md-img"') && mkCode.includes("md-img-ext")],
  ["前端把占位 img 换成 blob: URL（取不到则降级成可点击占位）",
    apCode.includes("resolveMarkdownImages") && apCode.includes("URL.createObjectURL") &&
    apCode.includes("md-img-missing")],
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

  /* ---- 刻意不做「侧边栏 / 工具栏 / 命令面板」入口（v0.8.5 做过、v0.8.6 撤回） ---- */
  ["manifest 刻意不声明 command / menus（会顶掉 mdnotes:// 的文件浏览入口，并把最低宿主抬到 0.6.21）",
    !(mani.contributions || []).some((c) => c.type === "command" || c.type === "menus"),
    (mani.contributions || []).map((c) => c.type).join(" / ")],
  ["engines.dbx 保持 >=0.5.68（没有为了新贡献点抬高）",
    String(mani.engines && mani.engines.dbx) === ">=0.5.68", JSON.stringify(mani.engines)],
  ["本地化键都能对上真实贡献点 id（宿主会把对不上的键判为无效清单）",
    (() => {
      const loc = mani.localizations && mani.localizations.en;
      if (!loc || !loc.contributions) { return false; }
      const ids = new Set((mani.contributions || []).map((c) => c.id));
      return Object.keys(loc.contributions).every((k) => ids.has(k));
    })(),
    Object.keys((mani.localizations && mani.localizations.en && mani.localizations.en.contributions) || {}).join(", ")],

  /* ---- 工具栏折叠（v0.8.5：只保留两个高频按钮） ---- */
  ["工具栏只固定显示「插入 SQL 块」「AI 助手」，其余收进「更多」",
    ix.includes('id="btn-insert-sql"') && ix.includes('id="btn-ai"') &&
    ix.includes('id="btn-more"') && ix.includes('id="more-menu"') &&
    ap.includes("toggleMoreMenu") && ap.includes("closeMoreMenu")],
  ["「更多」菜单默认收起，且能靠点空白 / Esc 关闭",
    /id="more-menu"[^>]*hidden/.test(ix) &&
    ap.includes('setAttribute("aria-expanded"') && ap.includes("closeMoreMenu();")],
  ["「更多」菜单显式声明 [hidden]（否则 display:flex 会顶掉默认隐藏）",
    /\.more-menu\[hidden\]\s*\{[^}]*display:\s*none/.test(cs)],
  ["低频动作仍在 DOM 里且 id 未变（导出/备份/恢复/为表新建）",
    liveIds.has("btn-export-md") && liveIds.has("btn-backup-zip") &&
    liveIds.has("btn-restore-zip") && liveIds.has("btn-table-note")],
  [".dbx-store.json 的 permissions / name 与 manifest 一致（商店会比对）",
    (() => {
      try {
        const pub = JSON.parse(fs.readFileSync(path.join(ROOT, ".dbx-store.json"), "utf8"));
        return JSON.stringify(pub.permissions) === JSON.stringify(mani.permissions) && pub.name === mani.name;
      } catch { return false; }
    })(),
    (() => {
      try { const pub = JSON.parse(fs.readFileSync(path.join(ROOT, ".dbx-store.json"), "utf8")); return pub.name + " / " + JSON.stringify(pub.permissions); } catch { return "(读不到)"; }
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
  ["默认「聊天」模式，创作模式才显示分析对象与任务（#aip-create-only）",
    ix.includes('id="aip-view-chat"') && ix.includes('id="aip-view-create"') && ix.includes('id="aip-create-only"') &&
    ap.includes("aiIsChat") && ap.includes("setAIMode") && ap.includes("renderAIMode")],
  ["聊天结果只带「复制」，创作结果才带四个写回操作",
    ap.includes("AI_OPS_CHAT") && ap.includes("AI_OPS_CREATE") && ap.includes('kind: chat ? "chat" : "create"')],
  ["AI 配置走独立弹框（聊天区里没有内嵌表单）",
    ix.includes('id="ai-cfg-modal"') && !ix.replace(/<!--[\s\S]*?-->/g, "").includes('id="aip-cfg"') &&
    st.includes('"ai/setConfig"') && st.includes('"ai/config"') && st.includes('"ai/resetConfig"') &&
    ap.includes("openAIConfigModal") && ap.includes("submitAIConfig") && ap.includes("clearLocalAIConfig")],
  ["弹框按钮行吸底（内容长时主按钮不会被滚出视野）",
    /\.modal-card\s+\.modal-actions\s*\{[^}]*position:\s*sticky/.test(cs)],
  ["结果支持四种操作（插入到光标 / 替换选中 / 追加到末尾 / 复制）",
    ap.includes('{ op: "insert"') && ap.includes('{ op: "replace"') &&
    ap.includes('{ op: "append"') && ap.includes('{ op: "copy"')],
  ["分析对象可切换 / 可清除（不是打开时钉死的旧值）",
    ix.includes('id="aip-mode-auto"') && ix.includes('id="aip-mode-selection"') &&
    ix.includes('id="aip-mode-note"') && ix.includes('id="aip-mode-none"') &&
    ap.includes("setAITargetMode") && ap.includes("aiTargetUsable") && ap.includes("bindAITargetWatch")],
  ["底栏固定、上半区可滚动（按钮不会被内容挤出视口）",
    ix.includes('id="aip-scroll"') && cs.includes(".aip-scroll") &&
    /\.aip-compose\s*\{[^}]*flex:\s*none/.test(cs) && /#app\s*\{[^}]*grid-template-rows/.test(cs)],
  ["没有分析对象时「提问 / 续写」仍可发送（纯对话 / 自由生成）",
    ap.includes("noContext") && ap.includes("aiCanRun") && ap.includes("aiInputText") &&
    ap.includes("不带笔记内容")],
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
  ["包内侧车能写笔记（notes/save 真的落盘）", probeExe.saveOk, probeExe.saveDetail, probeExe.skip ? "skip" : ""],
  ["包内侧车能存图片（notes/putAsset 真的可用）", probeExe.assetOk, probeExe.assetDetail, probeExe.skip ? "skip" : ""],
  ["包内备份带上 assets/ 图片目录（不漏图）", probeExe.assetBkOk, probeExe.assetBkDetail, probeExe.skip ? "skip" : ""],
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
