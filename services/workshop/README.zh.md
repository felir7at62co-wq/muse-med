# 剧本工坊

[English](README.md) | 中文

剧本工坊（Script Workshop）是 Muse 旁边的云端剧本工作台。FastAPI 后端保存草稿、大纲、定稿剧本，运行创作、裂变、分发和转写剧本的工厂任务，并管理用户的账号和积分。Next.js 前端是工作台网页。Muse 通过[工作台登录适配器](../muse-workbenches/README.zh.md)让用户登录，把视频转剧本作为工坊的工厂任务运行，并把定稿剧本存进工坊。

## 云端运行方式

云端在 Muse 共享工作台主机的 `/jubengongfang/` 路径下提供工坊。后端以 `app.main:app` 在 uvicorn 下运行，配有独立的 PostgreSQL 数据库、Redis 和任务 worker，上传目录为 `UPLOADS_DIR`。前端是 base path 为 `/jubengongfang` 的 Next.js standalone 构建，构建时设置 `NEXT_PUBLIC_ORCHESTRATOR_URL=/jubengongfang`。[`../muse-workbenches/shared-host`](../muse-workbenches/shared-host/nginx_locations.py) 中的路径代理对每个业务请求检查 Muse 会话和账号映射。

## 来源

本目录是 2026 年 11 月 17 日工作台备份中的工坊源码：`01-drama/code/services/orchestrator` 作为 `backend/`，`01-drama/code/apps/web` 作为 `frontend/`，含网页的 lockfile。未收录备份中的 `.legacy_backups/`、`*.backup-*` 副本、`public/report/`（周报页面及其媒体）、数据 CSV、orchestrator 的 Dockerfile、演示脚本、SQL 文件和 `.env` 示例、`scripts/agent_eval/README.md` 及其输入 `long_task.txt`、`tsconfig.tsbuildinfo`、`node_modules` 和构建产物。`backend/requirements.txt` 按云端运行环境的 `pip freeze` 固定包版本。

除以下改动外，本目录与备份逐字节一致：

- `app/agent/chat_jobs.py`、`app/agent/chat_skills.py`、`app/agent/job_status.py`、`app/agent/routes.py`、`app/agent_engine/tools.py`、`app/features/preview_routes.py`、`app/stages/adaptation.py`、`app/stages/drama_gate.py`、`app/stages/router.py`、`app/stages/user_plan.py`、`alembic/versions/20261011_history_job_id.py` 和 `frontend/components/workbench/ChatColumn.tsx` 的注释与 docstring 用 用户甲 代替用户姓名。
- `app/config.py` 和 `scripts/setup_oss_cors.py` 的注释以及 `frontend/public/static/download_videos.py` 的帮助文字用 `<公网地址>` 代替服务器的公网 IP。
- `app/frontcut/routes.py` 从 `FEISHU_LINK_LIBRARY_URL` 读取批量反推页的默认飞书表（短剧链接库），`app/feishu/routes.py` 从 `FEISHU_PRODUCTION_TABLE_URL` 读取飞书自动化的固定制作表格，不再写死公司租户的知识库和数据表 ID。两项设置默认为空；此时依赖默认表的请求返回 400 并要求提供表格链接。在服务器上设置这两项即可保持现有行为。
- `scripts/setup_oss_cors.py` 从 `OSS_CORS_PUBLIC_ORIGINS`（逗号分隔）添加公网来源，不再写死服务器地址；用户下载脚本 `public/static/download_videos.py` 和 `public/static/rename_videos_auto.py` 从 `--base` 或第一个 `http(s)://` 参数、或 `DRAMA_API_BASE` 取服务器地址，都未提供时给出提示并退出。

云端发布尚未从本目录构建，而是本源码再加上 [`../muse-workbenches`](../muse-workbenches/README.zh.md) 中安装时套用的改动：`install.py --audience script-workshop` 加入 Muse 登录和 Muse 视频反推执行器，`shared-host/prepare_uploads.py` 把上传路径移到 `UPLOADS_DIR` 下，`shared-host/prepare.py` 设置 `/jubengongfang` base path，视频转剧本和剧本库的安装脚本加入各自的路由和页面。

## 目录结构

| 路径 | 内容 |
|---|---|
| `backend/app/` | FastAPI 应用，以 `app.main:app` 提供服务；任务 worker 为 `app/worker.py` |
| `backend/alembic/`、`backend/alembic.ini` | 数据库迁移 |
| `backend/scripts/` | 迁移、初始化数据、验证和评测脚本 |
| `backend/pyproject.toml`、`backend/requirements.txt` | 声明的依赖范围和固定的云端运行环境 |
| `frontend/` | Next.js 应用，含 `package.json` 和 `pnpm-lock.yaml` |

## 测试与检查

云端运行环境使用 Python 3.12。在仓库外创建虚拟环境，并在 `backend/` 下检查所有模块均可编译：

```sh
uv venv --python 3.12 ~/.venvs/workshop
uv pip install --python ~/.venvs/workshop/bin/python -r requirements.txt
~/.venvs/workshop/bin/python -m compileall -q app
```

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
