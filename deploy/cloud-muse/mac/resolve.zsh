#!/bin/zsh
# Read-only: full sha of a revision and whether it is local main or an ancestor of it. Prints "<sha> <on-main|OFF-MAIN>".
set -eu
REPO=${0:A:h:h:h:h}
s=$(git -C "$REPO" rev-parse --verify "${1:?revision}^{commit}")
if git -C "$REPO" merge-base --is-ancestor "$s" main; then print "$s on-main"; else print "$s OFF-MAIN"; fi
