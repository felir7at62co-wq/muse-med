import os
import re
import json
import logging
import shutil
import sys
import subprocess
import hashlib
import math
import importlib.util
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tweet-drama-core' / 'scripts'))
from video_bans import check_videos, find_project
from draft_timing import ENDING_DURATION_US

_policy_spec = importlib.util.spec_from_file_location(
    "drama_delivery_policy", Path(__file__).resolve().parents[2]
    / "tweet-drama-background-render/scripts/delivery_policy.py")
_delivery_policy = importlib.util.module_from_spec(_policy_spec)
_policy_spec.loader.exec_module(_delivery_policy)

_inputs_spec = importlib.util.spec_from_file_location(
    "drama_draft_inputs", Path(__file__).resolve().with_name("draft_inputs.py"))
_draft_inputs = importlib.util.module_from_spec(_inputs_spec)
_inputs_spec.loader.exec_module(_draft_inputs)

_VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if _VENDOR_DIR.is_dir() and str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

_SKILL_ROOT = Path(__file__).resolve().parents[1]
_FFMPEG_DIR = _SKILL_ROOT / "tools" / "ffmpeg"
_FFMPEG_EXE = _FFMPEG_DIR / "ffmpeg.exe"
_FFPROBE_EXE = _FFMPEG_DIR / "ffprobe.exe"
if _FFMPEG_EXE.is_file():
    os.environ.setdefault("FFMPEG_BINARY", str(_FFMPEG_EXE))
    os.environ["PATH"] = str(_FFMPEG_DIR) + os.pathsep + os.environ.get("PATH", "")
if _FFPROBE_EXE.is_file():
    os.environ.setdefault("FFPROBE_BINARY", str(_FFPROBE_EXE))

import pyJianYingDraft as draft

logger = logging.getLogger(__name__)
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class DraftInputError(ValueError):
    """Invalid or incomplete material input for draft generation."""


# 剪映草稿字幕样式：本文件的这些值是**剪映 UI 单位**，不是 draft_content.json 里
# 写出的数字。pyJianYingDraft 按它自己的映射写出文件（见其 text_segment.py）：
#   styles[0].size                      = 字号 UI 值          → 11 写成 11.0
#   letter_spacing                      = 字间距 UI 值 * 0.05 → 0  写成 0.0
#   line_spacing                        = 0.02 + 行间距 * 0.05→ 0  写成 0.02（基线，不是设置）
#   styles[0].strokes[0].width          = 描边 UI 值 / 100 * 0.2 → 20 写成 0.04
# 默认的 UI 值与序列化值使用不同量纲；实际外观仍须在编辑器预览。
# 省略 font 时不写 styles[0].font，不能从文件确认剪映选择的实际字族。
_DEFAULT_DRAFT_STYLE = _draft_inputs.draft_style({})
SUBTITLE_FONT_SIZE = _DEFAULT_DRAFT_STYLE['subtitle']['font_size_ui']
SUBTITLE_LETTER_SPACING = 0
SUBTITLE_BORDER_UI_WIDTH = _DEFAULT_DRAFT_STYLE['subtitle']['border_width_ui']
SUBTITLE_BORDER_COLOR = (0.0, 0.0, 0.0)
SUBTITLE_TRANSFORM_Y = _DEFAULT_DRAFT_STYLE['subtitle']['transform_y']

# 时间线唯一形状：{"clips": [{"shot": 1, "start_us": 0, "duration_us": 10080000}]}，与
# drama_render prepare 写出的 editing/<集>-timeline.json 同形（见其 timeline.ts 的
# 校验与 body_end 推导）。draft_generator 按 <集>.timeline.json 把它复制进 05_timeline/。
# 字段名不一致（例如上游写 shots + start/end）不是"缺时间线"，必须报错而不是退回默认时长。
TIMELINE_CLIP_FIELDS = ("shot", "start_us", "duration_us")
DEFAULT_SHOT_DURATION_US = 5_000_000
"""旧版每段默认时长；正式生成要求实际时间线，不使用该值替代镜头时长。"""
TIMELINE_TOLERANCE_US = 200_000
"""时间线、实测音频与容器自报时长之间的容差（微秒）：容器比时间线多报几帧是正常的。"""

# 字幕文本规则：与成片（tweet-drama-background-render）同一条规则，草稿这里只是执行它。
# 无标点、单行、按语义切分、单条不超过 14 个有效字（空格按半个字计）。两条路径唯一允许的
# 差异是字体/字号/字间距/描边，文本内容不得分叉。
SUBTITLE_MAX_EFFECTIVE_CHARS = 14
SUBTITLE_PUNCTUATION = "，。！？；：、,.!?;:\"'“”‘’（）()《》【】〈〉「」『』…—-·~～"

# 无显式项目音量时保留 SDK 的单位增益；显式 audio 快照与正式渲染使用同一线性增益。
VOICE_VOLUME = 1.0
BGM_VOLUME = 1.0
WATERMARK_TEXT = "内容由AI生成"
WATERMARK_TRACK = "AI内容标识"
WATERMARK_FONT_SIZE = _DEFAULT_DRAFT_STYLE['watermark']['font_size_ui']


def watermark_position(width: int, height: int, font_size_ui: float = WATERMARK_FONT_SIZE) -> tuple[float, float]:
    """Adjust the lower-right text center for its estimated width; preview remains necessary."""
    text_width = len(WATERMARK_TEXT) * 44 * height / 1920 * font_size_ui / WATERMARK_FONT_SIZE
    return max(0.0, 0.90 - text_width / width), -0.8625


def draft_font_choice(name: str | None) -> dict:
    """Describe an exact library reference or a visible default fallback, without downloading fonts."""
    choice = {'requested': name, 'resolved': '剪映系统默认字体', 'resource_id': None,
              'status': 'default', 'warnings': []}
    if name is None:
        return choice
    font = next((item for item in draft.FontType if name in (item.name, item.value.name)), None)
    if font is None or font.value.is_vip:
        reason = '不在当前打包字体目录中' if font is None else '标为会员资源，尚未确认账号许可'
        choice.update(status='fallback', warnings=[
            f'请求字体“{name}”{reason}；已回退剪映系统默认字体，实际字族由剪映决定。'
            '未下载或购买字体；请核对预览，选用可用且获许可的字体后重新生成。'])
        return choice
    choice.update(resolved=font.value.name, resource_id=font.value.resource_id,
                  status='reference_unverified', warnings=[
                      f'已写入字体“{font.value.name}”的剪映资源引用；仅有目录元数据，'
                      '尚未验证本机资源可用性或使用许可，请在剪映预览中核对；未下载字体。'])
    return choice


def draft_ending_plan(timeline_path, clips: dict, project=None) -> dict:
    """Resolve explicit delivery policy, body clock and a permitted already included ending."""
    payload = json.loads(Path(timeline_path).read_text(encoding="utf-8")) if clips else {}
    end = max((clip["start_us"] + clip["duration_us"] for clip in clips.values()), default=0)
    try:
        clock = _draft_inputs.body_clock(payload, end, TIMELINE_TOLERANCE_US, ENDING_DURATION_US)
        policy = _delivery_policy.resolve_delivery(payload, project)
        audio = _draft_inputs.audio_gains(payload, project)
        effect_fit = _delivery_policy.ending_effect_fit(payload)
        style = _draft_inputs.draft_style(payload, project)
        _delivery_policy.reject_animation_ending({**payload, "body_end": clock["body_end_us"] / 1e6}, end, policy)
    except ValueError as error:
        raise DraftInputError(str(error)) from error
    body_end, included = clock["body_end_us"], clock["included"]
    font = draft_font_choice(style['subtitle']['font_family'])
    style_warnings = []
    if (policy['add_watermark'] and len(WATERMARK_TEXT) * 44 * policy['height'] / 1920
            * style['watermark']['font_size_ui'] / WATERMARK_FONT_SIZE > policy['width'] * 0.8):
        style_warnings.append(
            f"AI 内容标识字号 {style['watermark']['font_size_ui']:g} 的估算宽度超过画布安全区域；"
            "已保留项目字号，请预览确认是否越界，并按需调整 delivery.draft_style.watermark.font_size_ui。")
    body_clips = {shot: dict(clip) for shot, clip in clips.items()}
    last_shot = max(clips, key=lambda shot: clips[shot]["start_us"] + clips[shot]["duration_us"]) if clips else None
    if included:
        if body_clips[last_shot]["duration_us"] <= ENDING_DURATION_US:
            raise DraftInputError("已包含的定格必须位于最后一个正文视频末尾，不能替代整段正文镜头。")
        body_clips[last_shot]["duration_us"] -= ENDING_DURATION_US
    cursor = 0
    for clip in sorted(body_clips.values(), key=lambda clip: clip["start_us"]):
        if clip["start_us"] != cursor:
            raise DraftInputError("正文时间线必须连续，不能有重叠或空隙。")
        cursor += clip["duration_us"]
    return {"body_clips": body_clips, "body_end_us": body_end, "included": included,
            "duration_us": body_end + policy["ending_duration_us"], "last_shot": last_shot,
            "canvas": {key: policy[key] for key in ("width", "height")}, "policy": policy,
            "audio": audio, "draft_style": style, "subtitle_font": font,
            "warnings": [*clock["warnings"], *font['warnings'], *style_warnings], "ending_effect_fit": effect_fit}


def draft_decode_timeout_seconds() -> float:
    """Read the per-process decode deadline; invalid deployment settings fail before draft creation."""
    setting = os.environ.get("MUSE_DRAFT_DECODE_TIMEOUT_SECONDS", "120")
    try:
        seconds = float(setting)
    except ValueError as error:
        raise DraftInputError("MUSE_DRAFT_DECODE_TIMEOUT_SECONDS 必须是正数秒数。") from error
    if not math.isfinite(seconds) or seconds <= 0:
        raise DraftInputError("MUSE_DRAFT_DECODE_TIMEOUT_SECONDS 必须是有限的正数秒数。")
    return seconds


def _ffmpeg_output(arguments: list[str]) -> str:
    executable = (os.environ.get("DSH_FFMPEG_PATH") or os.environ.get("FFMPEG_PATH")
                  or os.environ.get("FFMPEG_BINARY") or shutil.which("ffmpeg") or "ffmpeg")
    timeout = draft_decode_timeout_seconds()
    try:
        result = subprocess.run([executable, "-v", "error", *arguments], capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=timeout,
                                creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired as error:
        raise DraftInputError(f"定格解码超过 {timeout:g} 秒，已终止进程；请检查视频，"
                              "或调整 MUSE_DRAFT_DECODE_TIMEOUT_SECONDS 后重试。") from error
    except OSError as error:
        # Windows process startup can omit the executable from its OSError.
        if error.filename is None and getattr(error, 'winerror', None) in (2, 5):
            error.strerror = f"{error.strerror}（解码器：{executable}）"
        raise
    if result.returncode:
        raise DraftInputError(f"定格提取失败：{result.stderr[-2000:]}")
    return result.stdout


def decoded_frame_hashes(source: Path, duration_us: int | None = None) -> list[str]:
    """Hash only decoded RGB video frames, optionally limited to the selected source interval."""
    limit = ["-t", f"{duration_us / 1e6:.6f}"] if duration_us is not None else []
    output = _ffmpeg_output(["-i", str(source), *limit, "-map", "0:v:0", "-pix_fmt", "rgb24",
                             "-f", "framemd5", "-"])
    return [line.split(",")[-1].strip() for line in output.splitlines()
            if line and not line.startswith("#")]


def extract_draft_tail(source: Path, duration_us: int, target: Path) -> str:
    """Extract and verify the last decoded frame of the source interval used in the draft."""
    expected = decoded_frame_hashes(source, duration_us)
    if not expected:
        raise DraftInputError(f"{source} 没有可解码画面，不能制作末帧定格。")
    target.parent.mkdir(parents=True, exist_ok=True)
    _ffmpeg_output(["-y", "-i", str(source), "-map", "0:v:0", "-vf",
                    f"select=eq(n\\,{len(expected) - 1})", "-frames:v", "1", str(target)])
    if not target.is_file() or target.stat().st_size == 0 or decoded_frame_hashes(target) != expected[-1:]:
        raise DraftInputError(f"{source} 的定格图与实际末帧不一致，拒绝交付。")
    return expected[-1]


def append_body_tail_hold(script, video_track, source: Path, selected_duration_us: int,
                          draft_path: Path, shot: int, start_us: int, duration_us: int) -> dict:
    """Fill a short SDK-trimmed body interval with its verified last frame, without retiming media."""
    from pyJianYingDraft.time_util import Timerange
    image = draft_path / "Resources" / f"body_tail_shot_{shot:03d}.png"
    frame_md5 = extract_draft_tail(source, selected_duration_us, image)
    hold = draft.VideoSegment(draft.VideoMaterial(str(image)), Timerange(start_us, duration_us), volume=0)
    with source.open("rb") as stream:
        source_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    image_sha256 = hashlib.sha256(image.read_bytes()).hexdigest()
    script.add_segment(hold, video_track)
    return {"shot": shot, "source": str(source), "source_sha256": source_sha256,
            "selected_duration_us": selected_duration_us, "frame_rgb_md5": frame_md5,
            "image": str(image), "image_sha256": image_sha256,
            "start_us": start_us, "duration_us": duration_us, "material_id": hold.material_id}


def append_draft_ending(script, video_track, source: Path, selected_duration_us: int,
                        draft_path: Path, plan: dict, materials_root: Path) -> None:
    """Add a separately editable freeze and any explicitly supplied ending sound/effect."""
    from pyJianYingDraft.track import TrackSpec
    from pyJianYingDraft.time_util import Timerange
    image = draft_path / "Resources" / "last_video_tail_frame.png"
    frame_md5 = extract_draft_tail(source, selected_duration_us, image)
    segment = draft.VideoSegment(draft.VideoMaterial(str(image)),
                                 Timerange(plan["body_end_us"], ENDING_DURATION_US))
    script.add_segment(segment, video_track)
    ending_assets = materials_root / "06_ending"
    effect_evidence = None
    for filename, kind, track_name in (("ending_audio.mp3", "audio", "片尾音"),
                                      ("ending_effect.mp4", "video", "片尾特效")):
        path = ending_assets / filename
        if kind == "audio" and plan["included"]:
            continue
        if not path.is_file():
            continue
        local = draft_path / "Resources" / filename
        shutil.copy2(path, local)
        track = script.append_track(TrackSpec(getattr(draft.TrackType, kind), track_name))
        material = draft.AudioMaterial(str(local)) if kind == "audio" else draft.VideoMaterial(str(local))
        timerange = Timerange(plan["body_end_us"], min(ENDING_DURATION_US, material.duration))
        if kind == "video" and plan.get("ending_effect_fit") == "stretch_to_window":
            if material.duration <= 0:
                raise DraftInputError("片尾特效必须有可测得的正数时长。")
            timerange = Timerange(plan["body_end_us"], ENDING_DURATION_US)
            ending = draft.VideoSegment(material, timerange,
                                        source_timerange=Timerange(0, material.duration),
                                        speed=material.duration / ENDING_DURATION_US)
        else:
            ending = draft.AudioSegment(material, timerange) if kind == "audio" else draft.VideoSegment(material, timerange)
        if kind == "video":
            ending.volume = 0
            ending.set_mix_mode(draft.MixModeType.滤色)
            effect_evidence = {"fit": plan.get("ending_effect_fit", "source_once"),
                               "source": str(local), "source_sha256": hashlib.sha256(local.read_bytes()).hexdigest(),
                               "source_duration_us": material.duration,
                               "target_start_us": timerange.start, "target_duration_us": timerange.duration,
                               "speed": material.duration / ENDING_DURATION_US
                               if plan.get("ending_effect_fit") == "stretch_to_window" else 1.0}
        script.add_segment(ending, track)
    with source.open("rb") as stream:
        source_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    evidence = {"source": str(source), "source_sha256": source_sha256,
                "source_duration_us": selected_duration_us, "frame_rgb_md5": frame_md5,
                "image": str(image), "image_sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
                "body_end_us": plan["body_end_us"], "duration_us": plan["duration_us"],
                "already_included": plan["included"]}
    if effect_evidence is not None:
        evidence["ending_effect"] = effect_evidence
    (draft_path / "ending-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
                                                     encoding="utf-8")


def append_draft_watermark(script, duration_us: int, canvas: dict, font_size_ui: float = WATERMARK_FONT_SIZE) -> None:
    """Add one editable white AI notice spanning the body and ending, independently of subtitles."""
    from pyJianYingDraft.track import TrackSpec
    from pyJianYingDraft.time_util import Timerange
    from pyJianYingDraft.text_segment import TextSegment, TextStyle
    from pyJianYingDraft.segment import ClipSettings
    x, y = watermark_position(canvas["width"], canvas["height"], font_size_ui)
    track = script.append_track(TrackSpec(draft.TrackType.text, WATERMARK_TRACK))
    segment = TextSegment(WATERMARK_TEXT, Timerange(0, duration_us),
                          style=TextStyle(size=font_size_ui, color=(1.0, 1.0, 1.0), align=2),
                          clip_settings=ClipSettings(transform_x=x, transform_y=y))
    script.add_segment(segment, track)

# 音频文件分析相关导入
try:
    from pydub import AudioSegment
    from pydub.silence import detect_silence
    PYDUB_AVAILABLE = True
except ImportError:
    PYDUB_AVAILABLE = False
    logger.info("pydub 未安装，将使用原始音频（不进行静音消除）")
except Exception:
    PYDUB_AVAILABLE = False


def seq_from_name(name: str) -> str | None:
    m = re.match(r"^(\d{2})", name)
    return m.group(1) if m else None


def find_first_file(folder: Path) -> Path:
    files = [p for p in folder.iterdir() if p.is_file()]
    files.sort(key=lambda p: p.name)
    if not files:
        raise DraftInputError(f"No files in: {folder}")
    return files[0]
def find_subdir_by_prefix(root: Path, prefix: str) -> Path | None:
    if not root.exists():
        return None
    matches = [p for p in root.iterdir() if p.is_dir() and p.name.startswith(prefix)]
    if not matches:
        return None
    matches.sort(key=lambda p: (len(p.name), p.name))
    return matches[0]


def has_mostly_numbered_files(folder):
    """检查文件夹中是否大多数文件以数字开头"""
    import re
    try:
        files = [f for f in folder.iterdir() if f.is_file()]
        if not files:
            return False
        numbered_count = 0
        for f in files:
            if re.match(r'^\d+', f.name):
                numbered_count += 1
        return numbered_count / len(files) >= 0.6
    except Exception:
        return False


def find_all_folders_by_type(root_path, material_type):
    """查找所有匹配类型的文件夹（返回列表）"""
    if not root_path.exists():
        return []

    type_config = {
        'audio': {
            'prefixes': ['01'],
            'keywords': ['音频', 'sound', 'voice', 'audio_files', 'sound_files', '语音素材'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'image': {
            'prefixes': ['02'],
            'keywords': ['图片', 'img', 'pic', '分镜', '场景', '画面', 'image_files', 'pic_files', '图片素材'],
            'extensions': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
        },
        'video': {
            'prefixes': ['02'],
            'keywords': ['视频', 'video', 'vid', '分镜', '场景', '画面', 'video_files', 'vid_files', '视频素材'],
            'extensions': ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']
        },
        'media': {
            'prefixes': ['02'],
            'keywords': ['图片', 'img', 'pic', '视频', 'video', 'vid', '分镜', '场景', '画面', 'media_files', '媒体素材'],
            'extensions': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']
        },
        'bgm': {
            'prefixes': ['04'],
            'keywords': ['背景音乐', 'bgm', '音乐', '配乐', 'bgm_files', 'music_files'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'subtitle': {
            'prefixes': ['03'],
            'keywords': ['字幕', 'subtitle', 'srt', 'caption', 'sub', '字幕文件'],
            'extensions': ['.srt', '.ass', '.ssa', '.vtt']
        }
    }

    config = type_config.get(material_type)
    if not config:
        return []

    subdirs = [p for p in root_path.iterdir() if p.is_dir() and p.name.lower() != "silence"
               and not (material_type == "bgm" and p.name == "06_ending")]
    matches = []

    for subdir in subdirs:
        score = 0
        for prefix in config['prefixes']:
            if subdir.name.startswith(prefix):
                score += 100
                break
        for keyword in config['keywords']:
            if keyword.lower() in subdir.name.lower():
                score += 50
                break
        try:
            file_count = 0
            for file in subdir.iterdir():
                if file.is_file() and any(file.name.lower().endswith(ext) for ext in config['extensions']):
                    file_count += 1
            if file_count > 0:
                score += min(file_count * 10, 80)
            if score > 0:
                matches.append((score, subdir))
        except Exception:
            continue

    matches.sort(key=lambda x: x[0], reverse=True)
    return [subdir for score, subdir in matches]


def get_media_type(folder):
    """检测文件夹中的媒体类型"""
    image_extensions = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
    video_extensions = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']

    has_images = False
    has_videos = False

    try:
        # 首先检查根目录是否有文件
        for file in folder.iterdir():
            if file.is_file():
                if any(file.name.lower().endswith(ext) for ext in image_extensions):
                    has_images = True
                if any(file.name.lower().endswith(ext) for ext in video_extensions):
                    has_videos = True

                # 如果已经找到两种类型，提前结束检查
                if has_images and has_videos:
                    break
    except Exception as e:
        logger.info(f"检测媒体类型时出错: {e}")

    # 如果根目录没有找到文件，检查子文件夹（对于分镜/图片这种包含子文件夹的情况
    if not has_images and not has_videos:
        try:
            for subfolder in folder.iterdir():
                if subfolder.is_dir():
                    # 检查子文件夹中是否有文件
                    for file in subfolder.iterdir():
                        if file.is_file():
                            if any(file.name.lower().endswith(ext) for ext in image_extensions):
                                has_images = True
                            if any(file.name.lower().endswith(ext) for ext in video_extensions):
                                has_videos = True
                        if has_images and has_videos:
                            break
                if has_images and has_videos:
                    break
        except Exception as e:
            logger.info(f"检查子文件夹媒体类型时出错: {e}")

    if has_images and has_videos:
        return 'both'
    elif has_images:
        return 'image'
    elif has_videos:
        return 'video'
    else:
        return 'unknown'


def find_media_folder_smart(root: Path) -> Path | None:
    """智能查找媒体文件夹（支持图片、视频或两者）"""
    # 首先尝试查找图片文件夹
    img_folders = find_all_folders_by_type(root, 'image')
    if img_folders:
        return img_folders[0]

    # 然后尝试查找视频文件夹
    video_folders = find_all_folders_by_type(root, 'video')
    if video_folders:
        return video_folders[0]

    # 最后尝试查找通用媒体文件夹
    media_folders = find_all_folders_by_type(root, 'media')
    if media_folders:
        return media_folders[0]

    # 如果都找不到，尝试查找以02开头的文件夹
    for p in root.iterdir():
        if p.is_dir() and (p.name.startswith('02') or any(keyword in p.name.lower() for keyword in ['图片', '视频', 'media', 'img', 'vid'])):
            return p

    return None


def find_material_folder_smart(root: Path, material_type: str, exclude_folders: list = None) -> Path | None:
    """智能查找素材文件夹"""
    if not root.exists():
        return None

    if exclude_folders is None:
        exclude_folders = []

    type_config = {
        'audio': {
            'prefixes': ['01'],
            'keywords': ['audio', 'voice', 'sound', '音频', '声音', '语音', 'audio_files', 'sound_files', '语音素材'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'image': {
            'prefixes': ['02'],
            'keywords': ['image', 'img', 'pic', 'picture', 'photo', '图片', '照片', '分镜', '场景', '画面', 'image_files', 'pic_files', '图片素材'],
            'extensions': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
        },
        'bgm': {
            'prefixes': ['04'],
            'keywords': ['bgm', 'music', 'background', '背景音乐', '音乐', '配乐', '背景音乐素材', 'bgm_files', 'music_files'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'subtitle': {
            'prefixes': ['03'],
            'keywords': ['subtitle', 'srt', 'caption', '字幕', 'sub', '字幕文件', 'subtitle_files', 'srt_files'],
            'extensions': ['.srt', '.ass', '.ssa', '.vtt']
        }
    }

    config = type_config.get(material_type)
    if not config:
        return None

    # 排除指定的文件夹
    subdirs = [p for p in root.iterdir() if p.is_dir() and p not in exclude_folders
               and not (material_type == "bgm" and p.name == "06_ending")]
    if not subdirs:
        return None

    scored_dirs = []
    for subdir in subdirs:
        score = 0
        # 前缀匹配（最高优先级）
        for prefix in config['prefixes']:
            if subdir.name.startswith(prefix):
                score += 100
                break
        # 关键词匹配
        for keyword in config['keywords']:
            if keyword.lower() in subdir.name.lower():
                score += 50
                break
        # 内容匹配（根据文件类型统计）
        try:
            file_count = 0
            for file in subdir.iterdir():
                if file.is_file():
                    if any(file.name.lower().endswith(ext) for ext in config['extensions']):
                        file_count += 1
                        if material_type == 'bgm':
                            for keyword in ['bgm', 'music', '背景音乐']:
                                if keyword.lower() in file.name.lower():
                                    file_count += 1
            if file_count > 0:
                score += min(file_count * 10, 80)
        except Exception:
            pass
        if score > 0:
            scored_dirs.append((score, subdir))

    if scored_dirs:
        scored_dirs.sort(key=lambda x: x[0], reverse=True)
        return scored_dirs[0][1]

    # 如果没有找到匹配的文件夹，尝试直接按文件内容识别（遍历所有文件夹看是否包含特定类型的文件）
    for subdir in subdirs:
        try:
            has_files = False
            for file in subdir.iterdir():
                if file.is_file() and any(file.name.lower().endswith(ext) for ext in config['extensions']):
                    has_files = True
                    break
            if has_files:
                logger.info(f"WARN: 自动识别到文件夹 '{subdir.name}' 包含 {material_type} 素材")
                return subdir
        except Exception:
            continue

    return None


def seq_from_name_smart(name: str, strategy: str = 'first') -> str | None:
    """
    智能从文件名提取序列编号

    Args:
        name: 文件名
        strategy: 提取策略 ('first'=第一个数字, 'last'=最后一个数字, 'max'=最大数字)

    Returns:
        标准化为2位的序列编号，找不到返回None
    """
    # 提取所有数字
    numbers = re.findall(r'(\d+)', name)
    if not numbers:
        return None

    if strategy == 'first':
        num_str = numbers[0]
    elif strategy == 'last':
        num_str = numbers[-1]
    elif strategy == 'max':
        num_str = max(numbers, key=lambda x: int(x))
    else:
        num_str = numbers[0]

    # 标准化为2位数字（不足补0，超过2位取前2位）
    num = int(num_str)
    return f"{min(num, 99):02d}"


def find_img_pack_smart(media_root: Path, seq: str) -> Path | None:
    """
    智能查找媒体文件夹（支持图片、视频或两者）

    Args:
        media_root: 媒体根目录
        seq: 序列编号（2位字符串）

    Returns:
        找到的媒体文件夹路径，找不到返回None
    """
    if not media_root.exists():
        return None

    seq_num = int(seq)
    seq_1digit = str(seq_num)

    subdirs = [p for p in media_root.iterdir() if p.is_dir()]

    # 1. 精确匹配（优先）
    for subdir in subdirs:
        if subdir.name == seq:
            return subdir

    # 2. 1位数字匹配
    for subdir in subdirs:
        if subdir.name == seq_1digit:
            return subdir

    # 3. 包含匹配（文件夹名包含数字即可）
    for subdir in subdirs:
        numbers = re.findall(r'(\d+)', subdir.name)
        if numbers:
            for num_str in numbers:
                num = int(num_str)
                if num == seq_num:
                    return subdir

    return None


def detect_audio_gaps(audio_path: str, silence_threshold: int = -50, min_silence_len: int = 100) -> list:
    """
    检测音频文件中的静音间隙

    Args:
        audio_path: 音频文件路径
        silence_threshold: 静音阈值（dBFS），默认-50（越负数越安静）
        min_silence_len: 最小静音长度（毫秒），默认50ms

    Returns:
        list: 静音时间范围列表，每个元素包含[start_ms, end_ms, duration_ms]
    """
    if not PYDUB_AVAILABLE:
        return []

    try:
        audio = AudioSegment.from_file(audio_path)

        # 检测静音
        silences = detect_silence(audio, min_silence_len=min_silence_len, silence_thresh=silence_threshold)

        gaps = []
        for start, end in silences:
            duration = end - start
            gaps.append([start, end, duration])
            logger.info(f"    发现静音间隙: 开始={start}ms, 结束={end}ms, 时长={duration}ms")

        return gaps
    except Exception as e:
        logger.info(f"    音频分析失败: {e}")
        return []

def remove_audio_gaps(audio_path: str, silence_threshold: int = -50, min_silence_len: int = 100, keep_silence: int = 130) -> str:
    """
    消除音频文件中的静音间隙

    Args:
        audio_path: 原始音频文件路径
        silence_threshold: 静音阈值（dBFS），默认-50
        min_silence_len: 最小静音长度（毫秒），默认50ms
        keep_silence: 保留的静音长度（毫秒），默认20ms

    Returns:
        str: 处理后的音频文件路径
    """
    if not PYDUB_AVAILABLE:
        return audio_path

    try:
        from pathlib import Path

        audio = AudioSegment.from_file(audio_path)
        logger.info(f"  正在消除音频静音...")

        # 检测静音
        silences = detect_silence(audio, min_silence_len=min_silence_len, silence_thresh=silence_threshold)

        if not silences:
            logger.info(f"  音频没有需要消除的静音")
            return audio_path

        # 生成处理后的音频 - 保留少量静音让过渡更自然
        processed_audio = AudioSegment.empty()
        last_end = 0

        for start, end in silences:
            # 添加静音前的音频片段
            if start > last_end:
                processed_audio += audio[last_end:start]

            # 添加保留的少量静音（平滑过渡）
            processed_audio += AudioSegment.silent(duration=keep_silence)
            last_end = end

        # 添加最后一个片段
        if last_end < len(audio):
            processed_audio += audio[last_end:]

        # 保存处理后的音频文件
        original_path = Path(audio_path)
        # 创建silence文件夹（如果不存在）
        silence_folder = original_path.parent / "silence"
        silence_folder.mkdir(exist_ok=True)
        # 保存到silence文件夹，保持原文件名
        processed_path = silence_folder / f"{original_path.stem}_no_silence{original_path.suffix}"
        processed_audio.export(str(processed_path), format=original_path.suffix[1:])

        original_duration = len(audio)
        processed_duration = len(processed_audio)
        removed = original_duration - processed_duration

        logger.info(f"  原始音频时长: {original_duration}ms")
        logger.info(f"  处理后时长: {processed_duration}ms")
        logger.info(f"  消除静音总时长: {removed}ms")
        logger.info(f"  处理后音频保存至: {processed_path}")

        return str(processed_path)

    except Exception as e:
        logger.info(f"  消除音频静音失败: {e}")
        import traceback
        logger.info(f"  错误详情: {traceback.format_exc()}")
        return audio_path

# 改进的素材替换函数，添加详细的错误处理
def replace_material(script, old_name, new_material, material_type):
    """
    替换素材的函数，添加详细的错误处理和日志
    
    Args:
        script: 草稿脚本对象
        old_name: 旧素材名称
        new_material: 新素材对象
        material_type: 素材类型（用于日志）
    
    Returns:
        bool: 是否替换成功
    """
    try:
        # 尝试使用不同的替换方法
        if hasattr(script, 'replace_material_by_name'):
            logger.info(f"  Trying to replace {material_type} using replace_material_by_name: {old_name}")
            script.replace_material_by_name(old_name, new_material)
            return True
        else:
            logger.info(f"  No replace method found for {material_type}")
            return False
    except Exception as e:
        # 捕获所有异常，避免替换失败导致整个脚本停止
        logger.info(f"  Failed to replace {material_type} {old_name}: {e}")
        return False


def load_edit_timeline(timeline_path) -> dict:
    """读取一集的时间线：{"clips": [{"shot": 1, "start_us": 0, "duration_us": 10080000}]}。

    文件不存在时返回空字典；正式生成会报告缺少时间线，不创建可交付草稿。
    文件存在但不是这个形状时抛 DraftInputError 并指出缺什么，绝不退回默认时长。

    Args:
        timeline_path: 05_timeline/<集>.timeline.json 的路径，可为 None。

    Returns:
        {镜头号: {"start_us": int, "duration_us": int}}，无时间线时为空字典。

    Raises:
        DraftInputError: 文件不可读、不是 JSON 对象、clips 缺失/为空，或某个 clip 的字段缺失、非整数。
    """
    if not timeline_path or not Path(timeline_path).exists():
        return {}
    try:
        with open(timeline_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise DraftInputError(f"时间线 {timeline_path} 读取失败: {exc}；修好这一集的时间线再重跑。") from exc
    if not isinstance(payload, dict):
        raise DraftInputError(f"时间线 {timeline_path} 顶层是 {type(payload).__name__}，应为 JSON 对象。")
    raw_clips = payload.get("clips")
    if raw_clips is None:
        found = sorted(payload.keys())
        legacy = "shots" in payload or ("start" in payload and "end" in payload)
        hint = ("这份时间线用的是 shots + start/end；唯一形状是 "
                '{"clips":[{"shot":1,"start_us":0,"duration_us":10080000}]}，'
                "请让上游按 clips 输出，不要在这里改字段名。") if legacy else (
                "请确认上游写的是 clips（drama_render prepare 的 editing/<集>-timeline.json）。")
        raise DraftInputError(f"时间线 {timeline_path} 没有 clips 字段，实际字段为 {found}。{hint}")
    if not isinstance(raw_clips, list) or not raw_clips:
        raise DraftInputError(
            f"时间线 {timeline_path} 的 clips 为空，一集至少要有 1 个镜头；"
            "拿不到镜头时长的草稿会按每段 5 秒铺，正是要避免的静默错误。")
    clips = {}
    for index, item in enumerate(raw_clips):
        if not isinstance(item, dict):
            raise DraftInputError(f"时间线 {timeline_path} 的第 {index + 1} 个 clip 不是对象：{item!r}")
        missing = [key for key in TIMELINE_CLIP_FIELDS if key not in item]
        if missing:
            raise DraftInputError(
                f"时间线 {timeline_path} 的第 {index + 1} 个 clip 缺字段 {missing}，"
                f"实际字段为 {sorted(item.keys())}；每个 clip 必须含整数 "
                'shot/start_us/duration_us，例如 {"shot":1,"start_us":0,"duration_us":10080000}。')
        values = {}
        for key in TIMELINE_CLIP_FIELDS:
            value = item[key]
            if isinstance(value, bool) or not isinstance(value, int):
                raise DraftInputError(
                    f"时间线 {timeline_path} 的第 {index + 1} 个 clip 的 {key}={value!r} 不是整数；"
                    "时间线的时间是微秒整数，秒数（如 start/end）不是这个形状。")
            values[key] = value
        if values["shot"] <= 0 or values["start_us"] < 0 or values["duration_us"] <= 0:
            raise DraftInputError(
                f"时间线 {timeline_path} 的第 {index + 1} 个 clip 取值非法：{values}；"
                "要求 shot > 0、start_us >= 0、duration_us > 0。")
        shot = values["shot"]
        if shot in clips:
            raise DraftInputError(f"时间线 {timeline_path} 里镜头 {shot} 出现了多次。")
        clips[shot] = {"start_us": values["start_us"], "duration_us": values["duration_us"]}
    logger.info(f"读取时间线 {timeline_path}: {len(clips)} 个镜头, "
                f"合计 {sum(clip['duration_us'] for clip in clips.values()) / 1e6:.3f} 秒")
    return clips


def assert_timeline_matches_audio(clips: dict, audio_duration_us: int, timeline_path) -> None:
    """校验时间线各段时长之和与音频时长一致（容差 TIMELINE_TOLERANCE_US）。

    Args:
        clips: load_edit_timeline 的返回值，必须非空。
        audio_duration_us: 实测主音频时长（微秒）。
        timeline_path: 报错时指出的时间线路径。

    Raises:
        DraftInputError: 两者相差超过容差，报文给出两个时长与差值。
    """
    total = sum(clip["duration_us"] for clip in clips.values())
    delta = total - audio_duration_us
    if abs(delta) > TIMELINE_TOLERANCE_US:
        raise DraftInputError(
            f"时间线 {timeline_path} 的各段时长之和 {total / 1e6:.3f} 秒与音频 "
            f"{audio_duration_us / 1e6:.3f} 秒相差 {abs(delta) / 1e6:.3f} 秒"
            f"（容差 {TIMELINE_TOLERANCE_US / 1e6:.1f} 秒）；"
            "说明时间线与这一集的音频不是同一次产物，先重新生成时间线再出草稿。")


def effective_character_count(text: str) -> float:
    """按字幕排版口径计字：空格算半个字，其余字符各算一个字。"""
    return sum(0.5 if char.isspace() else 1 for char in text)


def _break_long_word(word: str) -> list:
    """没有语义边界可切时，按字数上限硬切一个超长词。"""
    pieces, current = [], ""
    for char in word:
        if current and effective_character_count(current + char) > SUBTITLE_MAX_EFFECTIVE_CHARS:
            pieces.append(current)
            current = ""
        current += char
    if current:
        pieces.append(current)
    return pieces


def normalize_subtitle_text(text: str) -> list:
    """把一句剧本原文规范成交付字幕行：去标点、单行、按语义切分、单条不超过 14 个有效字。

    标点变成语义组之间的空格；空格分组后贪心装箱，超出上限就另起一条。
    返回的每一行都是一条独立字幕（草稿与成片共用这条文本规则）。

    Args:
        text: SRT 里的原始台词。

    Returns:
        规范化后的字幕行列表，至少一行。
    """
    cleaned = re.sub(f"[{re.escape(SUBTITLE_PUNCTUATION)}]+", " ", text or "")
    lines, current = [], ""
    for word in cleaned.split():
        for piece in _break_long_word(word):
            if not current:
                current = piece
            elif effective_character_count(current + " " + piece) <= SUBTITLE_MAX_EFFECTIVE_CHARS:
                current = f"{current} {piece}"
            else:
                lines.append(current)
                current = piece
    if current:
        lines.append(current)
    return lines or [""]


def parse_srt_cues(srt_path, *, allow_empty=False) -> list:
    """读 SRT 的 cue：返回 [{"start_us", "end_us", "text"}]，时间取整到微秒。"""
    try:
        raw = Path(srt_path).read_text(encoding="utf-8-sig")
    except OSError as exc:
        raise DraftInputError(f"字幕文件 {srt_path} 读取失败: {exc}") from exc
    if allow_empty and not raw.strip():
        return []
    timing = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})")

    def to_us(hours: int, minutes: int, seconds: int, millis: int) -> int:
        return ((hours * 60 + minutes) * 60 + seconds) * 1_000_000 + millis * 1000

    cues, current = [], None
    for line in raw.splitlines():
        if current is not None and line.strip():
            current["text"] = f"{current['text']}\n{line.strip()}".strip()
            continue
        match = timing.search(line)
        if match:
            groups = [int(value) for value in match.groups()]
            current = {"start_us": to_us(*groups[:4]), "end_us": to_us(*groups[4:]), "text": ""}
            cues.append(current)
        elif not line.strip():
            current = None
    for cue in cues:
        if cue["end_us"] <= cue["start_us"]:
            raise DraftInputError(f"字幕文件 {srt_path} 里有一条 cue 的结束时间不晚于开始时间：{cue}")
    if not cues:
        raise DraftInputError(f"字幕文件 {srt_path} 里没有可解析的 cue；交付草稿不接受空字幕。")
    return cues


def normalize_srt(srt_path, output_path=None, *, allow_empty=False) -> list:
    """规范化已对齐的短句文字并保留时间；未传输出路径时只校验。"""
    normalized = []
    for index, cue in enumerate(parse_srt_cues(srt_path, allow_empty=allow_empty), start=1):
        lines = normalize_subtitle_text(cue["text"])
        if len(lines) != 1:
            logger.warning(f"字幕文件 {srt_path} 第 {index} 条超过建议长度；保留当前文字与时间，不均分估时。")
            lines = [cue["text"]]
        normalized.append({"start_us": cue["start_us"], "end_us": cue["end_us"], "text": lines[0]})
    if output_path is not None:
        write_srt_cues(output_path, normalized)
    return normalized


def write_srt_cues(output_path, cues: list) -> None:
    """写出 SRT；时间用 HH:MM:SS,mmm。"""
    def stamp(us: int) -> str:
        seconds, millis = divmod(max(us, 0), 1_000_000)
        minutes, seconds = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis // 1000:03d}"

    blocks = [f"{index}\n{stamp(cue['start_us'])} --> {stamp(cue['end_us'])}\n{cue['text']}"
              for index, cue in enumerate(cues, start=1)]
    Path(output_path).write_text("\n\n".join(blocks) + "\n", encoding="utf-8")


def _media_shot_number(media_file: Path) -> int:
    match = re.search(r"(\d+)", media_file.stem)
    return int(match.group(1)) if match else 0


def _segments_of(content: dict, track_type: str) -> list:
    return [segment for track in content.get("tracks", []) if track.get("type") == track_type
            for segment in track.get("segments", [])]


def _duration_us(segment: dict) -> int:
    return int((segment.get("target_timerange") or {}).get("duration", 0))


def verify_draft_delivery(content: dict, clips: dict, audio_duration_us, normalized_cues,
                          ending=None, expect_bgm=False, body_tail_holds=None) -> None:
    """汇总草稿轨道待核项；生成流程将它们返回为提示并保留候选。

    正文镜头和主音频保持原时间线；3D 动画不添加 2 秒片尾定格或 AI 标识。
    仿真人与未声明媒介的旧项目另含 2 秒定格及独立 AI 标识，字幕仅计实际发声。

    Args:
        content: 即将写出的草稿内容（json.loads(script.dumps())）。
        clips: 本集时间线的镜头表，空字典表示这一集没有时间线。
        audio_duration_us: 实测主音频时长（微秒），None 表示音频没能加入。
        normalized_cues: normalize_srt 返回的规范化字幕 cue 列表，None 表示没有导入字幕。
        ending: draft_ending_plan 的结果；省略时正文来自 clips，自动追加 2 秒。
        expect_bgm: 已选择配乐时，要求独立 BGM 轨覆盖完整正文。
        body_tail_holds: 本次生成并验证的短正文末帧补齐记录；不代表 2 秒片尾。

    Raises:
        DraftInputError: 有任何一项不成立，报文逐条列出失败项与实测值。
    """
    failures = []
    selected_style = ending['draft_style'] if ending is not None and 'draft_style' in ending else _draft_inputs.draft_style({})
    subtitle_style = selected_style['subtitle']
    watermark_font_size = selected_style['watermark']['font_size_ui']
    expected_font_id = (ending or {}).get('subtitle_font', {}).get('resource_id')
    video_segments = [segment for track in content.get("tracks", [])
                      if track.get("type") == "video" and track.get("name") == "视频轨道"
                      for segment in track.get("segments", [])]
    audio_segments = [segment for track in content.get("tracks", [])
                      if track.get("type") == "audio" and track.get("name") == "主音频轨道"
                      for segment in track.get("segments", [])]
    video_total = sum(_duration_us(segment) for segment in video_segments)
    audio_total = sum(_duration_us(segment) for segment in audio_segments)
    body_end = max((clip["start_us"] + clip["duration_us"] for clip in clips.values()), default=0)
    include_ending = ending is None or ending["policy"]["ending_duration_us"] > 0
    add_watermark = ending is None or ending["policy"]["add_watermark"]
    total_duration = body_end + (ENDING_DURATION_US if include_ending else 0)
    expected_audio = audio_duration_us
    for track in content.get('tracks', []):
        if track.get('type') == 'video' and track.get('name') == '片尾特效':
            if any(segment.get('volume') != 0 for segment in track.get('segments', [])):
                failures.append('片尾覆盖视频须静音；保留独立片尾音，避免效果自带音频叠播。')
    if ending is not None:
        total_duration = ending["duration_us"]
    if not audio_segments:
        failures.append("主音频轨没有任何片段：音频没能加入草稿。")
    elif expected_audio is not None and abs(audio_total - expected_audio) > TIMELINE_TOLERANCE_US:
        failures.append(f"主音频轨总时长 {audio_total / 1e6:.3f} 秒与实测音频 "
                        f"{expected_audio / 1e6:.3f} 秒不一致。")
    if len(audio_segments) == 1 and int(audio_segments[0].get("target_timerange", {}).get("start", 0)) != 0:
        failures.append("主音频轨必须从 0 秒开始，不能让对白与画面整体错位。")
    if expect_bgm:
        bgm_segments = [segment for track in content.get("tracks", [])
                        if track.get("type") == "audio" and track.get("name") == "BGM轨道"
                        for segment in track.get("segments", [])]
        bgm_total = sum(_duration_us(segment) for segment in bgm_segments)
        if len(bgm_segments) != 1 or (bgm_segments and int(
                bgm_segments[0].get("target_timerange", {}).get("start", 0)) != 0) or (expected_audio is not None
                and abs(bgm_total - expected_audio) > TIMELINE_TOLERANCE_US):
            failures.append("BGM 轨道必须有一段覆盖完整正文的已选混音。")
    if not video_segments:
        failures.append("视频轨没有任何片段。")
    elif abs(video_total - total_duration) > TIMELINE_TOLERANCE_US:
        failures.append(f"视频总时长 {video_total / 1e6:.3f} 秒 != 交付要求 "
                        f"{total_duration / 1e6:.3f} 秒。")
    if clips:
        expected_freezes = 1 if include_ending else 0
        expected_holds = len(body_tail_holds or [])
        if len(video_segments) != len(clips) + expected_freezes + expected_holds:
            failures.append(f"视频段数 {len(video_segments)} != 镜头数 {len(clips)} + {expected_freezes} 个定格"
                            f" + {expected_holds} 个正文末帧补齐。")
    else:
        failures.append("这一集没有时间线（05_timeline/<集>.timeline.json）：无法核对正文镜头时长。")

    video_materials = {material.get("id"): material for material in content.get("materials", {}).get("videos", [])}
    video_paths = {material_id: material.get("path") for material_id, material in video_materials.items()}
    holds = {hold["material_id"]: hold for hold in body_tail_holds or []}
    if len(holds) != len(body_tail_holds or []):
        failures.append("正文末帧补齐记录重复。")
    for material_id, hold in holds.items():
        matching = [segment for segment in video_segments if segment.get("material_id") == material_id]
        if len(matching) != 1:
            failures.append(f"镜头 {hold['shot']} 的正文末帧补齐片段缺失或重复。")
    freeze_segments = []
    for segment in video_segments:
        path = Path(video_paths.get(segment.get("material_id")) or "")
        duration = _duration_us(segment)
        start = int((segment.get("target_timerange") or {}).get("start", 0))
        hold = holds.get(segment.get("material_id"))
        if hold is not None:
            clip = clips.get(hold["shot"])
            sources = [item for item in video_segments if video_paths.get(item.get("material_id")) == hold["source"]
                       and (item.get("target_timerange") or {}).get("start") == (clip or {}).get("start_us")
                       and _duration_us(item) == hold["selected_duration_us"]]
            if (clip is None or path != Path(hold["image"])
                    or video_materials.get(segment.get("material_id"), {}).get("type") != "photo" or start != hold["start_us"]
                    or duration != hold["duration_us"] or not 0 < duration <= TIMELINE_TOLERANCE_US
                    or start != clip["start_us"] + hold["selected_duration_us"]
                    or start + duration != clip["start_us"] + clip["duration_us"]
                    or segment.get("speed") != 1.0 or segment.get("volume") != 0 or len(sources) != 1):
                failures.append(f"镜头 {hold['shot']} 的正文末帧补齐与本次来源和时间线不一致。")
            continue
        if path.name == "last_video_tail_frame.png":
            freeze_segments.append(segment)
            if duration != ENDING_DURATION_US or start != body_end:
                failures.append("末帧定格必须恰好 2 秒并从正文结束开始。")
            continue
        shot = _media_shot_number(path)
        clip = clips.get(shot)
        if (audio_segments and video_materials.get(segment.get("material_id"), {}).get("type") == "video"
                and segment.get("volume") != 0):
            failures.append(f"镜头 {shot} 的源视频音量为 {segment.get('volume', '未声明')}，可能重复对白；"
                            "保留独立对白轨并将该源视频静音。")
        if clip is None:
            failures.append(f"镜头 {shot} 用的是默认时长 {duration / 1e6:.3f} 秒，时间线里没有这个镜头。")
        elif abs(duration - clip["duration_us"]) > TIMELINE_TOLERANCE_US or start != clip["start_us"]:
            failures.append(f"镜头 {shot} 的时间范围与正文时间线不一致。")
    if include_ending and len(freeze_segments) != 1:
        failures.append("主轨必须包含恰好一个可编辑末帧定格图片片段。")
    if not include_ending:
        generated_ending = any(track.get("name") in ("片尾音", "片尾特效")
                               for track in content.get("tracks", []))
        ending_material = any(Path(item.get("path") or "").name in
                              ("last_video_tail_frame.png", "ending_audio.mp3", "ending_effect.mp4")
                              for kind in ("videos", "audios")
                              for item in content.get("materials", {}).get(kind, []))
        if freeze_segments or generated_ending or ending_material:
            failures.append("3D 动画草稿不得包含生成的片尾轨道或定格素材。")
        if abs(content.get("duration", 0) - body_end) > TIMELINE_TOLERANCE_US:
            failures.append("3D 动画草稿总时长必须等于正文，不能含片尾。")

    watermark_segments = [segment for track in content.get("tracks", [])
                          if track.get("type") == "text" and track.get("name") == WATERMARK_TRACK
                          for segment in track.get("segments", [])]
    texts = {material.get("id"): material for material in content.get("materials", {}).get("texts", [])}
    if not add_watermark:
        if watermark_segments or any(track.get("name") == WATERMARK_TRACK for track in content.get("tracks", [])):
            failures.append("3D 动画草稿不得添加 AI 内容标识。")
    elif len(watermark_segments) != 1:
        failures.append("草稿必须包含一个独立可编辑的 AI 内容标识。")
    else:
        watermark = watermark_segments[0]
        material = texts.get(watermark.get("material_id"), {})
        data = json.loads(material.get("content") or "{}")
        styles = data.get("styles") or [{}]
        style = styles[0]
        expected_x, expected_y = watermark_position(content["canvas_config"]["width"],
                                                     content["canvas_config"]["height"], watermark_font_size)
        if (data.get("text") != WATERMARK_TEXT or _duration_us(watermark) != total_duration
                or watermark.get("target_timerange", {}).get("start") != 0):
            failures.append("AI 内容标识必须为“内容由AI生成”并覆盖正文和 2 秒片尾。")
        if (style.get("size") != watermark_font_size or style.get("strokes")
                or style.get("fill", {}).get("content", {}).get("solid", {}).get("color") != [1.0, 1.0, 1.0]):
            failures.append("AI 内容标识必须使用白色、无描边的小字。")
        transform = (watermark.get("clip") or {}).get("transform", {})
        if transform.get("x") != expected_x or transform.get("y") != expected_y:
            failures.append("AI 内容标识必须位于画布右下安全区。")

    text_segments = [segment for track in content.get("tracks", [])
                     if track.get("type") == "text" and track.get("name") != WATERMARK_TRACK
                     for segment in track.get("segments", [])]
    if normalized_cues is None:
        failures.append("草稿里没有字幕轨；交付草稿必须带规范化字幕。")
    elif len(text_segments) != len(normalized_cues):
        failures.append(f"字幕条数 {len(text_segments)} != 规范化后的字幕行数 {len(normalized_cues)}。")

    texts = {material.get("id"): material for material in content.get("materials", {}).get("texts", [])}
    ordered_subtitles = sorted(text_segments, key=lambda segment:
                               int((segment.get("target_timerange") or {}).get("start", 0)))
    for index, (segment, cue) in enumerate(zip(ordered_subtitles, normalized_cues or []), start=1):
        material = texts.get(segment.get("material_id"))
        if material is None:
            continue
        actual_text = json.loads(material.get("content") or "{}").get("text", "")
        if "text" in cue and actual_text != cue["text"]:
            failures.append(f"第 {index} 条字幕文字与已审核 SRT 不一致。")
        if "start_us" in cue and "end_us" in cue:
            span = segment.get("target_timerange") or {}
            actual_start = int(span.get("start", 0))
            actual_end = actual_start + int(span.get("duration", 0))
            if abs(actual_start - cue["start_us"]) > 50_000 or abs(actual_end - cue["end_us"]) > 50_000:
                failures.append(f"第 {index} 条字幕时间与已审核 SRT 相差超过 0.05 秒。")
    for segment in text_segments:
        material = texts.get(segment.get("material_id"))
        if material is None:
            failures.append(f"字幕片段 {segment.get('id')} 找不到对应文本素材。")
            continue
        style = (json.loads(material.get("content") or "{}").get("styles") or [{}])[0]
        strokes = style.get("strokes") or [{}]
        stroke = strokes[0]
        if style.get("size") != subtitle_style['font_size_ui']:
            failures.append(f"字幕字号 {style.get('size')!r} != {subtitle_style['font_size_ui']}。")
        if material.get("letter_spacing") != SUBTITLE_LETTER_SPACING * 0.05:
            failures.append(f"字幕字间距 {material.get('letter_spacing')!r} != "
                            f"{SUBTITLE_LETTER_SPACING * 0.05}。")
        if material.get("line_spacing") != 0.02:
            failures.append(f"字幕行间距 {material.get('line_spacing')!r} != 0.02（基线）。")
        if abs(float(stroke.get("width", 0)) - subtitle_style['border_width_ui'] / 100 * 0.2) > 1e-6:
            failures.append(f"字幕描边 {stroke.get('width')!r} != "
                            f"{subtitle_style['border_width_ui'] / 100 * 0.2}。")
        if (stroke.get("content", {}).get("solid", {}).get("color")) != list(SUBTITLE_BORDER_COLOR):
            failures.append(f"字幕描边颜色 {stroke.get('content')!r} != {list(SUBTITLE_BORDER_COLOR)}。")
        if expected_font_id is None and 'font' in style:
            failures.append('字幕应回退剪映系统默认字体，不写 font 字段。')
        elif expected_font_id is not None and style.get('font', {}).get('id') != expected_font_id:
            failures.append('字幕字体资源引用与本次已解析的项目样式不一致。')
        if (segment.get("clip") or {}).get("transform", {}).get("y") != subtitle_style['transform_y']:
            failures.append(f"字幕纵坐标 {(segment.get('clip') or {}).get('transform')!r} != "
                            f"transform_y={subtitle_style['transform_y']}。")
        text = json.loads(material.get("content") or "{}").get("text", "")
        if any(char in SUBTITLE_PUNCTUATION for char in text):
            failures.append(f"字幕仍带标点：{text!r}。")
        if effective_character_count(text) > SUBTITLE_MAX_EFFECTIVE_CHARS:
            failures.append(f"字幕 {text!r} 有 {effective_character_count(text):.1f} 个有效字，"
                            f"超过 {SUBTITLE_MAX_EFFECTIVE_CHARS}。")
        if "\n" in text:
            failures.append(f"字幕 {text!r} 是两行；交付字幕必须单行。")

    if failures:
        raise DraftInputError("草稿轨道存在待核项：\n  - " + "\n  - ".join(failures))


def main_with_args(args, results=None):
    """Generate candidates in order; retain verified results when a later candidate fails."""
    if results is None:
        results = []
    review_warnings = []

    def warn(message):
        review_warnings.append(message)
        logger.warning(message)

    if not isinstance(args.name_prefix, str) or re.search(r'[<>:"/\\|?*\x00-\x1f]', args.name_prefix):
        raise DraftInputError('name_prefix 只能包含合法的草稿名称字符，不能包含路径或 Windows 保留字符。')
    drafts_dir = Path(args.drafts)
    if not drafts_dir.is_absolute() or not drafts_dir.is_dir():
        raise DraftInputError('drafts_dir must be the existing absolute editor root returned by drama_draft_dir')
    # 如果template-dir为None，使用与drafts相同的目录
    if args.template_dir is None:
        template_dir = drafts_dir
    else:
        template_dir = Path(args.template_dir)
    root = Path(args.materials)

    logger.info(f"正在智能识别素材文件夹...")
    logger.info(f"  [根目录] 素材根目录: {root}")
    logger.info(f"  [根目录] 包含的子文件夹: {[p.name for p in root.iterdir() if p.is_dir()]}")

    audio_dir = find_material_folder_smart(root, 'audio')
    media_dir = find_media_folder_smart(root)
    if media_dir is None:
        raise DraftInputError("无法识别媒体素材文件夹（图片或视频），请确保包含图片或视频文件的文件夹")

    media_type = get_media_type(media_dir)
    if media_type == 'unknown':
        raise DraftInputError("媒体文件夹中没有找到有效的图片或视频文件")

    logger.info(f"  [media] 识别到{'图片+视频' if media_type == 'both' else '图片' if media_type == 'image' else '视频'}文件夹: {media_dir.name}")

    srt_dir = find_material_folder_smart(root, 'subtitle')
    timeline_dir = root / "05_timeline"
    bgm_dir = find_material_folder_smart(root, 'bgm', exclude_folders=[audio_dir])
    if getattr(args, 'require_bgm', False):
        warn('本次要求配乐，草稿将保留配乐检查提示，由 Muse 核对实际轨道。')

    logger.info(f"  [audio] 识别到音频文件夹: {audio_dir.name if audio_dir else '未找到'}")
    logger.info(f"  [bgm] 识别到BGM文件夹: {bgm_dir.name if bgm_dir else '未找到'}")

    if audio_dir is None:
        raise DraftInputError("无法识别音频素材文件夹，请确保包含音频文件的文件夹")
    if bgm_dir is None:
        warning = "未找到明确的 BGM 文件夹；草稿配乐待验收，不能从其他音频文件夹猜选。"
        warn(warning)

    has_srt_dir = (srt_dir is not None) and srt_dir.exists()
    has_timeline_dir = timeline_dir.exists()

    bgm_path = None
    if bgm_dir is not None and bgm_dir.exists():
        # 显示BGM文件夹中的所有文件
        logger.info(f"  [bgm] BGM文件夹中的文件: {[f.name for f in bgm_dir.iterdir() if f.is_file()]}")
        bgm_files = sorted((p for p in bgm_dir.iterdir()
                            if p.is_file() and p.suffix.lower() in ('.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg')),
                           key=lambda p: p.name)
        if len(bgm_files) > 1:
            warn(f"BGM 文件夹 {bgm_dir} 有多个候选，暂不选入；请 Muse 核对后补充。")
            bgm_files = []
        if bgm_files:
            bgm_path = bgm_files[0]
            logger.info(f"  [bgm] 使用BGM文件: {bgm_path.name}")
        else:
            logger.info(f"  [bgm] BGM文件夹为空，将跳过背景音乐")
    if bgm_path is not None:
        audio_role = _draft_inputs.bgm_import(getattr(args, 'bgm_role', None))
        for warning in audio_role['warnings']:
            warn(warning)
        if not audio_role['include']:
            bgm_path = None
    if bgm_path is None:
        warn("当前草稿未选入 BGM；请 Muse 核对任务需要并决定是否补充。")
    logger.info(f"  [audio] 音频文件夹: {audio_dir.name}, 文件示例: {[f.name for f in audio_dir.iterdir() if f.is_file()][:3] if audio_dir else '无'}")

    audio_extensions = {'.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'}
    audios = sorted([p for p in audio_dir.iterdir() if p.is_file() and p.suffix.lower() in audio_extensions],
                    key=lambda p: p.name)
    if not audios:
        raise DraftInputError("01* audio folder is empty")
    if bgm_path is not None and len(audios) > 1 and not args.seq:
        warning = "多个集数共用一份 BGM 混音；请逐集试听确认，建议按集传入 seq 选定配乐。"
        warn(warning)

    # 创建DraftFolder对象用于保存新草稿
    output_folder = draft.DraftFolder(str(drafts_dir))

    # 调试：查看DraftFolder对象的所有方法
    logger.info(f"DraftFolder methods: {dir(output_folder)}")

    # 定义更广泛的占位素材名称列表，增加替换成功率
    audio_placeholders = ["voice.wav", "voice.mp3", "voice.m4a", "audio.wav", "audio.mp3", "01.wav", "01.mp3", "audio", "voice"]
    bgm_placeholders = ["bgm.mp3", "bgm.wav", "music.mp3", "music.wav", "00.mp3", "00.wav", "bgm", "music"]
    
    # 生成图片占位名称列表，包括更多可能的格式
    image_placeholders = []
    for i in range(1, 30):
        # 2位数字格式
        image_placeholders.extend([f"{i:02d}.jpg", f"{i:02d}.jpeg", f"{i:02d}.png", f"{i:02d}.webp", f"{i:02d}.bmp"])
        # 1位数字格式
        image_placeholders.extend([f"{i}.jpg", f"{i}.jpeg", f"{i}.png", f"{i}.webp", f"{i}.bmp"])
    
    # 字幕占位名称列表
    subtitle_placeholders = ["00.srt", "sub.srt", "subtitle.srt", "subtitles.srt", "01.srt", "subtitle"]

    common_warnings = review_warnings.copy()
    for a in audios:
        seq = seq_from_name_smart(a.stem, strategy='first')
        if not seq:
            logger.info(f"  无法从文件名提取序列编号: {a.name}，尝试使用文件顺序")
            # 使用文件在列表中的索引作为序号
            seq_idx = audios.index(a) + 1
            seq = f"{seq_idx:02d}"
            logger.info(f"  使用序号: {seq}")
        
        # 只处理指定的序列
        if args.seq and seq != args.seq:
            continue

        review_warnings[:] = common_warnings
        draft_name = f"{args.name_prefix}{seq}"
        draft_path = drafts_dir / draft_name
        result = {"episode": seq, "name": draft_name, "path": str(draft_path),
                  "id": "", "success": False, "error": "草稿尚未完成保存校验。"}
        results.append(result)

        img_pack = find_img_pack_smart(media_dir, seq)
        if not img_pack:
            raise DraftInputError(f"[序列 {seq}] 无法找到对应的媒体文件夹，未生成草稿。")

        logger.info(f"[序列 {seq}] 找到媒体文件夹: {img_pack}")
        logger.info(f"[序列 {seq}] 媒体文件夹内容: {[f.name for f in img_pack.iterdir()]}")

        srt_path = (srt_dir / f"{seq}.srt") if has_srt_dir else None
        timeline_path = (timeline_dir / f"{seq}.timeline.json") if has_timeline_dir else None
        timeline_clips = load_edit_timeline(timeline_path)

        # 获取媒体文件列表 - 直接在当前序列文件夹中搜索所有图片和视频文件
        image_extensions = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
        video_extensions = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']

        media_files = []
        for p in img_pack.iterdir():
            if p.is_file():
                if any(p.name.lower().endswith(ext) for ext in image_extensions + video_extensions):
                    media_files.append(p)

        logger.info(f"[序列 {seq}] 找到 {len(media_files)} 个媒体文件: {[f.name for f in media_files]}")

        if not media_files:
            raise DraftInputError(f"[序列 {seq}] 媒体文件夹为空：{img_pack}，未生成草稿。")

        videos = [path for path in media_files if path.suffix.lower() in video_extensions]
        if videos:
            source_hashes = check_videos(find_project(root, getattr(args, 'project', None)), videos)

        if draft_path.exists():
            raise DraftInputError(f"{draft_path} 已存在，拒绝覆盖；请为新候选指定唯一 name_prefix。")

        if not timeline_clips:
            raise DraftInputError(f"这一集没有时间线 {timeline_path}，不能交付草稿。")
        project = getattr(args, 'project', None)
        if project is None:
            project = next((path for path in (root, *root.parents)
                            if (path / 'project_config.json').is_file()), None)
        ending_plan = draft_ending_plan(timeline_path, timeline_clips, project)
        for warning in ending_plan['warnings']:
            warn(warning)
        ending_effect = root / "06_ending" / "ending_effect.mp4"
        if ending_plan["policy"]["ending_duration_us"] and ending_effect.is_file():
            check_videos(find_project(root, project), [ending_effect])
        if ending_plan["policy"]["ending_duration_us"]:
            draft_decode_timeout_seconds()
        body_clips = ending_plan["body_clips"]
        canvas = ending_plan["canvas"]

        # 同编号视频优先，参考图片不重复成为正文镜头。
        selected_media = {}
        for path in media_files:
            shot = _media_shot_number(path)
            prior = selected_media.get(shot)
            if prior is not None and prior.suffix.lower() in video_extensions:
                if path.suffix.lower() in video_extensions:
                    raise DraftInputError(f"镜头 {shot} 有多个视频版本，请只保留本次选定版本。")
                continue
            selected_media[shot] = path
        media_files = sorted(selected_media.values(), key=_media_shot_number)

        subtitle_marker = (srt_dir or root / '03_subtitle') / f"{seq}.srt.blocked"
        for note in [subtitle_marker, subtitle_marker.with_suffix('.review.txt')]:
            if note.is_file() and note.read_text(encoding='utf-8').strip():
                warn(f"字幕对齐待核：{note}；保留选择继续生成，由 Muse 核听决定是否调整。")
        allow_empty_subtitle = getattr(args, 'allow_empty_subtitle_seq', None) == seq
        if srt_path and srt_path.exists():
            checked_cues = normalize_srt(srt_path, allow_empty=allow_empty_subtitle)
            if any(effective_character_count(cue['text']) > SUBTITLE_MAX_EFFECTIVE_CHARS for cue in checked_cues):
                warn(f"字幕 {srt_path} 超过建议长度，保留原文和时间，请 Muse 核对。")
        else:
            warn(f"当前候选没有已选字幕：{seq}；请 Muse 核对任务需要并决定是否补充。")

        def refuse(message: str):
            """报出输入契约违规，并删掉本次刚建的草稿目录，避免半成品挡住重跑。"""
            logger.error(f"[{draft_name}] {message}")
            shutil.rmtree(draft_path, ignore_errors=True)
            raise DraftInputError(message)

        try:
            script = output_folder.create_draft(draft_name, width=canvas["width"], height=canvas["height"], fps=ending_plan["policy"]["fps"])
        except Exception as error:
            raise DraftInputError(f"创建草稿 {draft_path} 失败：{error}") from error
        logger.info(f"[{draft_name}] Successfully created new draft: {draft_name} "
                    f"with {canvas['width']}x{canvas['height']} at {ending_plan['policy']['fps']:g}fps")

        # 禁用主轨道吸附（主轨磁吸），避免自动对齐导致的间隙
        script.maintrack_adsorb = False
        script.content.setdefault("config", {})["subtitle_sync"] = False
        script.content["config"]["lyrics_sync"] = False
        script.content["config"]["attachment_info"] = []
        script.content["relationships"] = []
        logger.info(f"[{draft_name}] Disabled main track adsorb to prevent gap issues")

        # 检查脚本对象的结构
        logger.info(f"[{draft_name}] Checking script structure...")
        logger.info(f"  Script type: {type(script)}")
        logger.info(f"  Script dir: {dir(script)}")
        
        # 尝试获取脚本的轨道信息
        try:
            if hasattr(script, 'get_tracks'):
                tracks = script.get_tracks()
                logger.info(f"[{draft_name}] Tracks: {tracks}")
            elif hasattr(script, 'tracks'):
                logger.info(f"[{draft_name}] Tracks: {script.tracks}")
        except Exception as e:
            logger.info(f"[{draft_name}] Failed to get tracks: {e}")
        
        # 检查是否是新创建的草稿（没有模板素材）
        is_new_draft = True
        audio_duration = None
        main_audio_added = False
        body_tail_holds = []
        normalized_cues = None
        logger.info(f"[{draft_name}] Forcing new draft mode - will add all materials to timeline")
        
        if is_new_draft:
            # 新创建的草稿，直接添加素材到时间线
            logger.info(f"[{draft_name}] Adding materials to new draft...")
            
            # 1) 添加主音频轨道和音频
            logger.info(f"[{draft_name}] Adding main audio...")
            try:
                # 保留主音频的停顿和字幕时钟，不做去静音处理。
                processed_audio_path = str(a)
                voice_new = draft.AudioMaterial(processed_audio_path)

                # 添加音频轨道
                from pyJianYingDraft.track import TrackSpec
                audio_track = script.append_track(TrackSpec(draft.TrackType.audio, "主音频轨道"))
                # 创建音频片段并添加到轨道
                from pyJianYingDraft.time_util import Timerange, tim
                audio_duration = voice_new.duration
                audio_segment = draft.AudioSegment(voice_new, Timerange(0, audio_duration))
                audio_segment.volume = ending_plan['audio']['master_gain']
                script.add_segment(audio_segment, audio_track)
                main_audio_added = True
                logger.info(f"[{draft_name}] Successfully added main audio to timeline")
                logger.info(f"[{draft_name}] Main audio volume: {audio_segment.volume}")
            except Exception as e:
                logger.info(f"[{draft_name}] Failed to add main audio: {e}")

            # 2) 添加 BGM 轨道和音频（确保与主音频时长一致）
            if bgm_path is not None:
                logger.info(f"[{draft_name}] Adding BGM...")
                try:
                    bgm_new = draft.AudioMaterial(str(bgm_path))
                    from pyJianYingDraft.track import TrackSpec
                    bgm_track = script.append_track(TrackSpec(draft.TrackType.audio, "BGM轨道"))

                    bgm_duration = bgm_new.duration
                    total_audio_duration = audio_duration

                    logger.info(f"[{draft_name}] Main audio duration: {total_audio_duration} us")
                    logger.info(f"[{draft_name}] BGM duration: {bgm_duration} us")

                    if total_audio_duration is None:
                        raise DraftInputError("主音频时长不可用，无法校验 BGM 覆盖范围。")
                    if bgm_duration + TIMELINE_TOLERANCE_US < total_audio_duration:
                        warn("BGM 时长短于正文；保留已有音轨，不自动循环补齐，请 Muse 决定是否补充。")
                    if bgm_duration > total_audio_duration:
                        bgm_segment = draft.AudioSegment(bgm_new, Timerange(0, total_audio_duration))
                        logger.info(f"[{draft_name}] BGM trimmed to match main audio duration")
                    else:
                        bgm_segment = draft.AudioSegment(bgm_new, Timerange(0, bgm_duration))
                        logger.info(f"[{draft_name}] BGM shorter than main audio, using full BGM duration")

                    bgm_segment.volume = ending_plan['audio']['bgm_gain']
                    script.add_segment(bgm_segment, bgm_track)
                    logger.info(f"[{draft_name}] Successfully added BGM to timeline (volume: {bgm_segment.volume})")
                except Exception as e:
                    warn(f"剪映草稿 BGM 未导入：{e}；其他轨道继续保留，请 Muse 核对。")

            # 3) 添加视频轨道和媒体（图片或视频）
            logger.info(f"[{draft_name}] Adding media...")
            media_added_count = 0
            try:
                # 添加视频轨道
                from pyJianYingDraft.track import TrackSpec
                video_track = script.append_track(TrackSpec(draft.TrackType.video, "视频轨道"))

                # 正文时间线与实测主音频共用同一时钟。
                from pyJianYingDraft.time_util import Timerange, tim

                if audio_duration is not None:
                    try:
                        assert_timeline_matches_audio(timeline_clips, audio_duration, timeline_path)
                    except DraftInputError as error:
                        refuse(str(error))
                last_source = None
                last_duration = None

                for idx, media_file in enumerate(media_files, start=1):
                    try:
                        logger.info(f"[{draft_name}] Processing media {idx}: {str(media_file)}")

                        media_material = draft.VideoMaterial(str(media_file))

                        shot = _media_shot_number(media_file)
                        clip = body_clips.get(shot)
                        if clip is None:
                            refuse(f"时间线 {timeline_path} 里没有镜头 {shot}（{media_file.name}）；"
                                   "请重新整理这一集的选定媒体和时间线。")
                        else:
                            start_time = int(clip["start_us"])
                            duration = int(clip["duration_us"])
                            # Container-reported duration can be a few frames longer than
                            # Jianying's decoded media duration. Keep the whole source clip
                            # without requesting an invalid overrun.
                            if media_file.suffix.lower() in video_extensions:
                                duration = min(duration, int(media_material.duration))

                        gap = int(clip["duration_us"]) - duration
                        frame_us = round(1_000_000 / ending_plan["policy"]["fps"])
                        micro_retime = (media_file.suffix.lower() in video_extensions
                                        and 0 < gap <= frame_us)
                        if micro_retime:
                            # Spread a sub-frame container/SDK duration difference across the
                            # moving shot. A still image at every cut is visible in Jianying.
                            video_segment = draft.VideoSegment(
                                media_material, Timerange(start_time, int(clip["duration_us"])),
                                source_timerange=Timerange(0, duration))
                        else:
                            video_segment = draft.VideoSegment(media_material, Timerange(start_time, duration))
                        if main_audio_added:
                            video_segment.volume = 0
                        script.add_segment(video_segment, video_track)
                        logger.info(f"[{draft_name}] Successfully added media {idx} to timeline")
                        media_added_count += 1

                        if shot == ending_plan["last_shot"]:
                            last_source, last_duration = media_file, duration
                        if micro_retime:
                            logger.info(f"镜头 {shot} 的 {gap / 1e6:.6f} 秒尾差均匀微调速，未添加定格帧")
                        elif gap > 0:
                            warn(f"镜头 {shot} 的正文缺口 {gap / 1e6:.6f} 秒不适合微调速；"
                                 "不自动补定格帧，保留原片供核对。")

                    except DraftInputError:
                        raise
                    except Exception as e:
                        logger.info(f"[{draft_name}] Failed to add media {idx}: {e}")
            except DraftInputError:
                raise
            except Exception as e:
                logger.info(f"[{draft_name}] Failed to add media: {e}")

            logger.info(f"[{draft_name}] Added {media_added_count} out of {len(media_files)} media files to timeline")
            if body_tail_holds:
                (draft_path / 'body-tail-evidence.json').write_text(
                    json.dumps({'holds': body_tail_holds}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            try:
                if last_source is None or last_duration is None:
                    raise DraftInputError("最后一个正文镜头未成功加入，不能生成定格。")
                if ending_plan["policy"]["ending_duration_us"]:
                    append_draft_ending(script, video_track, last_source, last_duration, draft_path,
                                        ending_plan, root)
                if ending_plan["policy"]["add_watermark"]:
                    append_draft_watermark(script, ending_plan["duration_us"], canvas,
                                           ending_plan['draft_style']['watermark']['font_size_ui'])
            except Exception as error:
                refuse(f"定格或AI标识创建失败：{error}")

            # 4) 导入字幕：先按共用文本规则规范化，再导入规范化后的那份
            if srt_path and srt_path.exists():
                logger.info(f"[{draft_name}] Importing subtitle...")
                normalized_srt = draft_path / f"{seq}.normalized.srt"
                try:
                    normalized_cues = normalize_srt(srt_path, normalized_srt, allow_empty=allow_empty_subtitle)
                except DraftInputError as error:
                    refuse(str(error))
                logger.info(f"[{draft_name}] 字幕 {len(normalized_cues)} 条（去标点/单行/≤"
                            f"{SUBTITLE_MAX_EFFECTIVE_CHARS} 有效字），写出 {normalized_srt}")
                if not normalized_cues:
                    logger.info(f"[{draft_name}] 全部对白字已保留在源画面；不导入空的后加字幕轨。")
                elif not hasattr(script, 'import_srt'):
                    warn("剪映草稿库缺少 import_srt，当前候选没有可编辑字幕；请 Muse 核对。")
                try:
                    if normalized_cues and hasattr(script, 'import_srt'):
                        # 导入字幕到文本轨道，设置样式
                        from pyJianYingDraft.text_segment import TextStyle, TextBorder, TextSegment
                        from pyJianYingDraft.segment import ClipSettings

                        # 字幕样式：字幕预排与草稿量纲的约定见文件顶部常量注释，改这里就是改草稿。
                        subtitle_style = ending_plan['draft_style']['subtitle']
                        subtitle_font_id = ending_plan['subtitle_font']['resource_id']
                        subtitle_font = next((item for item in draft.FontType
                                              if item.value.resource_id == subtitle_font_id), None)
                        text_style = TextStyle(
                            size=subtitle_style['font_size_ui'],
                            bold=False,
                            letter_spacing=SUBTITLE_LETTER_SPACING,
                            color=(1.0, 1.0, 1.0),
                            align=1,
                            auto_wrapping=True,
                        )
                        
                        # Keep the verified relative subtitle position on the 2K canvas.
                        clip_settings = ClipSettings(transform_y=subtitle_style['transform_y'])
                        style_reference = TextSegment(
                            "字幕样式",
                            Timerange(0, 500000),
                            font=subtitle_font,
                            style=text_style,
                            clip_settings=clip_settings,
                            border=TextBorder(alpha=1.0, color=SUBTITLE_BORDER_COLOR,
                                              width=subtitle_style['border_width_ui']),
                        )
                        
                        # 导入字幕
                        script.import_srt(
                            str(normalized_srt),
                            "字幕轨道",
                            style_reference=style_reference,
                            clip_settings=clip_settings
                        )
                        logger.info(f"[{draft_name}] Successfully imported subtitle to timeline with style")
                except Exception as e:
                    warn(f"剪映草稿字幕未导入：{e}；其他轨道保留，请 Muse 决定后续处理。")
        else:
            # 从模板复制的草稿，尝试替换素材
            logger.info(f"[{draft_name}] Replacing materials in template...")
            
            # 1) 替换主音频
            logger.info(f"[{draft_name}] Replacing main audio...")
            voice_new = draft.AudioMaterial(str(a))
            replaced = False
            for placeholder in audio_placeholders:
                if replace_material(script, placeholder, voice_new, "audio"):
                    logger.info(f"[{draft_name}] Successfully replaced main audio using placeholder: {placeholder}")
                    replaced = True
                    break
            if not replaced:
                logger.info(f"[{draft_name}] Warning: Failed to replace main audio - no matching placeholder found")

            # 2) 替换 BGM
            if bgm_path is not None:
                logger.info(f"[{draft_name}] Replacing BGM...")
                bgm_new = draft.AudioMaterial(str(bgm_path))
                replaced = False
                for placeholder in bgm_placeholders:
                    if replace_material(script, placeholder, bgm_new, "BGM"):
                        logger.info(f"[{draft_name}] Successfully replaced BGM using placeholder: {placeholder}")
                        replaced = True
                        break
                if not replaced:
                    logger.info(f"[{draft_name}] Warning: Failed to replace BGM - no matching placeholder found")

            # 3) 替换图片
            logger.info(f"[{draft_name}] Replacing images...")
            image_replaced_count = 0
            
            # 尝试获取模板中的所有图片素材，以便更精确地替换
            template_images = []
            try:
                if hasattr(script, 'list_materials'):
                    materials = script.list_materials()
                    template_images = [m for m in materials if any(ext in m.lower() for ext in ['.jpg', '.jpeg', '.png', '.webp', '.bmp'])]
                    logger.info(f"[{draft_name}] Found {len(template_images)} image materials in template")
                    for img in template_images:
                        logger.info(f"  - {img}")
            except Exception as e:
                logger.info(f"[{draft_name}] Failed to list template images: {e}")
            
            # 策略1：如果有模板图片列表，按顺序替换
            if template_images:
                logger.info(f"[{draft_name}] Using template image list for replacement")
                for idx, (template_img, new_img) in enumerate(zip(template_images, images), start=1):
                    img_material = draft.VideoMaterial(str(new_img))
                    if replace_material(script, template_img, img_material, f"image {idx}"):
                        logger.info(f"[{draft_name}] Successfully replaced image {idx} using template name: {template_img}")
                        image_replaced_count += 1
                    else:
                        logger.info(f"[{draft_name}] Warning: Failed to replace image {idx} using template name: {template_img}")
            else:
                # 策略2：尝试使用不同的占位符格式
                logger.info(f"[{draft_name}] Using placeholder strategy for image replacement")
                for idx, img in enumerate(images, start=1):
                    replaced = False
                    img_material = draft.VideoMaterial(str(img))
                    
                    # 尝试使用数字部分进行匹配
                    img_num = str(idx)
                    img_num_2digits = f"{idx:02d}"
                    
                    # 构建更多可能的占位符
                    custom_placeholders = []
                    for num in [img_num, img_num_2digits]:
                        for ext in ['.jpg', '.jpeg', '.png', '.webp', '.bmp']:
                            custom_placeholders.extend([num + ext, 'img' + num + ext, 'image' + num + ext])
                    
                    # 先尝试自定义占位符
                    for placeholder in custom_placeholders:
                        if replace_material(script, placeholder, img_material, f"image {idx}"):
                            logger.info(f"[{draft_name}] Successfully replaced image {idx} using custom placeholder: {placeholder}")
                            replaced = True
                            image_replaced_count += 1
                            break
                    
                    # 如果自定义占位符失败，尝试通用占位符
                    if not replaced:
                        for placeholder in image_placeholders:
                            if replace_material(script, placeholder, img_material, f"image {idx}"):
                                logger.info(f"[{draft_name}] Successfully replaced image {idx} using generic placeholder: {placeholder}")
                                replaced = True
                                image_replaced_count += 1
                                break
                    
                    if not replaced:
                        logger.info(f"[{draft_name}] Warning: Failed to replace image {idx} - no matching placeholder found")
            
            logger.info(f"[{draft_name}] Replaced {image_replaced_count} out of {len(images)} images")

            # 4) 替换字幕
            if srt_path and srt_path.exists() and hasattr(draft, "SubtitleMaterial"):
                logger.info(f"[{draft_name}] Replacing subtitle...")
                srt_new = draft.SubtitleMaterial(str(srt_path))
                replaced = False
                for placeholder in subtitle_placeholders:
                    if replace_material(script, placeholder, srt_new, "subtitle"):
                        logger.info(f"[{draft_name}] Successfully replaced subtitle using placeholder: {placeholder}")
                        replaced = True
                        break
                if not replaced:
                    logger.info(f"[{draft_name}] Warning: Failed to replace subtitle - no matching placeholder found")

        # 保存草稿
        # 验证时间范围，检查音频和视频片段是否连续
        logger.info(f"[{draft_name}] Verifying time ranges for continuity...")
        try:
            # 检查轨道和片段信息
            logger.info(f"  script.tracks: {type(script.tracks)}, {len(script.tracks)} tracks")

            # 检查是否是新创建的草稿模式（is_new_draft）
            if is_new_draft:
                logger.info(f"  New draft mode: materials are being added directly to script.tracks")

            for track_name, track in script.tracks.items():
                logger.info(f"  Track: {track_name} ({len(track.segments)} segments)")
                if len(track.segments) > 0:
                    track_segments = sorted(track.segments, key=lambda x: x.start)
                    for i, seg in enumerate(track_segments):
                        start_time = seg.start
                        duration = seg.duration
                        end_time = seg.end
                        logger.info(f"    [{i}] Start: {start_time} us, Duration: {duration} us, End: {end_time} us")

                        if i > 0:
                            prev_tr = track_segments[i-1]
                            gap = start_time - prev_tr.end
                            if gap > 0:
                                logger.info(f"    WARNING: GAP of {gap} us between segment {i-1} and {i}")
                            elif gap < 0:
                                logger.info(f"    WARNING: OVERLAP of {-gap} us between segment {i-1} and {i}")
                            else:
                                logger.info(f"    Segment {i} starts exactly at end of segment {i-1}")

            logger.info(f"[{draft_name}] Time range verification completed")
        except Exception as e:
            import traceback
            logger.info(f"[{draft_name}] Time range verification failed: {e}")
            logger.info(f"[{draft_name}] Detailed error: {traceback.format_exc()}")

        if videos and check_videos(find_project(root, getattr(args, 'project', None)), videos) != source_hashes:
            refuse("正文视频在草稿生成期间变化，请重新读取当前版本。")
        expected_content = json.loads(script.dumps())
        # Track observations remain visible with the saved candidate.
        try:
            verify_draft_delivery(expected_content, body_clips, audio_duration,
                                  normalized_cues, ending_plan, expect_bgm=bgm_path is not None,
                                  body_tail_holds=body_tail_holds)
        except DraftInputError as error:
            warn(f"草稿轨道待核：{error}；由 Muse 查看实际轨道并决定后续处理。")

        try:
            saved_content = save_verified_draft(script, draft_path, expected_content)
        except DraftInputError as error:
            refuse(str(error))

        # 创建剪映所需的附属文件夹和文件
        draft_path = drafts_dir / draft_name
        if draft_path.exists():
            for subdir in [".backup", "Resources", "subdraft"]:
                (draft_path / subdir).mkdir(exist_ok=True)
            for fname in ["draft_settings", "draft_virtual_store.json", "template_params"]:
                fpath = draft_path / fname
                if not fpath.exists():
                    fpath.touch()

        review_path = draft_path / 'muse-review.json'
        review_path.write_text(json.dumps({
            'status': 'needs_review', 'warnings': review_warnings,
            'draft_style': ending_plan['draft_style'], 'subtitle_font': ending_plan['subtitle_font'],
            'next': '草稿已保存；这不代表创作或交付质量通过，由 Muse 查看实际轨道后继续。'
        }, ensure_ascii=False, indent=2), encoding='utf-8')
        result.update(success=True, id=saved_content.get("id", ""), error="",
                      quality='needs_review', warnings=review_warnings.copy(), review_path=str(review_path))
        logger.info(f"[{draft_name}] Generated and read back successfully: {draft_path}")

    if not results:
        raise DraftInputError(f"没有匹配的音频序列，未生成草稿（seq={args.seq!r}）。")
    return results


def save_verified_draft(script, draft_path: Path, expected_content: dict = None) -> dict:
    """Persist a new candidate and require the saved JSON to equal its checked content."""
    if expected_content is None:
        expected_content = json.loads(script.dumps())
    content_path = draft_path / "draft_content.json"
    try:
        script.save()
    except Exception as save_error:
        try:
            draft_path.mkdir(parents=True, exist_ok=True)
            script.dump(str(content_path))
        except Exception as dump_error:
            raise DraftInputError(
                f"保存草稿 {draft_path} 失败：save={save_error}; dump={dump_error}") from dump_error
    try:
        saved_content = json.loads(content_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise DraftInputError(f"保存后无法回读草稿 {content_path}：{error}") from error
    if saved_content != expected_content:
        raise DraftInputError(f"保存后的草稿 {content_path} 与已校验内容不一致，拒绝交付。")
    if not isinstance(saved_content, dict) or not isinstance(saved_content.get("tracks"), list):
        raise DraftInputError("保存后的 draft_content.json 缺少有效轨道。")
    return saved_content



def generate_draft(
    drafts_dir: str,
    materials_dir: str,
    name_prefix: str = "",
    template_dir: str = None,
    seq: str = None,
    project: str = None,
    require_bgm: bool = False,
    bgm_role: str = None,
    allow_empty_subtitle_seq: str = None,
) -> dict:
    """
    生成剪映草稿（供 DraftGenerator 直接调用）。

    参数:
        drafts_dir: 剪映草稿输出目录
        materials_dir: 素材根目录（包含 01_audio/02_media/04_bgm/03_subtitle）
        name_prefix: 草稿命名前缀
        template_dir: 模板草稿目录（默认与 drafts_dir 相同）
        seq: 只处理指定序列号（可选）
        project: 视频禁用清单所属项目；省略时从素材目录祖先定位
        require_bgm: 兼容调用方的配乐要求，只追加提示，不因选曲未完成阻断草稿
        bgm_role: music_only 或 dialogue_music_mix 用途声明；不表示已经分析音轨确认无对白
        allow_empty_subtitle_seq: 内部已绑定全烧录字幕报告的唯一集号，仅允许其空白后加 SRT

    返回:
        success 仅在至少一个候选完成且全部成功时为 True；drafts_created 只统计已保存并回读一致的草稿。
        drafts 逐项包含 episode/name/path/id/success/error；id 取已保存 JSON，缺失时为空串。
        首个失败即停止，保留此前成功的草稿与结果；error 为本次失败原因。
    """
    import argparse
    args = argparse.Namespace(
        drafts=drafts_dir,
        materials=materials_dir,
        project=project,
        name_prefix=name_prefix,
        template_dir=template_dir,
        template=None,
        seq=seq,
        overwrite=False,
        new_template=None,
        require_bgm=require_bgm,
        bgm_role=bgm_role,
        allow_empty_subtitle_seq=allow_empty_subtitle_seq,
    )
    results = []
    error = ""
    try:
        main_with_args(args, results)
    except Exception as failure:
        error = str(failure) or type(failure).__name__
        logger.error(f"草稿生成失败: {error}")
        if results and not results[-1]["success"]:
            results[-1]["error"] = error
    created = sum(result["success"] for result in results)
    return {"success": not error and created > 0 and created == len(results),
            "drafts_created": created, "drafts": results, "quality": "needs_review",
            "warnings": [warning for result in results for warning in result.get("warnings", [])],
            **({"error": error} if error else {})}
