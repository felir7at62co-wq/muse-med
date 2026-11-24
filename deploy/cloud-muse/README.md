# Cloud Muse release from one main commit

English | [中文](README.zh.md)

Prepare, switch, verify, or roll back `muse-cloud.service` from a single commit on the local Muse `main` branch. Preparation runs beside the live service. The switch normally waits for running work to finish or pause before it restarts the service.

## Set up the release

Run the drivers on a machine that can reach the macOS Git host and the cloud server over SSH. The drivers run Git commands on the Git host. Pass the same short or full commit ID as `S` to every command. The commit must be on the Git host's local `main` unless you explicitly set `ALLOW_OFF_MAIN=1`.

| Variable | Meaning |
|---|---|
| `MUSE_RELEASE_GIT_HOST` | SSH destination of the Git host, such as `user@host` |
| `MUSE_RELEASE_GIT_REPO` | Absolute path to this repository on the Git host |
| `MUSE_RELEASE_SERVER` | SSH destination of the cloud server, as root |

Use the server's `/opt/muse/cloud/staging/queue.md` and its sibling README to record changes before a release. One owner batches the queued changes into one restart. On the server, `$OPS` refers to the root-only directory `/opt/muse/cloud/operations/release-main-<first 10 characters of S>`. Its `release.path` identifies the release directory, where `SOURCE_COMMIT` records the full commit ID.

## Prepare, switch and verify

| Step | Driver command | Expected result |
|---|---|---|
| Preflight | `./prepare.sh S --check-only`, `./switch.sh S --check-only`, `./check.sh S --check-only` | Read-only diagnostics for resources, the running unit, and the quiet-work checks. Inspect the switch output even if the command exits successfully. |
| Prepare | `./prepare.sh S` | Verified source, runtime and plugin builds, a next profile, a rehearsal, and `$OPS/prepared.json`. |
| Review | Read `$OPS/carry.txt` and `$OPS/dump/compare.txt` on the server | Review changes from the live plugins and composition before switching. Check the carried Hongguo engine hash. |
| Switch | `./switch.sh S [--wait-minutes 60]` | A restart and readiness check, followed by a paused transcription runner. |
| Check | `./check.sh S [--keep-paused]` | Confirmation of the installed release and its state, then the queue plan. The driver resumes a runner it paused unless you request otherwise. |
| Finish | `./finish.sh S`, then `./finish.sh S --apply` | Review the plan before moving shipped entries. Applying the plan requires `$OPS/checked.ok`. |

[Prepare](prepare.sh) transfers a Git archive and verifies checksums before building on the server. Its default transfer path uses a temporary HTTP server on the Git host's tailnet. With a slow Git host to server link, use `--relay` to stream the archive through the driver machine or `--delta=B` to send changes from an already prepared release. The delta recipient must match the Git host's complete tree manifest. The server records completed stages under `$OPS/stages` and skips them on retry. If a prior stage's inputs changed, inspect its output and receipt before rerunning that stage.

Prepare builds the locked workspace and plugin archives, stages a separate `muse-cloud-next` profile, checks its links, and compares its resolved config with the current profile. To queue a config change, place the full candidate in `/opt/muse/cloud/staging/next/cloud.patch.yml` before running prepare. Prepare prints the difference. Without that file, it carries the live config. The rehearsal uses a disposable home and a private loopback listener. It checks composition, client assets, and the Bot state endpoint in isolation. Live Bot schedules, production account access, and Feishu delivery are outside the rehearsal.

[Switch](switch.sh) runs in a transient systemd unit under the deployment lock. It checks the staged config, profile, and live drop-in against the prepare receipt. The quiet-work checks cover runner batch state, sessions, pending inbox or queued work, terminals, schedules, and Bot work. Inspect the full status before using `--allow-desk-turns`, which permits recognized transcription desk turns, or `--restart-busy`, which records active work and proceeds without waiting.

Once ready to stop, the switch records `before.json`, stops the service, and makes a root-only state backup. It copies the current profile's owner layer into the next profile so model selections written since preparation carry forward. Then it swaps profiles, installs the release drop-in and staged cloud config, and waits for the new PID and built client. An operator who intends to retire the station webhook can create `$OPS/retire-station-events` before switching. The switch backs up the active webhook drop-in and disables its secret-file setting. Rollback restores the prior drop-ins. A failure after the stop triggers rollback unless `--no-auto-rollback` is set.

[Check](check.sh) compares the served Bot client with the build, the Bot and session inventories with `before.json`, and Feishu readiness and bindings with their saved state. It checks the active service release and configuration and observes the new PID and restart count for five minutes by default. It writes `after.json` and marks a successful check with `checked.ok`. The driver pipes the one-time login link into `~/Muse云端登录链接.txt` on the Git host with mode `0600`. A read-only `--check-only` run prints current diagnostics without sending the link or restoring the runner pause.

[Finish](finish.sh) uses the queue entry's first commit ID to decide whether a queued item shipped in `S`. It keeps entries assigned to other services and moves already applied entries as records. For entries that landed under a different commit or were superseded, review the current queue and use `--ship "<header substring>"` or `--keep "<header substring>"` as needed. Applying the plan checks the queue's hash, saves its previous version, and creates the shipped receipt in `staging/shipped/`.

## Roll back and clean up

Run [`./rollback.sh S --check-only`](rollback.sh) to review the rollback plan. Run `./rollback.sh S` after a failed post-switch check. It restores the previous profile, release drop-ins and cloud config, carries back current owner settings, and confirms that the previous client is served. It lifts only the transcription pause set by this release. Use `--restore-state` only to recover from state damage. Restoring the backup replaces Bot and session changes made since the switch.

If the rollback script cannot run, read `$OPS/prepared.json`, `$OPS/before.json`, and the rollback log before making manual changes.

1. Stop `muse-cloud.service`. Preserve the current owner layer under `profiles/muse-cloud/cordis.patch.yml` if the next profile had gone live.
2. When a profile swap occurred, move the failed profile aside and restore `profiles/muse-cloud.before-<first 10 characters of S>` to `profiles/muse-cloud`. Copy the preserved owner layer back into the restored profile.
3. Remove the installed release drop-in only if it matches this operation's staged file. Restore the previous release drop-in, this operation's saved station webhook drop-in if present, and `$OPS/backup/cloud.patch.yml.before`. Remove `station-events-retired.conf` only if `$OPS/station-events-retired.created` records that this release created it.
4. Reload systemd and verify `ExecStart` points to the previous release. Start the unit, then compare the served client with the hash in `before.json`.
5. Set `"paused": false` in the runner's `control.json` only if `$OPS/runner-pause.json` records `"wePaused": true`.

Keep rollback profiles and backups during the recovery window. The state archive contains secret files. Retain older releases while a running or preview unit still references them.
