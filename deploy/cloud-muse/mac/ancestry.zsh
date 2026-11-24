#!/bin/zsh
# Read-only: for each token, whether it names a commit contained in the release commit. Usage: ancestry.zsh <sha> <token>...
REPO=${0:A:h:h:h:h}
S=$1; shift
for t in "$@"; do
  c=$(git -C "$REPO" rev-parse --verify --quiet "${t}^{commit}") || { print "$t unknown"; continue; }
  git -C "$REPO" merge-base --is-ancestor "$c" "$S" && print "$t yes" || print "$t no"
done
