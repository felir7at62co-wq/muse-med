"""异步任务执行器（MVP：进程内 asyncio 后台任务 + DB 状态）。

不引 celery/redis 队列的原因：MVP 单机单进程足够，任务状态已落 SQLite，
桌面端靠轮询 /v2/jobs/{id} 拿进度；后续量大再平移到 celery，接口不变。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone

from . import asset_prompt as ap
from .asset_prompt import character_prompt, prop_prompt, scene_prompt
from .character_brief import brief_for_image, creature_of
from .db import (Asset, Job, Project, Shot, AssetStage, desc_of, get_session,
                  profile_of, reset_clip_window)
from .err_text import human_error
from .project_defaults import _LEGACY_DEFAULTS
from .shot_timing import (_remap_anchors, narration_max_chars,
                          shot_seconds_cap)
from .events import publish
from .executors import run_long_blocking
from .providers.image import ImageProvider, ContentRejected
from .providers.registry import registry
from .providers.base import AudioMode, VideoRequest, to_public_url
from .prop_desc import ensure_prop_descriptions
from .scene_desc import ensure_scene_descriptions
from .prompt_sanitize import strip_editor_chrome
from . import stale as stale_mod          # 过期原因与消解规则（单一真源）
from .vision_desc import strip_auto

log = logging.getLogger(__name__)


# ---- 全局视频生成并发池 ----
# 信号量语义天然实现"池满排队、有槽即进"：新任务/重试统一 acquire，
# 上一批任何任务结束释放槽位，等待者立即获得执行权。
_VIDEO_POOL: asyncio.Semaphore | None = None
_IMAGE_GATE: "asyncio.Semaphore | _NoLimit | None" = None
_TTS_GATE: "asyncio.Semaphore | _NoLimit | None" = None


def _video_pool() -> asyncio.Semaphore:
    global _VIDEO_POOL
    if _VIDEO_POOL is None:
        from .config import get_settings
        _VIDEO_POOL = asyncio.Semaphore(max(1, get_settings().video_concurrency))
    return _VIDEO_POOL


class _NoLimit:
    """无上限闸门：与 asyncio.Semaphore 同接口的空实现（async with 直接放行）。"""

    async def __aenter__(self) -> "_NoLimit":
        return self

    async def __aexit__(self, *_exc) -> None:
        return None


def _image_gate() -> asyncio.Semaphore | _NoLimit:
    """图像生成闸门。

    2026-08 起默认**不设并发上限**（settings.image_concurrency=0）：KEY 自身支持
    ≥500 并发、且图像侧有 zx1/api4me 双渠道，此前 8 并发过于保守，把整批生图
    拖成串行体感。真正的过载保护改由 providers/image.py 承担——瞬态错误抖动退避
    重试、渠道级故障标记冷却并切换另一渠道，天然自适应真实承载力。

    ⚠️ 遵并发铁律：这是**取消上限**（放大吞吐），不是降并发；若仍被网关限流，
    正确解法是加 KEY / 提配额，而非把这个值调回小数字。
    需要临时限流时可设环境变量 FW_IMAGE_CONCURRENCY=N（>0 即启用信号量）。

    ⚠️ 必须缓存成模块级单例（与 _video_pool 一致）。
    原来每次调用都 `asyncio.Semaphore(n)` 新建一个 —— 信号量是**按对象**
    计数的，每个 job 各拿一个新闸门，等于"每 job 限 N 并发"而不是
    "全局限 N 并发"：10 个 job 同时跑就是 10×N。
    设了 FW_IMAGE_CONCURRENCY 却发现没拦住，根因在此。

    注：这里只修"限额不生效"，不改任何并发数值（默认仍是 0 = 无上限，
    行为与修复前一致）。
    """
    global _IMAGE_GATE
    if _IMAGE_GATE is None:
        from .config import get_settings
        n = get_settings().image_concurrency
        _IMAGE_GATE = asyncio.Semaphore(n) if n and n > 0 else _NoLimit()
    return _IMAGE_GATE


def _tts_gate() -> asyncio.Semaphore | _NoLimit:
    """TTS 合成闸门（与 _image_gate 同构，含同一个单例陷阱的规避）。

    解说剧一集就是几十段旁白，每段 60-70s——串行跑完要一小时以上，
    而各段之间毫无依赖，并发不影响音质。

    默认 **不设上限**：RunningHub 并发上限 800，实际生产很难打到，
    设人为上限只会白白拖慢。遵并发铁律——瓶颈时加 KEY / 扩容，不是降并发。
    需要临时限流时设 FW_TTS_CONCURRENCY=N。
    """
    global _TTS_GATE
    if _TTS_GATE is None:
        from .config import get_settings
        n = get_settings().tts_concurrency
        _TTS_GATE = asyncio.Semaphore(n) if n and n > 0 else _NoLimit()
    return _TTS_GATE


def create_job(kind: str, payload: dict, jid: str | None = None) -> str:
    """建一条 job 行。`jid` 可预先生成——提交闸门要**先扣费再建 job**，
    两者必须共用同一个 id，否则扣费流水会挂在一个不存在的任务上。"""
    jid = jid or uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # project_id 冗余进独立索引列（B30）：payload 仍是唯一事实来源，
    # 这一列只为"按项目筛 job"能走索引，不必全表载入再逐行解析 JSON。
    pid = payload.get("project_id") if isinstance(payload, dict) else None
    # 提交者：请求线程里取登录者；父任务派生子任务时取父任务的用量归属
    # （后台协程里没有请求上下文，但 _run_job_guarded 已设好 usage 上下文）。
    from . import usage as _usage
    uid = _usage.current().user_id
    with get_session() as session:
        session.add(Job(id=jid, kind=kind, payload=json.dumps(payload, ensure_ascii=False),
                        project_id=pid if isinstance(pid, str) else None,
                        user_id=uid,
                        created_at=now, updated_at=now))
        session.commit()
    return jid


#: 同项目内互斥的 job 分组：命中同组且仍在跑，就不许再提交第二个。
#: 判据是"重复跑一遍纯属浪费钱"：这些 job 的 shot_ids 缺省=全项目，
#: 用户多点一次就会有两批任务生成同一批镜头。
#: （2026-08 实测：项目 e3e5d6e517c6 因双击提交，113/170 镜被生成两遍，
#:  shot_versions 里 170 个镜头躺了 276 个版本，约 106 次视频生成白烧。）
#: 分组而非按 kind 精确匹配的原因：「🚀 一条龙」内部就是首帧+片段，
#: 它在跑的时候再点「▶ 全部生成」同样是重复烧同一批镜头。
#: 资产/拆解各自成组——它们与出片是不同资源，没必要互相挡。
#: 单镜重生不在此列（不是批量 job），用户针对某一镜的操作永远不该被批量任务挡住。
_EXCLUSIVE_GROUPS: dict[str, str] = {
    "shot_videos": "shots",
    "one_click_film": "shots",
    # 去字幕改的是 shot.video_url（落新 ShotVersion 再指过去），与出片改的是
    # 同一个字段：同时跑 = 一方刚擦完写回，另一方用旧素材生成完又覆盖掉，
    # 擦除那一次的钱就白花了。归进 shots 组一起互斥。
    "desub_scan": "shots",
    "desub_apply": "shots",
    # 高清放大改的也是 shot.video_url（落新 ShotVersion 再指过去）。它在
    # 产线最末端，与出片/去字幕跑同一批素材：不互斥就会"放大的是旧素材"
    # （放大完又被出片覆盖，或反过来把刚擦过的画面放大成没擦的版本）。
    # 放大按机时计费，这种白跑是直接烧钱。
    "upscale": "shots",
    "asset_batch": "assets",
    # 与 asset_batch 同组：它最后就是把清单交给 asset_batch 跑，
    # 且中途会**新建造型阶段行**。并行两条 = 同一批角色各建一套阶段、
    # 同一批图各生一遍——既脏数据又烧钱。
    "asset_fill": "assets",
    # 与 asset_batch 互斥：识别会删掉「还没出图」的阶段行重排，若此时批量生图
    # 正在按 stage_id 落图，图会落到一个刚被删掉的阶段上（钱花了、图丢了）。
    "costume_scan": "assets",
    # 与 asset_batch 同组：批量生图开头会一次性读档案并补缺，两边同时补
    # 同一批角色 = 同一个人被判两次长相，后写的覆盖先写的（脸可能对不上已出的图）。
    "profile_fill": "assets",
    "breakdown_all": "breakdown",
}

#: 真正**按镜头定位**的 kind —— 它们的 payload 能说出"这次要动哪几镜"，
#: 因而可以逐个镜头判断"这一镜是不是已经在跑了"。见 `covers_active_shot`。
#:
#: 刻意**不含** `asset_*` / `breakdown_all`：那些的单位是资产或全片，
#: 没有"某一镜"这个粒度，硬套只会得到一个恒真或恒假的判据。
_TARGET_KINDS: frozenset[str] = frozenset({
    "shot_videos", "one_click_film",
    "upscale", "desub_scan", "desub_apply",
})


def _target_dedup_key(kind: str, payload: dict) -> tuple | None:
    """需要**按目标**（而不是按项目）去重的 kind → 目标标识。

    `asset_generate` 是"给某一个资产/造型生一张图"，去重必须精确到**目标**：

      · 同一个目标重复提交 = 同一张图生成两遍，纯烧钱（双击、多标签页、
        刷新后重提交都会造成这种重复），所以要挡；
      · 但**不同目标之间必须能并发** —— 生成角色 A 的时候，角色 B 也得点得动。
        所以它**不能**塞进 `_EXCLUSIVE_GROUPS`：那张表是按 `project_id` 互斥的，
        放进去就会变成"生成一个资产时，同项目所有别的资产全被锁住"，
        正是用户刚报过的那个毛病。

    返回 None = 这个 kind 不走按目标去重（照旧走 `_EXCLUSIVE_GROUPS`）。
    """
    if kind == "asset_generate":
        return ("asset_generate", payload.get("kind"), payload.get("name"),
                payload.get("stage_id") or None)
    if kind == "image":
        # 自由生图：**同一份参数同时在飞**就复用（双击、多标签页、刷新后重提交）。
        # 参数一动就放行——用户就是想再出一批不一样的。刻意不放进
        # _EXCLUSIVE_GROUPS：那张表是按项目互斥的，生了图就锁住整个项目，
        # 正是"给资产 A 生图时资产 B 点不动"那个老毛病（见本函数文档）。
        return ("image", payload.get("prompt"), payload.get("model_id"),
                payload.get("size"), int(payload.get("n") or 1),
                tuple(payload.get("ref_urls") or []))
    return None


def covers_active_shot(shot_id: str, kind: str, project_id: str | None) -> bool:
    """这一镜是不是**已经**被某条在跑的同类任务覆盖了。

    与 `find_active_job` 是**两个不同的问题**，别互相替代：

      · `find_active_job` 问「这次提交该不该拦/复用」——是**整条提交**的判据，
        只回一个 job id（调用方拿它做 deduped 复用）；
      · 本函数问「这一镜现在能不能提交」——是**单个镜头**的判据。

    存在的理由（2026-10-16 用户报的问题）：`shotJobRunning()` 那种
    「只要该组有一个活跃任务就锁住全部按钮」的粗粒度拦法，会让用户
    "生成一镜之后连第二镜都点不动"。而正确的粒度是**镜头级**：
    同一镜重复提交要挡（那是重复烧钱），不同镜必须放行（并发）。

    注意本函数用的是 `_TARGET_KINDS`（真正按镜头定位的 kind），**不**用
    `_EXCLUSIVE_GROUPS` 的跨 kind 互斥（upscale/desub 与出片同组）：
    那种互斥是为了防止两个任务**同时改写** `shot.video_url`，
    是"同时开跑"的冲突，不是"这一镜已经被处理过"。拿它挡单镜会把
    "另一集在放大"变成"这一集不能出片"，比原来更糟。

    「覆盖」的定义对两类 payload 不同：

      · **定向**（带非空 `shot_ids`）：点名了哪几镜就是哪几镜。
      · **批量**（无 `shot_ids`）：范围由 `orders` / `episode` 决定，
        都没有 = 全项目。**必须连这些一起看** —— 只看 `shot_ids` 的话，
        "全片正在出片"会判成"没有覆盖任何镜头"，于是同一条批量任务可以被
        无限重复提交（正是 `_EXCLUSIVE_GROUPS` 当初要挡的那次实测：
        项目 e3e5d6e517c6 因双击，113/170 镜被生成两遍）。
    """
    from .db import Job
    if not project_id or kind not in _TARGET_KINDS:
        return False
    with get_session() as session:
        rows = (session.query(Job)
                .filter(Job.kind == kind,
                        Job.status.in_(("pending", "running")),
                        Job.project_id == project_id)
                .all())
        for j in rows:
            try:
                p = json.loads(j.payload or "{}")
            except ValueError:
                continue
            if isinstance(p, dict) and _payload_covers_shot(session, p, shot_id):
                return True
    return False


def _episodes_of(p: dict) -> set[int]:
    """payload 里点的集号集合。**`episode`（单集）与 `episodes`（多集）都要认**。

    漏认 `episodes` 的后果不是"不过滤"，而是**被判成覆盖全项目**：拆解/出片
    的 payload 一律写的是 `episodes: [1, 2, ...]`（`nd_breakdown` / `nd_produce`
    都是），只认 `episode` 就会把"拆第 2 集"当成"拆整个项目"，于是正在跑的
    "第 1 集"会把之后提交的每一集都静默去重掉——用户点了没反应、还以为提交成功。
    与 2026-10-26 `shots` 组那次是同一类哑火。

    解析不出来（脏值）返回空集合 = 说不清，由调用方按"覆盖一切"保守处理。
    """
    out: set[int] = set()
    for v in (p.get("episode"), p.get("episodes")):
        vals = v if isinstance(v, list) else [v]
        for x in vals:
            if x is None or (isinstance(x, str) and not x.strip()):
                continue
            try:
                out.add(int(x))
            except (TypeError, ValueError):
                return set()
    return out


def _payload_covers_shot(session, p: dict, shot_id: str) -> bool:
    """一条 job 的 payload 是否覆盖某个镜头。`session` 用来查镜头自身的集/序。"""
    ids = p.get("shot_ids")
    if isinstance(ids, list) and ids:
        return shot_id in ids
    orders = p.get("orders")
    eps = _episodes_of(p)
    if not orders and not eps:
        return True                     # 全项目批量：覆盖一切
    shot = session.get(Shot, shot_id)
    if shot is None:
        return False
    if isinstance(orders, list) and orders:
        return shot.order in set(orders)
    return shot.episode in eps


def find_covering_job(shot_id: str, kind: str, project_id: str | None) -> str | None:
    """覆盖了这一镜的那条在跑任务的 id；没有则 None。

    与 `covers_active_shot` 同一套判据，只是把命中的 job id 也带回来 ——
    "整批镜头都已在跑"时界面需要它去显示进度，而不是干巴巴一句"已跳过"。
    """
    from .db import Job
    if not project_id or kind not in _TARGET_KINDS:
        return None
    with get_session() as session:
        rows = (session.query(Job)
                .filter(Job.kind == kind,
                        Job.status.in_(("pending", "running")),
                        Job.project_id == project_id)
                .all())
        for j in rows:
            try:
                p = json.loads(j.payload or "{}")
            except ValueError:
                continue
            if isinstance(p, dict) and _payload_covers_shot(session, p, shot_id):
                return j.id
    return None


def group_covering_map(kind: str, project_id: str | None,
                       shot_ids: list[str]) -> dict[str, str]:
    """这批镜头里，哪些已被**同互斥组**的在跑任务占用 → `{shot_id: job_id}`。

    与 `find_covering_job` 的差别有两点，都是 2026-10-26 那次修复要的：

      · **跨 kind**：「正在出片」和「正在高清放大」改的是同一个
        `shot.video_url`，同时跑就会一方覆盖另一方。所以"这一镜现在能不能
        提交放大"必须把出片任务也算进来——否则放大会基于即将作废的旧素材，
        出片又会把刚放大好的版本盖掉，两笔钱都白花。
        （`find_covering_job` 只认同 kind，回答的是另一个问题：
        "这一镜是不是已经在被同类任务处理了"。）
      · **一次查一批**：活跃 job 只查一次，之后纯内存比对。批量提交动辄上百镜，
        逐镜查库会变成上百次全表过滤——而这条路径每次提交都要走。

    反过来也必须**只到镜头级**：同组但不同镜的任务完全不该互相挡，
    这正是 `_EXCLUSIVE_GROUPS` 当初按项目互斥时踩的坑（见 `find_active_job`）。

    用途见 `routers/upscale.py` 与 `routers/desub.py`：把"这次实际要动的镜头"
    逐个比对，剔除已被占用的、其余照常提交，而不是"组里有活就整条打回"。

    返回空 dict 的四种情形都不该报错：没有 project_id、kind 不是镜头级、
    没给镜头、该项目此刻没有任何活跃的同组任务。
    """
    from .db import Job
    if not project_id or kind not in _TARGET_KINDS or not shot_ids:
        return {}
    group = _EXCLUSIVE_GROUPS.get(kind)
    peers = [k for k, g in _EXCLUSIVE_GROUPS.items() if g == group] if group else [kind]
    out: dict[str, str] = {}
    with get_session() as session:
        rows = (session.query(Job)
                .filter(Job.kind.in_(peers),
                        Job.status.in_(("pending", "running")),
                        Job.project_id == project_id)
                .all())
        if not rows:
            return {}
        bundles: list[tuple[str, dict]] = []
        for j in rows:
            try:
                p = json.loads(j.payload or "{}")
            except ValueError:
                continue
            if isinstance(p, dict):
                bundles.append((j.id, p))
        for sid in shot_ids:
            for jid, p in bundles:
                if _payload_covers_shot(session, p, sid):
                    out[sid] = jid
                    break
    return out


def _shot_scope(session, project_id: str, p: dict) -> set[str] | None:
    """这条 payload 会动到**哪几镜**。None = 说不清/全项目，按"覆盖一切"处理。

    存在的理由（2026-10-26 用户报的问题，见 `find_active_job` 里那段说明）：
    `_EXCLUSIVE_GROUPS` 一直是**按项目**互斥的，而组内各 kind 真正要动的
    往往只是**几集甚至一镜**。判据一旦落到项目级，"第 19 集重出一镜"就能
    把"第 11 集整集放大"挡回去——两者一镜不重叠。

    与 `_payload_covers_shot` 的分工：那个是**逐镜问**"覆盖不覆盖"（够用但
    要按镜头数逐个开查询）；本函数一次性把范围**展开成集合**，用于两个提交
    之间做交集判断。两者对 payload 的理解必须一致 —— 改一处就要改另一处。
    """
    ids = p.get("shot_ids")
    if isinstance(ids, list) and ids:
        return {str(i) for i in ids if i}
    orders = p.get("orders")
    eps = _episodes_of(p)
    if not orders and not eps:
        return None                     # 全项目批量：说不清，按覆盖一切处理
    q = session.query(Shot.id).filter(Shot.project_id == project_id)
    if isinstance(orders, list) and orders:
        try:
            q = q.filter(Shot.order.in_([int(o) for o in orders]))
        except (TypeError, ValueError):
            return None                 # 解析不出来 → 保守当作覆盖一切
    else:
        q = q.filter(Shot.episode.in_(eps))
    return {r[0] for r in q.all()}


def _scopes_conflict(session, project_id: str, mine: dict, theirs: dict) -> bool:
    """两条 payload 是否会动到同一镜。任一侧说不清（全项目）就算冲突。

    ⚠️ 两侧都展开成**空集**时要单独判（2026-11-05）。空集有两种来源，含义完全
    相反，不能一律当成"不冲突"：
      · 项目里这一集**还没有镜头**（第一次拆解、拆完后被删）——两条任务动的是
        同一块将来才出现的东西，必须算冲突，否则同一集会被拆两遍、扣两次费；
      · 两边点的集号本来就**不重叠**（拆第 1 集 vs 拆第 2 集）——确实互不干扰。
    判据落到 payload 里的集号上：集号有交集（或任一侧没点集号=全项目）才算冲突。
    """
    a = _shot_scope(session, project_id, mine)
    if a is None:
        return True
    b = _shot_scope(session, project_id, theirs)
    if b is None:
        return True
    if not a and not b:
        ea, eb = _episodes_of(mine), _episodes_of(theirs)
        if not ea or not eb:            # 说不出集号 = 全项目，保守算冲突
            return True
        return bool(ea & eb)
    return bool(a & b)


def find_active_job(kind: str, project_id: str | None,
                    payload: dict | None = None) -> str | None:
    """同项目、同互斥组且仍在 pending/running 的 job id；没有则 None。

    payload 是 JSON 文本列，活跃 job 至多几条，直接内存过滤即可，
    不值得为它加索引列。

    TB-04：**定向提交不参与去重**。上面的注释一直写着「单镜重生永远不该被
    批量任务挡住」，但实际拦截发生在这里、只看 kind + project_id——前端的
    「重试这一镜」走的也是 shot_videos，于是被在跑的整批任务判成重复，
    直接返回那个批量 job，用户点了没反应、还以为自己重试成功了。

    判据：payload 明确带了 shot_ids（非空列表）= 用户点名了要哪几镜，
    这是定向操作，放行。缺省/None = 覆盖全项目的批量任务，照旧去重。

    ⚠️ `shots` 组的判据是**镜头集合相交**，不是"组里有活就拦"（2026-10-26）。

    原来的实现命中同组任意活跃 job 就 `return rows[0].id`，于是"第 19 集
    重出一镜"会把"第 11 集整集高清放大"判成重复、原样返回那条出片任务
    （`deduped:true`，既不建任务也不扣费）。前端又拿那个 id 去 waitJob，
    按钮就一直停在「已提交，排队中…」。生产实测 14 天里 72 次放大提交，
    **12 次一个任务都没建出来**，其中 11 次是被毫不相干的单镜重生成挡掉的。

    那层互斥本身是有正当理由的（同组各 kind 改的都是 `shot.video_url`，
    同时写会互相覆盖），但那个理由天生是**镜头级**的：两条任务只要不碰
    同一镜，同时跑没有任何问题。`covers_active_shot` 的文档早就写过同一句
    判决——"拿它挡单镜会把『另一集在放大』变成『这一集不能出片』"。

    保守方向仍然保留：任一侧范围说不清（全项目批量、payload 损坏）就算冲突，
    宁可多等，也不让两条任务同时改同一镜。
    """
    if payload:
        ids = payload.get("shot_ids")
        if isinstance(ids, list) and ids:
            return None
        # 要素补全的**子集提交**同理（2026-10-15）：用户点名"只补这几个"，
        # 不该被在跑的整批补全吞掉并回一个 deduped:true —— 那会让用户以为
        # 提交成功、实际什么都没发生（TB-04 在 shot_ids 上踩过同一个坑）。
        # 只在**两个都带 only 且集合相同**时才认为是重复，由下面的常规判据处理。
        only = payload.get("only")
        if isinstance(only, list) and only:
            return None

    # 按目标去重的 kind（asset_generate）：只跟**同一目标**的活跃任务比，
    # 不同目标一律放行。见 _target_dedup_key 的说明。
    tkey = _target_dedup_key(kind, payload or {})
    if tkey is not None:
        if not project_id:
            return None
        with get_session() as session:
            rows = (session.query(Job)
                    .filter(Job.kind == kind,
                            Job.status.in_(("pending", "running")),
                            Job.project_id == project_id)
                    .all())
        for j in rows:
            try:
                p = json.loads(j.payload or "{}")
            except ValueError:
                continue
            if _target_dedup_key(kind, p) == tkey:
                return j.id
        return None

    group = _EXCLUSIVE_GROUPS.get(kind)
    if not group or not project_id:
        return None
    peers = [k for k, g in _EXCLUSIVE_GROUPS.items() if g == group]
    #: `shots` 组按**镜头集合相交**判冲突（见本函数文档）；
    #: 其余组（assets / breakdown）的单位是资产或全片，没有"哪几镜"可言，
    #: 维持原来的项目级互斥。
    per_shot = group == "shots"
    with get_session() as session:
        # 按 project_id 索引列直接筛（B30）：原来是把所有活跃 job 载入再逐行
        # json.loads(payload) 比对。活跃 job 通常只有几条，但这条路径在每次
        # 提交都要走，没理由做全表扫描。
        rows = (session.query(Job)
                .filter(Job.kind.in_(peers),
                        Job.status.in_(("pending", "running")),
                        Job.project_id == project_id)
                .all())
        for j in rows:
            if not per_shot:
                return j.id
            try:
                p = json.loads(j.payload or "{}")
            except ValueError:
                return j.id             # payload 坏了 → 说不清，保守当作冲突
            if not isinstance(p, dict):
                return j.id
            if _scopes_conflict(session, project_id, payload or {}, p):
                return j.id
        # 兜底：老数据 project_id 可能为 NULL（回填漏掉/payload 损坏），
        # 此时仍按 payload 复核，避免去重失效导致重复烧钱。
        legacy = (session.query(Job)
                  .filter(Job.kind.in_(peers),
                          Job.status.in_(("pending", "running")),
                          Job.project_id.is_(None))
                  .all())
        for j in legacy:
            try:
                p = json.loads(j.payload or "{}")
            except ValueError:
                continue
            if not isinstance(p, dict) or p.get("project_id") != project_id:
                continue
            if not per_shot or _scopes_conflict(session, project_id, payload or {}, p):
                return j.id
    return None


#: job 的「当前阶段」标签（内存态，随进程生死；job 本来也活不过进程重启）。
#: 存在的理由：i2va 批量出片会**先把整批首帧生完再提交视频**，170 镜的头几分钟
#: 视频数恒为 0、进度条几乎不动，用户看着就是"点了没反应"（2026-08 实测投诉，
#: 用户因此又点了一次，同一批镜头被生成两遍）。把阶段摊到台面上才能自证在干活。
#: 形如 {"key": "frames", "label": "正在出首帧", "done": 32, "total": 170}
_JOB_PHASE: dict[str, dict] = {}


def set_job_phase(jid: str, phase: dict | None) -> None:
    """设置/清除 job 阶段标签。清除用于收尾，避免 dict 无限增长。"""
    if phase is None:
        _JOB_PHASE.pop(jid, None)
    else:
        _JOB_PHASE[jid] = phase


def get_job_phase(jid: str) -> dict | None:
    return _JOB_PHASE.get(jid)


def is_cancelled(jid: str) -> bool:
    """任务是否已被用户取消（routes_v2::cancel_job 只改状态位）。

    批量 runner 在每个镜头/每个分片的边界调一次：不能中途硬杀协程，
    但可以不再发起**下一个**上游请求——这是能少烧钱的最大粒度。
    """
    with get_session() as session:
        job = session.get(Job, jid)
        return bool(job and job.status == "cancelled")


#: 逐条目结果里"这一项是被取消的"的统一措辞。判定整批是否属于用户取消要按它匹配，
#: 所以**只能有一处定义**——散着写字面量，改了文案就会悄悄退化成"整批失败"。
_CANCELLED_MSG = "已取消"

#: 写进 Job.error 的失败明细上限。生产上出现过 12KB 的 JSON 直接灌进这一列，
#: 前端原样铺在错误卡片里，用户面对的是一屏 `{"name":...,"error":...}`。
_ERR_ITEMS_CAP = 5
_ERR_TEXT_CAP = 500

#: 审核类失败的单条明细上限（普通失败是 80）。
#:
#: ⚠️ 80 字符**正好把 `param` 切掉**（2026-10-13 修）。实测落库原文是
#:   `HTTP 400: {"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformatio`
#: —— 到 `PrivacyInformatio` 就断了，`'content[7]'` 这个唯一能定位到图的线索
#: 落在刀口之外。而 `_explain_refusal` 的翻译正是靠 `content[N]` 才能工作，
#: 所以这两处必须一起改：**翻译需要的信息不能被摘要先吃掉**。
#:
#: 放宽到 400 而不是无限：审核报错本身只有一两百字符，400 足够装下
#: code + param + message 三样，同时仍挡住 12KB 那种极端情况。
_ERR_MODERATION_ITEM_CAP = 400


def _brief_errors(failed: list[dict]) -> str:
    """把逐条目失败明细压成人能读的一句话 + 前几条样例。

    保留原始 JSON 的诉求是"可排查"，但那属于 `Job.result`（本来就存着全量
    results）；`Job.error` 是**给用户看的**，必须短。

    各 runner 的条目形状不同（资产用 name、镜头用 order、拆解用 episode），
    统一取第一个能标识"是哪一条"的字段当标签。
    """
    if not failed:
        return ""

    def _label(r: dict) -> str:
        for k, fmt in (("name", "{}"), ("order", "第 {} 镜"),
                       ("episode", "第 {} 集"), ("id", "{}")):
            if r.get(k) is not None:
                return fmt.format(r[k])
        return "?"

    def _item(r: dict) -> str:
        txt = str(r.get("error", "")).strip()
        # 审核类放宽截断：`content[N]` 常在 80 字符之后，切掉就等于
        # 又把"是哪张图"这条唯一线索丢了（见 _ERR_MODERATION_ITEM_CAP）
        cap = (_ERR_MODERATION_ITEM_CAP
               if classify_failure(txt) == "moderation" else 80)
        return f"{_label(r)}: {txt[:cap]}"

    head = "；".join(_item(r) for r in failed[:_ERR_ITEMS_CAP])
    more = f"（另有 {len(failed) - _ERR_ITEMS_CAP} 项失败）" \
        if len(failed) > _ERR_ITEMS_CAP else ""
    return f"{len(failed)} 项失败：{head}{more}"[:_ERR_TEXT_CAP]


def _update(jid: str, **fields) -> None:
    with get_session() as session:
        job = session.get(Job, jid)
        if not job:
            return
        # 已取消的任务不许被 runner 的收尾 _update 改回 done/failed——
        # 否则用户点了取消、进度条却在几十秒后跳成"已完成"，看起来像没生效。
        # 进度/结果仍照写，方便回溯取消时跑到哪儿了。
        if job.status == "cancelled":
            fields.pop("status", None)
        for k, v in fields.items():
            setattr(job, k, v)
        job.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        session.commit()
        # 终态清理必须在**组装 SSE 快照之前**做，否则收尾那一条事件里还挂着
        # 「正在出首帧 32/170」，前端收到 status=done 的同时又收到一个进行中
        # 的阶段标签，进度条会停在最后一个阶段上不消失。
        #
        # cancelled 也是终态（B32）。原来只清 done/failed，而上面那段又把
        # cancelled 任务的 status 更新全部 pop 掉 —— 于是被取消的 job
        # **永远**到不了 done/failed，阶段标签就在 _JOB_PHASE 里留到进程重启。
        # 后端是长驻裸进程（filmweaver-dev-backend.service），取消得越多这个
        # dict 越大，且 runner 后续的收尾 _update 还会把这个陈旧阶段一路推给
        # SSE，前端在任务已取消后仍显示「正在出首帧」。
        if job.status in ("done", "failed", "cancelled"):
            _JOB_PHASE.pop(job.id, None)
        # P2-5 SSE：job 状态/进度变更即发事件（payload 里带 project_id 的才推）
        snap = {"id": job.id, "kind": job.kind, "status": job.status,
                "progress": job.progress,
                "error": (job.error or "")[:200] or None,
                # 阶段标签随事件一起推：SSE 在线时轮询降到 15s 兜底，
                # 光靠轮询拿 phase 会慢到失去"在干活"的说服力
                "phase": _JOB_PHASE.get(job.id)}
        try:
            pid = json.loads(job.payload or "{}").get("project_id")
        except ValueError:
            pid = None
    publish(pid, "job", snap)


def get_job(jid: str) -> Job | None:
    with get_session() as session:
        return session.get(Job, jid)


async def run_asset_batch(jid: str, parent_jid: str | None = None) -> None:
    """批量资产生图：payload={"items":[{"name","prompt","stage_id"?},...],"model_id","size","project_id"}。

    并发策略（显著提速且保同角色多阶段一致性）：
    - 场景图：直接并发（无依赖）；
    - 角色阶段（带 stage_id）：按 character_name 分组，同角色串行（基准→参考并发），
      不同角色并发（受 Semaphore(8) 限流）。基准选已有图的阶段，全没图取 ep_from 最小。
      基准图失败则逐个尝试其他阶段，全失败才报该角色整体失败（退回文生图会导致跨阶段
      人物不一致 = 接下来视频全废，必须阻断）。
    - 配角/自定义资产（无 stage_id）：与场景图同批并发。

    实时刷新：每张落库即推进度（前端逐张点亮）。
    """
    from collections import defaultdict
    from .config import get_settings
    from .db import Asset, AssetStage

    job = get_job(jid)
    if not job:
        return
    payload = json.loads(job.payload)
    items = payload.get("items", [])
    model_id = payload.get("model_id")
    size = payload.get("size", "1024x1024")
    project_id = payload.get("project_id")

    _update(jid, status="running")
    # ⚠️ 不要在这里创建一个全局 provider 复用：条目可以自带 `model_id`
    # （2026-10-21，三类资产各用不同生图模型）。见 `_provider_for`。
    _default_model = model_id
    #: 三类的模型在**批次开头读一次**就够：它是项目级配置，一个批次里不会变。
    #: 每张图各查一次库的话，三百张图就是三百次 SQLite 查询（本项目实测
    #: 单个项目 400+ 条资产），纯属自己给自己加锁竞争。
    _kind_models: dict[str, str | None] = {}
    if project_id:
        with get_session() as _s:
            _kind_models = asset_image_models(_s.get(Project, project_id))
    total = len(items)
    done_count = 0
    results: list[dict] = []

    def _provider_for(item: dict, kind: str | None) -> ImageProvider:
        """该条目该用哪个生图 provider。

        优先级：**条目显式 `model_id`** > **类别配置** > **整批 `model_id`** >
        平台默认。

        条目显式排第一：用户在「提示词与生成」弹窗里当场选的模型必须生效，
        不能被项目里给这一类配的默认值顶掉。
        类别配置排在整批之上：整批 `model_id` 在 `asset_fill` 里就是"项目模型"，
        而类别配置正是用来**覆盖**它的。
        Provider 的构造只读配置、不发请求，逐条新建没有额外开销。
        """
        mid = item.get("model_id")
        if not mid and kind:
            mid = _kind_models.get(kind)
        return ImageProvider(model_id=mid or _default_model)

    def _report(name: str, urls: list[str] | None = None, error: str | None = None):
        nonlocal done_count
        r = {"name": name}
        if urls:
            r["urls"] = urls
        if error:
            r["error"] = error
        results.append(r)
        done_count += 1
        _update(jid, progress=int(done_count / max(total, 1) * 100),
                result=json.dumps(results, ensure_ascii=False))
        # 同步回报到父 job 的阶段计数：一键成片的进度面板与资产轨都读它。
        # 不报的话父 phase.done 恒为 0——前端以为一张都没出，
        # 资产图要等整条流水线跑完才出现在轨道上。
        if parent_jid:
            set_job_phase(parent_jid, {"key": "assets", "label": "正在补资产图",
                                       "done": done_count, "total": total})

    async def _gen_and_save(item: dict, ref_urls: list[str] | None = None
                            ) -> tuple[str | None, str | None]:
        """生成一张图并落库，返回 (url, error)。"""
        # 取消检查点。必须在 provider.generate **之前** —— 那一步才是花钱的。
        # 本函数此前完全没有检查点：run_asset_batch 收了 parent_jid 却只拿它
        # 当阶段标签用，用户点「停止生产」之后，剩下的图照样一张张生成并计费。
        # 每张图入口检查一次，而不是只在批次开头 —— 图像生成是逐张 await 的，
        # 只在开头检查等于"取消一律无效"（所有协程在第一轮事件循环就通过了）。
        if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
            return None, _CANCELLED_MSG
        # 场景图固定 16:9（见 SCENE_ASSET_SIZE）。批量里场景图一律是
        # scene_view_id 项；带 kind / asset_id 的也认，防将来新增的入口漏掉。
        _kind = item.get("kind")
        if item.get("scene_view_id"):
            _kind = "location"
        elif item.get("stage_id"):
            # 角色造型**必然**是角色（`asset_stages` 只存角色造型）。
            # 不补这一条的话，一键补全排出来的角色条目因为只带了 `stage_id`，
            # `_kind` 恒为 None —— 「角色用哪个模型」那档配置对它永远不生效，
            # 用户会以为"给角色换了模型，出的图没变"。
            _kind = "character"
        elif not _kind and item.get("asset_id"):
            from .db import Asset as _A
            with get_session() as _s:
                _a = _s.get(_A, item["asset_id"])
                _kind = _a.kind if _a else None
        isize = _size_for_kind(_kind, size)
        provider = _provider_for(item, _kind)
        try:
            urls = await provider.generate(item["prompt"], size=isize, ref_urls=ref_urls)
            if not urls:
                return None, "模型未返回图片"
            url = urls[0]
            # 落库前做一次**客观缺陷体检**（P2-3）。只记日志，不重试、不阻断 ——
            # 判据与"为什么不做候选图挑选"见 asset_qc 模块头。
            # 角色图才判"背景是否纯白"：场景图本来就不该是白底。
            try:
                from . import asset_qc
                from .media import ensure_local_async
                _p = await ensure_local_async(url)
                if _p is not None and _p.is_file():
                    # ⚠️ 体检要 PIL 解码整图 + `np.asarray(...).astype(np.float32)`，
                    # 一张 1792×1024 的图就是 **22 MB** 的 float32 数组，全程纯 CPU。
                    # 直接调等于把事件循环按住几十毫秒 —— 而它旁边就是整批出图
                    # 的主循环（每张图都要过这里）。见 asset_qc.inspect 的说明。
                    await asyncio.to_thread(
                        asset_qc.report, item.get("name") or "?", _p,
                        is_character=bool(item.get("stage_id")),
                        want_size=isize)
            except Exception:      # noqa: BLE001 体检绝不能连累出图
                log.debug("[asset_qc] 体检跳过", exc_info=True)
            # ⚠️ 目标行不存在时必须报失败，不能静默丢弃。
            # 这里的图已经生成、钱已经花了；如果对应的 AssetStage/Asset 在生成
            # 期间被删（用户重新识别造型、或同步接口 POST /v2/stages/draft
            # 的批量删除 —— 它不是 job，find_active_job 的互斥拦不住它），
            # 原来的写法会跳过写库、照样 return (url, None)，
            # _report 记为成功。结果：花了钱、图变成孤儿文件、
            # 用户看到一个绿勾和一个空的资产槽位，无从判断发生了什么。
            if item.get("stage_id"):
                with get_session() as session:
                    st = session.get(AssetStage, item["stage_id"])
                    if not st:
                        return None, (f"生成成功但目标阶段已不存在"
                                      f"（可能在生成期间被删除）；图片已生成: {url}")
                    st.image_url = url
                    # 快照要在 commit **之前**取：commit 后属性会过期，
                    # 出了 session 再读就是一次额外查询（甚至 DetachedInstanceError）。
                    # 它是"这一版的输入"（着装描述），回退时还的是它而不是复合稿。
                    _desc_in = st.description
                    session.commit()
                    # 版本快照要带上 stage 自己的名字——造型行以后可能被删，
                    # 那时从别处就查不到它叫什么了
                    _pid, _label = st.project_id, f"{st.character_name} · {st.stage_name}"
                from .asset_versions import record as _rec
                _rec(project_id=_pid, kind="stage", target_id=item["stage_id"],
                     image_url=url, prompt=item.get("prompt"), desc_in=_desc_in,
                     model_id=provider.model_id, source="ai", label=_label)
            elif item.get("scene_view_id"):
                # 场景多视角：图落在 SceneView 行上。主视角还要**写回**
                # Asset.image_url——readiness/资产页缩略图/注入兜底全读那一列，
                # 不写回去整个项目会报"所有场景都没图"（见 scene_view 模块头）。
                from .db import SceneView
                with get_session() as session:
                    sv_row = session.get(SceneView, item["scene_view_id"])
                    if not sv_row:
                        return None, (f"生成成功但目标场景视角已不存在"
                                      f"（可能在生成期间被删除）；图片已生成: {url}")
                    sv_row.image_url = url
                    sv_row.prompt = item.get("prompt")
                    _rec_asset = None
                    if item.get("primary"):
                        a = session.get(Asset, sv_row.asset_id)
                        if a is not None:
                            a.image_url = url
                            # 只有主视角才写回 Asset.image_url，所以也只记它——
                            # 非主视角那 7 张是 SceneView 自己的多方位于槽位，
                            # 不进资产图的版本链（否则版本列表会被视角图淹没）。
                            _rec_asset = (a.id, a.kind, a.name)
                    session.commit()
                if _rec_asset:
                    from .asset_versions import record as _rec
                    _rec(project_id=project_id, kind=_rec_asset[1],
                         target_id=_rec_asset[0], image_url=url,
                         prompt=item.get("prompt"), model_id=provider.model_id,
                         source="ai", label=_rec_asset[2])
            elif item.get("asset_id"):
                # 按 id 精确落库（道具等**自带 asset_id** 的条目走这条）。
                #
                # ⚠️ 必须排在下面那段"按名字找行"之前。那段是历史兜底，判据是
                # `Asset.name == plain`，**不带 kind** —— 于是道具「林晨」出图时
                # 会把角色「林晨」的定妆图覆盖掉，而且是静默的：图生成成功、
                # 版本链接到了角色上、用户看到角色的脸变成了一把刀。
                with get_session() as session:
                    a = session.get(Asset, item["asset_id"])
                    if a is None:
                        return None, (f"生成成功但目标资产已不存在"
                                      f"（可能在生成期间被删除）；图片已生成: {url}")
                    a.image_url = url
                    _rec3 = (a.id, a.kind, a.name, a.project_id)
                    session.commit()
                from .asset_versions import record as _rec
                _rec(project_id=_rec3[3], kind=_rec3[1], target_id=_rec3[0],
                     image_url=url, prompt=item.get("prompt"),
                     model_id=provider.model_id, source="ai", label=_rec3[2])
            elif project_id:
                raw_name = item.get("name", "")
                plain = raw_name.split("-", 1)[1] if "-" in raw_name else raw_name
                with get_session() as session:
                    a = (session.query(Asset)
                         .filter(Asset.project_id == project_id, Asset.name == plain)
                         .first())
                    if not a:
                        return None, (f"生成成功但目标资产「{plain}」已不存在"
                                      f"（可能在生成期间被删除）；图片已生成: {url}")
                    a.image_url = url
                    _rec2 = (a.id, a.kind, a.name)
                    session.commit()
                from .asset_versions import record as _rec
                _rec(project_id=project_id, kind=_rec2[1], target_id=_rec2[0],
                     image_url=url, prompt=item.get("prompt"),
                     model_id=provider.model_id, source="ai", label=_rec2[2])
            return url, None
        except Exception as e:  # noqa: BLE001
            # 参考图取不到要**说清楚是参考图的事**，不能压成一句 repr：
            # 这是"该去换哪张图"的可执行信息，而 repr 只会得到一句类型名。
            # 口径与 RefUnavailable 的注释一致（不静默降级、不出废图）。
            from .providers.image import RefUnavailable
            if isinstance(e, RefUnavailable):
                return None, str(e)[:200]
            # 用 repr：httpx 超时/连接类异常 str() 为空，repr 才能看到类型
            return None, repr(e)[:200]

    async def _gen_character(cname: str, char_items: list[dict], base_url: str | None):
        """一个角色的所有待生成阶段。

        base_url 非空 = 该角色已有定妆图（本批之外的阶段图 / 角色通用图），
        直接全部并发喂它做参考。base_url 为空 = 全新角色：先串行生一张基准，
        再用基准并发生剩余。

        基准图**必须**成功。退回纯文生图会让同角色跨阶段换脸，用户不一定当场发现，
        后续视频按不一致的首帧全量生成，损失远大于这里报错停下。所以逐个阶段换提示词
        重试，全失败才把该角色整组判失败（且一张都不落库）。
        基准阶段试失败的条目不在此时结算——它们回到 pend，稍后带基准图重试一次。
        """
        pend = sorted(char_items, key=lambda x: x.get("ep_from", 999))
        if base_url is None:
            base_errs: list[str] = []
            for it in list(pend):
                url, err = await _gen_and_save(it)
                if url:
                    _report(it["name"], [url])
                    pend.remove(it)
                    base_url = url
                    break
                base_errs.append(f"{it['name']}={err}")
            if base_url is None:
                # 该角色一张都生不出来：整组判失败，不留"各自文生图"的隐患
                for it in pend:
                    _report(it["name"],
                            error=f"基准定妆图生成失败，整组跳过（以免跨阶段换脸）：{base_errs[0] if base_errs else ''}")
                results.append({
                    "name": f"角色「{cname}」",
                    "error": f"所有 {len(base_errs)} 个阶段的基准定妆图均生成失败，"
                             f"该角色未产出任何图。明细：" + "；".join(e[:80] for e in base_errs),
                })
                _update(jid, result=json.dumps(results, ensure_ascii=False))
                return
        # 剩余阶段并发，全部以同一张基准图为参考 → 同角色跨造型保持同一张脸
        if pend:
            out = await asyncio.gather(*[_gen_and_save(it, ref_urls=[base_url])
                                         for it in pend])
            for it, (url, err) in zip(pend, out):
                _report(it["name"], [url] if url else None,
                        error=None if url else f"生成失败：{err}")

    async def _gen_scene(scene_key: str, view_items: list[dict],
                         base_url: str | None):
        """一个场景的所有待生成视角（多视角参考图，2026-09-09 新增）。

        与 `_gen_character` 同构，理由也同构：先串行生**主视角全景**当基准，
        其余 7 张全部 `ref_urls=[base]` 并发生成。

        为什么场景也需要基准链（用户反馈「不同图片画面色调不统一」的成因之三）：
        没有基准图时，同一个客厅的 8 个视角是 8 次独立生成 —— 不但色调各走各的，
        连"这是同一个房间"都不成立（墙纸、地板、家具会各画一套）。角色侧靠基准图
        链解决了跨造型换脸，场景侧照抄即可。

        与 `_gen_character` 的**一处关键差别**：主视角失败时**不**整组判失败，
        而是退回各自独立生成。理由是代价不对称——
        · 角色换脸 = 后续视频全废（必须阻断）；
        · 场景视角不一致 = 参考图差一点，画面仍能用（阻断反而让这个场景一张图都没有，
          注入时连兜底都没得挑，退化成纯文生图）。
        """
        prim = [it for it in view_items if it.get("primary")]
        rest = [it for it in view_items if not it.get("primary")]
        if base_url is None and prim:
            it = prim[0]
            url, err = await _gen_and_save(it)
            _report(it["name"], [url] if url else None,
                    error=None if url else f"生成失败：{err}")
            base_url = url
            prim = []
        pend = prim + rest
        if not pend:
            return
        if base_url is None:
            log.warning("[asset_batch] 场景「%s」主视角未生成，其余视角退回独立生成"
                        "（视角之间可能不是同一个空间）", scene_key)
        out = await asyncio.gather(*[
            _gen_and_save(it, ref_urls=[base_url] if base_url else None)
            for it in pend])
        for it, (url, err) in zip(pend, out):
            _report(it["name"], [url] if url else None,
                    error=None if url else f"生成失败：{err}")

    async def _gen_simple(item: dict):
        """场景 / 无阶段的配角：彼此无依赖，直接并发。"""
        url, err = await _gen_and_save(item)
        _report(item["name"], [url] if url else None,
                error=None if url else f"生成失败：{err}")

    # ---- 分组：角色阶段（按角色聚合）| 场景视角（按场景聚合）| 无阶段配角 ----
    by_char: dict[str, list[dict]] = defaultdict(list)
    by_scene: dict[str, list[dict]] = defaultdict(list)
    simple: list[dict] = []
    char_base: dict[str, str | None] = {}
    scene_base: dict[str, str | None] = {}
    with get_session() as session:
        for item in items:
            if item.get("scene_view_id"):
                # 多视角场景图：按场景资产聚合，同场景串行出基准 → 其余并发
                by_scene[item.get("scene_asset_id") or item["scene_view_id"]].append(item)
                continue
            st = (session.get(AssetStage, item["stage_id"])
                  if item.get("stage_id") else None)
            if st is None:
                simple.append(item)
                continue
            item["ep_from"] = st.ep_from          # 基准优先级：时间上最早的造型
            by_char[st.character_name].append(item)
        # 基准图优先取"该角色已有的图"：本批之外的阶段图 > 角色通用图
        # （判定与资产弹窗手动生图共用 asset_ref.character_base_ref，
        #  否则两条路挑的基准不一样，手动补的那张就跟批量出的不是同一张脸）。
        # 已有图时无需先串行生一张，全部阶段可直接并发。
        from .asset_ref import character_base_ref
        for cname in by_char:
            char_base[cname] = character_base_ref(
                session, project_id, cname,
                exclude_stage_ids={it["stage_id"] for it in by_char[cname]})
        # 场景基准 = 已有的主视角图。补齐个别缺失视角时（主视角早就有图）
        # 直接拿它当参考，不必先串行生一张。
        from .scene_view import base_ref as _scene_base_ref
        for said in by_scene:
            base = _scene_base_ref(session, said)
            # 本批要重画主视角时，那张旧图不能当基准——否则新主视角会照抄旧的，
            # 用户点"重画"等于没画。
            if any(it.get("primary") for it in by_scene[said]):
                base = None
            scene_base[said] = base

    # ---- 并发执行 ----
    # 图像侧默认**不设并发上限**（settings.image_concurrency=0）：渠道冷却 + 抖动退避
    # 天然自适应真实承载力，此前固定 8 并发过于保守。慢的根因是整批串行；
    # 若网关仍限流（429），正确解法是加 KEY / 提配额（遵并发铁律）。
    gate = _image_gate()

    async def _limited(coro_fn):
        async with gate:
            await coro_fn()

    await asyncio.gather(
        *[_limited(lambda it=it: _gen_simple(it)) for it in simple],
        *[_limited(lambda c=c, its=its: _gen_character(c, its, char_base.get(c)))
          for c, its in by_char.items()],
        *[_limited(lambda k=k, its=its: _gen_scene(k, its, scene_base.get(k)))
          for k, its in by_scene.items()],
    )

    # 整批判定：一张都没产出才算 failed（部分成功仍 done，失败明细进 error 供前端提示）。
    # 注意 results 里除逐条目结果外还可能有「角色「X」」这样的整组汇总行，不能按条数比。
    failed = [r for r in results if "error" in r]
    ok = [r for r in results if r.get("urls")]
    # ⚠️ 用户主动取消不是"失败"（2026-09-01 生产报障）。
    # 原来一律判 failed，于是用户点了「停止生产」之后，界面弹出一张红色
    # 「生成失败」卡片，正文是**每一条**资产的
    # `{"name":"场景-AEGIS公司","error":"生成失败：已取消"}` —— 实测生产上那条
    # 记录 12KB、几十项，用户完全读不出"这是我自己取消的"。
    # 取消时给 cancelled + 一句人话；`_update` 里那段"cancelled 不许被改回"
    # 只挡 status，仍会把 error 写进去，所以必须在这里就给对文案。
    cancelled = bool(failed) and all(
        str(r.get("error", "")).endswith(_CANCELLED_MSG) for r in failed)
    if cancelled and not ok:
        _update(jid, status="cancelled",
                error=f"已取消（{len(failed)} 项未开始生成）")
        return
    _update(
        jid,
        status="failed" if (total and not ok) else "done",
        error=_brief_errors(failed) if failed else None,
    )


def _resolve_project_gen_settings(proj) -> tuple[str | None, str | None]:
    """解析项目级 (generation_mode, image_model)。

    2026-08 重构：新项目统一读 default_profile JSON；
    旧预设项目（fast/consistent/premium/first_frame）通过 _LEGACY_DEFAULTS 兜底。
    """
    if proj is None:
        return None, None
    gen_mode = image_model = None
    if proj.default_profile:
        try:
            cs = json.loads(proj.default_profile)
            gen_mode = cs.get("generation_mode")
            image_model = cs.get("image_model")
        except (ValueError, AttributeError):
            pass
    if not gen_mode or not image_model:
        # 旧预设兜底
        pm = proj.production_mode or ""
        d = _LEGACY_DEFAULTS.get(pm, {})
        gen_mode = gen_mode or d.get("generation_mode")
        image_model = image_model or d.get("image_model")
    # 首帧 / 首尾帧 / 尾帧已下线：老项目里存着的这三种一律按全能参考读，不迁移数据。
    from .providers.base import live_generation_mode
    return live_generation_mode(gen_mode), image_model


#: 资产分类 → 允许单独指定生图模型的键名。三种顺序即界面上三个标签页的顺序。
ASSET_KINDS: tuple[str, ...] = ("character", "location", "prop")


def asset_image_models(proj) -> dict[str, str | None]:
    """项目级的**按类别**生图模型：{character/location/prop: model_id 或 None}。

    存在 `default_profile.image_model_by_kind`（既有 JSON 列，不新增列、
    不用 migration —— 与 `subtitle_style` 同一种存法）。

    ## 为什么需要它

    同一部片里三类的出图需求完全不同：角色要换脸稳定、场景要大空间透视、
    道具要材质特写。实测 z-image 人像最稳但场景发灰，gpt-image-2 场景最好
    但人脸千篇一律。此前只有一个全局 `image_model`，用户只能二选一，
    然后靠"导出去别的工具重做"绕过。

    值为空/缺键 = 跟随项目（`default_profile.image_model`），
    与改动前完全等价 —— 这条是**增量**开关，不动存量行为。
    """
    from .db import profile_of
    raw = (profile_of(proj) or {}).get("image_model_by_kind")
    out: dict[str, str | None] = {k: None for k in ASSET_KINDS}
    if isinstance(raw, dict):
        for k in ASSET_KINDS:
            v = raw.get(k)
            if isinstance(v, str) and v.strip():
                out[k] = v.strip()
    return out


def _resolve_asset_image_model(proj, kind: str | None) -> str | None:
    """该类别资产出图该用哪个模型。

    优先 **类别覆写** → 项目 image_model → None（Provider 回落到平台默认）。

    `kind` 为空（老条目没带分类）时直接走项目级，与改动前一致。
    """
    if proj is None:
        return None
    if kind in ASSET_KINDS:
        v = asset_image_models(proj).get(kind)
        if v:
            return v
    return _resolve_project_gen_settings(proj)[1]


def _category_image_model(proj, kind: str | None) -> str | None:
    """**只**返回该类别显式配置过的模型；没配返回 None（调用方自行回退）。

    与 `_resolve_asset_image_model` 的差别就是没有项目级兜底：
    批量生图要按 "条目显式 > 类别配置 > 整批 model_id > 平台默认" 排序，
    如果这里也兜底到项目模型，整批 model_id（可能来自"重画这一张"弹窗里
    用户当场选的）就永远轮不上了。
    """
    if proj is None or kind not in ASSET_KINDS:
        return None
    return asset_image_models(proj).get(kind)


#: 画幅 → 首帧图 size（与视频画幅一致，防止首帧比例错配导致裁切偏移）
_FRAME_SIZES = {"9:16": "1024x1792", "16:9": "1792x1024", "1:1": "1024x1024",
                "3:4": "1024x1365", "4:3": "1365x1024", "21:9": "1792x768"}

#: **资产图**（定妆照 / 场景参考图）的出图尺寸（2026-09-21 P0-4，2026-10-06 改版）。
#:
#: ## 2026-10-06：横画幅不再退回方图
#:
#: 改动前只有竖画幅跟项目走，横画幅（16:9 / 4:3 / 21:9）**一律退回 1:1**，
#: 理由记在下面那段旧实测里。**那条依据的前提已经变了**，故本次推翻：
#:
#:   1. 旧实测测的是**三视图**（正/侧/背并排），"16:9 下正面像只剩 153px"
#:      正是要把三个人塞进宽而矮的框造成的。版式已于同日改成
#:      **头图｜正面(遮面)｜背面**三段 —— **少一个视图，每个视图横向宽 50%**；
#:   2. 旧比较混进了"渠道返回尺寸 ≠ 请求尺寸"：1:1 请求 1024 实回 1254
#:      （多 50% 像素），16:9 却精确回 1792×1024。**基线本身不公平**；
#:   3. 用户 2026-10-06 指出：剧本平台的生图工作台支持 10 个比例，横画幅是常见
#:      选择；而织影**自己的首帧链路**早就在用 1792x1024 / 1365x1024 了
#:      （见上面的 `_FRAME_SIZES`），**只有资产链路还在退回方图** —— 不一致。
#:
#: 重测（`scripts/verify_asset_landscape_ab.py`，4 角色 × 3 尺寸，新版式固定，
#: 只变 size）。**看绝对像素，"脸有多大"才是真的**：
#:
#: | 尺寸 | 请求 → 实回 | 头图宽 | 全身视图宽 |
#: |---|---|---|---|
#: | 1024×1024 方 | 1254×1254 | 546px | 330px |
#: | **1792×1024（16:9）** | 1659×948 | **655px** | 305px |
#: | 1365×1024（4:3） | 1448×1086 | 612px | **343px** |
#:
#: 结论：**方图是三项里最差的一档**。16:9 给的头图比方图**大 20%**
#: （参考图的脸越大、视频模型锁脸越稳），4:3 则在两个视图上都均衡。
#: "退回方图"不仅没有保住脸，反而把脸做小了。
#:
#: ## 为什么不直接复用 `_FRAME_SIZES`
#:
#: 改造前这里硬编码 `1024x1024`，资产图一律 1:1、而成片是 9:16 ——
#: 定妆图喂给视频模型时要做一次隐式重构图（中国短剧团队的说法是
#: "比例漂移 → 脸最先崩"）。所以本该"跟项目画幅走"。
#: 现在两张表的关系是：**取值同源、但资产链路按自己的版式独立取尺寸**。
#: 21:9 也补齐（`_FRAME_SIZES` 里本来就有 1792x768）。
#:
#: ⚠️ 前提已验证：`size` 确实生效（实测各画幅全部跟上请求；渠道偶尔返回近似尺寸
#: —— 请求 1792×1024 回 1659×948、请求 1365×1024 回 1448×1086 ——
#: 但**比例与绝对像素都保持住了**，上表比较的就是实回值）。
#:
#: ⚠️ 未验证的部分：「横画幅定妆图喂视频模型，成片是否真的更稳」需要真出片
#: （实测 D 本体），本次未做。此处改的是有实测支撑的那一半（像素利用率）。
_ASSET_SIZES = {"9:16": "1024x1792", "3:4": "1024x1365", "1:1": "1024x1024",
                "16:9": "1792x1024", "4:3": "1365x1024", "21:9": "1792x768"}
_ASSET_SIZE_DEFAULT = "1024x1024"


#: 场景资产图的**固定**尺寸：16:9 横幅，**不跟项目画幅走**（用户 2026-10-15 裁定）。
#:
#: 理由：场景图是"这个空间长什么样"的参考，竖幅 9:16 天然装不下一个房间的
#: 横向信息（左右墙、门窗、陈设关系全被裁掉），用户反馈竖屏场景图"场景信息
#: 通常不全"。人物定妆图仍跟项目画幅（脸与全身比例要贴近成片构图），道具同理。
#:
#: ⚠️ 必须在**每一条**出场景图的路径上生效（2026-10-15 之前曾"以为改过但没生效"）：
#:   ① 批量 asset_batch —— 场景多视角 8 张（scene_view_id 项）；
#:   ② 单张 asset_generate / asset_candidates —— 资产弹窗「用这段提示词生图」；
#:   ③ POST /assets/{id}/scene-views/generate（routers/look.py）。
#: 漏一条，那条路出的就还是竖图，而用户只会觉得"又没生效"。
#: 统一走 `_size_for_kind`，别在调用点各写一份。
SCENE_ASSET_SIZE = "1792x1024"


def _size_for_kind(kind: str | None, default: str) -> str:
    """资产图尺寸按类别取：场景固定 16:9，其余用调用方给的（跟项目画幅）。"""
    return SCENE_ASSET_SIZE if (kind or "") == "location" else default


def _asset_size(aspect: str | None) -> str:
    """资产图尺寸。**跟项目画幅走**（含横画幅），未知值退回 1:1。

    与 `asset_prompt._PORTRAIT_ASPECTS` 同源：那张表里判为竖画幅的，
    在这里拿到竖尺寸；横/方画幅拿到横向或方形尺寸 —— 两边必须一致，
    否则会出现"按竖幅分段排版、却出成方图"这种自相矛盾的组合。
    """
    return _ASSET_SIZES.get((aspect or "").strip(), _ASSET_SIZE_DEFAULT)

#: 首帧生成喂给图像模型的参考图张数上限。
#: 与视频模型的 max_reference_images 无关——那是"视频侧能吃几张"，
#: 这是"生图侧能吃几张"，两者不可混用（混用会篡改视频通道能力值）。
_FRAME_REF_LIMIT = 4

#: 每 (project_id, canonical) 一把锁：同场景多镜头并发时，
#: 只让第一个镜头生成场景锚点，其余等待后复用，避免重复烧钱与锚点竞争。
#: 只锁"锚点生成"，不锁视频生成——视频侧 300 并发不受影响（遵并发铁律）。
#:
#: ⚠️ 曾按 (project_id, episode, location) 建键。那意味着同一个房间在第 1 集和
#: 第 10 集各生成一张互不相干的基准帧，跨集必漂；而拆解出的 location 每集写法
#: 还不一样（实测 22 个场景名跨集复用率 0，见 db.SceneAlias），于是同一集内
#: 换个写法也会再出一张。现在统一按**归一场景名**共享。
_ANCHOR_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}
_ANCHOR_LOCKS_GUARD = asyncio.Lock()


async def _anchor_lock(key: tuple[str, str]) -> asyncio.Lock:
    """取该场景的锁（首次访问时创建）。守卫锁保证 dict 写入本身线程安全。"""
    async with _ANCHOR_LOCKS_GUARD:
        lk = _ANCHOR_LOCKS.get(key)
        if lk is None:
            lk = asyncio.Lock()
            _ANCHOR_LOCKS[key] = lk
        return lk


def scene_canonical(project_id: str, location: str | None) -> str:
    """`Shot.location` 原值 → 归一场景名（空名返回空串）。"""
    if not location or not location.strip():
        return ""
    from .scenes import canonical_of
    with get_session() as session:
        return canonical_of(session, project_id, location)


def _get_anchor(project_id: str, canonical: str, episode: int | None = None,
                location: str | None = None) -> str | None:
    """查场景锚定图 URL（无则 None）。

    先按归一场景名查；查不到再按旧键 (episode, location) 兜一次——旧库里
    `canonical` 是 NULL 的历史行仍要能命中，否则升级后所有锚点都要重出一遍（白烧钱）。
    """
    from .db import SceneAnchor
    with get_session() as session:
        if canonical:
            a = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.canonical == canonical).first())
            if a is not None:
                return a.image_url
        if location:
            q = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.location == location))
            if episode is not None:
                q = q.filter(SceneAnchor.episode == episode)
            a = q.first()
            if a is not None:
                return a.image_url
        return None


def _put_anchor(project_id: str, canonical: str, episode: int, location: str,
                image_url: str, prompt: str) -> None:
    """落库场景锚定图（同一归一场景已存在则覆盖——重生锚点走同一入口）。

    `episode` / `location` 只作"这张锚点是从哪一镜建起来的"来源记录，
    共享与查找一律按 `canonical`。
    """
    from .db import SceneAnchor
    with get_session() as session:
        a = None
        if canonical:
            a = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.canonical == canonical).first())
        if a is None:
            # 旧行（canonical 为 NULL）就地补上 canonical，不再新增一行
            a = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.episode == episode,
                         SceneAnchor.location == location).first())
        if a is None:
            a = SceneAnchor(id=uuid.uuid4().hex[:16], project_id=project_id,
                            episode=episode, location=location)
            session.add(a)
        a.canonical = canonical or None
        a.image_url = image_url
        a.prompt = prompt
        session.commit()


async def _ensure_scene_anchor(project_id: str, episode: int, location: str,
                               ref_urls: list[str], ref_labels: list[str],
                               aspect: str, image_model: str | None,
                               force: bool = False,
                               canonical: str | None = None) -> str | None:
    """取（或首次生成）该场景的锚定基准帧。

    同场景所有镜头共享此帧作参考 → 陈设/光线/机位基调统一，
    这是"同一场景不同镜头之间场景漂移"的主要解法。
    共享粒度是**归一场景**（同一个房间跨集/跨写法都是同一张），
    `canonical` 不传则就地解析。
    返回 None 表示锚点不可用（上层降级为仅用资产图，不阻塞出片）。
    """
    if not location:
        return None
    canon = canonical if canonical is not None else scene_canonical(project_id, location)
    if not force:
        hit = _get_anchor(project_id, canon, episode, location)
        if hit:
            return hit
    lk = await _anchor_lock((project_id, canon or location))
    async with lk:
        # 锁内二次查库：并发同场景的其他镜头可能已建好锚点
        if not force:
            hit = _get_anchor(project_id, canon, episode, location)
            if hit:
                return hit
        listing = ("；".join(f"参考图{i + 1}为{lb}"
                            for i, lb in enumerate(ref_labels)) if ref_labels else "")
        st = _style_of(project_id)
        prompt = (
            f"{st.anchor_head}：{canon or location}。{listing}"
            f"{'。人物外观、服装、发型与场景陈设必须与参考图完全一致，不得改变。' if ref_labels else ''}"
            "requirements：完整呈现该场景的空间布局、陈设、材质与光线氛围，"
            "视角为该场景的标准全景机位，构图稳定、光线自然。"
            "本图将作为该场景所有镜头的统一视觉基准。"
            "禁止出现任何文字、水印、字幕、分镜框。"
            # 画风否定项必须跟着 anchor_head 一起给：基准帧是"该场景所有镜头的
            # 视觉基准"，它跑偏了下游每一镜都跟着跑偏。只给正向的
            # 「国漫动画场景基准图」而不给「禁止真人实拍照片感」，模型很容易
            # 出成实景照片——这一层是整条链上最不能省否定项的地方。
            # （都市档因此比改动前多一句「禁止卡通、动漫、插画、3D 渲染风格」，
            #  与该档本意同向，属收紧。）
            + st.negative
            # 锚点是"该场景所有镜头的视觉基准"，它自己不带影调，
            # 下游每镜首帧就会各自漂一点色 —— 影调必须从基准帧这一层就定下来。
            + _look_line(project_id))
        url = await _image_gen(prompt, aspect, image_model, ref_urls)
        if url:
            _put_anchor(project_id, canon, episode, location, url, prompt)
        return url


async def _image_gen(prompt: str, aspect: str, image_model: str | None,
                     ref_urls: list[str], strict: bool = False) -> str | None:
    """调图像模型出一张图。

    strict=False（默认）：失败返回 None，调用方自行降级——视频批量生成走这条，
      首帧失败会自动回退全参考路线，不该因一张图中断整批出片。
    strict=True：把异常原样抛出，让调用方拿到**真实失败原因**（尤其是
      ContentRejected 内容审核拒绝）。批量首帧走这条：用户明确要的就是首帧图，
      失败时必须告诉他"是提示词被判违规、该换模型或改写"，而不是吞成一句
      含糊的"图像渠道不可用"（2026-08 项目 812 的实际困惑来源）。
    """
    from .providers.image import ImageProvider, RefUnavailable
    provider = ImageProvider(model_id=image_model or "gpt-image-2")
    try:
        urls = await provider.generate(
            prompt, size=_FRAME_SIZES.get(aspect, "1024x1792"), n=1,
            ref_urls=ref_urls[:_FRAME_REF_LIMIT] or None)
        return urls[0] if urls else None
    except RefUnavailable as e:
        # 参考图取不到**必须留痕**，即使本轮不打算因为它中断整批出片。
        # 否则表现是"首帧/资产生成失败"，而真正的原因（某张参考图挂了）
        # 在这层被吞掉，排查只能靠猜。strict 时照旧抛给上层。
        log.warning("[image] 参考图取不到，本张降级为不带参考：%s", e)
        if strict:
            raise
        return None
    except Exception:  # noqa: BLE001  生图失败不阻塞出片，由上层降级
        if strict:
            raise
        return None


# ⚠️ 这里原有 `_distill_frame_prompt`（把镜头描述蒸馏成首帧画面描述）与
# `_gen_first_frame`（按描述 + 参考图 + 场景基准图出一张首帧图），2026-11-20 整体删除：
# 首帧路线下线，镜流不再给镜头出首帧图。


def _resolve_project_video_model(proj) -> str | None:
    """解析项目级默认视频模型。

    2026-08 重构：production_mode 从"技术参数预设"改为"配音策略"（drama/narration），
    技术参数统一存入 default_profile JSON。
    旧值（fast/consistent/premium/first_frame/custom）在迁移期间通过
    _LEGACY_DEFAULTS 平滑读取。
    """
    if proj is None:
        return None
    if proj.default_profile:
        try:
            model = json.loads(proj.default_profile).get("video_model")
            if model:
                return model
        except (ValueError, AttributeError):
            pass
    # 旧数据兜底：production_mode 是旧预设值时从 _LEGACY_DEFAULTS 取
    pm = proj.production_mode or ""
    return _LEGACY_DEFAULTS.get(pm, {}).get("video_model")


def _resolve_project_resolution(proj) -> str | None:
    """解析项目级默认分辨率档位（"480p"/"720p"/"1080p"/"2k"）。

    与 `_resolve_project_video_model` 同一套口径：**先读 `default_profile`**
    （新建向导把 video_model / image_model / generation_mode / resolution
    四项一起存在这里，不分模式），读不到再退 `_LEGACY_DEFAULTS`。

    ⚠️ 2026-09-10 修：此前这段逻辑内联在 `run_shot_videos` 里，且条件写成
    「production_mode 等于 custom 且 default_profile 非空」——
    只有旧的 custom 项目才读得到。可 2026-08 改版后 `production_mode` 已经变成
    **配音策略**（drama/narration/anime），没有一个新项目是 custom，
    于是**新建项目时选的分辨率对所有新项目一律无效**（proj_mp=None，
    实际下发由 Provider 自己定）。同一份 default_profile 里的 video_model
    却是全模式读的，两者口径不一致纯属遗漏。
    """
    if proj is None:
        return None
    if proj.default_profile:
        try:
            res = json.loads(proj.default_profile).get("resolution")
            if res:
                return str(res).lower()
        except (ValueError, AttributeError):
            pass
    pm = proj.production_mode or ""
    res = _LEGACY_DEFAULTS.get(pm, {}).get("resolution")
    return str(res).lower() if res else None


def _shot_mp(override: dict) -> float | None:
    """镜头级 `profile_override.resolution`（档位名）→ megapixels。

    **只认 `RESOLUTION_TIERS` 里的键**（480p/720p/1080p/2k）。认不出时返回 None
    （= 继续沿用 job/项目那两层），不猜、不报错：

      · 这一层是**增强**，不是必填。老数据里根本没有这个键（此前只有数值
        `megapixels`），返回 None 才是"没设过"的正确语义。
      · 写错了（`1080P` 大小写、`1080`、"高清"）就那么放着不管吗？不 ——
        大小写与空白归一后再查表（用户从外部粘贴过来很常见），仍不中就
        记一条 warning 并在返回值里体现为"没生效"。**静默忽略一个写错的档位**
        正是本项目最反感的那类缺陷，所以这里必须留痕。
    """
    from .shot_timing import RESOLUTION_TIERS
    raw = override.get("resolution")
    if raw is None:
        return None
    key = str(raw).strip().lower()
    if not key:
        return None
    mp = RESOLUTION_TIERS.get(key)
    if mp is None:
        log.warning("[refs] 镜头 profile_override.resolution=%r 不是已知档位"
                    "（可选 %s），已忽略，沿用项目设置",
                    raw, ", ".join(RESOLUTION_TIERS))
    return mp


#: 镜头不会被送去生成的原因（`shot_video_targets` 的 excluded[].reason）
_EXCLUDE_CN = {"disabled": "已停用", "external": "外部素材（自带成片，不由 AI 生成）"}


def _locked_prompt_of(override) -> str:
    """镜头**已锁定**的镜头脚本（`profile_override.prompt`）；没有返回空串。

    `override` 收 `Shot.profile_override` 的原始 JSON 文本或已解析的 dict。
    只剩编辑器残留 / 空白的稿不算有稿。出片、首帧共用这一个判据。
    """
    if isinstance(override, str):
        try:
            override = json.loads(override) if override else {}
        except ValueError:
            override = {}
    if not isinstance(override, dict):
        return ""
    raw = override.get("prompt")
    return strip_editor_chrome(raw).strip() if isinstance(raw, str) else ""


def unlocked_prompt_error(order) -> str:
    """「这一镜没有锁定的镜头脚本」的统一文案（`order` = 全剧镜号）。"""
    return f"镜头 {order} 还没有锁定的镜头脚本，请先由 Muse 写入并锁定"


def shot_video_targets(session, project_id: str, payload: dict) -> tuple[list, list[dict]]:
    """出片批次的范围判定：返回 (要生成的镜头, 被排除的镜头说明)。

    `run_shot_videos` 与提交前的预检（routes_v2.submit_job）共用这一份，
    两边说法才不会对不上。

    范围：`shot_ids` > `orders` > 缺省（只补还没出片的）。范围内的
    停用镜头与外部素材（is_special）不送去生成 —— 显式点选时同样排除，
    避免误触发对片头/片尾重跑。排除的逐镜列出原因，不再静默丢掉。
    """
    shots = (session.query(Shot).filter(Shot.project_id == project_id)
             .order_by(Shot.order).all())
    shot_ids = payload.get("shot_ids")
    orders = payload.get("orders")
    if shot_ids:
        want = set(shot_ids)
        shots = [s for s in shots if s.id in want]
    elif orders:
        want = set(orders)
        shots = [s for s in shots if s.order in want]
    else:
        shots = [s for s in shots if not s.video_url]   # 默认只补未生成的
    keep, excluded = [], []
    for s in shots:
        why = "disabled" if s.disabled else ("external" if s.is_special else "")
        if why:
            excluded.append({"shot_id": s.id, "order": s.order, "episode": s.episode,
                             "reason": why, "name": s.special_name or ""})
        else:
            keep.append(s)
    return keep, excluded


def excluded_note(excluded: list[dict]) -> str:
    """「这批镜头都不能生成」的一句人话：几个、各是什么原因、是哪几镜。"""
    by: dict[str, list[int]] = {}
    for x in excluded:
        by.setdefault(x["reason"], []).append(x["order"])
    parts = []
    for why, orders in by.items():
        shown = "、".join(f"#{o}" for o in orders[:8]) + ("…" if len(orders) > 8 else "")
        parts.append(f"{len(orders)} 个{_EXCLUDE_CN.get(why, why)}（{shown}）")
    head = f"这批 {len(excluded)} 个镜头都不能生成：" + "；".join(parts) + "。"
    tail = []
    if "external" in by:
        tail.append("外部素材镜头要换成 AI 镜头才能生成，可以删掉后重新拆解这一集")
    if "disabled" in by:
        tail.append("停用的镜头要先在时间轴上恢复")
    return head + ("；".join(tail) + "。" if tail else "")


async def run_shot_videos(jid: str, progress_cb=None, phase_jid: str | None = None,
                          parent_jid: str | None = None) -> None:
    """镜头批量生成视频（阶段④，R0 状态机版）。

    payload = {
      "project_id": "...",            # 必填
      "shot_ids": ["..."] | null,     # 优先：按镜头 id 选择（契约 C2）
      "orders": [1,2,3] | null,       # 兼容旧口径
      "model_id": null,               # 显式指定则覆盖策略链
      "resolution": null,             # 本次覆写分辨率档位（480p/720p/1080p/2k）；
                                      # **null = 沿用项目设置**，不要为了"沿用"下发具体值
      "aspect_ratio": null,           # 本次覆写画面比例；null = 沿用项目 base_aspect
      "prompt_prefix": "..."
    }
    每镜执行链：prompting(取锁定的镜头脚本) → generating → 成功建 shot_version 置 review。
    模型选择按契约 C4：shot.profile_override > project.production_mode 映射 > settings。

    ⚠️ **镜头脚本只认 Muse 写入并锁定的那一稿**（`profile_override.prompt`，
    2026-11-19 用户裁定）。没有锁定稿的镜头**当场失败**并写明原因，本函数不再调
    文本模型现写/改写提示词（原 `prompt_opt.optimize_full` 兜底已删）。

    `phase_jid`：阶段标签写到哪个 job 上（默认自己）。一条龙把父 job id 传进来，
    好让用户在父任务上就看到"正在出首帧 32/170"，而不是盯着一个不可见的子 job。
    """
    from .config import get_settings

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    #: TB-05 生成变体：显式 seed 让同一条 prompt 出可复现的另一版画面。
    #: None（缺省）= Provider 自行随机化，这是常规生成的行为，不要改。
    batch_seed = p.get("seed")
    if batch_seed is not None:
        try:
            batch_seed = int(batch_seed)
        except (TypeError, ValueError):
            batch_seed = None

    # 项目级默认（C4 中层）：共用解析函数（预设映射 / default_profile）
    from .db import Project
    from .shot_timing import RESOLUTION_TIERS
    with get_session() as session:
        proj = session.get(Project, project_id)
        mode_model = _resolve_project_video_model(proj)
        proj_resolution = _resolve_project_resolution(proj)
        proj_aspect = proj.base_aspect if proj else "9:16"
        proj_aspect_raw = proj_aspect
        # 首帧流水线（i2va）：项目 generation_mode=i2va 时启用两段式生成
        proj_gen_mode, proj_image_model = _resolve_project_gen_settings(proj)

    # ---- 本次覆写（一键成片「本次参数」/ 单独出片时的临时选择）----
    # payload 里给了就以它为准，没给（None）= 沿用项目设置。
    # ⚠️ 必须区分"没给"与"给了空值"：`p.get("resolution") or proj_resolution`
    # 这种写法会把显式的空串也当成没给，但更要命的是反过来——一旦前端为了
    # "沿用"而下发一个具体值（旧代码就是 width/height 兜底成 1080×1920），
    # 用户在项目里选的档位就被永久顶掉了。所以约定：**沿用就不要下发这个键**。
    batch_resolution = p.get("resolution")
    if batch_resolution:
        batch_resolution = str(batch_resolution).lower()
        if batch_resolution not in RESOLUTION_TIERS:
            log.warning("未知分辨率档位 %r（job=%s），忽略，沿用项目设置 %r",
                        batch_resolution, jid, proj_resolution)
            batch_resolution = None
    eff_resolution = batch_resolution or proj_resolution
    eff_aspect = p.get("aspect_ratio") or proj_aspect_raw
    #: 生效分辨率 → megapixels（镜头 override.megapixels 仍最优先，见 VideoRequest 处）
    proj_mp = RESOLUTION_TIERS.get(eff_resolution or "", None)
    proj_aspect = eff_aspect
    if batch_resolution or p.get("aspect_ratio"):
        log.info("job=%s 本次参数覆写：分辨率 %s→%s，画幅 %s→%s",
                 jid, proj_resolution, eff_resolution, proj_aspect_raw, eff_aspect)

    default_model = p.get("model_id") or mode_model or get_settings().video_model

    with get_session() as session:
        shots, excluded = shot_video_targets(session, project_id, p)
        plan = [(s.id, s.order, s.script_ref, s.profile_override, s.duration_sec)
                for s in shots]

    if not plan:
        # ⚠️ 空批次分两种，**不能都报成功**（2026-11-03）：
        #   · 范围里本来就没有要生成的（缺省范围下全都已出片）→ done，确实没事可做；
        #   · 范围里有镜头、但全被排除（停用 / 外部素材）→ failed 并逐镜说原因。
        #     原先这里一律写 done，任务队列一秒显示「成功」，镜头却还是「未出片」，
        #     用户反复点、反复"成功"（生产西北婚约第 5 集，12 镜全被排除）。
        if excluded:
            note = excluded_note(excluded)
            _update(jid, status="failed", progress=100, error=note,
                    result=json.dumps({"shots": [], "skipped": excluded, "note": note},
                                      ensure_ascii=False))
        else:
            _update(jid, status="done", progress=100,
                    result=json.dumps({"shots": [], "note": "没有待生成的镜头（都已出片）"},
                                      ensure_ascii=False))
        return

    _update(jid, status="running")
    # ---- 先把整批标成「生成中」，再去补齐那些可能耗时几分钟的前置材料 ----
    #
    # 为什么不靠 `_run_one` 开头那一句就够了（2026-10-24）：
    # 下面两道 `ensure_*_descriptions` 是**按项目**补的，新项目可能要跑好几分钟
    # （逐条调 LLM 写场景/道具描述）。在那之前一个镜头都没进 `_run_one`，
    # 于是用户点了「生成」之后，界面上整批镜头仍然写着「未出片」—— 看起来
    # 就像没提交成功。而它们其实已经排进这条 job 了。
    #
    # 与 `_run_one` 里那句的区别只是**早写几分钟**，语义完全相同
    # （`prompting` = 已排队、还没提交给上游）。
    #
    # ⚠️ 这两道前置补全一旦抛异常，整批镜头就再没人收尾了（`gather` 还没开始派发，
    #    不会有任何协程去改这一列），它们会以"生成中"的样子挂到巡检那一轮
    #    （最长 300 秒）。既然这一列现在决定界面显示什么，就必须在这里兜住。
    #    只在**这个**范围里兜：`gather` 之后的异常不能这样处理 —— 那时镜头已经
    #    派出去了，还有协程在跑，把它们放回 pending 会把真实结果盖掉。
    _mark_shots_busy([sid for sid, _o, _r, _ov, _d in plan])
    try:
        # 整批都没有锁定脚本 → 每一镜都会在 `_run_one` 入口被拒，这里**一次文本模型
        # 都不调**（下面两道补全会逐条调 LLM 写描述；为一批注定不出片的镜头花这个钱
        # 没有意义，也违背「没锁定脚本就不动模型」的口径）。
        if any(_locked_prompt_of(ov) for _s, _o, _r, ov, _d in plan):
            # 场景描述就地补齐（幂等，全都有描述时零调用）。
            # ⚠️ 不传 p["model_id"]：本 job 的 model_id 是**视频**模型覆盖值，
            # 而 ensure_scene_descriptions 要的是文本模型 id，传进去会拿去调 LLM。
            await ensure_scene_descriptions(project_id)
            # 道具同理。
            await ensure_prop_descriptions(project_id)
    except Exception:
        _release_transient([sid for sid, _o, _r, _ov, _d in plan])
        raise
    prefix = p.get("prompt_prefix") or ""
    results: list[dict] = []
    done_count = 0
    lock = asyncio.Lock()  # 保护 results/进度写入

    # ---- 阶段可见 ----
    # 只有出片一段（「先出整批首帧」那一段随首帧路线 2026-11-20 下线而删除）。
    # `frames_*` 两个键留着恒为 0：网页的进度条按这两个键判断有没有首帧阶段。
    ph_jid = phase_jid or jid

    def _phase() -> dict:
        return {
            "key": "videos", "label": "正在出片",
            "done": done_count, "total": len(plan),
            "frames_done": 0, "frames_total": 0,
            "videos_done": done_count, "videos_total": len(plan),
        }

    async def _report() -> None:
        pct = int(done_count / len(plan) * 100)
        set_job_phase(ph_jid, _phase())
        _update(jid, progress=pct,
                result=json.dumps({"shots": sorted(results, key=lambda r: r["order"])},
                                  ensure_ascii=False))
        if progress_cb:
            progress_cb(pct)

    async def _run_one(sid: str, order: int, script_ref: str,
                       override_raw: str | None, ai_duration: float | None) -> None:
        """单镜全流程：提示词 → 并发池内生成（失败自动重试，重试释放槽再排队）。"""
        nonlocal done_count
        # 取消检查点：不硬杀协程，但不再为**这一镜**发起上游请求。
        # gather 已把所有镜头派发出去了，逐个在入口自行退出是唯一能省钱的粒度。
        #
        # 必须同时看 parent_jid：一键成片为每段新建独立子 job，
        # 用户在 UI 上取消的是**父** job，只查 jid 的话取消传不到正在跑的子任务，
        # 170 个镜头会照样烧完。
        if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
            return
        from .config import get_settings
        s = get_settings()
        # ---- C4 合并：镜头 override 最高优先 ----
        override = json.loads(override_raw) if override_raw else {}
        # ---- 镜头脚本闸门：必须在**任何**生图 / 文本模型 / 出片调用之前 ----
        # 镜头脚本由 Muse 写入并锁定（`profile_override.prompt`）。没有就这一镜失败，
        # 不拿剧本原文或未锁定的底稿去出片，也不再现场让文本模型写一份。
        # 放在入口而不是下面取提示词的地方：走首帧路线的镜头会先花钱出一张首帧，
        # 到那时才发现没有脚本就白花了。
        if not _locked_prompt_of(override_raw):
            _msg = unlocked_prompt_error(order)
            _set_shot_status(sid, "failed", _msg)
            async with lock:
                results.append({"order": order, "shot_id": sid,
                                "reason": "no_locked_prompt", "error": _msg})
                done_count += 1
                await _report()
            return
        model_id = override.get("model_id") or default_model
        provider = registry.get_video(model_id)
        if provider is None:
            _set_shot_status(sid, "failed", f"未注册的视频模型: {model_id}")
            async with lock:
                results.append({"order": order, "error": f"未注册的视频模型: {model_id}"})
                done_count += 1
                await _report()
            return

        raw_prompt = override.get("prompt") or (f"{prefix}{script_ref}" if prefix else script_ref)

        # ---- prompting（池外做：不占生成并发槽）----
        _set_shot_status(sid, "prompting")
        from .providers.base import RETIRED_GENERATION_MODES, infer_generation_mode
        explicit_refs = override.get("ref_urls") or []
        injected_refs: list[str] = []
        injected_labels: list[str] = []
        injected_notes: list[str] = []

        # ---- 首帧 / 首尾帧 / 尾帧三种模式已下线（2026-11-20 用户裁定）----
        # 出片统一走全能参考。镜头上还留着的首帧图 / 尾帧图（手填的、或此前首帧路线
        # 钉在 override 里的）不再当"第一帧 / 最后一帧"下发，而是当**参考图**带上：
        # 这是官方推荐的用法，也是私域人像入库唯一覆盖的位置。它们按「用户手动指定的
        # 参考图」那条路走（排在自动注入之后、过同一套上限与入库），所以已有的
        # `@图片N` 编号不会因为多了帧图而错位。
        # 镜头自己选过这三种模式、或带着帧图的，在版本 meta 里记一条原因。
        asked_mode = override.get("generation_mode")
        frame_labels = {u: label for u, label in (
            (override.get("first_frame_url"), "首帧图"),
            (override.get("last_frame_url"), "尾帧图"),
        ) if isinstance(u, str) and u.strip()}
        frame_refs = list(frame_labels)
        if explicit_refs and frame_refs:
            explicit_refs = list(explicit_refs) + [u for u in frame_refs
                                                   if u not in explicit_refs]
        fallback_reason: str | None = None
        if asked_mode in RETIRED_GENERATION_MODES or frame_refs:
            fallback_reason = ("首帧 / 首尾帧 / 尾帧模式已下线，本镜按全能参考出片"
                               + ("，首帧 / 尾帧图已作为参考图带上" if frame_refs else ""))

        # 注入张数：按视频模型自身的参考图能力取。
        if not explicit_refs:
            inject_cap = getattr(provider, "max_reference_images", 0)
            # 参考位**全额**给定妆图/场景图。
            # 2026-09-11 之前这里会扣掉一位留给"上一镜尾帧"（尾帧接力），
            # 该设计已停用且不会再回来——理由与实测见
            # `docs/DECISION-2026-09-11-尾帧接力停用.md`（一句话：它挤掉一张定妆图，
            # 模型只把它当风格参考，而它作为"视频里渲染出来的人脸"必被 Seedance
            # 人脸审核拦下，实测注入尾帧的 8 镜 8/8 失败、未注入的 9 镜 9/9 通过）。
            injected_refs, injected_labels, injected_notes, injected_srcs = \
                _auto_inject_refs_with_source(sid, inject_cap)

            # ---- 用户手动 @ / 剔除的参考图（2026-10-06）----
            # 自动注入刻意保持克制（每角色 1 张 + 每场景 1 张），因为官方推荐配置
            # 就是「角色图 1-2 张 + 场景图 1 张」，多送是否更好未经验证。
            # 2.5 的素材上限是 30 图，宽出来的名额留给用户点名——
            # 用户 @ 的那张才是确定有用的（道具、同一角色的另一套造型、
            # 场景的某个特定视角，这些都进不了自动注入的白名单）。
            #
            # 顺序：自动注入在前、用户 @ 在后。**这个顺序就是 @图片N 的编号来源**
            # （见 _auto_inject_refs_detailed 的 docstring），且与前端
            # resolveRefs()/refPanel() 的算法必须一致，否则提示词里写"@林七雨"
            # 而模型收到的是另一个人——静默错位，最难查。
            #
            # ⚠️ 这一段必须放在 `_to_trusted_assets` **之前**。
            # 放在之后的话，用户 @ 的图会绕过可信资产转换——而官方 Seedance
            # 恰恰会拦"疑似真人"的参考图，表现是"我明明 @ 了这张，出片就是不带它"
            # 或者整镜被打回，且毫无提示。（自动注入的图走了转换、手动的没走，
            # 这种一半一半的状态最难查。）
            #
            # 反向操作：`refs_hide` 是用户**手动剔除**的自动注入图。此前用户对
            # 自动注入的图没有任何控制权——多出来的只能靠系统截断（"硬丢弃"），
            # 恰好留下的那张不对也没办法。按网址剔除（而不是按角色名）：
            # 同一个角色可能有多套造型，用户要剔的是**眼下这张**。
            user_refs, refs_dropped = _owned_user_refs(override, sid)
            # 镜头上的首帧 / 尾帧图接在用户指定的参考图后面，一起过下面的上限与入库。
            user_refs = list(user_refs) + [u for u in frame_refs if u not in user_refs]
            hide_refs = {u for u in (override.get("refs_hide") or [])
                         if isinstance(u, str) and u.strip()}
            if hide_refs:
                keep_idx = [i for i, u in enumerate(injected_refs) if u not in hide_refs]
                injected_refs = [injected_refs[i] for i in keep_idx]
                injected_labels = [injected_labels[i] for i in keep_idx]
                injected_notes = [injected_notes[i] for i in keep_idx]
                injected_srcs = [injected_srcs[i] for i in keep_idx]
            if user_refs:
                # ⚠️ 兜底口径必须与 `registry.list_video()` **一致**（2026-10-07 修）。
                # 那里报给前端的是
                #   `getattr(p, "max_input_images", p.max_reference_images)`
                # 而这里原来写的是 `getattr(provider, "max_input_images", 0) or 0`
                # —— 两者在"provider 没有这个属性"时**结论相反**：前端显示还能 @
                # 9 张，后端算出预算 0，用户点选的图**一张都进不去**，且静默。
                # 当时受影响的只有低价 seedance2.5（`LowCostSeedanceProvider`
                # 确实没定义该属性），它有 4 个生产项目在用。
                # 改为回落到 max_reference_images，两边从此同源。
                cap = (getattr(provider, "max_input_images", None)
                       or getattr(provider, "max_reference_images", 0) or 0)
                # 首帧 / 尾帧图不再单独占位：它们就在 user_refs 里，与别的参考图同样计数。
                reserved = 0
                budget = max(0, cap - reserved - len(injected_refs))
                added = dropped = 0
                # 本镜显式给了名字的参考图（2026-10-21）。
                # 来源是「生成视频」页给场景/道具换图：那张图是用户刚传的，
                # 资产表里还查不到它的名字，`_ref_label_for` 只能回一句
                # 「补充参考图」——优化器因此把 @名字 转写不出编号，等于白带。
                # 换图接口知道它属于谁，就顺手写在 override 里，这里优先读。
                known_labels = {**frame_labels,
                                **{str(k): str(v)
                                   for k, v in (override.get("ref_labels") or {}).items()
                                   if k and v}}
                for u in user_refs:
                    if u in injected_refs:
                        continue          # 与自动注入重复：不重复占位
                    if added >= budget:
                        dropped += 1
                        continue
                    injected_refs.append(u)
                    # ⚠️ label 必须是**真实名字**，不能写"用户指定"。
                    # 提示词优化器靠 labels 生成 `图片N=角色「X」` 的对照表，
                    # 再据此把提示词里的 `@名字` 转写成 `@图片N`（documented 硬要求：
                    # 不支持用 Asset ID 指代素材）。label 写成"用户指定"的话，
                    # 优化器既不知道这张是谁，也就无法转写——用户 @ 了等于没 @。
                    injected_labels.append(known_labels.get(u)
                                           or _ref_label_for(project_id, u))
                    injected_notes.append("")
                    # 用户手动 @ 的图不是造型自动挑出来的 —— 单独一类，
                    # 免得把它算进"造型生效/回退"任何一边。
                    injected_srcs.append(REF_SRC_MANUAL)
                    added += 1
                if dropped:
                    log.warning("[refs] %s 用户 @ 的参考图有 %d 张超上限"
                                "（%s 上限 %d，已扣首尾帧 %d、自动注入 %d），未带上",
                                sid, dropped, model_id, cap, reserved,
                                len(injected_refs) - added)

            # 官方 Seedance 会拦"疑似真人"的参考图（AI 定妆图也照拦）——
            # 换成已入库的 asset:// 可信资产即可过审。
            # ⚠️ 传的是 provider 的**显式能力声明**而非 model_id：这里以前按
            # `"seedance" in model_id` 判定，第三方低价渠道的 id 同样含 seedance，
            # 会把它每张参考图都传进**火山方舟**私域库——那既是用户明令禁止的
            # "走官方通道"，也是白花配额（那些 asset:// 根本到不了三方渠道）。
            # 覆盖**全部**参考图（自动 + 用户指定），所以放在上面那段之后。
            injected_refs = await _to_trusted_assets(sid, injected_refs,
                                                     uses_ark_assets=bool(
                                                         getattr(provider,
                                                                 "uses_ark_trusted_assets",
                                                                 False)),
                                                     user_urls=user_refs)

        vreq = VideoRequest(
            prompt=raw_prompt,
            # 已下线的三种模式不下发：按素材推断（带图 = 全能参考，否则纯文本）。
            generation_mode=(asked_mode if asked_mode not in RETIRED_GENERATION_MODES
                             else None),
            reference_image_urls=(explicit_refs or injected_refs),
            reference_audio_url=override.get("reference_audio_url"),
            duration_ms=override.get("duration_ms")
                or (int(ai_duration * 1000) if ai_duration else None),
            aspect_ratio=override.get("aspect_ratio") or proj_aspect,
            # 分辨率三层（2026-10-19 用户需求：项目内要能改、也要能单镜改）：
            #   ① 镜头 profile_override.megapixels —— 数值 MP，历史口径，最高优先
            #   ② 镜头 profile_override.resolution —— 档位名（480p/720p/…），
            #      2026-10-19 新加：界面按档位选，不该逼前端自己换算成 MP
            #      （换算表在后端 `RESOLUTION_TIERS`，前端抄一份必然漂移）
            #   ③ job payload.resolution（本次覆写）→ 已经算进 proj_mp
            #   ④ 项目 default_profile.resolution → 同样已算进 proj_mp
            # ② 与 ③/④ 的区别是"这一镜" vs "这一批/整个项目"。
            megapixels=(override.get("megapixels")
                        if override.get("megapixels") is not None
                        else _shot_mp(override) or proj_mp),
            # TB-05 生成变体：payload 显式给 seed 时用它，否则镜头级 override，
            # 再否则 None（Provider 自行随机化 —— 不随机的话同 prompt 永远同一结果）。
            seed=batch_seed if batch_seed is not None else override.get("seed"),
        )
        gen_mode = infer_generation_mode(vreq)
        # ---- 角色音色注入（在 gen_mode 之后，且**不参与** gen_mode 推断）----
        # 顺序是有意的：音色只能改音色。放在推断之前的话，一个纯文本镜头会只因
        # 主角有音色就从 t2va 变成 full_reference，连带换掉提示词框架与工作流路由。
        # （infer_generation_mode 里也去掉了音频那一支，两处一致。）
        voice_note: dict | None = None
        #: 用户手动 @ 的参考音频（音色）。与图片侧同一条规则：自动注入克制、
        #: 余量给用户点名。顺序即 `@音频N` 的编号（自动的那段在前）。
        user_audios = [u for u in (override.get("ref_audios") or [])
                       if isinstance(u, str) and u.strip()]
        #: 本镜「临时参考音频」的说明（url → 用户写的一句话，如「林七雨的音色」）。
        #: 临时音频不挂在任何角色上，`_audio_label_for` 反查不到名字；不带这份
        #: 说明，优化器只能写「补充参考音色」，模型不知道这段该用在谁身上。
        _raw_names = override.get("ref_audio_labels")
        audio_names = ({str(k): str(v).strip()[:40] for k, v in _raw_names.items()
                        if isinstance(k, str) and isinstance(v, str) and v.strip()}
                       if isinstance(_raw_names, dict) else {})
        if not vreq.reference_audio_url:      # 镜头 override 显式给了就不抢
            audio_ok = bool(provider.mode_support().get(gen_mode, {})
                            .get("reference_audio", False))
            v_url, v_label, v_skip = _auto_inject_voice_ref(sid)
            if v_url and audio_ok:
                vreq.reference_audio_url = v_url
                voice_note = {"url": v_url, "label": v_label}
            elif v_url:
                # 有音色但这个通道/模式吃不下 → 明确记原因。能力判定一律以
                # mode_support() 为准：base 的默认字典里根本没有 reference_audio
                # 这个键，取不到就是不支持（保守默认，绝不猜）。
                voice_note = {"skipped": f"{model_id} 在 {gen_mode} 模式下不支持参考音频",
                              "label": v_label}
            elif v_skip:
                voice_note = {"skipped": v_skip}
        # 用户点名的音色：接在自动注入之后，并按模型上限截断。
        if user_audios:
            audio_ok = bool(provider.mode_support().get(gen_mode, {})
                            .get("reference_audio", False))
            if not audio_ok:
                voice_note = {"skipped": f"{model_id} 在 {gen_mode} 模式下不支持参考音频"}
            else:
                cap_a = getattr(provider, "max_reference_audios", 0) or 0
                # ⚠️ 顺序：**用户点名的在前**，自动注入的音色接在后面（2026-10-19 改）。
                #
                # 前端的契约是「音频N = ref_audios 里的第 N 段」（app.js voiceIdxOf），
                # 界面上的编号、用户手写进提示词的「@音频1」都按这个算。此前这里是
                # 自动音色在前、用户的接在后——本镜只要有一个说话人带音色，用户
                # 那段就整体后移一位：界面写「音频1」，模型收到的「音频1」却是
                # 角色音色。加了「临时参考音频」之后这个错位会变成常态，故改顺序。
                # 自动音色并不丢：名额够就照样带上，只是编号排在用户的之后。
                base = list(vreq.reference_audio_urls or [])
                if not base and vreq.reference_audio_url:
                    base = [vreq.reference_audio_url]
                urls = _merge_ref_audios(user_audios, base, cap_a)
                vreq.reference_audio_urls = urls
                # 单值字段与列表首段保持一致：RunningHub 只读它（一路音轨），
                # 用户点名的那段优先于自动推断的说话人音色。
                vreq.reference_audio_url = urls[0] if urls else None
                if voice_note is None or voice_note.get("url") not in urls:
                    # ⚠️ 标签用**真实角色名**反查，不写"用户指定"。
                    # 与图片侧 `_ref_label_for` 完全同一条理由：优化器靠这份
                    # 清单写「音色参考「音频N」」，标签是"用户指定"它就不知道
                    # 第 N 段是谁的音色，那一句写不出来 —— 音色送进去了、
                    # 提示词里一个字不提，出片自然不像。
                    voice_note = {"url": urls[0] if urls else None,
                                  "label": _audio_label_for(project_id, urls[0],
                                                            audio_names)
                                           if urls else "用户指定"}
        # 参考音色的**最终顺序**（= 下发顺序 = `音频N` 编号）：
        # 用户点名的在前，自动注入的接在后面（理由见上）。编号错了会张冠李戴——
        # 把配角的音色安到主角身上，且听感上只是"有点不对"，很难归因。
        _audio_urls = list(vreq.reference_audio_urls or [])
        if not _audio_urls and vreq.reference_audio_url:
            _audio_urls = [vreq.reference_audio_url]
        audio_labels = [_audio_label_for(project_id, u, audio_names) for u in _audio_urls]
        # ---- 提示词：只有一条路 —— Muse 写入并锁定的那一稿，**原样**下发 ----
        #
        # 2026-11-19 之前这里有三条路：手改稿原样发 / 预生成稿确定性拼装后发 /
        # 两者都没有就调 `prompt_opt.optimize_full` 现写一份（之后还要跑一次
        # 「开场站位」分析）。后两条已删：镜头脚本的撰写整体移交 Muse，
        # 没有锁定稿的镜头在 `_run_one` 入口就已失败返回，走不到这里。
        #
        # 不做确定性拼装：写稿的人看到并锁定的就是他要的，悄悄给他补站位/后缀
        # 等于改了他的稿（且会被写回 gen_prompt，编辑器里平白多出几行）。
        # 只剥编辑器残留；下面的引用纠错、3D 画风句与引用绑定照旧。
        final_prompt = strip_editor_chrome(override["prompt"])
        # ---- `@名字` → 官方编号（确定性，三条路径都过）----
        #
        # 手改稿原样下发、不经过优化器，而 `@名字 → @图片N / 音频N` 原本只有
        # 优化器会做——于是手改稿里的 @ 引用全部以字面形式到达模型（见 at_refs
        # 模块头：女声参考音频、成片男声）。优化器产出的稿已是编号，再过一遍不变。
        #
        # 编号对齐真实下发顺序：图片 = 首/尾帧在前、参考图在后；标签与
        # reference_image_urls 一一对应时才转图片（首帧路线不下发参考图，
        # 对不上就不转，宁可不转也不能转错到别人身上）。
        # ---- 编号纠错（2026-10-18）→ `@名字` 转官方编号 ----
        #
        # ## 为什么必须先纠错（用户 2026-10-18 反馈「引用女1却出女二的脸」）
        #
        # `gen_prompt` 里的 `@图片N` 是**写提示词那天**按当时的角色顺序算死的。
        # 之后任何一次「角色增删 / 造型图补上或失效 / 场景改名」都不会回写那串
        # 数字，而出片时 `_auto_inject_refs_detailed` 又按**此刻**的顺序重新编号。
        # 两套编号之间此前**没有任何一致性校验**。
        #
        # 生产实测（14610 镜）：122 镜提示词里的编号指错人（38 镜已成片），
        # 53 镜引用了根本不存在的编号。典型成因是「无图角色被跳过 → 后面整体
        # 前移一位」和「L1.5 在场推导补进新角色 → 后面整体后移」。
        #
        # 修法：提示词自己声明了每个编号指谁（`@图片1 为林婉萍` / `林婉萍（@图片1）`
        # / `@图片1 的林婉萍`）。拿这份**它自己的声明**去对齐此刻的真实顺序，
        # 是确定性改写，不是猜。声明矛盾或名字对不上时**不动**并记日志。
        #
        # ⚠️ 顺序不能反：必须在 `resolve_at_refs` **之前**。反过来的话，名字先被
        # 转成编号，声明句本身也被改写（`@图片1 的林婉萍` → `@图片1 的@图片1`），
        # 纠错器就再也读不出"这个编号原本指谁"。
        _imgs = list(vreq.reference_image_urls or [])
        _img_labels = injected_labels if len(injected_labels) == len(_imgs) else []
        _off = int(bool(vreq.first_frame_url)) + int(bool(getattr(vreq, "last_frame_url", None)))
        if final_prompt and "@" in final_prompt:
            from .at_refs import drop_dangling_refs, remap_image_refs
            # ① 先剔除**本次根本没送出去**的引用（用户 2026-10-18 裁定）。
            #
            # 顺序必须在 remap **之前**：remap 会把这些编号挪到别人身上
            # （`@图片3 为赵妈` → 赵妈没图，编号被改到 3 号的实际持有者），
            # 先 remap 就再也看不出这一处原本想要的是个没送来的人。
            #
            # 不剔的后果是**双向的**：要么模型收到一个不存在的编号（乱套），
            # 要么被 remap 挪到另一个人身上 —— 后者更糟，是对着脸换人。
            #
            # 换成原文本而不是删掉（`林晨（@图片2）` → `林晨`），正文仍通顺。
            final_prompt, _dropped = drop_dangling_refs(
                final_prompt, _img_labels, image_offset=_off, image_count=len(_imgs),
                known_names=_project_entity_names(project_id))
            if _dropped:
                # 改了用户的稿就必须留痕：剔了哪几处、它原本指谁
                log.warning("[shot %s] 提示词引用了本次未提供的图，已按原文本剔除引用"
                            "（角色已删/无图/场景改名）：%s", order, "、".join(_dropped[:8]))
            # ② 再把**还在范围内的**编号按提示词自述的指代关系对齐真实顺序
            final_prompt, _remapped = remap_image_refs(
                final_prompt, _img_labels, image_offset=_off)
            if _remapped:
                # 改了用户的稿就必须留痕：这一镜的编号被纠正过，可事后追溯
                log.warning("[shot %s] 提示词里的 @图片N 与本次实际参考图不符，"
                            "已按提示词自述的指代关系纠正：%s", order, "、".join(_remapped))
        # ---- 画风 + 渲染规格：**确定性拼在最前面**（2026-10-08）----
        #
        # ⚠️ 必须放在这里、而不是放进 ctx 交给优化器：那是上一版的做法，
        # 实测优化器只保留了 5~6/9 个渲染词，用户在实际项目里看到的是**一个都没有**
        # （优化器用自己的画风措辞把那句改写掉了）。放在 if/elif/else 之后，
        # 三条路径（用户手改 / 预生成稿直发 / 重新优化）**全都**吃到，
        # 彻底消灭"画风只在某一条路径上"这类分叉 —— 画风当年命中率 0.1% 就是这么来的。
        #
        # 非 3D 四档 `render_line` 为空、且画风句早已由 ctx 提供 → 本调用
        # 对它们**逐字节无影响**（见 lock_style_line 的幂等与空值说明）。
        final_prompt = lock_style_line(project_id, final_prompt)
        # `gen_prompt` 是镜头卡上显示的那份。纠错（剔除/改号）与画风句写回，
        # 下面的「引用绑定」**不写回**（见下）。
        if final_prompt:
            with get_session() as session:
                _shot3 = session.get(Shot, sid)
                if _shot3 and _shot3.gen_prompt != final_prompt:
                    _shot3.gen_prompt = final_prompt
                    session.commit()
        # ---- 引用绑定：界面上的每个引用块，下发时都要真的生效（2026-10-27）----
        #
        # 两种写法都绑成 `名字@图片N`（官方要求按「素材类型+序号」引用素材）：
        #   ① `@名字`（用户手插的块）→ `resolve_at_refs`
        #   ② 裸名字 —— 编辑器同样把它显示成「名字 图N」的块（`promptHTML`
        #      的 `(@?名字)` 分支、「一键引用」也只登记不改正文），此前后端**不认**，
        #      模型收到光秃秃的人名、不知道哪张图是谁 → `bind_bare_names`
        #
        # 生产「巴郎错牵结良缘」E11·S045 就是 ②：界面写着「夏依达 图1 / 古丽娜 图2
        # / 叶尔赞 图3」，下发稿里一个 `@` 都没有，两个女角色互换了脸。
        #
        # ⚠️ **只改下发稿，不写回 `gen_prompt`**（用户 2026-10-27 裁定）：用户视觉上
        # 引用的是「@角色X」，正文保持他写的样子；绑定结果只在 `vreq.prompt` 与
        # 版本记录里。两者都幂等，重复出片不会叠出 `@图片1@图片1`。
        sent_prompt = final_prompt
        if sent_prompt and "@" in sent_prompt:
            from .at_refs import resolve_at_refs
            sent_prompt, _unk = resolve_at_refs(
                sent_prompt, _img_labels, audio_labels, image_offset=_off)
            if _unk:
                log.warning("[shot %s] 提示词里有认不出的 @引用（原样下发，模型不会把它"
                            "对到任何素材上）：%s", order, "、".join(_unk[:6]))
        if sent_prompt and _img_labels:
            from .at_refs import bind_bare_names
            from .prompt_opt import framework_for_model as _ffm_b
            # 只对**认 `@图片N` 语法**的通道绑（与 `_build_prompt_ctx` 里给优化器下发
            # 编号对照表的判据逐字相同）。其余通道在 ctx 里被明令「严禁出现 @图片N」，
            # 这里替它塞一堆编号进去就是自相矛盾。
            if _ffm_b(model_id) == "seedance2" and _at_ref_model(model_id):
                sent_prompt, _bound = bind_bare_names(
                    sent_prompt, _img_labels, image_offset=_off,
                    blockers=_project_asset_names(project_id))
                if _bound:
                    log.info("[shot %s] 正文里的引用名已绑定参考图编号：%s",
                             order, "、".join(_bound[:8]))
        vreq.prompt = sent_prompt

        # ---- generating：并发池内提交，失败自动重试 ----
        last_err = "生成失败"
        for attempt in range(1 + max(0, s.video_retries)):
            if attempt:  # 重试退避（在池外等待，不占槽）
                await asyncio.sleep(min(60.0, s.video_retry_backoff * (2 ** (attempt - 1))))
            async with _video_pool():  # 池满→在此排队；上一批任一任务结束即放行
                # ⚠️ 拿到槽位后**再查一次**取消。
                # 函数入口那次检查形同虚设：gather 一次性派发全部协程，
                # 它们在第一轮事件循环里就都通过了入口检查，然后堵在这个
                # 信号量上排队几分钟到几十分钟。用户的取消几乎必然发生在
                # 那之后 —— 不在这里补一次，排队中的镜头照样会全部提交、全部计费。
                if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
                    return
                _set_shot_status(sid, "generating")
                try:
                    res = await provider.submit(vreq)
                except Exception as e:  # noqa: BLE001
                    last_err = repr(e)
                    continue  # 释放槽 → 退避 → 重新排队重试
            if res.status == "done" and res.video_url:
                meta = dict(res.raw or {})
                # 真正发给模型的那一份（含 `名字@图片N` 绑定）。版本的 `prompt` 列存的是
                # 用户可见的正文 —— 它是「用这版提示词」的还原来源，存绑定稿会把
                # `@图片N` 写回编辑器（用户裁定不写回）。排查"到底发了什么"看这里。
                if vreq.prompt and vreq.prompt != final_prompt:
                    meta["sent_prompt"] = vreq.prompt
                if injected_refs:
                    meta["injected_refs"] = injected_refs
                    # 「这张图是造型挑出来的，还是造型一套都没中退回的通用图」——
                    # 用户报「设了造型却没生效」时，这是唯一能证伪的一行。
                    # 与注入顺序同序，前端据此在参考图面板上标「通用定妆图（兜底）」。
                    meta["injected_refs_src"] = injected_srcs
                if refs_dropped:
                    # 用户手动换过、但那个实体已经不在本镜了 —— 图没带上是**对的**，
                    # 但必须留痕，否则"我换过的图怎么没生效"永远查不出原因。
                    meta["refs_dropped"] = refs_dropped
                if voice_note:
                    # 音色是"听得见但看不见"的东西：不落 meta 的话，用户问
                    # "我传的音色到底用没用上"就只能靠耳朵猜。用上了记 url+是谁，
                    # 没用上记为什么没用上，两种情况都不许静默。
                    meta["voice_ref"] = voice_note
                if fallback_reason:
                    # 镜头选过已下线的帧模式或带着帧图 → 记录原因，避免"以为在跑X其实是全参考"
                    meta["mode_fallback"] = fallback_reason
                    meta["first_frame_fallback"] = fallback_reason  # 兼容既有版本记录字段
                if attempt:
                    meta["retries"] = attempt
                # TB-05：显式 seed 记进版本 meta，"生成变体"才可复现/可对比。
                # Provider 自选的 seed 通常已在 res.raw 里，不覆盖它。
                if batch_seed is not None:
                    meta.setdefault("seed", batch_seed)
                    meta["seed_source"] = "explicit"
                # P1-1：抽首帧供轨道/列表用 <img> 渲染。失败只是没缩略图，不影响出片，
                # 所以不放进 try 之外的失败分支，也不因它重试。
                from .media import make_thumb, probe_duration_local
                thumb_url = await make_thumb(res.video_url)
                # 出片时长回检：此前**没有任何环节**把成片的真实时长与计划时长
                # （Shot.duration_sec，拆镜按台词/旁白算出来的）比对过，于是
                # "通道少给了一截"这件事可以一路静默到成片——2026-09-04 的真人剧
                # 验证片就是这么烂的：17 镜计划 16~29s、实际全是 15.07s，32 条字幕
                # 落在视频结束之后，零报错。根因是 seedance provider 写死 min(15)
                # （已修，见 7c60e45），但**根因修了不等于这一类问题不会再来**：
                # 任何通道、任何原因少给时长，这里都该看得见。
                #
                # 只记录、不自动纠正：短了的正解是"重新生成更长的一版"，而不是
                # 把计划时长改小去迁就成片——后者会把台词/旁白挤出画面，且看起来
                # 一切正常。真相是"画面不够长"，就如实记成"画面不够长"。
                actual_sec = await probe_duration_local(res.video_url)
                sync_to: float | None = None
                if actual_sec > 0:
                    meta["actual_sec"] = round(actual_sec, 3)
                    planned = float(ai_duration or 0)
                    if planned > 0 and (planned - actual_sec) > max(0.5, planned * 0.05):
                        meta["duration_short"] = {"planned": round(planned, 3),
                                                  "actual": round(actual_sec, 3)}
                        log.warning(
                            "第 %s 镜出片时长不足：计划 %.2fs，实际 %.2fs（通道 %s）",
                            order, planned, actual_sec, model_id)
                    if getattr(provider, "audio_mode", None) == AudioMode.inline:
                        # 音画一体的通道（seedance 等）：**成片文件就是完整成品**
                        # ——画面和声音都在里面，没有第二条轨去定义"这一镜该多长"。
                        # 所以时间轴长度应当等于文件长度，不多不少。
                        #
                        # 不这么做的代价是双向的，而且**两边都是静默的**
                        # （2026-09-06 真人剧 29/29 镜全部命中）：
                        #   · 计划 > 实际 → 导出取 `clip_dur_sec ?? duration_sec`
                        #     （adapters/shotToClip.ts、render/normalize.ts 同口径），
                        #     多出来的部分是定格帧 + 静音，最多 0.44s
                        #   · 计划 < 实际 → 尾巴被裁掉，裁的是台词的最后半个字，
                        #     最多 0.6s
                        # 差值的来源是结构性的：下发给通道的是 int(round(计划))，
                        # 回来的片子又比下发值多出零点几秒的编码尾巴，
                        # 所以「计划」和「实际」本来就不可能相等。
                        #
                        # ⚠️ 这不会把"通道少给了一大截"糊过去：真正的缺斤短两由上面
                        # 那个 duration_short 分支拦下并 warning，时间轴如实缩到
                        # 实际长度只是不再假装有那么多画面——该重生成还是要重生成。
                        #
                        # ⚠️ 只对 inline 通道：解说剧（H3 + 独立 TTS 轨）的镜头长度
                        # 由旁白定（_sync_shot_duration），画面多出来的尾巴本就该裁，
                        # 在这里跟着画面走会在旁白结束后留一段静场。
                        if abs(actual_sec - (ai_duration or 0)) > 0.02:
                            sync_to = round(actual_sec, 3)
                vno = _save_shot_version(sid, res.video_url, model_id, final_prompt, meta,
                                         thumb_url=thumb_url)
                with get_session() as session:
                    shot = session.get(Shot, sid)
                    if shot:
                        shot.video_url = res.video_url
                        # 3.1：素材换了，旧的取片窗口（相对旧 video_url 的坐标）
                        # 就指向了另一段内容——不清会静默导出黑帧，见 db.py。
                        reset_clip_window(shot)
                        shot.thumb_url = thumb_url
                        # 生成即默认采用（用户决策：删「采用」按钮；切换版本=采用该版本）
                        shot.status = "adopted"
                        shot.adopted_version = vno
                        if sync_to:
                            # clip_dur_sec 为 None = 没有手工取片窗口，导出直接用
                            # duration_sec；此时同步它即可。用户自己设过窗口就别动，
                            # 那是明确的剪辑意图，不该被一次重生成覆盖掉。
                            if shot.clip_dur_sec is None and shot.clip_in_sec is None:
                                shot.duration_sec = sync_to
                        # P1-2：本次生成已按最新注入集合出片 → 清「参考图已变」标记
                        shot.refs_stale = 0
                        # P2-15：`stale` 以前**从没人清过**——重出片能治好的过期
                        # （regen：时长变了；reprompt：见下）出完片旗标还挂着，
                        # 用户永远看着一个洗不掉的「已过期」。
                        # rebreak 与老数据(NULL)不清：切分本身是错的，出多少次片都没用。
                        #
                        # ⚠️ reprompt 这一档沿用旧口径（出片成功即清），**未改**：
                        # 2026-11-19 起本函数不再重写提示词，锁定稿的重写由 Muse 做，
                        # 写入并锁定那一刻就会清掉过期标记（tools_write._write_prompt）；
                        # 这里清的是「带着旧稿仍然出了片」的那种，与此前手改稿的行为一致。
                        if stale_mod.clears_on_regen(shot.stale_reason):
                            stale_mod.clear_stale(shot)
                        session.commit()
                async with lock:
                    results.append({"order": order, "video_url": res.video_url,
                                    "version_no": vno, "retries": attempt})
                    done_count += 1
                    await _report()
                return
            last_err = res.error or "生成失败"
        # 重试次数用尽。
        #
        # ⚠️ 审核类失败必须**先翻译再落库**（2026-10-13）：原始文案里的
        # `content[7]` 对用户毫无意义，而"第 6 张参考图是谁"这个答案就在手里的
        # `injected_labels` 里。不翻译的话用户既不知换哪张图、也不知改哪句词，
        # 只能反复重试 —— 实测第 7 镜因此连续失败 11 次。
        _msg = str(last_err)
        if classify_failure(_msg) == "moderation":
            # 帧图已并进参考图（见上），没有单独的首帧 / 尾帧位。
            _msg = _explain_refusal(_msg, None, None, injected_labels)
        _set_shot_status(sid, "failed", _msg)
        async with lock:
            results.append({"order": order, "error": _msg[:300]})
            done_count += 1
            await _report()

    # 并发派发全部镜头（全局池控总并发；本 job 不设自身上限）
    await asyncio.gather(*(
        _run_one(sid, order, ref, ov, dur) for sid, order, ref, ov, dur in plan
    ))

    failed = [r for r in results if "error" in r]
    # 用户取消不是失败。⚠️ 这里**不能**照 run_asset_batch 那样按条目文案判断：
    # 本函数的取消检查点是裸 `return`（不往 results 记条目），被取消的镜头
    # 根本不出现在 results 里 —— 于是 failed=0、判定 done，用户取消了 170 镜
    # 却在任务中心看到一个绿勾。直接查状态位才是准的。
    if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
        skipped = len(plan) - len(results)
        # ⚠️ 必须把那批「卡在瞬时态」的镜头放掉（2026-10-24）。
        #
        # 被取消的镜头是从 `_run_one` 的检查点**裸 return** 的，而那时它多半
        # 已经写过 `status="prompting"`（进并发池之前就写了）。没人再碰这一行，
        # 于是它一直停在 prompting —— `maintenance.sweep_orphaned_states` 虽然
        # 会回收，但那是**每 300 秒**一轮，且只在项目没有活跃 job 时才动手。
        #
        # 这个残留一直存在，但此前**看不出来**（前端根本不读 status）。2026-10-24
        # 起界面按它显示「生成中…」，于是取消之后这 170 镜会继续显示"生成中"
        # 好几分钟，用户以为取消没生效。既然视图开始依赖这一列，取消就必须
        # 自己把它收拾干净，而不是指望巡检。
        #
        # 复位成 `pending` 而不是 `failed`：用户主动取消不是失败，不该在任务
        # 中心挂一片红。`pending` 正是"还没生成过"的既有取值。
        # 只动**还在瞬时态**的行：已经在跑的（提交出去了）会由它自己的协程
        # 写完 adopted/failed，那才是事实。
        _release_transient([sid for sid, _o, _r, _ov, _d in plan])
        _update(jid, status="cancelled",
                error=f"已取消（{skipped} 镜未生成）" if skipped else "已取消")
        return
    _update(
        jid,
        status="failed" if len(failed) == len(plan) else "done",
        # error 是给用户看的，必须短；全量明细在 result 里（可排查）。
        error=_brief_errors(failed) if failed else None,
    )


def _scene_desc_text(sid: str) -> tuple[str, str]:
    """本镜场景的文字设定（`Asset(kind="location").prompt`）。

    返回 `(场景名, 描述)`；查不到描述时描述为空串。描述由 `scene_desc.py` 产出，
    出图/出片链路已在入口处 `ensure_scene_descriptions` 幂等补齐。

    场景名返回**归一名**：资产按归一名存，描述也按归一名产出，这里再报原名
    会让提示词里的场景名与参考图标注对不上（同一个房间两种叫法）。
    """
    from .scenes import canonical_of, location_asset
    with get_session() as s:
        cur = s.get(Shot, sid)
        loc = (cur.location or "").strip() if cur else ""
        if not loc:
            return "", ""
        name = canonical_of(s, cur.project_id, loc) or loc
        a = location_asset(s, cur.project_id, loc)
        return name, strip_auto(desc_of(a)) if desc_of(a) else ""


#: 前情剧本喂给优化器的字数上限（取尾部——离本镜最近的才决定人此刻在哪）。
_RUN_RECAP_CAP = 700
#: 本场首镜提示词的引用上限。只要它里面的空间与陈设描写，不需要整篇。
_RUN_ANCHOR_CAP = 500

def _project_asset_names(project_id: str) -> set[str]:
    """项目里全部资产名 + 造型行角色名（含本镜没送图的、含已删的）。

    给 `at_refs.bind_bare_names(blockers=...)` 做最长优先拦截：与前端
    `promptHTML` 的 `allNames`（`S.detail.assets` + `S.stages`）同一份口径，
    两边对「陈秀兰家里的陈秀兰算不算引用」必须给出同一个答案。
    """
    from .db import Asset, AssetStage
    with get_session() as session:
        names = {n for (n,) in session.query(Asset.name)
                 .filter(Asset.project_id == project_id) if n}
        names |= {n for (n,) in session.query(AssetStage.character_name)
                  .filter(AssetStage.project_id == project_id) if n}
    return {n.strip() for n in names if n.strip()}


def _project_entity_names(project_id: str) -> set[str]:
    """项目里**有名有姓**的实体名：剔除悬空引用时用来判"被点名的是不是一个真实实体"。

    来源要宽：资产（含已删的 —— 删掉的角色恰恰是要剔的那一类）、造型行的角色名、
    角色/场景别名（改名前的旧名）、以及镜头里出现过的角色与场景原名
    （"还没出图"的角色只存在于这里）。

    只用于 `at_refs.drop_dangling_refs(known_names=...)`：认不出的写法
    （「站位图参考@图片6」里的「站位图」）不该被当成"没送来的人"而删掉引用。
    """
    from .db import Asset, AssetStage, CharacterAlias, SceneAlias
    names: set[str] = set()
    with get_session() as session:
        for (n,) in session.query(Asset.name).filter(Asset.project_id == project_id):
            if n:
                names.add(n)
        for (n,) in (session.query(AssetStage.character_name)
                     .filter(AssetStage.project_id == project_id)):
            if n:
                names.add(n)
        for model in (CharacterAlias, SceneAlias):
            for raw, canon in (session.query(model.raw_name, model.canonical)
                               .filter(model.project_id == project_id)):
                names.update(x for x in (raw, canon) if x)
        for chars, present, loc in (session.query(Shot.characters,
                                                  Shot.present_characters, Shot.location)
                                    .filter(Shot.project_id == project_id)):
            for raw in (chars, present):
                try:
                    lst = json.loads(raw) if raw else []
                except ValueError:
                    lst = []
                names.update(x for x in lst if isinstance(x, str) and x)
            if loc:
                names.add(loc)
    return {n.strip() for n in names if n and n.strip()}


def _ref_label_for(project_id: str, url: str) -> str:
    """给用户手动 @ 的那张图起一个**可读标签**，供提示词优化器做 `@名字 → @图片N` 转写。

    为什么非要有它：官方文档 §三写死了「提示词中必须使用**素材类型+序号**格式
    引用素材，**不支持使用 Asset ID**」，而优化器是拿 `labels` 清单
    （`图片1=角色「林七雨」`）去转写的。用户 @ 的图若没有标签，优化器就无从
    知道这张是谁，转写不出对应编号——用户 @ 了等于没 @，且全程无报错。

    反查顺序与前端 refCandidates() 一致：
      ① 造型阶段 —— 角色图往往只存在于这一层（见 _auto_inject_refs_detailed）
      ② 资产表 —— 通用定妆图 / 场景图 / 道具图
    """
    from .db import Asset, AssetStage
    with get_session() as session:
        st = (session.query(AssetStage)
              .filter(AssetStage.project_id == project_id,
                      AssetStage.image_url == url,
                      AssetStage.deleted_at.is_(None)).first())
        if st is not None:
            nm = (st.character_name or "").strip()
            tag = (st.stage_name or "").strip()
            if nm:
                return f"角色「{nm}」" + (f"（造型：{tag}）" if tag else "")
        a = (session.query(Asset)
             .filter(Asset.project_id == project_id,
                     Asset.image_url == url).first())
        if a is not None:
            kind = {"character": "角色", "location": "场景", "prop": "道具"}.get(
                a.kind, "素材")
            return f"{kind}「{a.name}」"
        # ③ 站位图 —— 正常由绑定时写进镜头的 `ref_labels` 给名字；那个键被别的写入
        #    路径丢掉时在这里补回来。
        from . import blocking_images
        label = blocking_images.label_for_url(session, project_id, url)
        if label:
            return label
    # 查不到也要给个不撒谎的占位：它至少告诉优化器"这里有一张图"，
    # 只是不知道是谁——总好过让编号整体错位。
    return "补充参考图"


def _merge_ref_audios(user: list[str], auto: list[str], cap: int) -> list[str]:
    """参考音频的最终下发顺序：**用户点名的在前**，自动推断的接在后面，去重并按上限截断。

    这个顺序就是提示词里「音频N」的编号来源，必须与前端 `voiceIdxOf`
    （= ref_audios 里的位置）一致。理由见 run_shot_videos 里调用处的注释。
    """
    out: list[str] = []
    for u in list(user or []) + list(auto or []):
        if not u or u in out:
            continue
        if len(out) >= cap:
            break
        out.append(u)
    return out


def _audio_label_for(project_id: str, url: str,
                     names: dict[str, str] | None = None) -> str:
    """给一段参考音频（音色）起一个**可读标签**，供优化器写「音色参考「音频N」」。

    与 `_ref_label_for` 同一条理由，只是素材类型换成音频：官方文档 §三的
    标准句式是

        「角色」说："「台词」，音色参考「音频n」"

    优化器要靠这份清单（`音频1=角色「男一号」`）才知道第 N 段音频是谁的音色，
    否则写不出那个句式 —— 音色会被送进去，但提示词里一个字都不提它，
    模型只会把它当背景音，用户看到的就是"传了音色却不像"。

    ⚠️ 标签用**角色名**而不是文件名：用户上传的文件名（`rec_001.m4a`、
    `男一号.wav`、`final_v3.mp3`）对模型毫无意义，而且同一角色换一版录音
    标签就会变，转写出来的提示词跟着漂。角色是稳定且唯一的身份。
    """
    from .db import Asset
    with get_session() as session:
        a = (session.query(Asset)
             .filter(Asset.project_id == project_id,
                     Asset.kind == "character",
                     Asset.voice_url == url,
                     Asset.deleted_at.is_(None)).first())
        if a is not None and (a.name or "").strip():
            return f"角色「{a.name}」的音色"
    # 本镜「临时参考音频」：用户上传时写的那句说明（见 run_shot_videos 的
    # ref_audio_labels）。排在角色反查之后——同一段音频若恰好也是某角色的音色，
    # 角色名更稳定。
    if names and (names.get(url) or "").strip():
        return f"「{names[url].strip()}」"
    # 查不到：可能是资产被换过音色（旧音频仍在 override 里），或镜头高级设置
    # 里手填的外链。同样给一个不撒谎的占位，别让编号错位。
    return "补充参考音色"


def _auto_inject_refs(sid: str, max_refs: int) -> tuple[list[str], list[str]]:
    """定妆图自动注入（契约 C6）。完整说明见 _auto_inject_refs_detailed。

    薄壳：只取 (urls, labels)，给不需要造型描述的调用方（首帧生成等）用。
    """
    urls, labels, _ = _auto_inject_refs_detailed(sid, max_refs)
    return urls, labels


#: `refs_hide` 网址 → 实体键。键是 `(project_id, 网址)`，
#: 值是 `{("角色","林晨"), ...}`。一次查库，项目内所有镜头共用。
HideIndex = dict[tuple[str, str], set[tuple[str, str]]]


def build_hide_index(session, project_id: str,
                     urls: set[str] | None = None) -> HideIndex:
    """项目级：把 `refs_hide` 里的网址反查成实体键。**一次查库**。

    ## 为什么必须项目级（2026-10-28 性能实测）

    单镜调 `_refs_hide_of` 要为它那两三个网址各打三次查询
    （AssetStage / Asset / SceneView）。逐镜循环里（`/detail` 下发注入清单、
    `audit_*` 体检）就是 N×3 次往返 —— 而这份映射**只随资产/造型变动**，
    与镜头无关，同项目所有镜头共用同一张表。

    实测（343 镜项目、26 镜有 hide）：
      · 逐镜调 `_refs_hide_of`                      1.246 s
      · 建本表 5 ms + 逐镜套用 28 ms                 0.033 s   （便宜 37 倍）

    `urls=None` 表示取该项目**所有**镜头 `refs_hide` 里出现过的网址
    （`/detail` 就该这么用：扫一遍全项目，之后逐镜零查询）。
    """
    from .db import Asset, AssetStage, SceneView

    if urls is None:
        want: set[str] = set()
        for (po,) in (session.query(Shot.profile_override)
                      .filter(Shot.project_id == project_id).all()):
            try:
                po = json.loads(po or "{}")
            except (ValueError, TypeError):
                continue
            for u in ((po or {}).get("refs_hide") or []):
                if isinstance(u, str) and u.strip():
                    want.add(u)
    else:
        want = {u for u in urls if isinstance(u, str) and u.strip()}

    idx: HideIndex = {}
    if not want:
        return idx

    def _put(url: str | None, key: tuple[str, str]) -> None:
        if url:
            idx.setdefault((project_id, url), set()).add(key)

    kind_cn = {"character": "角色", "location": "场景", "prop": "道具"}
    for st in (session.query(AssetStage)
               .filter(AssetStage.project_id == project_id,
                       AssetStage.image_url.in_(want)).all()):
        if st.character_name:
            _put(st.image_url, ("角色", st.character_name))
    for a in (session.query(Asset)
              .filter(Asset.project_id == project_id,
                      Asset.image_url.in_(want)).all()):
        if a.kind in kind_cn:
            _put(a.image_url, (kind_cn[a.kind], a.name))
    # 场景多视角图：网址本身不是资产主图，要经由 asset_id 回到场景名。
    views = (session.query(SceneView)
             .filter(SceneView.project_id == project_id,
                     SceneView.image_url.in_(want)).all())
    if views:
        names = {a.id: a.name for a in
                 session.query(Asset).filter(
                     Asset.id.in_({v.asset_id for v in views})).all()}
        for v in views:
            if names.get(v.asset_id):
                _put(v.image_url, ("场景", names[v.asset_id]))
    return idx


def _refs_hide_of(session, shot, *, index: HideIndex | None = None
                  ) -> tuple[set[str], set[tuple[str, str]]]:
    """本镜「不带」的图 → (原始网址集合, 实体键集合)。

    实体键形如 `("角色", "林晨")` / `("场景", "楚家公馆-客厅")` / `("道具", "黑卡")`。

    ## 为什么不能只按网址剔（2026-10-15 用户甲反馈"剔除了还是带上了"）

    前端「不带」记下的是**界面上显示的那张图**的网址，而后端实际注入的常常是
    **同一个实体的另一张图**：
      · 角色：界面显示 `Asset.image_url`（通用图），注入的是按本镜排序选出的
        **造型阶段图**；
      · 场景：界面显示场景主图，注入的是 8 张**多视角图**里贴本镜景别的那一张。
    dev 全库实测，界面图与注入图对不上的：角色 36%（950/2584）、场景 47%
    （587/1236）——这些镜头点「不带」**完全无效**，且无任何报错。

    所以把被剔的网址反查回它属于哪个角色/场景/道具，按**实体**剔。
    一镜里每个实体本来就只注入一张图，"不带这张"与"这一镜不带这个人/这个景"
    是同一件事。原始网址集合仍保留：反查不到实体的外链照旧按网址精确剔。

    `index`：`build_hide_index` 的结果。**逐镜循环里必须传**，否则每镜三次查询。
    """
    from .db import Asset, AssetStage, SceneView
    try:
        raw = [u for u in (json.loads(shot.profile_override or "{}").get("refs_hide") or [])
               if isinstance(u, str) and u.strip()]
    except (ValueError, TypeError, AttributeError):
        raw = []
    urls = set(raw)
    keys: set[tuple[str, str]] = set()
    if not raw:
        return urls, keys
    if index is not None:
        # 快速路径：项目级映射表已在内存里，零查询。
        for u in raw:
            keys |= index.get((shot.project_id, u), set())
        return urls, keys
    pid = shot.project_id
    kind_cn = {"character": "角色", "location": "场景", "prop": "道具"}
    for st in (session.query(AssetStage)
               .filter(AssetStage.project_id == pid, AssetStage.image_url.in_(raw)).all()):
        if st.character_name:
            keys.add(("角色", st.character_name))
    for a in (session.query(Asset)
              .filter(Asset.project_id == pid, Asset.image_url.in_(raw)).all()):
        if a.kind in kind_cn:
            keys.add((kind_cn[a.kind], a.name))
    sv_assets = {v.asset_id for v in (session.query(SceneView)
                 .filter(SceneView.project_id == pid, SceneView.image_url.in_(raw)).all())}
    if sv_assets:
        for a in session.query(Asset).filter(Asset.id.in_(sv_assets)).all():
            keys.add(("场景", a.name))
    return urls, keys


def _owned_user_refs(override: dict, shot_id: str) -> tuple[list[str], int]:
    """本镜用户手动指定（@ / 换图）的参考图，且**剔除已经不属于本镜实体的那些**。

    返回 `(urls, dropped_count)`。

    ## ⚠️ 参数是 shot_id，不是 Shot 对象（2026-10-23 生产事故）

    初版签名是 `(override, shot)`，而调用点在 `_run_one` 里 —— 那里**没有**
    名为 `shot` 的局部变量（`shot` 只在本文件别的作用域出现过），于是每一次
    视频生成都抛 `UnboundLocalError: local variable 'shot' referenced before
    assignment`，生产 10-22 21:56 上线后**全部出片失败**。

    改成收 id、在自己这里开 session 取，调用方就不可能再传错 —— 传 id 和传
    对象长得不像，抄漏一眼就能看出来；两者都是「一个 Shot 相关的东西」时才
    最容易错。另外这里本来就要开 session 查归一名，顺手把 shot 一起取了。
    """
    from .db import Shot, effective_characters
    from .scenes import canonical_locations
    raw = [u for u in (override.get("refs") or [])
           if isinstance(u, str) and u.strip()]
    owners = {o["url"]: o for o in (override.get("ref_owners") or [])
              if isinstance(o, dict) and o.get("url")}
    if not owners:
        return raw, 0

    with get_session() as _s:
        shot = _s.get(Shot, shot_id)
        if shot is None:
            return raw, 0                # 镜头已不在：保持原样，交给上层处理
        chars = set(effective_characters(shot))
        try:
            props = {x.strip() for x in json.loads(shot.props or "[]")
                     if isinstance(x, str) and x.strip()}
        except (ValueError, TypeError):
            props = set()
        # ⚠️ 场景必须比**归一名**：`ref_owners` 里存的是用户换图时那个实体的名字，
        # 而场景资产一律按归一名存放、注入也按归一名比（`canonical_locations`）。
        # 拿 `shot.location` 原名来比，同一个房间换个写法就对不上，
        # 用户刚换的图会被当成"已失效"直接剔掉 —— 比不校验更糟。
        locs = set(canonical_locations(_s, shot.project_id, shot))
        # 归一名之外，原名也放行：用户可能就是把图挂在"夜 内 客厅"这种写法上。
        if (shot.location or "").strip():
            locs.add(shot.location.strip())
        pid = shot.project_id

    keep: list[str] = []
    dropped = 0
    for u in raw:
        o = owners.get(u)
        if o is None:
            keep.append(u)          # 存量裸条目：没有归属，放行
            continue
        kind, name = o.get("kind"), (o.get("name") or "").strip()
        ok = True
        if kind == "character":
            ok = name in chars
        elif kind == "prop":
            ok = name in props
        elif kind == "location":
            ok = name in locs
        if ok:
            keep.append(u)
        else:
            dropped += 1
    if dropped:
        # 不静默：用户若觉得"我换过的图怎么没带"，这行日志是唯一线索。
        # ⚠️ 用提前取出的 shot_id / pid：这里已经出了 session，shot 是脱管的
        # 对象，再读它的属性会抛 DetachedInstanceError（那又是一个"只在运行
        # 到这一行才炸"的错，而这行只有当真的丢了图才会走到）。
        log.warning("[refs] %s 有 %d 张手动指定的图属于已不在本镜的实体，"
                    "已跳过（项目 %s）", shot_id, dropped, pid)
    return keep, dropped


def _auto_inject_refs_detailed(
        sid: str, max_refs: int) -> tuple[list[str], list[str], list[str]]:
    """定妆图自动注入（契约 C6）。实现与来源标记见 `_auto_inject_refs_with_source`。

    薄壳：丢掉第四项（每张图的来源）。十个调用点只用前两项/前三项，
    多返回一位会逼着全部改签名 —— 需要来源的调用方（出片落 meta）直接用
    `_auto_inject_refs_with_source`。
    """
    urls, labels, notes, _src = _auto_inject_refs_with_source(sid, max_refs)
    return urls, labels, notes


#: 参考图的来源口径（写进 `shot_versions.meta.injected_refs_detail`）。
#: 这是「用户说造型没生效」这件事唯一能被证伪的入口 —— 没有它，界面上
#: 一个角色一张脸，分不清是「这套造型赢了」还是「一套都没挑中、退了通用图」。
#: 生产实测（2026-10-22）：小福星2 的 174 镜里 135 镜走的是 `asset_fallback`，
#: 用户看到的却和「造型生效」一模一样。
REF_SRC_STAGE = "stage"                 # 命中某套造型（含场景绑定/指针行）
REF_SRC_FALLBACK = "asset_fallback"     # 造型一套没挑中 → 回退角色通用定妆图
REF_SRC_SCENE = "scene"                 # 场景参考图（多视角里挑的一张）
REF_SRC_PROP = "prop"                   # 道具参考图
REF_SRC_MANUAL = "manual"               # 用户在镜头里手动 @ / 换图指定的一张


def _auto_inject_refs_with_source(
        sid: str, max_refs: int, *,
        _pre: dict | None = None) -> tuple[list[str], list[str], list[str], list[str]]:
    """定妆图自动注入（契约 C6）：按镜头所属集取出场角色的阶段定妆图。

    `_pre`：**批量场景的项目级预取**（2026-10-26 加）。单镜调用传 None 即可，
    行为与改动前逐字一致。

    背景：本函数每个镜头要重建一次"项目级常量"——
      · `asset_gate.deleted_names(project_id)`：查全部墓碑资产，生产该项目 355 条
      · `scenes.canonical_map(project_id)`：查全部场景别名，303 条
    单镜调用完全正确，但在 `audit_ref_integrity` 这种**逐镜循环**里，
    589 镜就要把这些各查 589 次。生产实测（项目 06b5aee23dc2）：
      · 整轮 6917 条 SQL、3.95 秒
      · `deleted_names` 单次 1.86ms × 546 次 ≈ 1018ms = **总耗时的 26%**
      · 而一次性预取这两样只要 **7ms**

    预取键（缺任何一个就回落到各自查库，所以传一半也不会错）：
      · `"gone"`  → `set[str]`，`asset_gate.deleted_names` 的结果
      · `"canon"` → `dict[str, str]`，`scenes.canonical_map` 的结果

    ⚠️ **只在"同一项目、同一时刻、只读遍历多镜"的场合用**。写路径
    （出片、重新生成）必须传 None —— 那里可能刚改过资产，预取值会过期。

    返回 (urls, labels, notes, sources)：前三项同 `_auto_inject_refs_detailed`，
    sources 与 urls 一一对应，取值见 `REF_SRC_*`。

    labels 与 urls 一一对应（如 "角色「林晚」"/"场景「茶楼」"），
    供 Seedance @图片N 引用映射（图片顺序 = images 数组顺序 = @编号）。
    notes 是**被选中那张图里人物到底穿什么**（AssetStage.description），
    与 urls 同序：参考图只钳制长相，服装是否照抄取决于提示词怎么写；提示词里
    没有这份描述时优化器会凭空发明服装（实测：女主的浅米色风衣被写成
    "sleek dark dress"，女配反而穿上了女主的衣服）。有了 notes 才能在优化时
    要求"与参考图逐件对齐"。无描述可用的图对应空串（保持与 urls 同序）。
    仅在镜头无显式 ref_urls override 且模型支持参考图时调用。
    每角色 1 张，超模型上限按出场顺序截断。
    P1-2：角色集合走 effective_characters()（= (拆解真值 ∪ 人工add) − 人工remove），
    与资产轨渲染同一契约，保证「轨道显示的覆盖 = 实际注入」。
    P1-3：角色图之后补注场景参考图（effective_locations → Asset(kind=location)），
    角色优先占位（一致性权重更高），场景在余量内补位。
    2026-09-09：场景侧改为从该场景的**多视角参考图集**（`scene_view`，8 张）里
    挑一张——镜头文本认出景别就用那一档，否则用主视角全景，取不到再兜底
    `Asset.image_url`（老项目只有那一张）。**仍然只占一个参考位**。

    注入规则（修「资产页有图却注入不到」+「确认无意义」）：
    1. 不再过滤 `status=="confirmed"`——用户把图生成/上传到某阶段即视为选定该图，
       不该再多一道确认。status 仅留作资产页的人工标记，不影响注入。
    2. 阶段无图（或本镜不在阶段的 shot 精修区间内）时，**回退角色通用定妆图**
       `Asset(kind="character").image_url`。此前只认 AssetStage，导致资产页
       明明每个角色都有图、注入时却一张都取不到（首帧退化成纯文生图）。
       优先级：命中本镜的镜头级变体阶段 > 命中集区间的基础阶段图 > 角色通用图。
    3. 阶段挑选必须**先按特异性排序，再取第一条**（修一个真实 bug）：
       原实现是 `.order_by(ep_from).first()`，一旦某角色在同一集里既有基础阶段
       又有镜头级服装变体（如「丝绸睡裙」只覆盖 #12-#18），`.first()` 可能先拿到
       变体那条；随后发现本镜不在变体的 shot 区间内就把 st 置成 None，直接跌到
       角色通用图，**基础阶段图被整条跳过**。结果：明明有该集的基础定妆图，
       注入的却是通用图（丢造型区分），或者干脆没有图。
       现在改为：候选里优先选 shot 区间命中本镜的（越窄越优先），
       其次选没有 shot 区间限制的基础阶段。
    4. **场景绑定服装（"同一场景下同一人物服装相同"）自成一档**，且**不看集区间**：
       第 1 集在卧室穿的白色睡衣（`scene_bound=1` + `location=归一卧室名`），
       第 10 集镜头又回到同一个归一场景、剧本没另写衣着时，注入的是**同一张图**。
       跨多少集都成立（用户确认："沿用，除非剧本另写"）——剧本另写时那是明写镜号
       的变体，档位更高，自然压过本档。
       事件型服装（`scene_bound=0`，如婚纱@教堂）不进本档，只在自己的镜号区间/
       集区间内生效，人物再进教堂不会因此又穿上婚纱。
    5. **指针行解析到源阶段的图**（`source_stage_id`，见 db.AssetStage）：同一件衣服
       在相隔很远的两段镜头各出现一次时，后一段是指针行、自身无图，注入时取源那张，
       保证同一件衣服全剧只有一个样子、也只花一次生图钱。
    """
    from . import asset_gate
    from .costumes import resolve_stage_image
    from .db import Asset, AssetStage, effective_characters
    from .scene_view import pick_for_shot as sv_pick_for_shot
    from .scenes import canonical_locations, canonical_of
    if max_refs < 1:
        return [], [], [], []
    with get_session() as session:
        shot = session.get(Shot, sid)
        if not shot:
            return [], [], [], []
        chars = effective_characters(shot)
        # 归一名：场景资产按归一名存，拿原名「夜 内 楚家公馆-客厅」去查是查不到的
        locs = canonical_locations(session, shot.project_id, shot)
        # 用户删掉的资产**在这里断链**（需求 4「删掉的不该再被调用」）。
        # 注意只从**参考图集合**里剔除，镜头本身的 characters / location 一个字
        # 不改（用户决策「只断资产链，不动剧本」）——这一镜照样有这个角色、
        # 照样发生在这个场景，只是不再给模型那张参考图。
        # 批量场景可预取（见 `_pre` 的说明）；没给就照旧查一次。
        _gone = (_pre or {}).get("gone")
        if _gone is None:
            _gone = asset_gate.deleted_names(session, shot.project_id)
        if _gone:
            chars = [c for c in chars if c not in _gone]
            locs = [x for x in locs if x not in _gone]
        if not chars and not locs:
            return [], [], [], []
        # 用户「不带」的：按实体剔，且在**名额计数之前**跳过 —— 让出的名额由后面的
        # 顺延补上，与前端 resolveRefs 的"先剔再补"同序。放在这一层而不是调用方：
        # 出片、按资产重算提示词、首帧生成三条路共用本函数，此前只有出片那条剔了
        # （还是按网址剔、多半剔不中），另两条完全不认「不带」。
        _hide_urls, _hide_keys = _refs_hide_of(session, shot)
        # 本镜所在的**归一场景**：服装继承的判据。用原名比对是错的
        # （同一个房间每集写法都不同，实测跨集复用率 0，见 db.SceneAlias）。
        # 批量场景可预取整张映射表（见 `_pre`）；没给就照旧单查一次。
        _cmap = (_pre or {}).get("canon")
        if _cmap is not None:
            _raw = (shot.location or "").strip()
            shot_canon = _cmap.get(_raw) or canonical_of(
                session, shot.project_id, shot.location)
        else:
            shot_canon = canonical_of(session, shot.project_id, shot.location)
        urls: list[str] = []
        labels: list[str] = []
        notes: list[str] = []
        #: 与 urls 同序：每张图是「命中造型 / 回退通用图 / 场景 / 道具」。
        #: 只用于让回退可被看见（`REF_SRC_*`），不参与任何挑选判断——
        #: 挑选的唯一真源仍是 `stage_pick.pick`。
        sources: list[str] = []
        #: 有多少个在场角色/场景**因为名额不够**而没被注入。
        #: 2026-10-07 加：此前这里是**纯静默截断**（就一个 break），
        #: 于是"参考图超上限被丢掉"在生产上完全不可见 —— 日志里搜不到任何痕迹，
        #: 2026-10-06 我据此误判成"没发生过"（实际是压根没记）。
        #: 对照用户手动 @ 那条路径一直是有 log.warning 的，自动注入这条没有。
        _dropped = 0
        for c in chars:
            # 不再按集区间过滤 SQL：场景绑定服装必须**跨集**可见，
            # 过滤掉就等于把"第 10 集沿用第 1 集睡衣"这条规则关掉了。
            # 集区间的判断下沉到 _rank，只对基础阶段生效。
            # 墓碑阶段不参与候选（stage_gate）：用户删掉的造型不该再进画面。
            # 这是**花钱路径**上的过滤，漏了就等于删除功能不生效。
            from . import stage_gate
            cands = (stage_gate.alive(
                     session.query(AssetStage)
                     .filter(AssetStage.project_id == shot.project_id,
                             AssetStage.character_name == c))
                     .order_by(AssetStage.ep_from).all())
            # 图按指针行解析（自身无图的指针行取源阶段那张），解析不到的不参与排序
            imgs = {x.id: resolve_stage_image(session, x) for x in cands}
            cands = [x for x in cands if imgs.get(x.id)]

            # 排序判据已抽到 `stage_pick`（2026-10-19）：造型面板要能回答
            # "这套为什么没生效"，前端 stageForShot 也要与这里逐字一致。
            # 三处共用一份实现，别在这里再写第四份。
            from . import stage_pick
            st = stage_pick.pick(cands, episode=shot.episode, order=shot.order,
                                 shot_canon=shot_canon)
            url = imgs.get(st.id) if st is not None else None
            # 来源：这张图是「命中某套造型」还是「一套都没中、回退通用定妆图」。
            # 用户报「设了造型却没生效」时，只有这一位能回答 —— 界面上一张脸
            # 长得都对，但一个是本镜该穿的那件衣服，另一个是兜底。
            src_kind = REF_SRC_STAGE if url is not None else REF_SRC_FALLBACK
            # 标签：命中的**镜头级变体 / 场景绑定服装**把造型名带上
            # （"角色「白薇」（本镜造型：丝绸睡裙）"）。这类图必定是按它自己的
            # description 现生成的，图与名字不会打脸，写进提示词能显著加强
            # "这一镜就得穿这件"的锚定。基础阶段不带名字——它的图可能是从兜底占位
            # 继承来的通用图，带上造型名反而会误导模型。
            label = f"角色「{c}」"
            if st is not None and (st.stage_name or "").strip() and (
                    st.shot_from is not None or st.shot_to is not None):
                # 指针行（同一件衣服被别的造型切开后的续段）按它的源判断：源是整集造型时不带名字
                _src = session.get(AssetStage, st.source_stage_id) if st.source_stage_id else None
                if _src is None or _src.shot_from is not None or _src.shot_to is not None:
                    label = f"角色「{c}」（本镜造型：{st.stage_name}）"
            # 造型描述：这张图里人物到底穿什么。指针行自身可能没写描述，
            # 取源阶段的（同一件衣服，描述必然同源）。
            # strip_auto：去掉"〔自动识图〕"标记只留正文——标记是给 UI 区分
            # 人写/机器写的，喂给优化器纯属噪音。
            note = ""
            if st is not None:
                desc = strip_auto(st.description)
                if not desc and st.source_stage_id:
                    src = session.get(AssetStage, st.source_stage_id)
                    # 源被删掉了就别取它的描述——图已经不穿透墓碑
                    # （costumes.resolve_stage_image），描述再取就成了
                    # "文字说睡裙、参考图是别的造型"的自相矛盾。
                    desc = (strip_auto(src.description)
                            if src is not None and not src.deleted_at else "")
                if desc:
                    name = (st.stage_name or "").strip()
                    note = f"{name}：{desc}" if name else desc
            if url is None:
                # 没有造型覆盖本镜（或覆盖它的那套还没图）：用资产页卡片上那张图兜底
                # （2026-10-31 用户裁定：卡片上看到的就是兜底图；此前只认角色资产自己的图，
                # 只有造型图的角色在没被覆盖的镜头里一张图都送不出去）。
                from .stage_coverage import card_image
                url = card_image(session, shot.project_id, c)
                ca = (session.query(Asset)
                      .filter(Asset.project_id == shot.project_id,
                              Asset.kind == "character", Asset.name == c,
                              Asset.deleted_at.is_(None)).first())
                # 兜底图若就是角色资产自己的图，用它的描述；是某套造型的图时，
                # 阶段描述说的不一定是这张，宁可不给。不做字数硬截断（会把锚点截没）。
                note = strip_auto(desc_of(ca)) if (ca and url and ca.image_url == url) else ""
            if url is None:
                continue
            if ("角色", c) in _hide_keys or url in _hide_urls:
                continue          # 用户「不带」：不算被砍，名额让给后面的
            # ⚠️ 三件事的**顺序**决定计数对不对，别调换：
            #   ① 没图 → 跳过，不算被砍（它本来就没得送）
            #   ② 与已入选的图重复 → 跳过，不算被砍（它没占新名额）
            #   ③ 名额已满 → **这才是被砍**，+1 并继续往下数
            # 原来这三件事是一个 `if url not in urls: append` + 末尾 `break`，
            # 既数不出被砍了多少，也分不清"砍了"和"本来就没有"。
            if url in urls:
                continue
            if len(urls) >= max_refs:
                _dropped += 1
                continue
            urls.append(url)
            labels.append(label)
            notes.append(note)
            sources.append(src_kind)
        # P1-3 场景参考图补位：角色图未占满时按注入集合补场景（有图才注入）
        for loc in locs:
            a = (session.query(Asset)
                 .filter(Asset.project_id == shot.project_id,
                         Asset.kind == "location",
                         Asset.name == loc).first())
            if a is None:
                continue
            # 场景造型阶段（2026-11-04）：优先用用户为该场景建的造型阶段图，
            # 无造型或造型无图时再退回 sv_pick_for_shot / a.image_url。
            from .stage_pick import pick as _stage_pick
            loc_stages = (session.query(AssetStage)
                          .filter(AssetStage.project_id == shot.project_id,
                                  AssetStage.character_name == loc,
                                  AssetStage.deleted_at.is_(None),
                                  AssetStage.image_url.isnot(None)).all())
            loc_stage = _stage_pick(loc_stages, episode=shot.episode or 1,
                                    order=shot.order or 0) if loc_stages else None
            if loc_stage:
                url, vlabel = loc_stage.image_url, loc_stage.stage_name
            else:
                url, vlabel = sv_pick_for_shot(session, a.id, shot=shot)
            if url is None:
                url, vlabel = a.image_url, None      # 兜底：老项目只有那一张图
            # 与角色循环同一套顺序：没图/重复/用户不带 都不算被砍，名额满才算。
            if not url or url in urls:
                continue
            if ("场景", loc) in _hide_keys or url in _hide_urls:
                continue
            if len(urls) >= max_refs:
                _dropped += 1
                continue
            urls.append(url)
            labels.append(f"场景「{loc}」（{vlabel}）" if vlabel else f"场景「{loc}」")
            notes.append(strip_auto(desc_of(a)))
            sources.append(REF_SRC_SCENE)
        # ---- 道具（2026-10-08 新增）----
        # 排在角色与场景**之后**，是刻意的最低优先级：参考图位是稀缺资源，
        # 一个道具被截断只是它这张长得不完全一致，一个人物被截断 = 换了张脸。
        # 与场景侧"只挑一张"同理，每件道具只占一个位（道具没有多视角）。
        #
        # ⚠️ 白名单制：`shot.props` 有值 **不等于** 会注入。只有已经出过图的
        # 道具资产才占位；没图的道具资产在要素页等补全，不给模型送空位。
        # 这也解释了为什么"拆解提取了道具"之后画面不会立刻变——
        # 用户还得在要素页把道具图补出来（或点一键补全）。
        _props: list[str] = []
        try:
            _props = [x.strip() for x in json.loads(shot.props or "[]")
                      if isinstance(x, str) and x.strip()]
        except (ValueError, TypeError):
            _props = []
        for pn in _props:
            if pn in _gone:            # 用户删掉的道具资产同样在这里断链
                continue
            a = (session.query(Asset)
                 .filter(Asset.project_id == shot.project_id,
                         Asset.kind == "prop", Asset.name == pn,
                         Asset.deleted_at.is_(None)).first())
            # 没有资产行 / 资产还没出图：跳过。注意这与角色侧不同——
            # 角色没图会退回通用定妆图，道具没有"通用图"这一层。
            if a is None or not a.image_url or a.image_url in urls:
                continue
            if ("道具", pn) in _hide_keys or a.image_url in _hide_urls:
                continue
            if len(urls) >= max_refs:
                _dropped += 1
                continue
            urls.append(a.image_url)
            labels.append(f"道具「{pn}」")
            notes.append(strip_auto(desc_of(a)))
            sources.append(REF_SRC_PROP)
        if _dropped:
            # ⚠️ 这条告警是 2026-10-07 补的，**不能删**。
            # 此前自动注入超限是纯静默的（一个 break 走人，不留任何痕迹），
            # 于是"参考图被丢掉"在生产日志里搜不到，排查时会被误判成"没发生"。
            # 对照：用户手动 @ 那条路径一直有 log.warning。
            log.warning("[refs] %s 自动注入触顶：本镜 %d 个角色 + %d 个场景，"
                        "上限 %d，**%d 张没能注入**（项目 %s）",
                        sid, len(chars), len(locs), max_refs, _dropped,
                        shot.project_id)
        return urls, labels, notes, sources


def _auto_inject_voice_ref(sid: str) -> tuple[str | None, str, str | None]:
    """角色音色自动注入：这一镜谁说话最多，就参考谁的音色。

    返回 `(voice_url, label, skip_reason)`。三者恒有意义，调用方**必须把结果
    记进版本 meta**——不这么做的话，"音色没生效"永远只能靠听。

    ## 为什么需要它

    `Asset.voice_url`（资产弹窗里的「🎙 上传音色」）此前**没有任何消费方**：
    视频侧只认镜头 override 里的 `reference_audio_url`，而**没有任何界面写过
    那个字段**。于是"给人物上传音色"是一个上传完就到此为止的动作——
    文件存下来了，UI 也显示"已设置"，生成时一个字节都不会被用到，且全程无提示。
    （另外两个音色概念别混：`Project.narration_voice_url` 是解说剧的整片旁白，
     `AudioClip.voice_ref_url` 是解说剧逐条 TTS 的克隆参考，走 run_tts_batch。
     这里处理的是第三个：真人剧音画一体通道里的**角色音色**。）

    ## 选谁

    按**说话时长**降序（`drama_timing.speaker_seconds`），不是按出场顺序：
    一镜多人时第一句常常是一句「嗯。」，按顺序取会把配角的音色安到主角身上。
    通道目前只吃一段参考音（`max_reference_audios` 虽为 3，但多段音色无法
    与角色对应，给多了只会让模型串音），所以只取戏份最重的那一个。

    ## 边界

    · 本镜没有任何台词（纯动作/空镜）→ 不注入，skip_reason=None（不是问题）。
    · 说话人被用户删了资产 → 断链，与参考图同一条规则（asset_gate）。
    · 说话人有资产但没上传音色 → 不注入，skip_reason 写清楚是谁，
      这样"我明明传了音色"能当场对上"传的不是这一镜说话的那个人"。
    """
    from . import asset_gate
    from .db import Asset, effective_characters
    from .drama_timing import speaker_seconds
    with get_session() as session:
        shot = session.get(Shot, sid)
        if not shot:
            return None, "", None
        spoken = speaker_seconds(shot.script_ref or "")
        if not spoken:
            return None, "", None          # 无台词镜：本就不需要音色
        gone = asset_gate.deleted_names(session, shot.project_id)
        # 出场角色集合只用来**排序时兜底**，不做硬过滤：说话人是从剧本原文里
        # 解析出来的，比 characters 字段更接近事实（后者可能被人工 remove 过，
        # 但人删的是"参考图里别出现他"，不是"他这镜没说话"）。
        known = set(effective_characters(shot) or [])
        ranked = sorted(spoken.items(), key=lambda kv: (-kv[1], kv[0]))
        # 剧本写法 → 资产名（2026-10-21）：说话人是从剧本原文解析的（「林母」），
        # 资产可能叫归一后的名字。只按原名精确匹配时，这一镜会被记成"说话人都
        # 没有上传音色"——用户明明传了。别名表由拆解写下，是确定的映射，不是模糊匹配。
        try:
            from .char_alias import canonical_character_map
            alias = canonical_character_map(session, shot.project_id) or {}
        except Exception:  # noqa: BLE001 — 别名表坏了就按原名
            alias = {}
        missing: list[str] = []
        for name, _sec in ranked:
            if name in gone:
                continue                   # 用户删掉的资产：断链，与参考图同规则
            a = None
            for cand in dict.fromkeys([name, (alias.get(name) or "").strip()]):
                if not cand or cand in gone:
                    continue
                a = (session.query(Asset)
                     .filter(Asset.project_id == shot.project_id,
                             Asset.kind == "character", Asset.name == cand,
                             Asset.voice_url.isnot(None)).first())
                if a is not None and (a.voice_url or "").strip():
                    break
                a = None
            if a is not None:
                tag = "" if (name in known or a.name in known) else "（该角色不在本镜出场清单里）"
                return a.voice_url, f"角色「{a.name}」音色{tag}", None
            missing.append(name)
        if not missing:
            return None, "", None
        return None, "", "本镜说话人（%s）都没有上传音色" % "、".join(missing[:3])


def _at_ref_model(model_id: str) -> bool:
    """该通道的提示词认不认 `@图片N` / `@音频N` 编号。

    原判据是 `model_id.startswith("seedance")`（官方 seedance 系；第三方低价渠道的 id
    是 seedance-lowcost-*，同样以 seedance 开头但走的是另一条判据，见各调用处注释）。
    2026-11-02 接入万相：它的编号写法是「图 N」「音频 N」，由 provider 下发前改写，
    所以上游照 seedance 的口径写 `@图片N` 即可——provider 用 `at_ref_syntax` 声明。
    """
    if (model_id or "").startswith("seedance"):
        return True
    from .providers.registry import registry
    return bool(getattr(registry.get_video(model_id), "at_ref_syntax", False))


async def _to_trusted_assets(sid: str, urls: list[str],
                             *, uses_ark_assets: bool = False,
                             user_urls: list[str] | None = None) -> list[str]:
    """把定妆图换成火山可信资产引用（asset://），绕过 Seedance 人脸审核。

    只对**官方方舟通道**生效（调用方按 provider.uses_ark_trusted_assets 决定）。
    H3/Veo 没有这道审核，第三方低价渠道也不在方舟侧取图 —— 对它们入库
    纯属白花配额与时间。能力是渠道属性，故本函数收布尔而非 model_id：
    按 `"seedance" in model_id` 猜会把三方渠道也拖进方舟私域库。

    "要用的时候再入库"——在这里做而不是资产生成时，避免给根本不出片的
    角色白占素材库容量。已入库的会直接命中缓存（stage.volc_asset_id），
    同一角色几十个镜头只入一次。

    入库要发网络请求并等几十秒，所以：
      - 放在**出 session 之后**做，不占数据库连接
      - 用 to_thread 包住同步的 HTTP 调用，不阻塞事件循环
    任何一步失败都回退原始 URL——入库是优化项，不能因它把生成打死。
    """
    if not urls or not uses_ark_assets:
        return urls
    try:
        from .providers.volcano_assets import resolve_reference_url
    except ImportError:
        return urls

    # ⚠️ 绝不能在 with get_session() 里做那个网络调用。
    #
    # resolve_reference_url → wait_active(...) 会以 5s 间隔轮询**最长 180 秒**。
    # 放在 session 内的话，170 镜并发时每个镜头都占着一条连接好几分钟，
    # pool_size=20 + max_overflow=30 必然耗尽 → QueuePool timeout 抛出 →
    # 逃出 _run_one → 整个 job 卡在 running（见 A7 那条连锁）。
    # 另外 stage 是 session 绑定对象，却要在 to_thread 的工作线程里被改 ——
    # SQLAlchemy 的 Session 不是线程安全的。
    #
    # 所以拆成三段：① session 内取快照 → ② 出 session 做网络调用
    # → ③ 新 session 写回结果。
    from types import SimpleNamespace

    def _cached(row, url: str) -> tuple[str | None, str | None]:
        """读缓存的 (asset_id, status)；源图已换、或**不知道缓存的是哪张图**，都视为没有缓存。

        不同时，缓存的是**旧图**——直接复用会让模型拿到旧脸，且不报任何错。

        ⚠️ 2026-10-15 改：`volc_asset_src` 为空（这一列加之前写下的老缓存）**不再信任**。
        此前"按原行为信任"，而全库**没有任何一处**在换图时清掉 volc_asset_id——
        于是老缓存的角色只要重生成过定妆图，出片走官方通道时 asset:// 指向的仍是
        **入库那一刻的旧图**（用户甲："生视频之前把人物重生了，生的视频里人还是
        最开始的那版"）。dev 实测 337 条造型缓存里 299 条来源为空。
        代价是这些行下次出片时各重新入库一次（之后记下来源，照常命中缓存）。
        """
        src = getattr(row, "volc_asset_src", None)
        if not src or src != url:
            return None, None
        return row.volc_asset_id, row.volc_asset_status

    # ① 取快照（连接只占这一小段）
    with get_session() as session:
        shot = session.get(Shot, sid)
        if not shot:
            return urls
        project_id = shot.project_id
        # 按 url 反查 stage：注入函数返回的只是 url 列表，且它那个 session
        # 已经关了（detached 对象改了不会落库），必须在本 session 里重新取。
        snap: dict[str, SimpleNamespace] = {}
        for st in (session.query(AssetStage)
                   .filter(AssetStage.project_id == project_id,
                           AssetStage.image_url.in_(urls)).all()):
            aid, ast = _cached(st, st.image_url)
            snap[st.image_url] = SimpleNamespace(
                table=AssetStage, id=st.id,
                volc_asset_id=aid, volc_asset_status=ast,
                # ⚠️ 这两个字段必须跟着一起带：resolve_reference_url 用它们拼
                # 素材组名（`<项目id>:<角色名>`，火山侧**一个角色一组**）与素材名。
                # 漏掉就会双双取到默认值，于是所有角色挤进同一个
                # `<项目id>:unknown` 组、素材名一律叫 `unknown-`——
                # 私域形象「按角色归组」的能力等于没有，人工去素材库里也认不出谁是谁。
                # （上面尾帧那个调用方是对的：它显式传了 tailframe/tail。）
                character_name=st.character_name,
                stage_name=st.stage_name,
            )
        # 角色**通用定妆图**（Asset.kind='character'）同样要入库。
        #
        # 注入函数在角色没有造型阶段时回退到这张图——用户自己上传角色图的项目
        # 往往**一个阶段都没有**，所有角色图都走这一档。此前这里只认 stage，
        # 这类图一律"无处挂 asset_id，原样送"，被 Seedance 判真人拦下
        # （2026-10-09：100009 两个项目 11/16 镜失败，「前夫」系列同因）。
        # 用户裁定：上传的人物资产图**全部**过私域人像库，生成变慢可以接受。
        # 场景/道具图不在此列：没有人脸，送进人像库纯属浪费配额。
        for a in (session.query(Asset)
                  .filter(Asset.project_id == project_id,
                          Asset.kind == "character",
                          Asset.deleted_at.is_(None),
                          Asset.image_url.in_(urls)).all()):
            if a.image_url in snap:
                continue        # 同一张图已作为造型阶段处理，不重复入库
            aid, ast = _cached(a, a.image_url)
            snap[a.image_url] = SimpleNamespace(
                table=Asset, id=a.id,
                volc_asset_id=aid, volc_asset_status=ast,
                character_name=a.name, stage_name="通用",
            )
        # 用户**亲手加进这一镜**的图（临时参考图 / @ 面板点选）——不论归在哪一类，
        # 一律过私域人像库（2026-10-19）。
        #
        # 上面两段只认「造型阶段」与「kind=character」。而「这一镜的临时参考图」
        # 上传时要选归类，**默认值是道具**：用户传一张人像、直接点「加入本镜」，
        # 它就成了 kind=prop，于是原样送出、被 Seedance 判真人拦下——
        # 这正是用户报的"临时参考图里传人像，视频卡审核"。dev 当时 101 条手动
        # 参考图里道具 24、场景 13，都在这个口子外面。
        #
        # 为什么不"按归类猜有没有人脸"：用户自己选的类不可信（默认值就是错的），
        # 而手动图每镜就一两张，多入库几张的代价远小于一镜被拦。
        # 没有人脸的图入库会被判 Failed → resolve_reference_url 原样回退并记住
        # Failed，下次不再重试，不会反复白花配额。
        extra = [u for u in dict.fromkeys(user_urls or []) if u in urls and u not in snap]
        if extra:
            for a in (session.query(Asset)
                      .filter(Asset.project_id == project_id,
                              Asset.deleted_at.is_(None),
                              Asset.image_url.in_(extra)).all()):
                if a.image_url in snap:
                    continue
                aid, ast = _cached(a, a.image_url)
                snap[a.image_url] = SimpleNamespace(
                    table=Asset, id=a.id,
                    volc_asset_id=aid, volc_asset_status=ast,
                    character_name=a.name, stage_name="临时参考")
            for u in extra:
                if u not in snap:
                    # 连资产行都没有（老数据 / 资产被删后残留的地址）：照样入库，
                    # 只是无处缓存——table=None 的不写回，下次出片会再入一次。
                    snap[u] = SimpleNamespace(
                        table=None, id=None, volc_asset_id=None, volc_asset_status=None,
                        character_name="临时参考图", stage_name="")
        # 记下进入网络调用前的状态：只写回真正变化了的行
        before = {u: (s.volc_asset_id, s.volc_asset_status) for u, s in snap.items()}

    # ② 网络调用（无数据库连接在手）
    out: list[str] = []
    for u in urls:
        st = snap.get(u)
        if st is None:
            out.append(u)      # 场景图/道具图：没有人脸，不进人像库，原样送
            continue
        public = to_public_url(u)
        # resolve_reference_url 就地改 st 的 volc_asset_id / volc_asset_status，
        # 这里 st 是普通对象，改它不涉及任何 session
        #
        # ⚠️ 必须走 `run_long_blocking`（独立池），**不能**用 `asyncio.to_thread`。
        # 后者是事件循环的默认 executor，上限 min(32, cpu+4)=20，而同一批槽里
        # 还有鉴权中间件的 verify_session——那是**每个 /v2 请求的必经之路**。
        # 入库等一次最长 180 秒，十几个镜头并发就能把 20 槽占满，于是
        # 「打开项目库」这种与入库毫无关系的操作也要排队（2026-10-27 实测：
        # 16:03 全站 avg 18.99s、16:16 avg 20.56s，而没人在出片时 avg 1.02s）。
        out.append(await run_long_blocking(
            resolve_reference_url, st, public, project_id))

    # ③ 写回（再次短暂持有连接）
    changed = [(u, s) for u, s in snap.items()
               if s.table is not None
               and (s.volc_asset_id, s.volc_asset_status) != before[u]]
    if changed:
        with get_session() as session:
            for u, s in changed:
                row = session.get(s.table, s.id)
                if not row:
                    continue     # 期间被删（造型重识别 / 资产删除），跳过即可
                if row.image_url != u:
                    continue     # 期间换了图：这次的结果属于旧图，不能挂到新图上
                row.volc_asset_id = s.volc_asset_id
                row.volc_asset_status = s.volc_asset_status
                row.volc_asset_src = u
            session.commit()
    return out


#: 上游报错文本 → 失败分类。分类决定 UI 给什么建议：
#: moderation 重试同一提示词必然再被拒，要改词/换模型；channel 值得重试。
def classify_failure(err: str) -> str:
    """分类决定 UI 给什么建议，所以**必须认得自家通道写的文案**。

    ⚠️ 2026-10-08 修：RunningHub 两种失败文案此前一条都不在表里 ——
      取到详情时写 `RunningHub 任务 FAILED：<节点> …`、
      取不到时写 `RunningHub 任务 FAILED（大概率为显存不足：…，可降低
      megapixels 或时长后重试）`。两者都不含旧表里任何词，于是一律落 `other`，
      用户看到的就是那句「生成失败·other」——而"该降 megapixels/时长"
      这条**已经写在 error 文本里**的可执行建议，被归类动作一起抹掉了。
    同时补：中转站常把 `content policy` 写成 `contentpolicy` 无连字符形式，
    旧表带下划线的 `content_policy` 匹配不到（`video_lowcost` 的词表两种都认，
    两处口径不一致本身就是隐患）。
    """
    e = (err or "").lower()
    # 先把分隔符统一，`content_policy` / `content-policy` / `contentpolicy` 一视同仁
    flat = e.replace("_", "").replace("-", "").replace(" ", "")
    if (any(k in e for k in ("sensitivecontent", "moderation", "content_policy",
                             "privacyinformation", "real person", "审核", "敏感"))
            or "contentpolicy" in flat or "safety" in flat
            or "prohibited" in flat or "copyright" in flat or "侵权" in e):
        return "moderation"
    if any(k in e for k in ("timeout", "timed out", "connection", "502", "503",
                            "504", "429", "rate limit", "channeldown", "channel")):
        return "channel"
    # RunningHub 的失败是渠道/资源问题（显存不足、排队失败、节点异常），
    # 值得重试，不是内容问题。归 other 会让 UI 给不出任何建议。
    if "runninghub" in e or "显存" in e or "vram" in flat or "seedvr" in flat:
        return "channel"
    return "other"


def lock_style_line(project_id: str, prompt: str) -> str:
    """把**项目级画风 + 渲染规格**确定性地拼到提示词最前面。

    ## 为什么必须在优化器**之外**做（2026-10-08，用户实测反馈）

    上一版把渲染规格放进 ctx（`_build_prompt_ctx` 的 `全片画风：…渲染规格：…`），
    指望优化器把它保留进输出。**实测只活了 5~6/9 个词**，而且用户 2026-10-08
    在真实项目里看到的是**一个都没有** —— 优化器把它自己的画风措辞
    （"全片为中国风 3D 动画风格…"）写进去了，我们给的那句被改写掉了。

    教训：**"进得了 ctx"与"出得来"是两件事**。用户要的是"固定拼接"，
    那就得是拼接，不是"建议优化器保留"。

    ## 为什么是拼在最前面（prepend）

    - 与 `optimize_full` 的 human 组装方式一致：那一层给 ctx 的定位就是
      "优先级高于原稿"，同时承诺"冲突时以此为准"；
    - 首段（全局基础设定）本来就是放全局规格的位置，渲染规格属于那里；
    - 拼在后面会与规则14条那类"本片是正常速度叙事"的收尾约束挤在一起。

    ## 幂等

    提示词可能已经含画风句（拆解预生成写的、或上一次出片拼过的）。
    重复拼会让提示词越滚越长，所以先判断 `video_line` 的核心词在不在，
    在就原样返回。判据用 **`render_line` 的第一句**（`渲染规格：…`）而不是整串：
    优化器可能改动个别标点，整串比对会漏判。

    `render_line` 为空（真人档、厚涂、国漫四档）时**行为与改动前完全一致** ——
    这是本函数可安全上线的关键：它只对 3D 两档产生任何影响。
    """
    from . import style_preset as _sp
    try:
        st = _sp.load(project_id)
    except Exception as e:  # noqa: BLE001 画风读不到不该让出片失败
        log.warning("[style] 读画风失败，跳过画风锁定：%r", e)
        return prompt
    # ⚠️ **只对 3D 两档介入**（`render_line` 非空的档）。
    #
    # 这里踩过一次：第一版判据写成 `if not head: return prompt`，而
    # `video_line` 对六档**都是非空**的 → 于是六档全部被拼了一遍，
    # 真人档的提示词长度从 49 字变成 88 字，与"其余四档逐字节不变"的承诺不符。
    # 判据必须是 `render_line`：它才是"要不要锁定画风"的开关。
    if not st.render_line:
        return prompt
    head = st.video_line + st.render_line
    body = prompt or ""
    # 时代换头（2026-10-19）：已存的提示词开头可能是**同一档画风的另一时代版本**
    # （改动前现代剧拿到的是国风3D 的古建山水句）。下面的幂等判据只认
    # 「渲染规格：」，会把那句旧画风原样留着——于是改了画风定义，库里几百条
    # 现代剧提示词照旧以「国风古建与山水意境」开头。这里先换掉旧句再判幂等。
    for alt in _sp.era_variants(st.key):
        if alt != st.video_line and body.startswith(alt):
            body = st.video_line + body[len(alt):]
            break
    # 幂等：`渲染规格：` 已在 → 拼过了，不再拼（否则提示词会越滚越长）。
    # 判据用这个短标记而不是整串 —— 优化器可能改动个别标点，整串比对会漏判。
    if "渲染规格：" in body:
        return body
    # 原稿已经把画风写得很足（优化器自己写的画风句）时仍然要拼：
    # 优化器写的是"中国风 3D 动画风格…"，缺渲染管线那一整层规格。
    return head + "\n" + body if body else head


def _explain_refusal(err: str, first_frame_url: str | None,
                     last_frame_url: str | None,
                     ref_labels: list[str]) -> str:
    """把审核报错里的 `content[N]` 翻译成**人看得懂的"是哪张图/哪段词"**。

    ## 为什么必须有这个（2026-10-12 用户甲反馈）

    用户看到的原文是：

        HTTP 400: {"code":"InputImageSensitiveContentDetected.PrivacyInformation",
        "message":"...input image 'content[7]' may contain real person...",
        "param":"content[7]"}

    `content[7]` 对用户毫无意义。方舟的 content 数组顺序是
    **文本 → 首帧 → 尾帧 → 参考图**（见 `video_seedance.py::_build_images`），
    所以 `content[N]` 对应第 N-1 张图（`content[0]` 是文本本身）。
    而"第 6 张图是谁"这个答案**其实就在手里** —— `_auto_inject_refs_detailed`
    早就返回了与之逐位对应的 `labels`（`角色「赵柔」`/`场景「茶楼」`），
    只是以前只拿去写提示词、从没进过错误信息。

    于是用户面对一条审核失败，既不知道该换哪张图，也不知道该改哪句词，
    只能一个个试 —— 实测项目 60a81f4482ce 里"第 7 镜"因此**连续失败 11 次**。

    ## 文本违规

    `param: content[0]` 说明是提示词文本被判违规，报"提示词文本"并说明
    "第 N 张图"不适用 —— 别让用户去猜是图还是词。

    原错误文本**原样保留在后面**（不丢信息），只是前面补一句人话。
    """
    if not err or "content[" not in err:
        return err
    m = re.search(r"['\"]content\[(\d+)\]['\"]", err)
    if not m:
        return err
    idx = int(m.group(1))

    # 顺序与 `_build_images` 逐位对齐：文本 → 首帧 → 尾帧 → 参考图
    if idx == 0:
        why = ("**提示词文本**被判违规（不是图片问题）—— "
               "多半是剧本里的暴力/涉政/侵权词，改写该镜的提示词即可")
    else:
        img_i = idx - 1                       # 这是第几张图（从 0 数）
        named: str | None = None
        off = 0
        if first_frame_url:
            if img_i == 0:
                named = "首帧图"
            off = 1
        if named is None and last_frame_url:
            if img_i == off:
                named = "尾帧图"
            off += 1
        if named is None:
            k = img_i - off
            if 0 <= k < len(ref_labels):
                named = f"参考图 {k + 1} —— {ref_labels[k]}"
        if named is None:
            named = f"第 {img_i + 1} 张图（未能对应到具体资产，可能是已过期的手工参考图）"
        why = (f"**{named}** 被判违规（疑似含真人/敏感内容）—— "
               f"换掉或重新生成这张图即可")

    return f"（{why}）{err}"


def _mark_shots_busy(shot_ids: list[str]) -> int:
    """把整批镜头先标成 `prompting`（= 已排队、还没提交给上游）。

    用于 `run_shot_videos` 开头：在补场景/道具描述（可能要几分钟）、以及
    `gather` 派发之前先把状态立起来，让界面立刻显示「生成中」。
    不这么做的话，用户点了生成之后整批镜头仍是「未出片」，看起来像没提交成功
    （2026-10-24 用户需求）。

    ⚠️ 只动**还没出片**的行（`video_url IS NULL`）：显式重出一批已有片子的镜头
    时，用户手里那条能播的片子还在，把它标成"生成中"等于把已有成果藏起来。
    前端 `shotBusy()` 也是同一条判据，两边一致。

    ⚠️ 不动 `failed`：重试的镜头 `_run_one` 会自己写 `prompting`（并且顺带清掉
    旧错误），这里提前覆盖会让"失败 → 正在重试"的中间态少一拍，没有好处。
    """
    if not shot_ids:
        return 0
    n = 0
    with get_session() as session:
        rows = (session.query(Shot)
                .filter(Shot.id.in_(shot_ids),
                        Shot.video_url.is_(None),
                        # ⚠️ 必须把 NULL 放进来：SQL 里 `NULL != 'failed'` 求值为
                        # NULL（既非 true 也非 false），只写 `!= "failed"` 会让
                        # status 为 NULL 的行**一条都标不上**，它们就永远显示
                        # 「未出片」—— 正是本次要修的那个现象，只是换了个入口。
                        # 列有 default="pending"，dev 库实测 0 行 NULL，但老数据
                        # 与手写 SQL 都可能留下这种行，一行代码的成本不值得赌。
                        # 用 tuple 的 `.in_()` 而不是 `sqlalchemy.or_()`：本模块没
                        # import sqlalchemy（py_compile 查不出这种 NameError）。
                        Shot.status.in_((None, "pending", "prompting",
                                         "generating", "review", "adopted")))
                .all())
        for sh in rows:
            sh.status = "prompting"
            n += 1
        if n:
            session.commit()
    return n


def _release_transient(shot_ids: list[str]) -> int:
    """把**还停在瞬时态**的镜头放回 `pending`，返回放掉了几个。

    只用于"任务被取消、这批镜头再也不会有人收尾"的场合（见 run_shot_videos
    末尾那段）。刻意**不**复用 `_set_shot_status(..., "failed")`：

      · 取消不是失败，不该在任务中心挂一片红；
      · `pending` 正是"还没生成过"的既有取值，前端照常显示"未出片"，
        用户可以重新提交。

    ⚠️ 必须带 `status.in_(_SHOT_TRANSIENT)` 这个条件：取消是**并发**发生的，
    同一时刻可能已经有镜头跑完写了 `adopted`、有镜头刚失败写了 `failed`。
    无条件覆盖会把那些真实结果抹成"没生成过"——画面还在、状态却说不存在。

    ⚠️ 也**不**清 `fail_reason`：被取消的镜头如果上一轮留过失败原因，那是
    真实历史，与"这一轮没跑完"是两件事。
    """
    if not shot_ids:
        return 0
    n = 0
    with get_session() as session:
        rows = (session.query(Shot)
                .filter(Shot.id.in_(shot_ids),
                        Shot.status.in_(("prompting", "generating")))
                .all())
        for sh in rows:
            sh.status = "pending"
            n += 1
        if n:
            session.commit()
    return n


def _set_shot_status(sid: str, status: str, error: str | None = None) -> None:
    with get_session() as session:
        shot = session.get(Shot, sid)
        if shot:
            shot.status = status
            if status == "failed":
                # 只留摘要：上游错误常带整段 JSON + traceback，全塞进去
                # UI 上没法看，日志里也已经有完整版。
                #
                # ⚠️ 审核类放宽到 600（2026-10-13）：`_explain_refusal` 已经在前
                # 面加了一段人话前缀（"（**参考图 6 —— 角色「白晓楠」** 被判违规…）"），
                # 若仍按 300 截，前缀会把原来的 `content[N]` 线索挤出去，
                # 等于翻译白做。600 能同时装下前缀与完整原始 JSON。
                _cap = (_ERR_MODERATION_ITEM_CAP + 200
                        if classify_failure(error or "") == "moderation" else 300)
                shot.fail_reason = (error or "")[:_cap] or None
                shot.fail_kind = classify_failure(error or "")
            elif status in ("adopted", "review", "prompting", "generating"):
                # 重试成功后要清掉旧错误，否则镜头一直挂着上次的失败原因
                #
                # ⚠️ `prompting` 也在这里面（2026-10-24 补）：它是重试链路的**第一站**
                # —— `_run_one` 一进来就写它，此时上一轮的 `fail_kind/fail_reason`
                # 还没被清，于是同一行数据同时说着"正在生成"和"生成失败"。
                # 前端从 2026-10-24 起按 `status` 显示「生成中」，两种说法打架时
                # 用户看到的是"点了重试，还是失败"。清在这里，两者就一致了。
                shot.fail_reason = None
                shot.fail_kind = None
            session.commit()
            # P2-5 SSE：镜头状态流转（prompting/generating/adopted/failed）实时推送
            publish(shot.project_id, "shot", {"id": sid, "status": status,
                                              "fail_kind": shot.fail_kind,
                                              "fail_reason": shot.fail_reason})


def _save_shot_version(sid: str, video_url: str, model_id: str,
                       prompt: str, meta: dict | None,
                       thumb_url: str | None = None) -> int:
    """落一条版本记录，返回版本号（同镜头内自增）。"""
    from datetime import datetime, timezone
    from .db import ShotVersion
    with get_session() as session:
        last = (session.query(ShotVersion).filter(ShotVersion.shot_id == sid)
                .order_by(ShotVersion.version_no.desc()).first())
        vno = (last.version_no + 1) if last else 1
        session.add(ShotVersion(
            id=uuid.uuid4().hex[:12], shot_id=sid, version_no=vno,
            video_url=video_url, thumb_url=thumb_url,
            model_id=model_id, prompt=prompt,
            meta=json.dumps(meta, ensure_ascii=False) if meta else None,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ))
        session.commit()
        return vno


def _plan_default_stages(session, project_id: str, cname: str,
                         eps: list[int]) -> list[tuple[int, int]]:
    """为「完全没有定妆图的角色」规划要补建的造型阶段区间。

    输入 eps = 该角色的出场集数（可能不连续，如 [1,2,5]）。
    返回 [(ep_from, ep_to), ...]，已排除与既有阶段重叠的集。

    ## 为什么不能简单地"按连续段拆分"（这是一个真实 bug 的修复）

    旧实现把出场集压成**连续段**，每段建一个阶段，且都叫「默认造型」、
    description 相同（都取角色通用 prompt）。于是出场集有跳集的角色（如白薇
    出现在第 1、2、5 集）会得到两个**一模一样**的阶段：
      「默认造型」ep1-2 / 「默认造型」ep5-5
    用户在资产页看到两条完全相同的记录，无法理解区别在哪，还要为同一个造型
    付两次生图钱、并且两张图长得不一样（同一角色跨集变脸）。

    正确做法：**同一个"默认造型"本质上只该有一个阶段**。既然没有任何造型信息
    可区分，就用一个区间 [min, max] 覆盖到底——中间没出场的集数被覆盖了也无害
    （注入只按镜头所在集查阶段，该集没镜头就查不到）。只有当区间会与**既有
    阶段**重叠时才必须避让，此时才退化成多段。
    """
    from .db import AssetStage
    from . import stage_gate
    if not eps:
        return []
    # 墓碑阶段**不占集号**（stage_gate 里那条刻意的取舍）：否则用户删掉一个
    # 阶段后，那几集依旧被一个看不见的东西占着，规划只能绕开它 → 重跑识别后
    # 那段集永远没有造型，而用户在界面上找不到原因。
    siblings = stage_gate.alive_stages(session, project_id, cname)
    taken = {e for st in siblings for e in range(st.ep_from, st.ep_to + 1)}
    lo, hi = min(eps), max(eps)
    # 首选：一个区间打通到底（无空缺 → 同角色只有一条「默认造型」）
    span = [e for e in range(lo, hi + 1) if e not in taken]
    if not span:
        return []
    if len(span) == hi - lo + 1:
        return [(lo, hi)]
    # 与既有阶段重叠：只能按可用集的连续段拆（避免 patch_stage 的 409 重叠校验）
    runs: list[list[int]] = []
    for e in span:
        if runs and e == runs[-1][1] + 1:
            runs[-1][1] = e
        else:
            runs.append([e, e])
    return [(a, b) for a, b in runs]


async def run_one_click_film(jid: str) -> None:
    """一键成片 Saga（阶段⑤）：拆解 → 资产 → 片段 → 拼接。

    原「🚀 一条龙」已并入：同一条链（拆解→资产→片段→拼接），差别只在从哪环
    切入。后端会跳过已完成的环节（拆解：有 shots 则跳过；资产：gen_assets=false
    则跳过；片段：已出片的镜头自动跳过），所以从任何入口调用都安全。
    原先资产与片段之间的「首帧」一环随首帧路线 2026-11-20 下线而删除。

    payload = {
      "project_id": "...",
      "script": "...",               # 缺省时取项目的 optimized_script/raw_script
      "gen_assets": false,           # true = 先补缺失资产图，再出片段
      "llm_model": null, "video_model": null, "prompt_prefix": null,
      "resolution": null,            # 本次覆写分辨率档位；null = 沿用项目设置
      "aspect_ratio": null           # 本次覆写画面比例；null = 沿用项目 base_aspect
    }
    ⚠️ 2026-09-10：payload 里原来写的是 `width/height/fps`，**这三个键从来没有
    任何代码读过**（服务端不再合成，成片由桌面端 ffmpeg 出，尺寸由片段本身决定）。
    前端却一直在下发 `width: 1080, height: 1920` 兜底，于是「本次参数」里改的
    分辨率既没生效、也没报错。真正管用的旋钮只有一个：下发给 Provider 的
    `VideoRequest.megapixels` / `aspect_ratio`，它们在 run_shot_videos 里定，
    所以这一层要把 `resolution` / `aspect_ratio` 原样透传给 shot_videos 子 job。
    进度分配：拆解 0-10，资产 10-30，片段 60-85，收尾 85-100（30-60 原是首帧，现直接跳过）。
    **不产出成片文件**：最后的合成由桌面端本机 ffmpeg 完成（多轨/转场/字幕样式）。
    任一段整体失败即置 failed 并带上失败段落名，不静默往下走。
    """
    from .db import Asset, AssetStage, Project
    from .readiness import compute_readiness

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        script = p.get("script") or proj.optimized_script or proj.raw_script
    if not script:
        _update(jid, status="failed", error="项目没有剧本，请先导入/优化剧本")
        return

    _update(jid, status="running", progress=1)

    # 一键成片的五段流程标签。前端 PreflightDialog 按 key 逐步点亮，
    # 所以这里的 key 与前端 STAGES 必须一一对应——改名要两边一起改。
    def _stage(key: str, label: str, done: int = 0, total: int = 0) -> None:
        set_job_phase(jid, {"key": key, "label": label, "done": done, "total": total})

    # 段边界取消：用户点「停止生产」后不再进入下一段。
    # 段**内**的取消由子 runner 的镜头级检查点负责（parent_jid 传导）。
    def _abort_if_cancelled() -> bool:
        if is_cancelled(jid):
            set_job_phase(jid, None)
            return True
        return False

    # 1) 镜头拆解（0-10）：项目还没镜头，或显式传了新剧本则重拆
    # 这一段的 total 事前未知（拆完才知道多少镜），故只报 label 不报计数
    #
    # ⚠️ 必须走 breakdown_by_episode（**逐集**拆），不能直接 do_breakdown(整本剧本)。
    # 后者不传 episode，`do_breakdown` 会把全部镜头打上 episode=1，
    # 于是 generate_narration 按集分组时只看得见第 1 集的正文，把它稀释到全部
    # 镜头上——第 2 集起的旁白从头到尾不参与。实测项目 930 就是这样变成
    # "画面在演第 6 集、声音在念第 5 集"的。
    _stage("breakdown", "正在拆解镜头")
    try:
        with get_session() as session:
            has_shots = session.query(Shot).filter(Shot.project_id == project_id).count() > 0
        if not has_shots or p.get("script"):
            await breakdown_by_episode(
                project_id, script, p.get("llm_model"),
                # 显式传了新剧本 = 用户要按这本重来，已有镜头一律重拆
                force=bool(p.get("script")),
                video_model=p.get("video_model"))
        _update(jid, progress=10)
    except Exception as e:  # noqa: BLE001
        _update(jid, status="failed", error=f"拆解失败: {e!r}")
        return
    if _abort_if_cancelled():
        return

    # 2) 资产补齐（10-30）：只有 gen_assets=true 且真有缺口时才跑
    if p.get("gen_assets"):
        # 2-0) 先让 AI 规划造型阶段（含剧本明写的服装变体，如「丝绸睡裙」）。
        #
        # 为什么必须在生图之前跑这一步：原先一键链路根本不调 stages/draft，
        # 于是"剧本里写了不同服装人设的角色"永远只会拿到一条 `默认造型`
        # ——那件衣服既没被识别、也没被生成资产（用户反馈的正是这一点）。
        # stages_draft 会保护已有图的角色（kept_chars），所以重复调用不会
        # 冲掉用户已经出过图的时间线，也不会重复烧钱。
        # 识别失败（LLM 挂了/返回非 JSON）不阻断：退回"每角色一条默认造型"的
        # 老行为，总比整个一键成片失败好。
        _stage("costume", "正在识别服装造型")
        try:
            from .routes_v2 import StageDraftIn, stages_draft
            r = await stages_draft(StageDraftIn(project_id=project_id,
                                                model_id=p.get("llm_model")))
            log.info("[one_click_film %s] 造型阶段规划完成: 共 %s 个（其中服装变体 %s 个）",
                     jid, r.get("created"), r.get("variants"))
        except Exception as e:  # noqa: BLE001 识别失败不阻断，退回默认造型
            log.warning("[one_click_film %s] 造型阶段识别失败，退回默认造型: %r", jid, e)

        rd = compute_readiness(project_id)
        if rd.get("error"):
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        # Q1：先取人物档案（性别/年龄段/身份），供定妆照提示词使用。
        # 必须在 session 块**之前** await —— 同步 session 里不能跑协程，
        # 且 character_brief 会调 LLM，占着 DB 连接等网络是明确的反模式。
        _briefs = await _collect_briefs(project_id, rd, p.get("model_id"))
        # 形象档案（骨相/五官/气质）：同理必须在 session 块前 await。
        # 用户 2026-09-09 决策：一键成片里自动跑，不需要单独点一次。
        _profiles = await _collect_profiles(project_id, rd, p.get("model_id"))
        # 影调档案（全片一套调色基调）：同理必须在 session 块前 await。
        # 它拼进下面所有 character_prompt / scene_prompt，是"不同图色调不统一"的主要修法。
        _look = await _collect_look(project_id)
        # 画风预设（都市/古风/国漫…）：读一行库，不 await。它同时决定前缀、
        # 否定项与质感词——只换前缀会与残留的「禁止动漫」自相矛盾，
        # 见 style_preset 模块头。
        _style = _style_of(project_id)
        # Q3：场景描述就地补齐。没有它 scene_prompt 只报一个场景名，
        # 出来的参考图是"某个高档餐厅"而不是**这一个**餐厅；
        # 更要紧的是镜头提示词也拿不到陈设依据（见 ensure_scene_descriptions）。
        # 不透传 p["model_id"]：本 job 的 model_id 语义是**视频**模型覆盖值。
        await ensure_scene_descriptions(project_id)
        # 本链路同时会出道具参考图（下面的 _prop_items），形状同样需要描述
        await ensure_prop_descriptions(project_id)
        items: list[dict] = []
        with get_session() as session:
            proj = session.get(Project, project_id)
            title = proj.title if proj else ""
            # 资产图画幅跟项目走（P0-4）：竖画幅跟、横画幅退回 1:1，
            # 理由与实测数据见 `_ASSET_SIZES` 的注释。
            _asp = proj.base_aspect if proj else None
            _asset_sz = _asset_size(_asp)
            # 🐛 资产生图此前**不传 model_id**，于是 ImageProvider(model_id=None)
            # 恒取 settings.image_model（全局默认），而镜头图走的是项目自己的
            # image_model。两者是同一型号时看不出问题，用户一改项目模型，
            # 资产图和成片立刻两种质感——这是"色调不统一"的成因之二。
            _asset_image_model = _resolve_project_gen_settings(proj)[1]
            # 2a) 阶段无图（直接生图进该阶段）
            for row in rd["assets"]["stages_no_image"]:
                st = session.get(AssetStage, row["id"])
                if st is None:
                    continue
                items.append({
                    "name": f"角色-{st.character_name}",
                    "stage_id": st.id,
                    "prompt": character_prompt(
                        title, st.character_name,
                        stage_name=st.stage_name,
                        description=st.description,
                        brief=brief_for_image(_briefs, st.character_name),
                        creature=creature_of(_briefs, st.character_name),
                        profile=_profiles.get(st.character_name),
                        look=_look, style=_style,
                        aspect=_asp),
                })
            # 2b) 角色完全无定妆图：补建阶段行再生图
            for row in rd["assets"]["chars_no_asset"]:
                cname, eps = row["name"], row["episodes"]
                runs = _plan_default_stages(session, project_id, cname, eps)
                if not runs:
                    continue
                ca = (session.query(Asset)
                      .filter(Asset.project_id == project_id,
                              Asset.kind == "character", Asset.name == cname).first())
                desc = desc_of(ca) or ""
                for ep_from, ep_to in runs:
                    st = AssetStage(id=uuid.uuid4().hex[:12], project_id=project_id,
                                    character_name=cname, stage_name="默认造型",
                                    ep_from=ep_from, ep_to=ep_to, description=desc)
                    session.add(st)
                    session.commit()
                    items.append({
                        "name": f"角色-{cname}",
                        "stage_id": st.id,
                        "prompt": character_prompt(
                            title, cname, description=desc,
                            brief=brief_for_image(_briefs, cname),
                            creature=creature_of(_briefs, cname),
                            profile=_profiles.get(cname),
                            look=_look, style=_style,
                            aspect=_asp),
                    })
            # 场景多视角参考图（8 张/场景：方位 4 + 景别 4）。
            # 一张图不够的理由见 scene_view 模块头：镜头一换机位，模型手里只有
            # 一个方向的照片，只能现编这个房间的其它面——同一个客厅会不是同一个客厅。
            items += _scene_view_items(session, project_id, title,
                                       rd["assets"]["locations_no_image"], _look)
            # 道具参考图（2026-10-08）：每件 1 张，排在场景之后。
            # 它与角色/场景**不同**的一点：道具资产是从拆解结果直接长出来的，
            # 不需要"先识别再补建阶段"那一步，所以这里的缺口 = 有资产行但没图。
            items += _prop_items(session, project_id, title,
                                 rd["assets"].get("props_no_image") or [], _look)
        if items:
            # 段边界再查一次取消：用户在拆解/资产盘点这段时间里点了「停止生产」时，
            # 原来照样建子 job 并跑一遍——每一项在入口秒退成"已取消"，
            # 子 job 却被判 failed，再把 12KB 的明细灌进父 job 的 error，
            # 用户于是在自己点的取消之后收到一张红色「生成失败」卡片（2026-09-01 生产报障）。
            if _abort_if_cancelled():
                return
            _stage("assets", "正在补资产图", 0, len(items))
            sub_a = create_job("asset_batch", {"project_id": project_id,
                                               "items": items, "size": _asset_sz,
                                               "model_id": _asset_image_model,
                                               "_billing": "child"})
            await run_asset_batch(sub_a, parent_jid=jid)
            a_job = get_job(sub_a)
            if a_job is not None and a_job.status == "cancelled":
                _abort_if_cancelled()
                return
            if a_job is None or a_job.status == "failed":
                _update(jid, status="failed",
                        error=f"资产生成失败: {(a_job.error if a_job else 'job 丢失')}")
                return
        _update(jid, progress=30)
    else:
        _update(jid, progress=30)
    if _abort_if_cancelled():
        return

    # 2.9) 镜头脚本闸门（2026-11-19）：镜头脚本改由 Muse 撰写并锁定，一键成片不再
    # 自己写提示词。待出片的镜头里**一镜锁定稿都没有**时，后面的首帧 / 配音 / 出片
    # 注定全部失败（`run_shot_videos` 逐镜拒绝），而首帧和配音是真金白银 ——
    # 所以在花这笔钱之前就停下，把话说清楚。拆解与资产（上面两段）照常保留。
    # 只要有一镜锁了稿就放行：那是「先出这几镜」的正常用法，没锁的由出片那一步逐镜报。
    with get_session() as session:
        _todo = [s for s in session.query(Shot)
                 .filter(Shot.project_id == project_id).order_by(Shot.order).all()
                 if not s.video_url and not s.disabled and not s.is_special]
        _no_script = [s.order for s in _todo if not _locked_prompt_of(s.profile_override)]
    if _todo and len(_no_script) == len(_todo):
        set_job_phase(jid, None)
        _update(jid, status="failed",
                error=(f"{len(_todo)} 个待出片镜头都还没有锁定的镜头脚本。"
                       f"{SHOT_SCRIPT_BY_MUSE}：拆解与资产已就绪，"
                       "请让 Muse 写入并锁定镜头脚本后再出片"))
        return

    # 3) 这里原有「全部首帧」一段（30-60），随首帧路线 2026-11-20 下线而删除。
    _update(jid, progress=60)
    if _abort_if_cancelled():
        return

    # 3.5) 解说剧配音（60-70）——**必须在出视频之前**。
    #
    # 解说剧的镜头时长由旁白时长决定（run_tts_batch 里的 _sync_shot_duration）。
    # 如果先出视频再配音，时长一改这些视频全部作废，等于白烧一轮钱。
    # 所以顺序是：切旁白 → 合成 → 回写时长 → 再按新时长出视频。
    #
    # 真人剧不走这里：它的台词配音是叠在既有画面上的，不改镜头时长，
    # 用户在音频面板按需合成即可。
    narration_done = 0
    with get_session() as session:
        proj_mode = session.get(Project, project_id)
        is_narration = bool(proj_mode and proj_mode.production_mode == "narration")
        narr_voice = proj_mode.narration_voice_url if proj_mode else None
    if is_narration:
        from .routes_v2 import GenNarrationIn, generate_narration
        _stage("narration", "正在生成解说旁白")
        try:
            gen = generate_narration(project_id, GenNarrationIn(project_id=project_id))
            narration_done = gen.get("created", 0)
        except Exception as e:  # noqa: BLE001
            # 切分失败不该让整条链断在这——没有旁白的成片仍然可用（只是哑的），
            # 而用户可以事后在音频面板补。但要把原因带到最终结果里。
            log.warning("[autopilot] 解说旁白切分失败: %r", e)
        if not narr_voice:
            # 没配解说音色就没法合成。不静默跳过——那会让用户拿到一部
            # 没有解说的"解说剧"，还不知道为什么。
            _update(jid, status="failed",
                    error="解说剧需要先设置解说音色：音频面板 →「解说音色」上传一段人声参考")
            return
        _stage("narration_tts", "正在合成解说配音")
        sub_tts = create_job("tts_batch", {"project_id": project_id,
                                          "_billing": "child"})
        await run_tts_batch(sub_tts)
        tts_job = get_job(sub_tts)
        if tts_job is None or tts_job.status == "failed":
            _update(jid, status="failed",
                    error=f"解说配音失败: {tts_job.error if tts_job else 'job 丢失'}")
            return
        _update(jid, progress=70)
        if _abort_if_cancelled():
            return

    # 4) 逐镜生成视频（70-85）：复用 run_shot_videos，用子 job 承载细粒度结果
    with get_session() as session:
        _need = (session.query(Shot)
                 .filter(Shot.project_id == project_id,
                         Shot.video_url.is_(None),
                         Shot.disabled == 0).count())
    _stage("videos", "正在生成片段", 0, _need)
    sub_jid = create_job("shot_videos", {
        "project_id": project_id,
        "model_id": p.get("video_model"),
        "prompt_prefix": p.get("prompt_prefix"),
        # 「本次参数」里改的分辨率/画幅必须透传下去——真正下发给 Provider 的是
        # 子 job（run_shot_videos），一键成片这一层只是转发。漏传的话用户在
        # 面板上改了、也看见"已改"了，实际出片仍按项目设置走（静默失效）。
        # 值为 None 表示"沿用项目设置"，run_shot_videos 按 None 处理。
        "resolution": p.get("resolution"),
        "aspect_ratio": p.get("aspect_ratio"),
        "_billing": "child",
    })
    await run_shot_videos(
        sub_jid,
        progress_cb=lambda pct: _update(jid, progress=70 + int(pct * 0.15)),
        phase_jid=jid, parent_jid=jid,
    )
    sub = get_job(sub_jid)
    if sub is None or sub.status == "failed":
        _update(jid, status="failed",
                error=f"镜头生成全部失败: {sub.error if sub else 'job 丢失'}")
        return
    _update(jid, progress=85, result=sub.result)
    if _abort_if_cancelled():
        return

    # 5) 收尾（85-100）：**不再服务端拼接**。
    #
    # 服务端拼接只能做单轨顺序拼接——不渲染转场、不合成叠加层、字幕烧录也只有
    # 一个写死的 FontSize=18。它产出的"成片"和桌面端本机渲染的成片根本不是
    # 同一件东西，而用户拿到的又都叫"成片"，反而更容易误以为效果就该这样。
    # 现在统一由桌面端本机 ffmpeg 收尾（多轨 / 转场 / 字幕样式 / 硬件编码）。
    _stage("finalize", "镜头与旁白已就绪")
    with get_session() as session:
        shots = (session.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        ready = [s for s in shots if s.video_url and not s.disabled]
    if not ready:
        _update(jid, status="failed", error="没有任何镜头生成成功")
        return

    set_job_phase(jid, None)   # 收尾清标签，避免 _JOB_PHASE 无限增长
    _update(jid, status="done", progress=100, result=json.dumps({
        # film 恒为 None：一键成片不再直接产出视频文件。前端据此提示用户导出。
        "film": None,
        "ready_shots": len(ready),
        "next_step": "镜头与旁白已全部就绪，请在桌面端点「导出成片」用本机渲染收尾。",
        "shots": json.loads(sub.result or "{}").get("shots", []),
    }, ensure_ascii=False))


async def run_costume_scan(jid: str) -> None:
    """全剧服装识别 job（**纯文本、不生成任何图片、不花生图的钱**）。

    payload = {"project_id": "...", "model_id": null, "priors": {角色: 描述} | null}

    为什么必须是 job 而不是同步接口：识别要逐集调 LLM（长剧几十集 = 几十次调用，
    分钟级），同步接口会撞 nginx 504；更重要的是它必须**跑在出图之前**——
    「🖼 补齐缺失资产（N）」那个 N 是从 `asset_stages` 数出来的，识别没跑过时
    N 只等于"没有定妆图的角色数"，用户看到的报数就不是真实要出的图数
    （2026-08 用户实测：测试3 从没跑过识别，库里 0 条 asset_stages，
    于是无论剧情里有多少套衣服，按钮永远只显示 8）。
    """
    from fastapi import HTTPException

    from .routes_v2 import run_stages_draft

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    _update(jid, status="running", progress=1)
    set_job_phase(jid, {"key": "costume_scan", "label": "正在识别全剧服装",
                        "done": 0, "total": 0})

    def _progress(pct: int, note: str = "") -> None:
        _update(jid, progress=max(1, min(99, int(pct))))
        set_job_phase(jid, {"key": "costume_scan",
                            "label": note or "正在识别全剧服装",
                            "done": 0, "total": 0})

    try:
        out = await run_stages_draft(project_id, p.get("model_id"),
                                     p.get("priors"), progress_cb=_progress)
    except HTTPException as e:          # 无剧本/项目不存在等，如实回显给前端
        set_job_phase(jid, None)
        _update(jid, status="failed", error=str(e.detail))
        return
    except Exception as e:  # noqa: BLE001
        set_job_phase(jid, None)
        _update(jid, status="failed", error=f"服装识别失败: {e!r}")
        return

    set_job_phase(jid, None)
    _update(jid, status="done", progress=100,
            result=json.dumps(out, ensure_ascii=False))


async def run_profile_fill(jid: str) -> None:
    """补生成缺失的角色形象档案（「要素」页按钮，2026-10-17）。

    payload = {"project_id": "..."}。只补**还没有档案**的角色，已有的一个不动
    （档案 = 这个人长什么样，自动流程改它等于换脸）。纯文本、不出图。

    状态口径：
      · 整批失败（模型挂了 / 返回解析不出）→ failed，error 写原因；
      · 补上了一部分、仍漏几个 → done，result.missing 列出名字，用户可再点；
      · 本来就不缺 → done，wanted=0。
    """
    from .character_profile import fill_profiles

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    _update(jid, status="running", progress=5)
    set_job_phase(jid, {"key": "profile_fill", "label": "正在生成角色形象档案",
                        "done": 0, "total": 0})
    report = await fill_profiles(project_id, None, p.get("model_id"))
    set_job_phase(jid, None)
    whole_fail = bool(report.get("error")) and not report.get("generated")
    _update(jid, status="failed" if whole_fail else "done", progress=100,
            result=json.dumps({"profiles": report}, ensure_ascii=False),
            error=(f"形象档案生成失败：{report['error']}" if whole_fail else None))


async def breakdown_by_episode(
    project_id: str,
    raw_script: str,
    model_id: str | None,
    *,
    episodes: list[int] | None = None,
    force: bool = False,
    video_model: str | None = None,
    pregen_prompts: bool = True,
    on_progress=None,
    episode_offset: int = 0,
) -> dict:
    """**逐集**拆解一个项目。所有拆解入口的唯一实现。

    返回 {"episodes":[{episode,title,shots|error}...], "skipped":[...], "note":str|None}

    `episode_offset`：追加剧本时使用。新剧本的集号全部加上这个偏移，
    避免与项目已有集号冲突。例如项目已有第 1–30 集，追加时传
    `episode_offset=30`，新剧本的第 1 集变成第 31 集，以此类推。
    普通首次拆解保持默认值 0，行为与改动前完全一致。

    ## 为什么必须共用一份

    这段逻辑此前只存在于 `run_breakdown_all` 里，而 `run_one_click_film` 自己另写了
    一行 `do_breakdown(script, model, project_id)` —— **没传 episode，还把整个多集
    剧本一次性喂了进去**。`do_breakdown` 于是把全部镜头打上 `episode=1`，
    `generate_narration` 按集分组时只取得第 1 集的正文，把它稀释到全部镜头上，
    **第 2 集的旁白从头到尾没有参与**（实测项目 930：画面覆盖两集、旁白只有第 1 集，
    镜 8-15 是"画面在演第 6 集、声音在念第 5 集"）。

    两条路径各写一遍正是事故成因，所以这里合成一份，两边都调它。

    `episodes`：只拆这几集（重拆语义，无视已拆状态）；None = 全部。
    `force`：为 False 时跳过已有镜头的集（增量补拆）。
    `on_progress(done, total)`：每集完成回调，供 job 侧更新进度。

    ## 拆解**不再写镜头提示词**（2026-11-19 用户裁定）

    镜头脚本（视频提示词）一律由 Muse 撰写并锁定（`set_shot_prompt(s)`，lock=true），
    镜流只负责存与出片。此前这里每集拆完会立刻调 `_pregen_prompts` 用文本模型
    逐镜写一稿（外加「开场站位」分析）——那一段已整体删除：拆解只落镜头行、
    资产行，以及下面的造型 / 档案 / 影调 / 场景与道具描述。

    `pregen_prompts` 这个参数名是历史遗留，**已不代表写提示词**：它现在只是
    「拆完要不要顺带跑造型识别 / 形象档案 / 影调 / 场景道具描述」这组收尾步骤的开关。
    保留原名是为了不改调用方。
    """
    from .config import get_settings      # 局部导入，见下方 _bd_n（本模块无模块级绑定）
    from .routes_v2 import (do_breakdown,
                            breakdown_shot_cap)
    from .script_import import smart_split_chapters, too_short_to_break_down
    from .db import Project

    with get_session() as session:
        done_eps = {s.episode for s in session.query(Shot)
                    .filter(Shot.project_id == project_id).all()}
        # 解说剧：把"一镜最多多少字"带进拆解。不带的话 LLM 按"7-15 秒视频"
        # 拆出 116 字/镜，而 720p 海螺 H3 一镜只够读 85 字——旁白读不完，
        # 声音直接盖到下一个镜头上（项目 930 实测）。
        max_chars = narration_max_chars(session.get(Project, project_id),
                                        video_model)
        # 真人剧：把"这个视频模型一镜最多多少秒"带进拆解。不带的话一律按
        # 15 秒级模型拆成 8-12 秒一镜——选了 seedance-2.5（单镜 30s）的项目
        # 会被白白剁成三倍数量的碎镜，钱多花两倍、穿帮机会也多两倍。
        shot_cap = breakdown_shot_cap(session.get(Project, project_id),
                                      video_model)

    chapters = smart_split_chapters(raw_script or "")
    if not chapters:
        raise RuntimeError("剧本解析不出内容")

    # 追加剧本时，把新集号偏移到已有集号之后，避免与既有集号冲突。
    # 前言（order=0）不偏移：前言不拆解，集号无意义。
    if episode_offset > 0:
        for ch in chapters:
            if ch["order"] > 0:
                ch["order"] = ch["order"] + episode_offset

    wanted = set(episodes or [])
    if wanted:
        # 指定集：只拆这些集（重拆语义，无视已拆状态）
        todo = [c for c in chapters if c["order"] in wanted]
    else:
        todo = [c for c in chapters if force or c["order"] not in done_eps]

    # 前言与过短集一律不送 AI（C1）。
    # LLM 被要求产出镜头时不会因为"没内容"而拒绝，它会照着标题**凭空编**——
    # 实测 8 个字的书名换来一整段虚构剧情与 4 个剧本里不存在的角色，
    # 而这些假镜头/假角色会一路流进资产、首帧、成片，用户无从分辨真假。
    # 跳过的集要如实回报，不能静默丢弃（否则用户只看到集数对不上）。
    skipped = [{"episode": c["order"], "title": c["title"],
                "reason": "前言（非正片）" if c["order"] == 0 else
                          f"正文仅 {c['word_count']} 字，过短"}
               for c in todo if too_short_to_break_down(c)]
    todo = [c for c in todo if not too_short_to_break_down(c)]

    if not todo:
        return {"episodes": [], "skipped": skipped,
                "note": ("全部集已拆解" if not skipped else
                         f"没有可拆解的集（跳过 {len(skipped)} 个前言/过短集）")}

    results: list[dict] = []
    total = len(todo)
    done_count = 0
    rlock = asyncio.Lock()

    # 并发拆解全部集。
    # 拆解落库由 routes_v2._BREAKDOWN_DB_LOCK 保证 order/资产不竞态。
    #
    # ⚠️ 2026-10-13 改：这里曾是**硬编码的 `asyncio.Semaphore(6)`**，理由是注释里
    #    一句「防几十集同时打爆 LLM 网关」—— 没有实测标定，且是全项目四处闸门里
    #    **唯一没走配置系统**的那个（image/tts/video 都走 settings）。
    #    实测单集拆解 200-250s，61 集在 6 并发下要排很久。
    #
    #    现在与 image_concurrency / tts_concurrency 同构：默认 0 = **不设上限**，
    #    需要临时限流时设 FW_BREAKDOWN_CONCURRENCY=N。过载保护由 LLMProvider
    #    承担（429 指数退避 + 渠道冷却熔断 + 健康度换渠道），让它自适应真实承载力。
    #    ⚠️ 遵并发铁律：这是**取消上限**，不是降并发；若仍被限流，正确解法是加 KEY。
    # ⚠️ 不设上限时用 `_NoLimit()` 而**不是 None**：`async with None` 会当场
    #    TypeError。`_NoLimit` 与 image/tts 两处闸门是同一个类（见本文件开头），
    #    语义就是"闸门存在但不拦人"，保证 `async with sem:` 的调用点无需分叉。
    _bd_n = max(0, get_settings().breakdown_concurrency)
    sem: asyncio.Semaphore | _NoLimit = (
        asyncio.Semaphore(_bd_n) if _bd_n > 0 else _NoLimit())

    async def one(ch: dict) -> None:
        nonlocal done_count
        async with sem:
            try:
                out = await do_breakdown(ch["content"], model_id,
                                         project_id, episode=ch["order"],
                                         max_chars=max_chars,
                                         shot_cap_sec=shot_cap)
                entry = {"episode": ch["order"], "title": ch["title"],
                         "shots": len(out.shots)}
                # 拆解质量告警必须**逐集上报**（2026-10-13）。
                #
                # 此前拆解的质量问题是**完全静默**的：输出被截断时
                # `_parse_breakdown_json` 只抢救出前几个镜头、后面的剧情全丢，
                # 而 `_salvaged` 标记全代码库无人读取 —— 于是"丢了半集剧情"
                # 和"正常拆完"在日志/UI/库里长得一模一样。用户只能等成片时
                # 发现剧情跳了，且无从归因（这正是多人反馈"丢失剧情"查不出的原因）。
                #
                # `lossy=True` 表示这一集的剧情已经**真丢了**（截断抢救 或 覆盖率
                # 低于门槛），丢掉的内容不会自己回来。单独放一个标志位，
                # 是为了让上游能做"只重拆受损的那几集"这种精确重试。
                if getattr(out, "warnings", None):
                    entry["warnings"] = list(out.warnings)
                if getattr(out, "lossy", False):
                    entry["lossy"] = True
                # ⚠️ 这里**不再**预生成本集提示词（2026-11-19）：镜头脚本由 Muse 在
                # 场景资产出图之后撰写并锁定，拆解只产出镜头行。见本函数文档。
            except Exception as e:  # noqa: BLE001
                entry = {"episode": ch["order"], "title": ch["title"],
                         "error": repr(e)[:200]}
        async with rlock:
            results.append(entry)
            done_count += 1
            results.sort(key=lambda r: r["episode"])
            if on_progress:
                on_progress(done_count, total, results)

    await asyncio.gather(*[one(ch) for ch in todo])

    # 收尾重排：并发下先完成的集先编号，order 会与集序错位（第3集镜头排在第2集前）。
    # 统一按 (episode, 原order) 重排为全项目连续 1..N——镜头轨/导出按 order 消费，
    # 必须与集序一致。ref_overrides/版本等挂在 Shot.id 上不受影响，
    # 但音频/字幕锚点是普通整数 order，必须同步搬迁（见下面 _remap_anchors）。
    with get_session() as session:
        all_shots = (session.query(Shot)
                     .filter(Shot.project_id == project_id)
                     .order_by(Shot.episode, Shot.order).all())
        mapping: dict[int, int] = {}
        for i2, sh in enumerate(all_shots, start=1):
            if sh.order != i2:
                mapping[sh.order] = i2
                sh.order = i2
        # 音频/字幕的 start_shot_order 是普通整数、不是外键，不会跟着走。
        # 不搬的话，增量拆完一集之后所有旁白与字幕整体错位到别的镜头上。
        _remap_anchors(session, project_id, mapping)
        session.commit()
    # 拆解改了 location / link_to_prev → 连续段切分变了，丢掉进程内缓存。
    # （原先由 `_pregen_prompts` 开头顺带做；它删掉之后挪到这里。）
    from .continuity import invalidate_run_cache
    invalidate_run_cache(project_id)

    # ⚠️ 必须在这里先赋值：下面的 `return` 无条件引用它，而赋值的唯一位置在
    #    `if pregen_prompts:` 里面。`pregen_prompts=False` 时就会在**拆解已经
    #    成功之后**抛 NameError —— 用户看到的是一次彻底失败的拆解，而真实原因
    #    跟拆解本身毫无关系。
    #
    #    参数默认 True，当前两个调用方（一键成片、一键拆解）都没传 False，
    #    所以这条 bug 尚未被触发；但参数既然在签名里，就迟早有人传。
    #    防御方式是让**返回值不依赖分支**，而不是删掉这个参数。
    costume: dict | None = None
    if pregen_prompts:
        # ---- 造型识别（2026-10-12，用户裁定：这是拆解的**固定能力**）----
        #
        # 此前它是一条需要用户自己去点的独立任务（桌面端两个按钮，镜流网页端
        # 连按钮都没有）。用户裁定：「造型识别应该是剧本拆解的固定能力，用户拆
        # 剧本时默认跑这个，无需多余操作」。
        #
        # 为什么它必须在拆解之后、出图之前：
        #   · 「🖼 补齐缺失资产（N）」那个 N 是从 `asset_stages` 数出来的。识别
        #     没跑过时 N 只等于"没有定妆图的角色数"，剧本里真正需要的睡衣/婚纱/
        #     西装根本没进过资产表，用户看到的报数不是真实要出的图数。
        #   · 角色名归一只写映射表、不改资产（见 char_alias 的说明），资产层的
        #     合并要在这里补上，否则同一个人仍是多行资产、各出一张脸。
        #
        # ⚠️ **必须挡住在跑的 asset_batch**（2026-10-12）。
        #    `run_stages_draft` 会**删掉所有无图的阶段行再重建**，而 asset_batch
        #    正按 stage_id 往这些行写图 —— 行没了，已生成（已付费）的图就成了
        #    孤儿，用户看到绿勾和空槽位。
        #    这条闸门原本只在 HTTP 入口 `POST /stages/draft` 里（它不经
        #    find_active_job，必须自己挡）；而拆解走的是**函数**不是那个入口，
        #    于是这条新链路绕开了它。`breakdown_all` 与 `asset_batch` 分属
        #    breakdown / assets **两组、可以并发**，所以绕开是真的会同时跑。
        #    与 kill 掉那个 job 相比，跳过识别明显更合理：拆解结果本来就不该被
        #    一个可选优化拖累，用户稍后可再点一次「AI 识别造型」。
        busy = find_active_job("asset_batch", project_id, None)
        if busy:
            log.info("[breakdown] 项目 %s 有批量生图在跑（%s），本次跳过造型识别",
                     project_id, busy)
            costume = {"skipped": "asset_batch_running", "job_id": busy}
        else:
            # ⚠️ **整段失败不能让拆解失败**：拆解结果是用户等了几十秒换来的，
            #    而造型识别失败只是"少了个优化"，退回旧行为（每个角色一张通用图）。
            #    所以这里吞掉所有异常，只记日志 + 在返回值里如实报告。
            try:
                from .routes_v2 import run_stages_draft
                costume = await run_stages_draft(project_id, None, None)
            except Exception as e:  # noqa: BLE001
                log.warning("[breakdown] 造型识别失败（拆解结果照常返回）: %r", e)
                costume = {"error": repr(e)[:200]}

    # ---- 角色形象档案（2026-10-17，用户裁定：挪到拆解末尾）----
    #
    # 此前档案只在「生成资产图」开头才补（`_collect_profiles`），于是出图前
    # 打开提示词预览，骨相/肤色/五官那几层**一定是空的**——用户无法在花钱
    # 出图之前确认"这个人长什么样"，而且生成失败也没人看得见。
    #
    # 结果如实写进拆解的返回（落到 job.result.profiles），缺了谁、为什么，
    # 「要素」页据此显示，并可点「补生成缺失档案」单独重跑（`profile_fill`）。
    # 出图时 `_collect_profiles` 那次仍保留，作为兜底。
    #
    # 不受 asset_batch 闸门约束：档案只补"还没有档案"的角色，从不改已有的；
    # 而 asset_batch 在开头一次性读档案，晚到的档案只是这一批用不上。
    profiles: dict | None = None
    if pregen_prompts:
        try:
            from .character_profile import fill_profiles
            profiles = await fill_profiles(project_id)
        except Exception as e:  # noqa: BLE001 档案是增强项，绝不让拆解失败
            log.warning("[breakdown] 形象档案生成失败（拆解结果照常返回）: %r", e)
            profiles = {"wanted": 0, "generated": 0, "missing": [],
                        "error": repr(e)[:200]}

    # ---- 三种资产的**完整提示词**所需的三份输入（2026-10-20，用户裁定）----
    #
    # 用户的原话：「剧本拆解就生成完整的全部资产的完整提示词」。此前拆解末尾
    # 只做到 造型识别 + 形象档案，而**拼装提示词语句所需要的那三份输入**
    # 一个都没生成：
    #   · 影调档案（`look_profile`）—— `character/scene/prop_prompt` 都吃它；
    #   · 场景描述（`scene_desc`）—— `scene_prompt(description=...)` 的唯一来源；
    #   · 道具描述 —— **此前整个项目都没有生成能力**（见 prop_desc 模块头）。
    # 于是拆解结束后打开「提示词与生成」，看到的是降级口径（只报一个名字），
    # 而"完整提示词"要等到第一次点「一键补全」才出现。用户报的正是这个。
    #
    # 顺序有讲究：
    #   1. 影调**必须最先**——它进三种提示词的每一段，后补就白算一遍；
    #   2. 场景/道具描述互不依赖，但都和影调无关，可以并发跑；
    #   3. 角色档案（brief）必须落库——预览接口读它，不落库就退回现场调 LLM。
    #
    # ⚠️ 全部包在 try 里：这三步是"让结果更好"，**不是**拆解本身。
    #    任何一步失败都只记日志 + 在 result 里如实报告，拆解结果照常返回
    #    （用户等了几十秒换来的是镜头，不能因为一张描述没写成而全废）。
    # ⚠️ 不受 asset_batch 闸门约束：三步都只补"还没有的"，从不覆盖已有值；
    #    而 asset_batch 在开头一次性读场景描述，晚到的描述只是这一批用不上。
    look_report: dict | None = None
    scenes_report: dict | None = None
    props_report: dict | None = None
    briefs_report: dict | None = None
    if pregen_prompts:
        try:
            look_report = {"ok": bool(await _collect_look(project_id))}
        except Exception as e:  # noqa: BLE001
            log.warning("[breakdown] 影调档案生成失败（拆解结果照常返回）: %r", e)
            look_report = {"error": repr(e)[:200]}

        # 场景与道具的描述互不依赖，并发跑。两者内部各自按 default_concurrency
        # 限流（并发铁律：不新增也不下调任何并发数）。
        try:
            scenes_report, props_report = await asyncio.gather(
                ensure_scene_descriptions(project_id),
                ensure_prop_descriptions(project_id),
                return_exceptions=True)
        except Exception as e:  # noqa: BLE001
            log.warning("[breakdown] 场景/道具描述补齐异常（拆解结果照常返回）: %r", e)
        if isinstance(scenes_report, BaseException):
            log.warning("[breakdown] 场景描述失败: %r", scenes_report)
            scenes_report = {"error": repr(scenes_report)[:200]}
        if isinstance(props_report, BaseException):
            log.warning("[breakdown] 道具描述失败: %r", props_report)
            props_report = {"error": repr(props_report)[:200]}

        # 角色人称档案落库：预览接口只读库（见 routers/shotflow.prompt_preview），
        # 不落库的话每个角色第一次打开提示词窗口还得现场调一次 LLM。
        try:
            from .character_brief import fill_briefs
            briefs_report = await fill_briefs(project_id)
        except Exception as e:  # noqa: BLE001
            log.warning("[breakdown] 人物档案落库失败（拆解结果照常返回）: %r", e)
            briefs_report = {"error": repr(e)[:200]}

    return {"episodes": results, "skipped": skipped, "note": None,
            "costume": costume, "profiles": profiles,
            "look": look_report, "scenes": scenes_report,
            "props": props_report, "briefs": briefs_report}


async def run_breakdown_all(jid: str) -> None:
    """拆解 job（一键全部 / 指定集 / 追加剧本共用）。

    payload = {"project_id": "...", "model_id": null, "force": false,
               "episodes": [2,5] | null,     # null=全部；指定集时隐含 force
               "episode_offset": 30,         # 追加剧本时用：集号整体加上偏移
               "script_text": "..."}         # 追加剧本时用：独立剧本文本（不从库读）
    force=false 时跳过已有镜头的集（增量补拆）；进度按集数推进。
    script_text 存在时从它读取剧本（追加剧本），否则从 proj.raw_script 读取。
    走 job 而非同步接口的原因：长集分块后要串多次 LLM 调用（可达数分钟），
    同步接口会撞 nginx proxy_read_timeout 504。

    实现全在 `breakdown_by_episode`（与一键成片共用），这里只做 job 的收发。
    """
    from .db import Project

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    # 追加剧本模式：payload 里带独立的 script_text，不从库读
    script_text = p.get("script_text")
    if script_text:
        raw = script_text
    else:
        with get_session() as session:
            proj = session.get(Project, project_id)
            if not proj:
                _update(jid, status="failed", error=f"项目不存在: {project_id}")
                return
            raw = proj.raw_script
        if not raw:
            _update(jid, status="failed", error="项目没有剧本，请先导入")
            return

    _update(jid, status="running", progress=1)

    def _progress(done: int, total: int, results: list[dict]) -> None:
        _update(jid, progress=max(1, int(done / total * 100)),
                result=json.dumps({"episodes": results}, ensure_ascii=False))

    try:
        out = await breakdown_by_episode(
            project_id, raw, p.get("model_id"),
            episodes=p.get("episodes"), force=bool(p.get("force")),
            video_model=p.get("video_model"), on_progress=_progress,
            episode_offset=p.get("episode_offset", 0))
    except Exception as e:  # noqa: BLE001
        _update(jid, status="failed", error=repr(e)[:300])
        return

    results = out["episodes"]
    failed = [r for r in results if "error" in r]
    _update(jid,
            status="failed" if results and len(failed) == len(results) else "done",
            progress=100,
            # 跳过的前言/过短集随最终结果一起回报（C1）：拆解本身成功，
            # 但用户需要知道"为什么第 N 集没有镜头"，否则只会以为是漏拆了
            result=json.dumps({k: v for k, v in out.items() if v is not None},
                              ensure_ascii=False),
            error=_brief_errors(failed) if failed else None)


async def _collect_briefs(project_id: str, rd: dict,
                          model_id: str | None = None) -> dict[str, dict]:
    """收集本次要出图的角色的人物档案（性别/年龄段/身份），供定妆照提示词使用（Q1）。

    ## 为什么按"角色首次出场集"取

    `character_brief` 是**按集**缓存的，而资产图是**全剧共用**的——同一个角色的
    性别与年龄段不会因集数而变（真会变的"少年→中年"属于不同造型阶段，
    由 stage 的 description 区分）。所以每个角色只需取一次：用它**首次出场的那一集**，
    那一集的剧本片段一定包含足够判定其性别身份的上下文。

    这样 N 个角色最多触发 M 次纯文本调用（M = 涉及的不同集数，且 brief 本身
    还有进程内缓存），不会因为角色多就线性放大开销，也不额外花生图的钱。

    任何一集失败都不阻断——拿不到档案就退回"只有造型描述"的旧行为，
    不能让人物档案的问题挡住整条出图链路。
    """
    from .character_brief import character_brief

    # 角色 → 最小集号（stages_no_image 带 ep_from，chars_no_asset 带 episodes 列表）
    first_ep: dict[str, int] = {}
    for row in rd["assets"].get("stages_no_image", []):
        n = row.get("character_name")
        ep = row.get("ep_from") or 1
        if n and (n not in first_ep or ep < first_ep[n]):
            first_ep[n] = ep
    for row in rd["assets"].get("chars_no_asset", []):
        n = row.get("name")
        eps = row.get("episodes") or [1]
        ep = min(eps) if eps else 1
        if n and (n not in first_ep or ep < first_ep[n]):
            first_ep[n] = ep

    if not first_ep:
        return {}

    merged: dict[str, dict] = {}
    for ep in sorted(set(first_ep.values())):
        try:
            brief = await character_brief(project_id, ep, model_id)
        except Exception as e:  # noqa: BLE001 档案拿不到就退回旧行为
            log.warning("[briefs] 第 %s 集人物档案获取失败，该集角色退回无档案: %r", ep, e)
            continue
        for name, info in (brief or {}).items():
            # 只收本轮真正要出图、且首次出场正是这一集的角色
            if first_ep.get(name) == ep and name not in merged:
                merged[name] = info
    log.info("[briefs] 为 %d/%d 个待出图角色取到人物档案",
             len(merged), len(first_ep))
    # 顺手落库（2026-10-20）：这份档案原本只活在内存里，`prompt_preview`
    # 另算一遍（旧实现在 HTTP 请求里同步调 LLM，nginx 300s 直接 504）。
    # 出图时既然已经算出来了，就钉到资产行上——预览、下一次出图都读它。
    # 失败不影响出图（save_briefs 自己吞异常写日志）。
    if merged:
        try:
            from .character_brief import save_briefs
            save_briefs(project_id, merged)
        except Exception as e:  # noqa: BLE001 落库失败只是预览慢，不该挡出图
            log.warning("[briefs] 人物档案落库失败（本次出图不受影响）: %r", e)
    return merged


def _look_line(project_id: str) -> str:
    """读该项目影调档案并拼成一句话；没有档案返回空串（= 改动前口径）。

    首帧图与场景基准帧走这条**同步**读取，而不是把 `look` 一路当参数传下来：
    `_gen_first_frame` / `_ensure_scene_anchor` 的调用点有六处（批量首帧、
    run_shot_videos、重生成、锚点预热……），逐个加参数必然漏掉一两处，
    而漏掉的那条路径出的图就是"没影调"的——正是本次要修的病症。
    从库里读则**没有漏的可能**：只要 `_collect_look` 在批次入口写过，
    所有下游都拿到同一份。

    读的是一行 SQLite（项目行的一列），每镜一次的开销可忽略；
    且与 `asset_prompt` 用的是**同一份档案**，资产图与成片影调必然对齐。
    """
    try:
        from . import look_profile as lp
        return lp.phrase(lp.load(project_id))
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        log.warning("[look] 读取影调档案失败，本图退回无影调提示词: %r", e)
        return ""


def _style_of(project_id: str):
    """读该项目的**画风预设**（`style_preset.Style`）。永不失败，兜底都市档。

    与 `_look_line` 同款的同步读库，理由也相同、且更强烈：画风的注入点比影调
    还多（首帧句、场景基准图句、视频提示词、五处资产图），把 `style` 一路当
    参数传下去必然漏，而漏掉的那条路径出的图就是"画风没生效"的——动漫剧里
    突然冒出一张实拍照，比没影调刺眼得多。

    ⚠️ 画风**不是一个前缀**：`Style` 同时带着与前缀同向的否定项、首帧句、
    基准图句与质感词。只换前缀会与残留的「禁止动漫」自相矛盾，见 style_preset 模块头。
    """
    from . import style_preset as sp
    return sp.load(project_id)


async def _collect_look(project_id: str) -> dict | None:
    """取（必要时生成）全片**影调档案**，供所有资产图/首帧提示词使用。

    与 `_collect_profiles` 同款语义：只补缺的，绝不覆盖已有档案
    （尤其 `status=confirmed` 的——用户手调过的影调比 AI 猜的金贵）。
    失败返回 None，`asset_prompt` 自动不拼影调句 = 改动前行为。

    用户 2026-09-09 反馈「不同图片画面色调不统一」的**主要**修法：
    此前提示词里一个字的影调约束都没有，每张图各自决定一套色温/反差/饱和。
    """
    from . import look_profile as lp
    try:
        return await lp.ensure(project_id)
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        log.warning("[look] 影调档案获取失败，本轮退回无影调提示词: %r", e)
        return None


def ensure_prop_asset(session, project_id: str, name: str):
    """拿到 (project_id, kind='prop', name=name) 的资产行，没有就建。调用方负责 commit。

    与 `scenes.ensure_location_asset` 的分工：场景那边要认领老项目按原名建的行
    并改名（一个房间只能有一行），道具没有这回事 —— 拆解写进 `Shot.props` 的
    名字就是建资产时用的名字，两边同源，不会出现"同一个道具两个写法"的历史包袱。
    但**仍按 kind 限定查询**，否则道具「林晨」会认领到角色「林晨」那一行。

    ## ⚠️ 同名只剩墓碑行时**认领它，绝不新建**（2026-10-27）

    此前这里只查 `deleted_at IS NULL`，查不到就新建一行 —— 于是"用户删掉一件
    道具"会变成"库里多出一行同名资产"，也就是 B 行在用 + A 行墓碑。

    那个状态是有毒的：`asset_gate.deleted_names` 有一条**刻意**的规则，
    同名还有在用行时不算删过（见它的 docstring，合并功能逼出来的）。
    被自己新建的这行一撞，这次删除就**永久失效**了 —— 墓碑还在、恢复入口还在，
    但注入链路再也认不出"用户删过它"。实测：dev 项目 1017 删掉「手机」后
    跑一次补全，`deleted_names` 里就没有「手机」了，参考图回到每一镜。

    对照 `scenes.location_asset`：它**不过滤墓碑**，所以场景侧从来造不出
    同名的第二行，也就从来没踩到这个坑。这里对齐它 —— 找到墓碑行就返回它，
    **不清 `deleted_at`**（返回一个仍然已删除的行，调用方写进去的 image_url /
    desc_auto 都落在这行上，但它在注入与列表里依旧是删掉的）。
    "删掉的东西不复活"这条语义保持不变，只是不再制造同名的第二行。
    """
    import uuid as _uuid

    from .db import Asset
    base = (session.query(Asset)
            .filter(Asset.project_id == project_id, Asset.kind == "prop",
                    Asset.name == name))
    a = base.filter(Asset.deleted_at.is_(None)).first()
    if a is None:
        # 有墓碑行就认领它（见 docstring）：宁可返回一个已删除的行，
        # 也不能让它变成"一行墓碑 + 一行在用"。
        a = base.first()
    if a is None:
        a = Asset(id=_uuid.uuid4().hex[:12], project_id=project_id,
                  kind="prop", name=name)
        session.add(a)
    return a


def _prop_items(session, project_id: str, title: str, names: list[str],
                look: dict | None) -> list[dict]:
    """把「缺图的道具名」摊成生图条目（每件 1 张）。

    与 `_scene_view_items` 并列为资产补全的入口，但**刻意简单得多**：
    道具不做多视角（理由见 `asset_prompt._PROP_REQUIREMENTS_FMT`），
    一件道具一张图，形制定死。

    ⚠️ 每条都带 `asset_id`。批量出图回写时按 id 精确落库，**不走"按名字找行"**
    那条兜底（见 run_asset_batch 里 `plain` 那段）—— 名字可能跨 kind 撞车，
    「林晨」既是角色名也可能是道具名，按名字找会把角色定妆图覆盖成道具图。

    ⚠️ **墓碑在这里再拦一次**（2026-10-27）。readiness 那边已经不再把已删除
    的道具算进缺口了，但本函数还有两个绕过它的调用点：一键成片与首帧流水线
    都是拿**任务开始时的** `rd` 快照调的，用户完全可能在那之后才删掉这件道具。
    而在本函数出一张图的代价是真金白银，不是"多显示一行"。所以按 id 判一次，
    而不是靠上游那一处减法兜住全部路径。
    """
    items: list[dict] = []
    for name in names:
        a = ensure_prop_asset(session, project_id, name)
        session.commit()
        if a.deleted_at:
            # 认领到的是墓碑行（用户在盘点之后删的，或同名只剩墓碑）：
            # 不出图、不占条数。恢复之后下次补全自然会带上它。
            log.info("[props] 跳过已删除的道具「%s」（项目 %s，asset=%s）",
                     name, project_id, a.id)
            continue
        items.append({
            "name": f"道具-{name}",
            "asset_id": a.id,
            "prompt": prop_prompt(name, description=desc_of(a),
                                  title=title, look=look,
                                  style=_style_of(project_id)),
        })
    return items


def _scene_view_items(session, project_id: str, title: str, names: list[str],
                      look: dict | None) -> list[dict]:
    """把「缺图的场景名」摊成**多视角参考图**的生图条目（8 张/场景）。

    唯一定义处 —— 一键成片与首帧流水线两条入口共用。
    （`asset_prompt` 模块头记过教训：这类拼装散落成两份拷贝，就一定会
    "一键成片修好了、首帧流水线还是老样子"，且两条路产出的图不一致。）

    每个场景补齐 8 行 `SceneView`（`scene_view.ensure_views` 幂等，
    会**认领**老项目已有的那张 `Asset.image_url` 当主视角，不重复花钱），
    只为**没有图的**视角建条目。所以：
    · 全新场景 → 8 条；
    · 老项目已有一张图的场景 → 7 条（主视角被认领）；
    · 已经齐了的场景 → 0 条。

    调用方负责 commit。
    """
    from .scenes import ensure_location_asset
    items: list[dict] = []
    for name in names:
        # run_asset_batch 按 scene_view_id 回写；没有资产行就等于生成了写不进去。
        # 拆解只往 Shot.location 落名字，未必建过资产行，这里补建；
        # 老项目里那行按原名建的资产会被就地改名认领，而不是另起一行。
        a = ensure_location_asset(session, project_id, name)
        session.commit()
        items += scene_view_items_for_asset(session, a, title, look)
        session.commit()
    return items


def scene_view_items_for_asset(session, asset, title: str, look: dict | None,
                               view_keys: list[str] | None = None) -> list[dict]:
    """一个场景资产 → 多视角参考图的生图条目。**提示词只在这里拼**。

    `view_keys`：
      · None/空 → 只补**还没有图**的视角（批量补资产、一键成片走这条）；
      · 给了 key → 无论有没有图都重画这几张（资产弹窗「重画这一张」走这条）。

    调用方负责 commit。`session` 里的 `SceneView` 行会被 `ensure_views` 幂等补齐。
    """
    from . import scene_view as sv
    rows = sv.ensure_views(session, asset)
    if view_keys:
        want = set(view_keys)
        rows = [r for r in rows if r.view_key in want]
    else:
        rows = [r for r in rows if not (r.image_url or "").strip()]
    desc = desc_of(asset)
    # 画风就地读库，不从调用方传：本函数有两个入口（一键成片/批量补资产走
    # `_scene_view_items`，资产弹窗「重画这一张」走 routes_v2），
    # 加参数就得两处都记得传，漏一处那条路径出的图就没画风。
    style = _style_of(asset.project_id)
    out: list[dict] = []
    for row in rows:
        v = sv.BY_KEY[row.view_key]
        out.append({
            "name": f"场景-{asset.name}（{v.label}）",
            "scene_view_id": row.id,
            "scene_asset_id": asset.id,
            "primary": v.primary,
            "prompt": scene_prompt(asset.name, description=desc, title=title,
                                   view=v.phrase, view_label=v.label,
                                   look=look, style=style),
        })
    return out


async def _collect_profiles(project_id: str, rd: dict,
                            model_id: str | None = None) -> dict[str, dict]:
    """收集本次要出图的角色的**形象档案**（骨相/肤色/五官/气质），供定妆照提示词使用。

    与 `_collect_briefs` 的分工见 `character_profile` 模块开头：
    brief 管"人称与年龄"（按集判、进程内缓存），档案管"长什么样"（全剧一份、落库）。

    只补缺的：已有档案的角色一律跳过——档案定下来就等于这张脸定下来了，
    不该被下一次点击悄悄改掉。重生成走用户显式操作。

    失败不阻断：拿不到档案，`character_prompt` 少掉"骨相五官"那几层，
    构图/背景/光线/镜头/标注/兜底照常给。
    （2026-09-21 P0-1 前不是这样：那时会**整段退回**一条 158 字的扁平口径，
    连构图句和纯白背景都没有。现在档案只决定"这张脸长什么样"。）
    """
    from .character_profile import ensure_profiles

    names: list[str] = []
    for row in rd["assets"].get("stages_no_image", []):
        n = row.get("character_name")
        if n and n not in names:
            names.append(n)
    for row in rd["assets"].get("chars_no_asset", []):
        n = row.get("name")
        if n and n not in names:
            names.append(n)
    if not names:
        return {}
    try:
        profiles = await ensure_profiles(project_id, names, model_id)
    except Exception as e:  # noqa: BLE001 档案是增强项，绝不阻断出图
        log.warning("[profiles] 形象档案获取失败，本轮退回无档案提示词: %r", e)
        return {}
    log.info("[profiles] 为 %d/%d 个待出图角色取到形象档案",
             sum(1 for n in names if n in profiles), len(names))
    return profiles


# ⚠️ 这里原有 `_pregen_prompts`（拆解后逐镜预生成提示词）与 `run_reprompt`
# （「重新生成提示词」任务）两个函数，2026-11-19 整体删除：镜头脚本改由 Muse
# 撰写并锁定（`agent/tools_write.set_shot_prompt(s)`），镜流不再用文本模型写镜头提示词。
# `reprompt` 这个 job kind 随之下线，见文件末尾的 `RETIRED_KINDS`。


#: 中文 TTS 的语速上限（字/秒）。实测同批 78 段旁白：中位 5.78、最高 6.7；
#: 人声播报的物理极限约 10-12。取 15 是为了**只抓不可能的值**，
#: 不误伤"这段念得比较快"。
_TTS_MAX_CPS = 15.0
#: 太短的文本比值噪声大（2 个字 0.2s 完全正常），不参与判定
_TTS_MIN_CHARS = 8


def _tts_truncated(text: str, dur: float) -> bool:
    """TTS 返回的音频是不是被截断了。

    ⚠️ 这一层此前**不存在**：provider 返回什么就落什么，`status` 直接写 `done`。
    实测出现过 **87 字 / 1.056s（82.4 字每秒）** 的返回——文件真的只有 12KB，
    里面只念了开头一两个字。

    它的破坏力不止于旁白本身：紧接着 `_sync_shot_duration` 会拿这个时长去改
    `Shot.duration_sec`，于是**画面也被缩成 1.5s**，再照这个长度把视频生成出来。
    等能看出不对的时候，错的已经是成片，而且全程没有任何报错——
    旁白是 `done`、镜头是 `adopted`。

    只判"短得不可能"这一侧：长得离谱通常是 provider 补了静音尾巴，
    有 `shot_seconds_cap` 钳着，危害小得多。
    """
    t = (text or "").strip()
    if len(t) < _TTS_MIN_CHARS or dur <= 0:
        return False
    return len(t) / dur > _TTS_MAX_CPS


async def run_tts_batch(jid: str) -> None:
    """P2-4 TTS 批量合成：payload={"project_id", "clip_ids":[...]}。

    串行逐段合成（单段约 60-70s；RunningHub 单 KEY 串行最稳），每段完成即落库
    url/duration/status，前端轮询 audio-clips 逐段点亮。参考音色同批只上传一次
    （按 voice_ref_url 分组缓存 fileName）。
    """
    from .db import AudioClip
    from .media import probe_duration_local
    from .providers.tts import TTSProvider

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    clip_ids = p.get("clip_ids") or []

    provider = TTSProvider()
    if not provider.available:
        _update(jid, status="failed", error="TTS 未配置（缺 RunningHub key/工作流）")
        return

    with get_session() as session:
        q = (session.query(AudioClip)
             .filter(AudioClip.project_id == project_id,
                     # narration = 解说剧按剧本切出来的旁白，与手工 tts 走同一条合成链
                     AudioClip.kind.in_(("tts", "narration"))))
        if clip_ids:
            q = q.filter(AudioClip.id.in_(clip_ids))
        else:
            q = q.filter(AudioClip.status.in_(("pending", "failed")))
        rows = q.all()
        # ---- 音色回退：段上没有就取项目上的（2026-10-28 生产事故）----
        #
        # `AudioClip.voice_ref_url` 只在**建段那一刻**写一次（`generate_narration`
        # 从 `Project.narration_voice_url` 取）。而实际使用顺序几乎总是
        # 「先点切分旁白 → 才发现没配音色 → 再上传音色」：
        #   音色留在项目上，2091 段旁白的 `voice_ref_url` 却全是空，
        #   合成时读到空串就抛「未选择参考音色」，上传多少次都没用。
        # 生产实测：全库 narration 段 2091 条，`voice_ref_url` 非空 **0** 条，
        # 合成成功 **0** 条 —— 这条链在"先切分后配音色"的顺序下从来没通过。
        #
        # 所以合成这一层必须能回退到项目音色。因为解说剧整片共用一个解说声，
        # 这个回退没有歧义：项目音色就是这些旁白该用的音色。
        # 读到之后**顺手写回该段**：下一次不必再回退，界面上也能看到它带了哪个音色。
        proj = session.get(Project, project_id)
        proj_voice = ((proj.narration_voice_url or "").strip()
                      if proj is not None else "")
        backfilled = 0
        plan: list[tuple[str, str, str]] = []
        for a in rows:
            v = (a.voice_ref_url or "").strip()
            if not v and proj_voice and a.kind == "narration":
                v = proj_voice
                a.voice_ref_url = proj_voice
                backfilled += 1
            plan.append((a.id, a.text or "", v))
        if backfilled:
            session.commit()
            log.warning("[tts %s] %d 段旁白没有自带音色，已回退用项目解说音色并写回",
                        jid, backfilled)

    if not plan:
        _update(jid, status="done", progress=100,
                result=json.dumps({"clips": [], "note": "没有待合成的旁白"},
                                  ensure_ascii=False))
        return

    _update(jid, status="running")
    # 参考音色缓存：同一素材同批只上传一次
    ref_cache: dict[str, str] = {}
    results: list[dict] = []

    def _set(cid: str, **fields) -> None:
        with get_session() as session:
            a = session.get(AudioClip, cid)
            if a:
                for k, v in fields.items():
                    setattr(a, k, v)
                session.commit()
                # P2-5 SSE：旁白段状态（generating/done/failed）实时点亮
                publish(a.project_id, "audio", {"id": cid, "status": a.status})

    def _sync_shot_duration(cid: str, dur: float) -> str | None:
        """解说剧：用旁白实际时长驱动镜头时长，声画才能同步。

        只对 kind="narration" 生效——那是照剧本切出来的解说词，
        画面本来就是给旁白配的，旁白多长画面就该多长。
        手工加的 tts 旁白不动镜头（用户是往既有画面上叠旁白，不是反过来）。

        写的是 Shot.duration_sec（AI 拆镜判定的时长），视频生成时以它为目标。
        已经出过片的镜头会被标 stale——时长变了，旧视频对不上新旁白，需重出。

        ⚠️ 必须钳上限：切分阶段已按估算控过长度，但估算会偏
        （语速受标点/数字/语气词影响）。不钳的话一段估错的旁白就能写出
        35s 的镜头，视频生成必爆显存——实测已发生。
        钳掉的部分旁白会比画面长，导出时尾部旁白盖在下一镜上，
        比整批生成失败可接受得多。

        返回被改动的镜头 id，未改动返回 None。
        """
        from .db import Shot, Project
        if dur <= 0:
            return None
        with get_session() as session:
            a = session.get(AudioClip, cid)
            if not a or a.kind != "narration" or not a.source_shot_id:
                return None
            shot = session.get(Shot, a.source_shot_id)
            if not shot:
                return None
            # 上限跟着**项目分辨率 + 视频模型**走，与拆镜阶段同源（同一个函数）：
            # 0.5MP 允许 38s 的长镜，若这里仍按固定 12s 钳，
            # 拆镜精心留出的长镜会被硬砍成 12s，旁白大段盖到下一镜。
            proj = session.get(Project, shot.project_id)
            cap, _mp = shot_seconds_cap(profile_of(proj))
            # 留 0.4s 尾巴：旁白结束瞬间就切镜听感太赶
            target = round(min(dur + 0.4, cap), 2)
            if abs((shot.duration_sec or 0) - target) < 0.05:
                return None            # 已经对上了，别白标 stale
            shot.duration_sec = target
            if shot.video_url:
                # 时长变了，已有视频与新旁白对不上，标记待重生成。
                # regen = 最轻一档：画面依据（script_ref）一个字没变，
                # 提示词照用，重出片即可。mark_stale 只升不降，所以如果这镜
                # 本来因改剧本挂着 rebreak/reprompt，不会被这一下悄悄降级。
                stale_mod.mark_stale(shot, stale_mod.REGEN)
            session.commit()
            return shot.id

    retimed: list[str] = []
    done_n = 0
    # 参考音色上传要串行化：多个任务同时发现"缓存里没有"会各传一遍同一个文件，
    # 白白多花几十秒还可能拿到不同的 fileName。用锁把首次上传收敛成一次。
    ref_lock = asyncio.Lock()

    async def _ensure_ref(ref_url: str) -> str:
        if ref_url in ref_cache:
            return ref_cache[ref_url]
        async with ref_lock:
            if ref_url in ref_cache:      # 等锁期间别人可能已经传好了
                return ref_cache[ref_url]
            local = await _resolve_media_local(ref_url)
            if local is None:
                raise RuntimeError(f"参考音色不在本地: {ref_url}")
            ref_cache[ref_url] = await provider.upload_ref_voice(local)
            return ref_cache[ref_url]

    async def _one(cid: str, text: str, ref_url: str) -> None:
        nonlocal done_n
        try:
            # 取消检查点（2026-10-15 补）。配音是 gather 一次性派发的，
            # 入口检查在第一轮事件循环就全过了 —— 必须在这里（每段开始前）
            # 再查一次，否则"取消"只改状态位、合成照跑照计费。
            if is_cancelled(jid):
                return
            if not ref_url:
                raise RuntimeError("未选择参考音色（先在素材池上传一段人声）")
            name = await _ensure_ref(ref_url)
            _set(cid, status="generating", error=None)
            # 闸门只圈住真正打远端的那一段；落库/探时长不占并发额度
            async with _tts_gate():
                url = await provider.synth(name, text)
            dur = await probe_duration_local(url)
            # 截断兜底（见 _tts_truncated）：重合成一次，仍然截断就当失败。
            # 宁可这一段留 failed 让用户看见并重试，也不能把 1 秒的旁白
            # 当成 done —— 那会顺手把镜头时长也改错，然后照错的长度出片。
            if _tts_truncated(text, dur):
                async with _tts_gate():
                    url2 = await provider.synth(name, text)
                dur2 = await probe_duration_local(url2)
                if _tts_truncated(text, dur2):
                    raise RuntimeError(
                        f"TTS 返回的音频明显短于文本（{len(text.strip())} 字 / "
                        f"{dur2:.2f}s = {len(text.strip()) / max(dur2, 1e-6):.1f} 字每秒，"
                        f"上限 {_TTS_MAX_CPS}），重合成一次后仍然如此")
                url, dur = url2, dur2
            # 6.9：重新合成 = **换素材**，修剪窗口必须一起清掉。
            # 窗口 [clip_in_sec, +clip_dur_sec) 是相对某一个具体 url 的坐标，
            # 新旁白长度不同，旧坐标就指向了另一段内容 —— 用户把旁白剪成
            # "第 2.4s 起的 3s"、改了文本重合成、新音频只有 2.6s，导出就
            # `-ss 2.4 -t 3` 取到一段空白，而时间轴上仍然显示 3s。
            # 与 db.py `reset_clip_window` 是同一个道理、同一类静默损坏。
            _set(cid, url=url, duration=dur, status="done",
                 clip_in_sec=None, clip_dur_sec=None)
            changed = _sync_shot_duration(cid, dur)
            if changed:
                retimed.append(changed)
            results.append({"id": cid, "url": url, "duration": dur})
        except Exception as e:  # noqa: BLE001
            # human_error 而非 repr（见 err_text 模块头）：用户看到的是
            # `RuntimeError('...')` 那种 Python 字面量、读不懂也不知道找谁。
            _msg = human_error(e, 300)
            _set(cid, status="failed", error=_msg)
            results.append({"id": cid, "error": _msg})
        finally:
            done_n += 1
            _update(jid, progress=int(done_n / len(plan) * 100),
                    result=json.dumps({"clips": results}, ensure_ascii=False))

    # 并发合成：各段互不依赖，串行只是白等（一集几十段 × 60s 就是一小时）。
    # 单段失败不牵连其他段——_one 内部已吞异常并落 failed 状态。
    await asyncio.gather(*(_one(cid, text, ref) for cid, text, ref in plan))

    failed = [r for r in results if "error" in r]
    _update(jid,
            status="failed" if len(failed) == len(plan) else "done",
            result=json.dumps({"clips": results, "retimed_shots": retimed},
                              ensure_ascii=False),
            error=_brief_errors(failed) if failed else None)


async def _resolve_media_local(url: str):
    """/fw/media/... → 本地 Path；参考音色是视频时抽音轨转 wav 再上传。

    ## 为什么必须是 async（2026-09-11 修 B1）

    这里原来用的是同步 `subprocess.run(ffmpeg, timeout=120)`。它跑在
    `_ensure_ref` 里，而 `_ensure_ref` 是 async ——**同步 subprocess 会把整个
    事件循环钉住**。后端是单进程 asyncio，那 120 秒里：所有 HTTP 请求排队、
    SSE 全部静默、其他并发任务集体暂停。用户看到的是"第一次用某段视频当参考
    音色，整个网站卡死两分钟"，而且因为没有任何报错，只会以为是网络问题。

    改用 `media._run`（`asyncio.create_subprocess_exec` + `wait_for`）：
    同样带超时、超时同样 kill 子进程，但等待期间事件循环照常跑。

    ## 派生 wav 落 generated/ 而不是源文件旁边（N2）

    原来是 `p.with_suffix(".refvoice.wav")` —— 落在 `uploads/`、且是**后缀**。
    两个后果：
      · `_scan_generated_orphans` 只扫 `GENERATED_DIR`，所以它**永远回收不掉**；
      · 就算去扫 uploads，那里放的是用户上传的原件，误删代价完全不同。
    改落 `generated/refvoice_<源文件 id>.wav` 后，它变成一个和缩略图同性质的
    **可重建派生缓存**：不落任何库、必然被认成孤儿、24h 后自动回收，
    下次要用再花几秒重抽。文件名带源 id 是为了排障时能一眼看出它来自谁。
    """
    from .media import GENERATED_DIR, ensure_local_async, _run
    p = await ensure_local_async(url)
    if p is None or not p.is_file():
        return None
    if p.suffix.lower() in (".mp4", ".mov", ".mkv", ".webm"):
        # 视频素材：抽前 15s 音轨为 wav（IndexTTS 参考音色 15s 内即可）
        wav = GENERATED_DIR / f"refvoice_{p.stem}.wav"
        if not wav.is_file():
            code, out = await _run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(p), "-t", "15",
                 "-vn", "-ar", "44100", "-ac", "1", str(wav)], timeout=120.0)
            if code != 0 or not wav.is_file():
                log.warning("[tts] 参考音色抽音轨失败 code=%s: %s", code, out[-300:])
                return None
        return wav
    return p


# ⚠️ 这里原有 `run_first_frames`（批量出首帧）与 `run_first_frame_pipeline`
# （「🚀 一条龙」：资产 → 全部首帧 → 全部片段）两个任务，2026-11-20 整体删除：
# 首帧 / 首尾帧 / 尾帧三种生成模式下线，出片统一走全能参考（`run_shot_videos`），
# 整片出片走 `run_one_click_film`。两个 job kind 随之下线，见文件末尾的 `RETIRED_KINDS`。


async def run_asset_candidates(jid: str) -> None:
    """资产候选图生成（资产弹窗「✨ 生成」）：payload=
    {"project_id","kind","name","stage_id"?,"prompt","model_id","size","n",
     "ref_urls"?,"use_char_ref","exclude_url"?}

    为什么是 job 而不是同步接口：候选图要生 1-4 张、几十秒到一分多钟，
    而弹窗点一下外面就关了。原来的同步实现里候选只活在组件 state 里——
    窗一关，图已经落盘、钱已经花了，UI 却再也找不回来（用户实测反馈）。
    走 job 后进度与结果都在库里，关窗再开照样能挑。

    **不落库到资产上**：候选就是候选，只有用户点选那一张才写
    AssetStage.image_url / Asset.image_url（走既有的 PATCH 接口）。
    """
    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    prompt = (p.get("prompt") or "").strip()
    if not prompt:
        _update(jid, status="failed", error="缺少提示词")
        return

    # 参考图：显式传的优先；否则按角色自动找已有定妆图（同一张脸）。
    # 与 run_asset_batch / POST /v2/assets/generate 共用 character_base_ref。
    refs = list(p.get("ref_urls") or [])
    if not refs and p.get("use_char_ref", True) and p.get("kind") == "character" and project_id:
        from .asset_ref import character_base_ref
        with get_session() as session:
            base = character_base_ref(
                session, project_id, p.get("name") or "",
                exclude_stage_ids={p["stage_id"]} if p.get("stage_id") else None,
                exclude_url=p.get("exclude_url"))
        if base:
            refs = [base]

    _update(jid, status="running", progress=5)
    # 条目显式模型 > 项目里给这一类配的模型 > 平台默认（2026-10-21）
    _m = p.get("model_id")
    if not _m and project_id and p.get("kind"):
        with get_session() as _s:
            _m = _category_image_model(_s.get(Project, project_id), p.get("kind"))
    provider = ImageProvider(model_id=_m)
    try:
        urls = await provider.generate(prompt, size=_size_for_kind(p.get("kind"), p.get("size") or "1024x1024"),
                                       n=max(1, min(int(p.get("n") or 1), 4)),
                                       ref_urls=refs or None)
    except Exception as e:  # noqa: BLE001
        # 审核拒绝要能被前端识别（重试无用，得改词/换模型），与同步接口同口径
        from .providers.image import ContentRejected
        reason = "moderation" if isinstance(e, ContentRejected) else "channel"
        _update(jid, status="failed",
                error=json.dumps({"reason": reason, "message": str(e)[:300]},
                                 ensure_ascii=False))
        return

    if not urls:
        _update(jid, status="failed", error=json.dumps(
            {"reason": "empty", "message": "模型未返回图片"}, ensure_ascii=False))
        return

    _update(jid, status="done", progress=100, result=json.dumps({
        "urls": urls,
        "ref_used": refs[0] if refs else None,
        # 目标身份：重开弹窗时据此判断"这批候选是不是这张资产的"
        "target": {"kind": p.get("kind"), "name": p.get("name"),
                   "stage_id": p.get("stage_id")},
        "prompt": prompt,
    }, ensure_ascii=False))


async def run_image_generate(jid: str) -> None:
    """**自由生图**（镜流的「生图」页）：产出一批图，**不挂到任何资产上**。

    payload = {"project_id","prompt","model_id"?,"size"?,"n"?,"ref_urls"?}

    ## 与 `asset_candidates` / `asset_generate` 的区别（三个别合并）

    | runner | 目的 | 落库 |
    |---|---|---|
    | `asset_candidates` | 给某个资产挑候选，选中才写回 | 不落目标 |
    | `asset_generate` | 就生这一个资产的图，**生成即写回** | 写 Asset/AssetStage |
    | `image`（本函数） | 用户自己出图看 / 下载 / 当素材用 | 谁都不写，只有 job 行 |

    不写目标表是有意的：生图页是"到处试"的地方，试出来的图不该自动变成项目里的
    角色或场景——那会把资产库塞满没人认领的图，而且下次出片时它们会被当成
    参考图候选，把画面带偏。要复用，用户自己去资产库手动传/挂。

    ⚠️ 结果 URL 只活在 job.result 里（与候选图同理），所以**必须有地方读回来**：
    `GET /v2/projects/{pid}/image-jobs`。没有那个列表，图落盘、钱花掉、UI 找不回。
    """
    from .providers.image import ContentRejected, ImageProvider

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    prompt = (p.get("prompt") or "").strip()
    if not prompt:
        _update(jid, status="failed", error="缺少提示词")
        return

    size = p.get("size") or "1024x1024"
    n = max(1, min(int(p.get("n") or 1), 4))     # 与同步接口同上限：再多用户要等到超时
    refs = [u for u in (p.get("ref_urls") or []) if u][:9]

    _update(jid, status="running", progress=5)
    provider = ImageProvider(model_id=p.get("model_id"))
    try:
        urls = await provider.generate(prompt, size=size, n=n, ref_urls=refs or None)
    except Exception as e:  # noqa: BLE001
        # 审核拒绝要能被前端区分：重试无用（同一提示词判定一致），得改词或换模型。
        reason = "moderation" if isinstance(e, ContentRejected) else "channel"
        _update(jid, status="failed", error=json.dumps(
            {"reason": reason, "message": str(e)[:300]}, ensure_ascii=False))
        return
    if not urls:
        _update(jid, status="failed", error=json.dumps(
            {"reason": "empty", "message": "模型未返回图片"}, ensure_ascii=False))
        return
    _update(jid, status="done", progress=100, result=json.dumps({
        "urls": urls,
        # 生成参数原样回带：列表要显示"这张是什么尺寸/什么模型出的"，
        # 而「再来一批」要把参数填回控制台——省掉前端再解析一次 payload。
        "prompt": prompt, "model_id": provider.model_id, "size": size, "n": n,
        "ref_used": refs, "kind": "image",
    }, ensure_ascii=False))


def asset_prompt_for(session, project_id: str, kind: str, name: str,
                     stage_id: str | None = None) -> dict | None:
    """**这件资产/造型现在该用的生图提示词**。唯一实现。

    返回 `{"prompt", "target", "stage_id"?, "asset_id"?, "reused_from"?}`；
    目标不存在时返回 `None`（调用方决定是 404 还是 failed）。

    ## 为什么必须只有这一处

    2026-10-23 生产实测：agent 反复报「缺少提示词」，`asset_generate` 的
    payload 里**根本没有 prompt 字段** —— `run_asset_generate` 只传了
    `kind + name`，而拼装逻辑只存在于「资产弹窗生图」那条前端链路里
    （前端拼好整段提示词、当参数传上来）。于是同一个动作有两条路：
    人手点能出图，agent 一点就死在 `if not prompt: 缺少提示词`。

    拼装散成两份拷贝的老教训在 `asset_prompt` 模块头记过：一定会
    "一键成片修好了、首帧流水线还是老样子"，而且两条路产出的图不一致。

    ## 与 `routers/shotflow.prompt_preview` 的关系

    那个接口是**只读**的（查看者也要能看），且附带 `auto_prompt` / 可编辑
    标记等界面字段。这里只回答"该拿什么去生成"。两者读的是同一批落库数据
    （`desc_of` / `profile_json` / `look_json` / `art_style`），口径一致；
    预览那边多一层 `final_prompt_of`（用户改过的整段终稿优先）。

    这里同样**优先用用户的终稿**：否则「改好提示词再重生成」会被拼装结果覆盖，
    用户改了等于没改。
    """
    from .character_brief import brief_for_image, creature_of, load_brief
    from .db import desc_of, final_prompt_of

    proj = session.get(Project, project_id)
    if proj is None:
        return None
    title = proj.title or ""
    look = _look_of(project_id)
    style = _style_of(project_id)

    if stage_id:
        st = session.get(AssetStage, stage_id)
        if st is None or st.deleted_at or st.project_id != project_id:
            return None
        # 指针行自身无图时按它指向的源造型算，否则会拿到一段与实际那张图
        # 无关的描述（与预览接口同一判据）
        src = st
        if st.source_stage_id:
            s2 = session.get(AssetStage, st.source_stage_id)
            if s2 and not s2.deleted_at and s2.project_id == project_id:
                src = s2
        _b = load_brief(project_id, src.character_name)
        return {
            "prompt": character_prompt(
                title, src.character_name, stage_name=src.stage_name,
                description=src.description,
                brief=brief_for_image({src.character_name: _b} if _b else {},
                                      src.character_name),
                creature=creature_of({src.character_name: _b} if _b else {}, src.character_name),
                profile=_profile_of_asset(session, project_id,
                                          src.character_name),
                look=look, style=style, aspect=proj.base_aspect),
            "target": "stage", "stage_id": st.id,
            "reused_from": src.id if src is not st else None,
        }

    a = (session.query(Asset)
         .filter(Asset.project_id == project_id, Asset.kind == kind,
                 Asset.name == name, Asset.deleted_at.is_(None)).first())
    if a is None:
        return None

    # 用户改过的整段终稿优先（与预览接口同口径，见 `final_prompt_of` 的说明）
    saved = final_prompt_of(a)
    if saved:
        return {"prompt": saved, "target": "asset", "asset_id": a.id,
                "auto_prompt": None}

    if kind == "character":
        _b = load_brief(project_id, a.name)
        p = character_prompt(
            title, a.name, description=desc_of(a),
            brief=brief_for_image({a.name: _b} if _b else {}, a.name),
            creature=creature_of({a.name: _b} if _b else {}, a.name),
            profile=_profile_of_asset(session, project_id, a.name),
            look=look, style=style, aspect=proj.base_aspect)
    elif kind == "prop":
        # 道具必须走自己的模板：落到 else 会拿到场景模板
        # （"空镜头、画面中空无一人"），拿它去生一把刀。
        p = prop_prompt(a.name, description=desc_of(a), title=title,
                        look=look, style=style)
    else:
        p = scene_prompt(a.name, description=desc_of(a), title=title,
                         look=look, style=style)
    return {"prompt": p, "target": "asset", "asset_id": a.id}


def _profile_of_asset(session, project_id: str, name: str) -> dict | None:
    """某角色的形象档案（骨相/肤色/五官/气质）。没有返回 None。"""
    a = (session.query(Asset)
         .filter(Asset.project_id == project_id, Asset.kind == "character",
                 Asset.name == name, Asset.deleted_at.is_(None)).first())
    if not a or not a.profile_json:
        return None
    try:
        d = json.loads(a.profile_json)
    except (ValueError, TypeError):
        return None
    return d if isinstance(d, dict) else None


def _look_of(project_id: str) -> dict | None:
    """同步读项目的影调档案（生成时用，不触发 ensure）。"""
    try:
        from . import look_profile as lp
        return lp.load(project_id)
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        log.warning("[look] 读取影调档案失败，本图退回无影调提示词: %r", e)
        return None


async def run_asset_generate(jid: str) -> None:
    """单张资产生图并**立即写回**资产/造型（镜流网页端「用这段提示词生图」）。

    payload = {"project_id","kind","name","stage_id"?,"prompt","model_id"?,
               "size"?,"n"?,"use_char_ref"?,"ref_urls"?,"exclude_url"?}

    ## 为什么必须是 job，而不是原来那条同步接口

    这条链路此前走同步 `POST /v2/assets/generate`：生图要十几秒到一分钟，
    期间 HTTP 请求一直挂着。后果三条，其中两条是用户实测报来的：

      · **任务队列里看不见它** —— 没有 Job 行，`/projects/{id}/jobs` 自然查不到，
        顶栏角标、常驻横幅、任务中心全都不认它，用户没法知道"到底跑没跑"；
      · **刷新页面进度就没了** —— 进度只活在前端那个按钮的文案里，刷新即清零；
      · 更糟：**请求断开 ≠ 停止生成**。服务端那张图照样出、钱照样扣，
        而结果 URL 没有人接，图直接变成孤儿文件（用户既看不到也找不回）。

    job 化之后这三条一起消失：进度落库、关页面不丢、结果永远能在队列里找回。

    ## 与 `asset_candidates` 的区别（别把两者合并）

    `run_asset_candidates` 是桌面端的「给几张候选让我挑」——**故意不落库**，
    只有用户点选那一张才写回。本 runner 是「就生这一张」，**生成即写回**，
    语义与它取代的那条同步接口完全一致，只是搬进了 job。
    合并两者会让候选池被"已采用"的图污染，且桌面端按 kind=asset_candidates
    翻候选的那条回看链路会捞到一堆无关的图。
    """
    from . import stage_gate
    from .db import Asset

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    prompt = (p.get("prompt") or "").strip()
    stage_id = p.get("stage_id") or None
    kind = p.get("kind")
    name = p.get("name")

    def _fail(reason: str, message: str) -> None:
        _update(jid, status="failed", error=json.dumps(
            {"reason": reason, "message": message}, ensure_ascii=False))

    if not project_id or not kind or not name:
        return _fail("bad_request", "缺少 project_id / kind / name")

    # ⚠️ 没带 prompt 就**现场拼一份**，不能直接判死（2026-10-23 修）。
    #
    # 界面上的「生图」是前端把整段提示词拼好、当参数传上来的；而 agent 的
    # `run_asset_generate` 只有 `kind + name` —— 拼装逻辑此前只存在于那条
    # 前端链路里。于是同一个动作两条路：人手点能出图，agent 一点就死在
    # `缺少提示词`（项目 1023 实测，payload 里确实没有这个键）。
    #
    # 现在拼装收敛到 `asset_prompt_for` 这一处，两条路拿到的是同一段文字。
    if not prompt:
        with get_session() as session:
            built = asset_prompt_for(session, project_id, kind, name,
                                     stage_id=stage_id)
        if built is None:
            # 目标不存在 —— 与下面的存在性预检同口径
            return _fail("gone", (f"造型 {stage_id} 不存在或已被删除" if stage_id
                                  else f"资产「{name}」不存在或已被删除"))
        prompt = (built.get("prompt") or "").strip()
        if not prompt:
            return _fail("bad_request", "缺少提示词（自动拼装也没得到内容，"
                                        "请检查该资产是否还有名字/描述）")

    # 目标存在性**先查再花钱**：一开始就不在的目标没必要为它付费。
    # （生成期间被删是另一回事，下面写回时会再查一次并如实报 failed。）
    with get_session() as session:
        if stage_id:
            st = session.get(AssetStage, stage_id)
            if st is None or st.deleted_at:
                return _fail("gone", stage_gate.describe_missing(stage_id))
        else:
            a = (session.query(Asset)
                 .filter(Asset.project_id == project_id, Asset.kind == kind,
                         Asset.name == name, Asset.deleted_at.is_(None)).first())
            if a is None:
                return _fail("gone", f"资产「{name}」不存在或已被删除")

    # 参考图：显式传的优先；否则按角色自动找已有定妆图（同一张脸）。
    # 与 run_asset_batch / run_asset_candidates / 原同步接口共用 character_base_ref
    # —— 四条路挑的基准必须一致，否则"同一张脸"在不同入口保不住。
    refs = list(p.get("ref_urls") or [])
    if not refs and p.get("use_char_ref", True) and kind == "character":
        from .asset_ref import character_base_ref
        with get_session() as session:
            base = character_base_ref(
                session, project_id, name,
                exclude_stage_ids={stage_id} if stage_id else None,
                exclude_url=p.get("exclude_url"))
        if base:
            refs = [base]

    _update(jid, status="running", progress=10)
    gate = _image_gate()
    # 条目显式模型 > 项目里给这一类配的模型 > 平台默认（2026-10-21）。
    # 弹窗里用户当场选的那个模型在 p["model_id"] 里，排在类别之上。
    _m = p.get("model_id")
    if not _m and kind:
        with get_session() as _s:
            _m = _category_image_model(_s.get(Project, project_id), kind)
    provider = ImageProvider(model_id=_m)
    try:
        async with gate:
            urls = await provider.generate(
                prompt, size=_size_for_kind(p.get("kind"), p.get("size") or "1024x1024"),
                n=max(1, min(int(p.get("n") or 1), 4)), ref_urls=refs or None)
    except ContentRejected as e:
        # 与首帧/候选同口径：审核拒绝要能被前端识别成"改词或换模型"，
        # 而不是"重试"——同一提示词判定必然一致，重试只是再烧一次钱。
        cats = "、".join(e.categories) if e.categories else ""
        return _fail("moderation",
                     f"提示词被内容审核判定违规{('（' + cats + '）') if cats else ''}。"
                     "重试无效——同一提示词判定一致。请弱化提示词中的敏感描写，"
                     "或换用其他生图模型（各厂商审核尺度不同）。")
    except Exception as e:  # noqa: BLE001
        return _fail("channel", f"生图失败: {str(e)[:300]}")

    if not urls:
        return _fail("empty", "模型未返回图片")

    url = urls[0]
    _update(jid, progress=70)

    # ---- 写回 ----
    # 图已经生成、钱已经花了，这一步若失败必须**如实报 failed 并带上 url**，
    # 不能静默丢弃：否则用户看到失败、却不知道图其实出来过。
    if stage_id:
        with get_session() as session:
            st = session.get(AssetStage, stage_id)
            if st is None or st.deleted_at:
                return _fail("gone", f"生成成功但目标造型已不存在（可能在生成期间"
                                     f"被删除）；图片已生成: {url}")
            st.image_url = url
            # 人工/AI 给了新图 → 它自己就是源，解除指针（否则显示的仍是源那套的图）
            st.source_stage_id = None
            _desc_in = st.description      # commit 前取，理由同 `_gen_and_save`
            _label = f"{st.character_name} · {st.stage_name}"
            session.commit()
        from .asset_versions import record as _rec
        # `prompt` 是框里那份（可能被用户当场改过，只对这一次生效）；
        # `desc_in` 是造型真正的可编辑输入（着装描述），回退时还的是它。
        _rec(project_id=project_id, kind="stage", target_id=stage_id,
             image_url=url, prompt=prompt, desc_in=_desc_in,
             model_id=provider.model_id, source="ai", label=_label)
    else:
        with get_session() as session:
            # ⚠️ 必须带 `deleted_at.is_(None)`（2026-10-15 补），与上面的存在性
            # 预检、以及前端 `assetsOf` 的过滤口径**一致**。
            #
            # 不带的话：用户删掉一个角色、之后又建了一个同名的（很常见——"重新识别
            # 拆分"或手改名字），库里就有**一行墓碑 + 一行活的**。`.first()` 可能
            # 选到墓碑行：图写进去了、版本链接在了墓碑上，而前端按 `!deleted_at`
            # 过滤、显示的是**活行**那张旧图。症状与"生成了但卡片没变"一模一样，
            # 成因完全不同——那种情况下查前端怎么刷新都查不出来。
            a = (session.query(Asset)
                 .filter(Asset.project_id == project_id, Asset.kind == kind,
                         Asset.name == name, Asset.deleted_at.is_(None)).first())
            if a is None:
                return _fail("gone", f"生成成功但目标资产「{name}」已不存在（可能在"
                                     f"生成期间被删除）；图片已生成: {url}")
            a.image_url = url
            _aid, _akind, _aname = a.id, a.kind, a.name
            session.commit()
        from .asset_versions import record as _rec
        _rec(project_id=project_id, kind=_akind, target_id=_aid,
             image_url=url, prompt=prompt, model_id=provider.model_id,
             source="ai", label=_aname)

    _update(jid, status="done", progress=100, result=json.dumps({
        "urls": urls, "url": url,
        "ref_used": refs[0] if refs else None,
        # 目标身份：刷新后重开弹窗据此判断"在跑的是不是这一张"
        "target": {"kind": kind, "name": name, "stage_id": stage_id},
    }, ensure_ascii=False))


# kind -> 执行协程
RUNNERS = {
    "asset_generate": run_asset_generate,
    # 自由生图（镜流「生图」页）：产出不挂任何资产，见 run_image_generate 的说明
    "image": run_image_generate,
    "asset_candidates": run_asset_candidates,
    "asset_batch": run_asset_batch,
    "costume_scan": run_costume_scan,
    "profile_fill": run_profile_fill,
    "shot_videos": run_shot_videos,
    "one_click_film": run_one_click_film,
    # ⚠️ 不要再加回 "first_frames" / "first_frame_pipeline"（见下面的 RETIRED_KINDS）。
    # ⚠️ 不要再加回 "compose"。服务端拼接已于 2026-08-30 整体下线：
    # 它只做单轨顺序拼接（无转场/无叠加层/字幕写死 FontSize=18），
    # 产物与桌面端本机渲染差距太大却同样叫"成片"。合成统一走桌面端 ffmpeg。
    "breakdown_all": run_breakdown_all,
    "tts_batch": run_tts_batch,
    # ⚠️ 不要再加回 "reprompt"（见下面的 RETIRED_KINDS）。
}

#: 已下线的任务类型 → 给用户看的一句话。`POST /v2/jobs` 与 `/jobs/{id}/retry`
#: 遇到这些 kind 一律回 **HTTP 410**（不是 400「未知任务类型」）：网页上还留着
#: 对应的按钮，要让它明确知道"这个功能没了、该去哪做"，而不是当成参数写错。
#:
#: `reprompt`（2026-11-19 用户裁定）：镜头脚本的撰写整体移交 Muse，镜流只存与出片。
SHOT_SCRIPT_BY_MUSE = "镜头脚本已改由 Muse 撰写，镜流不再自动生成或改写提示词"
#:
#: `first_frames` / `first_frame_pipeline`（2026-11-20 用户裁定）：首帧 / 首尾帧 / 尾帧
#: 三种生成模式整体下线，出片统一走全能参考，镜流不再给镜头出首帧图。
FIRST_FRAME_RETIRED = ("首帧路线已下线：出片统一走全能参考，"
                       "要指定开头或结尾画面，请把那张图作为参考图加进镜头")
RETIRED_KINDS: dict[str, str] = {
    "reprompt": SHOT_SCRIPT_BY_MUSE + "：请让 Muse 用 set_shot_prompt(s) 写入并锁定",
    "first_frames": FIRST_FRAME_RETIRED,
    "first_frame_pipeline": FIRST_FRAME_RETIRED + "；整片出片请用「一键成片」",
}

# 自动字幕整块（4 个纯函数 + runner + 4 个常量）在 subtitle_jobs.py。
# 它一直是**外挂**——登记方式从来就是下面这一行补登记，而不是写进上面的
# RUNNERS 字面量。搬出去是为了给「去字幕」的两条腾预算，逻辑一行没改。
#
# ⚠️ import 必须放在文件**末尾**：subtitle_jobs 反过来要 `from .jobs import`
# 取 get_job / _update / set_job_phase，放到文件头会在那三个还没定义时触发循环。
from .subtitle_jobs import run_auto_subtitles  # noqa: E402

# 超级 Agent 的 run 执行器（2026-10-20）。与上面同款：补登记而不是写进字面量。
# ⚠️ 同样必须在文件末尾 import —— agent.runner 反过来要 `from ..jobs import`。
from .agent.runner import run_agent_run  # noqa: E402
RUNNERS["agent_run"] = run_agent_run


#: 「一键补全」的分类过滤（2026-10-19）。charge.estimate 与 run_asset_fill 共用，
#: 报价与实际跑的必须是同一个判据——两处各解析一遍迟早会一处认、一处不认。
_FILL_KIND_CN = {"character": "角色", "location": "场景", "prop": "道具"}


def fill_kinds(payload: dict) -> set[str]:
    """payload["kinds"] → 合法分类集合；空集 = 不限（三类都补）。未知值丢弃。"""
    raw = payload.get("kinds") if isinstance(payload, dict) else None
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return set()
    return {k for k in (str(x).strip() for x in raw) if k in _FILL_KIND_CN}


async def run_asset_fill(jid: str) -> None:
    """一键补全要素：把缺图的角色/场景/道具补齐（已有的一律不动）。

    ## 为什么不能让前端自己拼 items

    `run_asset_batch` 的 payload 是 `{"items":[{name,prompt,stage_id?}],...}` ——
    调用方必须**自带提示词**。前端若自己拼一段"角色立绘, XX, 全身, 高质量"，
    出来的图与一键成片那条链路完全不是一个质感（人物档案、形象档案、影调、
    画风预设全都丢了），且此后两边各改各的必然漂移。

    所以补全这件事必须在服务端做：**提示词一律走 `asset_prompt` 那套框架**，
    这里只负责"挑出缺哪些"并编排。

    ⚠️ 与 `run_one_click_film` 的资产段是同一套组合（人物档案 → 形象档案 →
    影调 → 画风 → 场景描述 → 逐项拼 prompt）。那边改了这里要跟着改；
    刻意没有做成共用函数——一键成片是关键路径，为了给补全复用而重构它，
    风险大于收益。

    payload = {"project_id": "...", "model_id": null, "only": [{"kind","name"}]?}
    """
    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    #: 只补这几件（2026-10-15 用户需求「仅补全选中」）。空/缺省 = 全项目补缺。
    #:
    #: 为什么不像 `shot_videos` 那样直接收 id：这四类缺口的**主键各不相同**——
    #: 角色按 `character_name`（有的还没建 AssetStage 行，压根没有 id）、
    #: 场景按 location 名、道具按 `asset_id`。前端资产列表能给的最稳定的东西是
    #: **(kind, name)**，所以判据就用它，由这里映射回各自的键。
    #: 不这样做的后果（改之前实测过）：前端把选中的 id 发过来，这里照样重算
    #: 全项目缺口 —— 用户以为只补 2 个，实际全补一遍、也按全项目扣费。
    _only_raw = p.get("only") or []
    only: set[tuple[str, str]] = set()
    for it in _only_raw:
        if isinstance(it, dict) and it.get("name"):
            only.add((str(it.get("kind") or "").strip(), str(it["name"]).strip()))
        elif isinstance(it, str):
            # 只给了名字：三种 kind 都算命中（前端老版本/手写调用容错）
            only.add(("", it.strip()))
    only_names = {n for _k, n in only}
    #: 只补哪几类（2026-10-19 用户需求：「一键补全」只补**当前正在看的**
    #: 角色/场景/道具页，而不是三类全补）。空 = 三类都补（= 改动前行为）。
    #: 与 `only` 正交：`only` 是勾选的具体几件，`kinds` 是整页。
    #: ⚠️ 不能让前端改发"本页所有名字"的 `only` 来替代：缺口里有**还没建资产行**
    #:    的条目（镜头里出现了、要素页还没有的场景/角色），前端列不出它们。
    kinds = fill_kinds(p)

    def _want(kind: str, name: str) -> bool:
        """这件要不要补。`only`/`kinds` 都为空 = 全都要（= 改动前行为）。"""
        if kinds and kind not in kinds:
            return False
        if not only:
            return True
        n = (name or "").strip()
        return (kind, n) in only or ("", n) in only

    # 这两个模块级没有（`run_one_click_film` 同样是函数内导入），
    # 直接用会在**运行时**才 NameError——那时 job 已经建了、用户已经在等了。
    from .readiness import compute_readiness
    from .db import Asset, Project

    _update(jid, status="running")
    # ⚠️ phase 必须是 **dict**，不能是字符串。`JobOut.phase: Optional[dict]`
    #    是 pydantic 强校验的，字符串会让 `GET /v2/jobs/{id}` 直接 500——
    #    而 main.py 没注册异常处理器，所以是裸 500，前端拿不到任何解释。
    #    本函数曾传字符串（"盘点缺口" 等 6 处），于是要素补全跑的这几分钟里
    #    单任务详情接口全程 500。
    #    形状与其他 runner 一致：{key, label, done, total}；本功能的分步是
    #    **串行阶段**而非计数，故不带 done/total（前端读的是 label）。
    def _ph(key: str, label: str) -> None:
        set_job_phase(jid, {"key": key, "label": label})

    _ph("readiness", "盘点缺口")
    rd = compute_readiness(project_id)
    if rd.get("error"):
        _update(jid, status="failed", error=f"项目不存在: {project_id}")
        return

    # 这几步都要 await（会调 LLM），必须在 session 块之前做完：
    # 同步 session 里不能跑协程，占着 DB 连接等网络也是明确的反模式。
    #
    # 只补场景/道具页时，**跳过只为角色服务的准备步骤**（人物档案、形象档案）：
    # 它们每个角色一次 LLM 调用，几十个角色就是几分钟和一笔文本费，
    # 而这一轮根本不会出任何角色图。同理，只补角色/道具时不生成场景描述。
    _need_char = not kinds or "character" in kinds
    _need_loc = not kinds or "location" in kinds
    _need_prop = not kinds or "prop" in kinds
    _briefs: dict = {}
    _profiles: dict = {}
    if _need_char:
        _ph("briefs", "人物档案")
        _briefs = await _collect_briefs(project_id, rd, p.get("model_id"))
        _ph("profiles", "形象档案")
        _profiles = await _collect_profiles(project_id, rd, p.get("model_id"))
    _ph("look", "影调档案")
    _look = await _collect_look(project_id)
    _style = _style_of(project_id)
    if _need_loc:
        _ph("scenes", "场景描述")
        await ensure_scene_descriptions(project_id)
    if _need_prop:
        _ph("props", "道具描述")
        await ensure_prop_descriptions(project_id)

    _ph("plan", "排生图清单")
    items: list[dict] = []
    with get_session() as session:
        proj = session.get(Project, project_id)
        title = proj.title if proj else ""
        # 定妆图版式跟画幅走：竖幅"上半幅头图 + 下半幅正/背双视图"，
        # 横/方幅"左中右三段：头图｜正面(遮面)｜背面"。见 asset_prompt.view_layout。
        _asp = proj.base_aspect if proj else None
        # 阶段无图：直接生图进该阶段
        for row in rd["assets"]["stages_no_image"]:
            st = session.get(AssetStage, row["id"])
            if st is None:
                continue
            if not _want("character", st.character_name):
                continue
            items.append({
                "name": f"角色-{st.character_name}",
                "stage_id": st.id,
                "prompt": character_prompt(
                    title, st.character_name, stage_name=st.stage_name,
                    description=st.description,
                    brief=brief_for_image(_briefs, st.character_name),
                    creature=creature_of(_briefs, st.character_name),
                    profile=_profiles.get(st.character_name),
                    look=_look, style=_style,
                    aspect=_asp),
            })
        # 角色完全无定妆图：补建阶段行再生图
        for row in rd["assets"]["chars_no_asset"]:
            cname, eps = row["name"], row["episodes"]
            if not _want("character", cname):
                continue
            runs = _plan_default_stages(session, project_id, cname, eps)
            if not runs:
                continue
            ca = (session.query(Asset)
                  .filter(Asset.project_id == project_id,
                          Asset.kind == "character", Asset.name == cname).first())
            desc = desc_of(ca) or ""
            for ep_from, ep_to in runs:
                # 盘点快照是 job 开头算的。若期间已有别的任务把阶段建好了
                # （去重失效、或用户在别处点了补全），照建就是重复行。
                # 判据与 _plan_default_stages 的产出一致：同角色 + 同集区间。
                exists = (session.query(AssetStage)
                          .filter(AssetStage.project_id == project_id,
                                  AssetStage.character_name == cname,
                                  AssetStage.ep_from == ep_from,
                                  AssetStage.ep_to == ep_to,
                                  AssetStage.deleted_at.is_(None)).first())
                if exists:
                    if not exists.image_url:
                        items.append({
                            "name": f"角色-{cname}", "stage_id": exists.id,
                            "prompt": character_prompt(
                                title, cname, description=desc,
                                brief=brief_for_image(_briefs, cname),
                                creature=creature_of(_briefs, cname),
                                profile=_profiles.get(cname),
                                look=_look, style=_style,
                                aspect=_asp),
                        })
                    continue
                st = AssetStage(id=uuid.uuid4().hex[:12], project_id=project_id,
                                character_name=cname, stage_name="默认造型",
                                ep_from=ep_from, ep_to=ep_to, description=desc)
                session.add(st)
                session.commit()
                items.append({
                    "name": f"角色-{cname}",
                    "stage_id": st.id,
                    "prompt": character_prompt(
                        title, cname, description=desc,
                        brief=brief_for_image(_briefs, cname),
                        creature=creature_of(_briefs, cname),
                        profile=_profiles.get(cname),
                        look=_look, style=_style,
                        aspect=_asp),
                })
        # 场景多视角参考图
        items += _scene_view_items(
            session, project_id, title,
            [n for n in rd["assets"]["locations_no_image"]
             if _want("location", n)], _look)
        # 道具参考图（2026-10-08）。`.get` 而非 `[]`：readiness 是**进程内**
        # 同版本调用，字典里一定有这个键；但这里留一道兜底 —— 一键补全跑在
        # 生产上、几十分钟的长任务中间可能跨过一次部署，旧进程算出的 rd
        # 没有这个键，`[]` 会直接 KeyError 把整条任务炸掉。
        items += _prop_items(
            session, project_id, title,
            [n for n in (rd["assets"].get("props_no_image") or [])
             if _want("prop", n)], _look)
        _asset_sz = _asset_size(proj.base_aspect if proj else None)
        _asset_model = _resolve_project_gen_settings(proj)[1]

    if not items:
        _kcn = "、".join(_FILL_KIND_CN[k] for k in sorted(kinds)) if kinds else ""
        note = ("选中的要素都没有缺口，无需补全" if only
                else f"{_kcn}都不缺图，无需补全" if kinds
                else "没有缺图的要素，无需补全")
        _update(jid, status="done", result=json.dumps(
            {"filled": 0, "note": note, "only": sorted(only_names) if only else None,
             "kinds": sorted(kinds) or None},
            ensure_ascii=False))
        return

    # 把排好的清单写回自己的 payload，再交给 run_asset_batch——
    # 它是从 job 记录里重新读 payload 的，所以这样就是"同一个 job 接着往下跑"。
    p.update({"items": items, "size": _asset_sz,
              "model_id": p.get("model_id") or _asset_model})
    with get_session() as session:
        j = session.get(Job, jid)
        if j:
            j.payload = json.dumps(p, ensure_ascii=False)
            session.commit()
    await run_asset_batch(jid)


RUNNERS["asset_fill"] = run_asset_fill

RUNNERS["auto_subtitles"] = run_auto_subtitles

# 去字幕（擦掉视频模型烧进画面的原生字幕）同样放在**文件末尾**，同样的理由：
# desub_jobs 反过来要 `from .jobs import` 取 get_job / _update / set_job_phase。
#
# ⚠️ 它们**不是 compose**。上面 RUNNERS 字面量里那条「不要再加回 compose」的
# 禁令针对的是**服务端拼成片**（跨镜顺序拼接冒充成片）；这里的拼接发生在
# **单镜素材内部**（擦过的段与没擦的段接回同一条视频），产物仍然是一个镜头的
# 素材、仍然交给桌面端去合成。两者只是都用了 ffmpeg，性质完全不同。
from .desub_jobs import run_desub_apply, run_desub_scan  # noqa: E402

RUNNERS["desub_scan"] = run_desub_scan
RUNNERS["desub_apply"] = run_desub_apply

# 高清放大（SeedVR2 超分）同理放在文件末尾。它改的也是 shot.video_url，
# 故归进 shots 组互斥（见 _EXCLUSIVE_GROUPS）。
from .upscale_jobs import run_upscale  # noqa: E402

RUNNERS["upscale"] = run_upscale

# 镜流「高清」页的独立放大（2026-10-17）：不挂镜头、不改 shot.video_url，
# 所以**刻意不进** _EXCLUSIVE_GROUPS —— 进了就会"项目在出片时高清页点不动"，
# 正是 10-16 刚修掉的那类粗粒度锁。重复提交按**文件**去重，见 routers/upscale.py。
from .upscale_jobs import run_video_upscale  # noqa: E402

RUNNERS["video_upscale"] = run_video_upscale

# 资产查重的「AI 复审」（2026-10-28）。纯文本、只读不写库，所以**不进**
# _EXCLUSIVE_GROUPS（进了会让"补全在跑时点不了复审"）；同项目重复提交按 kind 去重。
from .asset_dedupe_ai import run_asset_dedupe_ai  # noqa: E402

RUNNERS["asset_dedupe_ai"] = run_asset_dedupe_ai

# 「解说剧·角色开口」（2026-10-30）：整条流水线在 app/nd/，与其他模式隔离。
# 两个任务都动本项目的镜头集合（拆解会删建镜头），归进 shots 组彼此互斥。
from .nd.pipeline import run_nd_breakdown, run_nd_produce  # noqa: E402
RUNNERS["nd_breakdown"] = run_nd_breakdown
RUNNERS["nd_produce"] = run_nd_produce
_EXCLUSIVE_GROUPS["nd_breakdown"] = "shots"
_EXCLUSIVE_GROUPS["nd_produce"] = "shots"
