# Data station

English | [中文](README.zh.md)

The data station (数据站) is Muse's work-data site at `/data/` on the Muse website. It collects the public rankings of Hongguo, Fanqie and Qimao into its own PGlite database, searches Douyin and saves Douyin videos to TOS, takes the 绿泡泡 rankings that a Mac collector pushes, keeps the scripts and original novels that members obtained, and runs the 储备看板, which selects hit dramas every day and tracks their transcription jobs. The client is React built by Vite; the server is Hono on Node, bundled by esbuild into one file.

Muse uses the station in three ways:

- Desktop Muse reads rankings, the 储备看板 and 立即转写 through the member routes with the signed-in account ([`muse-account/src/data-station.ts`](../../packages/host/muse-account/src/data-station.ts)).
- The [hit transcription worker](../../integrations/muse-hit-transcription/README.md) and the [`tool-hit-queue`](../../packages/drama/tool-hit-queue/README.md) tool claim and report transcription jobs through `/api/service/hits` with the station service token.
- The station pushes 储备 job changes to cloud Muse's route `/api/muse/station-events`, which wakes the Bot that supervises transcription ([`station-events.js`](../../third_party/plugins/ds-bot/src/host/station-events.js)).

## How it runs in the cloud

The cloud runs the station as the systemd service `muse-data-web` under its own user `muse-data-web`. The service runs the station's own Node 24.21.0 at `/srv/muse-data-web/runtime/node` on `/srv/muse-data-web/app/dist-server/main.js` with `/srv/muse-data-web/app` as working directory, listens on `127.0.0.1:19617` only, and reads its settings from `/srv/muse-data-web/access/server.env`, whose template is [`deploy/server.env.example`](deploy/server.env.example). The Muse site's nginx forwards `/data/` to it ([location template](deploy/nginx-data-location.muse-session.conf.example)). The state is the PGlite database in `app/.data/live`, which allows exactly one writer process; identities, tokens, the TOS key and the 储备 push secret are private files in `/srv/muse-data-web/access`. The timer `muse-data-feishu-links.timer` runs [`deploy/export-muse-feishu-links.py`](deploy/export-muse-feishu-links.py) every 10 minutes to export the Muse-account-to-Feishu links by which the station admits members.

## Source

This tree is commit `e53565b` of the muse-data-web repository (branch `codex/station-events`, November 20, 2026), which is what the cloud runs. A build of this tree reproduces the live files byte for byte: `dist-server/main.js` (SHA-256 `42b4b326…30ed`), and, built with the base `/data/`, `index.html`, `assets/index-DoFW9Osb.js`, `assets/index-SWNgSPoH.css` and `muse-mark.svg`. The live `package.json`, `pnpm-lock.yaml`, `scripts/setup-novel-runtime.mjs`, `third_party/fanqie-original/` and Qimao license files equal this tree's.

The last full release, made by `scripts/prepare-cloud-release.mjs` on November 17, is commit `1252dbd`, which the server's `RELEASE.json` still names. Later updates replaced single built files in `/srv/muse-data-web/app`; each build below reproduces the file that the next update backed up:

| Server date | Replaced | Built from |
|---|---|---|
| November 20 | client assets | `3a630fe`: search the 储备看板 by title or Hongguo ID |
| November 20 | client assets | `8f453d1`: start transcription from 作品数据 |
| November 20 | client assets | `2e3b547`: keep the search responsive while the board loads (live client) |
| November 20 | `dist-server/main.js` | `ed994ea`: board reads without a full scan, with a one-time `VACUUM FULL` of `hit_candidates` |
| November 20 | `dist-server/main.js` | `0680436`: member routes for desktop Muse |
| November 21 | `dist-server/main.js` | `e53565b`: the 储备 push, with its two settings added to `server.env` (live server) |

These commits form one line from `1252dbd` to `e53565b`, so no merge was needed, and the client source did not change after `2e3b547`. `app/dist/assets` on the server still holds the earlier bundles; `index.html` loads only the live pair.

Left out are the repository history, `.env.example`, whose values are the defaults in `src/server/config.ts`, and every ignored path, such as `.data/`, `node_modules/`, `dist/`, `dist-server/`, `artifacts/` and `test-results/`. The tree matches commit `e53565b` byte for byte apart from these edits, none of which reaches a built file:

- The project README moved to [`docs/overview.md`](docs/overview.md), with its links rebased to `docs/`.
- Tests, `docs/hit-transcription.md`, `docs/server-identity.md`, `deploy/server.env.example` and a comment in `src/shared/types.ts` say 用户甲, 用户甲组, 甲组成员 and 用户乙 instead of two colleagues' names and a department named after one of them, and `usera` and `userb` instead of their usernames.
- The 绿泡泡 collector's default host label, its example config, `docs/lvpaopao.md` and its tests say `collector-mac` instead of a Mac's host name. A new collector install whose config has no `host` reports `collector-mac`.
- `.gitignore` also ignores `.env.*` and keeps `third_party/fanqie-original/vendor/signer/lib/` in despite the repository's `lib/` rule.

## Layout

| Path | Contents |
|---|---|
| `src/server/` | Hono server: collectors, discovery, hit selection and jobs, Douyin search and downloads, novels, identity and the PGlite repository; `main.ts` is the bundle entry |
| `src/client/` | React client served at `/data/` |
| `src/shared/` | Types and schemas that the server and client share |
| `tests/` | Vitest suites; `tests/browser/` holds the Playwright suites |
| `scripts/` | Cloud release packager, Python runtime setup for novel downloads, local isolation check |
| `deploy/` | systemd units, nginx location templates, settings and identity templates, the Feishu link export and the Chinese deploy guide |
| `third_party/fanqie-original/` | Python worker for Fanqie original downloads, shipped in the release |
| `mac-collectors/lvpaopao/` | Mac collector that pushes 绿泡泡 rankings to the station; it runs on a Mac, not on the server |
| `docs/` | Chinese documents: overview, API, architecture, Crawlee, hit transcription, 绿泡泡 and identity |

## Build and test

The station keeps its own `package.json` and `pnpm-lock.yaml` and is not a member of the repository's pnpm workspace, so the repository install and build leave it out. Run these from `services/data-station` with Node 24:

```sh
pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run build
pnpm run test:browser
```

`--ignore-workspace` installs the station's own lockfile instead of the repository workspace. `--ignore-scripts` skips the install scripts of esbuild and `tos-crc64-js`, which pnpm 10 and later reject without an allow list; the cloud release installs its production dependencies with the same flag. `pnpm run build` type-checks, builds the client into `dist/` with the base `/`, and bundles the server into `dist-server/main.js`. `test:browser` starts the built server on `127.0.0.1:4318` with a temporary database and drives Google Chrome from `/Applications`. The Python suites run with `python3 -m unittest discover -s tests` in `mac-collectors/lvpaopao`, and with `python3 -m unittest test_worker` in `third_party/fanqie-original` after installing its `requirements.txt` into a virtual environment outside the repository.

The cloud bundles come from these two commands; the client uses the base `/data/`:

```sh
pnpm exec esbuild src/server/main.ts --bundle --platform=node --format=esm --packages=external --outfile=dist-server/main.js
pnpm exec vite build --base=/data/ --outDir=<output>/dist --emptyOutDir
```

## Deploy

A deploy changes only `/srv/muse-data-web` and restarts only `muse-data-web`; `app/.data` stays in place and gets a backup. PGlite has one writer, so never run a second copy against `.data/live`. Each restart briefly interrupts the members' pages and the transcription worker's station calls.

When `package.json` and `pnpm-lock.yaml` are unchanged, replace the built files, as the November 20 and 21 updates did:

1. Build `dist-server/main.js` and the `/data/` client from a commit with the two commands above, on the Mac, and record the SHA-256 of every output file.
2. Copy the files to a new directory under `/root` on the server and check their hashes.
3. Add new settings to `/srv/muse-data-web/access/server.env`, after copying it next to the files; a setting that the new build requires stops it at start.
4. Run `systemctl stop muse-data-web` and confirm that no process runs `/srv/muse-data-web/app/dist-server/main.js`.
5. Copy `app/.data/live` to `/srv/muse-data-web/backups/data-before-<commit>-<UTC time>`.
6. Keep a copy of the current `dist-server/main.js` next to the new one, then install the new one with `install -m 0644 -o root -g root`. For a client change, copy `app/dist` to `app/dist.before-<change>-<date>`, add the new files in `assets/`, and replace `index.html` last.
7. Run `systemctl start muse-data-web`, wait until `https://<Muse site>/data/api/health` answers 200 through a signed-in session, and read `journalctl -u muse-data-web` for start errors.

When dependencies change, build a full release. Commit, run `pnpm run build` and then `node scripts/prepare-cloud-release.mjs` in `services/data-station`. The packager refuses uncommitted changes in this directory, builds the `/data/` client itself, installs production dependencies in a separate staging directory, and writes the archive, its SHA-256 and its manifest to `artifacts/cloud-release-*`. Then follow 后续升级与恢复 in [`deploy/README.md`](deploy/README.md): stop the station, back up `.data/live`, replace `app` with the checked release while keeping `.data`, and start only the station. First-time setup, the runtime, the service user, nginx and identities are also described there.

## Repository settings

The root `.gitattributes` exempts `docs/hit-transcription.md` (trailing whitespace) and `src/server/novels/README.md` (final blank line) from `git diff --check`. The staged lint job in `lefthook.yml`, `.oxlintrc.json`, `scripts/verify-no-unknown-casts.ts` and `scripts/verify-repository-references.ts` skip `services/data-station/`, so the imported TypeScript keeps its own style and casts and its references to the Muse commits that its parsers were extracted from. `scripts/translation-pairing.manifest.json` exempts the Chinese-only READMEs under `deploy/`, `mac-collectors/`, `src/` and `third_party/` from bilingual pairing.

## Not in this repository

The muse-data-web repository keeps the history and branches; its branch `codex/muse-data-douyin-source-management-20261113` holds four commits that are not in this tree. Its ignored `artifacts/` directory keeps the release receipts, research files and screenshots. Server state, private files and backups stay on the server.
