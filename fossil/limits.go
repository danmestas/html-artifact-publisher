package main

import (
	"bytes"
	"compress/zlib"
	"fmt"
)

// A Durable Object's SQLite holds at most 2,000,000 bytes in one value.
// Fossil stores each artifact zlib-compressed in one blob row with a 4-byte
// size prefix, so a file whose compressed form does not fit can never be
// stored. maxStored leaves room for that prefix and the row's other columns.
const maxStored = 1_990_000

// errTooLarge marks a file the repository cannot store.
type errTooLarge struct {
	name string
	size int
}

func (e errTooLarge) Error() string {
	return fmt.Sprintf("%s is too large to store: %d bytes compressed, the limit is %d", e.name, e.size, maxStored)
}

// checkStorable returns errTooLarge when content cannot fit in one row.
// Compressing is skipped for content that fits uncompressed.
func checkStorable(name string, content []byte) error {
	if len(content)+4 <= maxStored {
		return nil
	}
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	w.Write(content)
	w.Close()
	if n := buf.Len() + 4; n > maxStored {
		return errTooLarge{name: name, size: n}
	}
	return nil
}
