#!/bin/sh
# Build muse-dtk-app:5.1.10, the pinned DTK API image with patches/*.patch applied.
# The patches must apply cleanly to the pinned source; the image label records their hash.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
source=${DTK_SOURCE_DIR:-/opt/muse/dtk/source-v5.1.10}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -a "$source/src" "$source/tests" "$source/documents" "$work/"
for patch in "$here"/patches/*.patch; do
    patch -d "$work" -p1 --forward --batch --silent < "$patch"
done
digest=$(cat "$here"/patches/*.patch | sha256sum | cut -d' ' -f1)
docker build -f "$here/Dockerfile.patched" --label "com.muse.dtk.patches.sha256=$digest" -t muse-dtk-app:5.1.10 "$work"
echo "built muse-dtk-app:5.1.10 patches=$digest"
