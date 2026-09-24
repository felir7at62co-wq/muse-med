"""
Resident NDJSON worker: one process, model loaded once.

Protocol, one JSON object per line in each direction:
  -> {"id": "...", "method": "analyse", "params": {...}}
  <- {"id": "...", "status": "ok", "result": {...}}
  <- {"id": "...", "status": "error", "error": {"code": "...", "message": "..."}}

The first line out is a handshake, so a caller learns about missing dependencies
before the first analysis rather than during it. Nothing but protocol JSON ever
reaches stdout: a stray print would corrupt the stream and the resulting failure
would look like a protocol bug rather than a print statement.
"""
from __future__ import annotations

import json
import sys
import traceback
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The host launches this with `-I`, which implies `-P`: the script's own directory
# is deliberately NOT added to `sys.path`. That is the isolation we want for the
# environment, but it also hides the sibling modules this worker is built from
# (`emo_pipeline`, and `vendored/` inside it). Adding exactly this one directory
# keeps the isolation while making the package importable; nothing else is added.
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + '\n')
    sys.stdout.flush()


def handshake() -> dict:
    """Report import health up front; a missing wheel is a deployment fact, not a crash."""
    missing: list[str] = []
    for name in ('torch', 'torchaudio', 'transformers', 'librosa', 'music21', 'numpy',
                 'mir_eval', 'pretty_midi', 'yaml'):
        try:
            __import__(name)
        except Exception as error:  # noqa: BLE001
            missing.append(f'{name}: {type(error).__name__}')
    return {'ready': not missing, 'face': 'emotion', 'missing': missing,
            'python': sys.version.split()[0]}


def dispatch(method: str, params: dict) -> dict:
    if method != 'analyse':
        raise ValueError(f'UNKNOWN_METHOD:{method}')
    from emo_pipeline import analyse
    return analyse(audio_path=Path(params['audio_path']),
                   data_dir=Path(params.get('data_dir') or HERE / 'data'),
                   weights_path=Path(params['weights_path']),
                   source_sha256=params.get('source_sha256'))


def main() -> int:
    emit({'id': '__handshake__', 'status': 'ok', 'result': handshake()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            # Model-library diagnostics must not enter the NDJSON response stream.
            with redirect_stdout(sys.stderr):
                result = dispatch(request['method'], request.get('params') or {})
            emit({'id': request_id, 'status': 'ok', 'result': result})
        except Exception as error:  # noqa: BLE001 - every failure must answer, never die
            emit({'id': request_id, 'status': 'error',
                  'error': {'code': type(error).__name__, 'message': str(error)[:500],
                            'traceback': traceback.format_exc()[-800:]}})
    return 0


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        raise SystemExit(main())
    except Exception:
        print('WORKER_FAILED', file=sys.stderr)
        raise
