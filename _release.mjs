// 一次产出**全部平台**的候选包 + `release-candidates.json`。
//
// 背景（官方文档与 CLI 源码实证）：
//   - `dbx-plugin package` 只按**当前宿主**平台打包；显式传 --target 指向别的平台会被拒绝：
//     "Native plugin target 'X' does not match build host 'Y'; run this package command on the target platform"
//     → 官方的多平台做法是在 CI 上开平台矩阵，各自构建，再合并出 release-candidates.json。
//   - 本插件的侧车是 **纯 Go、无 cgo**，所以可以直接交叉编译（CGO_ENABLED=0），
//     在 Windows 上就能产出 darwin-arm64 / linux-x64 的合法包。
//     ⚠️ 交叉编译的是**字节正确**，不等于**在目标机上验证过** —— 真机冒烟仍需各平台跑一次。
//
// 用法：
//   node _release.mjs                                  # windows-x64 + darwin-arm64 + linux-x64
//   node _release.mjs windows-x64 linux-x64            # 只做指定平台
//
// 产物：
//   dist/<id>-<version>-<target>.dbxp
//   dist/<id>-<version>-<target>.artifact.json
//   dist/release-candidates.json
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = "D:/core/web/dbx-pj/dbx-md-notes";
const BINARY = "dbx-plugin-mdnotes";
const GO = process.env.DBX_GO || "D:/apply/go1.25/bin/go.exe";
const GOROOT = process.env.DBX_GOROOT || "D:/apply/go1.25";
const NODE = process.execPath;

// target → Go 工具链三元组（官方 current_target() 的命名：darwin/linux/windows + arm64/x64）
const TRIPLES = {
  "windows-x64": ["windows", "amd64"],
  "windows-arm64": ["windows", "arm64"],
  "darwin-arm64": ["darwin", "arm64"],
  "darwin-x64": ["darwin", "amd64"],
  "linux-x64": ["linux", "amd64"],
  "linux-arm64": ["linux", "arm64"],
};
const DEFAULT_TARGETS = ["windows-x64", "darwin-arm64", "linux-x64"];
const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = (targets.length ? targets : DEFAULT_TARGETS).slice().sort();

for (const t of list) {
  if (!TRIPLES[t]) {
    console.error(`[FATAL] 未知 target：${t}。已知：${Object.keys(TRIPLES).join(", ")}`);
    process.exit(1);
  }
}

const mani = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const ver = mani.version;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    console.error(`[FATAL] 命令失败（exit ${r.status}）：${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
  return r.stdout || "";
}

console.log(`=== 构建 ${list.length} 个平台：${list.join(", ")} ===\n`);

// ---- 1) 交叉编译侧车 ----
for (const t of list) {
  const [goos, goarch] = TRIPLES[t];
  // 注意：`go build -C backend` 会先切到 backend/，所以 -o 是相对 backend/ 的。
  const outArg = t === "windows-x64"
    ? `${BINARY}.exe`                                        // 本机产物，e2e 也读这份
    : `../_xbuild/${BINARY}-${goos}-${goarch}`;
  const shown = outArg.replace(/^\.\.\//, "");
  process.stdout.write(`[build] ${t.padEnd(13)} GOOS=${goos} GOARCH=${goarch} -> ${shown}\n`);
  run(GO, ["build", "-C", "backend", "-o", outArg, "."], {
    env: { ...process.env, GOROOT, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  });
}

// ---- 2) 逐平台打包 ----
console.log("");
for (const t of list) {
  run(NODE, [path.join(ROOT, "_buildpkg.js"), "--target", t]);
}

// ---- 3) 逐包校验（包结构 / checksums / executable 路径与扩展名） ----
console.log("");
const pkgOf = (t) => path.join(ROOT, "dist", `${mani.id}-${ver}-${t}.dbxp`);
for (const t of list) {
  console.log(`--- verify ${t} ---`);
  run(NODE, [path.join(ROOT, "_verify.mjs"), pkgOf(t)]);
}

// ---- 4) 汇总 release-candidates.json ----
// 结构对齐 DBX Store 官方发布流程：plugin 元信息 + artifacts（每个平台的 target/url/sha256/size）。
// url 用**文件名**（与官方 artifact.json 一致）；候选包本体放在 GitHub Release / CDN 上，
// 由 dbx-store 的同步 Workflow 读取本文件生成候选 PR。
const artifacts = [];
for (const t of list) {
  const ap = path.join(ROOT, "dist", `${mani.id}-${ver}-${t}.artifact.json`);
  if (!fs.existsSync(ap)) {
    console.error(`[FATAL] 缺少 ${path.basename(ap)}`);
    process.exit(1);
  }
  const a = JSON.parse(fs.readFileSync(ap, "utf8"));
  artifacts.push({ target: a.target, url: a.url, sha256: a.sha256, size: a.size });
}
artifacts.sort((x, y) => x.target.localeCompare(y.target));

const payload = {
  plugin: {
    id: mani.id,
    name: mani.name,
    description: mani.description,
    publisher: mani.publisher,
    version: mani.version,
    permissions: mani.permissions || [],
  },
  artifacts,
};
const rcPath = path.join(ROOT, "dist", "release-candidates.json");
fs.writeFileSync(rcPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

console.log("\n=== release-candidates.json ===");
console.log(JSON.stringify(payload, null, 2));
console.log(`\n已写出 ${rcPath}`);
console.log(`共 ${artifacts.length} 个平台产物：${artifacts.map((a) => a.target + "(" + a.size + "B)").join("  ")}`);
