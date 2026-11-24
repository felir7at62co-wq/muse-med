#!/bin/bash
# Build one gateway release from a Muse main commit S beside the live one; the service is not touched.
# Usage: prepare.sh <S> [--check-only] [--from=<release name>]
#   --check-only  read-only: resolve S and run the server preflight
#   --from        base release to copy (default: the release the running unit uses)
# Steps: resolve S -> git archive of services/muse-accounts and integrations/localminidrama on the git machine,
# streamed through this machine with a sha256 check -> server/prepare-server.sh builds
# <releases>/<CST date>-main-<short> as a copy of the base with those two directories replaced, npm ci, node --check,
# and a file manifest diff against the base -> receipt $OPS/prepared.json.
source "$(dirname "$0")/lib.sh"
ARG=${1:?usage: prepare.sh <S> [--check-only] [--from=<release name>]}; shift
CHECK_ONLY=0; FROM=
for a in "$@"; do case $a in --check-only) CHECK_ONLY=1;; --from=*) FROM=${a#--from=};; *) die "unknown option $a";; esac; done
S=$(resolve_sha "$ARG"); OPS=$(ops_dir "$S")
say "release commit $S"
if [ "$CHECK_ONLY" = 1 ]; then
  srv "S=$S FROM='$FROM' RELEASES='$RELEASES' OPS='$OPS' CHECK_ONLY=1 bash -s" < "$REL_DIR/server/prepare-server.sh"
  exit 0
fi
srv "test ! -e '$OPS/prepared.json'" || die "$OPS/prepared.json exists; this commit is already prepared"
srv "mkdir -p '$OPS/incoming' '$OPS/server' && chmod 700 '$OPS'"
tar -C "$REL_DIR/server" -cf - . | srv "tar -xf - -C '$OPS/server' && chmod 700 '$OPS/server'"
say "archiving services/muse-accounts and integrations/localminidrama at ${S:0:10}"
want=$(git_host "git -C '$GIT_REPO' archive --format=tar $S services/muse-accounts integrations/localminidrama | shasum -a 256 | cut -d' ' -f1")
git_host "git -C '$GIT_REPO' archive --format=tar $S services/muse-accounts integrations/localminidrama" | srv "cat > '$OPS/incoming/source.tar'"
got=$(srv "sha256sum '$OPS/incoming/source.tar' | cut -d' ' -f1")
[ "$want" = "$got" ] || die "archive checksum mismatch ($want vs $got)"
run_unit "muse-gateway-prepare-${S:0:10}" "$OPS/prepare.log" "$OPS/prepare.exit" \
  "/usr/bin/env S=$S FROM='$FROM' RELEASES='$RELEASES' OPS='$OPS' NPM_CONFIG_REGISTRY='${NPM_CONFIG_REGISTRY:-}' bash '$OPS/server/prepare-server.sh'" \
  || die "prepare failed; see $OPS/prepare.log on the server"
srv "cat '$OPS/prepared.json'"
