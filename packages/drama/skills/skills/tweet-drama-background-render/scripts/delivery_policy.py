"""Resolve explicit project/timeline delivery choices shared by Python exporters."""

import json
import logging
import math
import os
from pathlib import Path

logger = logging.getLogger(__name__)
DEFAULT_GEOMETRY = {'width': 1440, 'height': 2560, 'fps': 60}
LEGACY_WARNING = (
    'visual_medium is missing; preserving legacy delivery with a 2-second ending and AI mark. '
    'Set project_bible.visual_medium to animation_3d or photorealistic and rerun prepare; '
    'style text and aspect ratio do not select delivery policy.'
)


def _medium(container: dict, label: str):
    if 'visual_medium' not in container:
        return None
    value = container['visual_medium']
    if value not in ('animation_3d', 'photorealistic'):
        raise ValueError(f'{label}.visual_medium must be animation_3d or photorealistic; got {value!r}')
    return value


def _dimensions(value, label: str, even: bool = False) -> dict:
    if not isinstance(value, dict) or any(
            isinstance(value.get(key), bool) or not isinstance(value.get(key), (int, float))
            or not math.isfinite(value[key]) or value[key] != int(value[key])
            or not 0 < value[key] <= 9_007_199_254_740_991
            or (even and value[key] % 2 != 0) for key in ('width', 'height')):
        qualifier = 'even ' if even else ''
        raise ValueError(f'{label} must contain positive safe {qualifier}integer width and height')
    return {key: int(value[key]) for key in ('width', 'height')}


def _geometry(value, label: str) -> dict:
    dimensions = _dimensions(value, label, even=True)
    fps = value.get('fps')
    if (isinstance(fps, bool) or not isinstance(fps, (int, float))
            or not math.isfinite(fps) or fps != int(fps) or not 1 <= fps <= 240):
        raise ValueError(f'{label}.fps must be an integer from 1 to 240')
    return {**dimensions, 'fps': int(fps)}


def _subtitle(value, label: str, height: int) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    for field, upper, zero in (('font_size_px', 9_007_199_254_740_991, False),
                               ('margin_bottom_px', height, True)):
        if field in value:
            number = value[field]
            if (isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number)
                    or number > upper or (number < 0 if zero else number <= 0)):
                raise ValueError(f'{label}.{field} is out of range')
    if 'font_family' in value and (not isinstance(value['font_family'], str)
                                   or not value['font_family'].strip()
                                   or any(c in value['font_family'] for c in ',\r\n')):
        raise ValueError(f'{label}.font_family must be a nonempty ASS family without delimiters')
    return {key: value[key] for key in ('font_family', 'font_size_px', 'margin_bottom_px') if key in value}


def _subtitle_visual(value, label: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f'{label} must be an object')
    if not value:
        return {}
    if type(value.get('schema_version')) is not int or value['schema_version'] != 1:
        raise ValueError(f'{label}.schema_version must be 1')
    ranges = {'reference_width': (16384, False), 'reference_height': (16384, False),
              'font_size_px': (16384, False), 'outline_px': (100, True),
              'center_y_ratio': (1, True), 'max_width_ratio': (1, False)}
    result = {'schema_version': 1}
    for field, (upper, zero) in ranges.items():
        number = value.get(field)
        if (isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number)
                or number > upper or (number < 0 if zero else number <= 0)):
            raise ValueError(f'{label}.{field} is out of range')
        result[field] = number
    if 'font_family' in value:
        family = value['font_family']
        if (not isinstance(family, str) or not family.strip() or len(family.strip()) > 128
                or any(c == ',' or ord(c) < 32 or ord(c) == 127 for c in family)):
            raise ValueError(f'{label}.font_family is invalid')
        result['font_family'] = family.strip()
    return result


def resolve_delivery(timeline: dict, project: Path | None = None) -> dict:
    """Validate persisted choices; missing medium keeps the marked legacy ending with a warning.

    Either an explicit project medium or a timeline snapshot may supply the medium. Conflicting
    explicit choices require preparation again. Canvas dimensions never select a medium.
    """
    if not isinstance(timeline, dict):
        raise ValueError('Timeline must be a JSON object')
    snapshot = timeline.get('delivery', {})
    if not isinstance(snapshot, dict):
        raise ValueError('timeline.delivery must be an object')
    timeline_medium = _medium(snapshot, 'timeline.delivery')
    project_medium = None
    project_delivery = {}
    if project is not None:
        config_path = Path(project) / 'project_config.json'
        if config_path.exists():
            config = json.loads(config_path.read_text(encoding='utf-8-sig'))
            if not isinstance(config, dict) or not isinstance(config.get('project_bible', {}), dict):
                raise ValueError(f'{config_path}: project_bible must be an object')
            bible = config.get('project_bible', {})
            project_medium = _medium(bible, 'project_bible')
            if 'delivery' in bible:
                if not isinstance(bible['delivery'], dict):
                    raise ValueError('project_bible.delivery must be an object')
                _geometry({**DEFAULT_GEOMETRY, **bible['delivery']}, 'project_bible.delivery')
                project_delivery = bible['delivery']
    if timeline_medium and project_medium and timeline_medium != project_medium:
        raise ValueError('timeline.delivery.visual_medium conflicts with project_bible.visual_medium; '
                         'rerun prepare (重新 prepare) before delivery')
    medium = project_medium or timeline_medium
    warnings = []
    if medium is None:
        warnings.append(LEGACY_WARNING)
        logger.warning(LEGACY_WARNING)
    canvas = _dimensions(timeline['canvas'], 'timeline.canvas') if 'canvas' in timeline else None
    if 'delivery' in timeline:
        geometry = _geometry(snapshot, 'timeline.delivery')
        dimensions = {key: geometry[key] for key in ('width', 'height')}
        fps = geometry['fps']
        if canvas is not None and canvas != dimensions:
            raise ValueError('timeline.canvas conflicts with timeline.delivery dimensions; rerun prepare')
    else:
        dimensions, fps = canvas or {'width': 1440, 'height': 2560}, 60
    selected = {}
    default_visual = os.environ.get('MUSE_DEFAULT_SUBTITLE_VISUAL')
    # In the packaged Muse short-drama product's portrait output, stale project/timeline
    # visual snapshots must not override the accepted style. Do not change persisted choices.
    # Other deployments (and environments without a configured product visual) keep their
    # existing explicit-style inheritance and fallback behaviour.
    product_visual_enabled = os.environ.get('MUSE_FORCE_SUBTITLE_VISUAL') == '1'
    force_product_visual = (product_visual_enabled and default_visual
                            and dimensions['height'] > dimensions['width'])
    if not force_product_visual:
        for key in ('subtitle', 'subtitle_visual'):
            source = snapshot if key in snapshot else project_delivery
            if key in source:
                selected[key] = (_subtitle(source[key], f'delivery.{key}', dimensions['height']) if key == 'subtitle'
                                 else _subtitle_visual(source[key], f'delivery.{key}'))
    if default_visual and (force_product_visual or (not product_visual_enabled and not selected)):
        selected['subtitle_visual'] = _subtitle_visual(json.loads(default_visual), 'MUSE_DEFAULT_SUBTITLE_VISUAL')
    return {'visual_medium': medium, **dimensions, 'fps': fps, **selected,
            'ending_duration_us': 0 if medium == 'animation_3d' else 2_000_000,
            'add_watermark': medium != 'animation_3d', 'warnings': warnings}


def reject_animation_ending(timeline: dict, end_us: int, policy: dict) -> None:
    """Reject an animation timeline explicitly marking an already included ending."""
    if policy['visual_medium'] != 'animation_3d' or 'body_end' not in timeline:
        return
    body_end = timeline['body_end']
    if (isinstance(body_end, bool) or not isinstance(body_end, (int, float))
            or not math.isfinite(body_end) or round(body_end * 1_000_000) != end_us):
        raise ValueError('animation_3d cannot include an ending after body_end; '
                         'rerun prepare with body-only clips (重新 prepare)')


def ending_effect_fit(timeline: dict) -> str:
    """Use the timeline selection before the optional product deployment fallback."""
    fit = timeline.get('ending_effect_fit', os.environ.get('MUSE_DEFAULT_ENDING_EFFECT_FIT', 'source_once'))
    if fit not in ('source_once', 'stretch_to_window'):
        raise ValueError('ending_effect_fit must be source_once or stretch_to_window')
    return fit
