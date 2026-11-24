#!/bin/zsh
# Build a small change package from base commit B to release commit S, for a slow link to the server.
# Usage: delta.zsh <full S> <full B>. Writes /tmp/muse-delta-<S short>/delta.tar.gz holding text.patch (text files
# added or modified), files.tar (binary, symlink and empty files, prefix src/), deleted.z (NUL-separated), manifest
# (manifest.py over `git archive S`) and server/*. Prints "DELTA <path> <bytes>".
set -eu
REPO=${0:A:h:h:h:h}
REL="$REPO/deploy/cloud-muse"
S=${1:?full S}; B=${2:?full B}
[[ $S =~ '^[0-9a-f]{40}$' && $B =~ '^[0-9a-f]{40}$' ]] || { print -u2 "need full shas"; exit 64; }
git -C "$REPO" merge-base --is-ancestor "$B" "$S" || { print -u2 "base is not an ancestor of S"; exit 1; }
OUT=/tmp/muse-delta-${S[1,10]}
rm -rf "$OUT"; mkdir -p "$OUT/pkg/server" "$OUT/tree"; chmod 700 "$OUT"
cd "$REPO"
git diff --raw -z --no-renames --no-abbrev "$B" "$S" > "$OUT/raw.z"
git diff --numstat -z --no-renames "$B" "$S" > "$OUT/numstat.z"
python3 - "$OUT" <<'PY'
import sys, os
out = sys.argv[1]
raw = open(f'{out}/raw.z', 'rb').read().split(b'\0')
binary = set()
num = open(f'{out}/numstat.z', 'rb').read().split(b'\0')
for field in num:
    parts = field.split(b'\t')
    if len(parts) == 3 and parts[0] == b'-':
        binary.add(parts[2])
EMPTY = b'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
text, whole, deleted = [], [], []
i = 0
while i < len(raw) - 1:
    meta, path = raw[i], raw[i + 1]; i += 2
    if not meta.startswith(b':'):
        continue
    old_mode, new_mode, old_sha, new_sha, status = meta[1:].split(b' ')
    if status == b'D':
        deleted.append(path)
    elif new_mode == b'120000' or old_mode == b'120000' or path in binary or new_sha == EMPTY or new_mode == b'160000':
        whole.append(path)
    else:
        text.append(path)
for name, items in (('text', text), ('whole', whole), ('deleted', deleted)):
    open(f'{out}/{name}.z', 'wb').write(b'\0'.join(items) + (b'\0' if items else b''))
print(f'text {len(text)} whole {len(whole)} deleted {len(deleted)}')
PY
if [ -s "$OUT/text.z" ]; then xargs -0 git --literal-pathspecs diff --no-renames --full-index "$B" "$S" -- < "$OUT/text.z" > "$OUT/pkg/text.patch"; else : > "$OUT/pkg/text.patch"; fi
if [ -s "$OUT/whole.z" ]; then xargs -0 git --literal-pathspecs archive --format=tar --prefix=src/ "$S" -- < "$OUT/whole.z" > "$OUT/pkg/files.tar"; else tar -cf "$OUT/pkg/files.tar" -T /dev/null; fi
cp "$OUT/deleted.z" "$OUT/pkg/deleted.z"
git archive --format=tar --prefix=src/ "$S" | tar -xf - -C "$OUT/tree"
python3 "$REL/server/manifest.py" "$OUT/tree/src" > "$OUT/pkg/manifest"
cp "$REL"/server/*(.) "$OUT/pkg/server/"
print "$S" > "$OUT/pkg/S"; print "$B" > "$OUT/pkg/B"
tar -C "$OUT/pkg" -czf "$OUT/delta.tar.gz" .
rm -rf "$OUT/tree"
print "manifest: $(cat "$OUT/pkg/manifest")"
print "DELTA $OUT/delta.tar.gz $(stat -f %z "$OUT/delta.tar.gz")"
