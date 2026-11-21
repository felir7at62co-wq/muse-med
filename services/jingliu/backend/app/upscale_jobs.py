"""高清放大：把项目里**当前采用的**那一版片段整批送去超分，落成新的 ShotVersion。

## 这个功能在做什么

RunningHub 的 SeedVR2 工作流把片段按**短边放大到 1088**（720×1280 → 1088×1934）。
它是产线末端的一步：不动内容、不改时长、不换音轨，只是把像素补上去，
让最终成片在大屏上不糊。

## 「当前所有片段」到底指哪些（用户原话里的重点）

判据只有一条：**`shot.video_url` 非空**。而 `shot.video_url` 恒等于
`shot.adopted_version` 对应的那一版（每次落版本都同步写这两个字段）。

于是「重新生成后被换下的旧版本天然不参与」不需要任何额外筛选——
它们在 `shot_versions` 表里躺着，而 `video_url` 早就指向新的那一版了。
这一点是**结构保证**的，不是靠这里写了个 if。

## 并发（用户明确要求）

复用 `jobs._video_pool()`（= `settings.video_concurrency`，默认 300），
**不新建常量、不下调**（并发数铁律）。与出片共用同一个池是**有意为之**：
放大和出片抢的是同两个资源（RunningHub 账号配额、本机出口带宽），
分成两个池只会让两边都以为自己有余量，合起来把账号打爆。

## 与 desub_apply 的对照

2026-11-13 起 `desub_apply` **也改成并发了**：它原来是「多段切-擦-拼」的
流水线（一镜要提交好几次第三方任务，出错时要能立刻停下来），换成火山精细版
之后变成**一镜一次提交**，与放大同形 —— 再串行只会让 30 镜的一集从几十分钟
拖到几小时。两者现在共用同一条纪律：一镜一次、无分支、失败只影响那一镜。

放大是**一镜一次提交、且无分支**：要么成功要么失败，失败只是那一镜少放大一次，
不会产生半成品，也不会因为并发而互相干扰（每次提交是独立的 graph，
见 `providers/upscale.py::_graph` 的深拷贝说明）。用户要的就是"整批跑完"，
串行只会把 20 个镜头拖成几小时。

## 落版本

照抄 `desub_jobs._apply_one` 的范式，但**时长断言的意义相反**：
放大**必须**保持帧数与时长的逐帧对齐（工作流里 `frame_rate`/`images` 都接源信息），
所以一旦 drift 就说明产物有问题，此时才 `reset_clip_window`。
正常路径（实测 2.000s → 2.000s、48帧 → 48帧）不清窗口 ——
取片窗口是用户调好的剪辑意图，等长替身没有理由把它丢掉。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

from .db import Shot, ShotVersion, get_session
from .err_text import human_error

# ⚠️ 与 desub_jobs / subtitle_jobs 同一条纪律：**不在模块顶层** `from .jobs import ...`。
# 模块图必须单向（jobs 在文件末尾 → 本模块），反向只能发生在**调用时**。

log = logging.getLogger(__name__)

#: 时长容差（秒）。与 `desub_jobs._DUR_TOLERANCE_SEC` 同值同义：
#: 容器时间戳是毫秒粒度，逐帧等长的两份文件在 ffprobe 上可能差几毫秒，
#: 那不是 drift；超过 50ms 才是拼接/编码真的改了时长。
_DUR_TOLERANCE_SEC = 0.05


async def _one(row: dict, on_progress=None) -> dict:
    """放大一个镜头，返回 {"ok", "note", ...}。**不落库**（落库在 run_upscale 里）。

    超过 30s 的素材由 provider 切段并发放大再拼回（2026-10-18）；
    `on_progress(done, total)` 透传给它，用于"已完成 x/k 段"。

    把"花钱的调用"与"写数据库"分开：前者慢且可能失败，后者必须快且原子。
    """
    from .media import (_probe_wh, ensure_local_async, make_thumb,
                        probe_video_frames)
    from .providers.upscale import pick_upscale_provider

    sid = row["id"]
    src = await ensure_local_async(row["video_url"] or "")
    if src is None or not src.is_file():
        return {"ok": False, "note": "素材文件不存在"}

    provider = pick_upscale_provider()
    if provider is None:
        return {"ok": False,
                "note": "未配置高清放大通道（检查 FW_UPSCALE_CHANNEL 与对应渠道的 key）"}

    before_w, before_h = await _probe_wh(src)
    r = await provider.upscale(row["video_url"], on_progress=on_progress)
    if not r.get("ok"):
        return {"ok": False, "note": (r.get("error") or "放大失败")[:200],
                "cost_sec": r.get("cost_sec") or 0.0, "cancelled": bool(r.get("cancelled"))}

    new_url = r["video_url"]
    new_path = await ensure_local_async(new_url)
    if new_path is None or not new_path.is_file():
        return {"ok": False, "note": "放大产物落盘失败"}

    after_w, after_h = await _probe_wh(new_path)
    if not after_w or not after_h:
        new_path.unlink(missing_ok=True)
        return {"ok": False, "note": "放大产物不可读"}

    # ---- 判据一：分辨率真的变大了 ----
    # 这条断言防的正是 provider 那边最隐蔽的错法：**字段名写错**时平台照收、
    # 节点值不变，产物是"原样过了一遍工作流"的等分辨率文件。
    # 不判这一下，用户花了机时拿到一堆"看起来没变"的片子，而系统报"成功"。
    scaled_up = after_w * after_h > before_w * before_h
    if not scaled_up:
        new_path.unlink(missing_ok=True)
        return {"ok": False,
                "note": f"放大无效（{before_w}×{before_h} → {after_w}×{after_h}），"
                        f"已丢弃产物"}

    # ---- 判据二：时长逐帧对齐 ----
    # ⚠️ 比**视频流**，不是容器时长：容器时长取最长的那条流，音轨恒等于原片，
    # 画面被吃掉一整秒它也纹丝不动（去字幕就是这个断言失效的，见
    # docs/AUDIT-2026-11-12-去字幕音画不对应.md）。放大必须逐帧等长，
    # 所以这里连帧数一起比。

    file_dur, file_frames = await probe_video_frames(src)
    new_dur, new_frames = await probe_video_frames(new_path)
    drifted = (file_dur <= 0 or new_dur <= 0
               or abs(new_dur - file_dur) > _DUR_TOLERANCE_SEC
               or (file_frames > 0 and new_frames > 0
                   and abs(new_frames - file_frames) > 1))

    thumb = await make_thumb(new_url, at_sec=max(0.0, row.get("clip_in") or 0.0) + 0.5)
    return {"ok": True, "sid": sid, "video_url": new_url, "thumb": thumb,
            "src_video_url": row["video_url"], "drifted": drifted,
            "note": (f"时长漂移 {file_dur:.2f}s → {new_dur:.2f}s"
                     if drifted else ""),
            "before": f"{before_w}x{before_h}", "after": f"{after_w}x{after_h}",
            "cost_sec": r.get("cost_sec") or 0.0, "money": r.get("money")}


def _install(row: dict, r: dict) -> int:
    """把放大产物落成新版本并采用。返回新版本号。"""
    from .db import ShotVersion, reset_clip_window

    sid = row["id"]
    meta = json.dumps({"target_short_edge": r.get("after"),
                       "src_resolution": r.get("before"),
                       "src_video_url": r["src_video_url"],
                       "cost_sec": round(float(r.get("cost_sec") or 0.0), 1),
                       "money": r.get("money"),
                       "duration_drift": bool(r.get("drifted"))},
                      ensure_ascii=False)
    with get_session() as session:
        shot = session.get(Shot, sid)
        if shot is None:
            return 0
        last = (session.query(ShotVersion)
                .filter(ShotVersion.shot_id == sid)
                .order_by(ShotVersion.version_no.desc()).first())
        if last is None:
            # 当前成片**没有任何版本记录**（全库约 1%）。不补这一版的话，
            # 放大产物会成为「版本 1」，用户在版本区看不到"放大前长什么样"，
            # 也就无从切回。补录的 model_id 用 "original"，与 desub 同口径。
            session.add(ShotVersion(
                id=uuid.uuid4().hex[:16], shot_id=sid, version_no=1,
                video_url=row["video_url"], thumb_url=shot.thumb_url,
                model_id="original",
                meta=json.dumps({"note": "高清放大前的原片（补录）"},
                                ensure_ascii=False)))
            vno = 2
        else:
            vno = last.version_no + 1
        session.add(ShotVersion(
            id=uuid.uuid4().hex[:16], shot_id=sid, version_no=vno,
            video_url=r["video_url"], thumb_url=r["thumb"],
            model_id="upscale", meta=meta))
        shot.video_url = r["video_url"]
        shot.thumb_url = r["thumb"] or shot.thumb_url
        # ← 漏掉它界面就没有任何一版标着「当前」，而画面已经是放大后的了。
        #   （desub_jobs.py:767 的同一条注释，同一个坑。）
        shot.adopted_version = vno
        if r.get("drifted"):
            # 只有真的漂了才清：放大本应逐帧等长，漂了说明产物与源不是同一段，
            # 取片窗口指向的时间点已经错位。正常路径保留窗口。
            reset_clip_window(shot)
        session.commit()
    return vno


def upscale_candidates(session, project_id: str, *, payload: dict,
                       skip_hd_default: bool = True) -> list[Shot]:
    """这次高清**到底要处理哪些镜头** —— 唯一的判据实现，报价与执行共用。

    ## 为什么必须只有一处

    原先 `charge.estimate` 自己按 `episode` 筛、`run_upscale` 自己按 `shot_ids`
    筛，两边口径不同：传 `episode` 时预扣按那一集算、实际却跑了整片（多花钱
    没人拦），传 `shot_ids` 时又反过来（预扣按整片、实际只跑几个，余额被锁住）。
    这就是 `episode` 那个字段长期只在报价侧存在的原因。所以筛法收在这里，
    两个调用方都从这里取。

    ## 参数

    | payload | 含义 |
    |---|---|
    | `shot_ids`（非空） | **点名**：只处理这几个。点名是显式的，**已高清的也照做**（用户就是要重做） |
    | `episode` | 只做这一集 |
    | `skip_hd`（默认 true） | 跳过**当前采用版本已经是高清**的镜头 |

    三者可叠加：`{episode: 3, skip_hd: true}` = 第 3 集里还没高清的。

    `skip_hd` 为什么默认开：`video_url` 恒等于 `adopted_version` 那一版，所以
    「已经高清过」的镜头再跑一次，放大的是**放大过的片子**——画质不会更好，
    机时照付（RunningHub 按机时计费）。"高清全部"在用户嘴里指的就是"把还没
    高清的都高清掉"，不是"把高清过的再来一遍"。
    """
    only = set(payload.get("shot_ids") or [])
    ep = payload.get("episode")
    ep = int(ep) if ep is not None and str(ep).strip() != "" else None
    skip_hd = payload.get("skip_hd", skip_hd_default)

    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id, Shot.video_url.isnot(None))
            .order_by(Shot.order).all())
    ids = [s.id for s in rows]
    hd: set[str] = set()
    if ids:
        hd = {sid for (sid,) in
              (session.query(ShotVersion.shot_id)
               .join(Shot, Shot.id == ShotVersion.shot_id)
               .filter(ShotVersion.shot_id.in_(ids),
                       ShotVersion.version_no == Shot.adopted_version,
                       ShotVersion.model_id == "upscale").all())}

    out = []
    for s in rows:
        if s.disabled:
            continue
        if only and s.id not in only:
            continue          # 点名了别的镜头
        if ep is not None and s.episode != ep:
            continue
        if skip_hd and not only and s.id in hd:
            continue          # 点名的不跳过：用户明确要重做
        out.append(s)
    return out


async def run_upscale(jid: str) -> None:
    """对项目里所有当前有成片的镜头跑高清放大。

    payload = {"project_id": "...", "shot_ids": [...]?, "episode": int?}

    ⚠️ **会花钱**（RunningHub 按机时计费，实测 plus 机型 ≈ ¥6/h，
    2 秒片段 ≈ 139 秒机时）。结论会连同机时一起写进 job result，
    让"这一批花了多少"是可查的，而不是只能靠事后翻账单。
    """
    from .jobs import (_brief_errors, _update, _video_pool, get_job,
                       is_cancelled, set_job_phase)

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    _update(jid, status="running", progress=1)

    with get_session() as session:
        cand = upscale_candidates(session, project_id, payload=p)
        rows = [{"id": s.id, "order": s.order, "video_url": s.video_url,
                 "clip_in": s.clip_in_sec or 0.0} for s in cand]

    if not rows:
        _update(jid, status="failed",
                error="没有可放大的片段。请先生成片段，再跑高清放大。")
        return

    total = len(rows)
    set_job_phase(jid, {"key": "upscale", "label": "正在高清放大",
                        "done": 0, "total": total})

    pool = _video_pool()
    done = 0
    okn = 0
    cost = 0.0
    money = 0.0
    notes: list[str] = []
    #: 失败明细（带镜头序号），收尾时交给 _brief_errors 压成一句话。
    failed_rows: list[tuple[dict, dict]] = []
    lock = asyncio.Lock()

    async def _run(row: dict) -> None:
        nonlocal done, okn, cost, money
        async with pool:
            # ⚠️ 拿到槽位后**再查一次**取消（2026-10-15 补）。
            # 位置必须在这里而不是函数入口：gather 一次性派发全部协程，
            # 它们在第一轮事件循环就都通过了入口检查，然后堵在 300 并发的
            # 信号量上排队几十分钟 —— 用户的取消几乎必然发生在那之后。
            # 不在这里补一次，"取消"就只是把状态位改成"已取消"、镜头照跑、
            # 机时照烧（放大按机时计费，这是直接烧钱）。
            # 裸 return：不追加失败明细，收尾按 job 状态位判定（见本函数末尾）。
            if is_cancelled(jid):
                return
            try:
                r = await _one(row)
            except Exception as e:  # noqa: BLE001 —— 单镜异常不该带垮整批
                log.warning("[upscale] 镜头 %s 失败: %s", row["id"], e)
                # human_error 而非 str(e)：超时类异常 str() 是空串，
                # 报错栏会显示 "第 N 镜 " 后面什么都没有（见 err_text 模块头）。
                r = {"ok": False, "note": human_error(e)}
            if r.get("ok"):
                try:
                    vno = _install(row, r)
                    r["version_no"] = vno
                except Exception as e:  # noqa: BLE001
                    log.warning("[upscale] 镜头 %s 落库失败: %s", row["id"], e)
                    r = {"ok": False, "note": f"落库失败：{str(e)[:160]}",
                         "cost_sec": r.get("cost_sec") or 0.0}
        async with lock:
            done += 1
            if r.get("ok"):
                okn += 1
                cost += float(r.get("cost_sec") or 0.0)
                # consumeMoney 平台给字符串，且可能是 null（老任务）。
                # 只在真有值时累加，不用 0 冒充"这次没花钱"。
                if r.get("money") is not None:
                    money += float(r.get("money") or 0.0)
            else:
                # 「第 N 镜」而非 `#N`：同一个项目里 `#N` 有两种含义（拆解的
                # `order` 与这里的镜头序号），任务中心的「镜头」列又是 shot_id
                # 前 8 位 —— 三个东西长得像但不是一回事，用户对不上。
                notes.append(f"第 {row['order']} 镜 {r.get('note')}")
                failed_rows.append((row, r))
            set_job_phase(jid, {"key": "upscale", "label": "正在高清放大",
                                "done": done, "total": total})
            _update(jid, progress=max(1, min(98, int(done / total * 100))))

    # 这**就是**「并发跑」：并发度由 _video_pool() 决定（默认 300），
    # 不在这里另设上限、也不分批串行。
    await asyncio.gather(*(_run(row) for row in rows))

    set_job_phase(jid, None)
    result = json.dumps({"total": total, "done": okn, "failed": total - okn,
                         "cost_sec": round(cost, 1), "money": round(money, 3),
                         "rate_per_hour": 6.0},
                        ensure_ascii=False)
    # 用 _brief_errors 收口，别自己 `notes[:3]` 硬切：它有 5 条上限、
    # 500 字符总量、以及「另有 N 项失败」的收尾。此前硬切 3 条 + 外层 300 字符
    # 截断，**恰好把第三条砍在中间**，用户看到的就是 `…；#` 这种断尾
    # （2026-10-15 用户报的"看不懂的报错"）。
    _brief = _brief_errors([{"order": row["order"], "error": r.get("note")}
                            for row, r in failed_rows])
    if okn == 0:
        _update(jid, status="failed", progress=100, result=result,
                error=f"高清放大失败：{_brief}")
        return
    _update(jid, status="done", progress=100, result=result,
            error=(f"{_brief}，其余已完成") if _brief else None)


# --------------------------------------------------------------- 独立高清页
#
# 镜流「高清」页（2026-10-17 用户需求）：用户**直接上传**一个或多个视频，
# 整批送去同一条 SeedVR2 工作流，全部并发。与上面 `run_upscale` 的区别只有一条：
# **不挂任何镜头、不落 ShotVersion**——产物只活在 job.result 里，由
# `GET /v2/projects/{pid}/video-upscale-jobs` 列回来（与「生图」页同一个思路：
# 那条列表就是这些成片唯一能被找回来的入口）。
#
# 「花钱的调用」完全复用 `_one()`：同一个 provider、同一条"分辨率必须真的变大"
# 断言（防的是工作流字段写错时平台照收、产物原样返回、系统却报成功）。
# 两份实现的话，那条断言迟早只在一边有。

def video_upscale_items(payload: dict) -> list[dict]:
    """payload → 规整后的条目清单。报价、执行、列表三处共用这一个口径。"""
    out = []
    for i, it in enumerate(payload.get("items") or []):
        if not isinstance(it, dict) or not (it.get("url") or "").strip():
            continue
        out.append({"url": it["url"].strip(),
                    "name": (it.get("name") or "").strip() or f"视频 {i + 1}",
                    "duration": float(it.get("duration") or 0.0)})
    return out


async def run_video_upscale(jid: str) -> None:
    """独立高清：payload = {"project_id", "items": [{url, name, duration}]}。

    ⚠️ 会花钱（RunningHub 按机时）。并发度 = `jobs._video_pool()`，与出片/镜头放大
    **共用同一个池**（理由见模块头"并发"一节），不新建常量、不下调（并发数铁律）。

    每完成一条就把 result **整份重写**一次：界面在轮询里逐条点亮，
    而不是等最后一条跑完才一次性出现——长视频放大是分钟到小时级的。
    """
    from .jobs import _brief_errors, _update, _video_pool, get_job, is_cancelled

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    items = video_upscale_items(p)
    if not items:
        _update(jid, status="failed", error="没有要放大的视频")
        return
    _update(jid, status="running", progress=1)

    total = len(items)
    states: list[dict] = [{"url": it["url"], "name": it["name"],
                           "duration": it["duration"], "status": "pending"}
                          for it in items]
    pool = _video_pool()
    lock = asyncio.Lock()
    done = 0

    def _flush(final: bool = False) -> None:
        okn = sum(1 for s in states if s["status"] == "done")
        res = {"total": total, "done": okn,
               "failed": sum(1 for s in states if s["status"] == "failed"),
               "cost_sec": round(sum(float(s.get("cost_sec") or 0) for s in states), 1),
               "items": states}
        fields = {"result": json.dumps(res, ensure_ascii=False)}
        if not final:
            # 切段的视频按"已完成段数/总段数"折算进进度（2026-10-18）：
            # 只放一个长视频时，不折算的话整个过程都停在 1%。
            part = sum(s["segments_done"] / s["segments"] for s in states
                       if s["status"] == "running" and s.get("segments"))
            fields["progress"] = max(1, min(98, int((done + part) / total * 100)))
        _update(jid, **fields)

    async def _run(i: int, it: dict) -> None:
        nonlocal done
        async with pool:
            # 拿到槽位后**再查一次**取消：理由同 run_upscale（gather 一次派发全部，
            # 入口检查形同虚设，取消几乎必然发生在排队之后）。
            if is_cancelled(jid):
                async with lock:
                    states[i]["status"] = "cancelled"
                return
            async with lock:
                states[i]["status"] = "running"
                _flush()
            def _seg_progress(d: int, n: int) -> None:
                # 长视频切段并发：把"已完成 x/k 段"写进这一条的说明里。
                # 否则整条要跑到最后一段才有变化，界面上就是一直停在 1%。
                states[i]["note"] = f"分 {n} 段并发放大，已完成 {d}/{n} 段"
                states[i]["segments"] = n
                states[i]["segments_done"] = d
                _flush()

            try:
                r = await _one({"id": f"v{i}", "video_url": it["url"], "clip_in": 0.0},
                               on_progress=_seg_progress)
            except Exception as e:  # noqa: BLE001 —— 单条异常不该带垮整批
                log.warning("[video_upscale] 第 %d 条失败: %s", i + 1, e)
                r = {"ok": False, "note": human_error(e)}
        async with lock:
            done += 1
            st = states[i]
            st["cost_sec"] = float(r.get("cost_sec") or 0.0)
            if r.get("ok"):
                st.update(status="done", video_url=r["video_url"],
                          thumb=r.get("thumb"), before=r.get("before"),
                          after=r.get("after"), note=r.get("note") or "")
            elif r.get("cancelled"):
                st.update(status="cancelled", note="已取消")
            else:
                st.update(status="failed", note=r.get("note") or "放大失败")
            _flush()

    await asyncio.gather(*(_run(i, it) for i, it in enumerate(items)))

    _flush(final=True)
    okn = sum(1 for s in states if s["status"] == "done")
    failed = [s for s in states if s["status"] == "failed"]
    # 标签用文件名：这些不是镜头，「第 N 镜」会让用户对不上是哪个文件
    brief = _brief_errors([{"name": s["name"], "error": s.get("note")} for s in failed])
    if is_cancelled(jid):
        return                      # 状态位已由取消接口写好，这里不覆盖
    if okn == 0:
        _update(jid, status="failed", progress=100,
                error=f"高清放大失败：{brief}" if brief else "高清放大失败")
        return
    _update(jid, status="done", progress=100,
            error=(f"{brief}，其余已完成") if brief else None)
