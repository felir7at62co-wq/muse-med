# Account gateway release from one main commit

English | [中文](README.zh.md)

One release of the account and model gateway (`muse-minimal-accounts.service` on the cloud server) from one Muse `main` commit S. The release replaces two directories of the running release with S's [`services/muse-accounts`](../../services/muse-accounts/README.md) and `integrations/localminidrama`; everything else is carried from the running release.

Run the drivers from any machine that reaches both the git machine and the server over SSH. Git runs only on the git machine. Every driver takes S as a short or full sha and refuses a commit that is not local `main` or an ancestor of it; set `ALLOW_OFF_MAIN=1` to override.

| Variable | Meaning |
|---|---|
| `MUSE_RELEASE_GIT_HOST` | SSH destination of the git machine, e.g. `user@host` |
| `MUSE_RELEASE_GIT_REPO` | Path of this repository on the git machine |
| `MUSE_RELEASE_SERVER` | SSH destination of the cloud server, as root |
| `MUSE_GATEWAY_RELEASES` | Optional; release root on the server, default `/opt/muse/platform/releases` |
| `MUSE_GATEWAY_OPS` | Optional; operations root on the server, default `/opt/muse/platform/operations` |
| `NPM_CONFIG_REGISTRY` | Optional; npm registry for `npm ci` on the server |

`$OPS` = `<operations root>/gateway-main-<S short>` (root only). It holds the server scripts, logs, `prepared.json`, `diff.txt`, the saved drop-in and `activation.json`.

## Steps

| Step | Command | Service |
|---|---|---|
| 0 | `./prepare.sh S --check-only` | untouched (read-only) |
| 1 | `./prepare.sh S [--from=<release name>]` | untouched |
| 2 | Read `$OPS/diff.txt` on the server: only the files S should change may appear | untouched |
| 3 | `./switch.sh S check` | untouched (read-only) |
| 4 | `./switch.sh S activate` at a quiet time, after telling the cloud transcription owner | stopped and started once, normally under 15 s |
| on failure | `./switch.sh S rollback` | stopped and started once |

One gateway restart affects every Muse user: batch changes into one release and restart once. Log each round in the server's gateway change queue (`<operations root>/gateway-queue.md`).

## What each script does and touches

- **prepare.sh** resolves S, streams `git archive S services/muse-accounts integrations/localminidrama` through the driver machine and checks its sha256 on both ends, then runs `server/prepare-server.sh` as the transient unit `muse-gateway-prepare-<short>`:
  1. The base is the release the unit runs (from its `WorkingDirectory`), or `--from`.
  2. `cp -a` of the base to `<release root>/<CST date>-main-<short>.partial`. This carries the shared `gateway/services/node_modules`, `gateway/deployment` and `gateway/third_party` links, `studio/`, `runtime/` and the private studio configuration, none of which is built from this repository yet.
  3. `gateway/services/muse-accounts` and `gateway/integrations/localminidrama` are replaced by the archive, then `npm ci --omit=dev --ignore-scripts` installs the gateway's locked dependencies.
  4. `node --check` on every `.mjs`, `.js` and `.cjs` file of the two directories.
  5. `diff.txt`: changed, added and removed files against the base, by sha256, without `node_modules`.
  6. The directory is renamed without `.partial`, `SOURCE_COMMIT` holds S, and `prepared.json` records the release, the base and the live release.
  - It never touches the unit, its drop-ins, configuration under `/etc` or `/var/lib`, or another release.
- **switch.sh** copies the server scripts into `$OPS` and runs `server/switch.py`; `activate` and `rollback` run as transient units, so a dropped SSH session cannot cut them in half.
  - `check` and `activate` refuse unless the unit still runs the live release that prepare recorded. The effective drop-in is the last one in name order that sets `ExecStart`; it must also set `WorkingDirectory` and name the live release path at least twice.
  - `activate` saves that drop-in, replaces the live release path with the prepared one, runs `daemon-reload` and `systemctl restart --no-block`, kills a previous main process that has not stopped after 25 s, and waits up to 150 s until the new main process runs from the new release and `GET /login` returns 200 on the unit's `MUSE_PORT` with the host of its `MUSE_PUBLIC_ORIGIN`. On failure it restores the drop-in and restarts the previous release. It writes `activation.json`.
  - `rollback` restores the saved drop-in and restarts the previous release, with the same health check.
  - The model directory (`MUSE_MODEL_CONFIG`), environment files and keys are not part of a release; change them as separate, logged steps.

## Configuration a release may need

New gateway features stay off until configured; the [production source table](../../services/muse-accounts/README.md#production-source) lists their settings and defaults. Before `activate`, compare the unit's environment files with the settings S's gateway refuses at startup: since supplier-direct access was removed, any `MUSE_DESKTOP_MODEL_TRANSPORT` other than `relay` and the retired `MUSE_ZHIPU_DIRECT_*` and `MUSE_USAGE_RATE_PER_MINUTE` variables stop startup, and `switch.py` then rolls back automatically. Feishu department lookup at sign-in is on unless the Feishu login configuration sets `organizationSync` to `false`; before the first release with it, confirm that the Feishu application has the three user-identity contact permissions enabled and published, or set `false`. Change environment and configuration files in the same restart as the release, and log the change.
