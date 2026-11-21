"""FilmWeaver 后端入口（dev）。云端隐形生成后端，供 Tauri 桌面客户端调用。"""
from __future__ import annotations

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request as _RoleReq

from .access import (ROLE_EDITOR, ROLE_VIEWER, can_access_project,
                     collect_project_ids, enforce_role, project_id_in_path,
                     project_ids_in_body, request_project_ids, set_current_user,
                     set_request_level, set_request_project_ids)
from .auth import (apply_admin_overrides, cleanup_expired_sessions, router as auth_router,
                   seed_known_users, verify_session)
from .config import get_settings
from .executors import run_long_blocking
from .db import init_db
from .feishu_bot import router as feishu_bot_router  # 同时注册三张机器人表，须在 init_db 之前导入
from .maintenance import (SWEEP_INTERVAL_SEC, backup_sqlite,
                          recover_zombie_tasks, sweep_orphaned_states,
                          sweep_stale_agent_runs)
from .media import DATA_DIR, router as media_router
from .migrations import run_migrations
from .providers.registry import register_defaults, registry
from .routes_v2 import router as v2_router
# 新路由进 routers/ 子模块（routes_v2.py 的行数预算是「只许减」）。
# 前缀同样是 /v2：对前端来说没有"新旧两套 API"，只是后端换了个文件放。
#
# ⚠️ **子模块在这里直接 include，不要嵌套进 v2_router**。子模块自带
# `prefix="/v2"`，而 `include_router` 会把父 router 的前缀再叠一层 ——
# 嵌套的结果是 `/v2/v2/transitions`（2026-09-18 实测踩过：路由表里查不到、
# OpenAPI 里也没有，表现为"搬完路由就 404"）。本文件逐个 include 是**协议**，
# 不是风格偏好。
#
# ⚠️ **include 顺序 = 匹配优先级**。搬某个域出去时，注册位置要与它原来在
# routes_v2.py 里的相对先后一致：同方法同路径的两组、以及「通配段在前」这类
# 情形都靠顺序决定谁接客。搬完用 OpenAPI 路由表比对确认零变化。
from .routers.agent import router as agent_router
from .routers.agent_run import router as agent_run_router
from .routers.assets import router as assets_router
from .routers.audio import router as audio_router
from .routers.budget import router as budget_router
from .routers.desub import router as desub_router
from .routers.desktop_agent import router as desktop_agent_router
from .routers.drama_gateway import router as drama_gateway_router
from .routers.desktop_models import router as desktop_models_router
from .routers.transitions import router as transitions_router
from .routers.jianying import router as jianying_router
from .routers.library import router as library_router
from .routers.look import router as look_router
from .routers.project import router as project_router
from .routers.shotflow import router as shotflow_router
from .routers.shots import router as shots_router
from .routers.stage_scene import router as stage_scene_router
from .routers.subtitle import router as subtitle_router
from .routers.upscale import router as upscale_router
from .routers.usage import router as usage_router
from .routers.stats import router as stats_router
from .routers.voice import router as voice_router
from .redact import install_log_redaction

# 所有日志在格式化时去掉密钥和签名（见 app/redact.py）。
install_log_redaction()


REMINDER_INTERVAL_SEC = 20

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 慢语句/长事务探针（2026-11-03）。必须在 init_db() **之前**挂：
    # 建表、迁移、僵尸回收这些启动动作本身也可能长时间持写锁，
    # 那正是我们要观测的对象之一。`FW_DB_SLOW_LOG=0` 可整段关掉。
    from . import dbslow
    from .db import engine as _engine
    dbslow.install(_engine)

    init_db()
    # 数据安全：备份必须在 run_migrations() **之前**。
    # 原来顺序相反 —— 迁移若损坏数据，备份快照的是已损坏的库，
    # 等于没有可回滚的点，而这正是最需要备份的场景。
    # （backup_sqlite 内部按分钟防抖，崩溃循环不会把历史备份冲掉。）
    bak = backup_sqlite()
    if bak:
        print(f"[backup] {bak}")
    applied = run_migrations()
    if applied:
        print(f"[migrations] applied: {applied}")
    # 易用性：清理上次进程遗留的僵尸任务/卡态镜头/卡态旁白（否则看板永远转圈）
    z = recover_zombie_tasks()
    if z["jobs"] or z["shots"] or z["audio"]:
        print(f"[recover] 置 failed: {z['jobs']} jobs, {z['shots']} shots, "
              f"{z['audio']} audio")
    # 启动时 agent 轮的执行体必然已经不在（它只活在内存里）——不收尾的话，
    # 那个项目从此再也开不了新的一轮（409「已有一轮在进行中」）。
    sa = sweep_stale_agent_runs(at_startup=True)
    if sa["runs"]:
        print(f"[recover] agent 轮置 failed: {sa['runs']} 个，关闭审批行 {sa['closed']} 条")
    # ⚠️ 名录补录必须在清理过期会话**之前**：清掉的会话里可能有还没进名录的人
    #（见 auth.KnownUser 的说明——转交项目要按名字找到他们）。
    k = seed_known_users()
    if k:
        print(f"[auth] 用户名录补录: {k}")
    a = apply_admin_overrides()       # 本地提权名单（config.admin_user_ids）写进现存会话
    if a:
        print(f"[auth] 本地管理员提权: {a} 行")
    n = cleanup_expired_sessions()
    if n:
        print(f"[auth] 清理过期会话: {n}")
    register_defaults()
    _selfcheck_imports()
    # B14：启动清一次盖不住"进程不重启但 runner 半途丢了"的情况，
    # 挂一个常驻巡检把孤儿瞬时态收回来（判据见 sweep_orphaned_states）。
    sweeper = asyncio.create_task(_sweep_loop())
    reminder_loop = asyncio.create_task(_reminder_loop())
    # 飞书机器人长连接（没开机器人 / 不是长连接模式时什么都不做）。
    from .feishu_bot import start_long_connection
    start_long_connection(asyncio.get_running_loop())
    try:
        yield
    finally:
        sweeper.cancel()
        reminder_loop.cancel()
        # 等它真的退出，避免关停时留下 "Task was destroyed but it is pending"
        try:
            await sweeper
        except asyncio.CancelledError:
            pass
        # 2026-10-21：关停时回收上游共享 httpx 客户端。不关的话连接池会留到
        # 进程被 SIGKILL，句柄最后只由 OS 回收。
        try:
            from .providers import http as _http
            await _http.aclose_all()
        except Exception:  # noqa: BLE001 —— 关停失败不该掩盖真正的退出原因
            pass


async def _reminder_loop() -> None:
    """飞书提醒。不搭 300 秒的巡检：「三点提醒我」晚五分钟就是错的。"""
    from . import reminders

    while True:
        try:
            await asyncio.sleep(REMINDER_INTERVAL_SEC)
            await asyncio.to_thread(reminders.sweep)
            # 通宵模式的离线检测搭这趟车：同样要求准时（心跳停 5 分钟就该告诉用户）。
            from . import overnight
            await asyncio.to_thread(overnight.sweep)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logging.getLogger(__name__).exception("[reminder] 本轮失败，继续下一轮")


async def _sweep_loop() -> None:
    """孤儿瞬时态常驻巡检。单次异常不能让循环死掉——否则后面永远不再巡检。"""
    from .routers.jianying import sweep_exports

    while True:
        try:
            await asyncio.sleep(SWEEP_INTERVAL_SEC)
            await asyncio.to_thread(sweep_orphaned_states)
            # 没有执行体的 agent 轮（见 sweep_stale_agent_runs）：它会挡住该项目
            # 新建每一轮，用户看到的是「已有一轮在进行中」而又找不到那一轮。
            await asyncio.to_thread(sweep_stale_agent_runs)
            # 导出包按 TTL 清理（30 分钟）。搭这趟车而不另起一个循环：
            # 巡检间隔 300s 远小于 TTL，精度绰绰有余，多一个常驻任务只是多一处
            # 可能悄悄死掉的地方。
            await asyncio.to_thread(sweep_exports)
            # 素材补传进桶 + 按盘水位淘汰本地副本。同理搭车。
            # 未配置桶时 media_cache.sweep() 自己会空转返回，不必在这里判。
            #
            # ⚠️ 这一个必须进长阻塞池：`upload_pending` 单轮最多 300 个文件，
            # 每个 `storage.put_file` 的上限是 600 秒（httpx.put）。留在默认
            # 20 槽里，一次补传就能把鉴权挤停好几分钟。见 app/executors.py。
            from .media_cache import sweep as _cache_sweep
            await run_long_blocking(_cache_sweep)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logging.getLogger(__name__).exception("[sweep] 本轮巡检失败，继续下一轮")


#: `/media` 挂的是整个数据目录，库文件与备份可能也在里面：这些名字一律 404。
_PRIVATE_MEDIA_RE = re.compile(r"\.(db|sqlite3?)(-wal|-shm|-journal)?$|\.tos$", re.IGNORECASE)


def _private_media(path: str) -> bool:
    """库文件、库备份、点开头的文件（如 `.env`）不经 `/media` 对外。"""
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    if not parts:
        return False
    if parts[0] == "backups" or any(p.startswith(".") for p in parts):
        return True
    return bool(_PRIVATE_MEDIA_RE.search(parts[-1]))


class _MediaFiles(StaticFiles):
    """静态素材：本地命中就直发，本地没有就 302 到桶的预签名地址。

    为什么用 302 而不是"服务端代理转发"：
      · 流量直接 浏览器↔桶，不经过本服务，省带宽也不占 worker；
      · Range 请求（视频拖进度条）由桶原生支持，代理转发要自己实现且容易错；
      · 剪映导入器的断点续传也是 Range，同理受益。

    为什么不干脆把库里的 URL 改成桶地址：预签名 URL 会过期，存进库就是一堆
    定时炸弹；而 `/fw/media/...` 这个相对地址是**永久有效**的，每次访问现签。
    库里一行都不用改，前端、导出、导入器全部零改动。
    """

    async def get_response(self, path: str, scope):
        from starlette.responses import RedirectResponse
        if _private_media(path):
            raise StarletteHTTPException(status_code=404)
        try:
            resp = await super().get_response(path, scope)
        except StarletteHTTPException as e:
            if e.status_code != 404:
                raise
            from . import storage
            from .media import _touch_used
            if not storage.enabled():
                raise
            rel = path.lstrip("/")
            if not rel or rel.split("/", 1)[0] not in set(get_settings().tos_dirs):
                raise
            # 下载文件名（2026-10-19）：前端下载链接带 `?dl=<集号>_hd.mp4`。
            # 必须在这里塞进桶的响应头——**跨域 307 之后浏览器会丢弃
            # `<a download>` 属性**，用户拿到的文件名退化成 URL 末段
            # （`up_62e1a3408268.mp4`），这正是"文件名变乱码"的真因。
            # 实测：同源 307 不会丢，跨域（桶是另一个域名）必丢。
            dl = None
            try:
                from urllib.parse import parse_qs
                qs = parse_qs((scope.get("query_string") or b"").decode("latin-1"))
                dl = storage.safe_download_name((qs.get("dl") or [None])[0])
            except Exception:  # noqa: BLE001 —— 文件名只影响体验，绝不因此 500
                dl = None
            try:
                url = storage.public_url(rel, download_name=dl)
            except Exception:  # noqa: BLE001
                raise e
            # ⚠️ 2026-10-24 生产卡死事故：这里原先直接 `_touch_used(rel)`。
            #
            # `_touch_used` 是**同步**函数（`engine.begin()` 开一个 SQLite 写事务，
            # busy_timeout=30s），而本函数是 `async def`——直接在事件循环里跑，
            # 等于把整个单进程 uvicorn 按住，最长 30 秒。它是全站共同的入口：
            # nginx 的 `/fwp/media/*` 全部落到这里，生产实测**每天 58063 次 307**
            # （占全部媒体请求的 89.2%），每次都要写一回 `media_objects`。
            #
            # 后果不是"媒体慢"，而是**所有**请求一起排队：2026-10-24 15:20 起
            # 延迟单调爬升（14s→49s→70s→90s→128s→159s…），16:01–16:25 全线
            # 触顶 nginx 的 300s，连不查任何业务数据的 `/v2/auth/me` 都超时 97 次。
            # 16:26 请求量自然回落、队列排空才恢复，进程从未重启。
            #
            # 同文件的 `media.py:408/418` 两处调用**都是** `await asyncio.to_thread(...)`，
            # 只有这一处漏了——所以这是个孤立的疏漏，不是有意为之。
            # 改回一致写法即可：写库交给线程池，事件循环继续服务其他请求。
            await asyncio.to_thread(_touch_used, rel)
            # 307 而非 302：302 会把 Range 等请求语义丢掉一部分客户端实现，
            # 307 明确要求保持方法与头，拖进度条与断点续传才稳。
            #
            # ⚠️ 2026-10-19：预签名地址会**过期**，必须显式 no-store。
            # 这条 307 一旦被浏览器缓存，过期后用户看到的就是永久坏图；
            # 而且缓存期间不会回源，等于把"现签"这层保护废掉了。
            redirect = RedirectResponse(url, status_code=307)
            redirect.headers["Cache-Control"] = "no-store"
            return redirect

        # ⚠️ 2026-10-19：本地命中的文件是**内容寻址**的（上传名 uuid4().hex[:12]，
        # 生成名同为随机 id），写盘后永不覆写，所以可以放心长缓存。
        #
        # 实测：此前完全不发 Cache-Control，浏览器只能启发式缓存，于是同一张图
        # 一天被重复拉 88 次 —— 今日 /fwp/media 200 有 8,393 次、304 仅 1,485 次，
        # 缓存几乎没起作用，单日 20.9 GB 出网里绝大部分是重复回源。
        #
        # 只给 200 加（206 分片响应由 starlette 自己处理 Range，缓存头同样适用，
        # 但 304 不需要重复设置）；HTML/入口文件不在此挂载点内，不受影响。
        if resp.status_code in (200, 206):
            resp.headers.setdefault(
                "Cache-Control", "public, max-age=31536000, immutable")
        return resp


def _selfcheck_imports() -> None:
    """启动自检：把生成链路会用到的模块**真的导一遍**。

    为什么需要：jobs.py 里漏了一个 `from .db import AssetStage`，语法检查
    过、服务也起得来，直到用户点生成、执行到那一行才 NameError——任务卡在
    0% 39 分钟，进度条一直转，看不出哪里坏了。

    Python 的惰性求值让这类错误只在运行到那一行时才暴露。启动时主动引用
    一遍关键符号，坏了就在日志里立刻喊出来，而不是等用户踩。
    """
    try:
        from . import jobs
        # 逐个点名：只 import 模块不够，模块级 import 缺失才是要抓的那类
        for name in ("AssetStage", "to_public_url", "_to_trusted_assets",
                     "_auto_inject_refs_detailed", "run_shot_videos"):
            if not hasattr(jobs, name):
                print(f"[selfcheck] ❌ jobs.{name} 不存在——生成链路会在运行时炸")
    except Exception as e:  # noqa: BLE001
        print(f"[selfcheck] ❌ jobs 模块导入失败: {e!r}")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="FilmWeaver Backend", version="0.1.0", lifespan=lifespan)

    # 积分不足 → 402。放在应用级而不是逐个路由 try/except：
    # 扣费闸门有 20+ 个落点（1 个异步提交口 + 11 条同步旁路 + 各自重试），
    # 靠每个调用点自己包一层迟早漏一个——而漏掉的那个会变成 500，
    # 用户看到的是"服务器错误"而不是"找上级要额度"。
    # 见 app/charge.py 模块文档。
    from .charge import InsufficientCredit

    # 接口报错去掉密钥：几十处路由把异常原文放进 HTTPException 的 detail
    # （如「LLM 调用失败: …」），供应商回显的密钥会直接到浏览器。见 app/redact.py。
    from fastapi.exception_handlers import http_exception_handler as _http_exception_handler

    from .redact import redact_structure, redact_text

    @app.exception_handler(StarletteHTTPException)
    async def _redacted_http_exception(request, exc: StarletteHTTPException):
        detail = exc.detail
        cleaned = redact_text(detail) if isinstance(detail, str) else redact_structure(detail)
        if cleaned != detail:
            exc = StarletteHTTPException(exc.status_code, detail=cleaned, headers=exc.headers)
        return await _http_exception_handler(request, exc)

    @app.exception_handler(InsufficientCredit)
    async def _insufficient_credit(_req, exc: InsufficientCredit):
        return JSONResponse(
            status_code=402,
            content={"detail": {
                "reason": "insufficient_credit",
                "message": str(exc),
                "need_fen": exc.need_fen,
                "have_fen": exc.have_fen,
                "need_yuan": round(exc.need_fen / 100, 2),
                "have_yuan": round(exc.have_fen / 100, 2),
            }},
        )

    # Tauri 桌面客户端从本地 WebView 发起请求，Origin 是 `tauri://localhost`
    # （Windows WebView2 上是 `https://tauri.localhost`）；网页端则是本站地址。
    #
    # ⚠️ 这里原本是 `["*"] if env == "dev" else []` —— prod 下等于**一个来源都不放行**，
    # 桌面客户端每个请求都被 WebView 的 CORS 拦掉，表现为"连不上后端服务，
    # 正在每 15 秒重试"，而后端 /health 明明返回 200（实测 2026-08-28
    # 正式版首发即栽在这，dev 侥幸没事只因它走 env == "dev" 那条分支）。
    # prod 收紧是对的，但不能收成空集：要显式列出**合法的客户端来源**。
    _origins = ["*"] if settings.env == "dev" else [
        "tauri://localhost",          # Tauri WebView（Linux/macOS）
        "https://tauri.localhost",    # Tauri WebView（Windows WebView2）
        "http://tauri.localhost",
        settings.public_base_url,     # 网页端
        settings.feishu_callback_base.rsplit("/", 1)[0] if settings.feishu_callback_base else "",
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o for o in _origins if o],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 登录体系（FW_AUTH_UPSTREAM 设置即启用，复用主平台用户数据）：
    # /v2 全部接口需带 Authorization: Bearer <会话token>。
    # 放行清单（防"无法登录→无法更新"死循环）：/health、/v2/auth/*、
    # /v2/app/latest（检查更新）、/media（预览与更新包下载不经此后端）。
    if settings.auth_upstream:
        from starlette.requests import Request as _Req
        from starlette.responses import JSONResponse as _JR

        #: 放行的**精确**路径：必须一字不差才放行。
        _OPEN_PATHS = ("/health", "/v2/app/latest")
        #: 放行的**子树**：前缀本身或 `前缀 + "/"` 开头才放行。
        _OPEN_TREES = ("/v2/auth", "/media")

        def _is_open(path: str) -> bool:
            """公开路由判定。

            ⚠️ 2026-09-11（S5）之前这里是 `any(path.startswith(x) for x in ...)`，
            于是 `/mediaXXX`、`/healthz`、`/v2/authorize` 这类**名字以放行项开头
            的新路由会自动免鉴权**。当时恰好没有这种路由，属埋雷：半年后谁加一个
            `/v2/auth_admin`，它就默默对全公网开放，而且没有任何报错。
            改成"精确匹配 或 子树匹配"后，只有真正的 `/media` 与 `/media/...`
            放行，`/mediax` 不放行。
            """
            return path in _OPEN_PATHS or any(
                path == t or path.startswith(t + "/") for t in _OPEN_TREES)

        @app.middleware("http")
        async def session_guard(request: _Req, call_next):
            path = request.url.path
            if (request.method == "OPTIONS"
                    or _is_open(path)
                    or not path.startswith("/v2")):
                return await call_next(request)
            authz = request.headers.get("Authorization", "")
            token = authz[7:] if authz.startswith("Bearer ") else ""
            # ⚠️ 2026-10-24：`verify_session` 是**同步**读库（`session.get(AuthSession)`），
            # 必须丢线程池。本中间件是 `async def`，直接在事件循环里跑它意味着
            # **每个 /v2 请求**都在主循环上做一次 SQLite 往返；撞上写锁时最坏
            # 睡满 `busy_timeout` 的 30 秒，而且整个进程一起停（所有协程都在
            # 同一个循环上，包括正在等上游的 job runner 和 SSE 心跳）。
            # 这是全站共同的底噪，也是"CPU 不高但整站卡住"的直接来源之一。
            user = await asyncio.to_thread(verify_session, token)
            if not user:
                return _JR({"detail": "未登录或会话已过期"}, status_code=401)
            # ---- 多用户隔离（2026-10-09 用户反馈"所有用户都能看到所有项目"）----
            #
            # 把调用者放进 ContextVar，路由就能在**不给自己加参数**的前提下
            # 知道"谁在访问"。这一步必须在下面那条路径校验**之前**，否则
            # access 模块读到的还是上一条请求的用户（或默认的 None）。
            set_current_user(user)
            # 路径形如 /v2/projects/{pid}/... 的一律先在这里拦一道。
            #
            # 为什么放在中间件而不是逐个路由：这类端点有 43 个，"逐个加"最怕漏，
            # 而漏掉的那一个就是下一个越权漏洞且不会报错。放这里，新增同类路由
            # 自动受保护。
            #
            # ⚠️ 路径里没有 project_id 的端点（/v2/shots/{id}、/v2/assets/{id}…）
            # 这一层**管不到** —— 中间件无从知道那个 id 属于哪个项目。
            # 那些必须由路由自己调 `access.req_*()`，并由
            # `scripts/verify_access_control.py` 枚举全部路由确认没有遗漏。
            #
            # 三处来源一起收：路径 / 查询串 / 请求体。只拦路径的话，
            # `POST /v2/assets {project_id: 别人的}` 照样能往别人项目里写资产，
            # `GET /v2/assets/candidates?project_id=别人的` 照样能读。
            #
            # ⚠️ 收集逻辑与档位依赖 `_role_guard` **共用 `access.collect_project_ids`**：
            # 两处各自实现必然漂移，而"中间件收了、档位没收"就是静默越权。
            ct = request.headers.get("content-type", "")
            pids = collect_project_ids(
                path=path,
                method=request.method,
                query_params=request.query_params,
                path_params=request.path_params,
                # 实测 Starlette 1.3.1：这里读过 body，下游路由的
                # Pydantic/Form 解析仍拿得到（body 被缓存在 request 上）。
                # 升级 Starlette 时必须重跑 verify_access_control 的这条用例。
                body=(await request.body()) if request.method in
                     ("POST", "PUT", "PATCH", "DELETE") else b"",
                content_type=ct,
            )
            if pids:
                # 同上：`can_access_project` 内部是同步点查，不能留在事件循环上。
                # 单独抽成同步函数交给线程池 —— 注意**不能**在线程里 return 一个
                # Response 就当作已返回，这里只回"第一个不可访问的 pid"。
                from .db import get_session as _gs

                def _first_denied(_pids=pids):
                    with _gs() as _s:
                        for pid in _pids:
                            if not can_access_project(_s, pid):
                                return pid
                    return None

                denied = await asyncio.to_thread(_first_denied)
                if denied is not None:
                    # 404 而非 403：403 等于承认"这个 id 存在，只是你看不了"，
                    # 把项目 id 变成可探测的资源。见 access 模块头 ①
                    return _JR({"detail": "项目不存在"}, status_code=404)
            # 把已解析的 pid 传给档位依赖复用。**必须在这里 set**：
            # 请求体只能读一次，依赖再读会抛 "Stream consumed"（实测）。
            set_request_project_ids(pids)
            return await call_next(request)

    # 可选 API Token（数据安全）：FW_API_TOKEN 设置即启用，对写操作校验；
    # 未设置保持 dev 开放，不破坏易用性。GET/health/media 静态放行（预览需要）。
    if settings.api_token:
        from starlette.requests import Request

        @app.middleware("http")
        async def token_guard(request: Request, call_next):
            if (request.method not in ("GET", "HEAD", "OPTIONS")
                    and request.url.path.startswith("/v2")
                    and request.headers.get("X-FW-Token") != settings.api_token):
                return JSONResponse({"detail": "无效或缺失 X-FW-Token"}, status_code=401)
            return await call_next(request)

    @app.get("/health")
    def health() -> dict:
        # llm_channels / image_channels：文本与图像的渠道兜底链
        # （只报渠道名与冷却状态，不含任何 key）。
        # 排障用：拆解/优化/生图全失败时先看这里是不是只剩一条、或全在冷却。
        from .providers.llm import _healthy, build_channels
        from .providers.image import _healthy as _img_healthy
        from .providers.image import channel_names
        chans = build_channels(settings.llm_model, settings)
        return {
            "status": "ok",
            "env": settings.env,
            "video_providers": len(registry.list_video()),
            "auth": "token" if settings.api_token else "open",
            "login": bool(settings.auth_upstream),  # 前端据此显示登录页
            "llm_model": settings.llm_model,
            "llm_channels": [
                {"name": c.name,
                 "cooling_down": not _healthy(c.name, settings.llm_model)}
                for c in chans
            ],
            "image_model": settings.image_model,
            # 图像侧无并发上限（0=不限），健壮性靠渠道冷却 + 抖动退避重试
            "image_concurrency": settings.image_concurrency,
            "image_channels": [
                {"name": n,
                 "cooling_down": not _img_healthy(n, settings.image_model)}
                for n in channel_names(settings.image_model)
            ],
        }

    # ------------------------------------------------------------------
    # 项目档位闸门（2026-10-16 协作）：查看者 / 编辑者 / 管理者 / 所有者
    # ------------------------------------------------------------------
    #
    # 中间件那一层只回答"是不是成员"（不是就 404）。档位是**语义**问题而不是
    # 结构问题 —— 决定一个端点需要哪一档，只能逐个端点声明：
    #   · `POST /v2/projects/{pid}/jianying/export` 是 POST 却**不写库**，
    #     查看者必须能导出，它要的是 viewer；
    #   · `DELETE /v2/projects/{pid}` 要的是 owner（管理者不能删项目）。
    # 所以做法是给路由盖 `@access.requires("editor")` 这类章，由这个依赖统一执行。
    #
    # ## 为什么不是中间件
    #
    # 中间件在 `call_next` **之前**跑，那时 `request.scope["route"]` 还是 None，
    # 拿不到匹配到的路由，也就读不到盖的章。应用级依赖在路由匹配**之后**跑，
    # 能拿到 `route.endpoint`。
    #
    # ## 为什么必须注册在 include_router 之前
    #
    # `app.router.dependencies` 是在 `include_router` 时**快照**进每条路由的。
    # 放在 include_router 之后再 append，实测零次调用（不报错，就是静默不生效）。
    #
    # ## 为什么必须 async def
    #
    # 实测：**同步 `def` 依赖里 `ContextVar.set` 对同步路由不可见**，`async def`
    # 才可见。这里虽然只读不写 ContextVar，但同样的机制差异会咬人，故一律 async。
    #
    # ## 开放模式（未配 FW_AUTH_UPSTREAM）下的行为
    #
    # 那种部署没有任何身份，`_in_request()` 恒为假 → `project_role` 返回 owner，
    # 于是这里全部放行 —— 与中间件不安装、`can_access_project` 恒真的既有行为一致。
    #: 会改状态的方法。用来决定"未盖章时的默认档位"与"要不要读请求体"。
    _WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")

    async def _role_guard(request: _RoleReq) -> None:
        """按路由盖的章校验档位。不是成员 → 404；是成员但不够档 → 403。"""
        path = request.url.path
        if not path.startswith("/v2"):
            return
        route = request.scope.get("route")
        endpoint = getattr(route, "endpoint", None)
        # 未盖章的默认值：写方法 = editor，读方法 = viewer。
        # **默认方向刻意保守**：漏盖章是"多要了一档"（用户看得见 403），
        # 而不是"少要了一档"的静默越权。真正的只读 POST 必须显式盖 viewer。
        level = getattr(endpoint, "_fw_role", None) or (
            ROLE_EDITOR if request.method in _WRITE_METHODS else ROLE_VIEWER)
        # 档位先放进 ContextVar：**即使这次请求没有 pid 也要放**。
        # 只带对象 id 的路由（PATCH /v2/assets/{asset_id} 那类）pid 不在路径、
        # 不在查询串、也不在请求体，这里无从得知它属于哪个项目 —— 那一刀由
        # `access._require` 在处理函数取出对象之后补（见 `access._LEVEL` 的注释）。
        # 两条路合起来才覆盖全部路由。
        set_request_level(level)
        # 复用中间件已解析的 pid。**不能在这里再调 collect_project_ids** ——
        # 请求体只能读一次，中间件读过之后这里再读会抛
        # `RuntimeError: Stream consumed`（实测就是这么炸的）。
        # `None` = 中间件没装（开放模式，没有身份），此时全部放行。
        pids = request_project_ids()
        if not pids:
            return
        # ⚠️ 2026-10-24：`enforce_role` → `project_role` 是同步点查，同样是每个
        # /v2 请求在事件循环上做的 SQLite 往返。它与 `session_guard` 那两处叠在
        # 一起，构成"每请求 3~6 条阻塞语句"的底噪；撞上写锁最坏 30 秒全站停摆。
        # 应用级依赖在每个路由处理函数**之前**跑，所以它对每个请求都叠加一次，
        # 修它的收益比任何单个端点都大。
        from .db import get_session as _gs

        def _enforce(_pids=pids, _level=level):
            with _gs() as _s:
                for pid in _pids:
                    enforce_role(_s, pid, _level)

        await asyncio.to_thread(_enforce)

    app.router.dependencies.append(Depends(_role_guard))

    app.include_router(v2_router)
    # 域路由：原在 v2_router 里的域，按业务域拆到 routers/ 后逐个挂载。
    # 位置与它们原先在 routes_v2.py 中的先后一致（transitions 在后半段、
    # agent 在文件末尾），故匹配优先级与拆分前相同。
    app.include_router(transitions_router)
    app.include_router(agent_router)
    # 超级 Agent 的 run 接口（2026-10-20）。与上面的 agent_router 是两件事：
    # 那个是给桌面客户端的"意图回传"，这个是**服务端真正执行**。
    app.include_router(agent_run_router)
    # 桌面端 Agent 的统一工具网关（2026-10-28）。与上面两个都不是一回事：
    #   · agent_router      → 给桌面客户端的「意图回传」（客户端自己执行）
    #   · agent_run_router  → 服务端 LangGraph 自己规划多步
    #   · 这个               → 客户端模型挑工具，服务端只做闸门 + 执行
    # 路径前缀 /desktop-agent 与既有路由无重叠，注册位置不影响匹配优先级。
    app.include_router(desktop_agent_router)
    app.include_router(drama_gateway_router)  # 短剧编导：云端转写与剧变音色分配（镜流账号）
    # 桌面端的大模型转发（2026-10-28）。客户端上不放任何模型 key，
    # 只有本人 7 天会话 token；渠道选择与冷却复用 providers/llm.py。
    app.include_router(desktop_models_router)
    # 「解说剧·角色开口」独有接口（2026-10-30）。与其他模式完全隔离，见 app/nd/。
    from .routers.nd import router as nd_router
    app.include_router(nd_router)
    app.include_router(voice_router)
    app.include_router(audio_router)
    app.include_router(assets_router)
    app.include_router(subtitle_router)
    app.include_router(stage_scene_router)
    app.include_router(shots_router)
    app.include_router(project_router)
    app.include_router(look_router)
    app.include_router(desub_router)
    app.include_router(upscale_router)
    app.include_router(usage_router)
    app.include_router(stats_router)
    app.include_router(budget_router)
    app.include_router(auth_router)
    # 飞书机器人事件入口（/feishu/events，不在 /v2 下：飞书不带 Bearer，入口自己验 token 与签名）。
    app.include_router(feishu_bot_router)
    app.include_router(jianying_router)
    app.include_router(shotflow_router)
    # 共享资产库 + 项目转交（2026-10-09）。全是新路径，与既有路由无重叠，
    # 注册位置不影响任何旧端点的匹配优先级。
    app.include_router(library_router)
    app.include_router(media_router)
    from .routers.media_tos import router as media_tos_router
    app.include_router(media_tos_router)     # 桶里的媒体：resolve / 直传（见 app/media_store.py）
    # 素材/成片静态访问：/media/uploads/... /media/outputs/...
    app.mount("/media", _MediaFiles(directory=str(DATA_DIR)), name="media")

    # 网页预览通道（dev 提效）：desktop 的 vite 构建产物挂在 /app，
    # 浏览器访问 http://<host>/fw/app/ 即可秒级预览最新 UI，无需打包 Windows 安装包。
    # Tauri 专属能力（更新器/sidecar 本机渲染）在浏览器中自动降级（代码已有 catch/云端兜底）。
    web_dir = DATA_DIR / "webapp"
    if web_dir.is_dir():
        app.mount("/app", StaticFiles(directory=str(web_dir), html=True),
                  name="webapp")

        @app.middleware("http")
        async def _no_cache_webapp_html(request, call_next):
            """给 /fw/app/ 的 HTML 加 no-cache。

            StaticFiles 默认只发 etag/last-modified，不发 Cache-Control，
            浏览器于是对 index.html 用**启发式缓存**——发布了新版本，
            用户（甚至 Ctrl+F5）仍可能拿旧 html，它引用的还是旧 hash 的
            js/css，看起来就是"改了没生效"。实际踩过这个坑。

            资源文件名带内容 hash，可以长缓存；只有入口 html 必须每次回源。
            """
            resp = await call_next(request)
            path = request.url.path
            if path.startswith("/app") and (
                    path.endswith((".html", "/")) or path == "/app"):
                resp.headers["Cache-Control"] = "no-cache, must-revalidate"
            return resp

    return app


app = create_app()