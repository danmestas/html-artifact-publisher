package main

import (
	"math/rand/v2"
	"regexp"
	"strings"
	"testing"
)

// The hand-written PRAGMA matchers in classify.go must agree with the regexps they
// replace, on hand-picked and random inputs.
var oraclePragma = regexp.MustCompile(`(?is)^\s*PRAGMA\s+(?:\w+\.)?(\w+)\s*(?:=\s*([^;]*?)|\(\s*([^)]*?)\s*\))?\s*;?\s*$`)
var oracleEmbedded = regexp.MustCompile(`(?mi)^[ \t]*PRAGMA[^;]*;`)

func oracleSplit(script string) ([]string, string) {
	var p []string
	for _, m := range oracleEmbedded.FindAllString(script, -1) {
		p = append(p, strings.TrimSuffix(strings.TrimSpace(m), ";"))
	}
	if len(p) == 0 {
		return nil, script
	}
	return p, oracleEmbedded.ReplaceAllString(script, "")
}

func TestOracle(t *testing.T) {
	cases := []string{"PRAGMA user_version", "pragma main.user_version = 3;", " PRAGMA x(1) ; ", "PRAGMA x.", "PRAGMA x.y(a b)",
		"PRAGMA a = b;c", "PRAGMA a=;", "PRAGMA", "PRAGMAx", "PRAGMA\tfoo\n", "PRAGMA a(b", "PRAGMA a ( b ) ;;", "PRAGMA a = 1 ;  ",
		"CREATE TABLE t(x);\nPRAGMA application_id=1;\n  PRAGMA user_version = 2;\nINSERT INTO t VALUES(1);", "x PRAGMA a;\n\tpragma b\n c;d"}
	alpha := []string{"PRAGMA", "pragma", " ", "\t", "\n", ";", "=", "(", ")", ".", "a", "b1", "_", "x;y", "\r"}
	r := rand.New(rand.NewPCG(1, 2))
	for i := 0; i < 200000; i++ {
		var b strings.Builder
		for n := r.IntN(10); n >= 0; n-- {
			b.WriteString(alpha[r.IntN(len(alpha))])
		}
		cases = append(cases, b.String())
	}
	for _, q := range cases {
		m := oraclePragma.FindStringSubmatch(q)
		name, value, ok := parsePragma(q)
		if ok != (m != nil) || ok && (name != m[1] || value != strings.TrimSpace(m[2]+m[3])) {
			t.Fatalf("parsePragma(%q) = %q %q %v, regexp %q", q, name, value, ok, m)
		}
		p1, r1 := splitPragmas(q)
		p2, r2 := oracleSplit(q)
		if strings.Join(p1, "\x00") != strings.Join(p2, "\x00") || r1 != r2 || len(p1) != len(p2) {
			t.Fatalf("splitPragmas(%q) = %q %q, regexp %q %q", q, p1, r1, p2, r2)
		}
	}
}
