/*
 * 轻量 Markdown 渲染器（无外部依赖，纯前端）
 * 暴露：window.MDNotes.renderMarkdown(src) -> HTML 字符串
 * 支持：标题、加粗/斜体/删除线、行内代码、代码块（```sql 走 SQL 高亮）、
 *       无序/有序列表（含一层嵌套）、引用、表格、分隔线、链接、段落。
 * 安全：文本先转义 HTML，仅输出受控标签；链接仅允许 http/https/#/mailto。
 */
(function () {
  "use strict";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(text) {
    var codes = [];
    text = esc(text);
    text = text.replace(/`([^`]+)`/g, function (_, c) {
      codes.push(c);
      return "@@C" + (codes.length - 1) + "@@";
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, t, u) {
      if (/^(https?:\/\/|\/|#|mailto:)/i.test(u)) {
        return '<a href="' + u + '" target="_blank" rel="noopener">' + t + "</a>";
      }
      return t;
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    text = text.replace(/(^|[^a-zA-Z0-9_])_([^_]+)_([^a-zA-Z0-9_]|$)/g, "$1<em>$2</em>$3");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    text = text.replace(/@@C(\d+)@@/g, function (_, idx) {
      return "<code>" + codes[+idx] + "</code>";
    });
    return text;
  }

  function splitRow(s) {
    s = s.trim();
    if (s.charAt(0) === "|") { s = s.slice(1); }
    if (s.charAt(s.length - 1) === "|") { s = s.slice(0, -1); }
    return s.split("|").map(function (x) { return x.trim(); });
  }

  function isTableSep(s) {
    if (s.indexOf("|") < 0 || s.indexOf("-") < 0) { return false; }
    var t = s.trim();
    if (t.charAt(0) === "|") { t = t.slice(1); }
    if (t.charAt(t.length - 1) === "|") { t = t.slice(0, -1); }
    for (var x = 0; x < t.length; x++) {
      var ch = t.charAt(x);
      if (ch !== " " && ch !== ":" && ch !== "-" && ch !== "|") { return false; }
    }
    return true;
  }

  function listInfo(line) {
    var i = 0;
    while (i < line.length && line.charAt(i) === " ") { i++; }
    var rest = line.slice(i);
    if (rest.length === 0) { return null; }
    var c0 = rest.charAt(0);
    if (c0 === "-" || c0 === "*" || c0 === "+") {
      if (rest.charAt(1) === " ") { return { indent: i, ordered: false, content: rest.slice(2) }; }
      return null;
    }
    var d = 0;
    while (d < rest.length && rest.charAt(d) >= "0" && rest.charAt(d) <= "9") { d++; }
    if (d > 0 && rest.charAt(d) === "." && rest.charAt(d + 1) === " ") {
      return { indent: i, ordered: true, content: rest.slice(d + 2) };
    }
    return null;
  }

  function parseList(lines, i, indent) {
    var type = null;
    var out = "";
    while (i < lines.length) {
      var info = listInfo(lines[i]);
      if (!info || info.indent !== indent) { break; }
      if (type === null) { type = info.ordered ? "ol" : "ul"; }
      var content = info.content;
      i++;
      var child = "";
      if (i < lines.length) {
        var nxt = listInfo(lines[i]);
        if (nxt && nxt.indent > indent) {
          var sub = parseList(lines, i, nxt.indent);
          child = sub.html;
          i = sub.next;
        }
      }
      out += "<li>" + inline(content) + child + "</li>";
    }
    if (type === null) { type = "ul"; }
    return { html: "<" + type + ">" + out + "</" + type + ">", next: i };
  }

  function isFence(s) { return s.trim().indexOf("```") === 0; }
  function isCloseFence(s) { return s.trim() === "```"; }
  function fenceLang(s) { return s.trim().slice(3).trim(); }
  function isHeading(s) { return /^(#+)\s/.test(s); }
  function isHr(s) { var t = s.trim(); return t === "---" || t === "***" || t === "___"; }
  function isBlockquote(s) { return s.trim().charAt(0) === ">"; }
  function isBlank(s) { return s.trim() === ""; }

  function renderMarkdown(src) {
    if (typeof src !== "string") { src = ""; }
    src = src.replace(/\r\n?/g, "\n");
    var lines = src.split("\n");
    var html = [];
    var i = 0;
    var n = lines.length;
    while (i < n) {
      var line = lines[i];

      if (isFence(line)) {
        var lang = fenceLang(line).toLowerCase();
        var buf = [];
        i++;
        while (i < n && !isCloseFence(lines[i])) { buf.push(lines[i]); i++; }
        if (i < n) { i++; }
        var code = buf.join("\n");
        var inner = (lang && lang.indexOf("sql") === 0)
          ? window.MDNotes.highlightSQL(code)
          : esc(code);
        html.push('<pre class="md-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : "") + '><code>' + inner + "</code></pre>");
        continue;
      }
      if (isBlank(line)) { i++; continue; }

      var hm = line.match(/^(#+)\s/);
      if (hm) {
        var lvl = Math.min(hm[1].length, 6);
        var rest = line.slice(hm[1].length).trim();
        html.push("<h" + lvl + ">" + inline(rest) + "</h" + lvl + ">");
        i++; continue;
      }
      if (isHr(line)) { html.push("<hr>"); i++; continue; }

      if (isBlockquote(line)) {
        var qb = [];
        while (i < n && isBlockquote(lines[i])) {
          var q = lines[i];
          if (q.charAt(0) === ">") { q = q.slice(1); }
          if (q.charAt(0) === " ") { q = q.slice(1); }
          qb.push(q);
          i++;
        }
        html.push("<blockquote>" + renderMarkdown(qb.join("\n")) + "</blockquote>");
        continue;
      }

      if (line.indexOf("|") >= 0 && i + 1 < n && isTableSep(lines[i + 1])) {
        var header = splitRow(line);
        i += 2;
        var rows = [];
        while (i < n && lines[i].indexOf("|") >= 0 && !isBlank(lines[i])) {
          rows.push(splitRow(lines[i])); i++;
        }
        var t = "<table><thead><tr>" +
          header.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") +
          "</tr></thead><tbody>";
        rows.forEach(function (r) {
          t += "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>";
        });
        t += "</tbody></table>";
        html.push(t);
        continue;
      }

      var info = listInfo(line);
      if (info) {
        var res = parseList(lines, i, info.indent);
        html.push(res.html);
        i = res.next;
        continue;
      }

      var para = [];
      while (i < n) {
        var l = lines[i];
        if (isBlank(l) || isFence(l) || isBlockquote(l) || listInfo(l) || isHeading(l)) { break; }
        para.push(l); i++;
      }
      if (para.length) {
        html.push("<p>" + inline(para.join("<br>")) + "</p>");
      } else {
        i++;
      }
    }
    return html.join("\n");
  }

  window.MDNotes = window.MDNotes || {};
  window.MDNotes.renderMarkdown = renderMarkdown;
})();
