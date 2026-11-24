#!/bin/bash
# Queue bookkeeping after a release. Usage:
#   finish.sh <S> [--apply] [--ship "<header text>"]... [--keep "<header text>"]...
# Without --apply it only prints the plan. A `queued` entry is shipped when the first commit named on its
# `commit:` line is contained in S (checked on the Mac); `applied` entries move along as records. --ship / --keep
# override by a substring of the entry's header (for entries whose commit line names no commit in S, such as one
# superseded by a later entry or a change that reached main under another sha). --apply requires checked.ok.
source "$(dirname "$0")/lib.sh"
ARG=${1:?usage: finish.sh <S> [--apply] [--ship TEXT]... [--keep TEXT]...}; shift
APPLY=0; SHIP=(); KEEP=()
while [ $# -gt 0 ]; do case $1 in --apply) APPLY=1;; --ship) SHIP+=("$2"); shift;; --keep) KEEP+=("$2"); shift;; *) die "unknown option $1";; esac; shift; done
S=$(resolve_sha "$ARG"); OPS=$(ops_dir "$S")
RELEASE_NAME=$(srv "basename \"\$(cat '$OPS/release.path' 2>/dev/null)\" 2>/dev/null" || true)
[ -n "$RELEASE_NAME" ] || RELEASE_NAME="main-${S:0:10}"
BLOCKS=$(srv "python3 - blocks" < "$REL_DIR/server/finish-queue.py")
TOKENS=$(printf '%s' "$BLOCKS" | python3 -c 'import json,sys; print(" ".join(e["tokens"][0] for e in json.load(sys.stdin)["entries"] if e["tokens"]))')
ANCESTRY=$( [ -n "$TOKENS" ] && mac_script ancestry.zsh "$S" $TOKENS || true)
PLAN=$(python3 - "$S" "$RELEASE_NAME" "$BLOCKS" "$ANCESTRY" "$(printf '%s\n' "${SHIP[@]}")" "$(printf '%s\n' "${KEEP[@]}")" <<'PY'
import json, sys
s, release, blocks, ancestry, ship_txt, keep_txt = sys.argv[1:7]
blocks = json.loads(blocks)
seen = dict(line.split() for line in ancestry.splitlines() if len(line.split()) == 2)
force_ship = [t for t in ship_txt.splitlines() if t]
import re
force_keep = [t for t in keep_txt.splitlines() if t]
plan = {'queueSHA': blocks['queueSHA'], 'release': release, 'sha': s, 'ship': [], 'applied': []}
for e in blocks['entries']:
    h, status = e['header'], e['status']
    first = e['tokens'][0] if e['tokens'] else None
    if any(t in h for t in force_keep):
        verdict = 'keep (--keep)'
    elif any(t in h for t in force_ship):
        verdict = 'ship (--ship)'; plan['ship'].append(h)
    elif status.startswith('applied'):
        verdict = 'move as applied'; plan['applied'].append(h)
    elif status.startswith('queued') and re.search(r'\[(?!muse-cloud\])[a-z0-9-]+\]', h):
        # An entry tagged with another service ([muse-transcription-desk]) is work this release does not do.
        verdict = 'KEEP: names another service; decide with --ship/--keep'
    elif status.startswith('queued') and first and seen.get(first) == 'yes':
        verdict = f'ship ({first} is in {s[:10]})'; plan['ship'].append(h)
    elif status.startswith('queued'):
        verdict = f'KEEP: {first or "no commit"} is {seen.get(first, "not named") if first else "not named"} in {s[:10]}; decide with --ship/--keep'
    else:
        verdict = f'keep (status "{status[:30]}")'
    print(f'  {verdict:58} | {h[:90]}', file=sys.stderr)
print(json.dumps(plan, ensure_ascii=False))
PY
)
if [ "$APPLY" = 0 ]; then say "dry run; rerun with --apply to move the entries above"; exit 0; fi
srv "test -f '$OPS/checked.ok'" || die "no checked.ok for this release; finish after check.sh passes"
printf '%s' "$PLAN" | srv "python3 '$OPS/server/finish-queue.py' apply"
