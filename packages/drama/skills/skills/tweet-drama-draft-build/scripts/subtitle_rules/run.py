"""Apply the vendored Jingliu subtitle rules to one JSON request read from stdin.

Request: ``{"max_chars": 14, "space_width": 0.5, "shots": [{"key", "audio_sha256", "words", "lines", "names",
"decisions", "flags"}]}``. ``words`` are measured ``{start, end, text, seg?, speaker_id?}`` rows in shot-local
source seconds; ``decisions`` are ``{id, action}`` rows with ``action`` in ``heard``, ``script`` or ``drop``;
``flags`` are caller findings ``{kind, start, end}`` listed as review items.

Result on stdout: ``{"rules_sha256", "pypinyin", "shots": [{"key", "cues", "items", "pending", "stats"}]}``,
with cues ``{start, end, text}`` and items ``{id, kind, heard, script, start, end, decision}``. A missing rule
module or another ``pypinyin`` version prints ``{"error": {"code", "message", "python"}}`` and exits 3, so a
runtime that cannot apply the shared rules never produces subtitles.

``subtitle_align.py`` and ``subtitle_cues.py`` are byte copies of ``services/jingliu/backend/app``;
``verify-subtitle-rules-copy`` rejects any difference. This file only moves JSON in and out of ``shot_cues``.
"""
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
RULE_FILES = ('subtitle_align.py', 'subtitle_cues.py', 'run.py')
PYPINYIN_VERSION = '0.55.0'
STATS = ('similarity', 'fixed', 'kept', 'extra', 'unspoken', 'deviated', 'unheard', 'no_script')


def rules_sha256():
    """Hash every rule file by name and bytes, so any change to the rules changes the cache key."""
    digest = hashlib.sha256()
    for name in RULE_FILES:
        digest.update(name.encode('utf-8') + b'\0' + (HERE / name).read_bytes() + b'\0')
    return digest.hexdigest()


def refuse(code, message):
    """Print one loud refusal naming this interpreter and stop."""
    print(json.dumps({'error': {'code': code, 'message': message, 'python': sys.executable}}, ensure_ascii=False))
    return 3


def load_rules():
    """Import the rule modules from this directory, or describe why they are unusable."""
    for name in RULE_FILES:
        if not (HERE / name).is_file():
            return None, ('rules_missing', f'字幕规则文件缺失：{HERE / name}')
    try:
        import importlib.metadata
        version = importlib.metadata.version('pypinyin')
    except Exception as error:  # PackageNotFoundError or a broken distribution: both leave no usable reading.
        return None, ('pypinyin_missing', f'字幕规则需要 pypinyin=={PYPINYIN_VERSION}：{error}')
    if version != PYPINYIN_VERSION:
        return None, ('pypinyin_version', f'字幕规则需要 pypinyin=={PYPINYIN_VERSION}，当前为 {version}。')
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    import subtitle_cues
    return subtitle_cues, None


def shot_result(cues_module, shot, max_chars, space_width):
    """Correct one shot's words toward its script, apply decisions and lay out cues."""
    out = cues_module.shot_cues(shot['words'], shot['lines'], shot['names'], shot.get('decisions') or [],
                                max_chars=max_chars, space_width=space_width, audio_sha=shot['audio_sha256'],
                                flags=shot.get('flags') or [])
    return {'key': shot['key'],
            'cues': [{'start': cue['start'], 'end': cue['end'], 'text': cue['text']} for cue in out['cues']],
            'items': [{key: item[key] for key in ('id', 'kind', 'heard', 'script', 'start', 'end', 'decision')}
                      for item in out['items']],
            'pending': out['pending'], 'stats': {key: out['stats'][key] for key in STATS}}


def main():
    """Read one request, print one result; every diagnostic is part of the JSON result."""
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    cues_module, problem = load_rules()
    if problem is not None:
        return refuse(*problem)
    max_chars, space_width = request['max_chars'], request.get('space_width', 0.5)
    shots = [shot_result(cues_module, shot, max_chars, space_width) for shot in request['shots']]
    print(json.dumps({'rules_sha256': rules_sha256(), 'pypinyin': PYPINYIN_VERSION, 'shots': shots},
                     ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
