// Inspect a .dbxp: list entries, dump manifest.json / checksums.json, verify checksums.
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");

const file = process.argv[2];
const buf = fs.readFileSync(file);

// locate EOCD
let off = buf.length - 22;
while (off >= 0 && buf.readUInt32LE(off) !== 0x06054b50) off--;
if (off < 0) { console.log("not a zip"); process.exit(1); }
const count = buf.readUInt16LE(off + 10);
const cdOff = buf.readUInt32LE(off + 16);

const entries = [];
let p = cdOff;
for (let i = 0; i < count; i++) {
  const method = buf.readUInt16LE(p + 10);
  const crc = buf.readUInt32LE(p + 16);
  const csize = buf.readUInt32LE(p + 20);
  const usize = buf.readUInt32LE(p + 24);
  const nlen = buf.readUInt16LE(p + 28);
  const elen = buf.readUInt16LE(p + 30);
  const clen = buf.readUInt16LE(p + 32);
  const lho = buf.readUInt32LE(p + 42);
  const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
  // local header
  const lnlen = buf.readUInt16LE(lho + 26);
  const lelen = buf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + lnlen + lelen;
  const raw = buf.slice(dataStart, dataStart + csize);
  let data;
  if (method === 0) data = raw;
  else if (method === 8) data = zlib.inflateRawSync(raw);
  else { console.log("  unsupported method " + method + " for " + name); data = null; }
  entries.push({ name, method, crc, csize, usize, data });
  p += 46 + nlen + elen + clen;
}

console.log("=== " + file + " ===");
console.log("entries: " + entries.length);
for (const e of entries) {
  console.log("  " + e.name + "  method=" + e.method + "  size=" + e.usize + (e.data ? "  crcOK=" + ((crc32(e.data) >>> 0) === (e.crc >>> 0)) : ""));
}

const manifest = entries.find(e => e.name === "manifest.json");
if (manifest) {
  const m = JSON.parse(manifest.data.toString("utf8"));
  console.log("\n=== manifest ===");
  console.log("id=" + m.id + "  version=" + m.version);
  console.log("entrypoints.backend = " + JSON.stringify(m.entrypoints && m.entrypoints.backend));
  console.log("entrypoints.ui = " + JSON.stringify(m.entrypoints && m.entrypoints.ui));
  const exePath = m.entrypoints && m.entrypoints.backend && m.entrypoints.backend.executable;
  const exists = entries.some(e => e.name === exePath);
  console.log(">>> backend executable declared: " + JSON.stringify(exePath));
  console.log(">>> file present in package? " + exists + (exists ? "" : "   <<<< 致命：宿主会判 incompatible"));
}

const ck = entries.find(e => e.name === "checksums.json");
if (!ck) {
  console.log("\n>>> checksums.json MISSING  <<<< 致命：安装器直接拒绝");
} else {
  const c = JSON.parse(ck.data.toString("utf8"));
  console.log("\n=== checksums.json ===");
  console.log("algorithm=" + c.algorithm + "  files=" + Object.keys(c.files).length);
  const declared = new Set(Object.keys(c.files));
  const actual = new Set(entries.map(e => e.name).filter(n => n !== "checksums.json" && n !== "signature.json"));
  const missing = [...actual].filter(x => !declared.has(x));
  const extra = [...declared].filter(x => !actual.has(x));
  console.log("missing in checksums: " + (missing.length ? JSON.stringify(missing) : "none"));
  console.log("extra in checksums:   " + (extra.length ? JSON.stringify(extra) : "none"));
  let bad = 0;
  for (const e of entries) {
    if (!(e.name in c.files)) continue;
    const h = crypto.createHash("sha256").update(e.data).digest("hex");
    if (h.toLowerCase() !== String(c.files[e.name]).toLowerCase()) { console.log("  MISMATCH " + e.name); bad++; }
  }
  console.log("sha256 mismatches: " + bad);
}
const sig = entries.find(e => e.name === "signature.json");
console.log("signature.json: " + (sig ? "present (signed)" : "absent (needs 允许安装未签名开发包)"));

function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c;
}
