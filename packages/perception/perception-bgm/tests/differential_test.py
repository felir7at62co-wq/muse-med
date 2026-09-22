"""
Differential test: this pipeline must reproduce upstream's numbers.

The emotion head consumes four tensors (MERT features, chord roots, chord
attributes, key mode). Reimplementing that chain is only defensible if it produces
the *same* answer as the original, because every valence/arousal figure the design
doc quotes — and every target coordinate a caller will type in — comes from the
original.

So this runs both on the same file and requires agreement:
  - valence and arousal within 1e-4
  - identical mood tag sets
Then it runs the three files that make upstream crash, where upstream cannot be
the baseline and this pipeline must succeed anyway.

Run from the repository root with PYTHONPATH pointing at both this package's
python/ directory and the upstream checkout:

  python tests/differential_test.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

# The model is already in the local HuggingFace cache; without this, transformers
# issues a HEAD request per load to check for updates, which on a slow link turns a
# 80-second test into a stalled one. A correctness test must not depend on network.
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

HERE = Path(__file__).resolve().parent
PIPELINE_DIR = HERE.parent / 'python'
# Use a disposable upstream checkout: upstream writes intermediates beside its code.
UPSTREAM = Path(os.environ['DSH_BGM_UPSTREAM']).resolve()
UPSTREAM_WEIGHTS = Path(os.environ['DSH_PERCEPTION_BGM_WEIGHTS']).resolve()
DATA_DIR = Path(os.environ['DSH_PERCEPTION_DATA_DIR']).resolve()
STAGED = Path(os.environ['DSH_PERCEPTION_E2E_DIR']).resolve()

# Files whose upstream result is known to be correct, chosen to span the space
# rather than to be easy: quiet/sad, loud/tense, and an English-named neutral one.
# Staged names verified against library-emotions.ndjson rather than assumed.
AGREE_CASES = {
    '悲伤剧情氛围.mp3': 'track030.mp3',
    '紧张打斗 战争 史诗 绝处逢生.mp3': 'track052.mp3',
    'vroken.mp3': 'track013.mp3',
}
# Known upstream crashes; this pipeline must still answer.
CRASH_CASES = {'危险降临.mp3': 'track018.mp3', '悬疑推理迷离.mp3': 'track029.mp3',
               '悲壮交响哀曲.mp3': 'track031.mp3'}

TOLERANCE = 1e-4


def upstream_predict(audio: Path) -> dict | None:
    """Run upstream in its own working directory, since it uses relative paths."""
    import os
    previous = os.getcwd()
    os.chdir(UPSTREAM)
    try:
        from music2emo import Music2emo
        engine = Music2emo()
        return engine.predict(str(audio))
    except Exception as error:  # noqa: BLE001 - a crash here is a documented finding
        print(f'    upstream raised {type(error).__name__}: {error}')
        return None
    finally:
        os.chdir(previous)
        # Upstream builds ./temp_out and ./output next to its own package.
        for leftover in ('temp_out', 'output'):
            shutil.rmtree(UPSTREAM / leftover, ignore_errors=True)


def ours_predict(audio: Path) -> dict:
    sys.path.insert(0, str(PIPELINE_DIR))
    from emo_pipeline import analyse
    return analyse(audio_path=audio, data_dir=DATA_DIR, weights_path=UPSTREAM_WEIGHTS)


def compare(name: str, ours: dict, theirs: dict) -> bool:
    dv = abs(ours['valence'] - theirs['valence'])
    da = abs(ours['arousal'] - theirs['arousal'])
    same_moods = set(ours['moods']) == set(theirs['predicted_moods'])
    ok = dv <= TOLERANCE and da <= TOLERANCE and same_moods
    print(f'    ours   v={ours["valence"]:.6f} a={ours["arousal"]:.6f} moods={len(ours["moods"])}')
    print(f'    theirs v={theirs["valence"]:.6f} a={theirs["arousal"]:.6f} '
          f'moods={len(theirs["predicted_moods"])}')
    print(f'    delta  v={dv:.2e} a={da:.2e}  moods_equal={same_moods}  -> '
          f'{"PASS" if ok else "FAIL"}')
    if not same_moods:
        print(f'      only ours  : {sorted(set(ours["moods"]) - set(theirs["predicted_moods"]))}')
        print(f'      only theirs: {sorted(set(theirs["predicted_moods"]) - set(ours["moods"]))}')
    return ok


def main() -> int:
    results: dict[str, object] = {'tolerance': TOLERANCE, 'agree': [], 'crash': []}

    print('=' * 74)
    print('Part 1 — must agree with upstream (upstream is the baseline)')
    agree_ok = True
    for label, staged in AGREE_CASES.items():
        audio = STAGED / staged
        if not audio.is_file():
            print(f'  SKIP {label}: staged copy {staged} not found')
            continue
        print(f'\n  {label}  ({staged})')
        theirs = upstream_predict(audio)
        if theirs is None:
            print('    upstream produced no result; cannot use it as a baseline')
            agree_ok = False
            continue
        ours = ours_predict(audio)
        ok = compare(label, ours, theirs)
        agree_ok = agree_ok and ok
        results['agree'].append({'file': label, 'ours': ours, 'theirs': theirs, 'pass': ok})

    print('\n' + '=' * 74)
    print('Part 2 — upstream crashes, this pipeline must not')
    crash_ok = True
    for label, staged in CRASH_CASES.items():
        audio = STAGED / staged
        if not audio.is_file():
            print(f'  SKIP {label}: staged copy {staged} not found')
            continue
        print(f'\n  {label}  ({staged})')
        print('    running upstream to confirm it still crashes ...')
        theirs = upstream_predict(audio)
        if theirs is not None:
            # Not a failure of ours, but the premise changed and the report must say so.
            print('    NOTE: upstream did not crash this time; premise changed')
        started = time.monotonic()
        try:
            ours = ours_predict(audio)
            ok = True
            print(f'    ours OK in {time.monotonic() - started:.1f} s  '
                  f'v={ours["valence"]:.4f} a={ours["arousal"]:.4f} '
                  f'dropped={ours["dropped_trailing_samples"]} samples')
        except Exception as error:  # noqa: BLE001
            ok = False
            ours = {'error': f'{type(error).__name__}: {error}'}
            print(f'    ours FAILED: {ours["error"]}')
        crash_ok = crash_ok and ok
        results['crash'].append({'file': label, 'upstream_crashed': theirs is None,
                                 'ours': ours, 'pass': ok})

    out = HERE / 'differential-report.json'
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print('\n' + '=' * 74)
    print(f'Part 1 agree : {"PASS" if agree_ok else "FAIL"}')
    print(f'Part 2 crash : {"PASS" if crash_ok else "FAIL"}')
    print(f'report: {out}')
    return 0 if (agree_ok and crash_ok) else 1


if __name__ == '__main__':
    raise SystemExit(main())
