/*
 * 布局级端到端验证：用**真实浏览器**（系统 Chrome/Edge + puppeteer-core）跑真实 ui/index.html，量元素的几何。
 * ============================================================================
 * 为什么需要这一层：
 *   「元素存在但用户看不见」这类 bug，`_domcheck.py`（查 DOM）和 jsdom 层（查 JS 报错）**都抓不到** ——
 *   jsdom 没有布局引擎，`getBoundingClientRect()` 全是 0。这类 bug 的表现是
 *   「按钮没被删、控制台没报错、自动化点击还能过」，用户却说"按钮不见了"。
 *   本项目实测踩过两次：AI 栏配置区一展开，底栏的输入 + 发送按钮被推出视口（620px 高）；
 *   配置弹框里十来项填完后，主按钮「保存」要滚动才够得到。
 *
 * 这一层**不连侧车**：注入语义一致的假桥接即可，量的是纯几何。
 * 环境里没有 Chrome/Edge 或 puppeteer-core 时自动 SKIP（不要改成 FAIL，否则会挡住别的机器）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = "D:/core/web/dbx-pj/dbx-md-notes";
const NODE_WS = process.env.DBX_NODE_WS || "C:/Users/Luke-pc/.workbuddy/binaries/node/workspace/package.json";
const PAGE = "ui/index.html";
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
// 至少带一个「矮窗口」：很多挤出视口的 bug 只在矮窗口下出现
const VIEWPORTS = [[1280, 620], [1280, 460]];

const pass = [], fail = [];
const check = (name, ok, extra) => (ok ? pass : fail).push(name + (extra ? "  |  " + extra : ""));

/* 进度标记 + 看门狗：这个脚本要起真浏览器、跑得久，卡住时必须能一眼看出停在哪一步。
 * 实测踩过：`await browser.close()` 卡住（Chrome 不退），而汇总排在它后面 →
 * 脚本静默挂死 5 分钟、输出文件 0 字节，只能靠猜。 */
const PROGRESS = path.join(ROOT, "_layout_progress.txt");
try { fs.unlinkSync(PROGRESS); } catch { /* 首次运行 */ }
const step = (t) => {
  const line = "[" + new Date().toISOString().slice(11, 19) + "] " + t + "\n";
  try { fs.appendFileSync(PROGRESS, line); } catch { /* 写不进去不该拖垮验证 */ }
  process.stdout.write(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WATCHDOG_MS = 240000;
const watchdog = setTimeout(() => {
  console.error("\n[FATAL] 布局验证超过 " + (WATCHDOG_MS / 1000) + "s 未结束；最后进度见 _layout_progress.txt\n");
  process.exit(2);
}, WATCHDOG_MS);
if (watchdog.unref) watchdog.unref();

/** 结论先落地：无论后面关浏览器顺不顺利，结果都已经写出来了 */
function printSummary() {
  console.log("\n===== 通过 " + pass.length + " 项 =====");
  pass.forEach((p) => console.log("  PASS  " + p));
  if (fail.length) {
    console.log("\n===== 失败 " + fail.length + " 项 =====");
    fail.forEach((f) => console.log("  FAIL  " + f));
  }
  console.log("\nRESULT: " + (fail.length ? "FAIL(" + fail.length + ")" : "PASS"));
}

const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) { console.log("SKIP  找不到 Chrome/Edge，跳过布局验证"); process.exit(0); }
let puppeteer;
try { puppeteer = createRequire(NODE_WS)("puppeteer-core"); }
catch (e) { console.log("SKIP  puppeteer-core 不可用：" + e.message); process.exit(0); }

// ⚠️ 这个函数会被序列化后在页面里执行：**不能引用外部变量**，所有数据写进函数体。
function bridgeStub() {
  const LONG = "# 分析结果\n\n" + "这是一段用于撑高面板的较长的结果内容。".repeat(30) + "\n\n- 要点一\n- 要点二";
  const note = {
    id: "n1", type: "note", name: "示例笔记", parentId: null,
    content: "# 示例笔记\n\n" + "正文段落。".repeat(60) + "\n",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
  const reply = (method) => {
    if (method === "notes/ping") return { ok: true, plugin: "com.lwai.mdnotes", version: "layout", dir: "D:/tmp/md", configured: true };
    if (method === "notes/probe") return { ok: true, dir: "D:/tmp/md" };
    if (method === "notes/load") return { data: { version: 2, nodes: [note], activeId: "n1", expanded: {}, view: "split" }, dir: "D:/tmp/md" };
    if (method === "notes/save") return { ok: true, dir: "D:/tmp/md" };
    if (method === "ui/getPrefs") return { prefs: {} };
    if (method === "ui/setPrefs") return { prefs: {} };
    if (method === "ai/config") {
      return { enabled: true, ready: true, provider: "openai", baseUrl: "http://127.0.0.1:1/v1",
        model: "layout-model", hasKey: true, keyFrom: "panel", overridden: false, missing: [],
        timeoutSecs: 60, maxChars: 12000 };
    }
    if (method === "ai/chat") return { content: LONG, model: "layout-model", latencyMs: 12, truncated: false, sentChars: 10 };
    return {};
  };
  window.dbxPlugin = {
    ready: Promise.resolve({ connectionId: "layout" }),
    context: { connectionId: "layout" },
    capabilities: {},
    invoke: (m) => Promise.resolve(reply(m)),
    request: () => Promise.resolve({}),
    saveFile: () => Promise.resolve({ path: "D:/tmp/out" }),
    onContext: () => {}, onInit: () => {},
  };
}

/** 通用几何：元素在不在视口里、有没有被 display:none */
const boxFn = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) { return null; }
  const b = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right),
    h: Math.round(b.height), w: Math.round(b.width),
    shown: st.display !== "none" && st.visibility !== "hidden" && b.height > 0 };
}`;

const measure = (page, selectors) => page.evaluate(
  (sels, fnSrc) => {
    const box = eval(fnSrc);
    const out = { vh: window.innerHeight, vw: window.innerWidth };
    for (const [k, sel] of Object.entries(sels)) { out[k] = box(sel); }
    return out;
  }, selectors, boxFn);

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true,
    args: ["--allow-file-access-from-files", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  step("chrome 已启动");
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String((e && e.message) || e)));
  await page.evaluateOnNewDocument(bridgeStub);

  for (const [w, h] of VIEWPORTS) {
    const tag = w + "x" + h;
    await page.setViewport({ width: w, height: h });
    await page.goto("file:///" + path.join(ROOT, PAGE).replace(/\\/g, "/"), { waitUntil: "load" });
    await sleep(800);
    step(tag + " index.html 已加载");

    /* ---- 1) AI 栏 · 聊天模式（默认）：底栏与主按钮必须在视口里 ---- */
    step(tag + " 1) AI 栏聊天模式");
    await page.click("#btn-ai");
    await sleep(400);
    let g = await measure(page, {
      panel: "#ai-panel", footer: ".aip-compose", btn: "#aip-go", input: "#aip-input" });
    check("[" + tag + "] 聊天模式：面板不高于视口", !!g.panel && g.panel.h <= g.vh + 1,
      "面板 " + (g.panel && g.panel.h) + " / 视口 " + g.vh);
    check("[" + tag + "] 聊天模式：输入框完整可见",
      !!g.input && g.input.shown && g.input.top >= 0 && g.input.bottom <= g.vh,
      g.input ? (g.input.top + "~" + g.input.bottom) : "缺 #aip-input");
    check("[" + tag + "] 聊天模式：发送按钮完整可见",
      !!g.btn && g.btn.shown && g.btn.top >= 0 && g.btn.bottom <= g.vh,
      g.btn ? ("top=" + g.btn.top + " bottom=" + g.btn.bottom + " 视口=" + g.vh) : "缺 #aip-go");

    /* ---- 2) AI 栏 · 创作模式（对象区把内容顶下去，最容易挤掉底栏） ---- */
    step(tag + " 2) 创作模式");
    await page.click("#aip-view-create");
    await sleep(400);
    g = await measure(page, {
      footer: ".aip-compose", btn: "#aip-go", scroll: "#aip-scroll", target: "#aip-target" });
    check("[" + tag + "] 创作模式：对象区出现且能滚",
      !!g.target && g.target.shown && !!g.scroll && g.scroll.h > 0,
      g.target ? ("对象区 h=" + g.target.h + " · 滚动区 h=" + (g.scroll && g.scroll.h)) : "缺 #aip-target");
    check("[" + tag + "] 创作模式：底栏仍固定在视口内",
      !!g.btn && g.btn.top >= 0 && g.btn.bottom <= g.vh,
      g.btn ? ("top=" + g.btn.top + " bottom=" + g.btn.bottom + " 视口=" + g.vh) : "缺 #aip-go");

    /* ---- 3) 出结果后（结果很长，内容会撑高） ---- */
    step(tag + " 3) 出结果后");
    await page.click("#aip-mode-note");
    await sleep(150);
    await page.click("#aip-go");
    await sleep(900);
    g = await measure(page, { btn: "#aip-go", footer: ".aip-compose", log: "#aip-log" });
    const hasEntry = await page.evaluate(() => document.querySelectorAll("#aip-log .aip-entry").length > 0);
    check("[" + tag + "] 出结果后：记录里真的有条目", hasEntry,
      (await page.evaluate(() => (document.getElementById("aip-log").textContent || "").slice(0, 40))));
    check("[" + tag + "] 出结果后：发送按钮仍在视口内",
      !!g.btn && g.btn.top >= 0 && g.btn.bottom <= g.vh,
      g.btn ? ("top=" + g.btn.top + " bottom=" + g.btn.bottom + " 视口=" + g.vh) : "缺 #aip-go");

    /* ---- 4) 配置弹框：主按钮「保存」不能要滚动才够得到 ---- */
    step(tag + " 4) 配置弹框");
    await page.click("#aip-cfg-toggle");
    await sleep(400);
    g = await measure(page, { card: "#ai-cfg-modal .modal-card", save: "#aic-save", test: "#aic-test", clear: "#aic-clear" });
    check("[" + tag + "] 配置弹框打开且卡片不高于视口",
      !!g.card && g.card.shown && g.card.h <= g.vh, g.card ? ("卡片 h=" + g.card.h + " / 视口 " + g.vh) : "缺卡片");
    check("[" + tag + "] 配置弹框：「保存」按钮不用滚动就完整可见",
      !!g.save && g.save.shown && g.save.top >= 0 && g.save.bottom <= g.vh,
      g.save ? ("top=" + g.save.top + " bottom=" + g.save.bottom + " 视口=" + g.vh) : "缺 #aic-save");
    check("[" + tag + "] 配置弹框：清除/测试按钮也在视口内",
      !!g.test && !!g.clear && g.test.bottom <= g.vh && g.clear.bottom <= g.vh,
      g.test && g.clear ? ("测试 bottom=" + g.test.bottom + " · 清除 bottom=" + g.clear.bottom) : "缺按钮");
    await page.click("#aic-cancel");
    await sleep(250);
    check("[" + tag + "] 配置弹框：取消后关闭",
      await page.evaluate(() => document.getElementById("ai-cfg-modal").hidden === true));

    /* ---- 5) 导入弹框：文件多了以后主按钮「开始导入」仍要够得到 ---- */
    step(tag + " 5) 导入弹框");
    await page.evaluate(() => {
      const mk = (name, text, rel) => {
        const f = new File([text], name, { type: "text/markdown" });
        Object.defineProperty(f, "webkitRelativePath", { value: rel });
        return f;
      };
      const dt = new DataTransfer();
      dt.items.add(mk("a01.md", "# 第一篇\n\n正文。", "我的笔记/子目录/a01.md"));
      dt.items.add(mk("a02.md", "# 第二篇\n\n正文。", "我的笔记/子目录/a02.md"));
      dt.items.add(mk("a03.md", "# 第三篇\n\n正文。", "我的笔记/子目录/a03.md"));
      dt.items.add(mk("a04.md", "# 第四篇\n\n正文。", "我的笔记/子目录/a04.md"));
      dt.items.add(mk("a05.md", "# 第五篇\n\n正文。", "我的笔记/子目录/a05.md"));
      dt.items.add(mk("a06.md", "# 第六篇\n\n正文。", "我的笔记/子目录/a06.md"));
      dt.items.add(mk("a07.md", "# 第七篇\n\n正文。", "我的笔记/子目录/a07.md"));
      dt.items.add(mk("a08.md", "# 第八篇\n\n正文。", "我的笔记/子目录/a08.md"));
      const fi = document.getElementById("file-input");
      fi.files = dt.files;
      fi.dispatchEvent(new Event("change"));
    });
    await sleep(700);
    g = await measure(page, { card: "#modal .modal-card", go: "#modal .modal-actions .primary", list: "#modal .import-list" });
    check("[" + tag + "] 导入弹框：打开且卡片不高于视口",
      !!g.card && g.card.shown && g.card.h <= g.vh, g.card ? ("卡片 h=" + g.card.h + " / 视口 " + g.vh) : "缺卡片");
    check("[" + tag + "] 导入弹框：「开始导入」按钮不用滚动就完整可见",
      !!g.go && g.go.shown && g.go.top >= 0 && g.go.bottom <= g.vh,
      g.go ? ("top=" + g.go.top + " bottom=" + g.go.bottom + " 视口=" + g.vh) : "没找到主按钮");
    check("[" + tag + "] 导入弹框：标题行自己滚（不把按钮顶出去）",
      !!g.list && g.list.h <= 260, g.list ? ("列表 h=" + g.list.h) : "缺 #modal .import-list");
    await page.keyboard.press("Escape");
    await sleep(250);

    /* ---- 6) 工具栏：两个固定按钮 + 「更多」下拉，单行且不溢出 ---- */
    step(tag + " 6) 工具栏");
    const tbBox = async () => measure(page, {
      tb: ".toolbar", sql: "#btn-insert-sql", ai: "#btn-ai", more: "#btn-more", menu: "#more-menu" });
    let t = await tbBox();
    check("[" + tag + "] 工具栏：三个按钮都在视口内、同一行、工具栏只有一行高",
      !!t.sql && !!t.ai && !!t.more && t.sql.shown && t.ai.shown && t.more.shown &&
      Math.abs(t.sql.top - t.ai.top) <= 4 && Math.abs(t.ai.top - t.more.top) <= 4 &&
      t.more.right <= t.vw && !!t.tb && t.tb.h <= 70   /* 一行实测 57px，两行 101px */,
      "sql.top=" + (t.sql && t.sql.top) + " ai.top=" + (t.ai && t.ai.top) + " more.right=" + (t.more && t.more.right) +
      "/" + t.vw + " toolbar.h=" + (t.tb && t.tb.h));
    check("[" + tag + "] 「更多」菜单默认收起",
      await page.evaluate(() => document.getElementById("more-menu").hidden === true));
    await page.click("#btn-more");
    await sleep(250);
    t = await tbBox();
    check("[" + tag + "] 展开「更多」：菜单完整落在视口内（不会被裁）",
      !!t.menu && t.menu.shown && t.menu.top >= 0 && t.menu.right <= t.vw + 1 && t.menu.bottom <= t.vh,
      t.menu ? ("menu " + t.menu.top + "~" + t.menu.bottom + " · right=" + t.menu.right + "/视口宽 " + t.vw) : "缺菜单");
    check("[" + tag + "] 展开「更多」不会把工具栏撑成两行", !!t.tb && t.tb.h <= 70, "toolbar.h=" + (t.tb && t.tb.h));
    await page.keyboard.press("Escape");
    await sleep(200);
    check("[" + tag + "] Esc 收起「更多」菜单",
      await page.evaluate(() => document.getElementById("more-menu").hidden === true &&
        document.getElementById("btn-more").getAttribute("aria-expanded") === "false"));

    if (errs.length) { break; }   // 页面已经报错，继续量下去没有意义
  }

  step("全部用例跑完");
  clearTimeout(watchdog);
  check("页面无未捕获错误", errs.length === 0, errs.join(" | "));
  printSummary();

  // ⚠️ 结论一定要排在 browser.close() **之前**：close 卡住时前面的输出必须已经落地
  try {
    await Promise.race([browser.close(), sleep(5000)]);
  } catch { /* 关不掉就算了，结论已经打印 */ }
  try { fs.unlinkSync(PROGRESS); } catch { /* ignore */ }
  process.exit(fail.length ? 1 : 0);
};

run().catch((e) => {
  console.error("布局验证崩溃:", e);
  printSummary();
  process.exit(1);
});
