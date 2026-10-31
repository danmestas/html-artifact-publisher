//go:build js

package main

// dosql: a database/sql driver over a SQLite-backed Durable Object's
// ctx.storage.sql. JS installs globalThis.__dosql(sql, params) ->
// {cols, rows, id, n}, bound to the object handling the current call; every
// call is synchronous. Each request runs inside one transactionSync, so this
// driver's own transactions are no-ops; a rollback marks the request
// aborted, and JS throws to undo it (src/fossil.ts).

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"math"
	"runtime"
	"strings"
	"syscall/js"
	"time"
)

// aborted is set when go-libfossil rolls back; the request must not commit.
var aborted string

func init() { sql.Register("dosql", drv{}) }

type drv struct{}

func (drv) Open(string) (driver.Conn, error) { return conn{}, nil }

type conn struct{}

func (conn) Prepare(q string) (driver.Stmt, error) { return stmt{q}, nil }
func (conn) Close() error                          { return nil }
func (conn) Begin() (driver.Tx, error)             { return tx{}, nil }

func (conn) Exec(q string, args []driver.Value) (driver.Result, error) {
	r, err := run(q, args)
	if err != nil {
		return nil, err
	}
	return result{r.id, r.n}, nil
}

func (conn) Query(q string, args []driver.Value) (driver.Rows, error) {
	r, err := run(q, args)
	if err != nil {
		return nil, err
	}
	return &rows{res: r}, nil
}

// BeginTx gives a read-only transaction its own Tx. go-libfossil serves a
// request that cannot write, a clone among them, in a read transaction and
// always ends it with Rollback; that rollback undoes nothing, so it must not
// abort the request the way a write transaction's rollback does.
func (conn) BeginTx(_ context.Context, o driver.TxOptions) (driver.Tx, error) {
	if o.ReadOnly {
		return readTx{}, nil
	}
	return tx{}, nil
}

type readTx struct{}

func (readTx) Commit() error   { return nil }
func (readTx) Rollback() error { return nil }

type tx struct{}

func (tx) Commit() error { return nil }
func (tx) Rollback() error {
	markAborted("transaction rolled back")
	return nil
}

func markAborted(why string) {
	if aborted == "" {
		aborted = why
	}
}

type stmt struct{ q string }

func (s stmt) Close() error                                    { return nil }
func (s stmt) NumInput() int                                   { return -1 }
func (s stmt) Exec(args []driver.Value) (driver.Result, error) { return conn{}.Exec(s.q, args) }
func (s stmt) Query(args []driver.Value) (driver.Rows, error)  { return conn{}.Query(s.q, args) }

type result struct{ id, n int64 }

func (r result) LastInsertId() (int64, error) { return r.id, nil }
func (r result) RowsAffected() (int64, error) { return r.n, nil }

type res struct {
	cols []string
	rows [][]driver.Value
	id   int64
	n    int64
}

type rows struct {
	res *res
	i   int
}

func (r *rows) Columns() []string { return r.res.cols }
func (r *rows) Close() error      { return nil }
func (r *rows) Next(dest []driver.Value) error {
	if r.i >= len(r.res.rows) {
		return io.EOF
	}
	copy(dest, r.res.rows[r.i])
	r.i++
	return nil
}

func run(q string, args []driver.Value) (*res, error) {
	p := classify(q)
	switch p.action {
	case skip:
		return &res{}, nil
	case abort:
		markAborted(strings.TrimSpace(q))
		return &res{}, nil
	case checkpoint:
		return &res{cols: []string{"busy", "log", "checkpointed"}, rows: [][]driver.Value{{int64(0), int64(0), int64(0)}}}, nil
	case pragmaSet:
		if _, err := exec(`CREATE TABLE IF NOT EXISTS _dosql_pragma(k TEXT PRIMARY KEY, v INTEGER)`, nil); err != nil {
			return nil, err
		}
		return exec(`INSERT OR REPLACE INTO _dosql_pragma VALUES (?, CAST(? AS INTEGER))`, []driver.Value{p.name, p.value})
	case pragmaGet:
		r, err := exec(`SELECT v FROM _dosql_pragma WHERE k = ?`, []driver.Value{p.name})
		if err != nil || len(r.rows) == 0 {
			r = &res{rows: [][]driver.Value{{int64(0)}}}
		}
		r.cols = []string{p.name}
		return r, nil
	}
	if len(args) == 0 {
		pragmas, rest := splitPragmas(q)
		for _, pq := range pragmas {
			if _, err := run(pq, nil); err != nil {
				return nil, err
			}
		}
		q = rest
	}
	return exec(q, args)
}

var (
	bridge     js.Value
	uint8Array = js.Global().Get("Uint8Array")
	arrayBuf   = js.Global().Get("ArrayBuffer")
)

func exec(q string, args []driver.Value) (out *res, err error) {
	// database/sql cancels row/transaction cleanup goroutines between queries;
	// a cooperative scheduler must run them before their stacks accumulate. The
	// TinyGo engine has no scheduler and no such goroutines (goroot.patch), so
	// this only matters for GO_COMPILER=go.
	runtime.Gosched()
	if bridge.Type() != js.TypeFunction {
		bridge = js.Global().Get("__dosql")
	}
	params := make([]any, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case []byte:
			u := uint8Array.New(len(v))
			js.CopyBytesToJS(u, v)
			params[i] = u
		case bool:
			params[i] = 0
			if v {
				params[i] = 1
			}
		case time.Time:
			params[i] = v.UTC().Format("2006-01-02 15:04:05.000")
		default:
			params[i] = v // int64, float64, string, nil
		}
	}
	r, jsErr := invoke(q, params)
	if strings.Contains(jsErr, "SQLITE_TOOBIG") {
		// Name the cause before go-libfossil's rollback replaces it with "ROLLBACK TO …".
		markAborted(fmt.Sprintf("a file is too large to store: compressed, each must be under %d bytes", maxStored))
	}
	if jsErr != "" {
		return nil, fmt.Errorf("dosql: %s [%s]", jsErr, short(q))
	}
	out = &res{id: int64(r.Get("id").Float()), n: int64(r.Get("n").Float())}
	cols := r.Get("cols")
	for i := 0; i < cols.Length(); i++ {
		out.cols = append(out.cols, cols.Index(i).String())
	}
	jrows := r.Get("rows")
	for i := 0; i < jrows.Length(); i++ {
		jr := jrows.Index(i)
		row := make([]driver.Value, jr.Length())
		for j := range row {
			row[j] = fromJS(jr.Index(j))
		}
		out.rows = append(out.rows, row)
	}
	return out, nil
}

// invoke calls the bridge; it reports a thrown JS error as a string, since
// the JS side returns {error} rather than throwing across the boundary.
func invoke(q string, params []any) (js.Value, string) {
	r := bridge.Invoke(q, js.ValueOf(params))
	if e := r.Get("error"); e.Type() == js.TypeString {
		return r, e.String()
	}
	return r, ""
}

func fromJS(v js.Value) driver.Value {
	switch v.Type() {
	case js.TypeNull, js.TypeUndefined:
		return nil
	case js.TypeNumber:
		// JS has one number type; integral values come back as INTEGER.
		f := v.Float()
		if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
			return int64(f)
		}
		return f
	case js.TypeString:
		return v.String()
	case js.TypeObject:
		if v.InstanceOf(arrayBuf) {
			v = uint8Array.New(v)
		}
		b := make([]byte, v.Get("length").Int())
		js.CopyBytesToGo(b, v)
		return b
	}
	return nil
}

func short(q string) string {
	q = strings.Join(strings.Fields(q), " ")
	if len(q) > 120 {
		return q[:120] + "…"
	}
	return q
}
