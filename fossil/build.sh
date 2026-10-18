#!/bin/sh
# Build the Durable Object's Fossil engine: src/fossil.wasm and the matching
# runtime glue src/wasm_exec.js, from this directory's Go program.
#
#   sh fossil/build.sh            # TinyGo (default): ~2.7 MB raw, ~0.9 MB gzip
#   GO_COMPILER=go sh fossil/build.sh   # standard Go:  ~9 MB raw, ~2.4 MB gzip
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../src"
cd "$here"
case "${GO_COMPILER:-tinygo}" in
  tinygo)
    # The default goroutine stack overflows in go-libfossil's deeper paths.
    tinygo build -target wasm -no-debug -opt=z -stack-size=1MB -o "$out/fossil.wasm" .
    cp "$(tinygo env TINYGOROOT)/targets/wasm_exec.js" "$out/wasm_exec.js"
    ;;
  go)
    GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/fossil.wasm" .
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"
    ;;
  *) echo "GO_COMPILER must be tinygo or go" >&2; exit 2 ;;
esac
echo "built src/fossil.wasm with ${GO_COMPILER:-tinygo}: $(wc -c <"$out/fossil.wasm") bytes, $(gzip -9c "$out/fossil.wasm" | wc -c) gzipped"
