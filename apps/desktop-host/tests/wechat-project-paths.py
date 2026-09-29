"""Offline checks for project state and preservation of existing media."""
import ast
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

scripts = Path(__file__).resolve().parents[1] / 'skills' / 'wechat-shortdrama-harvest' / 'scripts'
for source in scripts.glob('*.py'):
    ast.parse(source.read_text(encoding='utf-8'), filename=str(source))

with tempfile.TemporaryDirectory(prefix='muse-wechat-test-') as temporary:
    project = Path(temporary) / 'project'
    os.environ['SHORTDRAMA_WORK'] = str(project)
    sys.path.insert(0, str(scripts))
    import common
    common.save_config({'drama_name': 'sample'})
    assert Path(common.CONFIG_F).is_relative_to(project)
    assert Path(common.CONFIG_F).is_file()
    assert Path(common.LOCK_F).is_relative_to(project)
    assert Path(common.out_dir(True)).is_relative_to(project)
    source = project / 'source.mp4'
    target = project / 'target.mp4'
    source.write_bytes(b'first')
    common.copy_media(source, target)
    common.copy_media(source, target)
    source.write_bytes(b'other')
    try:
        common.copy_media(source, target)
    except FileExistsError:
        pass
    else:
        raise AssertionError('Different existing media must not be overwritten')
    assert target.read_bytes() == b'first'
    denied = subprocess.run([sys.executable, '-B', '-c', 'import common'], cwd=scripts,
                            env={**os.environ, 'SHORTDRAMA_WORK': str(scripts / 'work')},
                            capture_output=True, text=True)
    assert denied.returncode != 0
    assert 'outside the installed skill directory' in denied.stderr
    import drive
    common.save_config({'drama_name': 'sample', 'episode_count': 1, 'buckets': {'baseline_t': 1}})
    clock = [0.0]
    scans = []
    harvest = SimpleNamespace(load_durations=lambda: None, scan_once=lambda **kw: scans.append(True))
    finalize = SimpleNamespace(main=lambda: None)
    def sleep(seconds):
        clock[0] += seconds
        if clock[0] > 30:
            raise AssertionError('Missing-window retries exceeded the collection deadline')
    with patch.dict(sys.modules, {'harvest': harvest, 'finalize': finalize}), \
         patch.object(drive, 'focus', lambda *args: None), \
         patch.object(drive, 'open_drama', lambda *args, **kw: (True, 'fixture')), \
         patch.object(drive, 'dump', side_effect=drive.NoWindow('fixture window missing')), \
         patch.object(drive.time, 'time', lambda: clock[0]), \
         patch.object(drive.time, 'sleep', sleep), \
         patch.object(sys, 'argv', ['offline-check']):
        complete, message = drive.run_auto(max_minutes=0.01)
    assert not complete and len(scans) == 1
    drive._BRIDGE_TMP.cleanup()
print('WeChat offline checks passed: helper syntax, project state, immutable existing media')
