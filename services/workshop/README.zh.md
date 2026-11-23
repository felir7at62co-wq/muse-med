# 剧本工坊

[English](README.md) | 中文

剧本工坊（Script Workshop）是 Muse 旁边的云端剧本工作台。FastAPI 后端保存草稿、大纲、定稿剧本，运行创作、裂变、分发和转写剧本的工厂任务，并管理用户的账号和积分。Next.js 前端是工作台网页。Muse 通过[工作台登录适配器](../muse-workbenches/README.zh.md)让用户登录，把视频转剧本作为工坊的工厂任务运行，并把定稿剧本存进工坊。

## 云端运行方式

云端在 Muse 共享工作台主机的 `/jubengongfang/` 路径下提供工坊。后端以 `app.main:app` 在 uvicorn 下运行，配有独立的 PostgreSQL 数据库、Redis 和任务 worker，上传目录为 `UPLOADS_DIR`。前端是 base path 为 `/jubengongfang` 的 Next.js standalone 构建，构建时设置 `NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang`。[`../muse-workbenches/shared-host`](../muse-workbenches/shared-host/nginx_locations.py) 中的路径代理对每个业务请求检查 Muse 会话和账号映射。

## Muse 草稿编辑

`/v1/script-editor` 使用编辑的工坊账号新建空白草稿，或导入 Word、Markdown、UTF-8 文本和结构化分集内容，导入过程无需启动生成任务。文件导入从不超过 4 MiB 的文件中提取可编辑文本，并识别分集标题。结构化导入保留原有分场顺序和附加字段。

草稿所有者和管理员可编辑每集正文和结构化分场，预览两类历史版本，恢复已保存的版本，以及导出 Word、Markdown 或纯文本。保存、采纳正文候选稿和恢复均校验当前版本，并在同一事务中归档修改前的版本。完整草稿由所有者定稿。定稿校验整稿版本并复用该草稿的剧本库条目，已选用的版本保持有效。

## 来源

本目录是云端运行的工坊源码，即 2026 年 11 月 17 日工作台备份中的工坊源码（`01-drama/code/services/orchestrator` 作为 `backend/`，`01-drama/code/apps/web` 作为 `frontend/`，含网页的 lockfile），加上 [`../muse-workbenches`](../muse-workbenches/README.zh.md) 中安装时套用的 Muse 改动：

- Muse 登录：`app/muse_login.py`、`app/muse_login.js` 和 `app/muse_storage.js`，挂载在 `app/main.py`；前端的登录、注册和飞书页面以及 `lib/auth.ts` 让用户经由它登录。
- Muse 视频反推：`app/muse_reverse.py`、`app/reverse_routes.py` 和 `app/reverse_storage.py`，由 `app/features/video_routes.py`、`app/video/video_pipeline.py` 和 `app/tikhub/routes.py` 调用，配合上传对话框和 `lib/workshop_video_intake.ts`。
- 上传路径：`app/agent/images.py`、`app/dev_ab_deai.py`、`app/dev_image/routes.py`、`app/draft_cover/routes.py`、`app/features/theme_routes.py` 和 `app/production_image/routes.py` 写入 `UPLOADS_DIR` 而不是 `/app/uploads`。
- Base path：`next.config.mjs` 设置 `basePath: "/jubengongfang"` 和 `output: "standalone"`，拼接绝对链接或直接调用 `/v1/` 的页面带上该前缀。
- 视频转剧本：工厂任务 `app/factory/video_transcribe.py`，`app/factory/routes.py`、`app/factory/pipeline.py` 和 `app/main.py` 中的路由、流水线步骤和启动恢复，以及 `app/factory/_PipelinePanel.tsx`、`app/factory/page.tsx` 和 `app/factory/jobs/[id]/` 中的编辑器和状态显示。
- 剧本库：定稿剧本库 `app/script_library.py`，挂载在 `app/main.py`。

除下列改动和尚未部署的改动外，`backend/app` 与云端发布 `20261120-scripts-01` 的应用一致，`frontend/` 与线上网页构建的源码一致。未收录备份中的 `.legacy_backups/`、`*.backup-*` 副本、`public/report/`（周报页面及其媒体）、数据 CSV、orchestrator 的 Dockerfile、演示脚本、SQL 文件和 `.env` 示例、`scripts/agent_eval/README.md` 及其输入 `long_task.txt`、`tsconfig.tsbuildinfo`、`node_modules` 和构建产物。`backend/requirements.txt` 按云端运行环境的 `pip freeze` 固定包版本。

除以下改动外，本目录与备份及安装改动逐字节一致：

- `app/agent/chat_jobs.py`、`app/agent/chat_skills.py`、`app/agent/job_status.py`、`app/agent/routes.py`、`app/agent_engine/tools.py`、`app/features/preview_routes.py`、`app/stages/adaptation.py`、`app/stages/drama_gate.py`、`app/stages/router.py`、`app/stages/user_plan.py`、`alembic/versions/20261011_history_job_id.py` 和 `frontend/components/workbench/ChatColumn.tsx` 的注释与 docstring 用 用户甲 代替用户姓名。
- `app/config.py` 和 `scripts/setup_oss_cors.py` 的注释以及 `frontend/public/static/download_videos.py` 的帮助文字用 `<公网地址>` 代替服务器的公网 IP。
- `app/frontcut/routes.py` 从 `FEISHU_LINK_LIBRARY_URL` 读取批量反推页的默认飞书表（短剧链接库），`app/feishu/routes.py` 从 `FEISHU_PRODUCTION_TABLE_URL` 读取飞书自动化的固定制作表格，不再写死公司租户的知识库和数据表 ID。两项设置默认为空；此时依赖默认表的请求返回 400 并要求提供表格链接。在服务器上设置这两项即可保持现有行为。
- `scripts/setup_oss_cors.py` 从 `OSS_CORS_PUBLIC_ORIGINS`（逗号分隔）添加公网来源，不再写死服务器地址；用户下载脚本 `public/static/download_videos.py` 和 `public/static/rename_videos_auto.py` 从 `--base` 或第一个 `http(s)://` 参数、或 `DRAMA_API_BASE` 取服务器地址，都未提供时给出提示并退出。

本目录中云端尚未运行的改动：`app/factory/pipeline.py` 只有一个视频转剧本步骤。发布版本里该步骤出现两次，因为两个版本的安装脚本各插入了一次；实际运行的第一份把已停止的任务改回 `pending` 重启，却保留了停止请求，任务随即再次停止。保留的步骤用 `video_transcribe.reopen` 重开任务：清除停止请求和上次结束状态，保留已有结果和已领取的剧，与 `POST /v1/factory/jobs/{id}/resume` 一致。

本目录现在是工坊的唯一源码。云端发布仍由 `install.py --audience script-workshop`、`shared-host/prepare_uploads.py`、`shared-host/prepare.py` 以及视频转剧本和剧本库的安装脚本套用到备份上构建；在从本目录构建发布之前，这些安装脚本保留。

## 目录结构

| 路径 | 内容 |
|---|---|
| `backend/app/` | FastAPI 应用，以 `app.main:app` 提供服务；任务 worker 为 `app/worker.py` |
| `backend/alembic/`、`backend/alembic.ini` | 数据库迁移 |
| `backend/scripts/` | 迁移、初始化数据、验证和评测脚本 |
| `backend/tests/` | 视频转剧本和 Muse 草稿编辑的 unittest 测试 |
| `backend/pyproject.toml`、`backend/requirements.txt` | 声明的依赖范围和固定的云端运行环境 |
| `frontend/` | Next.js 应用，含 `package.json` 和 `pnpm-lock.yaml` |

## 测试与检查

云端运行环境使用 Python 3.12。在仓库外创建虚拟环境，并在 `backend/` 下检查所有模块均可编译：

```sh
uv venv --python 3.12 ~/.venvs/workshop
uv pip install --python ~/.venvs/workshop/bin/python -r requirements.txt
~/.venvs/workshop/bin/python -m compileall -q app
```

导入应用还需要 Muse 登录设置（`MUSE_WORKBENCH_ISSUER`、`MUSE_WORKBENCH_PUBLIC_ORIGIN`、`MUSE_WORKBENCH_SECRET`、`MUSE_WORKBENCH_BINDINGS`、`MUSE_WORKBENCH_STATE_DB`）、`AUTH_REQUIRED=true`、至少 32 个字符的 `JWT_SECRET` 以及 `UPLOADS_DIR`。使用占位值和不含用户的 bindings 文件时，`import app.main` 和 `app` 下的所有模块均可加载，不连接数据库或 Redis。

在 `backend/` 下运行 `~/.venvs/workshop/bin/python -m unittest discover -s tests` 执行视频转剧本和草稿编辑测试。草稿编辑测试使用临时 SQLite 文件，需要 `aiosqlite` 开发依赖。将 `MUSE_SCRIPT_EDITOR_TEST_POSTGRES_URL` 指向使用 `postgresql+psycopg` 和 `127.0.0.1` 的临时 PostgreSQL，即可在独立 schema 中验证并发保存和定稿。

在 `frontend/` 下用写出 lockfile 的 pnpm 版本构建前端：

```sh
npx pnpm@9.15.9 install --frozen-lockfile
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang npx pnpm@9.15.9 exec next build
```

`next build` 同时运行 Next 的 lint 和类型检查。

## 仓库属性

根目录 `.gitattributes` 让 43 个导入文件免于 `git diff --check`，因为它们保留了源码的行尾空白或末尾空行；并把前端的 PNG 和 WebP 图片标为二进制。lefthook 的暂存区 lint 任务跳过 `frontend/`，提交时不会改写导入的 TypeScript。`services/workshop/.gitignore` 把缓存、虚拟环境、本地数据库、`.env` 文件、`node_modules` 和 Next 输出排除在外，并在仓库的 `lib/` 规则下保留 `frontend/lib/`。

## 不在本仓库中

工坊自己的文档、admin 和 downloader 应用、基础设施文件、顶层脚本以及周报页面仍只在 11 月 17 日备份中。
