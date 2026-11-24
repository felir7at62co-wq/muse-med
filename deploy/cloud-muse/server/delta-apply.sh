#!/bin/bash
# Rebuild source.tar.gz for release S on the server from base release B's archive plus a delta package (mac/delta.zsh).
# Usage: delta-apply.sh <OPS dir of S> <OPS dir of B>. Expects <OPS>/incoming/delta.tar.gz. The rebuilt tree must match
# the Mac's manifest (server/manifest.py) or nothing is written. Leaves incoming/source.tar.gz, incoming/server/ and
# incoming/SHA256SUMS exactly as the normal download would.
set -euo pipefail
OPS=${1:?ops dir}; BASE_OPS=${2:?base ops dir}
I="$OPS/incoming"; D="$I/delta"; T="$I/tree"
rm -rf "$D" "$T"; mkdir -p "$D" "$T"
tar -xzf "$I/delta.tar.gz" -C "$D"
(cd "$BASE_OPS/incoming" && sha256sum -c --quiet SHA256SUMS) || { echo "base archive fails its own checksums"; exit 1; }
grep -q "$(cat "$D/B")" "$BASE_OPS/prepared.json" || { echo "base ops dir was not prepared from $(cat "$D/B")"; exit 1; }
tar -xzf "$BASE_OPS/incoming/source.tar.gz" -C "$T"
python3 - "$T/src" "$D/deleted.z" <<'PY'
import os, sys
root, listing = sys.argv[1], sys.argv[2]
for rel in filter(None, open(listing, 'rb').read().split(b'\0')):
    path = os.path.join(os.fsencode(root), rel)
    if os.path.islink(path) or os.path.isfile(path):
        os.remove(path)
    else:
        print('deleted path missing in base:', rel.decode(errors='replace'))
PY
if [ -s "$D/text.patch" ]; then
  patch -d "$T/src" -p1 --batch --forward --no-backup-if-mismatch -s < "$D/text.patch"
fi
python3 - "$T/src" "$D/files.tar" <<'PY'
import os, sys, tarfile
root, archive = sys.argv[1], sys.argv[2]
with tarfile.open(archive) as tar:
    for member in tar.getmembers():
        if member.isdir():
            continue
        rel = member.name[len('src/'):] if member.name.startswith('src/') else member.name
        target = os.path.join(root, rel)
        if os.path.lexists(target) and not os.path.isdir(target):
            os.remove(target)
PY
tar -xf "$D/files.tar" -C "$T"
want=$(cat "$D/manifest"); got=$(python3 "$D/server/manifest.py" "$T/src")
echo "manifest mac:    $want"; echo "manifest server: $got"
[ "$want" = "$got" ] || { echo "rebuilt tree differs from the Mac's; not writing source.tar.gz"; exit 1; }
tar -C "$T" -cf - src | gzip -1 > "$I/source.tar.gz.new"
mv "$I/source.tar.gz.new" "$I/source.tar.gz"
rm -rf "$I/server"; mkdir -p "$I/server"; cp "$D"/server/* "$I/server/"
(cd "$I" && sha256sum source.tar.gz server/* > SHA256SUMS)
rm -rf "$T"
echo "rebuilt source.tar.gz $(stat -c %s "$I/source.tar.gz") bytes"
