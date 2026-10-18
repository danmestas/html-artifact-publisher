package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		q    string
		want plan
	}{
		{"SELECT 1", plan{action: forward}},
		{"  begin immediate", plan{action: skip}},
		{"COMMIT", plan{action: skip}},
		{"SAVEPOINT withtx_1", plan{action: skip}},
		{"RELEASE withtx_1", plan{action: skip}},
		{"ROLLBACK TO withtx_1", plan{action: abort}},
		{"ROLLBACK", plan{action: abort}},
		{"PRAGMA wal_checkpoint(TRUNCATE)", plan{action: checkpoint, name: "wal_checkpoint"}},
		{"PRAGMA journal_mode = WAL", plan{action: skip, name: "journal_mode"}},
		{"PRAGMA foreign_keys=OFF;", plan{action: skip, name: "foreign_keys"}},
		{"PRAGMA application_id=252006673;", plan{action: pragmaSet, name: "application_id", value: "252006673"}},
		{"pragma main.application_id", plan{action: pragmaGet, name: "application_id"}},
		{"PRAGMA table_info(blob)", plan{action: forward, name: "table_info"}},
	}
	for _, c := range cases {
		if got := classify(c.q); got != c.want {
			t.Errorf("classify(%q) = %+v, want %+v", c.q, got, c.want)
		}
	}
}

func TestSplitPragmas(t *testing.T) {
	script := "CREATE TABLE a(x);\nPRAGMA application_id=252006673;\nCREATE TABLE b(y);\n"
	pragmas, rest := splitPragmas(script)
	if len(pragmas) != 1 || pragmas[0] != "PRAGMA application_id=252006673" {
		t.Fatalf("pragmas = %q", pragmas)
	}
	if strings.Contains(rest, "PRAGMA") || !strings.Contains(rest, "CREATE TABLE b") {
		t.Fatalf("rest = %q", rest)
	}
	if p, r := splitPragmas("SELECT 1"); p != nil || r != "SELECT 1" {
		t.Fatalf("no-pragma script changed: %q %q", p, r)
	}
}

func TestCheckStorable(t *testing.T) {
	if err := checkStorable("small", []byte("<h1>hi</h1>")); err != nil {
		t.Fatal(err)
	}
	// 3 MB that compresses to almost nothing fits.
	if err := checkStorable("zeros", bytes.Repeat([]byte{0}, 3_000_000)); err != nil {
		t.Fatal(err)
	}
	// 3 MB of noise does not.
	noise := make([]byte, 3_000_000)
	rand.Read(noise)
	var tooLarge errTooLarge
	if err := checkStorable("noise.bin", noise); !errors.As(err, &tooLarge) || tooLarge.name != "noise.bin" {
		t.Fatalf("want errTooLarge, got %v", err)
	}
}
