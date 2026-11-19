"""Adapt a Workshop draft to the installed cloud Muse episode runner."""
import asyncio
from contextlib import asynccontextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
from tempfile import NamedTemporaryFile

from .reverse_storage import encode_catalog, file_sha, local_file, publish, storage_prefix


def config():
    location = os.environ.get("MUSE_WORKSHOP_REVERSE_CONFIG")
    if not location:
        raise ValueError("工坊尚未启用云端 Muse 视频反推，请管理员配置转写服务账号")
    path = Path(location)
    value = json.loads(path.read_text())
    for key in ("stateRoot", "runner", "python", "sdkHome", "sdkPatch", "dsh", "node", "ffprobe", "ffmpeg", "sourceRoot", "mediaRuntime", "skillFiles"):
        item = Path(value[key])
        if not item.is_absolute() or not item.exists():
            raise ValueError(f"Muse 反推配置缺少有效的 {key}")
    for key in ("episodeAttempts", "episodeTimeoutSeconds", "parallelEpisodes"):
        if type(value[key]) is not int or value[key] < 1:
            raise ValueError(f"Muse 反推配置的 {key} 必须为正整数")
    if not value.get("provider") or not value.get("model") or not (Path(value["sdkHome"]) / "account/session.json").is_file():
        raise ValueError("工坊专用 Muse 账号或模型尚未配置")
    if value.get("tosPrefix"):
        storage_prefix(value["tosPrefix"])
        from .oss.client import is_configured
        if not is_configured():
            raise ValueError("已启用反推素材归档，请配置工坊的私有 TOS 桶")
    return path, value


def atomic_json(path, value):
    with NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as file:
        temp = Path(file.name)
        try:
            json.dump(value, file, ensure_ascii=False)
            file.flush()
            os.fsync(file.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    try:
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


async def finish_io(function, *args):
    """Keep the episode lock until an ongoing file or object write has finished."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


@asynccontextmanager
async def lock(paths):
    """Admit one episode per slot across the web and worker processes."""
    while True:
        for path in paths:
            handle = path.open("a+b")
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                handle.close()
                continue
            try:
                yield handle
            finally:
                handle.close()
            return
        await asyncio.sleep(0.25)


def stage(directory, number, video_path, oss_key, frozen):
    """Materialize the same bytes at the same SDK path on every attempt."""
    folder = directory / "source"
    folder.mkdir(exist_ok=True)
    source = folder / f"{number:04d}.mp4"
    if frozen and source.is_file():
        if file_sha(source) != frozen["sourceSHA256"]:
            raise ValueError("本集上次转写的原片已发生变化")
        return source
    with NamedTemporaryFile(dir=folder, delete=False) as file:
        temp = Path(file.name)
    try:
        if oss_key:
            from .oss.client import get_object_to_file
            get_object_to_file(oss_key, str(temp))
        else:
            origin = Path(video_path).resolve(strict=True)
            roots = (Path(os.environ["UPLOADS_DIR"]).resolve(), Path(os.environ.get("VIDEO_TMP_DIR", "/tmp/drama_video")).resolve())
            if not any(origin.is_relative_to(base) for base in roots) or not origin.is_file():
                raise ValueError("视频不在工坊上传目录中")
            shutil.copyfile(origin, temp)
        if not temp.stat().st_size or (frozen and file_sha(temp) != frozen["sourceSHA256"]):
            raise ValueError("视频为空或与原任务来源不符")
        temp.replace(source)
        return source
    finally:
        temp.unlink(missing_ok=True)


async def execute(path, cfg, directory, handles):
    """Launch only the configured SDK environment; keep Workshop credentials out of the child."""
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE") if k in os.environ}
    env.update(HOME=cfg["sdkHome"], PYTHONDONTWRITEBYTECODE="1")
    if cfg.get("pythonPath"):
        env["PYTHONPATH"] = cfg["pythonPath"]
    with (directory / "runner.log").open("ab") as log:
        process = await asyncio.create_subprocess_exec(
            cfg["python"], "-B", cfg["runner"], str(path), str(directory), env=env,
            stdout=log, stderr=log, start_new_session=True, pass_fds=tuple(h.fileno() for h in handles))
        try:
            status = await asyncio.wait_for(process.wait(), timeout=cfg["episodeTimeoutSeconds"])
        finally:
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    await asyncio.wait_for(process.wait(), timeout=10)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
                except ProcessLookupError:
                    await process.wait()
    if status:
        raise RuntimeError("Muse 逐集反推未通过来源核对。已保留任务记录，可查看服务日志后续跑")


async def reserve_revisions(draft_id, orders, revision):
    """Remember which older chapters an explicit rerun still needs to replace."""
    from .db import ScriptDraft, session_scope
    async with session_scope() as db:
        draft = await db.get(ScriptDraft, draft_id, with_for_update=True)
        outline = dict(draft.outline or {})
        pending = dict(outline.get("muse_reverse_pending") or {})
        pending.update((str(order), revision) for order in orders)
        draft.outline = {**outline, "muse_reverse_pending": pending}


async def draft_context(draft_id, order):
    from sqlalchemy import select
    from .db import ScriptChapter, ScriptDraft, session_scope
    async with session_scope() as db:
        draft = await db.get(ScriptDraft, draft_id)
        if draft is None or type(draft.user_id) is not int or draft.user_id < 1:
            raise ValueError("无法确认工坊草稿归属")
        previous = (await db.execute(select(ScriptChapter.full_text).where(
            ScriptChapter.draft_id == draft_id, ScriptChapter.chapter_order == order - 1))).scalar_one_or_none()
        pending = (draft.outline or {}).get("muse_reverse_pending", {}).get(str(order))
        return draft.user_id, max(draft.episode_count or 0, order), previous or "", pending


def cast_rows(value):
    """Keep names and descriptions the Muse character file actually supplies."""
    rows = value.get("characters", [])
    if isinstance(rows, dict):
        rows = [dict(v, name=k) if isinstance(v, dict) else {"name": k} for k, v in rows.items()]
    result = []
    for item in rows if isinstance(rows, list) else []:
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("alias")
        if isinstance(name, str) and name.strip():
            result.append({"alias": name, "appearance": str(item.get("appearance") or ""),
                           "role": str(item.get("role") or item.get("identity") or "")})
    return result


def output_dir(cfg, owner, draft_id, order, revision):
    if not all(type(i) is int and i > 0 for i in (owner, draft_id, order)) or not re.fullmatch(r"initial|[0-9a-f]{32}", revision):
        raise ValueError("无效的工坊反推任务")
    return Path(cfg["stateRoot"]) / str(owner) / str(draft_id) / str(order) / revision


def archive_target(cfg):
    if not cfg.get("tosPrefix"):
        return None
    from .config import get_settings
    from .oss.client import get_client_internal
    return get_client_internal(), get_settings().aliyun_oss_bucket, cfg["tosPrefix"]


async def analyze_video_file(*, draft_id, user_id, draft_title, episode_order, known_characters,
                             video_path=None, oss_key=None, revision=None):
    """Return a checked screenplay, character rows and its private material index to the native pipeline."""
    path, cfg = config()
    if bool(video_path) == bool(oss_key) or type(user_id) is not int or user_id <= 0:
        raise ValueError("视频反推缺少原片或发起人身份")
    owner, total, previous, pending = await draft_context(draft_id, episode_order)
    if revision and pending and revision != pending:
        raise ValueError("本集已提交更新的反推版本")
    episode = output_dir(cfg, owner, draft_id, episode_order, "initial").parent
    episode.mkdir(parents=True, exist_ok=True, mode=0o700)
    async with lock([episode / ".lock"]) as episode_lock:
        marker = episode / "active.json"
        active = revision or pending or (json.loads(marker.read_text()) if marker.exists() else "initial")
        directory = output_dir(cfg, owner, draft_id, episode_order, active)
        directory.mkdir(exist_ok=True, mode=0o700)
        atomic_json(marker, active)
        receipt = directory / "request.json"
        frozen = json.loads(receipt.read_text()) if receipt.exists() else None
        source_ref = oss_key or str(Path(video_path).absolute())
        if frozen and frozen["sourceRef"] != source_ref:
            raise ValueError("原任务的片源已变更，请明确重新反推")
        slots = [Path(cfg["stateRoot"]) / f".slot-{n}" for n in range(cfg["parallelEpisodes"])]
        async with lock(slots) as slot:
            source = await finish_io(stage, directory, episode_order, video_path, oss_key, frozen)
            if not frozen:
                atomic_json(receipt, {"episode": episode_order, "total": total, "title": draft_title,
                                      "source": str(source.relative_to(directory)), "sourceSHA256": await asyncio.to_thread(file_sha, source),
                                      "sourceRef": source_ref, "initiator": user_id, "owner": owner,
                                      "previous": previous, "characters": known_characters})
            await execute(path, cfg, directory, [episode_lock, slot])
            manifest = json.loads((directory / "materials.json").read_text())
            identity = directory.relative_to(cfg["stateRoot"]).as_posix()
            target = archive_target(cfg)
            catalog = await finish_io(publish, directory, manifest, identity, target)
            atomic_json(directory / "catalog.json", catalog)
            files = {f["kind"]: local_file(directory, f["path"]) for f in manifest["files"]}
            text = files["screenplay"].read_text().strip()
            if not text:
                raise ValueError("Muse 交付的本集正文为空")
            output = {"revision": active, "sessionId": manifest["sessionId"], "sourceSHA256": manifest["sourceSHA256"],
                      "manifestSHA256": hashlib.sha256(encode_catalog(catalog)).hexdigest(), "storage": "tos" if target else "local"}
            if target:
                output.update(bucket=catalog["bucket"], manifestKey=catalog["manifestKey"])
            result = {"episode_title": text.splitlines()[0][:20], "episode_synopsis": " ".join(text.split())[:80], "full_text": text, "shots": [],
                      "characters_in_episode": cast_rows(json.loads(files["characters"].read_text())),
                      "muse_materials": output}
            source.unlink(missing_ok=True)
            return result
