// 从源码直接构造 .dbxp（zip）。
//
// 必须复刻官方 `dbx-plugin package` 的三条硬规则，否则宿主在安装阶段就直接拒绝
// （宿主源码 crates/dbx-plugin-runtime/src/plugins/installer.rs 与 manifest.rs）：
//
//   1) manifest.entrypoints.backend.executable 必须指向包内【真实存在】的文件。
//      官方打包器会把它重写成 bin/<target>/<binary>[.exe]（target 形如 windows-x64，
//      **只有 windows 目标才带 .exe** —— 官方 CLI 的 executable_name() 就是这么定的）。
//      宿主解析时不会自动补 ".exe"，也不会做 target 目录替换 —— 名字对不上就是
//      "Plugin backend executable does not exist" → 整个包判为 incompatible。
//   2) 必须包含 checksums.json（algorithm 必须是 "sha256"），且 files 必须
//      【精确等于】包内除 checksums.json / signature.json 之外的每一个文件。
//      少一个多一个都是 "Plugin checksums do not cover the package exactly"。
//   3) signature.json 可省，但只能在插件中心开启「允许安装未签名开发包」后安装。
//
// 这三条里 1 和 2 任何一条不满足，安装会直接失败，表现为「装完之后什么也存不了」。
//
// 用法：
//   node _buildpkg.js                            # 默认 windows-x64（用 backend/ 下的本机构建产物）
//   node _buildpkg.js --target linux-x64         # 用 _xbuild/ 下的交叉编译产物
//   node _buildpkg.js --target darwin-arm64 --exe <path>
//
// 关于多平台：官方 CLI（dbx-plugin package）**拒绝**为「非当前宿主」的 target 打包
// （"Native plugin target 'X' does not match build host 'Y'; run this package command on the target platform"），
// 官方推荐的做法是在 CI 上按平台矩阵分别构建。但本插件的侧车是**纯 Go、无 cgo**，
// 可以直接交叉编译（见 _release.mjs），因此本地也能产出其它平台的合法包。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const root = "D:/core/web/dbx-pj/dbx-md-notes/";
const binary = "dbx-plugin-mdnotes";       // 与 dbx-plugin.toml [backend].binary 一致

const argv = process.argv.slice(2);
function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
}
const target = argValue("--target") || "windows-x64";   // current_target(): {os}-{arch}
if (!/^[a-z0-9-]{1,64}$/.test(target)) {
  console.error(`\n[FATAL] target 含非法字符：${target}（只允许小写字母/数字/-，与官方 validate_artifact_target 一致）\n`);
  process.exit(1);
}

// 目标 → Go 的 GOOS/GOARCH。windows-x64 用 backend/ 下本机构建的那份，其余用交叉编译产物。
const GO_TRIPLES = {
  "windows-x64": ["windows", "amd64"],
  "windows-arm64": ["windows", "arm64"],
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "linux-x64": ["linux", "amd64"],
  "linux-arm64": ["linux", "arm64"],
};
function resolveExe() {
  const explicit = argValue("--exe");
  if (explicit) { return explicit; }
  if (target === "windows-x64") { return root + `backend/${binary}.exe`; }
  const t = GO_TRIPLES[target];
  if (!t) {
    console.error(`\n[FATAL] 未知 target：${target}。已知：${Object.keys(GO_TRIPLES).join(", ")}\n`);
    process.exit(1);
  }
  return root + `_xbuild/${binary}-${t[0]}-${t[1]}`;
}

const mani = JSON.parse(fs.readFileSync(root + "manifest.json", "utf8"));
const ver = mani.version || "0.0.0";
// 只有 windows 目标带 .exe（对齐官方 executable_name()）
const exeRel = `bin/${target}/${binary}${target.startsWith("windows") ? ".exe" : ""}`;
const exePath = resolveExe();
const out = root + `dist/${mani.id}-${ver}-${target}.dbxp`;

if (!fs.existsSync(exePath)) {
  console.error(`\n[FATAL] 找不到 target=${target} 的侧车二进制：${exePath}`);
  console.error(`        先构建：CGO_ENABLED=0 GOOS=<os> GOARCH=<arch> go build -C backend -o ../_xbuild/${binary}-<os>-<arch> .`);
  console.error(`        （或直接跑 node _release.mjs 一次产出全部平台）\n`);
  process.exit(1);
}

// ---- 1) 重写 manifest，使 executable 与包内真实路径一致 ----
mani.entrypoints = mani.entrypoints || {};
mani.entrypoints.backend = Object.assign({}, mani.entrypoints.backend, { executable: exeRel });
const manifestBytes = Buffer.from(JSON.stringify(mani, null, 2) + "\n", "utf8");

// ---- 1.5) 前端自检：这两个 bug 都曾经让「整个 UI 静默死掉、笔记永远存不了」----
const htmlRaw = fs.readFileSync(root + "ui/index.html", "utf8");
const htmlLive = htmlRaw.replace(/<!--[\s\S]*?-->/g, "");          // 去掉注释后的真实 DOM
const liveIds = new Set([...htmlLive.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const appSrc = fs.readFileSync(root + "ui/app.js", "utf8");
const storeSrc = fs.readFileSync(root + "ui/storage.js", "utf8");
// 扫描前先去掉注释：注释里会引用历史错误代码（例如 `$("x").onclick = ...`），不能当真
const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// (a) app.js 里出现 `$("x").` 时，x 必须真实存在；否则 = 赋值到 null = TypeError，
//     而它往往位于 bindEvents/boot 开头，会把整个界面连坐搞死。
const unsafe = [...appCode.matchAll(/\$\("([^"]+)"\)\s*\./g)].map(m => m[1]);
const badRefs = [...new Set(unsafe.filter(id => !liveIds.has(id)))];
if (badRefs.length) {
  console.error("\n[FATAL] app.js 对不存在的 DOM 元素做了属性访问（会导致启动中断）：");
  const srcLines = appSrc.split("\n");
  for (const id of badRefs) {
    const at = srcLines.map((l, i) => l.includes(`$("${id}")`) ? i + 1 : 0).filter(Boolean);
    console.error(`   - #${id}  (app.js 行 ${at.join(", ") || "?"})`);
  }
  console.error("   修复：改用安全绑定 click(id, fn) / on(id, ev, fn)，或把元素从 HTML 注释里放出来。\n");
  process.exit(1);
}

// (b) 关键 UI 节点必须在 index.html 里真实存在
const CRITICAL = ["main", "store-status", "store-text", "tree", "editor", "title",
  "ai-panel", "aip-log", "aip-go", "gutter-side", "gutter-ai"];
const missingCritical = CRITICAL.filter(id => !liveIds.has(id));
if (missingCritical.length) {
  console.error("\n[FATAL] index.html 缺少关键元素：" + missingCritical.join(", ") + "\n");
  process.exit(1);
}

// (b2) 同名函数声明：后声明的会静默覆盖前面的，函数名撞车不会有任何提示。//      2026-09-21 事故：confirmModal 定义两次（一个收字符串、一个收数组），
//      后者顶掉前者 → removeNode 传字符串进去 `lines.join is not a function` 抛错，
//      表现成「点删除毫无反应」。
const fnLines = {};
appCode.split(/\r?\n/).forEach((l, i) => {
  const m = /^  function (\w+)\s*\(/.exec(l);
  if (m) { (fnLines[m[1]] = fnLines[m[1]] || []).push(i + 1); }
});
const dupFns = Object.keys(fnLines).filter(k => fnLines[k].length > 1);
if (dupFns.length) {
  console.error("\n[FATAL] app.js 存在重复的函数声明（后者会覆盖前者，必须改名）：");
  dupFns.forEach(k => console.error(`   - ${k}  (行 ${fnLines[k].join(", ")})`));
  console.error("");
  process.exit(1);
}

// (d) 置顶诊断条的开关必须与 HTML 一致：开关 true 就得有元素，false 就不能有，
//     否则「开关开了但元素被注释」= renderDiag 静默 return，排障时白等一场。
const showDiagBar = /var\s+SHOW_DIAG_BAR\s*=\s*(true|false)/.exec(appCode);
if (!showDiagBar) {
  console.error("\n[FATAL] app.js 缺少 SHOW_DIAG_BAR 开关（置顶诊断条的状态无法自证）。\n");
  process.exit(1);
}
const diagBarLive = liveIds.has("diag-bar");
if (showDiagBar[1] === "true" && !diagBarLive) {
  console.error("\n[FATAL] SHOW_DIAG_BAR=true 但 index.html 里 #diag-bar 仍被注释：请一并放开。\n");
  process.exit(1);
}
if (showDiagBar[1] === "false" && diagBarLive) {
  console.error("\n[FATAL] SHOW_DIAG_BAR=false 但 index.html 里 #diag-bar 仍存在：上线不该出现。\n");
  process.exit(1);
}

// (d2) 功能开关 ENABLE_IMPORT 必须与 HTML 一致：开关关掉就该连入口一起摘掉，
//      否则会出现「按钮在、点了没反应」——比没有按钮更让人困惑。
const enableImport = /var\s+ENABLE_IMPORT\s*=\s*(true|false)/.exec(appCode);
if (!enableImport) {
  console.error("\n[FATAL] app.js 缺少 ENABLE_IMPORT 开关（导入功能的启用状态无法自证）。\n");
  process.exit(1);
}
const importBtnLive = liveIds.has("btn-import-md");
const importInputLive = liveIds.has("file-input");
if (enableImport[1] === "false" && (importBtnLive || importInputLive)) {
  console.error("\n[FATAL] ENABLE_IMPORT=false 但 index.html 里 #btn-import-md 或 #file-input 仍存在：请一并注释掉。\n");
  process.exit(1);
}
if (enableImport[1] === "true" && !(importBtnLive && importInputLive)) {
  console.error("\n[FATAL] ENABLE_IMPORT=true 但 index.html 里 #btn-import-md / #file-input 被注释：请一并放开。\n");
  process.exit(1);
}

// (d3) 权限：本插件刻意【不依赖】宿主内置 AI。
//      host.ai 只在 ≥0.6.20 的宿主上存在，而 permissions 是静态的 —— 声明它会让老宿主
//      在安装阶段直接拒绝整个包，为了一个「不返回模型回复」的入口把用户全挡在门外并不值。
//      这里把它固化成闸门，防止日后又被顺手加回来。
if ((mani.permissions || []).indexOf("host.ai") >= 0) {
  console.error("\n[FATAL] manifest 声明了 host.ai：本插件只用自配第三方模型，不应依赖宿主内置 AI。");
  console.error("        它会把最低宿主抬到 0.6.20，且旧宿主会在安装阶段直接拒绝整个包。\n");
  process.exit(1);
}
// (d4) .dbx-store.json 的 permissions 必须与 manifest 一致，
//      否则商店报 "Marketplace package permissions do not match catalog permissions"。
try {
  const pub = JSON.parse(fs.readFileSync(root + ".dbx-store.json", "utf8"));
  if (JSON.stringify(pub.permissions) !== JSON.stringify(mani.permissions)) {
    console.error("\n[FATAL] .dbx-store.json 的 permissions 与 manifest 不一致（商店会拒绝这个包）：");
    console.error("        manifest   : " + JSON.stringify(mani.permissions));
    console.error("        .dbx-store : " + JSON.stringify(pub.permissions) + "\n");
    process.exit(1);
  }
} catch (e) {
  console.warn("\n[WARN] 读不到 .dbx-store.json（跳过权限一致性检查）：" + e.message + "\n");
}

// (c) 前端 UI 版本号必须与 manifest 一致，避免「装的是新版、跑的是旧代码」
const uiVer = (storeSrc.match(/var UI_VERSION = "([^"]+)"/) || [])[1];

if (uiVer !== ver) {
  console.error(`\n[FATAL] ui/storage.js UI_VERSION=${uiVer} 与 manifest.version=${ver} 不一致。\n`);
  process.exit(1);
}
console.log("  自检通过：DOM 引用 0 处悬空 / 关键元素齐备 / UI_VERSION=" + uiVer);

// (e) 发布前提醒：别再拿占位身份发出去（发布包用 example 占位会与别人的插件撞 id）
if (!mani.publisher || mani.publisher === "example" || /^com\.example\./.test(mani.id)) {
  console.warn("\n[WARN] manifest 的 id / publisher 仍是占位值（" + mani.id + " / " + mani.publisher +
    "）：正式发布前请改成自己的。\n");
}

// ---- 2) 收集包内文件（跳过 _ 前缀临时文件与隐藏文件）----
const files = [
  ["manifest.json", manifestBytes],
  [exeRel, fs.readFileSync(exePath)],
];
for (const dir of ["assets", "ui"]) {
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp, rel + "/" + e.name);
      else files.push([rel + "/" + e.name, fs.readFileSync(fp)]);
    }
  })(root + dir, dir);
}

// ---- 3) checksums.json 必须精确覆盖除自身与 signature.json 外的全部文件 ----
const checksums = { algorithm: "sha256", files: {} };
for (const [name, data] of files) {
  checksums.files[name] = crypto.createHash("sha256").update(data).digest("hex");
}
files.push(["checksums.json", Buffer.from(JSON.stringify(checksums, null, 2) + "\n", "utf8")]);

// ---- 4) 写出 zip（deflate）----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const local = [];
const central = [];
for (const [name, data] of files) {
  const nameBuf = Buffer.from(name, "utf8");
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const off = Buffer.concat(local).length;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8);              // deflate
  lh.writeUInt16LE(0, 10);
  lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  local.push(lh, nameBuf, comp);

  // ---- Unix 权限位（macOS/Linux 上必须写对，否则侧车起不来）----
  // 宿主安装器（installer.rs）在 Unix 上会执行：
  //     if let Some(mode) = entry.unix_mode() { set_permissions(from_mode(mode & 0o777)) }
  // 而 zip crate 的 unix_mode() 在 `external_attributes == 0` 时直接返回 None
  //   → 宿主跳过设权限 → 解出来的文件是默认 0o644 → **侧车没有可执行位，无法启动**。
  // 官方打包器给 bin/<target>/ 下的文件 0o755、其余 0o644；这里照做。
  // 模式位存在 external_attributes 的高 16 位，且要高字节声明 System::Unix（3）才会被读取。
  const isExe = name === exeRel;
  const unixMode = isExe ? 0o100755 : 0o100644;   // S_IFREG | 权限（与 zip crate 的写法一致）
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE((3 << 8) | 20, 4);  // version made by：高字节 3 = Unix
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  // 注意：JS 的 `<<` 是 32 位【有符号】运算，0o100644<<16 会溢出成负数 —— 必须用乘法。
  ch.writeUInt32LE((unixMode * 0x10000) >>> 0, 38);
  ch.writeUInt32LE(off, 42);
  central.push(Buffer.concat([ch, nameBuf]));
}

const body = Buffer.concat(local);
const cd = Buffer.concat(central);
const eo = Buffer.alloc(22);
eo.writeUInt32LE(0x06054b50, 0);
eo.writeUInt16LE(files.length, 8);
eo.writeUInt16LE(files.length, 10);
eo.writeUInt32LE(cd.length, 12);
eo.writeUInt32LE(body.length, 16);

fs.mkdirSync(root + "dist", { recursive: true });
const pkg = Buffer.concat([body, cd, eo]);
fs.writeFileSync(out, pkg);

// 顺带产出官方同名的 artifact.json
fs.writeFileSync(out.replace(/\.dbxp$/, ".artifact.json"), JSON.stringify({
  target,
  url: path.basename(out),
  sha256: crypto.createHash("sha256").update(pkg).digest("hex"),
  size: pkg.length,
}, null, 2) + "\n");

console.log("built " + out);
console.log("  target=" + target + "  size=" + pkg.length + "  entries=" + files.length);
console.log("  executable=" + exeRel + "  version=" + ver);
