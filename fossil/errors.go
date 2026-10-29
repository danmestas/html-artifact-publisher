package main

import "fmt"

// coded errors carry a machine-readable code to the Worker.
type coded struct {
	code string
	msg  string
}

func (e coded) Error() string { return e.msg }

func fail(code, format string, a ...any) error { return coded{code, fmt.Sprintf(format, a...)} }
