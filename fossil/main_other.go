//go:build !js

package main

// The server only runs as WebAssembly inside a Durable Object; see build.sh.
// This file lets `go test` and `go vet` run the platform-independent parts.
func main() { panic("build with GOOS=js GOARCH=wasm (see fossil/build.sh)") }
