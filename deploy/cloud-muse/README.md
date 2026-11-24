# Cloud Muse release from one main commit

One combined release of cloud Muse (`muse-cloud.service` on the cloud server) from one Muse `main` commit S.

Run the drivers from any machine that reaches both the git machine and the server over SSH. The git machine is a macOS machine that holds this repository; git runs only there. Every driver takes S as a short or full sha and refuses a commit that is not local `main` or an ancestor of it. To override that, set `ALLOW_OFF_MAIN=1`.

Set these before running any driver:

| Variable | Meaning |
|---|---|
| `MUSE_RELEASE_GIT_HOST` | SSH destination of the git machine, e.g. `user@host` |
| `MUSE_RELEASE_GIT_REPO` | Path of this repository on the git machine |
| `MUSE_RELEASE_SERVER` | SSH destination of the cloud server, as root |

Cloud Muse changes only through the staging queue on the server (`/opt/muse/cloud/staging/queue.md`, see its README): one owner, one batched restart. Record each change there before the round; `finish.sh` moves the shipped entries to `staging/shipped/`. It keeps an entry tagged with another service (`[unit-name]`) unless `--ship` names it.

Options added since the first rounds:

- `prepare.sh S --relay`: stream the payload through the driver machine when the git machine reaches the server only through a slow relay.
- `prepare.sh S --delta=B`: send only the change from an already prepared release B (a patch plus binary files); the server rebuilds the tree from B's archive and refuses it unless a whole-tree manifest matches the git machine's. Use it when the link is slow.
- A queued config change waits in `/opt/muse/cloud/staging/next/cloud.patch.yml`; prepare stages it instead of the live file and prints the difference.
- `touch $OPS/retire-station-events` before `switch.sh` retires the data-station webhook drop-in (already done on 2026-11-24); rollback restores it.
- `switch.sh S --restart-busy` restarts even while sessions run, recording them; with `--allow-desk-turns` the desk's Bots are expected to resume on their own.
- The Hongguo download plugin is carried as built from S; check `carry.txt` for its engine hash.

## Steps

| Step | Command | Time | Service |
|---|---|---|---|
| 0 | `./prepare.sh S --check-only`, `./switch.sh S --check-only`, `./check.sh S --check-only` | 1 min | untouched (read-only) |
| 1 | `./prepare.sh S` | about 15–30 min (not measured; the 11-21 `build:artifacts` alone took 33 s on a warm tree) | untouched |
| 2 | Read `$OPS/carry.txt` and `$OPS/dump/compare.txt` on the server | 5 min | untouched |
| 3 | `./switch.sh S [--wait-minutes 60] [--allow-desk-turns]` | waits for quiet, then about 1 min of downtime | stopped and started once |
| 4 | `./check.sh S` | about 6 min (5 min restart window) | read-only, then lifts our transcription pause |
| 5 | `./finish.sh S`, then `./finish.sh S --apply --ship "…"` | 1 min | untouched |
| on failure | `./rollback.sh S [--restore-state]` | about 1 min of downtime | stopped and started once |

`$OPS` = `/opt/muse/cloud/operations/release-main-<S short>` (root only). It holds the server scripts, logs, `prepared.json`, `before.json`, `after.json` and the backups.

## What each script does and touches

- **prepare.sh**: resolves S on the Mac and runs `git archive S` into `/tmp/muse-release-<short>` on the Mac. It serves that file and `server/*` with `python3 -m http.server` on the Mac's tailnet IP (port 18765), and the server downloads them with curl and checks their sha256. The HTTP server is stopped and the payload deleted afterwards. `server/prepare-server.sh` then runs as the transient unit `muse-cloud-prepare-<short>`. Each finished stage is marked in `$OPS/stages`, and a rerun skips it.
  - **Creates:** `/opt/muse/cloud/releases/<CST date>-main-<short>` (with `SOURCE_COMMIT` = full sha), `/opt/muse/cloud/plugin-archives/<same name>`, `profiles/muse-cloud-next` and `$OPS`. During the rehearsal it also uses `/var/cache/muse-release-<short>` and the transient unit `muse-cloud-rehearsal-<short>`, and deletes both after success.
  - **Never touches:** the unit, its drop-ins, `cloud.patch.yml`, the live profile, the other releases (the preview units need `releases/20261123-script-editor-5f79885239` and `previews/web-bot-ui-20261123`) or any other service.
  - **Stages:**
    1. Preflight, which `--check-only` runs alone.
    2. Extract the archive.
    3. Build core with the same commands as `build-core-20261121.sh` (`pnpm install --frozen-lockfile`, `build:artifacts`, the native system build), using `DSH_CLIENT_COMMIT_HASH=<short>` and running under nice/ionice.
    4. Add the koffi link if it is missing.
    5. Build the plugin archives (toolchain build plus `build-downloads.mjs`).
    6. Build `muse-cloud-next` with `prepareDevelopmentProject`. Its absolute self links are made relative so the directory still works after the rename, the live owner layer `cordis.patch.yml` is copied in, and ownership is set to muse-cloud.
    7. Check the links: none broken, none into another release, none absolute into `profiles/` or `/var/lib`.
    8. Carry check: list every file hand-edited in the live profile since 11-21 and say whether the next build has it, check the marker strings, and compare the dependency sets.
    9. Stage the config: `cloud.patch.yml.next` is a copy of the live file, and `release.conf` is generated from the live release drop-in by swapping the release path (exactly 3 occurrences).
    10. Run `--dump-config` as muse-cloud with the unit's environment for both live and next. Compare their ids and assert the required rows.
    11. Rehearsal (see below).
    12. Write the receipt `prepared.json`.
- **switch.sh**: syncs `server/*` into `$OPS/server`, then runs `switch-server.sh` as the transient unit `muse-cloud-switch-<short>` (a dropped SSH session cannot cut it in half) and follows its log. Steps:
  1. Take the lock `/run/lock/muse-cloud-deploy.lock` (non-blocking).
  2. Compare-and-swap against the receipt. The live release drop-in, `cloud.patch.yml`, the next profile's client and the staged files must be exactly what prepare saw. The links must still be sound, the service active, and `central-members.conf` and `station-events-bot.conf` present.
  3. Set `"paused": true` in `control.json`, recording whether we changed it.
  4. Wait, polling every 20 s up to `--wait-minutes`, for the quiet gate:
     - Every runner slot is `paused` (at a batch boundary; a held claim is fine) or `idle` with nothing current.
     - No Muse session is running.
     - No pending inbox, attached-session queue or terminal.
     - No schedule due within 210 s.
     - No Bot question, part, work, inflight turn or durable work.
  5. Write `before.json`: PID, installed and served `client.js` sha, session ids, Bot and main Bot ids, Central, the Feishu bindings hash (quiet-check's function), the Feishu config sha, unit environment names and drop-ins.
  6. Check the gate once more, then stop the service.
  7. Write `backup/home-state.tar`: `home` without profiles, attachments, dsh-runtimes or caches, about 130 MB, root 0600.
  8. Copy the current owner layer into next.
  9. `mv muse-cloud muse-cloud.before-<short>`, then `mv muse-cloud-next muse-cloud`.
  10. Move `script-editor-release.conf` to `$OPS/backup/dropin/` and install `release.conf`. The other two drop-ins stay.
  11. Back up `cloud.patch.yml` and replace it only if `.next` differs.
  12. Run `daemon-reload` and verify `ExecStart`, `MUSE_CLOUD_RELEASE` and the env names.
  13. Start the service and wait up to 240 s until ready: new PID, `client.js` served = built, Bot state, Central, dsh-im Feishu ready.
  14. If anything after the stop fails, roll back automatically (`--no-auto-rollback` turns this off).
  15. Transcription stays paused.
- **check.sh**: runs `check-server.sh`, then `gate.py check`. It checks:
  - a new PID
  - served `client.js` = built
  - Central members present
  - main Bots and Bots ⊇ before
  - sessions ⊇ before
  - Feishu ready with the same bindings hash, and the Feishu config unchanged
  - the two drop-ins kept
  - `ExecStart` and `MUSE_CLOUD_RELEASE` on the new release
  - Central env names
  - `MUSE_STATION_EVENTS_BOT` in the env and read by `station-events.js`
  - `DSH_PRIMARY_RUNTIME` present
  - `MUSE_DESKTOP_HOST` absent (so `localMedia` stays false)
  - `localVideo` in jingliu-connection's lib
  - `workshop_script_editor` in the release's desktop patch
  - `muse-desktop-office`, feishu-channel and `feishuDshIm` in the config
  - the journal of the new PID showing only the known lines
  - NRestarts 0 and the same PID after 5 min

  Then:
  - It always delivers the new one-time login link: server journal → pipe → Mac `~/Muse云端登录链接.txt` (0600). The link is never printed.
  - On success it lifts the transcription pause only if switch set it, and prints the queue plan.
  - It exits non-zero on any FAIL.
- **rollback.sh**: runs `rollback-server.sh` as a transient unit. It:
  - stops the service and carries the current owner layer back
  - moves the new profile to `muse-cloud.failed-<short>-<time>` and `muse-cloud.before-<short>` back to `muse-cloud`
  - removes `release.conf` (only if it is ours), restores `script-editor-release.conf` and restores `cloud.patch.yml`
  - runs `daemon-reload`, starts, and waits until the served `client.js` = the sha in `before.json`
  - lifts our pause and delivers the login link

  `--restore-state` also unpacks `home-state.tar`. It loses Bot and Session changes made since the switch, so use it only if the new code damaged state. Every step checks what is there, so it also finishes a half-done switch.
- **finish.sh**: reads the queue entries and checks, on the Mac, whether the first commit named on each `commit:` line is in S. A `queued` entry is shipped when that commit is in S, and an `applied` entry is moved as a record. `--ship` and `--keep` take a header substring. `--apply` needs `checked.ok`, compares the queue's sha256 first, keeps `queue.md.before-<short>` and writes `staging/shipped/<release>.md`.

`gate.py` is built from `quiet-check.py`, `served-check.py` and `release.py`, and reads `state.json`, the Feishu config and the journal token in-process. It prints counts and hashes only. `login-link` refuses to write to a terminal.

## Verified now (read-only)

- **Disk:** 339 G free. 32 CPUs and 60 G RAM.
- **Port 19513 is taken** by `muse-feishu-settings-review` (`--profile muse-cloud` with its own HOME), so the rehearsal uses 19523, which is free.
- **Unit:** the env names are DSH_FFMPEG_PATH, DSH_FFPROBE_PATH, DSH_HOME, DSH_PRIMARY_RUNTIME, DSH_TELEMETRY_DISABLED, HOME, MUSE_BASE_URL, MUSE_CENTRAL_LOOPBACK_ORIGIN, MUSE_CENTRAL_MEMBERS, MUSE_CENTRAL_ORIGIN, MUSE_CLOUD_RELEASE, MUSE_DOUYIN_PYTHON_PATH, MUSE_HOME, MUSE_OCR_PYTHON_PATH, MUSE_STATION_EVENTS_BOT, MUSE_STATION_EVENTS_SECRET_FILE, PATH and XDG_CACHE_HOME. Exactly one drop-in (`script-editor-release.conf`) sets ExecStart, and it names the live release 3 times. The generated `release.conf` was tested on a copy.
- **Profile layout:**
  - Build output: `cordis.yml` (an empty root), `package.json`, `pnpm-workspace.yaml`, `desktop-runtime.json` and `node_modules`.
  - State: only `cordis.patch.yml` (the owner layer, model choice). The app rewrites it: mtime 17:55 today. That is why switch copies it again after the stop.
  - Junk: `.node_modules-before-*`, `.script-editor-*-stage.*`, and `node_modules/.ds-bot-*` / `.central-host.*`. They stay in the before dir.
  - Bots, sessions, memory, accounts, market, IM, integrations and Jingliu all live in `home/*` outside the profile and are untouched.
  - The 11-21 prepare deleted the profile and rewrote the owner layer with fixed content. These scripts never delete the live profile.
- **Live hand edits since 11-21:**
  - ds-bot host files, `client.js` and `central-members.js`: S has Central, station-events and the `feishuDshIm` code.
  - dsh-im `lib/index.js`, `client.js` and `upstream.js`: S has newer dsh-im sources. Prepare's carry check shows SAME or DIFFERS per file.
  - **muse-hongguo-download `patches/0002-electron-main-only.patch` and its patched `upstream/engine.cjs`, 16:55, plus a temporary guard in the script-editor release's `electron/index.js`: NOT in S.** The fix is commit `88c3ea7d71` on `codex/hongguo-node-runtime`, not in main.
  - Three links into `releases/20261123-central-right-sidebar-6866248324`: S contains 6866248324.
- **Config:** main's desktop patch already carries `workshop_script_editor` (line 327). Its only other changes are jingliu-connection `localMedia` (true only when `MUSE_DESKTOP_HOST=1`, which only the Electron Desktop Host sets in `main()`) and `mediaHosts` (default host), plus `muse_billing` and `jingliu_media` in tool discovery. The preset and cloud-skills directories are unchanged, and no new code-generated Desktop Host rows have appeared since 41d4919b09. Conclusion: **`cloud.patch.yml.next` = the live file, unchanged**: feishu-channel enabled, `feishuDshIm: { im_975ad889: bot_muse_central }` and `muse-desktop-office` kept.
- **Format version constants:** none changed between 949d55071f and main, so rollback does not face a newer schema.
- **Quiet gate (`gate.py check-only`), run twice:** it reports the runner mid-batch `21-30` of 盛夏芬德拉 (control already `paused: true`, set by someone else at 17:35, so switch will not unpause it). It also reports 4–6 running sessions, Bot work and parts running, and the desk Bots 转写2 and 转写3 on 好一个乖乖女 and 家里家外.
- **`check.sh --check-only` against the current release:** these pass:
  - served `client.js` = installed (50f29327…)
  - Central present, 4 main Bots
  - journal: the 3 known startup lines, plus 4 Feishu `message_read_v1` lines and 1 "usage could not read 11 Sessions" (counted as tolerated)

  These fail, as expected for the old code: `station-events.js` does not read `MUSE_STATION_EVENTS_BOT`, and jingliu-connection has no `localVideo`.
- **`finish.sh S` (dry):** ships the two 18:12 entries and moves the two `applied` ones. It keeps three, which need `--ship`:
  - the 16:50 Central entry (superseded by 18:12; 09415c39ca is in S)
  - the 17:15 transcription entry (2180fe09a4 is not in S, but its content landed as 926dcc7042)
  - the 18:00 desk/sub-agents entry (ffca919f8f is not in S; S has the newer c6ddc2eff0 + a96dae584b)

  Suggested: `./finish.sh S --apply --ship "16:50" --ship "17:15 CST — transcription-line session (Claude" --ship "18:00 CST — transcription-line session: Bots transcribe"`. Check the 17:15 and 18:00 changes are what you expect first.

## Not verified

- Nothing was built:
  - pnpm install for S's lockfile (76 new lock lines; needs registry access from the server)
  - build and plugin build times
  - whether `prepareDevelopmentProject` at S accepts the archives (hostVersion 0.2.2-rc.2)
  - the dsh-im archive contents
  - the koffi version
  - the dump-config row count (was about 387)
  - the rehearsal
- The rehearsal boots the new release on 127.0.0.1:19523 with an empty throwaway home, Feishu off, no IM mapping, `/var/lib/muse-cloud` inaccessible and no Central or station env. It proves the composition loads, `client.js` is served and Bot state answers. It does not rehearse with a copy of the real home: Bots would run their schedules, call models through the account gateway, claim drama work through the transcription desk, and could post to Feishu.
- The switch path: `daemon-reload`, the drop-in swap, the start and the automatic rollback have not run. The quiet gate's `--allow-desk-turns` matching (Bot and session ids found in `partsRunning`, `work.turns` and `inflight`) is a text match on unseen data. Prefer waiting for a real idle moment.
- Login link delivery (`gate.py login-link` was not run, because it emits a credential).
- The signed station-events test delivery to 剧本管理 needs the secret, so it is not automated. Do it by hand after check.
- The desk (`muse-transcription-desk`) has **no pause switch**. During the stop, its watch logs `watch-skipped`. A Bot turn cut by the restart is re-prompted after two idle passes (≥10 min).

## Manual rollback (if rollback.sh cannot run)

```
systemctl stop muse-cloud
cd /var/lib/muse-cloud/home/profiles && mv muse-cloud muse-cloud.failed && mv muse-cloud.before-<short> muse-cloud
rm /etc/systemd/system/muse-cloud.service.d/release.conf
cp -p $OPS/backup/dropin/script-editor-release.conf /etc/systemd/system/muse-cloud.service.d/
cp -p $OPS/backup/cloud.patch.yml.before /opt/muse/cloud/config/cloud.patch.yml
systemctl daemon-reload && systemctl start muse-cloud
```

Then set `"paused": false` in `control.json` only if `$OPS/runner-pause.json` says `"wePaused": true`.

## Cleanup later (not scripted)

- After a week: `profiles/muse-cloud.before-<short>`, `$OPS/backup/home-state.tar` (it contains secret files, root 0600) and `$OPS/dump/*`.
- Keep `releases/20261123-script-editor-5f79885239` while the preview units use it.
