/*
 * 存储层 v3（重构版）—— 严格按 DBX 官方插件 SDK 的桥接语义实现
 * ==========================================================================
 *
 * 官方 SDK（宿主源码 apps/desktop/src/lib/plugins/pluginHostBridge.ts 里的
 * pluginSdkSource()）定义的 window.dbxPlugin 形状：
 *
 *   window.dbxPlugin = {
 *     ready,                    // Promise<工作台上下文>  ← resolve 的是【纯数据】，不是 API！
 *     get context(),            // 同步读工作台上下文
 *     get locale(), get theme(), get capabilities(),
 *     invoke(method, params, { timeoutMs }),   // 调【侧车】（后端）
 *     request(method, params),                 // 调【宿主】（host.getContext / host.saveFile ...）
 *     notify(...), onContext(fn), onInit(fn), ...
 *   }
 *
 * 三条硬规则（前两条是之前"笔记永远存不了"的根因）：
 *
 *   1. API 对象永远是 window.dbxPlugin 本身。
 *      绝不能写成 ready.then(api => ...) 然后把 api 当宿主对象用 —— ready 的结果是
 *      上下文数据 { connectionId, database, schema, values }，它没有 invoke/request。
 *      一旦这么写，dbxPlugin.invoke 就是 undefined，侧车握手必然抛错，直接落回内存。
 *      （官方模板的写法是 `dbxPlugin.ready.then((context) => {...})` 然后调用
 *       `window.dbxPlugin.request(...)`。）
 *
 *   2. 侧车 RPC 只能走 `dbxPlugin.invoke(method, params, { timeoutMs })`；
 *      宿主方法走 `dbxPlugin.request(method, params)`。两者不可混用 ——
 *      把 "host.getContext" 交给 invoke() 会被当成侧车方法，侧车没有该 handler。
 *
 *   3. 前端不碰磁盘。插件 UI 跑在 sandboxed iframe（opaque origin）里，
 *      localStorage / IndexedDB / showDirectoryPicker / a.download 全部不可用。
 *      唯一可靠的落盘通道是 `invoke() → Go 侧车 → 真实 .md 文件`。
 *      因此本层【绝不静默退化】：侧车不可用时明确报错（状态栏 + 诊断面板），
 *      内存后端只当会话缓存，且 persistent=false / ok=false，不伪装成已保存。
 *
 * 存储目录从哪来（三层保险，互不依赖）：
 *   a) 宿主连接流程调 connection/connect 时把 storage_dir 交给侧车；
 *   b) 侧车把它持久化在 <DBX_PLUGIN_DATA_DIR>/config.json，重启自己读回；
 *   c) 前端若在工作台上下文里读到 storage_dir，额外 invoke("notes/setDir") 兜底。
 *   前端拿不到 storage_dir 不影响落盘 —— 侧车侧已有一份。【权威来源是侧车】，
 *   前端的 storageDir 只用于显示。
 */
(function () {
  "use strict";

  var MD = window.MDNotes = window.MDNotes || {};

  var DATA_KEY = "com.lwai.mdnotes:data:v2";
  var RPC_TIMEOUT = 30000;
  var READY_TIMEOUT = 8000;   // 等宿主 init 消息
  var CTX_TIMEOUT = 2500;     // host.getContext 兜底
  var PING_TIMEOUT = 6000;    // 侧车握手
  var BRIDGE_TIMEOUT = 8000;  // 等 window.dbxPlugin 注入
  var BRIDGE_PAYLOAD_LIMIT = 1.9 * 1024 * 1024; // 宿主上限 2 MiB，留出余量
  var SAVE_DEBOUNCE = 400;
  // AI 调用的超时单独放宽：模型常常要几十秒，沿用 30 秒的通用超时会把正常请求掐死。
  var AI_TIMEOUT = 180000;

  /* ============ 诊断日志（页面置顶诊断条 + 状态弹窗共用，实时刷新） ============ */

  var UI_VERSION = "0.8.1";   // 打包脚本会校验它与 manifest.version 一致
  var T0 = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  /** 自模块加载起的毫秒数（给每条日志打上相对时间，能看出卡在哪一步） */
  function since() {
    var t = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    return t - T0;
  }

  var diag = [];
  var diagListeners = [];

  function note(step, ok, detail) {
    diag.push({
      at: Date.now(),
      t: since(),
      ok: (ok === true || ok === false) ? ok : null,   // null = 纯信息
      step: step,
      detail: detail ? String(detail).slice(0, 500) : ""
    });
    if (diag.length > 150) { diag.shift(); }
    for (var i = 0; i < diagListeners.length; i++) {
      try { diagListeners[i](); } catch (e) { /* ignore */ }
    }
  }

  function onDiag(fn) { if (typeof fn === "function") { diagListeners.push(fn); } }

  function diagLines() {
    return diag.map(function (d) {
      var mark = d.ok === true ? "[ OK ]" : (d.ok === false ? "[FAIL]" : "[ .. ]");
      return "+" + (d.t / 1000).toFixed(3) + "s " + mark + " " + d.step
        + (d.detail ? "  ->  " + d.detail : "");
    });
  }

  function errText(e) {
    if (!e) { return "未知错误"; }
    if (typeof e === "string") { return e; }
    if (e.message) { return String(e.message); }
    if (e.error) { return String(e.error); }
    try { return JSON.stringify(e).slice(0, 300); } catch (e2) { return String(e); }
  }

  /** 环境快照：判断「桥接到底在不在」的第一手证据 */
  function envSnapshot() {
    var a = null, keys = [], origin = "?";
    try { a = window.dbxPlugin; } catch (e) { a = null; }
    try { origin = String(window.origin); } catch (e) { origin = "?"; }
    try { keys = a ? Object.keys(a).slice(0, 30) : []; } catch (e) { keys = []; }
    return "origin=" + origin
      + " · sandboxed=" + isSandboxed()
      + " · showDirectoryPicker=" + (typeof window.showDirectoryPicker)
      + " · typeof window.dbxPlugin=" + (a ? typeof a : "undefined")
      + " · invoke=" + (a ? typeof a.invoke : "-")
      + " · request=" + (a ? typeof a.request : "-")
      + " · ready=" + (a && a.ready ? typeof a.ready.then : "-")
      + " · keys=[" + keys.join(",") + "]"
      + " · readyState=" + document.readyState;
  }

  /** 完整诊断报告（一键复制给开发者看） */
  function report() {
    var st = status;
    var L = [];
    L.push("=== DBX MD 笔记 · 存储诊断报告 ===");
    L.push("时间：" + new Date().toLocaleString("zh-CN"));
    L.push("UI 版本：" + UI_VERSION);
    L.push("页面：" + (function () { try { return String(location.href); } catch (e) { return "?"; } })());
    L.push("UA：" + navigator.userAgent);
    L.push("");
    L.push("--- 环境 ---");
    L.push(envSnapshot());
    L.push("");
    L.push("--- 状态 ---");
    L.push("backend=" + st.backend + " · persistent=" + st.persistent + " · ok=" + st.ok
      + " · available=" + st.available);
    L.push("hostAvailable=" + st.hostAvailable + " · sidecarAvailable=" + st.sidecarAvailable);
    L.push("connectionId=" + (st.connectionId || "(空)"));
    L.push("storageDir=" + (st.storageDir || "(空)") + " · dirConfigured=" + st.dirConfigured);
    L.push("storagePath=" + (st.storagePath || "(空)"));
    L.push("sidecarError=" + (st.sidecarError || "(无)"));
    L.push("lastError=" + (st.lastError || "(无)"));
    L.push("payloadBytes=" + st.payloadBytes + " · lastSavedAt="
      + (st.lastSavedAt ? new Date(st.lastSavedAt).toLocaleString("zh-CN") : "(尚无)"));
    L.push("");
    L.push("--- 诊断日志（" + diag.length + " 条，最早在上）---");
    L.push(diagLines().join("\n") || "(无)");
    return L.join("\n");
  }

  // 模块加载即落一条，确保「即使 UI 完全没启动」诊断条里也有东西可看。
  note("存储模块加载完成（等待 UI 调用 init）", null, "UI 版本 " + UI_VERSION);

  /* ============================ 状态 ============================ */

  var listeners = [];
  var status = {
    backend: "unknown",     // sidecar | folder | memory | none
    persistent: false,
    available: false,
    ok: true,
    lastError: "",
    lastSavedAt: 0,
    hostAvailable: false,   // window.dbxPlugin 是否存在
    sidecarAvailable: false,
    sidecarError: "",       // 侧车不可用的确切原因
    connectionId: "",
    storageDir: "",         // 侧车实际在用的目录（来自侧车回报，权威）
    dirConfigured: false,   // 侧车是否真用上了用户指定的 storage_dir
    storagePath: "",        // meta.json 的绝对路径
    fsSupported: false,
    folderName: "",
    backupOnly: false,      // true = 仅会话内缓存，未真正落盘
    payloadBytes: 0         // 最近一次 save 的负载大小
  };

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](status); } catch (e) { /* ignore */ }
    }
  }
  function setStatus(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { status[k] = patch[k]; }
    }
    emit();
  }

  /* ============================ 小工具 ============================ */

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function withTimeout(promise, ms, msg) {
    var timer = null;
    var gate = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(msg + "（" + ms + "ms 未响应）")); }, ms);
    });
    function clear() { if (timer) { clearTimeout(timer); timer = null; } }
    return Promise.race([Promise.resolve(promise), gate]).then(
      function (v) { clear(); return v; },
      function (e) { clear(); throw e; }
    );
  }

  /** 把 promise 收成 { ok, value | error }，避免到处 try/catch */
  function settle(promise) {
    return Promise.resolve(promise).then(
      function (v) { return { ok: true, value: v }; },
      function (e) { return { ok: false, error: e }; }
    );
  }

  function nonEmptyStr(v) {
    return (typeof v === "string" && v.trim()) ? v.trim() : "";
  }

  /* ====================== 宿主桥接获取 ====================== */

  var api = null;          // window.dbxPlugin（API 对象）
  var apiReady = false;    // 是否已收到宿主 init

  /** 等 window.dbxPlugin 注入（SDK 脚本在 <head>，正常是同步就绪；这里只做保险） */
  function waitBridge(ms) {
    if (api) { return Promise.resolve(api); }
    var deadline = Date.now() + ms;
    return (function poll() {
      if (window.dbxPlugin && typeof window.dbxPlugin === "object") {
        api = window.dbxPlugin;
        return Promise.resolve(api);
      }
      if (Date.now() >= deadline) { return Promise.resolve(null); }
      return delay(25).then(poll);
    })();
  }

  /** 等 ready —— 只等它 resolve，绝不使用它的值（值是上下文数据，不是 API） */
  function waitReady(a) {
    if (apiReady) { return Promise.resolve(true); }
    var ready = (a && a.ready && typeof a.ready.then === "function") ? a.ready : Promise.resolve();
    return settle(withTimeout(ready, READY_TIMEOUT, "等待宿主 dbxPlugin.ready")).then(function (r) {
      apiReady = r.ok;
      note("宿主桥接 ready（dbxPlugin.ready）", r.ok, r.ok ? "已收到宿主 init 消息" : errText(r.error));
      return r.ok;
    });
  }

  /** 读工作台上下文：同步 context 优先，缺失时用宿主 request("host.getContext") 兜底 */
  function readContext(a) {
    var sync = null;
    try { sync = a && a.context; } catch (e) { sync = null; }
    if (sync && typeof sync === "object" && Object.keys(sync).length) {
      note("工作台上下文（同步 dbxPlugin.context）", true, describeCtx(sync));
      return Promise.resolve(sync);
    }
    if (a && typeof a.request === "function") {
      return settle(withTimeout(a.request("host.getContext", {}), CTX_TIMEOUT, "请求 host.getContext"))
        .then(function (r) {
          var ctx = (r.ok && r.value && typeof r.value === "object") ? r.value : {};
          var has = Object.keys(ctx).length > 0;
          note("工作台上下文（兜底 host.getContext）", r.ok && has,
            r.ok ? describeCtx(ctx) : errText(r.error));
          return ctx;
        });
    }
    note("工作台上下文", false, "宿主既未提供同步 context，也无 request 方法");
    return Promise.resolve({});
  }

  function describeCtx(ctx) {
    var keys = Object.keys(ctx || {});
    return "字段 [" + keys.slice(0, 8).join(", ") + (keys.length > 8 ? ", …" : "") + "]";
  }

  /** 从上下文里尽力取 connectionId / storage_dir（取不到也不影响落盘，见文件头说明） */
  var DIR_KEYS = ["storage_dir", "storageDir", "storage_path", "storagePath", "notes_dir", "notesDir"];
  function extractPath(obj, keys, depth) {
    if (!obj || typeof obj !== "object" || depth > 4) { return ""; }
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (nonEmptyStr(v)) { return nonEmptyStr(v); }
    }
    var names = Object.keys(obj);
    for (var j = 0; j < names.length; j++) {
      var child = obj[names[j]];
      if (child && typeof child === "object") {
        var found = extractPath(child, keys, depth + 1);
        if (found) { return found; }
      }
    }
    return "";
  }

  function extractContext(ctx) {
    var connectionId = "";
    var storageDir = "";
    try {
      connectionId = nonEmptyStr(ctx.connectionId)
        || nonEmptyStr(ctx.connection && ctx.connection.id)
        || "";
      var ec = ctx.external_config || (ctx.connection && ctx.connection.external_config);
      if (ec) {
        for (var i = 0; i < DIR_KEYS.length; i++) {
          storageDir = nonEmptyStr(ec[DIR_KEYS[i]]);
          if (storageDir) { break; }
        }
      }
      if (!storageDir) { storageDir = extractPath(ctx, DIR_KEYS, 0); }
    } catch (e) { /* ignore */ }
    return { connectionId: connectionId, storageDir: storageDir };
  }

  /* ====================== 侧车通道（唯一真实持久化） ====================== */

  var client = null;  // { api, connectionId, storageDir }

  function rpcRaw(method, params, timeoutMs) {
    if (!client || !client.api || typeof client.api.invoke !== "function") {
      return Promise.reject(new Error("侧车通道未就绪（宿主未提供 dbxPlugin.invoke）"));
    }
    var payload = {};
    if (client.connectionId) { payload.connectionId = client.connectionId; }
    for (var k in (params || {})) {
      if (Object.prototype.hasOwnProperty.call(params, k)) { payload[k] = params[k]; }
    }
    var out;
    try {
      out = client.api.invoke(method, payload, { timeoutMs: timeoutMs || RPC_TIMEOUT });
    } catch (e) {
      return Promise.reject(new Error(method + " 调用失败：" + errText(e)));
    }
    return Promise.resolve(out);
  }

  /**
   * 调侧车。宿主把 invoke() 直接映射到 backend.invoke，并把侧车的 JSON-RPC result
   * 原样 resolve 回来；侧车报错则宿主 reject。这里只做一层兼容解包。
   */
  function rpc(method, params, timeoutMs) {
    var started = since();
    var ms = function () { return (since() - started).toFixed(0) + "ms"; };
    return rpcRaw(method, params, timeoutMs).then(function (res) {
      if (res && typeof res === "object" && res.error && !res.ok && !res.data) {
        note("侧车调用 " + method, false, ms() + " · " + errText(res.error));
        throw new Error(errText(res.error));
      }
      var out = res;
      if (res && typeof res === "object" && res.result !== undefined
        && res.ok === undefined && res.data === undefined && res.path === undefined && res.dir === undefined) {
        out = res.result;
      }
      note("侧车调用 " + method, true, ms());
      return out;
    }, function (err) {
      note("侧车调用 " + method, false, ms() + " · " + errText(err));
      throw err;
    });
  }

  /* ====================== 会话内存后端（仅缓存，不伪装持久） ====================== */

  function memoryBackend() {
    var mem = null;
    return {
      name: "memory",
      persistent: false,
      available: function () { return true; },
      read: function () { return mem; },
      write: function (data) { mem = data; return true; }
    };
  }

  /* ============ 本地目录后端（仅限非沙箱环境打开 index.html 时；DBX 内不可用） ============ */

  function isSandboxed() {
    try { return !window.origin || String(window.origin) === "null"; } catch (e) { return true; }
  }
  function fsSupported() {
    return typeof window.showDirectoryPicker === "function" && !isSandboxed();
  }

  var FS_FILE = "md-notes.json";
  var fsState = { handle: null, name: "" };

  function folderBackend() {
    return {
      name: "folder",
      persistent: true,
      available: function () { return !!fsState.handle; },
      read: function () {
        return fsState.handle.getFileHandle(FS_FILE, { create: false })
          .then(function (fh) { return fh.getFile(); })
          .then(function (f) { return f.text(); })
          .then(function (t) { return t ? JSON.parse(t) : null; })
          .catch(function () { return null; });
      },
      write: function (data) {
        return fsState.handle.getFileHandle(FS_FILE, { create: true })
          .then(function (fh) { return fh.createWritable(); })
          .then(function (w) {
            return w.write(JSON.stringify(data)).then(function () { return w.close(); });
          })
          .then(function () { return true; });
      }
    };
  }

  /* ============================ 当前后端 ============================ */

  var current = null;
  var flushTimer = null;
  var pendingData = null;

  function readCurrent() {
    if (!current) { current = memoryBackend(); }
    var read = null;
    try { read = current.read(); } catch (e) { read = null; }
    return Promise.resolve(read).then(function (d) {
      if (d && d.data !== undefined) {
        return {
          data: (d.data && typeof d.data === "object") ? d.data : null,
          pending: d.pending || null,
          backend: current.name,
          persistent: current.persistent,
          firstRun: !(d.data && d.data.nodes)
        };
      }
      return {
        data: d || null,
        pending: null,
        backend: current.name,
        persistent: current.persistent,
        firstRun: !d
      };
    }).catch(function (err) {
      setStatus({ ok: false, lastError: errText(err) });
      note("读取笔记", false, errText(err));
      return {
        data: null, pending: null,
        backend: current ? current.name : "memory",
        persistent: false, firstRun: true
      };
    });
  }

  /* ============================ 初始化 ============================ */

  function failHard(reason) {
    setStatus({
      backend: "none", persistent: false, available: false, ok: false,
      sidecarAvailable: false, sidecarError: reason, lastError: reason,
      backupOnly: true
    });
    current = memoryBackend();
    client = null;
  }

  var initCalled = false;
  var initStartedAt = 0;

  function init() {
    initCalled = true;
    initStartedAt = since();
    note("=== 存储初始化开始 ===", null, UI_VERSION + " @ " + new Date().toLocaleTimeString("zh-CN"));
    note("环境快照", null, envSnapshot());
    return waitBridge(BRIDGE_TIMEOUT).then(function (a) {
      note("等 window.dbxPlugin 注入", !!a, (since() - initStartedAt).toFixed(0) + "ms"
        + (a ? " · 已拿到" : " · 超时 " + BRIDGE_TIMEOUT + "ms"));
      if (!a) {
        var msg = "宿主未注入 window.dbxPlugin（当前不在 DBX 插件工作台内）";
        note("获取 dbxPlugin 桥接", false, msg);
        setStatus({ hostAvailable: false, fsSupported: fsSupported() });
        failHard(msg);
        return fallbackResult(msg);
      }
      note("获取 dbxPlugin 桥接", true, "已有 invoke=" + (typeof a.invoke) + " request=" + (typeof a.request));
      setStatus({ hostAvailable: true, fsSupported: fsSupported() });

      return waitReady(a).then(function () {
        return readContext(a);
      }).then(function (ctx) {
        var info = extractContext(ctx);
        setStatus({
          connectionId: info.connectionId,
          storageDir: info.storageDir,
          storagePath: info.storageDir
        });
        note("解析连接上下文", !!info.connectionId || !!info.storageDir,
          "connectionId=" + (info.connectionId || "（无）") + " storage_dir=" + (info.storageDir || "（无，侧车侧自持）"));

        client = { api: a, connectionId: info.connectionId, storageDir: info.storageDir };

        // 上下文更新（换连接）时保持同步，不重建 iframe 也能跟上
        if (typeof a.onContext === "function") {
          try {
            a.onContext(function (next) {
              var nx = extractContext(next || {});
              if (nx.connectionId) { status.connectionId = nx.connectionId; }
              if (nx.storageDir) { status.storageDir = nx.storageDir; }
              if (client) {
                client.connectionId = nx.connectionId || client.connectionId;
                client.storageDir = nx.storageDir || client.storageDir;
              }
              emit();
            });
          } catch (e) { /* 老宿主无 onContext，忽略 */ }
        }

        // —— 侧车握手：这才是真正的可用性判据 ——
        return settle(withTimeout(rpc("notes/ping", {}, PING_TIMEOUT), PING_TIMEOUT + 500, "侧车握手 notes/ping"))
          .then(function (r) {
            if (!r.ok) {
              var why = "侧车不可用：" + errText(r.error);
              note("侧车握手 notes/ping", false, errText(r.error));
              failHard(why);
              return fallbackResult(why);
            }
            var pl = r.value || {};
            note("侧车握手 notes/ping", true,
              "version=" + (pl.version || "?") + " dir=" + (pl.storagePath || pl.dir || "（未回报）")
              + " configured=" + (pl.configured === true));

            current = sidecarBackend();
            setStatus({
              backend: "sidecar", persistent: true, available: true, ok: true,
              lastError: "", sidecarAvailable: true, sidecarError: "",
              backupOnly: false,
              storageDir: nonEmptyStr(pl.storagePath) || status.storageDir,
              storagePath: nonEmptyStr(pl.storagePath) || status.storagePath,
              dirConfigured: pl.configured === true
            });

            // 若上下文里读到了 storage_dir，额外告知侧车做兜底（侧车自己也有 config.json）
            if (info.storageDir) {
              settle(rpc("notes/setDir", { dir: info.storageDir }, PING_TIMEOUT)).then(function (s) {
                note("同步存储目录到侧车 notes/setDir", s.ok,
                  s.ok ? ((s.value && s.value.dir) || info.storageDir) : errText(s.error));
                if (s.ok && s.value) {
                  setStatus({
                    storageDir: nonEmptyStr(s.value.dir) || status.storageDir,
                    storagePath: nonEmptyStr(s.value.path) || status.storagePath
                  });
                }
              });
            }

            return readCurrent().then(function (r) {
              r.connectionId = status.connectionId;
              r.storageDir = status.storageDir;
              r.path = status.storagePath;
              note("读取笔记 notes/load", true,
                "节点数=" + ((r.data && r.data.nodes && r.data.nodes.length) || 0) + " firstRun=" + r.firstRun);
              return r;
            });
          });
      });
    }).catch(function (err) {
      var msg = "存储初始化异常：" + errText(err);
      note("存储初始化", false, errText(err));
      failHard(msg);
      return fallbackResult(msg);
    });
  }

  function fallbackResult(reason) {
    return readCurrent().then(function (r) {
      r.connectionId = status.connectionId;
      r.storageDir = "";
      r.path = "";
      r.backupOnly = true;
      r.error = reason;
      return r;
    });
  }

  /* ====================== 侧车后端实现 ====================== */

  function jsonBytes(v) {
    try { return new Blob([JSON.stringify(v)]).size; }
    catch (e) {
      try { return JSON.stringify(v).length; } catch (e2) { return 0; }
    }
  }

  function sidecarBackend() {
    return {
      name: "sidecar",
      persistent: true,
      available: function () { return true; },
      read: function () {
        return rpc("notes/load", {}, RPC_TIMEOUT).then(function (pl) {
          if (!pl || typeof pl !== "object") { return null; }
          setStatus({
            storagePath: nonEmptyStr(pl.path) || status.storagePath,
            storageDir: nonEmptyStr(pl.dir) || status.storageDir,
            dirConfigured: pl.configured === true
          });
          return { data: pl.data || null, pending: pl.pending || null };
        });
      },
      write: function (data) {
        var bytes = jsonBytes(data);
        setStatus({ payloadBytes: bytes });
        if (bytes > BRIDGE_PAYLOAD_LIMIT) {
          var over = "笔记本整体大小 " + Math.round(bytes / 1024) + " KB 超过宿主桥接单次上限（2 MB）。"
            + "请拆分或精简笔记内容后重试。";
          note("notes/save 负载检查", false, over);
          return Promise.reject(new Error(over));
        }
        var extra = { data: data };
        if (client && client.storageDir) { extra.storage_dir = client.storageDir; }
        return rpc("notes/save", extra, RPC_TIMEOUT).then(function (pl) {
          if (pl && typeof pl === "object") {
            setStatus({
              storagePath: nonEmptyStr(pl.path) || status.storagePath,
              storageDir: nonEmptyStr(pl.dir) || status.storageDir,
              dirConfigured: true
            });
          }
          note("notes/save", true,
            Math.round(bytes / 1024) + " KB -> " + (status.storagePath || "（侧车未回报路径）"));
          return true;
        });
      }
    };
  }

  /* ================== 宿主「另存为」：让用户自己选目录 ==================
   * 为什么必须走宿主而不是 a.download：插件 UI 跑在 opaque origin 的 sandbox iframe 里，
   * blob 导航/下载会被宿主无声取消（WKWebView 直接 cancel），前端点不动任何下载。
   * 宿主提供的 host.saveFile 由它自己弹【原生保存对话框】并写盘 —— 用户可选目录和文件名。
   *
   * 传输方式（宿主源码 apps/desktop/src/lib/plugins/pluginHostBridge.ts · host.saveFile）：
   *   - 传 Uint8Array / ArrayBuffer → postMessage 以 transfer 零拷贝送出，上限 512 MiB；
   *   - 传 base64 字符串          → 作为请求参数走 JSON，受 2 MiB 参数上限约束（约合 1.5 MB 文件）。
   * 所以一律传 ArrayBuffer，且必须是【长度精确】的 buffer —— SDK 里
   * `data instanceof Uint8Array ? data.buffer : …` 会把整个 underlying buffer 送走，
   * 若递过去的是大 buffer 上的一个视图，落盘内容会多出一截垃圾。
   */

  /** 宿主对 request 参数有 2 MiB 上限（enforcePayloadLimit）→ 上行文件（如恢复备份）要守住这个量级 */
  var MAX_UPSTREAM_BYTES = 1500 * 1000;

  function base64ToBytes(b64) {
    var bin = atob(String(b64 || "").replace(/\s+/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i) & 0xff; }
    return out;
  }

  /** 得到「长度精确」的 ArrayBuffer（见上方注释：视图会被整个 buffer 送走） */
  function toExactBuffer(v) {
    if (v instanceof ArrayBuffer) { return v; }
    var u8;
    if (typeof v === "string") { u8 = base64ToBytes(v); }
    else if (v instanceof Uint8Array) { u8 = v; }
    else { u8 = new Uint8Array(v || 0); }
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) { return u8.buffer; }
    var copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    return copy.buffer;
  }

  function hasHostSave() {
    return !!(api && typeof api.saveFile === "function");
  }

  /** 弹宿主原生「另存为」，把字节写到用户选的目录。返回 {ok, canceled, path, error} */
  function hostSaveFile(fileName, contentType, bytes) {
    if (!hasHostSave()) {
      note("宿主 saveFile", false, "当前宿主没有 saveFile 能力，无法弹出保存对话框");
      return Promise.resolve({
        ok: false, canceled: false, path: "",
        error: "当前 DBX 宿主不支持「另存为」对话框"
      });
    }
    var buf, size = 0;
    try {
      buf = toExactBuffer(bytes);
      size = buf.byteLength;
    } catch (e) {
      note("宿主 saveFile", false, "字节准备失败：" + errText(e));
      return Promise.resolve({ ok: false, canceled: false, path: "", error: errText(e) });
    }
    var opts = { fileName: fileName, contentType: contentType };
    return Promise.resolve(api.saveFile(opts, buf)).then(function (res) {
      // 宿主文档：用户取消时 resolve null
      if (res === null || res === undefined) {
        note("宿主 saveFile", null, "用户取消了保存：" + fileName);
        return { ok: false, canceled: true, path: "", error: "已取消" };
      }
      var p = (res && typeof res.path === "string") ? res.path : "";
      note("宿主 saveFile", true, fileName + "（" + size + " B）-> " + (p || "(宿主未回传路径)"));
      return { ok: true, canceled: false, path: p, error: "" };
    }).catch(function (e) {
      note("宿主 saveFile", false, fileName + "：" + errText(e));
      return { ok: false, canceled: false, path: "", error: errText(e) };
    });
  }

  /* ============================ 对外 API ============================ */

  var Store = {
    DATA_KEY: DATA_KEY,
    VERSION: UI_VERSION,

    onStatus: function (fn) {
      if (typeof fn === "function") { listeners.push(fn); }
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },

    /** 订阅诊断日志变化（每落一条就回调一次），供页面置顶诊断条实时刷新 */
    onDiag: onDiag,

    /** 由 UI 层往同一条诊断日志里补记（前端各启动阶段） */
    log: function (step, ok, detail) { note(step, ok, detail); },

    /** 完整诊断报告文本（一键复制） */
    report: report,

    env: envSnapshot,

    status: function () {
      var copy = {};
      for (var k in status) {
        if (Object.prototype.hasOwnProperty.call(status, k)) { copy[k] = status[k]; }
      }
      copy.diag = diagLines();
      return copy;
    },

    /** 初始化，返回 { data, pending, firstRun, connectionId, storageDir, path, backupOnly } */
    init: init,

    /** 上下文变化时重新绑定（不重建 iframe 的宿主会推 context，一般不需要手动调） */
    rebind: function () {
      return waitBridge(BRIDGE_TIMEOUT).then(function (a) {
        if (!a) { return Store.status(); }
        return readContext(a).then(function (ctx) {
          var info = extractContext(ctx);
          setStatus({ connectionId: info.connectionId, storageDir: info.storageDir });
          if (client) {
            client.connectionId = info.connectionId || client.connectionId;
            client.storageDir = info.storageDir || client.storageDir;
          }
          return Store.status();
        });
      }).catch(function () { return Store.status(); });
    },

    /** 手动指定笔记存储目录（走侧车 notes/setDir） */
    setDir: function (dir) {
      if (!nonEmptyStr(dir)) { return Promise.resolve({ ok: false, error: "目录为空" }); }
      return settle(rpc("notes/setDir", { dir: dir }, PING_TIMEOUT)).then(function (r) {
        if (!r.ok) {
          note("notes/setDir", false, errText(r.error));
          return { ok: false, error: errText(r.error) };
        }
        var pl = r.value || {};
        if (client) { client.storageDir = dir; }
        setStatus({
          storageDir: nonEmptyStr(pl.dir) || dir,
          storagePath: nonEmptyStr(pl.path) || status.storagePath,
          dirConfigured: true
        });
        note("notes/setDir", true, status.storageDir);
        return { ok: true, path: status.storagePath };
      });
    },

    /** 目录选择器（仅非沙箱环境；DBX 内不会出现该按钮） */
    pickDirectory: function () {
      if (!fsSupported()) {
        return Promise.resolve({
          ok: false,
          error: "当前环境不允许前端访问本地目录（沙箱 iframe 内无磁盘权限），笔记由侧车写入存储目录"
        });
      }
      return window.showDirectoryPicker({ mode: "readwrite" }).then(function (h) {
        fsState.handle = h;
        fsState.name = h.name || "";
        current = folderBackend();
        setStatus({
          backend: "folder", persistent: true, available: true, ok: true,
          lastError: "", folderName: fsState.name, backupOnly: false
        });
        note("选择本地目录", true, fsState.name);
        return { ok: true, name: fsState.name };
      }).catch(function (e) {
        return { ok: false, error: errText(e) || "已取消或不被允许" };
      });
    },

    fsSupported: fsSupported,
    folderName: function () { return fsState.name; },

    /** 用当前后端重新读一次（侧车目录变化后同步 UI） */
    reload: function () {
      return readCurrent().then(function (r) {
        r.connectionId = status.connectionId;
        r.storageDir = status.storageDir;
        r.path = status.storagePath;
        return r;
      });
    },

    /** 直接调侧车 RPC（导出/备份走后端落盘），resolve 侧车 result */
    invoke: function (method, params) {
      return rpc(method, params, RPC_TIMEOUT);
    },

    /* ---------------- AI（走侧车；密钥不下发前端，前端也永远拿不到） ----------------
     *
     * 设计取舍：不再依赖宿主的 host.ai（内置 AI 面板）。
     *   - 那个接口只「打开对话」，不返回模型回复、不暴露模型配置，做不了「结果写回笔记」；
     *   - 它需要 host.ai 权限，而权限是静态的 —— 旧宿主遇到未知权限会在安装阶段直接拒绝，
     *     等于为了一个用不上的入口把所有 <0.6.20 的用户挡在门外。
     * 现在只保留一条路：配置第三方模型，由侧车持有密钥并直连。
     */

    /** 侧车当前的 AI 配置与状态（不含密钥，只有一个 hasKey 布尔） */
    aiConfig: function () {
      return rpc("ai/config", {}, RPC_TIMEOUT).catch(function () { return null; });
    },

    /**
     * 更新 AI 配置。cfg 可含：
     *   enabled / provider / baseUrl / model / apiKey / systemPrompt / timeoutSecs / maxChars
     *   rememberKey（true = 允许把密钥写进本机插件数据目录）
     *   clearKey（true = 清掉本机保存的密钥）
     * persist=false 时只改内存（供「测试连接」用，不落盘）。
     */
    aiSetConfig: function (cfg, persist) {
      var payload = { persist: persist !== false };
      var src = cfg || {};
      ["enabled", "provider", "baseUrl", "model", "apiKey", "systemPrompt",
        "timeoutSecs", "maxChars", "rememberKey", "clearKey"].forEach(function (k) {
          if (src[k] !== undefined) { payload[k] = src[k]; }
        });
      return rpc("ai/setConfig", payload, RPC_TIMEOUT);
    },

    /**
     * 用一组参数（留空则用当前生效配置）发一次最小请求。
     * **不会改动生效配置** —— 测坏了不会把用户原本能用的配置搞坏。
     */
    aiTest: function (cfg) {
      return rpc("ai/test", cfg || {}, AI_TIMEOUT);
    },

    /** 清掉本机（面板）保存的配置，回到「以连接配置为准」 */
    aiResetConfig: function () {
      return rpc("ai/resetConfig", {}, RPC_TIMEOUT);
    },

    /** 让 AI 处理一段文本。task ∈ analyze|polish|continue|ask */
    aiChat: function (task, text, instruction) {
      return rpc("ai/chat", { task: task, text: text, instruction: instruction || "" }, AI_TIMEOUT);
    },

    /** AI 调用的超时（毫秒），供 UI 显示进度预期 */
    AI_TIMEOUT: AI_TIMEOUT,

    /* ---------------- UI 偏好（面板宽度等，存在插件数据目录，不进笔记目录） ---------------- */

    getPrefs: function () {
      return rpc("ui/getPrefs", {}, RPC_TIMEOUT)
        .then(function (r) { return (r && r.prefs) || {}; })
        .catch(function () { return {}; });
    },

    setPrefs: function (prefs) {
      return rpc("ui/setPrefs", { prefs: prefs || {} }, RPC_TIMEOUT).catch(function () { return null; });
    },

    /** 宿主是否提供「另存为」对话框（决定导出/备份能否让用户自选目录） */
    hasHostSave: hasHostSave,

    /** 弹宿主原生「另存为」，把字节写到用户选的目录 */
    saveFile: hostSaveFile,

    /** 上行（前端 → 侧车）单次文件大小上限，见 MAX_UPSTREAM_BYTES 注释 */
    MAX_UPSTREAM_BYTES: MAX_UPSTREAM_BYTES,

    /** 写入。debounce=true 时合并短时间内的多次写入 */
    save: function (data, debounce) {
      if (debounce) {
        pendingData = data;
        if (flushTimer) { clearTimeout(flushTimer); }
        flushTimer = setTimeout(function () { Store.flush(); }, SAVE_DEBOUNCE);
        return Promise.resolve(true);
      }
      return Store.writeNow(data);
    },

    writeNow: function (data) {
      // 直接写盘必须取消挂起的防抖写：否则更早排队的旧快照会在 400ms 后落盘，
      // 把这次（更新的）写入覆盖掉。恢复备份时曾因此把恢复结果整片盖回旧状态。
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      pendingData = null;
      if (!current) { current = memoryBackend(); }
      var target = current;
      return Promise.resolve().then(function () {
        return target.write(data);
      }).then(function () {
        setStatus({
          ok: true, lastError: "", lastSavedAt: Date.now(),
          backend: target.name, persistent: target.persistent,
          available: target.name !== "memory",
          backupOnly: target.name === "memory"
        });
        return true;
      }).catch(function (err) {
        // 侧车写失败：尝试重连一次再重试（宿主可能重启过侧车）
        if (target.name === "sidecar") {
          return settle(withTimeout(rpc("notes/ping", {}, PING_TIMEOUT), PING_TIMEOUT + 500, "重连侧车"))
            .then(function (r) {
              if (r.ok) { return target.write(data); }
              throw err;
            }).then(function () {
              setStatus({ ok: true, lastError: "", lastSavedAt: Date.now() });
              return true;
            }).catch(function (again) {
              var msg = errText(again || err);
              setStatus({ ok: false, lastError: msg, sidecarAvailable: false, sidecarError: msg });
              note("notes/save", false, msg);
              return false;
            });
        }
        var m = errText(err);
        setStatus({ ok: false, lastError: m });
        note("写入笔记", false, m);
        return false;
      });
    },

    flush: function () {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingData) {
        var d = pendingData;
        pendingData = null;
        return Store.writeNow(d);
      }
      return Promise.resolve(true);
    },

    readFileAsText: function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result)); };
        r.onerror = function () { reject(r.error || new Error("读取文件失败")); };
        r.readAsText(file);
      });
    },

    /** 读本地文件为 base64（恢复备份用：zip 是二进制，不能按文本读） */
    readFileAsBase64: function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var u8 = new Uint8Array(r.result);
          var s = "";
          for (var i = 0; i < u8.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
          }
          resolve(btoa(s));
        };
        r.onerror = function () { reject(r.error || new Error("读取文件失败")); };
        r.readAsArrayBuffer(file);
      });
    },

    /** 诊断文本（存储状态弹窗用） */
    diagLines: diagLines
  };

  /* ====================== 看门狗：拿不到结果也要留下证据 ======================
   * 存在的意义：本次事故（bindEvents 崩在缺失按钮上 → boot 中断 → init() 从未被调用）
   * 在前端表现为「状态一直是 unknown」，但没有任何异常提示。看门狗把这种「静默卡死」
   * 变成诊断日志里的一条 FAIL，直接指出是 UI 层没调 init，而不是存储层的问题。
   */
  var WATCHDOG_MARKS = [4000, 10000, 20000];
  WATCHDOG_MARKS.forEach(function (ms) {
    setTimeout(function () {
      try {
        if (!initCalled) {
          note("看门狗 +" + (ms / 1000) + "s", false,
            "存储模块已加载 " + (ms / 1000) + " 秒，但 init() 从未被调用 "
            + "→ UI 启动在更早的位置中断（往下看是否有「前端启动中断 / 页面 JS 错误」）");
        } else if (status.backend === "unknown") {
          note("看门狗 +" + (ms / 1000) + "s", false,
            "存储初始化仍未出结果（backend 仍为 unknown），最后一条日志即卡住的位置");
        }
      } catch (e) { /* ignore */ }
    }, ms);
  });

  // 页面隐藏/卸载前把最后一次编辑写出去
  window.addEventListener("pagehide", function () { Store.flush(); });
  window.addEventListener("beforeunload", function () { Store.flush(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { Store.flush(); }
  });

  MD.storage = Store;
})();
