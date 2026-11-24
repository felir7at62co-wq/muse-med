#!/bin/zsh
# Archive one commit and serve it, with the server scripts, to the tailnet for the cloud server to download.
# Usage: archive.zsh <full sha> [port]. Prints "SERVING <url>" once the HTTP server answers. stop-serving.zsh ends it.
set -eu
REPO=${0:A:h:h:h:h}
REL="$REPO/deploy/cloud-muse"
S=${1:?full sha}; PORT=${2:-18765}
[[ $S =~ '^[0-9a-f]{40}$' ]] || { print -u2 "need a full sha"; exit 64; }
git -C "$REPO" cat-file -e "${S}^{commit}"
IP=$(tailscale ip -4 2>/dev/null || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4)
IP=${IP%%$'\n'*}
[[ $IP == 100.* ]] || { print -u2 "no tailnet IPv4"; exit 1; }
OUT=/tmp/muse-release-${S[1,10]}
[ -e "$OUT/http.pid" ] && kill "$(cat "$OUT/http.pid")" 2>/dev/null || true
rm -rf "$OUT"; mkdir -p "$OUT/payload/server"; chmod 700 "$OUT"
git -C "$REPO" archive --format=tar --prefix=src/ "$S" | gzip -1 > "$OUT/payload/source.tar.gz"
cp "$REL"/server/*(.) "$OUT/payload/server/"
(cd "$OUT/payload" && shasum -a 256 source.tar.gz server/* > SHA256SUMS)
print "archive bytes: $(stat -f %z "$OUT/payload/source.tar.gz")"
nohup python3 -m http.server "$PORT" --bind "$IP" --directory "$OUT/payload" > "$OUT/http.log" 2>&1 &
print $! > "$OUT/http.pid"
for i in {1..20}; do curl -fsS -o /dev/null "http://$IP:$PORT/SHA256SUMS" && { print "SERVING http://$IP:$PORT"; exit 0; }; sleep 0.5; done
print -u2 "http server did not start"; exit 1
