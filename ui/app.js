/*
 * MD 笔记 主逻辑
 * 依赖（按 index.html 加载顺序）：sql-highlight.js、markdown.js、storage.js
 *
 * 本版修复：
 *  - 笔记丢失：存储层多后端探测 + 写入失败可见；仅在「确实没有任何数据」时才初始化示例
 *  - 目录树：笔记/文件夹图标区分、支持移动到任意文件夹（对话框 + 拖拽）、右键菜单
 *  - 导出：文件名安全化、重名处理、沙箱禁用下载时降级为「可复制」弹窗、支持文件夹导出 zip
 *  - 体验：状态栏（存储后端/字数/视图切换）、空状态、Toast、快捷键、明暗主题跟随 DBX
 */
(function () {
  "use strict";

  var S = window.MDNotes.storage;
  function $(id) { return document.getElementById(id); }

  /**
   * 安全绑定：元素不存在时记一条诊断日志并跳过，绝不抛错中断启动。
   * 历史事故：index.html 里 `btn-copy-sql` 被注释掉，而 bindEvents 里仍写
   *   `$("btn-copy-sql").onclick = copySqlToDbx;`
   * → TypeError: Cannot set properties of null
   * → bindEvents 在这里中断（后面 40 多个绑定全部没执行）
   * → boot() 第一行就抛错 → applyTheme/renderStatus/S.init 从未执行
   * → 表现为「所有按钮点不动 + 存储状态一直停在 unknown + 笔记永远不落盘」。
   * 现在改成：缺元素只记日志，不再连坐后面所有绑定。
   */
  function on(id, evName, handler, optional) {
    var el = $(id);
    if (!el) {
      S.log("绑定 " + evName + " → #" + id, optional ? null : false,
        optional
          ? "元素不存在（HTML 里未启用），该功能按未启用处理"
          : "DOM 中不存在该元素（被注释/删除），该功能不可用；其余绑定不受影响（已不再连坐）");
      return null;
    }
    el[evName] = handler;
    return el;
  }
  function click(id, handler, optional) { return on(id, "onclick", handler, optional); }

  /** 页面级错误捕获：任何未捕获异常都进置顶诊断条，不再静默失败 */
  window.addEventListener("error", function (e) {
    var where = (e && e.filename)
      ? " @ " + String(e.filename).split(/[\\/]/).pop() + ":" + (e.lineno || 0) + ":" + (e.colno || 0)
      : "";
    S.log("页面 JS 错误", false, ((e && e.message) || "未知错误") + where);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    S.log("未处理的 Promise 异常", false, (r && (r.message || r.stack)) || String(r));
  });

  var state = {
    nodes: [],        // [{id,type:'folder'|'note',name,parentId,content,createdAt,updatedAt}]
    activeId: null,
    expanded: {},
    view: "split",
    query: "",
    loaded: false
  };
  var manualTheme = null;
  var configuredDir = "";   // 连接表单里填的「笔记存储目录」（宿主传入，前端只能读不能写）
  var dragId = null; // 保留兼容，指针拖拽使用 pdrag
  var pdrag = null; // 指针拖拽状态：{id, n, row, startX, startY, moved, ghost}
  var previewTimer = null;
  var toastTimer = null;

  // ---------------- 基础工具 ----------------
  function uid() {
    return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function nowISO() { return new Date().toISOString(); }

  function byId(id) {
    for (var i = 0; i < state.nodes.length; i++) {
      if (state.nodes[i].id === id) { return state.nodes[i]; }
    }
    return null;
  }
  function childrenOf(pid) {
    var p = pid || null;
    return state.nodes.filter(function (n) { return (n.parentId || null) === p; });
  }
  function isDescendant(id, ancestorId) {
    var n = byId(id), guard = 0;
    while (n && n.parentId && guard < 64) {
      if (n.parentId === ancestorId) { return true; }
      n = byId(n.parentId); guard++;
    }
    return false;
  }
  function countNotes(pid) {
    var total = 0;
    childrenOf(pid).forEach(function (n) {
      if (n.type === "note") { total++; } else { total += countNotes(n.id); }
    });
    return total;
  }
  function sortNodes(list) {
    return list.slice().sort(function (a, b) {
      if (a.type !== b.type) { return a.type === "folder" ? -1 : 1; }
      return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
    });
  }
  function uniqueName(pid, name, excludeId) {
    var taken = {};
    childrenOf(pid).forEach(function (n) {
      if (n.id !== excludeId) { taken[String(n.name).toLowerCase()] = true; }
    });
    if (!taken[String(name).toLowerCase()]) { return name; }
    var i = 2;
    while (taken[(name + " (" + i + ")").toLowerCase()]) { i++; }
    return name + " (" + i + ")";
  }
  function stripExt(name) {
    return String(name || "").replace(/\.(md|markdown|txt)$/i, "");
  }
  function activeNote() {
    var n = state.activeId ? byId(state.activeId) : null;
    return n && n.type === "note" ? n : null;
  }
  function selectedNode() {
    return state.activeId ? byId(state.activeId) : null;
  }
  /** 新建笔记时默认落到哪个文件夹：当前选中文件夹 → 当前笔记所在文件夹 → 根目录 */
  function targetFolderId() {
    var n = selectedNode();
    if (!n) { return null; }
    return n.type === "folder" ? n.id : (n.parentId || null);
  }

  // ---------------- 持久化 ----------------
  function snapshot() {
    return {
      version: 2,
      nodes: state.nodes,
      activeId: state.activeId,
      expanded: state.expanded,
      view: state.view,
      updatedAt: Date.now()
    };
  }
  function persist(debounce) {
    if (!state.loaded) { return; }
    S.save(snapshot(), debounce !== false);
  }

  /**
   * 把「载入结果」套用到 state，成功返回 true。
   *
   * 坑：S.init() / S.reload() resolve 的是 {data:{nodes,...}, firstRun, ...}，
   * 笔记数据在 .data 这一层，不在顶层。取错层会静默失败（守卫条件不成立），
   * 于是「换存储目录」或「恢复备份」后界面仍显示旧状态，而紧接着的那次
   * persist 又把旧状态写回磁盘 —— 等于把刚写好的结果原地抹掉。
   */
  function applyLoaded(res) {
    var d = (res && res.data) ? res.data : res;
    if (!d || Object.prototype.toString.call(d.nodes) !== "[object Array]") { return false; }
    state.nodes = d.nodes;
    state.activeId = d.activeId || null;
    state.expanded = d.expanded || {};
    if (d.view) { setView(d.view); }
    if (state.activeId && !byId(state.activeId)) { state.activeId = null; }
    if (!state.activeId) {
      var firsts = state.nodes.filter(function (n) { return n.type === "note"; });
      if (firsts.length) { state.activeId = firsts[0].id; }
    }
    return true;
  }

  // ---------------- 图标 ----------------
  var ICONS = {
    folder: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M2 4.3c0-.6.5-1.1 1.1-1.1h2.5l1.3 1.6h6c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" ' +
      'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    note: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
      '<path d="M4 2.2h5.3L12 4.9V13.8H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M6 7.4h4.4M6 9.8h4.4M6 12.1h2.9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
    chevron: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<path d="M6 4.2l4 3.8-4 3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function iconSpan(kind, cls) {
    var s = document.createElement("span");
    s.className = "ico " + (cls || kind);
    s.innerHTML = ICONS[kind] || "";
    return s;
  }

  // ---------------- 主题 ----------------
  function hostTheme() {
    try {
      var d = window.dbxPlugin;
      if (d && typeof d.theme === "string") { return d.theme; }
      if (d && d.theme && typeof d.theme.mode === "string") { return d.theme.mode; }
      var attr = document.documentElement.getAttribute("data-dbx-theme");
      if (attr) { return attr.indexOf("dark") >= 0 ? "dark" : "light"; }
    } catch (e) { /* ignore */ }
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) { return "dark"; }
    } catch (e) { /* ignore */ }
    return "light";
  }
  function applyTheme() {
    var m = manualTheme || hostTheme();
    document.documentElement.setAttribute("data-theme", m);
    if (m === "dark") { document.body.classList.add("dark"); } else { document.body.classList.remove("dark"); }
  }

  // ---------------- Toast ----------------
  function toast(msg, kind) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------------- 通用弹窗 ----------------
  function closeModal() {
    var m = $("modal");
    m.hidden = true;
    m.textContent = "";
    m.onclick = null;
  }
  function openModal(build) {
    var m = $("modal");
    closeModal();
    m.hidden = false;
    var card = document.createElement("div");
    card.className = "modal-card";
    build(card);
    m.appendChild(card);
    m.onclick = function (e) { if (e.target === m) { closeModal(); } };
    var first = card.querySelector("input,textarea");
    if (first) { first.focus(); if (first.select) { first.select(); } }
  }
  function modalButtons(parent, buttons) {
    var wrap = document.createElement("div");
    wrap.className = "modal-actions";
    buttons.forEach(function (b) {
      var el = document.createElement("button");
      el.textContent = b.text;
      if (b.primary) { el.className = "primary"; }
      if (b.danger) { el.className = "danger"; }
      el.onclick = b.onClick;
      wrap.appendChild(el);
    });
    parent.appendChild(wrap);
    return wrap;
  }
  function promptModal(title, label, value, okText) {
    return new Promise(function (resolve) {
      var input;
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
        var lb = document.createElement("label"); lb.className = "m-label"; lb.textContent = label; card.appendChild(lb);
        input = document.createElement("input");
        input.className = "m-input";
        input.value = value || "";
        input.onkeydown = function (e) {
          if (e.key === "Enter") { done(true); }
          if (e.key === "Escape") { done(false); }
        };
        card.appendChild(input);
        modalButtons(card, [
          { text: "取消", onClick: function () { done(false); } },
          { text: okText || "确定", primary: true, onClick: function () { done(true); } }
        ]);
      });
      function done(ok) {
        if (!ok) { closeModal(); resolve(null); return; }
        var v = String(input.value || "").trim();
        if (!v) { toast("名称不能为空", "warn"); return; }
        closeModal(); resolve(v);
      }
    });
  }
  function confirmModal(title, message, okText, danger) {
    return new Promise(function (resolve) {
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
        var p = document.createElement("p"); p.className = "m-msg"; p.textContent = message; card.appendChild(p);
        modalButtons(card, [
          { text: "取消", onClick: function () { closeModal(); resolve(false); } },
          { text: okText || "确定", primary: !danger, danger: !!danger, onClick: function () { closeModal(); resolve(true); } }
        ]);
      });
    });
  }
  function moveModal(node) {
    return new Promise(function (resolve) {
      var sel;
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = "移动到…"; card.appendChild(h);
        var p = document.createElement("p");
        p.className = "m-msg";
        p.textContent = "把「" + node.name + "」移动到：" + (node.type === "folder" ? "（整棵子树一起移动）" : "");
        card.appendChild(p);
        sel = document.createElement("select");
        sel.className = "m-input";
        folderOptions(node.id).forEach(function (o) {
          var op = document.createElement("option");
          op.value = o.id; op.textContent = o.label;
          sel.appendChild(op);
        });
        card.appendChild(sel);
        modalButtons(card, [
          { text: "取消", onClick: function () { closeModal(); resolve(null); } },
          { text: "移动", primary: true, onClick: function () { closeModal(); resolve(sel.value); } }
        ]);
      });
    });
  }
  function folderOptions(excludeId) {
    var out = [{ id: "", label: "（根目录）" }];
    function walk(pid, depth) {
      sortNodes(childrenOf(pid)).forEach(function (n) {
        if (n.type !== "folder") { return; }
        if (excludeId && (n.id === excludeId || isDescendant(n.id, excludeId))) { return; }
        out.push({ id: n.id, label: new Array(depth + 1).join("　") + n.name });
        walk(n.id, depth + 1);
      });
    }
    walk(null, 0);
    return out;
  }

  // ---------------- 目录树渲染 ----------------
  function highlightInto(el, text, q) {
    el.textContent = "";
    var s = String(text || "");
    if (!q) { el.textContent = s; return; }
    var lower = s.toLowerCase(), needle = q.toLowerCase(), from = 0, idx;
    while ((idx = lower.indexOf(needle, from)) >= 0) {
      if (idx > from) { el.appendChild(document.createTextNode(s.slice(from, idx))); }
      var mk = document.createElement("mark");
      mk.textContent = s.slice(idx, idx + needle.length);
      el.appendChild(mk);
      from = idx + needle.length;
    }
    if (from < s.length) { el.appendChild(document.createTextNode(s.slice(from))); }
  }

  function rowEl(n, depth, forceOpen) {
    var row = document.createElement("div");
    row.className = "node" + (n.id === state.activeId ? " active" : "");
    row.setAttribute("data-id", n.id);
    row.setAttribute("data-type", n.type);
    // 这里【绝对不能】写 draggable="true"：
    // 目录树的拖拽是上面用指针事件自实现的；一旦元素可原生拖拽，浏览器会在拖到几像素时
    // 抢走手势 → 触发原生 HTML5 拖拽 → 随即发 pointercancel 掐断我们的 pointermove，
    // 结果就是「拖不动 + 一路禁止光标」。2026-09-21 的实际事故正是这一行遗留属性。
    row.style.paddingLeft = (8 + depth * 14) + "px";

    var tw = document.createElement("span");
    tw.className = "twisty";
    if (n.type === "folder") {
      tw.appendChild(iconSpan("chevron"));
      if (state.expanded[n.id] || forceOpen) { tw.classList.add("open"); }
      tw.onclick = function (e) {
        e.stopPropagation();
        state.expanded[n.id] = !state.expanded[n.id];
        persist(true);
        renderTree();
      };
    }
    row.appendChild(tw);

    row.appendChild(iconSpan(n.type));

    var lb = document.createElement("span");
    lb.className = "node-label";
    lb.title = n.name || "";
    highlightInto(lb, n.name, state.query.trim());
    row.appendChild(lb);

    if (n.type === "folder") {
      var cnt = document.createElement("span");
      cnt.className = "node-count";
      cnt.textContent = String(countNotes(n.id));
      row.appendChild(cnt);
    }

    row.onclick = function () { select(n.id); };
    row.ondblclick = function () { renameNode(n); };
    row.oncontextmenu = function (e) { e.preventDefault(); select(n.id); showCtxMenu(e.clientX, e.clientY, n); };

    // 指针拖拽（不依赖 HTML5 DnD API，在沙箱/插件 webview 中更可靠）
    row.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) { return; }
      // 展开箭头/按钮上不启动拖拽，保证点击展开、重命名等交互正常
      if (e.target && e.target.closest && (e.target.closest(".twisty") || e.target.closest("button"))) { return; }
      pdragBegin(e, n, row);
    });
    return row;
  }

  function clearDropMarks() {
    var els = document.querySelectorAll(".node.drop-target");
    for (var i = 0; i < els.length; i++) { els[i].classList.remove("drop-target"); }
  }

  function showDropMark(row) {
    clearDropMarks();
    row.classList.add("drop-target");
  }

  // ---------------- 指针拖拽（替代 HTML5 DnD，避免沙箱内 dragover 不生效/无放置光标） ----------------

  function pdragBegin(e, n, row) {
    pdrag = { id: n.id, n: n, row: row, startX: e.clientX, startY: e.clientY, moved: false, ghost: null };
  }

  function makeGhost(n) {
    var g = document.createElement("div");
    g.className = "drag-ghost";
    g.textContent = (n.type === "folder" ? "[文件夹] " : "[笔记] ") + (n.name || "");
    document.body.appendChild(g);
    return g;
  }

  function elementToNode(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el !== document.body && el.nodeType === 1) {
      if (el.classList && el.classList.contains("node")) { return el; }
      el = el.parentNode;
    }
    return null;
  }

  // 返回落点：文件夹 id=移入；笔记 id=成为同级（取其父级）；null=根目录；undefined=取消（无效/自身/子文件夹）
  function computeDropTarget(x, y, srcId) {
    var nodeEl = elementToNode(x, y);
    if (!nodeEl) {
      var tree = $("tree");
      var under = document.elementFromPoint(x, y);
      if (tree && under && tree.contains(under)) { return null; } // 树空白区 = 根目录
      return undefined; // 落在插件区域外，视为取消
    }
    var id = nodeEl.getAttribute("data-id");
    if (id === srcId) { return undefined; }
    var tn = byId(id);
    if (!tn) { return undefined; }
    if (tn.type === "folder" && isDescendant(id, srcId)) { return undefined; }
    if (tn.type === "folder") { return id; }
    return tn.parentId || null;
  }

  function updateDropTarget(x, y, srcId) {
    clearDropMarks();
    var nodeEl = elementToNode(x, y);
    if (!nodeEl) { return; }
    var id = nodeEl.getAttribute("data-id");
    if (id === srcId) { return; }
    var tn = byId(id);
    if (!tn) { return; }
    if (tn.type === "folder" && isDescendant(id, srcId)) { return; }
    nodeEl.classList.add("drop-target");
  }

  function pdragMove(e) {
    if (!pdrag) { return; }
    if (!pdrag.moved) {
      var dx = e.clientX - pdrag.startX, dy = e.clientY - pdrag.startY;
      if (dx * dx + dy * dy < 36) { return; } // 阈值 ~6px，区分点击与拖拽
      pdrag.moved = true;
      document.body.classList.add("dragging-active");
      if (pdrag.row) { pdrag.row.classList.add("dragging"); }
      pdrag.ghost = makeGhost(pdrag.n);
    }
    if (pdrag.ghost) {
      pdrag.ghost.style.left = e.clientX + "px";
      pdrag.ghost.style.top = e.clientY + "px";
    }
    updateDropTarget(e.clientX, e.clientY, pdrag.id);
  }

  function pdragEnd(e) {
    if (!pdrag) { return; }
    var moved = pdrag.moved;
    var id = pdrag.id;
    if (pdrag.ghost && pdrag.ghost.parentNode) { pdrag.ghost.parentNode.removeChild(pdrag.ghost); }
    if (pdrag.row) { pdrag.row.classList.remove("dragging"); }
    clearDropMarks();
    document.body.classList.remove("dragging-active");
    pdrag = null;
    if (moved) {
      var dest = computeDropTarget(e.clientX, e.clientY, id);
      if (dest !== undefined) { doMove(id, dest); }
    }
  }

  // 全局指针监听（仅在拖拽进行中生效，否则直接 return，不影响其它交互）
  document.addEventListener("pointermove", pdragMove);
  document.addEventListener("pointerup", pdragEnd);
  document.addEventListener("pointercancel", pdragEnd);

  // 兜底闸门：任何情况下都不允许原生 HTML5 拖拽接管目录树。
  // 原生拖拽一旦启动会立刻发 pointercancel 掐断指针拖拽，并显示禁止光标 —— 加这一层
  // 是为了让「日后有人再加回 draggable / 或从别处拖入元素」也不会把拖拽功能搞死。
  document.addEventListener("dragstart", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("#tree")) { e.preventDefault(); }
  });

  function renderTree() {
    var tree = $("tree");
    tree.textContent = "";
    var q = state.query.trim().toLowerCase();

    var hit = {};
    if (q) {
      state.nodes.forEach(function (n) {
        if (n.type === "note") {
          if (String(n.name || "").toLowerCase().indexOf(q) >= 0 ||
            String(n.content || "").toLowerCase().indexOf(q) >= 0) { hit[n.id] = true; }
        } else if (String(n.name || "").toLowerCase().indexOf(q) >= 0) {
          hit[n.id] = true;
        }
      });
      // 命中的父链也要显示
      Object.keys(hit).forEach(function (id) {
        var p = byId(id), guard = 0;
        if (p) { p = p.parentId ? byId(p.parentId) : null; }
        while (p && guard < 64) {
          if (p.type === "folder") { hit[p.id] = true; }
          p = p.parentId ? byId(p.parentId) : null;
          guard++;
        }
      });
    }

    function build(pid, depth) {
      var out = [];
      sortNodes(childrenOf(pid)).forEach(function (n) {
        if (q) {
          var selfHit = !!hit[n.id];
          var kids = build(n.id, depth + 1);
          if (!selfHit && kids.length === 0) { return; }
          out.push(rowEl(n, depth, true));
          kids.forEach(function (k) { out.push(k); });
        } else {
          out.push(rowEl(n, depth, false));
          if (n.type === "folder" && state.expanded[n.id]) {
            build(n.id, depth + 1).forEach(function (k) { out.push(k); });
          }
        }
      });
      return out;
    }

    var rows = build(null, 0);
    if (rows.length === 0) {
      var empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = q ? "没有匹配的笔记" : "还没有任何笔记，点击「+ 新建笔记」开始";
      tree.appendChild(empty);
    } else {
      rows.forEach(function (r) { tree.appendChild(r); });
    }

    var sel = selectedNode();
    $("sel-actions").hidden = !sel;
  }

  // ---------------- 编辑器 / 预览 ----------------
  function renderEditor() {
    var n = activeNote();
    var panes = $("panes");
    var title = $("title");
    var editor = $("editor");
    if (!n) {
      panes.setAttribute("data-empty", "1");
      title.value = "";
      title.disabled = true;
      editor.value = "";
      editor.disabled = true;
      $("preview").textContent = "";
      updateCounter();
      return;
    }
    panes.setAttribute("data-empty", "0");
    title.disabled = false;
    editor.disabled = false;
    if (title.value !== n.name && document.activeElement !== title) { title.value = n.name; }
    if (editor.value !== (n.content || "") && document.activeElement !== editor) { editor.value = n.content || ""; }
    renderPreview();
    updateCounter();
  }

  function renderPreview() {
    var n = activeNote();
    var pv = $("preview");
    if (!n) { pv.textContent = ""; return; }
    pv.innerHTML = window.MDNotes.renderMarkdown(n.content || "");
  }

  function updateCounter() {
    var n = activeNote();
    var el = $("counter");
    if (!n) { el.textContent = "0 字"; $("note-meta").textContent = ""; return; }
    var txt = n.content || "";
    var lines = txt ? txt.split(/\r?\n/).length : 0;
    el.textContent = txt.length + " 字 · " + lines + " 行";
    var meta = $("note-meta");
    if (n.updatedAt) {
      meta.textContent = "更新于 " + fmtTime(n.updatedAt);
      meta.title = "最后更新：" + new Date(n.updatedAt).toLocaleString("zh-CN");
    } else {
      meta.textContent = "";
    }
  }
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      var now = new Date();
      var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
      function p2(x) { return (x < 10 ? "0" : "") + x; }
      if (sameDay) { return p2(d.getHours()) + ":" + p2(d.getMinutes()); }
      return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + p2(d.getHours()) + ":" + p2(d.getMinutes());
    } catch (e) { return ""; }
  }

  function setView(v) {
    state.view = v;
    $("panes").setAttribute("data-view", v);
    var btns = $("view-switch").querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute("data-view") === v) { btns[i].classList.add("on"); }
      else { btns[i].classList.remove("on"); }
    }
    persist(true);
  }

  // ---------------- 存储状态 ----------------
  var STATUS_TEXT = {
    host: "已保存到 DBX 插件空间",
    folder: "已保存到本地目录",
    local: "已保存到浏览器本地存储",
    session: "仅临时保存（关闭后丢失）",
    memory: "仅在内存中（未持久化）",
    sidecar: "已保存到存储目录"
  };
  function renderStatus(st) {
    st = S.status();   // 必须现取副本：onStatus 回调传的是内部 status 对象（没有 .diag 等派生字段）
    var pill = $("store-status");
    var dot = pill ? pill.querySelector(".store-dot") : null;
    var text = $("store-text");
    if (!dot || !text) { S.log("渲染状态栏", false, "状态栏 DOM 缺失（#store-status / #store-text）"); return; }

    var unconfigured = (st.backend === "sidecar" && st.dirConfigured === false);
    var bad = !st.ok || !st.persistent;
    var cls = st.ok ? (st.persistent ? "ok" : "warn") : "bad";
    if (unconfigured) { cls = "warn"; }
    dot.className = "store-dot " + cls;

    var label = STATUS_TEXT[st.backend] || ("存储：" + st.backend);
    if (st.backend === "sidecar" && st.storageDir) { label += "：" + st.storageDir; }
    if (st.backend === "folder" && st.folderName) { label += "：" + st.folderName; }
    if (!st.ok && st.lastError) { label += "（写入失败：" + st.lastError + "）"; }
    if (unconfigured) {
      var where = st.storageDir || st.storagePath || "插件默认目录";
      label = "未配置存储目录：笔记暂存于 " + where;
    }
    text.textContent = label;
    // 异常时仅用状态条颜色 + title 提示，不再弹干扰性横幅
    pill.title = unconfigured
      ? "未配置「笔记存储目录」：笔记当前保存在 " + (st.storageDir || st.storagePath || "插件默认目录") +
        "。请在连接设置里填写「笔记存储目录」后重新连接，笔记才会落到你指定的文件夹。"
      : (bad ? "存储异常：" + (st.lastError || "未持久化")
             : "已持久化保存" + (st.storageDir ? "（" + st.storageDir + "）" : ""));
  }

  /* ============ 页面置顶诊断条（上线默认关闭，保留代码便于排障） ============
   * 2026-09-21：存储已稳定，按产品要求把置顶条下线（线上太占地方）。
   * 需要排障时：把 SHOW_DIAG_BAR 改成 true + 取消 index.html 里那段注释即可，
   * renderDiag() 的调用点全部保留着，无需再改其它地方。
   */
  var SHOW_DIAG_BAR = false;
  var SHOW_DIAG_LOG_IN_MODAL = false;   // 存储状态弹窗里的「存储诊断日志」面板，默认隐藏

  /* ============ 功能开关：导入 .md（暂时下线） ============
   * 2026-09-21：导入功能容易出问题，先摘掉入口（工具栏按钮 / 右键菜单 / 隐藏 file input 全下线），
   * 代码与处理逻辑全部保留。要恢复：把下面改成 true，并把 index.html 里 #btn-import-md 与
   * #file-input 两处注释取消即可 —— 打包闸门会校验「开关与 HTML 必须一致」，不一致直接拒绝打包。
   */
  var ENABLE_IMPORT = false;

  var diagOpen = true;
  var diagLastSev = null;

  function diagSeverity(st) {
    if (st.backend === "unknown") { return "warn"; }
    if (!st.hostAvailable) { return "bad"; }
    if (!st.ok || !st.persistent) { return "bad"; }
    if (st.backend === "sidecar" && st.dirConfigured === false) { return "warn"; }
    return "ok";
  }

  function verdictText(st) {
    if (!st.hostAvailable) {
      return "笔记不会落盘：未检测到 dbxPlugin 桥接（当前可能不在 DBX 插件工作台内）";
    }
    if (st.backend === "unknown") {
      return "存储初始化尚未完成 —— 请看下方日志的最后一行，那里就是卡住的位置";
    }
    if (st.backend === "sidecar") {
      var where = st.storageDir || st.storagePath || "插件默认目录";
      if (st.ok && st.persistent) {
        return st.dirConfigured === false
          ? "笔记已落盘，但未配置「笔记存储目录」，实际写入：" + where
          : "笔记正在落盘到：" + where;
      }
      return "笔记不会落盘：" + (st.lastError || "侧车写入异常");
    }
    if (st.sidecarError) { return "笔记不会落盘：" + st.sidecarError; }
    if (st.lastError) { return "笔记不会落盘：" + st.lastError; }
    return "笔记当前不会落盘（后端：" + st.backend + "）";
  }

  function renderDiag() {
    if (!SHOW_DIAG_BAR) { return; }   // 置顶诊断条已下线
    var bar = $("diag-bar");
    if (!bar) { return; }
    var st = S.status();   // 同上：必须现取副本，否则 st.diag 为空 → 日志区永远显示"（暂无日志）"
    var sev = diagSeverity(st);
    bar.hidden = false;
    bar.setAttribute("data-sev", sev);

    var v = $("diag-verdict");
    if (v) { v.textContent = verdictText(st); }

    var parts = [
      "UI v" + (S.VERSION || "?"),
      "后端 " + st.backend,
      st.persistent ? "可持久化" : "不可持久化",
      "桥接 " + (st.hostAvailable ? "已连接" : "缺失"),
      "侧车 " + (st.sidecarAvailable ? "已握手" : "未握手"),
      "目录 " + (st.storageDir || "未读到")
    ];
    if (st.connectionId) { parts.push("连接 " + st.connectionId); }
    if (st.payloadBytes) { parts.push("上次负载 " + Math.round(st.payloadBytes / 1024) + "KB"); }
    if (st.lastSavedAt) { parts.push("上次写入 " + new Date(st.lastSavedAt).toLocaleTimeString("zh-CN")); }
    if (st.lastError) { parts.push("错误 " + st.lastError); }
    var s = $("diag-summary");
    if (s) { s.textContent = parts.join(" · "); }

    var log = $("diag-log");
    if (log) {
      log.textContent = (st.diag && st.diag.length) ? st.diag.join("\n") : "（暂无日志）";
      log.scrollTop = log.scrollHeight;
    }
    // 默认展开；一旦出现严重问题（bad）强制再展开一次，保证故障不会被折叠藏起来
    if (sev === "bad" && diagLastSev !== "bad") { diagOpen = true; }
    diagLastSev = sev;
    if (log) { log.hidden = !diagOpen; }
    var btn = $("diag-toggle");
    if (btn) { btn.textContent = diagOpen ? "收起日志" : "展开日志"; }
  }

  function openStoreModal() {
    var st = S.status();
    var lines = [
      "后端：" + st.backend
        + (st.backend === "folder" && st.folderName ? "（" + st.folderName + "）" : ""),
      "可持久化：" + (st.persistent ? "是" : "否"),
      "宿主桥接：" + (st.hostAvailable ? "已连接" : "不存在"),
      "侧车进程：" + (st.sidecarAvailable ? "已握手" : ("不可用 —— " + (st.sidecarError || "未知原因"))),
      "连接 ID：" + (st.connectionId || "（未读到）"),
      "实际落盘目录：" + (st.storageDir || "（未读到）"),
      "数据文件：" + (st.storagePath || "（尚未写入）"),
      "目录已配置：" + (st.dirConfigured ? "是" : "否（写入插件默认目录）"),
      "前端目录授权：" + (st.fsSupported ? "支持" : "不支持（沙箱内不可用，需走侧车）"),
      "最近写入：" + (st.lastSavedAt ? new Date(st.lastSavedAt).toLocaleString("zh-CN") : "尚无"),
      "最近负载：" + (st.payloadBytes ? Math.round(st.payloadBytes / 1024) + " KB" : "（尚无）"),
      "错误：" + (st.lastError || "无")
    ];
    openModal(function (card) {
      var h = document.createElement("h3"); h.textContent = "存储状态"; card.appendChild(h);
      var p = document.createElement("pre");
      p.className = "m-pre";
      p.textContent = lines.join("\n");
      card.appendChild(p);

      // 诊断日志面板：上线默认隐藏（SHOW_DIAG_LOG_IN_MODAL=false），
      // 改成 true 即可放出来；日志本身始终保留在 S.status().diag / S.report() 里。
      if (SHOW_DIAG_LOG_IN_MODAL) {
        var det = document.createElement("details");
        det.className = "m-diag";
        det.open = !st.persistent;   // 有问题默认展开
        var sum = document.createElement("summary");
        sum.textContent = "存储诊断日志（" + ((st.diag && st.diag.length) || 0) + " 条，排查用）";
        det.appendChild(sum);
        var pre = document.createElement("pre");
        pre.className = "m-pre";
        pre.textContent = (st.diag && st.diag.length) ? st.diag.join("\n") : "（无）";
        det.appendChild(pre);
        card.appendChild(det);
      }

      var acts = [];
      if (st.fsSupported) {
        acts.push({ text: "选择笔记目录…", onClick: function () { closeModal(); chooseDirFlow(); } });
      }
      acts.push({ text: "复制诊断报告", onClick: function () { copyText(S.report(), "诊断报告"); } });
      acts.push({ text: "立即备份", onClick: function () { closeModal(); backupAll(); } });
      acts.push({ text: "从备份恢复…", onClick: function () { closeModal(); restoreFlow(); } });
      acts.push({ text: "关闭", primary: true, onClick: closeModal });
      modalButtons(card, acts);
    });
  }

  // ---------------- 侧栏底部：统计 ----------------
  // 这里不再显示存储位置：存储状态弹窗（点状态栏）是唯一权威出口，
  // 同一信息两处显示只会出现「两处不一致、用户不知道该信哪个」。
  function renderSideFoot() {
    var foot = $("side-foot");
    if (!foot) { return; }
    var st = S.status();
    var totalNotes = 0, totalFolders = 0;
    state.nodes.forEach(function (n) {
      if (n.type === "note") { totalNotes++; } else { totalFolders++; }
    });
    foot.textContent = "";

    var stat = document.createElement("div");
    stat.className = "foot-stat";
    stat.innerHTML = '<span class="foot-num">' + totalNotes + '</span> 篇笔记 · ' +
      '<span class="foot-num">' + totalFolders + '</span> 个文件夹';
    foot.appendChild(stat);

    // 未配置 storage_dir 时给出醒目提示：笔记其实写进了插件默认目录，用户看不到 → 误以为没存储。
    // 注意这里只说「去哪看」，不重复贴路径（状态弹窗里有）。
    if (st.backend === "sidecar" && st.dirConfigured === false) {
      var warn = document.createElement("div");
      warn.className = "foot-warn";
      warn.textContent = "未配置「笔记存储目录」：笔记暂存在插件默认目录，在你自己的文件夹里看不到。"
        + "请在连接设置里填写后重新连接（点状态栏可看详情）。";
      foot.appendChild(warn);
    }
  }

  /** 授权一个本地目录，把笔记真正落盘 */
  function chooseDirFlow() {
    S.pickDirectory().then(function (r) {
      if (!r.ok) {
        toast(r.error || "无法选择目录", "warn");
        return null;
      }
      return S.reload().then(function (data) {
        if (applyLoaded(data) && state.nodes.length) {
          render();
          persist(false);
          toast("已载入本地目录中的笔记：" + r.name);
        } else {
          persist(false);
          toast("笔记将保存到本地目录：" + r.name);
        }
        renderStatus();
      });
    });
  }

  // ---------------- 渲染入口 ----------------
  function render() {
    renderTree();
    renderEditor();
    renderStatus();
    renderSideFoot();
    renderDiag();
  }

  // ---------------- 节点操作 ----------------
  function select(id) {
    state.activeId = id;
    var n = byId(id);
    if (n && n.type === "folder" && state.expanded[id] === undefined) { state.expanded[id] = true; }
    persist(true);
    render();
  }

  function createNote(name, parentId, content) {
    var n = {
      id: uid(), type: "note", name: uniqueName(parentId, name || "未命名笔记"),
      parentId: parentId || null, content: content == null ? "" : content,
      createdAt: nowISO(), updatedAt: nowISO()
    };
    state.nodes.push(n);
    state.activeId = n.id;
    persist(false);
    render();
    $("editor").focus();
    return n;
  }

  function createFolder(name, parentId) {
    var f = {
      id: uid(), type: "folder", name: uniqueName(parentId, name || "新建文件夹"),
      parentId: parentId || null, createdAt: nowISO(), updatedAt: nowISO()
    };
    state.nodes.push(f);
    state.expanded[f.id] = true;
    state.activeId = f.id;
    persist(false);
    render();
    return f;
  }

  function renameNode(n) {
    promptModal("重命名", n.type === "folder" ? "文件夹名称" : "笔记标题", n.name, "保存").then(function (v) {
      if (!v) { return; }
      var finalName = uniqueName(n.parentId, v, n.id);
      n.name = finalName;
      n.updatedAt = nowISO();
      persist(false);
      render();
      toast("已重命名");
    });
  }

  function removeNode(n) {
    var extra = n.type === "folder" ? (countNotes(n.id) + " 条笔记") : "";
    confirmModal(
      "删除" + (n.type === "folder" ? "文件夹" : "笔记"),
      "确定删除「" + n.name + "」" + (extra ? "及其中的 " + extra : "") + "？此操作不可撤销。",
      "删除", true
    ).then(function (ok) {
      if (!ok) { return; }
      var kill = {};
      kill[n.id] = true;
      if (n.type === "folder") {
        state.nodes.forEach(function (x) { if (isDescendant(x.id, n.id)) { kill[x.id] = true; } });
      }
      state.nodes = state.nodes.filter(function (x) { return !kill[x.id]; });
      if (kill[state.activeId]) { state.activeId = null; }
      persist(false);
      render();
      toast("已删除");
    });
  }

  function doMove(id, destId) {
    var n = byId(id);
    if (!n) { return; }
    destId = destId || null;
    if ((n.parentId || null) === destId) { return; }
    if (n.type === "folder") {
      if (destId === n.id || isDescendant(destId, n.id)) {
        toast("不能把文件夹移动到它自己或它的子文件夹里", "warn");
        return;
      }
    }
    n.parentId = destId;
    n.name = uniqueName(destId, n.name, n.id);
    n.updatedAt = nowISO();
    if (destId) { state.expanded[destId] = true; }
    persist(false);
    render();
    toast("已移动到「" + (destId ? byId(destId).name : "根目录") + "」");
  }

  // ---------------- 右键菜单 ----------------
  function closeCtxMenu() {
    var m = $("ctx-menu");
    m.hidden = true;
    m.textContent = "";
  }
  function showCtxMenu(x, y, n) {
    var m = $("ctx-menu");
    m.textContent = "";
    m.hidden = false;

    function item(text, fn, danger) {
      var b = document.createElement("button");
      b.className = "ctx-item" + (danger ? " danger" : "");
      b.textContent = text;
      b.onclick = function () { closeCtxMenu(); fn(); };
      m.appendChild(b);
    }

    if (!n) {
      item("新建笔记", function () { createNote("未命名笔记", null, ""); });
      item("新建文件夹", function () { newFolderFlow(null); });
      if (ENABLE_IMPORT) { item("导入 .md 文件", pickImportFiles); }
      item("备份全部为 zip", backupAll);
      item("从备份恢复…", restoreFlow);
    } else if (n.type === "folder") {
      item("新建笔记", function () { createNote("未命名笔记", n.id, ""); });
      item("新建子文件夹", function () { newFolderFlow(n.id); });
      item("重命名", function () { renameNode(n); });
      item("移动到…", function () { moveNodeFlow(n); });
      item("导出此文件夹为 zip", function () { exportFolder(n); });
      item("删除文件夹", function () { removeNode(n); }, true);
    } else {
      item("重命名", function () { renameNode(n); });
      item("移动到…", function () { moveNodeFlow(n); });
      item("导出 .md", function () { exportNote(n); });
      item("复制正文", function () { copyText(n.content || "", "笔记正文"); });
      item("删除笔记", function () { removeNode(n); }, true);
    }

    var w = m.offsetWidth || 168, h = m.offsetHeight || 180;
    var left = Math.min(x, window.innerWidth - w - 8);
    var top = Math.min(y, window.innerHeight - h - 8);
    m.style.left = Math.max(4, left) + "px";
    m.style.top = Math.max(4, top) + "px";
    setTimeout(function () {
      document.addEventListener("click", closeCtxMenu, { once: true });
    }, 0);
  }
  function moveNodeFlow(n) {
    moveModal(n).then(function (dest) {
      if (dest === null) { return; }
      doMove(n.id, dest);
    });
  }
  function newFolderFlow(parentId) {
    promptModal("新建文件夹", "文件夹名称", "新建文件夹", "创建").then(function (v) {
      if (v) { createFolder(v, parentId); }
    });
  }

  // ---------------- 导入 / 导出 / 备份 / 恢复 ----------------
  //
  // 落盘有两条通道，优先级从高到低：
  //   1. 宿主原生「另存为」（dbxPlugin.saveFile）—— 由宿主弹系统保存对话框，用户自己选目录和文件名。
  //      沙箱 iframe 里没有磁盘权限，a.download / blob 导航会被宿主静默取消，所以只能借宿主之手。
  //   2. 侧车写进「笔记存储目录」（toDisk=true）—— 宿主没有 saveFile 能力时的兜底，路径回显给用户。
  //
  // 备份必须包含配置：mdnotes-backup.json（版本/时间/原存储目录/计数）+ .mdnotes/meta.json（目录树索引）
  // + 全部正文 .md。只备份正文而不备份索引，恢复出来就是一堆没有名字和层级的孤儿文件。

  function merge(o, extra) {
    var out = {}, k;
    for (k in (o || {})) { if (Object.prototype.hasOwnProperty.call(o, k)) { out[k] = o[k]; } }
    for (k in (extra || {})) { if (Object.prototype.hasOwnProperty.call(extra, k)) { out[k] = extra[k]; } }
    return out;
  }

  function mimeOf(name) {
    var s = String(name || "").toLowerCase();
    if (/\.zip$/.test(s)) { return "application/zip"; }
    if (/\.md$/.test(s)) { return "text/markdown"; }
    if (/\.txt$/.test(s)) { return "text/plain"; }
    return "application/octet-stream";
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) { return n + " B"; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + " KB"; }
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  /** 让侧车产出字节，再交给用户：优先宿主「另存为」（自选目录），否则回退写进存储目录 */
  function saveViaSidecar(method, params, what, linesFn) {
    if (!S.hasHostSave()) {
      return S.invoke(method, merge(params, { toDisk: true })).then(function (d) {
        showPathModal("已" + what + "到笔记存储目录", d.path);
      }).catch(function (e) {
        toast(what + "失败：" + (e && e.message ? e.message : e), "warn");
      });
    }
    return S.invoke(method, params).then(function (r) {
      var name = r.fileName || ("md-notes" + (method.indexOf("backup") >= 0 ? ".zip" : ".md"));
      return S.saveFile(name, mimeOf(name), r.dataBase64).then(function (res) {
        if (res.canceled) { toast("已取消" + what); return; }
        if (res.ok) { showSavedModal("已" + what, res.path || name, linesFn ? linesFn(r) : null); return; }
        toast("「另存为」不可用（" + res.error + "），改为写入笔记存储目录", "warn");
        return S.invoke(method, merge(params, { toDisk: true })).then(function (d) {
          showPathModal("已" + what + "到笔记存储目录", d.path);
        });
      });
    }).catch(function (e) {
      toast(what + "失败：" + (e && e.message ? e.message : e), "warn");
    });
  }

  function exportNote(n) {
    if (!n) { toast("请先选择一条笔记", "warn"); return; }
    return saveViaSidecar("notes/exportNote", { id: n.id }, "导出笔记");
  }
  function exportFolder(folder) {
    if (!folder) { toast("请先选择一个文件夹", "warn"); return; }
    return saveViaSidecar("notes/backup", { scope: folder.id }, "备份文件夹", backupLines);
  }
  function backupAll() {
    return saveViaSidecar("notes/backup", {}, "备份全部笔记", backupLines);
  }

  /** 备份成功后把「包里装了什么」摊开说 —— 「含配置」必须看得见，否则没人知道它能用来恢复。 */
  function backupLines(r) {
    var lines = [
      "包含：" + (r.count || 0) + " 篇笔记 · " + (r.folders || 0) + " 个文件夹",
      "已含配置：mdnotes-backup.json（版本 / 导出时间 / 原存储目录）",
      "　　　　　.mdnotes/meta.json（目录树索引，恢复出层级和标题靠它）",
      "包体积：" + fmtBytes(r.bytes)
    ];
    if (r.storageDir) { lines.push("原存储目录：" + r.storageDir); }
    lines.push("");
    lines.push("要恢复：工具栏「恢复备份…」选中这个 zip 即可。");
    return lines;
  }

  /** 已保存到用户所选目录的弹窗 */
  function showSavedModal(title, path, extraLines, actions) {
    openModal(function (card) {
      var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
      var p = document.createElement("p");
      p.className = "m-msg";
      p.textContent = "已保存到你选择的目录：";
      card.appendChild(p);
      var ta = document.createElement("textarea");
      ta.className = "m-text";
      ta.value = path || "";
      ta.readOnly = true;
      card.appendChild(ta);
      if (extraLines && extraLines.length) {
        var pre = document.createElement("pre");
        pre.className = "m-pre";
        pre.textContent = extraLines.join("\n");
        card.appendChild(pre);
      }
      var acts = [];
      if (path) { acts.push({ text: "复制路径", onClick: function () { copyText(path, "文件路径"); } }); }
      (actions || []).forEach(function (a) { acts.push(a); });
      acts.push({ text: "关闭", primary: !actions || !actions.length, onClick: closeModal });
      modalButtons(card, acts);
    });
  }

  function showPathModal(title, path) {
    openModal(function (card) {
      var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
      var p = document.createElement("p");
      p.className = "m-msg";
      p.textContent = "文件已生成到你的笔记存储目录：";
      card.appendChild(p);
      var ta = document.createElement("textarea");
      ta.className = "m-text";
      ta.value = path || "";
      ta.readOnly = true;
      card.appendChild(ta);
      modalButtons(card, [
        { text: "关闭", onClick: closeModal },
        { text: "复制路径", primary: true, onClick: function () { copyText(path, "导出路径"); } }
      ]);
    });
  }

  /** 简单确认框（恢复这种破坏性操作必须先问一句） */
  function confirmModal(title, lines, okText) {
    return new Promise(function (resolve) {
      var done = function (v) { closeModal(); resolve(v); };
      openModal(function (card) {
        var h = document.createElement("h3"); h.textContent = title; card.appendChild(h);
        var pre = document.createElement("pre");
        pre.className = "m-pre";
        pre.textContent = lines.join("\n");
        card.appendChild(pre);
        modalButtons(card, [
          { text: "取消", onClick: function () { done(false); } },
          { text: okText || "确定", primary: true, onClick: function () { done(true); } }
        ]);
      });
    });
  }

  // ---------------- 从备份恢复 ----------------

  function restoreFlow() {
    var inp = $("backup-input");
    if (!inp) { toast("恢复入口不可用", "warn"); return; }
    inp.value = "";
    inp.click();
  }

  function handleRestoreFile(files) {
    var f = files && files[0];
    if (!f) { return; }
    // 宿主对 request 参数有 2 MiB 上限，base64 之后能带上行的 zip 约 1.5 MB。
    // 超过就明确拒绝并给替代方案，而不是让它失败在一个看不懂的报错上。
    if (f.size > S.MAX_UPSTREAM_BYTES) {
      toast("备份包太大（" + fmtBytes(f.size) + " > 上限 " + fmtBytes(S.MAX_UPSTREAM_BYTES)
        + "）：请手动解压后把 .md 放回存储目录", "warn");
      return;
    }
    var b64 = "";
    S.readFileAsBase64(f).then(function (v) {
      b64 = v;
      return S.invoke("notes/restore", { dataBase64: b64, dryRun: true });
    }).then(function (r) {
      var bi = r.backup || {};
      var lines = [
        "备份文件：" + f.name + "（" + fmtBytes(f.size) + "）",
        "备份时间：" + (bi.exportedAt || "（未记录）"),
        "插件版本：" + (bi.version || "（未记录）"),
        "备份时存储目录：" + (bi.storageDir || "（未记录）"),
        "包含：" + r.notes + " 篇笔记 · " + r.folders + " 个文件夹",
        "",
        "将写入当前存储目录：" + r.storageDir,
        "同名笔记会被覆盖，目录树索引会被替换为备份时的状态。",
        "恢复前会自动另存一份 pre-restore-*.zip 作为退路。"
      ];
      return confirmModal("确认恢复？", lines, "开始恢复");
    }).then(function (ok) {
      if (!ok) { toast("已取消恢复"); return null; }
      // 恢复前先把挂起的防抖写落定，避免「恢复完成」之后又被那一帧旧快照覆盖。
      return S.flush().then(function () {
        return S.invoke("notes/restore", { dataBase64: b64 });
      }).then(function (r) {
        return S.reload().then(function (data) {
          applyLoaded(data);
          render();
          persist(false);
          var lines = [
            "已恢复 " + r.notes + " 篇笔记 · " + r.folders + " 个文件夹",
            "存储目录：" + r.storageDir
          ];
          lines.push(r.safetyPath
            ? ("恢复前的快照（退路）：" + r.safetyPath)
            : "（恢复前没有笔记，无需快照）");
          showSavedModal("恢复完成", r.storageDir, lines);
        });
      });
    }).catch(function (e) {
      toast("恢复失败：" + (e && e.message ? e.message : e), "warn");
    });
  }
  /** 打开「导入 .md」的文件选择框。导入功能下线时不会走到这里；
   *  取元素用安全写法（先赋值再判空），避免元素缺失时抛错把调用方连坐。 */
  function pickImportFiles() {
    var fi = $("file-input");
    if (fi) { fi.click(); } else { toast("导入功能已停用", "warn"); }
  }

  function handleImport(files) {
    if (!files || !files.length) { return; }
    var parentId = targetFolderId();
    var list = Array.prototype.slice.call(files);
    Promise.all(list.map(function (f) {
      return S.readFileAsText(f).then(function (txt) { return { name: stripExt(f.name), text: txt }; })
        .catch(function () { return null; });
    })).then(function (items) {
      var n = 0;
      items.forEach(function (it) {
        if (!it) { return; }
        createNote(it.name, parentId, it.text);
        n++;
      });
      toast(n ? ("已导入 " + n + " 条笔记") : "没有可导入的 .md 文件", n ? "" : "warn");
    });
  }
  function copyText(text, what) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      return ok;
    }
    var done = function (ok) { toast(ok ? ("已复制" + (what ? "（" + what + "）" : "")) : "复制失败，请手动选择复制", ok ? "" : "warn"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(fallback()); });
    } else {
      done(fallback());
    }
  }

  // ---------------- 与数据库表联动 ----------------
  function parseFields(text) {
    return String(text || "").split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(Boolean).map(function (l) {
        var parts = l.split(/\s+/);
        return { name: parts[0], type: parts.slice(1).join(" ") };
      });
  }
  function tableMarkdown(table, fields) {
    var L = [];
    L.push("# 表设计笔记：" + table);
    L.push("");
    L.push("> 创建于 " + new Date().toLocaleString("zh-CN"));
    L.push("");
    L.push("## 字段清单");
    L.push("");
    if (fields.length) {
      L.push("| 列名 | 类型 | 说明 |");
      L.push("| --- | --- | --- |");
      fields.forEach(function (f) { L.push("| " + f.name + " | " + (f.type || "") + " |  |"); });
    } else {
      L.push("（未提供字段清单）");
    }
    L.push("");
    L.push("## 设计说明");
    L.push("");
    L.push("- 主键 / 唯一键：");
    L.push("- 索引设计：");
    L.push("- 数据量级与增长：");
    L.push("");
    L.push("## 踩坑记录");
    L.push("");
    L.push("- ");
    L.push("");
    L.push("## SQL 心得");
    L.push("");
    L.push("```sql");
    var cols = fields.length ? fields.slice(0, 6).map(function (f) { return f.name; }).join(", ") : "*";
    L.push("SELECT " + cols);
    L.push("FROM " + table);
    L.push("LIMIT 100;");
    L.push("```");
    return L.join("\n");
  }

  function openTableModal(prefill) {
    var tm = $("table-modal");
    var folderSel = $("tn-folder");
    folderSel.textContent = "";
    folderOptions(null).forEach(function (o) {
      var op = document.createElement("option");
      op.value = o.id; op.textContent = o.label;
      folderSel.appendChild(op);
    });
    var def = targetFolderId();
    if (def) { folderSel.value = def; }
    $("tn-table").value = (prefill && prefill.table) || "";
    $("tn-fields").value = (prefill && prefill.fields) || "";
    tm.hidden = false;
    setTimeout(function () { $("tn-table").focus(); }, 0);
  }
  function closeTableModal() { $("table-modal").hidden = true; }
  function submitTableModal() {
    var table = String($("tn-table").value || "").trim();
    if (!table) { toast("请填写表名", "warn"); return; }
    var fields = parseFields($("tn-fields").value);
    var parent = $("tn-folder").value || null;
    closeTableModal();
    createNote("表设计：" + table, parent, tableMarkdown(table, fields));
    toast("已为「" + table + "」创建笔记");
  }

  /** 从宿主传入的上下文自动建笔记（右键「为此表新建笔记」） */
  /**
   * 处理「为此表新建笔记」上下文。
   * 上下文有两个来源：
   *  1) 宿主直接把 context 挂在桥接对象上（dbxPlugin.context）
   *  2) 右键菜单由侧车记录到 pending，前端 notes/load 取回（不依赖宿主的打开方法名）
   */
  function handleHostContext(pending) {
    var ctx = pending || null;
    if (!ctx) {
      try { ctx = window.dbxPlugin && window.dbxPlugin.context; } catch (e) { ctx = null; }
    }
    if (!ctx) { return; }
    var table = ctx.tableName || ctx.table || ctx.name || ctx.objectName || "";
    if (!table) { return; }
    var cols = ctx.columns || ctx.fields || [];
    var fieldsText = cols.map(function (c) {
      if (typeof c === "string") { return c; }
      return (c.name || c.column || "") + (c.type ? " " + c.type : "");
    }).filter(Boolean).join("\n");

    var title = "表设计：" + table;
    var exist = state.nodes.filter(function (n) { return n.type === "note" && n.name === title; })[0];
    if (exist) {
      state.activeId = exist.id;
      persist(false);
      render();
      toast("已打开已有笔记：" + title);
      return;
    }
    createNote(title, null, tableMarkdown(table, parseFields(fieldsText)));
    toast("已为「" + table + "」创建笔记");
  }

  function insertSqlBlock() {
    var n = activeNote();
    if (!n) { toast("请先选择一条笔记", "warn"); return; }
    var ta = $("editor");
    var table = "";
    var m = String(n.name || "").match(/表设计[：:]\s*(.+)$/);
    if (m) { table = m[1].trim(); }
    var block = "\n```sql\nSELECT *\nFROM " + (table || "your_table") + "\nLIMIT 100;\n```\n";
    var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var end = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    var v = ta.value;
    ta.value = v.slice(0, start) + block + v.slice(end);
    var pos = start + block.length;
    ta.selectionStart = ta.selectionEnd = pos;
    n.content = ta.value;
    n.updatedAt = nowISO();
    ta.focus();
    persist(false);
    renderPreview();
    updateCounter();
  }

  function firstSqlBlock(text) {
    var re = /```[ \t]*sql[ \t]*\r?\n([\s\S]*?)```/gi;
    var m = re.exec(String(text || ""));
    return m ? m[1] : "";
  }
  function copySqlToDbx() {
    var ta = $("editor");
    var sel = ta.value.slice(ta.selectionStart || 0, ta.selectionEnd || 0);
    var sql = sel.trim() ? sel.trim() : firstSqlBlock(ta.value);
    if (!sql) { sql = ta.value; }
    if (!String(sql).trim()) { toast("没有可复制的 SQL", "warn"); return; }
    copyText(sql, "SQL，可直接粘贴到 DBX SQL 编辑器");
  }

  // ---------------- 初始化示例（仅在完全没有数据时） ----------------
  function seed() {
    var welcome =
      "# 欢迎使用 MD 笔记\n\n" +
      "这是你的第一篇笔记。左侧是目录树，右侧是编辑器与实时预览。\n\n" +
      "## 支持的语法\n\n" +
      "- 标题、列表、**加粗**、*斜体*、`行内代码`\n" +
      "- > 引用\n\n" +
      "| 列名 | 类型 | 说明 |\n" +
      "| --- | --- | --- |\n" +
      "| id | bigint | 主键 |\n\n" +
      "## SQL 代码块（自动高亮）\n\n" +
      "```sql\nSELECT id, name\nFROM users\nWHERE created_at >= '2026-01-01'\nORDER BY id DESC\nLIMIT 100;\n```\n\n" +
      "> 提示：右上角「复制 SQL 到 DBX」会提取第一个 ```sql 块，粘贴进原生 SQL 编辑器即可执行。\n";

    var tips =
      "# DBX 使用心得\n\n" +
      "## 慢查询排查\n\n" +
      "1. 先看执行计划\n" +
      "2. 再确认索引是否命中\n\n" +
      "```sql\nEXPLAIN SELECT * FROM orders WHERE user_id = 42;\n```\n\n" +
      "## 踩坑\n\n" +
      "- 大表 `COUNT(*)` 很慢，改用近似值或缓存。\n";

    var f = { id: uid(), type: "folder", name: "示例", parentId: null, createdAt: nowISO(), updatedAt: nowISO() };
    var n1 = { id: uid(), type: "note", name: "欢迎使用 MD 笔记", parentId: null, content: welcome, createdAt: nowISO(), updatedAt: nowISO() };
    var n2 = { id: uid(), type: "note", name: "DBX 使用心得", parentId: f.id, content: tips, createdAt: nowISO(), updatedAt: nowISO() };
    state.nodes = [f, n1, n2];
    state.expanded[f.id] = true;
    state.activeId = n1.id;
  }

  // ---------------- 事件绑定 ----------------
  function bindEvents() {
    click("btn-new-note", function () { createNote("未命名笔记", targetFolderId(), ""); });
    click("btn-new-folder", function () { newFolderFlow(targetFolderId()); });
    click("btn-empty-new", function () { createNote("未命名笔记", targetFolderId(), ""); });

    click("btn-rename", function () { var n = selectedNode(); if (n) { renameNode(n); } });
    click("btn-move", function () { var n = selectedNode(); if (n) { moveNodeFlow(n); } });
    click("btn-delete", function () { var n = selectedNode(); if (n) { removeNode(n); } });

    click("btn-table-note", function () { openTableModal(null); });
    click("btn-insert-sql", insertSqlBlock);
    // 注意：index.html 里 #btn-copy-sql 目前是注释状态，这里必须用安全绑定（optional=true），
    // 否则整个 bindEvents 会在此处中断（2026-09-21 实际事故：所有按钮点不动 + 笔记从不落盘）。
    click("btn-copy-sql", copySqlToDbx, true);
    click("btn-export-md", function () { exportNote(activeNote()); });
    // 导入功能暂时下线（ENABLE_IMPORT=false）：入口与绑定一起摘掉，避免出现点了没反应的按钮。
    if (ENABLE_IMPORT) { click("btn-import-md", pickImportFiles); }
    click("btn-backup-zip", backupAll);
    click("btn-restore-zip", restoreFlow);

    click("tn-cancel", closeTableModal);
    click("tn-ok", submitTableModal);
    click("table-modal", function (e) { if (e.target === $("table-modal")) { closeTableModal(); } });
    on("tn-fields", "onkeydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { submitTableModal(); }
    });

    if (ENABLE_IMPORT) {
      on("file-input", "onchange", function (e) {
        handleImport(e.target.files);
        e.target.value = "";
      });
    }

    on("backup-input", "onchange", function (e) {
      handleRestoreFile(e.target.files);
      e.target.value = "";
    });

    var search = $("search");
    if (search) {
      search.oninput = function () {
        state.query = search.value;
        $("search-clear").hidden = !search.value;
        renderTree();
      };
    } else {
      S.log("绑定 oninput → #search", false, "元素不存在，检索功能不可用");
    }
    click("search-clear", function () {
      search.value = ""; state.query = ""; $("search-clear").hidden = true; renderTree(); search.focus();
    });

    var title = $("title");
    title.oninput = function () {
      var n = activeNote();
      if (!n) { return; }
      n.name = title.value || "未命名笔记";
      n.updatedAt = nowISO();
      persist(true);
      renderTree();
    };
    title.onblur = function () {
      var n = activeNote();
      if (!n) { return; }
      var clean = uniqueName(n.parentId, String(n.name || "未命名笔记").trim() || "未命名笔记", n.id);
      n.name = clean;
      title.value = clean;
      persist(false);
      renderTree();
    };

    var editor = $("editor");
    editor.oninput = function () {
      var n = activeNote();
      if (!n) { return; }
      n.content = editor.value;
      n.updatedAt = nowISO();
      persist(true);
      updateCounter();
      if (previewTimer) { clearTimeout(previewTimer); }
      previewTimer = setTimeout(renderPreview, 120);
    };
    editor.onblur = function () { persist(false); };

    var vs = $("view-switch");
    var btns = vs ? vs.querySelectorAll("button") : [];
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.onclick = function () { setView(b.getAttribute("data-view")); };
      })(btns[i]);
    }

    click("btn-theme", function () {
      manualTheme = (document.documentElement.getAttribute("data-theme") === "dark") ? "light" : "dark";
      applyTheme();
    });

    // 目录空白处右键 → 根目录菜单
    on("tree", "oncontextmenu", function (e) {
      if (e.target !== $("tree")) { return; }
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, null);
    });

    // 置顶诊断条上的按钮：随 SHOW_DIAG_BAR 一起下线（元素已注释，绑定会打日志噪音）。
    // 需要排障时连同上面的开关一起放开：
    // click("diag-toggle", function () { diagOpen = !diagOpen; renderDiag(); });
    // click("diag-copy", function () { copyText(S.report(), "诊断报告"); });
    // click("diag-detail", openStoreModal);

    // 状态栏胶囊 → 状态详情弹窗
    click("store-status", openStoreModal);

    document.addEventListener("keydown", function (e) {
      var mod = e.ctrlKey || e.metaKey;
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "");
      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        S.flush().then(function () { toast("已保存"); });
        return;
      }
      if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        createNote("未命名笔记", targetFolderId(), "");
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        search.focus();
        return;
      }
      if (e.key === "Escape") {
        closeCtxMenu();
        if (!$("modal").hidden) { closeModal(); }
        if (!$("table-modal").hidden) { closeTableModal(); }
      }
    });

    document.addEventListener("click", function () { closeCtxMenu(); });

    // 主题跟随 DBX
    window.addEventListener("dbx-plugin-env", function () { applyTheme(); });
    if (window.matchMedia) {
      try {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
          if (!manualTheme) { applyTheme(); }
        });
      } catch (e) { /* ignore */ }
    }
  }

  // ---------------- 启动 ----------------
  /** 读取侧车实际在用的笔记存储目录（由 storage.js 从连接配置里解析） */
  function readConfiguredDir() {
    try {
      var st = S.status();
      configuredDir = st.storageDir || st.storagePath || "";
    } catch (e) { configuredDir = ""; }
  }

  function boot() {
    S.log("前端 boot 开始", null, "readyState=" + document.readyState);

    // 状态/日志一变就刷新状态栏 + 置顶诊断条
    S.onStatus(function () {
      try { renderStatus(); renderDiag(); } catch (e) { /* ignore */ }
    });
    S.onDiag(function () {
      try { renderDiag(); } catch (e) { /* ignore */ }
    });

    var phase = "绑定事件";
    try {
      bindEvents();
      phase = "应用主题";
      applyTheme();
      phase = "读取已配置目录";
      readConfiguredDir();
      phase = "首次渲染";
      renderStatus(S.status());
      renderDiag(S.status());
      S.log("前端 UI 就绪", true, "按钮绑定完成（置顶诊断条已下线），接下来调用存储 init()");
    } catch (e) {
      // 关键：任何前置阶段出错也要把诊断条画出来，否则用户只会看到一个死界面
      S.log("前端启动中断", false, phase + " 阶段抛错：" + ((e && e.message) || String(e)));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
      try { toast("界面初始化出错，请查看页顶诊断条", "warn"); } catch (e2) { /* ignore */ }
    }

    var initResult;
    try {
      initResult = S.init();
    } catch (e) {
      S.log("调用存储 init() 抛错", false, (e && e.message) || String(e));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
      return;
    }
    if (!initResult || typeof initResult.then !== "function") {
      S.log("调用存储 init()", false, "未返回 Promise（存储层可能未正确加载）");
      return;
    }

    initResult.then(function (res) {
      readConfiguredDir();
      renderStatus(S.status());
      renderDiag(S.status());

      var data = res.data;
      if (data && Object.prototype.toString.call(data.nodes) === "[object Array]") {
        state.nodes = data.nodes;
        state.activeId = data.activeId || null;
        state.expanded = data.expanded || {};
        state.view = data.view || "split";
      } else if (res.firstRun && S.status().persistent) {
        // 只有「确实没有任何数据」时才放示例笔记；读成空数组绝不重新初始化，
        // 否则用户删空笔记后每次打开都会把示例塞回来。
        // 存储不可持久化时也不放：否则会塞进一批根本存不下的假数据，掩盖真实故障。
        seed();
      }
      state.loaded = true;
      if (!S.status().persistent) {
        toast("存储未就绪，笔记不会落盘。请看页顶诊断条。", "warn");
      }

      if (state.activeId && !byId(state.activeId)) { state.activeId = null; }
      if (!state.activeId) {
        var firsts = state.nodes.filter(function (n) { return n.type === "note"; });
        if (firsts.length) { state.activeId = firsts[0].id; }
      }

      setView(state.view);
      handleHostContext();
      render();
      renderDiag(S.status());
      // 立即写一次，用于验证后端真的可写；失败会在状态栏/诊断条显示
      persist(false);
    }).catch(function (e) {
      S.log("存储 init() 收尾异常", false, (e && e.message) || String(e));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
    });
  }

  /* ---------------- 启动 ----------------
   * 立即启动，不等 dbxPlugin.ready。
   * 旧写法是 `dbxPlugin.ready.then(boot)`：一旦 ready 因为任何原因不 resolve，
   * 整个 UI 永远停在初始状态（按钮全死、状态永远 unknown），而且没有任何报错。
   * storage.js 内部自己会 await ready（带 8 秒超时兜底），外层不需要再等一次。
   */
  var booted = false;
  function bootOnce(why) {
    if (booted) { return; }
    booted = true;
    S.log("触发 boot", null, why);
    try {
      boot();
    } catch (e) {
      S.log("boot 抛出异常", false, (e && e.message) || String(e));
      try { renderDiag(S.status()); } catch (e2) { /* ignore */ }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { bootOnce("DOMContentLoaded"); });
  } else {
    bootOnce("脚本执行时 DOM 已就绪（readyState=" + document.readyState + "）");
  }
  // 兜底：万一 DOMContentLoaded 没触发（历史事故里出现过界面完全不动的情况），3 秒后强制启动一次
  setTimeout(function () { bootOnce("兜底计时器 3s"); }, 3000);
})();
