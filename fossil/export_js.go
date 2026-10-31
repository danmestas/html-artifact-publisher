//go:build js && tinygo

package main

import "syscall/js"

// fossil_call is the engine's entry point in the TinyGo build
// (-buildmode=c-shared -scheduler=none, see build.sh), where js.FuncOf
// callbacks cannot run. JS puts [request, body] in globalThis.__fossilIn,
// calls this export, and reads the reply from globalThis.__fossilOut.
//
//go:wasmexport fossil_call
func fossilCall() {
	in := js.Global().Get("__fossilIn")
	js.Global().Set("__fossilOut", callEngine([]js.Value{in.Index(0), in.Index(1)}))
}
