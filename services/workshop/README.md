# Script Workshop

English | [中文](README.zh.md)

Script Workshop (剧本工坊) is the cloud script studio beside Muse. Its FastAPI backend holds drafts, outlines, finalized scripts, the factory jobs that create, adapt, distribute and transcribe scripts, and the accounts and credits of its users. Its Next.js frontend is the studio web page. Muse signs users in through the [workbench login adapter](../muse-workbenches/README.md), runs 视频转剧本 as a Workshop factory job and stores finalized scripts in Workshop.

## How it runs in the cloud

The cloud serves Workshop on the shared Muse workbench host at `/jubengongfang/`. The backend runs as `app.main:app` under uvicorn with its own PostgreSQL database, Redis and job worker, and its uploads volume is `UPLOADS_DIR`. The frontend is a Next.js standalone build with the base path `/jubengongfang`, built with `NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang`. The path proxy in [`../muse-workbenches/shared-host`](../muse-workbenches/shared-host/nginx_locations.py) checks the Muse session and the account mapping on every business request.

## Source

This tree is the Workshop source that the cloud runs. It is the Workshop source of the November 17, 2026 workbench backup, `01-drama/code/services/orchestrator` as `backend/` and `01-drama/code/apps/web` as `frontend/` including the web lockfile, with the Muse changes that the install-time overlays in [`../muse-workbenches`](../muse-workbenches/README.md) add:

- Muse login: `app/muse_login.py`, `app/muse_login.js` and `app/muse_storage.js`, mounted in `app/main.py`, with the frontend's login, register and Feishu pages and `lib/auth.ts` sending users through it.
- Muse video reverse: `app/muse_reverse.py`, `app/reverse_routes.py` and `app/reverse_storage.py`, used by `app/features/video_routes.py`, `app/video/video_pipeline.py` and `app/tikhub/routes.py`, with the upload dialog and `lib/workshop_video_intake.ts`.
- Upload paths: `app/agent/images.py`, `app/dev_ab_deai.py`, `app/dev_image/routes.py`, `app/draft_cover/routes.py`, `app/features/theme_routes.py` and `app/production_image/routes.py` write under `UPLOADS_DIR` instead of `/app/uploads`.
- Base path: `next.config.mjs` sets `basePath: "/jubengongfang"` and `output: "standalone"`, and pages that build absolute links or call `/v1/` directly include the prefix.
- 视频转剧本: the factory job `app/factory/video_transcribe.py`, its routes, pipeline step and startup recovery in `app/factory/routes.py`, `app/factory/pipeline.py` and `app/main.py`, and its editor and status in `app/factory/_PipelinePanel.tsx`, `app/factory/page.tsx` and `app/factory/jobs/[id]/`.
- Script library: `app/script_library.py`, the store of finalized scripts, mounted in `app/main.py`.

`backend/app` equals the application of cloud release `20261120-scripts-01` and `frontend/` equals the source of the live web build, apart from the edits listed below. Left out are the backup's `.legacy_backups/`, `*.backup-*` copies, `public/report/` (weekly report pages and their media), data CSVs, the orchestrator's Dockerfile, demo scripts, SQL file and `.env` examples, `scripts/agent_eval/README.md` and its `long_task.txt` input, `tsconfig.tsbuildinfo`, `node_modules` and build output. `backend/requirements.txt` pins the packages of the cloud runtime from its `pip freeze`.

The tree matches the backup and the overlays byte for byte apart from these edits:

- Comments and docstrings in `app/agent/chat_jobs.py`, `app/agent/chat_skills.py`, `app/agent/job_status.py`, `app/agent/routes.py`, `app/agent_engine/tools.py`, `app/features/preview_routes.py`, `app/stages/adaptation.py`, `app/stages/drama_gate.py`, `app/stages/router.py`, `app/stages/user_plan.py`, `alembic/versions/20261011_history_job_id.py` and `frontend/components/workbench/ChatColumn.tsx` say 用户甲 instead of a user's name.
- Comments in `app/config.py` and `scripts/setup_oss_cors.py`, and the help text of `frontend/public/static/download_videos.py`, say `<公网地址>` instead of the server's public IP address.
- `app/frontcut/routes.py` reads the default Feishu table of the batch reverse page (短剧链接库) from `FEISHU_LINK_LIBRARY_URL`, and `app/feishu/routes.py` reads the fixed production table of the Feishu automation (制作表格) from `FEISHU_PRODUCTION_TABLE_URL`, instead of hardcoding the company tenant's wiki and table IDs. Both settings default to empty; a request that relies on the default table then answers 400 and asks for a table link. Set both on the server to keep today's behaviour.
- `scripts/setup_oss_cors.py` adds the public origins in `OSS_CORS_PUBLIC_ORIGINS` (comma-separated) instead of the server's hardcoded addresses, and the user download scripts `public/static/download_videos.py` and `public/static/rename_videos_auto.py` take the server address from `--base` or the first `http(s)://` argument, or from `DRAMA_API_BASE`, and stop with a message when none is given.

This tree is now the source of truth for Workshop. The cloud release is still built by applying `install.py --audience script-workshop`, `shared-host/prepare_uploads.py`, `shared-host/prepare.py` and the 视频转剧本 and script library installers to the backup; those installers stay until a release is built from this tree.

## Layout

| Path | Contents |
|---|---|
| `backend/app/` | FastAPI application, served as `app.main:app`, and the job worker `app/worker.py` |
| `backend/alembic/`, `backend/alembic.ini` | Database migrations |
| `backend/scripts/` | Migration, seed, verification and evaluation scripts |
| `backend/pyproject.toml`, `backend/requirements.txt` | Declared dependency ranges and the pinned cloud runtime |
| `frontend/` | Next.js application with its `package.json` and `pnpm-lock.yaml` |

## Tests and checks

The cloud runtime uses Python 3.12. Create the virtual environment outside the repository and check from `backend/` that every module compiles:

```sh
uv venv --python 3.12 ~/.venvs/workshop
uv pip install --python ~/.venvs/workshop/bin/python -r requirements.txt
~/.venvs/workshop/bin/python -m compileall -q app
```

Importing the application also needs the Muse login settings (`MUSE_WORKBENCH_ISSUER`, `MUSE_WORKBENCH_PUBLIC_ORIGIN`, `MUSE_WORKBENCH_SECRET`, `MUSE_WORKBENCH_BINDINGS`, `MUSE_WORKBENCH_STATE_DB`), `AUTH_REQUIRED=true`, a `JWT_SECRET` of at least 32 characters and `UPLOADS_DIR`. With placeholder values and a bindings file without users, `import app.main` and every module under `app` load without connecting to the database or Redis.

Build the frontend from `frontend/` with the pnpm version that wrote the lockfile:

```sh
npx pnpm@9.15.9 install --frozen-lockfile
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang npx pnpm@9.15.9 exec next build
```

`next build` also runs Next's lint and type checks.

## Repository attributes

The root `.gitattributes` exempts 43 imported files from `git diff --check` because they keep the trailing whitespace or final blank line of the source, and marks the frontend's PNG and WebP images binary. lefthook's staged lint job skips `frontend/`, so a commit does not reformat the imported TypeScript. `services/workshop/.gitignore` keeps caches, virtual environments, local databases, `.env` files, `node_modules` and Next output out of the tree, and keeps `frontend/lib/` in it despite the repository's `lib/` rule.

## Not in this repository

Workshop's own documents, the admin and downloader apps, infrastructure files, top-level scripts and the report pages remain in the November 17 backup.
