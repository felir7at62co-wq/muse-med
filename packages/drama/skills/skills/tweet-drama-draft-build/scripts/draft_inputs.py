"""Resolve editable-draft clocks and declared audio roles without inspecting speech."""

import json
import math
from fractions import Fraction
import os
from pathlib import Path


def subtitle_visual(timeline: dict, project: Path | None = None) -> dict | None:
    """Select a complete reference-canvas subtitle section; an empty snapshot disables it."""
    project_delivery = {}
    if project is not None:
        path = Path(project) / 'project_config.json'
        if path.exists():
            config = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(config, dict) or not isinstance(config.get('project_bible', {}), dict):
                raise ValueError(f'{path}: project_bible must be an object')
            project_delivery = config.get('project_bible', {}).get('delivery', {})
    snapshot = timeline.get('delivery', {})
    fields = ('reference_width', 'reference_height', 'font_size_px', 'outline_px',
              'center_y_ratio', 'max_width_ratio')
    for container, label in ((project_delivery, 'project_bible.delivery'), (snapshot, 'timeline.delivery')):
        if not isinstance(container, dict):
            raise ValueError(f'{label} must be an object')
        if 'subtitle_visual' not in container:
            continue
        section = container['subtitle_visual']
        field = f'{label}.subtitle_visual'
        if not isinstance(section, dict):
            raise ValueError(f'{field} must be an object')
        if not section:
            continue
        if isinstance(section.get('schema_version'), bool) or section.get('schema_version') != 1:
            raise ValueError(f'{field}.schema_version must be 1')
        for key in fields:
            value = section.get(key)
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value)):
                raise ValueError(f'{field}.{key} must be a finite number')
            if key in ('reference_width', 'reference_height', 'font_size_px') and not 0 < value <= 16384:
                raise ValueError(f'{field}.{key} must be positive and at most 16384')
            if key == 'outline_px' and not 0 <= value <= 100:
                raise ValueError(f'{field}.{key} must be between 0 and 100')
            if key == 'center_y_ratio' and not 0 <= value <= 1:
                raise ValueError(f'{field}.{key} must be between 0 and 1')
            if key == 'max_width_ratio' and not 0 < value <= 1:
                raise ValueError(f'{field}.{key} must be greater than 0 and at most 1')
        if 'font_family' in section:
            name = section['font_family']
            if (not isinstance(name, str) or not name.strip() or len(name.strip()) > 128
                    or ',' in name or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in name)):
                raise ValueError(f'{field}.font_family must be a nonempty font name '
                                 'of at most 128 characters without commas or control characters')
    selected = snapshot['subtitle_visual'] if 'subtitle_visual' in snapshot else project_delivery.get('subtitle_visual')
    if not selected:
        return None
    return {**selected, **({'font_family': selected['font_family'].strip()} if 'font_family' in selected else {})}


def draft_subtitle_visual(visual: dict, subtitle_style: dict) -> dict:
    """Keep resolved editor typography and position; reference pixels do not calibrate editor UI units."""
    return {
        'subtitle': {**subtitle_style,
                     'transform_y': subtitle_style.get('transform_y', 1 - 2 * visual['center_y_ratio']),
                     'auto_wrapping': False, 'max_line_width': visual['max_width_ratio']},
        'adapter': {'name': 'jianying-editor-style', 'status': 'needs_preview', 'gui_verified': False,
                    'typography_source': 'delivery.draft_style.subtitle',
                    'unconfigured_editor_fields_use': 'legacy_defaults',
                    'nominal_reference_font_size_px': visual['font_size_px'],
                    'nominal_reference_outline_px': visual['outline_px'],
                    'reference_font_family': visual.get('font_family'),
                    'pixel_equivalence_verified': False, 'line_width_is_fit_guarantee': False},
    }


def draft_style(timeline: dict, project: Path | None = None, *, center_y_ratio: float | None = None) -> dict:
    """Select one UI-style section; the common centre only replaces an unspecified editor position."""
    project_delivery = {}
    if project is not None:
        path = Path(project) / 'project_config.json'
        if path.exists():
            config = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(config, dict) or not isinstance(config.get('project_bible', {}), dict):
                raise ValueError(f'{path}: project_bible must be an object')
            project_delivery = config.get('project_bible', {}).get('delivery', {})
    snapshot = timeline.get('delivery', {})
    for container, label in ((project_delivery, 'project_bible.delivery'), (snapshot, 'timeline.delivery')):
        if not isinstance(container, dict):
            raise ValueError(f'{label} must be an object')
        if 'draft_style' not in container:
            continue
        section = container['draft_style']
        if not isinstance(section, dict):
            raise ValueError(f'{label}.draft_style must be an object')
        for kind in ('watermark', 'subtitle'):
            if kind not in section:
                continue
            row = section[kind]
            field = f'{label}.draft_style.{kind}'
            if not isinstance(row, dict):
                raise ValueError(f'{field} must be an object')
            ranges = {'font_size_ui': (0, 100)}
            if kind == 'subtitle':
                ranges.update({'border_width_ui': (0, 100), 'transform_y': (-1, 1)})
                if 'font_family' in row:
                    name = row['font_family']
                    if (not isinstance(name, str) or not name.strip() or len(name.strip()) > 128
                            or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in name)):
                        raise ValueError(f'{field}.font_family must be a nonempty font name '
                                         'of at most 128 characters without control characters')
            for key, (minimum, maximum) in ranges.items():
                if key not in row:
                    continue
                value = row[key]
                if (isinstance(value, bool) or not isinstance(value, (int, float))
                        or not math.isfinite(value) or not minimum <= value <= maximum
                        or (key == 'font_size_ui' and value == 0)):
                    raise ValueError(f'{field}.{key} must be a finite UI value '
                                     f'between {minimum} and {maximum}'
                                     + (' (positive)' if key == 'font_size_ui' else ''))
    selected = snapshot['draft_style'] if 'draft_style' in snapshot else project_delivery.get('draft_style', {})
    watermark = selected.get('watermark', {})
    subtitle = selected.get('subtitle', {})
    default_position = -0.465625 if center_y_ratio is None else 1 - 2 * center_y_ratio
    return {'watermark': {'font_size_ui': watermark.get('font_size_ui', 6.0)},
            'subtitle': {'font_family': subtitle.get('font_family', '').strip() or None,
                         'font_size_ui': subtitle.get('font_size_ui', 11.0),
                         'border_width_ui': subtitle.get('border_width_ui', 20.0),
                         'transform_y': subtitle.get('transform_y', default_position)}}


def audio_gains(timeline: dict, project: Path | None = None) -> dict:
    """Use an explicit audio snapshot or project section; missing gains retain SDK unit volume."""
    project_delivery = {}
    if project is not None:
        path = Path(project) / 'project_config.json'
        if path.exists():
            config = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(config, dict) or not isinstance(config.get('project_bible', {}), dict):
                raise ValueError(f'{path}: project_bible must be an object')
            project_delivery = config.get('project_bible', {}).get('delivery', {})
    snapshot = timeline.get('delivery', {})
    for container, label in ((project_delivery, 'project_bible.delivery'), (snapshot, 'timeline.delivery')):
        if not isinstance(container, dict):
            raise ValueError(f'{label} must be an object')
        if 'audio' not in container:
            continue
        audio = container['audio']
        if not isinstance(audio, dict):
            raise ValueError(f'{label}.audio must be an object')
        for key in ('master_gain', 'bgm_gain'):
            if key in audio:
                gain = audio[key]
                if (isinstance(gain, bool) or not isinstance(gain, (int, float))
                        or not math.isfinite(gain) or not 0 <= gain <= 8):
                    raise ValueError(f'{label}.audio.{key} must be a finite number from 0 to 8')
    selected = snapshot['audio'] if 'audio' in snapshot else project_delivery.get('audio', {})
    ceiling = float(os.environ.get('DSH_BGM_MAX_GAIN', '8'))
    if not math.isfinite(ceiling) or not 0 <= ceiling <= 8:
        raise ValueError('DSH_BGM_MAX_GAIN must be a finite number from 0 to 8')
    return {'master_gain': selected.get('master_gain', 1.0),
            'bgm_gain': min(selected.get('bgm_gain', 1.0), ceiling)}


def body_clock(timeline: dict, clip_end_us: int, tolerance_us: int, ending_us: int) -> dict:
    """Use clip endpoints, tolerating container tails but retaining an explicit included ending."""
    declared = timeline.get('body_end', clip_end_us / 1_000_000)
    if (isinstance(declared, bool) or not isinstance(declared, (int, float))
            or not math.isfinite(declared) or declared <= 0):
        raise ValueError('时间线 body_end 必须是实际正文结束的正数秒数。')
    declared_us = round(declared * 1_000_000)
    included = clip_end_us - declared_us == ending_us
    warnings = []
    if included:
        body_end_us = declared_us
    elif abs(declared_us - clip_end_us) <= tolerance_us:
        body_end_us = clip_end_us
        if declared_us != clip_end_us:
            warnings.append(
                f'时间线 body_end={declared_us / 1e6:.6f} 秒与 clips 末尾 '
                f'{clip_end_us / 1e6:.6f} 秒存在容器尾差；已按 clips 整数微秒端点归一，'
                '未修改源时间线。')
    else:
        raise ValueError('时间线 body_end 与镜头末尾不符；只有已包含的 2 秒定格可位于正文之后。')
    return {'body_end_us': body_end_us, 'included': included, 'warnings': warnings}


def frame_time_us(frame: int, fps: int) -> int:
    """Serialize one absolute project-frame boundary once, including fractional microseconds."""
    return round(Fraction(frame * 1_000_000, fps))


def project_frame_index(time_us: int, fps: int) -> int:
    """Choose the first serialized frame boundary at or after an integer-microsecond time."""
    nearest = round(Fraction(time_us * fps, 1_000_000))
    if frame_time_us(nearest, fps) == time_us:
        return nearest
    return (time_us * fps + 999_999) // 1_000_000


def project_frame_clock(clips: dict, fps: int, body_end_us: int, ending_us: int) -> dict:
    """Plan shared absolute target boundaries; source selection and audio keep their original clocks."""
    projected = {}
    for shot, clip in clips.items():
        start = project_frame_index(clip['start_us'], fps)
        end = project_frame_index(clip['start_us'] + clip['duration_us'], fps)
        if end <= start:
            return {'status': 'unsupported', 'reason': f'镜头 {shot} 在项目帧网格中不足一帧'}
        projected[shot] = {'original_start_us': clip['start_us'], 'original_duration_us': clip['duration_us'],
                           'start_frame': start, 'end_frame': end, 'start_us': frame_time_us(start, fps),
                           'duration_us': frame_time_us(end, fps) - frame_time_us(start, fps)}
    body_frame = project_frame_index(body_end_us, fps)
    total_frames = body_frame + ending_us * fps // 1_000_000
    return {'status': 'planned', 'fps': fps, 'original_body_end_us': body_end_us,
            'body_end_frame': body_frame, 'body_end_us': frame_time_us(body_frame, fps),
            'total_frames': total_frames, 'duration_us': frame_time_us(total_frames, fps),
            'delta_us': frame_time_us(body_frame, fps) - body_end_us, 'clips': projected}


def bgm_import(role: str | None) -> dict:
    """Separate a declared review mix from a music bed; declarations do not verify its samples."""
    if role == 'dialogue_music_mix':
        return {'role': role, 'include': False, 'content_verified': False, 'warnings': [
            '所选 BGM 声明为 dialogue_music_mix（对白＋音乐审查混音）；'
            '为避免对白叠播，本候选不导入独立 BGM 轨。请另选 music_only 纯音乐轨；草稿仍保留。']}
    if role == 'music_only':
        return {'role': role, 'include': True, 'content_verified': False, 'warnings': []}
    return {'role': 'unknown', 'include': True, 'content_verified': False, 'warnings': [
        '所选 BGM 未声明为 music_only；保留旧输入，但未分析或确认其不含对白。'
        '请核对这不是对白＋音乐审查混音，并逐集试听独立配乐轨。']}
