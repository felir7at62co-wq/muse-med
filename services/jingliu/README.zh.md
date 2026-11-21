# 镜流后端

[English](README.md) | 中文

镜流是 Muse 的制片引擎。其 FastAPI 服务接入视频、图片、配音、语音识别、超分和字幕擦除的生成供应商。任务队列对重复提交去重，并按积分账本结算每个任务的花费。数据库保存项目、分集、镜头、资产、站位图、字幕和音频。一键批量流程把一个制片步骤应用到整集。

## Muse 如何调用

Muse 通过已登录的[镜流连接](../../packages/drama/jingliu-connection/README.zh.md)访问制片站的 `/fwp/v2` 接口。包括 `jingliu_run` 在内的[镜流工具](../../packages/drama/tool-jingliu/README.zh.md)从 `GET /desktop-agent/tools` 读取流程目录，用 `POST /desktop-agent/quote` 报价，再用 `POST /desktop-agent/tool` 执行。Muse 的制片面板使用同一连接。

## 来源

此目录是云端发布 `20261121-jingliu-blocking-01` 的后端，即 2026-11-17 工作台备份加上四项已部署改动。镜头脚本改由 Muse 撰写并锁定，取代镜流自己的提示词撰写。存库的报错、任务结果和日志中的密钥已脱敏。`FW_ARK_TRUSTED_ASSETS` 把人像参考图入库交给模型网关，首帧生成已下线。站位图单独保存并绑定到镜头。除 Muse 登录适配和以下几处外，`backend/app` 与该发布逐字节一致：`app/at_refs.py`、`app/auth.py`、`app/budget.py`、`app/jobs.py`、`app/notify.py`、`app/routers/library.py`、`app/routers/shots.py` 和 `app/user_directory.py` 的注释与文档字符串用占位值代替用户和管理员的姓名、一个昵称和 IP 地址，`app/config.py` 中 `feishu_notify_contact` 的默认值是「管理员」，而不是一位管理员的姓名。

登录适配不在此目录中，由 [`../muse-workbenches/install.py`](../muse-workbenches/install.py) 在安装时写入发布副本。云端发布包含适配中的登录和共享素材库改动，但不包含安装器对剪映导出的适配。

## 目录结构

| 路径 | 内容 |
|---|---|
| `backend/app/` | FastAPI 应用，以 `app.main:app` 启动 |
| `backend/tests/` | pytest 测试；`tests/data` 存放文本夹具 |
| `backend/scripts/` | 静态代码检查，以及配乐库和音效库的导入脚本 |
| `backend/requirements.txt` | 固定版本的依赖 |

## 测试与静态检查

云端运行环境使用 Python 3.12。除 `requirements.txt` 外还需要 python-multipart、`pyJianYingDraft==0.3.1`、Pillow 和 numpy，该文件未列出这些包。在仓库之外创建虚拟环境，并在 `backend/` 下运行：

```sh
uv venv --python 3.12 ~/.venvs/jingliu
uv pip install --python ~/.venvs/jingliu/bin/python -r requirements.txt python-multipart pyJianYingDraft==0.3.1 pillow numpy pytest pyflakes
~/.venvs/jingliu/bin/python -m pytest tests
~/.venvs/jingliu/bin/python scripts/check_undefined_names.py
```

测试使用临时 SQLite 数据库和数据目录，不访问网络。`check_lazy_imports.py`、`check_module_attrs.py` 和 `check_self_misuse.py` 只解析 `app/` 的源码，不导入它。`check_undefined_names.py` 调用 pyflakes。

## 仓库属性

根目录的 `.gitattributes` 涉及八个导入文件。三个 `jianying_pack/*.bat` 设为 `-text`，因此 Git 不会转换 Windows 用户收到的 CRLF 换行。五个应用文件保留已部署版本中的行尾空格或末尾空行，因此不参与 `git diff --check`。

## 不在仓库中的内容

旧版制片站网页前端只在云端服务器和 11-17 备份中。镜流自己的文档、`backend/tools/`、一次性验证与审计脚本、后端顶层的测试脚本和 A/B 结果文件、Dockerfile 以及镜流原 README 保留在该备份和维护者的本地源码副本中。

## 已知限制与后续工作

Muse 将移除或替换镜流自己的模型驱动步骤、LangGraph 智能体和飞书机器人、Muse 不使用的代码，以及 Muse 账号与镜流账号之间单独的登录和扣费桥接。旧网站保留到 Muse 网页控制台上线。

已部署代码上有两项静态检查不通过。`check_module_attrs.py` 报告 `app/feishu_bot.py` 调用的 `agent_run.ResumeIn` 在 `app/routers/agent_run.py` 中没有定义。`check_undefined_names.py` 报告 `app/routers/shotflow.py:448` 的字符串注解 `"asyncio.Lock"`，其白名单条目记录的是第 395 行。
