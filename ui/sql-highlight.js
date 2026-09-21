/*
 * SQL 语法高亮（无外部依赖）
 * 暴露：window.MDNotes.highlightSQL(sql) -> HTML 字符串（已转义）
 * 覆盖：行注释 -- 、块注释 /* *\/ 、字符串 '...' 与 "..." 与 `...`、
 *       数字、关键字（通用 SQL + DBX 数据库场景常见词）、操作符。
 */
(function () {
  "use strict";

  var KEYWORDS = ("select from where insert into values update set delete merge create table view "
    + "index drop alter add column primary key foreign references constraint unique check "
    + "join inner left right full outer cross on using natural group by order having "
    + "limit offset fetch first rows only top union all except intersect distinct as "
    + "case when then else end and or not xor null is in like between exists any some "
    + "with recursive cte comment schema database catalog if explain describe show grant revoke "
    + "begin commit rollback transaction savepoint set session cast convert type array json xml "
    + "true false unknown default current_date current_time current_timestamp now getdate "
    + "count sum avg min max coalesce nullif row_number rank dense_rank lead lag "
    + "partition over window filter asc desc returning returning").toUpperCase().split(/\s+/);

  var KW = {};
  for (var k = 0; k < KEYWORDS.length; k++) { KW[KEYWORDS[k]] = true; }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlight(sql) {
    if (typeof sql !== "string") { return ""; }
    var out = [];
    var i = 0, n = sql.length;

    function push(cls, text) {
      out.push(cls ? '<span class="' + cls + '">' + esc(text) + "</span>" : esc(text));
    }

    while (i < n) {
      var c = sql[i];

      // 行注释
      if (c === "-" && sql[i + 1] === "-") {
        var j = sql.indexOf("\n", i); if (j < 0) { j = n; }
        push("tok-com", sql.slice(i, j)); i = j; continue;
      }
      // 块注释
      if (c === "/" && sql[i + 1] === "*") {
        var e = sql.indexOf("*/", i + 2); e = (e < 0 ? n : e + 2);
        push("tok-com", sql.slice(i, e)); i = e; continue;
      }
      // 单引号字符串（支持 '' 转义）
      if (c === "'") {
        var k1 = i + 1;
        while (k1 < n) {
          if (sql[k1] === "'") { if (sql[k1 + 1] === "'") { k1 += 2; continue; } break; }
          k1++;
        }
        var end1 = (k1 < n) ? k1 + 1 : n;
        push("tok-str", sql.slice(i, end1)); i = end1; continue;
      }
      // 双引号 / 反引号 标识符或字符串
      if (c === '"' || c === "`") {
        var q = c, m = i + 1;
        while (m < n && sql[m] !== q) { m++; }
        var e2 = (m < n) ? m + 1 : n;
        push("tok-id", sql.slice(i, e2)); i = e2; continue;
      }
      // 数字
      if (c >= "0" && c <= "9") {
        var p = i; while (p < n && /[0-9.]/.test(sql[p])) { p++; }
        push("tok-num", sql.slice(i, p)); i = p; continue;
      }
      // 单词（关键字 / 标识符）
      if (/[A-Za-z_]/.test(c)) {
        var w = i; while (w < n && /[A-Za-z0-9_]/.test(sql[w])) { w++; }
        var word = sql.slice(i, w);
        if (KW[word.toUpperCase()]) { push("tok-kw", word); }
        else { push("tok-id", word); }
        i = w; continue;
      }
      // 操作符 / 标点
      if ("=<>+-*/%.,();:".indexOf(c) >= 0) {
        push("tok-op", c); i++; continue;
      }
      // 其它（空白等）
      push(null, c); i++;
    }
    return out.join("");
  }

  window.MDNotes = window.MDNotes || {};
  window.MDNotes.highlightSQL = highlight;
})();
