#!/bin/sh
# Build the Durable Object's Fossil engine: src/fossil.wasm and the matching
# runtime glue src/wasm_exec.js, from this directory's Go program.
#
#   npm ci && npm run build:wasm             # TinyGo (default): ~1.5 MB raw, ~0.6 MB gzip
#   GO_COMPILER=go sh fossil/build.sh        # standard Go:  ~9 MB raw, ~2.4 MB gzip (debugging only)
#
# The TinyGo build is reproducible across Linux and macOS because every
# wasm-opt it runs is Binaryen from node_modules (pinned in package.json), not
# whatever is installed on the machine. A Homebrew wasm-opt made a 25% larger
# build. The build fails if the result is over the size budget below.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root="$here/.."
out="$root/src"
wasmopt="$root/node_modules/.bin/wasm-opt"
# gzip -9 bytes. Raise it only on purpose, in the same commit as the change
# that needs it.
budget="${FOSSIL_WASM_MAX_GZIP:-1100000}"
# The engine serves sync with HandleSyncWithOpts and never dials out, so
# go-libfossil's HTTP client and server (net/http, TLS, X.509) stay out.
# libfossil_noslog writes go-libfossil's diagnostics as plain stderr lines
# without log/slog.
tags="libfossil_nohttp libfossil_noslog"

# patched_goroot prints a copy of the current Go tree with goroot.patch
# applied, building it once per Go version and patch.
patched_goroot() {
  src=$(go env GOROOT)
  ver=$(head -n 1 "$src/VERSION")
  # A GOROOT from the environment (a version manager's, say) can point at
  # another Go than the one on PATH; TinyGo would use its library.
  if [ "$ver" != "$(go env GOVERSION)" ]; then
    echo "GOROOT is $ver but go on PATH is $(go env GOVERSION): select one Go with both GOROOT and PATH" >&2
    exit 1
  fi
  sum=$(cksum <"$here/goroot.patch" | cut -d' ' -f1)
  dst="${TMPDIR:-/tmp}/fossil-goroot-$ver-$sum"
  if [ ! -f "$dst/.patched" ]; then
    rm -rf "$dst.tmp"
    cp -R "$src" "$dst.tmp"
    chmod -R u+w "$dst.tmp"
    (cd "$dst.tmp" && patch -p1 -s --no-backup-if-mismatch <"$here/goroot.patch") >&2
    touch "$dst.tmp/.patched"
    rm -rf "$dst" && mv "$dst.tmp" "$dst"
  fi
  echo "$dst"
}

cd "$here"
case "${GO_COMPILER:-tinygo}" in
  tinygo)
    [ -x "$wasmopt" ] || { echo "wasm-opt not found: run npm ci in $root first" >&2; exit 1; }
    want=0.43.0
    have=$(tinygo version | sed -n 's/^tinygo version \([0-9.]*\).*/\1/p')
    [ "$have" = "$want" ] || { echo "TinyGo $want is required (found ${have:-none}); see README, Building the Fossil engine" >&2; exit 1; }
    # The engine runs without a scheduler (-scheduler=none): asyncify, which
    # lets goroutines pause, made it about 40% larger and 3x slower, and every
    # request already runs synchronously. The only goroutines in the program
    # are six in Go's standard library (database/sql, context, time); see
    # goroot.patch, applied to a copy of the Go tree from go.mod. Without a
    # scheduler js.FuncOf cannot call in, so the engine is a reactor
    # (-buildmode=c-shared) exporting fossil_call (export_js.go), and
    # -panic-unwind=explicit keeps recover working so a panic is still an
    # error reply. -stack-size=1MB: go-libfossil's deeper paths overflow the
    # 64 KB default.
    goroot=$(patched_goroot)
    GOROOT="$goroot" PATH="$goroot/bin:$PATH" GOTOOLCHAIN=local WASMOPT="$wasmopt" \
      tinygo build -target wasm -tags "$tags" -no-debug -opt=z -stack-size=1MB \
      -scheduler=none -buildmode=c-shared -panic-unwind=explicit -o "$out/fossil.wasm" .
    # One more size pass over the whole module: about 5% smaller raw, 3% gzipped.
    "$wasmopt" -Oz --detect-features --strip-debug --strip-producers "$out/fossil.wasm" -o "$out/fossil.wasm"
    cp "$(tinygo env TINYGOROOT)/targets/wasm_exec.js" "$out/wasm_exec.js"
    ;;
  go)
    GOOS=js GOARCH=wasm go build -tags "$tags" -trimpath -ldflags="-s -w" -o "$out/fossil.wasm" .
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"
    budget=0
    ;;
  *) echo "GO_COMPILER must be tinygo or go" >&2; exit 2 ;;
esac

raw=$(wc -c <"$out/fossil.wasm")
gz=$(gzip -9c "$out/fossil.wasm" | wc -c)
echo "built src/fossil.wasm with ${GO_COMPILER:-tinygo}: $raw bytes, $gz gzipped"
if [ "$budget" -gt 0 ] && [ "$gz" -gt "$budget" ]; then
  echo "src/fossil.wasm is $gz bytes gzipped, over the $budget budget. Check the TinyGo version and that wasm-opt came from node_modules; see README, Building the Fossil engine." >&2
  exit 1
fi
