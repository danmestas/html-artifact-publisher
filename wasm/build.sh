#!/bin/sh
# Rebuild public/fossil.wasm.gz (wasm/main.go compiled against go-libfossil at
# the commit in wasm/GO-LIBFOSSIL) and public/wasm_exec.js (the matching Go
# runtime glue).
#
#   sh wasm/build.sh [GO_LIBFOSSIL_CHECKOUT]
#
# main.go uses go-libfossil's internal packages, so it is built from inside a
# checkout of that module. Without a checkout argument the pinned commit is
# fetched from GitHub.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../public"
pin=$(cat "$here/GO-LIBFOSSIL")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
if [ $# -gt 0 ]; then
  git -C "$1" archive "$pin" | tar -x -C "$work" --one-top-level=glf
else
  git init -q "$work/glf"
  git -C "$work/glf" fetch -q --depth 1 https://github.com/danmestas/go-libfossil "$pin"
  git -C "$work/glf" checkout -q FETCH_HEAD
fi
mkdir -p "$work/glf/examples/artifactrepo" "$out"
cp "$here/main.go" "$work/glf/examples/artifactrepo/main.go"
(cd "$work/glf" && GOOS=js GOARCH=wasm go build -buildvcs=false -trimpath -ldflags="-s -w" \
  -o "$work/fossil.wasm" ./examples/artifactrepo)
gzip -9n <"$work/fossil.wasm" >"$out/fossil.wasm.gz"
cp "$(cd "$work/glf" && go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"
echo "built public/fossil.wasm.gz from go-libfossil $(echo "$pin" | cut -c1-12) with $(cd "$work/glf" && go env GOVERSION)"
