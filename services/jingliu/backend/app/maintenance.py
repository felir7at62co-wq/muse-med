"""启动维护（R3 提前项，按"易用性+数据安全"决策）：

1. 僵尸任务清理：BackgroundTasks 随进程死亡，重启后 pending/running job 永远
   不会推进，卡在 prompting/generating 的镜头永远转圈——启动时统一置 failed，
   用户在看板一眼看到可重试，而不是无限等待（易用性）。
2. SQLite 自动备份：全部项目数据在单文件，启动时备份到 backups/ 保留最近 7 份
   （数据安全）。用 sqlite3 backup API 保证一致性（拷文件可能撕裂热库）。
   配了桶时，巡检再把每份备份复制到桶里的私有前缀 `backups/`（`upload_backups`）。
"""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .db import DATABASE_URL, Job, Shot, get_session

logger = logging.getLogger(__name__)

# 每天最多保留 7 份（BACKUP_KEEP_DAYS），同分钟内不重复备份（防崩溃循环自毁）
BACKUP_KEEP_DAYS = 7
# 崩溃循环防御：同一分钟内的第二次备份直接跳过。
# Restart=always + RestartSec=5 意味着崩溃循环会以每 5 秒一份的速度建备份，
# 35 秒内就能把 7 份槽位全覆盖成崩溃时刻的状态，把所有历史备份消灭。
BACKUP_DEBOUNCE_MINUTES = 1


#: 镜头/音频段的**瞬时态**：只应在 job runner 执行期间出现，落在这些状态上
#: 且没有对应活跃 job，就是孤儿（详见 sweep_orphaned_states 的判据说明）。
_SHOT_TRANSIENT = ("prompting", "generating")
_AUDIO_TRANSIENT = ("generating",)

#: 孤儿巡检间隔（秒）。5 分钟：够快到用户不会长时间对着转圈的进度条，
#: 又不会频繁扫库。巡检本身是两条带索引条件的查询，成本可忽略。
SWEEP_INTERVAL_SEC = 300


def recover_zombie_tasks() -> dict:
    """把上次进程留下的 running/pending job 与瞬时态的镜头/音频段置为 failed。

    ⚠️ audio_clips 原来漏了（B14）：run_tts 会把 AudioClip.status 写成
    "generating"，而这里只清 Job 与 Shot。更糟的是重跑入口
    （run_tts 的 `status.in_(("pending","failed"))`）**不认 generating**，
    于是重启后卡在 generating 的旁白段既不显示失败、也永远不会被重跑捡起，
    用户看到那一段一直转圈，只能手动删掉重建。
    """
    with get_session() as session:
        from .db import AudioClip

        zombie_jobs = (session.query(Job)
                       .filter(Job.status.in_(("pending", "running"))).all())
        for j in zombie_jobs:
            j.status = "failed"
            j.error = "后端重启，任务中断（可在看板重试）"
        zombie_shots = (session.query(Shot)
                        .filter(Shot.status.in_(_SHOT_TRANSIENT)).all())
        for s in zombie_shots:
            s.status = "failed"
        zombie_audio = (session.query(AudioClip)
                        .filter(AudioClip.status.in_(_AUDIO_TRANSIENT)).all())
        for a in zombie_audio:
            a.status = "failed"
            a.error = "后端重启，合成中断（可重新合成）"
        session.commit()
        # 积分结算：重启不是用户的错，这批任务的预扣**全额退还**。
        # 与"取消不返还"（用户主动取消，出片是 gather 一次性派发、钱基本已花）
        # 刻意区别对待：这里的任务是**没跑完就被进程中断**的，退还才是对的。
        # 放在 commit 之后调：settle 自己开事务，混在同一事务里会互相锁。
        try:
            from .charge import settle
            for j in zombie_jobs:
                settle(j.id, ok=False, reason="后端重启，任务中断")
        except Exception:  # noqa: BLE001
            logger.exception("[maintenance] 僵尸任务积分结算失败（不影响恢复）")
        return {"jobs": len(zombie_jobs), "shots": len(zombie_shots),
                "audio": len(zombie_audio)}


def sweep_orphaned_states() -> dict:
    """巡检并回收**进程存活期间**产生的孤儿瞬时态（B14）。

    ## 为什么启动时清一次不够

    recover_zombie_tasks 只在 lifespan 启动时跑一次，它能盖住"进程死了重启"
    这一种情况。但瞬时态还有别的丢法，且都发生在进程**不重启**的时候：
    runner 协程被取消、`_run_job_guarded` 之外的路径异常退出、job 已落终态
    但某几个镜头的收尾写入没走到。这些镜头会一直停在 generating，
    看板上无限转圈，而后端活得好好的 —— 不重启就永远不会被回收。

    ## 判据：为什么这样判是安全的

    绝不能"超过 N 分钟就置失败"——正在跑的长任务会被误杀（单镜视频 60s+、
    整批可达几十分钟），那比 bug 本身更糟。这里用的是**可证明**的判据：

      瞬时态只由 job runner 写入（已核对：`_set_shot_status` 的 4 个调用点
      全在 jobs.py；`AudioClip.status="generating"` 只出现在 run_tts）。
      因此某项目没有任何 pending/running 的 job 时，它名下还停在瞬时态的行
      **必然**是孤儿 —— 不存在能推进它的执行体。

    保守兜底：若存在活跃 job 但 payload 里读不出 project_id，则无法判断它
    归属哪个项目，本轮整体跳过（宁可漏收，不可误杀）。
    """
    import json as _json

    from .db import AudioClip

    with get_session() as session:
        active = (session.query(Job)
                  .filter(Job.status.in_(("pending", "running"))).all())
        busy: set[str] = set()
        for j in active:
            try:
                pid = _json.loads(j.payload or "{}").get("project_id")
            except ValueError:
                pid = None
            if not pid:
                # 读不出归属 → 无法证明任何项目是空闲的，本轮不动手
                logger.debug("[sweep] 活跃 job %s 无 project_id，跳过本轮", j.id)
                return {"skipped": True, "shots": 0, "audio": 0}
            busy.add(pid)

        shots = [s for s in session.query(Shot)
                 .filter(Shot.status.in_(_SHOT_TRANSIENT)).all()
                 if s.project_id not in busy]
        for s in shots:
            s.status = "failed"
            if not s.fail_reason:
                s.fail_reason = "任务已结束但本镜未收尾（已自动回收，可重试）"
        audio = [a for a in session.query(AudioClip)
                 .filter(AudioClip.status.in_(_AUDIO_TRANSIENT)).all()
                 if a.project_id not in busy]
        for a in audio:
            a.status = "failed"
            a.error = "合成任务已结束但本段未收尾（已自动回收，可重新合成）"
        if shots or audio:
            session.commit()
            logger.warning("[sweep] 回收孤儿瞬时态: %d 镜, %d 段旁白",
                           len(shots), len(audio))
        return {"skipped": False, "shots": len(shots), "audio": len(audio)}


def sweep_stale_agent_runs(*, at_startup: bool = False) -> dict:
    """把**没有执行体在跑**的 agent 轮收尾，并关掉它挂着的审批行。

    ## 为什么必须做（2026-10-27 用户实测）

    `agent_runs.status` 停在 `running` / `pending` 时，`_ensure_no_other_active`
    会拒绝这个项目**新建任何一轮**（409「已有一轮在进行中」）；界面上那一轮还会
    一直显示成"正在跑"。dev 实测就有一条 2026-10-23 建的 run 停在 running，
    进程重启几次都没被动过 —— 那个项目从此再也开不了新的一轮。

    而且它挂着的 `approval=pending` 步骤会一直渲染成「等你点头」，点批准 → 409。
    用户的原话「根本没有批准选项」有一半来自这里。

    ## 判据（与 `sweep_orphaned_states` 同一条思路：可证明的才算孤儿）

      · `at_startup=True`：进程刚起来，库里所有 running/pending 的轮**必然**
        没有执行体（它们只跑在内存里）→ 直接收尾；
      · 平时巡查：某一轮状态是 running/pending，但**没有任何** pending/running
        的 `agent_run` job 指向它 → 没有执行体，收尾。

    ⚠️ `waiting_approval` **不动**：它本来就该停在那里等人，checkpoint 也还在，
    重启后照样能批准。把它置失败等于把用户正要确认的那一步吞掉。
    """
    from .db import AgentRun, Job

    with get_session() as session:
        rows = (session.query(AgentRun)
                .filter(AgentRun.status.in_(("pending", "running"))).all())
        if not rows:
            return {"runs": 0, "closed": 0}
        stale_ids: list[str] = []
        busy: set[str] = set()
        if not at_startup:
            for j in (session.query(Job)
                      .filter(Job.status.in_(("pending", "running")),
                              Job.kind == "agent_run").all()):
                try:
                    rid = json.loads(j.payload or "{}").get("run_id")
                except ValueError:
                    rid = None
                if rid:
                    busy.add(str(rid))
        stale = [r for r in rows if at_startup or str(r.id) not in busy]
        for r in stale:
            r.status = "failed"
            r.error = ("后端重启，这一轮中断（点「继续」可以从断点接着做）"
                       if at_startup else
                       "这一轮没有执行体在跑了（已自动回收，可继续或重新开始）")
        # ⚠️ id 必须在 **session 里**取出来：出了 with 之后访问 `r.id` 会
        # commit 后过期而被 re-load，`DetachedInstanceError`（实测踩过）。
        stale_ids = [str(r.id) for r in stale]
        if stale:
            session.commit()
            logger.warning("[sweep] 回收没有执行体的 agent 轮: %d 个", len(stale))
    # 审批行要单独关：它们不在同一个 session 里，且要写 decided_at
    from .agent import store as agent_store
    closed = 0
    for rid in stale_ids:
        try:
            closed += agent_store.close_pending_approvals(
                rid, result="这一轮已中断，未执行", approval="rejected")
        except Exception:  # noqa: BLE001 — 收尾失败不该拖垮巡检
            logger.warning("[sweep] 关闭 run %s 的审批行失败", rid, exc_info=True)
    return {"runs": len(stale), "closed": closed}


def backup_sqlite() -> str | None:
    """启动时备份 SQLite（仅 sqlite URL 生效），返回备份路径。

    ## 崩溃循环防御

    原来两个缺陷叠加，会让备份在崩溃循环中快速自毁：

    1. **顺序**：backup 在 run_migrations() *之后*——如果迁移本身损坏了数据，
       备份快照的是已损坏的库，等于没有可用的回滚点。
       调用方（main.py）应在迁移之前先调一次此函数。
    2. **保留策略**：`sorted(...)[:-7]` 按文件名（时间戳）排序，每次启动都
       写一份新备份并删掉最旧的一份。Restart=always + RestartSec=5 时，
       35 秒内 7 个槽位就全被崩溃时刻的备份填满，历史备份全部丢失。

    修复方案：
    - **防抖**：同一分钟内不重复备份（5 秒重启根本触发不了下一个槽）
    - **按天去重**：glob 现有备份的日期部分（%Y%m%d），若今天已有备份则跳过
      ——稳定运行的服务每天最多生成一份新备份，槽位不会被频繁重启耗尽
    - **失败继续**：连接或 IO 错误只打日志，不向上抛异常（备份失败不该
      阻止服务启动）
    """
    if not DATABASE_URL.startswith("sqlite"):
        return None
    db_path = Path(DATABASE_URL.split("///", 1)[1])
    if not db_path.exists():
        return None
    backup_dir = db_path.parent / "backups"
    backup_dir.mkdir(exist_ok=True)

    now = datetime.now(timezone.utc)

    # 防抖：同一分钟内已有备份就跳过。
    # 崩溃循环是每 5 秒一次，必然落在同一分钟内 → 拦住。
    # 而正常的手工重启（间隔通常超过一分钟）仍能拿到迁移前的新鲜快照——
    # 这一点很重要：若按"天"跳过，当天下午部署的迁移就没有回滚点了。
    minute_prefix = now.strftime("%Y%m%d_%H%M")
    if list(backup_dir.glob(f"{db_path.stem}_{minute_prefix}*.db")):
        return None

    stamp = now.strftime("%Y%m%d_%H%M%S")
    dest = backup_dir / f"{db_path.stem}_{stamp}.db"

    # sqlite backup API：对热库安全（直接 cp 可能拿到写一半的页）
    src = dst = None
    try:
        src = sqlite3.connect(str(db_path))
        dst = sqlite3.connect(str(dest))
        with dst:
            src.backup(dst)
    except Exception as exc:  # noqa: BLE001
        # 备份失败不能让服务起不来——只记录，继续
        logger.error("[backup] 备份失败: %s", exc)
        try:
            dest.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    finally:
        if src:
            src.close()
        if dst:
            dst.close()

    # 只按天保留，每天一份；超出 BACKUP_KEEP_DAYS 的按日期删最旧的
    all_backups = sorted(backup_dir.glob(f"{db_path.stem}_*.db"))
    # 以 YYYYMMDD 为 key 去重，同天多份只保最新
    by_day: dict[str, Path] = {}
    for f in all_backups:
        day = f.stem[len(db_path.stem) + 1:len(db_path.stem) + 9]
        by_day[day] = f   # 同 key 后写覆盖前写（sorted → 最新在后）

    days_sorted = sorted(by_day)
    to_keep = set(by_day[d] for d in days_sorted[-BACKUP_KEEP_DAYS:])
    for f in all_backups:
        if f not in to_keep:
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass

    return str(dest)


#: 备份在桶里的前缀（相对 `tos_key_prefix`）。不在 `tos_dirs` 里，
#: `media_store.managed_rel` 也把它排除在外：它永远不会被签成对外地址。
BACKUP_TOS_PREFIX = "backups"

#: 已复制进桶的备份旁边放一个同名加此后缀的标记文件。
_TOS_MARK = ".tos"


def _backup_dir() -> tuple[Path, str] | None:
    if not DATABASE_URL.startswith("sqlite"):
        return None
    db_path = Path(DATABASE_URL.split("///", 1)[1])
    d = db_path.parent / "backups"
    return (d, db_path.stem) if d.is_dir() else None


def upload_backups() -> dict:
    """把还没进桶的备份复制到 `backups/<文件名>`；本地已按保留策略删掉的，
    桶里那份一起删。返回 {uploaded, removed}。由常驻巡检按轮调用，同步。

    启动时不传：`backup_sqlite` 跑在启动路径上，桶不通时不能让服务起不来。
    每份备份传成功后写一个 `<备份>.tos` 标记，下一轮不再传。
    """
    from . import storage
    from .media_store import note_failure

    out = {"uploaded": 0, "removed": 0}
    found = _backup_dir()
    if found is None or not storage.enabled():
        return out
    d, stem = found
    for f in sorted(d.glob(f"{stem}_*.db")):
        mark = f.with_name(f.name + _TOS_MARK)
        if mark.exists():
            continue
        try:
            storage.put_file(f, f"{BACKUP_TOS_PREFIX}/{f.name}",
                             content_type="application/vnd.sqlite3")
            mark.write_text(datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            encoding="utf-8")
            out["uploaded"] += 1
        except Exception as e:      # noqa: BLE001
            note_failure("backup", f.name, e)
    for mark in d.glob(f"{stem}_*.db{_TOS_MARK}"):
        db = mark.with_name(mark.name[:-len(_TOS_MARK)])
        if db.exists():
            continue
        try:
            storage.delete(f"{BACKUP_TOS_PREFIX}/{db.name}")
            mark.unlink(missing_ok=True)
            out["removed"] += 1
        except Exception as e:      # noqa: BLE001
            note_failure("backup", db.name, e)
    return out
