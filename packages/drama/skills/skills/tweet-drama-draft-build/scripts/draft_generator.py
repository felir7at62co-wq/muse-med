"""Internal material preparation and FFmpeg setup for the Jianying draft builder."""
import os
import sys
import shutil
import logging
import re
import json
import tempfile
import importlib.util
from typing import Dict, Any, Optional
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tweet-drama-core' / 'scripts'))
from video_bans import check_videos, find_project

_policy_spec = importlib.util.spec_from_file_location(
    "drama_delivery_policy", Path(__file__).resolve().parents[2]
    / "tweet-drama-background-render/scripts/delivery_policy.py")
_delivery_policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(_delivery_policy)

logger = logging.getLogger(__name__)


class DraftGenerator:
    """Prepare materials and invoke the local Jianying draft implementation."""

    def __init__(self, ffmpeg_path: str = ""):
        self.ffmpeg_path = ffmpeg_path

    def _setup_ffmpeg(self):
        """Configure an external FFmpeg without importing another skill's paths module."""
        target = (self.ffmpeg_path or os.getenv("DSH_FFMPEG_PATH")
                  or os.getenv("FFMPEG_PATH") or shutil.which("ffmpeg"))
        if not target or not os.path.isfile(target):
            raise FileNotFoundError("Configure DSH_FFMPEG_PATH or install ffmpeg on PATH")
        ffmpeg_dir = os.path.dirname(os.path.abspath(target))
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
        os.environ["FFMPEG_BINARY"] = target
        logger.info(f"FFmpeg 路径已设置: {target}")

    def prepare_materials(
        self,
        audio_dir: str,
        video_dir: str,
        output_materials_dir: str,
        subtitle_dir: Optional[str] = None,
        timeline_dir: Optional[str] = None,
        bgm_dir: Optional[str] = None,
        fallback_video_dir: Optional[str] = None,
        project: Optional[str] = None,
        ending_audio: Optional[str] = None,
        ending_effect: Optional[str] = None,
    ) -> str:
        """
        将项目各步骤的输出整理为 jianji 期望的目录结构。

        期望结构:
            output_materials_dir/
              01_audio/       ← 01.flac, 02.flac, ...
              02_media/
                01/           ← 第1集的视频/图片文件
                02/           ← 第2集的视频/图片文件
              03_subtitle/    ← 01.srt, 02.srt, ... (可选)
              04_bgm/         ← bgm.mp3 (可选)
              05_timeline/    ← 01.timeline.json, ... (可选)
              06_ending/      ← 与成片相同的已选 ending_audio.mp3/ending_effect.mp4 (可选)

        仿真人的 ending_audio/ending_effect 在正文后 2 秒内保持原速独立可编辑；3D 动画忽略片尾素材。
        """
        selected = {}
        for directory in (fallback_video_dir, video_dir):
            if directory:
                for path in Path(directory).glob('*/*'):
                    if path.is_file() and path.parent.name.isdigit():
                        selected[(path.parent.name, path.name)] = path
        videos = [path for path in selected.values() if path.suffix.lower() in {'.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v'}]
        project_root = Path(project) if project else next(
            (path for path in (Path(video_dir).resolve(), *Path(video_dir).resolve().parents)
             if (path / 'project_config.json').is_file()), None)
        if videos:
            project_root = find_project(Path(video_dir), project)
            check_videos(project_root, videos)
        timeline_paths = sorted(Path(timeline_dir).glob('*.timeline.json')) if timeline_dir else []
        policies = [_delivery_policy.resolve_delivery(
            json.loads(path.read_text(encoding='utf-8')), project_root) for path in timeline_paths]
        if not policies:
            policies = [_delivery_policy.resolve_delivery({}, project_root)]
        include_ending = any(policy['ending_duration_us'] for policy in policies)
        ending_files = ({"ending_audio.mp3": ending_audio, "ending_effect.mp4": ending_effect}
                        if include_ending else {})
        for source in ending_files.values():
            if source is not None and not Path(source).is_file():
                raise FileNotFoundError(f"Missing selected ending asset: {source}")
        if include_ending and ending_effect:
            check_videos(find_project(Path(video_dir), project), [Path(ending_effect)])
        # Resolve episode scope and subtitle alignment status before replacing
        # prepared materials. A failed alignment may leave an older SRT behind.
        episodes = set()
        if os.path.exists(audio_dir):
            for filename in os.listdir(audio_dir):
                name = os.path.splitext(filename)[0]
                if name.isdigit():
                    episodes.add(name)
        video_dirs = [path for path in (fallback_video_dir, video_dir)
                      if path and os.path.exists(path)]
        for source_dir in video_dirs:
            for dirname in os.listdir(source_dir):
                if os.path.isdir(os.path.join(source_dir, dirname)) and dirname.isdigit():
                    episodes.add(dirname)
        if subtitle_dir:
            for ep_num in episodes:
                blocked = Path(subtitle_dir) / f"{ep_num}.srt.blocked"
                if blocked.exists():
                    logger.warning(f"字幕对齐待核：{blocked}；保留选择并继续准备草稿，由 Muse 核听决定。")
        bgm_source = None
        if bgm_dir and os.path.exists(bgm_dir):
            candidates = sorted(path for path in Path(bgm_dir).iterdir()
                                if path.is_file() and path.suffix.lower() in
                                {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'})
            if len(candidates) != 1:
                logger.warning(f"BGM 文件夹 {bgm_dir} 有 {len(candidates)} 份候选，暂不选入；Muse 可核对后补充。")
            else:
                bgm_source = candidates[0]
        # Existing prepared materials may contain manual changes.
        if os.path.exists(output_materials_dir):
            target = Path(output_materials_dir).resolve()
            output_materials_dir = tempfile.mkdtemp(prefix=f"{target.name}-candidate-", dir=target.parent)
            logger.info(f"保留已有素材目录，新候选写入 {output_materials_dir}")
        os.makedirs(output_materials_dir, exist_ok=True)

        audio_out = os.path.join(output_materials_dir, "01_audio")
        media_out = os.path.join(output_materials_dir, "02_media")
        os.makedirs(audio_out, exist_ok=True)
        os.makedirs(media_out, exist_ok=True)

        logger.info(f"整理 {len(episodes)} 集素材")

        for ep_num in sorted(episodes):
            for ext in (".flac", ".mp3", ".wav"):
                src = os.path.join(audio_dir, f"{ep_num}{ext}")
                if os.path.exists(src):
                    shutil.copy2(src, audio_out)

            ep_media_out = os.path.join(media_out, ep_num)
            for source_dir in video_dirs:
                video_ep_dir = os.path.join(source_dir, ep_num)
                if not os.path.exists(video_ep_dir):
                    continue
                os.makedirs(ep_media_out, exist_ok=True)
                for f in os.listdir(video_ep_dir):
                    src = os.path.join(video_ep_dir, f)
                    if os.path.isfile(src):
                        # fallback is copied first; sorted video_dir overwrites
                        # the same shot while leaving unmatched shots intact.
                        shutil.copy2(src, ep_media_out)

        if subtitle_dir and os.path.exists(subtitle_dir):
            subtitle_out = os.path.join(output_materials_dir, "03_subtitle")
            os.makedirs(subtitle_out, exist_ok=True)
            for ep_num in sorted(episodes):
                for ext in (".srt", ".ass", ".vtt", ".srt.review.txt", ".srt.blocked"):
                    src = os.path.join(subtitle_dir, f"{ep_num}{ext}")
                    if os.path.exists(src):
                        shutil.copy2(src, subtitle_out)

        if timeline_dir and os.path.exists(timeline_dir):
            timeline_out = os.path.join(output_materials_dir, "05_timeline")
            os.makedirs(timeline_out, exist_ok=True)
            for ep_num in sorted(episodes):
                src = os.path.join(timeline_dir, f"{ep_num}.timeline.json")
                if os.path.exists(src):
                    shutil.copy2(src, timeline_out)

        if bgm_source is not None:
            bgm_out = os.path.join(output_materials_dir, "04_bgm")
            os.makedirs(bgm_out, exist_ok=True)
            shutil.copy2(bgm_source, bgm_out)

        if any(ending_files.values()):
            ending_out = Path(output_materials_dir) / "06_ending"
            ending_out.mkdir()
            for filename, source in ending_files.items():
                if source:
                    shutil.copy2(source, ending_out / filename)

        return output_materials_dir

    def process(
        self,
        materials_dir: str,
        drafts_dir: str,
        name_prefix: str = "",
        template: Optional[str] = None,
        seq: Optional[str] = None,
        project: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not Path(drafts_dir).is_absolute() or not Path(drafts_dir).is_dir():
            raise ValueError('drafts_dir must be the existing absolute editor root returned by drama_draft_dir')

        # 配置 ffmpeg
        self._setup_ffmpeg()

        # 直接调用本地模块
        from jianying_draft import generate_draft

        result = generate_draft(
            drafts_dir=drafts_dir,
            materials_dir=materials_dir,
            name_prefix=name_prefix,
            template_dir=drafts_dir,
            seq=seq,
            project=project,
        )

        logger.info(f"剪映草稿生成结果: {result['drafts_created']} 个已验证草稿，success={result['success']}")
        return result


def _read_text_if_exists(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def _collect_media_shots(ep_num: str, *roots: str) -> list[int]:
    shots = set()
    for root in roots:
        ep_dir = os.path.join(root or "", ep_num)
        if not os.path.isdir(ep_dir):
            continue
        for name in os.listdir(ep_dir):
            if not name.lower().endswith((".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v")):
                continue
            match = re.search(r"(\d+)", os.path.splitext(name)[0])
            if match:
                shots.add(int(match.group(1)))
    return sorted(shots)
