"""Resolve editable-draft clocks and declared audio roles without inspecting speech."""

import json
import math
import os
from pathlib import Path


def draft_style(timeline: dict, project: Path | None = None) -> dict:
    """Select one saved/project UI-style section; absent fields retain legacy draft defaults."""
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
    return {'watermark': {'font_size_ui': watermark.get('font_size_ui', 6.0)},
            'subtitle': {'font_family': subtitle.get('font_family', '').strip() or None,
                         'font_size_ui': subtitle.get('font_size_ui', 11.0),
                         'border_width_ui': subtitle.get('border_width_ui', 20.0),
                         'transform_y': subtitle.get('transform_y', -0.465625)}}


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
