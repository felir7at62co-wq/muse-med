"""Resolve explicit project/timeline delivery choices shared by Python exporters."""

import json
import logging
import math
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
    return {'visual_medium': medium, **dimensions, 'fps': fps,
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
    """Read only the explicit timeline fit; omission keeps original-speed playback."""
    fit = timeline.get('ending_effect_fit', 'source_once')
    if fit not in ('source_once', 'stretch_to_window'):
        raise ValueError('ending_effect_fit must be source_once or stretch_to_window')
    return fit
