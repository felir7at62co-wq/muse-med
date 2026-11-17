"""Read-only checks for a saved candidate's identity and embedded video windows."""

from collections.abc import Mapping
from fractions import Fraction
import json
import math
import ntpath
import os
from pathlib import Path
import re
from urllib.parse import unquote
from uuid import UUID


class DraftIntegrityUnavailable(ValueError):
    """Saved evidence is missing or opaque, so verification remains unavailable."""


def _identity_error(detail):
    return ValueError(f'草稿身份校验失败：{detail}。请保留现有草稿和素材，使用新名称生成候选稿；不要覆盖旧稿或自动修改索引。')


def _read_identity_json(path):
    try:
        document = json.loads(path.read_text(encoding='utf-8-sig'))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise DraftIntegrityUnavailable(
            f'无法读取草稿身份凭据 {path.name}；可能缺失或为不可解读格式，身份尚未验收。请保留现有草稿和素材。') from error
    if not isinstance(document, dict):
        raise _identity_error(f'{path.name} 不是 JSON 对象')
    return document


def _uuid(value, label):
    if not isinstance(value, str) or not value.strip():
        raise _identity_error(f'{label} 缺少有效 UUID')
    try:
        return str(UUID(value.strip()))
    except ValueError as error:
        raise _identity_error(f'{label} 不是有效 UUID') from error


def _path_key(value):
    """Normalize absolute local paths, including native local/file resource URIs."""
    value = os.fspath(value)
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError('素材或草稿路径必须是非空本地绝对路径')
    for prefix in ('local:///', 'file:///'):
        if value.startswith(prefix):
            value = unquote(value[len(prefix):])
            if not re.match(r'^[A-Za-z]:[\\/]', value):
                value = '/' + value
            break
    if re.match(r'^/[A-Za-z]:[\\/]', value):
        value = value[1:]
    # Windows absolute paths remain comparable when checking a saved document on POSIX.
    if ntpath.isabs(value) and (ntpath.splitdrive(value)[0] or value.startswith('\\\\')):
        if os.name != 'nt':
            return ntpath.normcase(ntpath.normpath(value))
    value = value.replace('\\', os.sep).replace('/', os.sep)
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('素材或草稿路径必须是本地绝对路径')
    return os.path.normcase(str(path.resolve(strict=False)))


def verify_saved_identity(draft_path, drafts_root, expected_id):
    """Require one saved-directory index entry with the expected UUID, without repair.

    Missing or opaque identity files raise ``DraftIntegrityUnavailable``. Readable
    but inconsistent evidence raises ``ValueError``. Neither case changes files.
    """
    draft, root = Path(draft_path).resolve(), Path(drafts_root).resolve()
    if draft == root or not draft.is_relative_to(root):
        raise _identity_error('保存目录不在指定草稿根目录内')
    expected = _uuid(expected_id, '预期 draft_id')
    unavailable = []
    try:
        meta = _read_identity_json(draft / 'draft_meta_info.json')
    except DraftIntegrityUnavailable as error:
        meta = None
        unavailable.append(error)
    try:
        index = _read_identity_json(root / 'root_meta_info.json')
    except DraftIntegrityUnavailable as error:
        index = None
        unavailable.append(error)
    draft_key = _path_key(draft)
    name = draft.name
    if meta is not None:
        if _uuid(meta.get('draft_id'), 'draft_meta_info.json draft_id') != expected:
            raise _identity_error('保存目录的 draft_id 与本次创建结果不一致')
        if 'draft_fold_path' in meta:
            try:
                meta_key = _path_key(meta['draft_fold_path'])
            except (TypeError, ValueError) as error:
                raise _identity_error('保存目录的 draft_fold_path 格式错误') from error
            if meta_key != draft_key:
                raise _identity_error('保存目录的 draft_fold_path 指向另一目录')
        name = meta.get('draft_name', draft.name)
        if not isinstance(name, str) or not name.strip():
            raise _identity_error('保存目录的 draft_name 格式错误')
    if index is None:
        raise unavailable[0]
    rows = index.get('all_draft_store')
    if not isinstance(rows, list):
        raise _identity_error('根索引缺少 all_draft_store 数组')
    matches = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            row_key = _path_key(row.get('draft_fold_path'))
        except (TypeError, ValueError):
            row_key = None
        # Only the candidate's path, identity or name can make this row relevant.
        try:
            row_id = str(UUID(row.get('draft_id', '')))
        except (ValueError, TypeError, AttributeError):
            row_id = None
        same_name = row.get('draft_name') == name
        if row_key != draft_key and row_id != expected and not same_name:
            continue
        if row_key != draft_key:
            raise _identity_error('根索引中同名或同 ID 的记录指向另一保存目录')
        if _uuid(row.get('draft_id'), '根索引 draft_id') != expected:
            raise _identity_error('根索引 draft_id 与保存目录及本次创建结果不一致')
        if not isinstance(row.get('draft_name'), str) or not row['draft_name'].strip():
            raise _identity_error('根索引的 draft_name 格式错误')
        if meta is not None and row['draft_name'] != name:
            raise _identity_error('根索引 draft_name 与保存目录元数据不一致')
        matches.append(row)
    if len(matches) != 1:
        raise _identity_error('根索引中保存目录的记录缺失或重复')
    if unavailable:
        raise unavailable[0]


def _positive_duration(value, label):
    if type(value) is not int or value <= 0:
        raise ValueError(f'{label} 必须是正整数微秒')
    return value


def _time_range(value, label):
    if (not isinstance(value, dict) or type(value.get('start')) is not int
            or value['start'] < 0):
        raise ValueError(f'{label}.start 必须是非负整数微秒')
    return value['start'], _positive_duration(value.get('duration'), f'{label}.duration')


def _source_bounds(durations, selected, label):
    if durations is None:
        return None
    if not isinstance(durations, Mapping):
        raise ValueError(f'{label}必须是路径到整数微秒的映射')
    bounds = {}
    for path, duration in durations.items():
        key = _path_key(path)
        if key in selected:
            value = _positive_duration(duration, f'探测的{label}')
            if key in bounds and bounds[key] != value:
                raise ValueError(f'同一选定视频存在互相冲突的{label}')
            bounds[key] = value
    if not selected.issubset(bounds):
        raise ValueError(f'部分选定正文视频缺少探测的{label}')
    return bounds


def verify_native_material_durations(document, source_durations):
    """Require read-only native resource metadata to retain each complete source.

    ``source_durations`` maps selected video paths to measured positive integer
    microseconds. A native ``xmldraft`` readback must report ``written: false``
    and include every selected path. Every matching video record, including
    repeated uses of one file, must retain its complete source duration. Native
    integral floats are accepted; missing, fractional or non-finite values fail.
    Unselected resources are ignored, and this function changes no input data.
    """
    if (not isinstance(document, dict) or document.get('protocol') != 'xmldraft'
            or document.get('written') is not False):
        raise ValueError('原生素材回读必须使用 xmldraft 协议且 written=false')
    if not isinstance(source_durations, Mapping) or not source_durations:
        raise ValueError('原生素材时长校验缺少选定正文视频的完整源时长')
    measured = {}
    for path, duration in source_durations.items():
        try:
            key = _path_key(path)
        except (TypeError, ValueError) as error:
            raise ValueError('选定正文视频必须使用本地绝对路径') from error
        expected = _positive_duration(duration, '探测的完整源时长')
        if key in measured and measured[key] != expected:
            raise ValueError('同一选定视频存在互相冲突的完整源时长')
        measured[key] = expected
    resources = document.get('resource_map')
    if not isinstance(resources, list):
        raise ValueError('原生素材回读缺少 resource_map 数组')
    seen = set()
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        try:
            key = _path_key(resource.get('path'))
        except (TypeError, ValueError):
            continue
        if key not in measured:
            continue
        if resource.get('type') != 'video':
            raise ValueError('选定正文视频的原生素材类型不是 video')
        metadata = resource.get('metadata')
        if not isinstance(metadata, dict):
            raise ValueError('选定正文视频的原生素材缺少 metadata')
        duration = metadata.get('duration_us')
        if (type(duration) not in (int, float) or duration <= 0
                or (isinstance(duration, float) and (not math.isfinite(duration) or not duration.is_integer()))):
            raise ValueError('原生素材 duration_us 必须是有限正整数微秒')
        if duration != measured[key]:
            raise ValueError('原生素材 duration_us 与探测的完整源时长不一致')
        seen.add(key)
    if seen != set(measured):
        raise ValueError('原生素材回读未包含所有选定正文视频')


def verify_embedded_source_ranges(content, selected_paths, source_durations=None, *, source_window_durations=None):
    """Check selected embedded body-video windows in saved, readable draft JSON.

    ``selected_paths`` contains absolute body-video paths, not ending images/effects.
    Optional ``source_durations`` maps those paths to probed full-container integer
    microseconds; material duration must retain this complete value, even when
    only a shorter source window is selected on the timeline. The optional keyword
    ``source_window_durations`` separately bounds source windows by playable video
    stream duration, which may be shorter than a container with an audio tail.
    Every selected path must occur in a video segment. Split segments and nonzero
    source starts are valid. Audio, captions and unselected media retain their own
    contracts. This checks metadata, not actual editor trim/export output.
    """
    if not isinstance(content, dict):
        raise ValueError('草稿内容必须是可读 JSON 对象，源时窗尚未验收')
    selected = {_path_key(path) for path in selected_paths}
    if not selected:
        raise ValueError('源时窗校验缺少选定正文视频')
    measured = _source_bounds(source_durations, selected, '完整源时长')
    playable = _source_bounds(source_window_durations, selected, '视频可用时长')
    groups, tracks = content.get('materials'), content.get('tracks')
    if not isinstance(groups, dict) or not isinstance(groups.get('videos'), list) or not isinstance(tracks, list):
        raise ValueError('草稿缺少可读视频材料或轨道数组')
    body, all_ids = {}, {}
    for material in groups['videos']:
        if not isinstance(material, dict):
            continue
        identifier = material.get('id')
        if isinstance(identifier, str):
            all_ids[identifier] = all_ids.get(identifier, 0) + 1
        try:
            key = _path_key(material.get('path'))
        except (TypeError, ValueError):
            continue
        if key not in selected:
            continue
        if not isinstance(identifier, str) or not identifier:
            raise ValueError('选定正文视频材料缺少 id')
        if material.get('type', 'video') != 'video':
            raise ValueError('选定正文视频材料被保存为非视频类型')
        duration = _positive_duration(material.get('duration'), '选定正文视频 material.duration')
        if measured is not None and duration != measured[key]:
            raise ValueError('选定正文视频 material.duration 与探测的完整源时长不一致')
        body[identifier] = (key, duration)
    if any(all_ids[identifier] != 1 for identifier in body):
        raise ValueError('选定正文视频的 material_id 重复，无法确定源材料')
    seen = set()
    for track in tracks:
        if not isinstance(track, dict) or track.get('type') != 'video':
            continue
        if not isinstance(track.get('segments'), list):
            raise ValueError('视频轨道缺少 segments 数组')
        for segment in track['segments']:
            if not isinstance(segment, dict):
                continue
            identifier = segment.get('material_id')
            if not isinstance(identifier, str) or identifier not in body:
                continue
            key, full_duration = body[identifier]
            start, duration = _time_range(segment.get('source_timerange'), '正文视频 source_timerange')
            _, target_duration = _time_range(segment.get('target_timerange'), '正文视频 target_timerange')
            if start + duration > full_duration:
                raise ValueError('正文视频 source_timerange 超出 material.duration')
            if measured is not None and start + duration > measured[key]:
                raise ValueError('正文视频 source_timerange 超出探测的完整源时长')
            if playable is not None and start + duration > playable[key]:
                raise ValueError('正文视频 source_timerange 超出探测的视频可用时长')
            speed = segment.get('speed')
            if (type(speed) not in (int, float) or speed <= 0
                    or (isinstance(speed, float) and not math.isfinite(speed))):
                raise ValueError('正文视频 speed 必须是有限正数')
            ratio = Fraction(str(speed))
            # Each integer-microsecond serialization can discard <1 us. Converting
            # the target's quantization back to source units adds <speed us; there
            # is no frame- or millisecond-sized grace period.
            if abs(Fraction(duration) - target_duration * ratio) >= 1 + ratio:
                raise ValueError('正文视频源时长与 target_timerange.duration × speed 不一致')
            seen.add(key)
    if seen != selected:
        raise ValueError('草稿视频轨未引用所有选定正文视频，无法核对源路径和时窗')
