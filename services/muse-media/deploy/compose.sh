#!/bin/sh
# Operate the isolated DTK project; do not print its resolved environment.
set -eu
dtk_source=${DTK_SOURCE_DIR:-/opt/muse/dtk/source-v5.1.10}
dtk_env=${DTK_PRIVATE_ENV:-/etc/muse/dtk.env}
exec docker compose --env-file "$dtk_env" -p muse-dtk \
  -f "$dtk_source/docker/compose.yml" --profile browser --profile downloader "$@"
