#!/bin/bash
# Server side of prepare.sh, as root. Inputs (environment): S, RELEASES, OPS, optional FROM, CHECK_ONLY, NPM_CONFIG_REGISTRY.
# Creates only <RELEASES>/<CST date>-main-<short> and files under OPS; never touches the unit, its drop-ins or another release.
set -euo pipefail
UNIT=${MUSE_GATEWAY_UNIT:-muse-minimal-accounts.service}
NODE_BIN=${MUSE_GATEWAY_NODE_BIN:-/opt/muse/runtime/node/bin}
SHORT=${S:0:10}; NAME="$(TZ=Asia/Shanghai date +%Y%m%d)-main-$SHORT"; NEW="$RELEASES/$NAME"
finish() { local rc=$?; [ "${CHECK_ONLY:-0}" = 1 ] || echo "$rc $(date -Is)" > "$OPS/prepare.exit"; }
trap finish EXIT
say() { printf '== %s %s\n' "$(TZ=Asia/Shanghai date +%H:%M:%S)" "$*"; }

# Base release: the one the running unit uses, unless FROM names another.
wd=$(systemctl show "$UNIT" -p WorkingDirectory --value)
live=${wd%/gateway/services/muse-accounts}
[ "$live" != "$wd" ] || { echo "STOP: unexpected WorkingDirectory $wd"; exit 1; }
BASE=${FROM:+$RELEASES/$FROM}; BASE=${BASE:-$live}
say "live release $live; base $BASE; new $NEW"
[ -d "$BASE/gateway/services/muse-accounts" ] || { echo "STOP: base has no gateway/services/muse-accounts"; exit 1; }
[ ! -e "$NEW" ] || { echo "STOP: $NEW exists"; exit 1; }
df -h "$RELEASES" | tail -1
"$NODE_BIN/node" --version
[ "${CHECK_ONLY:-0}" = 1 ] && { say "check only: nothing written"; exit 0; }

say "copying the base release"
cp -a "$BASE" "$NEW.partial"
W="$NEW.partial/gateway"
mkdir -p "$OPS/extract"; tar -xf "$OPS/incoming/source.tar" -C "$OPS/extract"
for dir in services/muse-accounts integrations/localminidrama; do
  target="$W/$dir"
  [ -d "$target" ] || { echo "STOP: base lacks gateway/$dir"; exit 1; }
  rm -rf "$target"; mkdir -p "$target"; cp -a "$OPS/extract/$dir/." "$target/"
done
echo "$S" > "$NEW.partial/SOURCE_COMMIT"

say "installing gateway dependencies (npm ci)"
(cd "$W/services/muse-accounts" && PATH="$NODE_BIN:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

say "syntax check"
bad=0
while IFS= read -r -d '' f; do "$NODE_BIN/node" --check "$f" >/dev/null 2>&1 || { echo "syntax error: $f"; bad=1; }; done \
  < <(find "$W/services/muse-accounts" "$W/integrations/localminidrama" -path '*/node_modules' -prune -o \( -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \) -print0)
[ "$bad" = 0 ] || { echo "STOP: syntax errors"; exit 1; }

say "file differences against the base (node_modules excluded)"
python3 -I - "$BASE/gateway" "$W" "$OPS/diff.txt" <<'PY'
import hashlib, os, sys
def tree(root):
    out = {}
    for r, ds, fs in os.walk(root, followlinks=False):
        ds[:] = [d for d in ds if d != "node_modules" and not os.path.islink(os.path.join(r, d))]
        for f in fs:
            p = os.path.join(r, f)
            if os.path.islink(p): continue
            out[os.path.relpath(p, root)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out
a, b = tree(sys.argv[1]), tree(sys.argv[2])
lines = [f"changed {p}" for p in sorted(a.keys() & b.keys()) if a[p] != b[p]] + [f"added {p}" for p in sorted(b.keys() - a.keys())] + [f"removed {p}" for p in sorted(a.keys() - b.keys())]
open(sys.argv[3], "w").write("\n".join(lines) + "\n")
print(f"{sum(l.startswith('changed') for l in lines)} changed, {sum(l.startswith('added') for l in lines)} added, {sum(l.startswith('removed') for l in lines)} removed; list in {sys.argv[3]}")
PY
mv "$NEW.partial" "$NEW"; rm -rf "$OPS/extract"
python3 -I -c 'import json,sys; json.dump({"commit":sys.argv[1],"release":sys.argv[2],"base":sys.argv[3],"live":sys.argv[4]},open(sys.argv[5],"w"),indent=1)' "$S" "$NEW" "$BASE" "$live" "$OPS/prepared.json"
say "prepared $NEW"
