package main

import (
	"regexp"
	"strings"
)

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

var pragmaRe = regexp.MustCompile(`(?is)^\s*PRAGMA\s+(?:\w+\.)?(\w+)\s*(?:=\s*([^;]*?)|\(\s*([^)]*?)\s*\))?\s*;?\s*$`)

func classifyPragma(q string) plan {
	m := pragmaRe.FindStringSubmatch(q)
	if m == nil {
		return plan{action: forward}
	}
	name := strings.ToLower(m[1])
	value := strings.TrimSpace(m[2] + m[3])
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

var embeddedPragma = regexp.MustCompile(`(?mi)^[ \t]*PRAGMA[^;]*;`)

// splitPragmas pulls whole-line PRAGMA statements out of a multi-statement
// script (go-libfossil's schema embeds one), so they can be emulated while
// the rest of the script runs as one statement.
func splitPragmas(script string) (pragmas []string, rest string) {
	for _, m := range embeddedPragma.FindAllString(script, -1) {
		pragmas = append(pragmas, strings.TrimSuffix(strings.TrimSpace(m), ";"))
	}
	if len(pragmas) == 0 {
		return nil, script
	}
	return pragmas, embeddedPragma.ReplaceAllString(script, "")
}
