#!/bin/sh
# Operate only the account-authorized media gateway project.
set -eu
ops_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec docker compose --env-file "${MUSE_MEDIA_COMPOSE_ENV:-/etc/muse/media-gateway/compose.env}" \
  -p muse-company-media -f "$ops_directory/compose.yml" "$@"
