#!/bin/zsh
# Stop the temporary HTTP server for one release and delete its payload. Usage: stop-serving.zsh <full sha>
OUT=/tmp/muse-release-${1[1,10]}
[ -f "$OUT/http.pid" ] && kill "$(cat "$OUT/http.pid")" 2>/dev/null && print "http server stopped"
rm -rf "$OUT"
