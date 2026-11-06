package main

// SQLite 索引层（v3 存储模型）
//
// 之前：结构/索引 = .mdnotes/meta.json（单个 JSON 文件，整存整取）。
// 现在：结构/索引 = .mdnotes/notes.db（SQLite）；笔记正文仍是磁盘上真实的 .md 文件。
//
// 为什么换：
//   - 多个插件实例共用同一存储目录时，JSON 整存整取没有并发控制，旧实例一保存就把
//     别人的改动整片盖掉（2026-09-21 事故）。SQLite 事务 + 全局 rev 的 CAS 能挡住。
//   - 每个节点带 version / state / rev，编辑时能明确知道「谁在什么时候改过哪条」。
//
// 关键取舍：
//   - 只把索引元数据入库，正文不入库（仍是真实 .md 文件，保留外部编辑器 / mdnotes:// / grep）。
//   - 保留 Meta / MetaNode 内存结构，只替换 loadMeta / saveMeta 的持久化后端，
//     这样 saveNotes / reconcile / 虚拟文件系统等调用点几乎不用动。
//   - meta.json 迁移后仍保留在磁盘上（回退用），但运行时不再读它。
//   - 备份包里放的是可移植的 JSON 快照（.mdnotes/index.json），不是 .db 二进制。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	_ "modernc.org/sqlite" // 纯 Go SQLite：CGO_ENABLED=0 可交叉编译到全部平台
)

const storeSchema = 1

// dbPath 是索引数据库文件位置（与旧 meta.json 同目录）。
func dbPath() string { return filepath.Join(metaDir(), "notes.db") }

// legacyMetaPath 是旧版索引文件（只读，用于一次性迁移）。
func legacyMetaPath() string { return filepath.Join(metaDir(), "meta.json") }

// conflictInfo 描述一次被 CAS 拦下的保存。
type conflictInfo struct {
	CurrentRev int64
	BaseRev    int64
	Changed    []map[string]any // 自 BaseRev 以来被改动的节点
}

// nodeRow 是 nodes 表在内存里的投影。
type nodeRow struct {
	id, typ, name, parentID, file, createdAt, updatedAt, state string
	version, rev                                               int64
}

func openNotesDB() (*sql.DB, error) {
	if err := os.MkdirAll(metaDir(), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbPath())
	if err != nil {
		return nil, err
	}
	// 单进程内串行，避免 database/sql 开多个连接各自持锁导致自锁。
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	for _, pragma := range []string{
		"PRAGMA busy_timeout=8000",
		"PRAGMA journal_mode=WAL",
		"PRAGMA foreign_keys=OFF",
	} {
		if _, e := db.Exec(pragma); e != nil {
			_ = db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, e)
		}
	}
	return db, nil
}

var schemaStatements = []string{
	`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
	`CREATE TABLE IF NOT EXISTS nodes (
		id         TEXT PRIMARY KEY,
		type       TEXT NOT NULL,
		name       TEXT NOT NULL,
		parent_id  TEXT,
		file       TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT '',
		version    INTEGER NOT NULL DEFAULT 1,
		state      TEXT NOT NULL DEFAULT 'active',
		rev        INTEGER NOT NULL DEFAULT 1
	)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file)`,
	`CREATE INDEX IF NOT EXISTS idx_nodes_rev ON nodes(rev)`,
}

// ensureSchema 建表，并在首次开库时把旧 meta.json 一次性导入。
// 用 meta 表里的 'schema' 键做幂等标记，迁移过的库不会重复导入。
func ensureSchema(db *sql.DB) error {
	for _, stmt := range schemaStatements {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	var v string
	err := db.QueryRow(`SELECT v FROM meta WHERE k='schema'`).Scan(&v)
	if err == nil {
		return nil // 已初始化
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	// 旧格式迁移：meta.json 存在就全量导入，节点 version=1 / state='migrated'。
	// 不存在则是全新库（或 notes.json 老迁移路径），空库起步即可。
	imported := 0
	if b, e := os.ReadFile(legacyMetaPath()); e == nil {
		var old Meta
		if json.Unmarshal(b, &old) == nil {
			for _, n := range old.Nodes {
				var pid any
				if n.ParentID != nil {
					pid = *n.ParentID
				}
				if _, e2 := tx.Exec(`INSERT OR IGNORE INTO nodes
					(id,type,name,parent_id,file,created_at,updated_at,version,state,rev)
					VALUES(?,?,?,?,?,?,?,1,'migrated',1)`,
					n.ID, n.Type, n.Name, pid, n.File, n.CreatedAt, n.UpdatedAt); e2 != nil {
					return e2
				}
				imported++
			}
			ver := old.Version
			if ver == 0 {
				ver = 2
			}
			if err := putMetaTx(tx, "version", strconv.Itoa(ver)); err != nil {
				return err
			}
			if err := putMetaTx(tx, "activeId", old.ActiveID); err != nil {
				return err
			}
			if err := putMetaTx(tx, "view", old.View); err != nil {
				return err
			}
			if b2, e3 := json.Marshal(old.Expanded); e3 == nil {
				if err := putMetaTx(tx, "expanded", string(b2)); err != nil {
					return err
				}
			}
		}
	}
	if err := putMetaTx(tx, "schema", strconv.Itoa(storeSchema)); err != nil {
		return err
	}
	if err := putMetaTx(tx, "rev", "1"); err != nil {
		return err
	}
	// 从旧 meta.json 迁进来的节点本身就是「已有数据」，打上标记，
	// 免得首次运行判定把迁移后的空节点集当成全新目录。
	if imported > 0 {
		if err := putMetaTx(tx, "initialized", "1"); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if imported > 0 {
		sidecarTrace(fmt.Sprintf("SQLite 迁移完成：从 meta.json 导入 %d 个节点 dir=%s", imported, notesDir()))
	}
	return nil
}

func putMetaTx(tx *sql.Tx, k, v string) error {
	_, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?)
		ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v)
	return err
}

func putMetaConn(conn *sql.Conn, ctx context.Context, k, v string) error {
	_, err := conn.ExecContext(ctx, `INSERT INTO meta(k,v) VALUES(?,?)
		ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v)
	return err
}

// metaExists 判定「索引文件是否已经在磁盘上」。DB 或旧 meta.json 任一存在即算，
// 用于 notes.json 老迁移路径、恢复前的安全快照等「文件级」判断。
func metaExists() bool {
	if _, err := os.Stat(dbPath()); err == nil {
		return true
	}
	_, err := os.Stat(legacyMetaPath())
	return err == nil
}

// storeHasData 判定「这个存储目录是否曾经真正有过索引数据」，供首次运行的
// 示例笔记判定使用。
//
// 不能复用 metaExists()：SQLite 版的 loadMeta() 会顺手建一个空库，光是
// notes/ping、notes/probe、notes/backup 就能让 notes.db 出现在磁盘上，
// 于是首次运行会被误判成「已有数据」，前端不再放示例笔记（0.8.13 前的回归点）。
// 判据改为：旧 meta.json 存在，或库里 meta.initialized=1 —— 后者只在
// writeTx.commit 真正写过索引时才置位，删空笔记后依然为 1，不会反复塞示例。
func storeHasData() bool {
	if _, err := os.Stat(legacyMetaPath()); err == nil {
		return true
	}
	if _, err := os.Stat(dbPath()); err != nil {
		return false
	}
	db, err := openNotesDB()
	if err != nil {
		return true // 库打不开时保守当作「已有数据」，绝不擅自塞示例覆盖现场
	}
	defer db.Close()
	if err := ensureSchema(db); err != nil {
		return true
	}
	var v string
	if err := db.QueryRow(`SELECT v FROM meta WHERE k='initialized'`).Scan(&v); err != nil {
		return false
	}
	return v == "1"
}

// loadMeta 从 SQLite 读出完整索引（含全局 rev 与每节点 version/state）。
func loadMeta() Meta {
	m := Meta{Version: 2, Nodes: []MetaNode{}, Rev: 1}
	db, err := openNotesDB()
	if err != nil {
		sidecarTrace(fmt.Sprintf("SQLite 打开失败 dir=%s err=%v", notesDir(), err))
		return m
	}
	defer db.Close()
	if err := ensureSchema(db); err != nil {
		sidecarTrace(fmt.Sprintf("SQLite 初始化失败 dir=%s err=%v", notesDir(), err))
		return m
	}

	rows, err := db.Query(`SELECT k,v FROM meta`)
	if err == nil {
		for rows.Next() {
			var k, v string
			if rows.Scan(&k, &v) != nil {
				continue
			}
			switch k {
			case "rev":
				if n, e := strconv.ParseInt(v, 10, 64); e == nil {
					m.Rev = n
				}
			case "version":
				if n, e := strconv.Atoi(v); e == nil {
					m.Version = n
				}
			case "activeId":
				m.ActiveID = v
			case "view":
				m.View = v
			case "expanded":
				var ex map[string]bool
				if json.Unmarshal([]byte(v), &ex) == nil {
					m.Expanded = ex
				}
			}
		}
		_ = rows.Close()
	}

	// ORDER BY rowid 保持写入顺序稳定（前端目录树顺序 / e2e 断言依赖）。
	nr, err := db.Query(`SELECT id,type,name,parent_id,file,created_at,updated_at,version,state
		FROM nodes ORDER BY rowid`)
	if err != nil {
		return m
	}
	defer nr.Close()
	for nr.Next() {
		var r nodeRow
		var pid sql.NullString
		if nr.Scan(&r.id, &r.typ, &r.name, &pid, &r.file, &r.createdAt,
			&r.updatedAt, &r.version, &r.state) != nil {
			continue
		}
		n := MetaNode{
			ID: r.id, Type: r.typ, Name: r.name, File: r.file,
			CreatedAt: r.createdAt, UpdatedAt: r.updatedAt,
			Version: r.version, State: r.state,
		}
		if pid.Valid {
			s := pid.String
			n.ParentID = &s
		}
		m.Nodes = append(m.Nodes, n)
	}
	return m
}

// saveMeta 无 CAS 的全量同步（reconcile / 虚拟文件系统 / 恢复等内部写入用）。
func saveMeta(m Meta) error {
	t, _, err := beginWriteTx(nil)
	if err != nil {
		return err
	}
	defer t.done()
	_, err = t.commit(m)
	return err
}

// nodeSig 是节点元数据签名，用于判断一条节点是否真的被改动。
// 正文不入库，所以正文变化由调用方通过 Meta.Dirty 显式告知。
func nodeSig(n MetaNode) string {
	pid := ""
	if n.ParentID != nil {
		pid = *n.ParentID
	}
	return strings.Join([]string{n.ID, n.Type, n.Name, pid, n.File, n.CreatedAt, n.UpdatedAt}, "\x1f")
}

// writeTx 持有一个 BEGIN IMMEDIATE 写锁，跨越「写磁盘正文 → 写索引」整个过程。
//
// 为什么必须跨这么长：如果先写盘再做 CAS 检查，冲突被拦下时磁盘上的 .md 已经被
// 旧快照改了，索引却还没变 —— 数据处于半应用状态。持有 SQLite 写锁后，另一个实例
// 会阻塞在 BEGIN IMMEDIATE，直到本次提交后才读到新 rev 并被自己的 CAS 挡住。
type writeTx struct {
	db        *sql.DB
	conn      *sql.Conn
	ctx       context.Context
	newRev    int64
	committed bool
}

func (t *writeTx) done() {
	if !t.committed {
		_, _ = t.conn.ExecContext(t.ctx, "ROLLBACK")
	}
	_ = t.conn.Close()
	_ = t.db.Close()
}

// beginWriteTx 拿写锁并做乐观锁检查。baseRev 非 nil 且与当前 rev 不符时返回冲突，
// 调用方必须立刻停止、不得写盘。
func beginWriteTx(baseRev *int64) (*writeTx, *conflictInfo, error) {
	db, err := openNotesDB()
	if err != nil {
		return nil, nil, err
	}
	if err := ensureSchema(db); err != nil {
		_ = db.Close()
		return nil, nil, err
	}

	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	t := &writeTx{db: db, conn: conn, ctx: ctx}

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		t.done()
		return nil, nil, fmt.Errorf("begin immediate: %w", err)
	}

	var revText string
	if err := conn.QueryRowContext(ctx, `SELECT v FROM meta WHERE k='rev'`).Scan(&revText); err != nil {
		t.done()
		return nil, nil, err
	}
	curRev, err := strconv.ParseInt(revText, 10, 64)
	if err != nil {
		t.done()
		return nil, nil, err
	}

	if baseRev != nil && *baseRev != curRev {
		changed := []map[string]any{}
		cr, qerr := conn.QueryContext(ctx,
			`SELECT id,name,version,state,rev FROM nodes WHERE rev > ? ORDER BY rev`, *baseRev)
		if qerr == nil {
			for cr.Next() {
				var id, name, state string
				var ver, nrev int64
				if cr.Scan(&id, &name, &ver, &state, &nrev) == nil {
					changed = append(changed, map[string]any{
						"id": id, "name": name, "version": ver, "state": state, "rev": nrev,
					})
				}
			}
			_ = cr.Close()
		}
		t.done()
		return nil, &conflictInfo{CurrentRev: curRev, BaseRev: *baseRev, Changed: changed}, nil
	}

	t.newRev = curRev + 1
	return t, nil, nil
}

// commit 把最终节点集全量同步进 DB 并 rev+1，然后释放写锁。
func (t *writeTx) commit(m Meta) (int64, error) {
	ctx := t.ctx
	conn := t.conn
	newRev := t.newRev

	// 现有节点快照
	existing := map[string]nodeRow{}
	sigs := map[string]string{}
	er, err := conn.QueryContext(ctx,
		`SELECT id,type,name,parent_id,file,created_at,updated_at,version,state,rev FROM nodes`)
	if err != nil {
		return 0, err
	}
	for er.Next() {
		var r nodeRow
		var pid sql.NullString
		if er.Scan(&r.id, &r.typ, &r.name, &pid, &r.file, &r.createdAt,
			&r.updatedAt, &r.version, &r.state, &r.rev) != nil {
			continue
		}
		if pid.Valid {
			r.parentID = pid.String
		}
		existing[r.id] = r
		sigs[r.id] = nodeSig(MetaNode{
			ID: r.id, Type: r.typ, Name: r.name, File: r.file,
			CreatedAt: r.createdAt, UpdatedAt: r.updatedAt,
			ParentID: func() *string {
				if r.parentID == "" {
					return nil
				}
				s := r.parentID
				return &s
			}(),
		})
	}
	_ = er.Close()

	want := map[string]bool{}
	for _, n := range m.Nodes {
		if n.ID == "" {
			continue
		}
		want[n.ID] = true
		var pid any
		if n.ParentID != nil {
			pid = *n.ParentID
		}
		old, found := existing[n.ID]
		sig := nodeSig(n)
		dirty := m.Dirty != nil && m.Dirty[n.ID]

		switch {
		case !found:
			// 新建：version=1，state=created
			if _, err := conn.ExecContext(ctx, `INSERT INTO nodes
				(id,type,name,parent_id,file,created_at,updated_at,version,state,rev)
				VALUES(?,?,?,?,?,?,?,1,'created',?)`,
				n.ID, n.Type, n.Name, pid, n.File, n.CreatedAt, n.UpdatedAt, newRev); err != nil {
				return 0, err
			}
		case sigs[n.ID] != sig || dirty:
			// 被编辑：version+1，state=edited
			if _, err := conn.ExecContext(ctx, `UPDATE nodes SET
				type=?,name=?,parent_id=?,file=?,created_at=?,updated_at=?,
				version=?,state='edited',rev=? WHERE id=?`,
				n.Type, n.Name, pid, n.File, n.CreatedAt, n.UpdatedAt,
				old.version+1, newRev, n.ID); err != nil {
				return 0, err
			}
		default:
			// 没变化：version / state / rev 全不动
		}
	}
	// result 是完整最终态：不在里面的节点即被显式删除（saveNotes 已保证
	// 「未知≠要删」的 preserved 节点都在 result 里）。
	for id := range existing {
		if !want[id] {
			if _, err := conn.ExecContext(ctx, `DELETE FROM nodes WHERE id=?`, id); err != nil {
				return 0, err
			}
		}
	}

	ver := m.Version
	if ver == 0 {
		ver = 2
	}
	if err := putMetaConn(conn, ctx, "version", strconv.Itoa(ver)); err != nil {
		return 0, err
	}
	if err := putMetaConn(conn, ctx, "activeId", m.ActiveID); err != nil {
		return 0, err
	}
	if err := putMetaConn(conn, ctx, "view", m.View); err != nil {
		return 0, err
	}
	ex, _ := json.Marshal(m.Expanded)
	if err := putMetaConn(conn, ctx, "expanded", string(ex)); err != nil {
		return 0, err
	}
	if err := putMetaConn(conn, ctx, "rev", strconv.FormatInt(newRev, 10)); err != nil {
		return 0, err
	}
	// 只有真正提交过一次索引才标记为「已有数据」（见 storeHasData 的说明）。
	if err := putMetaConn(conn, ctx, "initialized", "1"); err != nil {
		return 0, err
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return 0, err
	}
	t.committed = true
	return newRev, nil
}

// restoreIndex 把备份包里的 JSON 快照整库灌回 SQLite（跳过 CAS，恢复是权威替换）。
func restoreIndex(m Meta) (int64, error) {
	t, _, err := beginWriteTx(nil)
	if err != nil {
		return 0, err
	}
	defer t.done()
	return t.commit(m)
}
