"""Apply the vendored Jingliu subtitle rules to one JSON request read from stdin.

Request: ``{"layout": {"max_chars": 14, ...}, "shots": [{"key", "identity", "words", "lines", "names",
"decisions"}]}``. ``identity`` carries ``audio_sha256``, ``transcript_sha256`` and ``lines_sha256`` for
stable review-item IDs; ``words`` are measured ``{start, end, text, seg, speaker?}`` rows in shot-local
seconds; ``decisions`` are ``{id, action}`` rows with ``action`` in ``heard``, ``script`` or ``drop``.

Result on stdout: ``{"rules_sha256", "pypinyin", "shots": [{"key", "cues", "stats", "items"}]}``.
A missing rule module or a different ``pypinyin`` prints ``{"error": {"code", "message", "python"}}``
and exits 3, so a runtime that cannot apply the shared rules never produces subtitles.

The two rule modules are byte copies of ``services/jingliu/backend/app``; ``verify-subtitle-rules-copy``
rejects any difference. This file only moves JSON between the caller and those modules.
"""
import hashlib
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
RULE_FILES = ('subtitle_align.py', 'subtitle_cues.py', 'run.py')
PYPINYIN_VERSION = '0.55.0'
ACTIONS = ('heard', 'script', 'drop')


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
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    try:
        import importlib.metadata
        version = importlib.metadata.version('pypinyin')
    except Exception as error:  # PackageNotFoundError or a broken distribution: both leave no usable reading.
        return None, ('pypinyin_missing', f'字幕规则需要 pypinyin=={PYPINYIN_VERSION}：{error}')
    if version != PYPINYIN_VERSION:
        return None, ('pypinyin_version', f'字幕规则需要 pypinyin=={PYPINYIN_VERSION}，当前为 {version}。')
    # TODO: subtitle_cues.py arrives with the Jingliu J1 commit (branch muse/jingliu-subtitles); until then
    # every call refuses here instead of producing subtitles from partial rules.
    for name in RULE_FILES:
        if not (HERE / name).is_file():
            return None, ('rules_missing', f'字幕规则文件缺失：{HERE / name}')
    import subtitle_cues
    return subtitle_cues, None


def shot_result(cues_module, shot, layout):
    """Correct one shot's measured words toward its script, apply decisions and lay out cues."""
    identity = shot['identity']
    words, stats = cues_module.correct_words(shot['words'], shot['lines'], shot['names'])
    items = cues_module.review_items(stats, words, audio_sha256=identity['audio_sha256'],
                                     transcript_sha256=identity['transcript_sha256'],
                                     lines_sha256=identity['lines_sha256'])
    decisions = [row for row in shot.get('decisions', []) if row.get('action') in ACTIONS]
    words = cues_module.apply_decisions(words, items, decisions)
    cues = cues_module.layout_cues(words, **layout)
    decided = {row['id'] for row in decisions}
    return {'key': shot['key'], 'cues': cues, 'stats': stats,
            'items': [{**item, 'decided': item['id'] in decided} for item in items]}


def main():
    """Read one request, print one result; every diagnostic is part of the JSON result."""
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    cues_module, problem = load_rules()
    if problem is not None:
        return refuse(*problem)
    layout = request.get('layout') or {}
    shots = [shot_result(cues_module, shot, layout) for shot in request['shots']]
    print(json.dumps({'rules_sha256': rules_sha256(), 'pypinyin': PYPINYIN_VERSION, 'shots': shots},
                     ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
