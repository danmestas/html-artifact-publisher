package main

import "strings"

// A Durable Object's SQLite refuses some statements go-libfossil issues:
// transaction control (the whole request already runs in one
// transactionSync), and most PRAGMAs (SQLITE_AUTH). classify decides what
// the driver does with each statement instead of sending it.
type action int

const (
	forward    action = iota // send to the Durable Object as written
	skip                     // succeed without doing anything
	abort                    // a rollback: fail the whole request so it is undone
	checkpoint               // PRAGMA wal_checkpoint: answer one row of zeros
	pragmaGet                // PRAGMA name: read the emulated value
	pragmaSet                // PRAGMA name = value: store the emulated value
)

type plan struct {
	action action
	name   string // pragma name, lower case
	value  string // pragma value for pragmaSet
}

// Pragmas that only tune SQLite's own file handling, meaningless here.
var tuningPragmas = map[string]bool{
	"journal_mode": true, "locking_mode": true, "busy_timeout": true, "synchronous": true,
	"foreign_keys": true, "cache_size": true, "temp_store": true, "mmap_size": true,
}

// Pragmas whose values go-libfossil stores and reads back.
var storedPragmas = map[string]bool{"application_id": true, "user_version": true}

func classify(q string) plan {
	fields := strings.Fields(strings.ToUpper(q))
	if len(fields) == 0 {
		return plan{action: forward}
	}
	switch fields[0] {
	case "BEGIN", "COMMIT", "END", "SAVEPOINT", "RELEASE", "VACUUM":
		return plan{action: skip}
	case "ROLLBACK":
		return plan{action: abort}
	case "PRAGMA":
		return classifyPragma(q)
	}
	return plan{action: forward}
}

func classifyPragma(q string) plan {
	name, value, ok := parsePragma(q)
	if !ok {
		return plan{action: forward}
	}
	name = strings.ToLower(name)
	value = strings.TrimSpace(value)
	switch {
	case name == "wal_checkpoint":
		return plan{action: checkpoint, name: name}
	case tuningPragmas[name]:
		return plan{action: skip, name: name}
	case storedPragmas[name] && value != "":
		return plan{action: pragmaSet, name: name, value: value}
	case storedPragmas[name]:
		return plan{action: pragmaGet, name: name}
	}
	return plan{action: forward, name: name}
}

// splitPragmas pulls whole-line PRAGMA statements out of a multi-statement
// script (go-libfossil's schema embeds one), so they can be emulated while
// the rest of the script runs as one statement.
func splitPragmas(script string) (pragmas []string, rest string) {
	var b strings.Builder
	kept := 0 // script[kept:] not yet copied to b
	for line := 0; line < len(script); {
		end, ok := pragmaAt(script, line)
		if ok {
			pragmas = append(pragmas, strings.TrimSuffix(strings.TrimSpace(script[line:end]), ";"))
			b.WriteString(script[kept:line])
			kept = end
		}
		next := strings.IndexByte(script[line:], '\n')
		if ok {
			next = strings.IndexByte(script[end:], '\n')
			if next < 0 {
				break
			}
			line = end + next + 1
			continue
		}
		if next < 0 {
			break
		}
		line += next + 1
	}
	if len(pragmas) == 0 {
		return nil, script
	}
	b.WriteString(script[kept:])
	return pragmas, b.String()
}

// The hand-written matchers below replace two regular expressions, so the
// engine does not link package regexp:
//
//	(?is)^\s*PRAGMA\s+(?:\w+\.)?(\w+)\s*(?:=\s*([^;]*?)|\(\s*([^)]*?)\s*\))?\s*;?\s*$
//	(?mi)^[ \t]*PRAGMA[^;]*;

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\f' || c == '\r' }

func isWord(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c == '_'
}

func trimSpace(s string) string {
	for len(s) > 0 && isSpace(s[0]) {
		s = s[1:]
	}
	for len(s) > 0 && isSpace(s[len(s)-1]) {
		s = s[:len(s)-1]
	}
	return s
}

func word(s string) (w, rest string) {
	i := 0
	for i < len(s) && isWord(s[i]) {
		i++
	}
	return s[:i], s[i:]
}

// tailOK reports whether s is only spaces with at most one semicolon.
func tailOK(s string) bool {
	s = trimSpace(s)
	return s == "" || s == ";" || (s[0] == ';' && trimSpace(s[1:]) == "")
}

// parsePragma matches the first expression: name is its group 1, value its
// group 2 or 3.
func parsePragma(q string) (name, value string, ok bool) {
	s := q
	for len(s) > 0 && isSpace(s[0]) {
		s = s[1:]
	}
	if len(s) < 7 || !strings.EqualFold(s[:6], "PRAGMA") || !isSpace(s[6]) {
		return "", "", false
	}
	s = trimSpace(s[6:]) + " "
	name, s = word(s)
	if name == "" {
		return "", "", false
	}
	if s[0] == '.' {
		if n2, r2 := word(s[1:]); n2 != "" {
			name, s = n2, r2
		}
	}
	for len(s) > 0 && isSpace(s[0]) {
		s = s[1:]
	}
	switch {
	case strings.HasPrefix(s, "="):
		v := trimSpace(s[1:])
		v = trimSpace(strings.TrimSuffix(v, ";"))
		if strings.IndexByte(v, ';') >= 0 {
			return "", "", false
		}
		return name, v, true
	case strings.HasPrefix(s, "("):
		end := strings.IndexByte(s, ')')
		if end < 0 || !tailOK(s[end+1:]) {
			return "", "", false
		}
		return name, trimSpace(s[1:end]), true
	}
	return name, "", tailOK(s)
}

// pragmaAt matches the second expression at the line starting at i: the
// match is script[i:end].
func pragmaAt(script string, i int) (end int, ok bool) {
	j := i
	for j < len(script) && (script[j] == ' ' || script[j] == '\t') {
		j++
	}
	if len(script)-j < 6 || !strings.EqualFold(script[j:j+6], "PRAGMA") {
		return 0, false
	}
	semi := strings.IndexByte(script[j+6:], ';')
	if semi < 0 {
		return 0, false
	}
	return j + 6 + semi + 1, true
}
