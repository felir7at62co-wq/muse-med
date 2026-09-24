"""Exercise the isolated noncommercial BGM model on a generated MP3 without network or personal caches."""
import importlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    root = Path(sys.argv[1]).resolve()
    worker = Path(sys.argv[2]).resolve()
    expected = root / 'python'
    assert sys.version_info[:2] == (3, 11)
    assert Path(sys.prefix).resolve() == expected
    assert Path(sys.base_prefix).resolve() == expected
    assert not (expected / 'pyvenv.cfg').exists()
    assert all(Path(path).resolve().is_relative_to(expected) for path in sys.path if path)
    from packaging.requirements import Requirement
    for distribution in importlib.metadata.distributions():
        for declared in distribution.requires or []:
            requirement = Requirement(declared)
            if requirement.marker and not requirement.marker.evaluate({'extra': ''}):
                continue
            installed = importlib.metadata.version(requirement.name)
            assert installed in requirement.specifier, (distribution.metadata['Name'], declared, installed)
    for name in ['torch', 'torchaudio', 'transformers', 'librosa', 'music21', 'mir_eval',
                 'pretty_midi', 'numpy', 'yaml', 'pytorch_lightning', 'sklearn', 'soundfile']:
        imported = importlib.import_module(name)
        assert Path(imported.__file__).resolve().is_relative_to(expected), name
    assert importlib.metadata.version('torch') == '2.3.1+cpu'
    assert importlib.metadata.version('torchaudio') == '2.3.1+cpu'
    assert importlib.metadata.version('transformers') == '4.44.0'
    import numpy as np
    with tempfile.TemporaryDirectory(prefix='muse-bgm-offline-', dir=root.parent) as temporary:
        work = Path(temporary)
        sample_rate = 44100
        pieces = []
        for chord in [(261.63, 329.63, 392.0), (220.0, 261.63, 329.63),
                      (174.61, 220.0, 261.63), (196.0, 246.94, 293.66)]:
            time = np.arange(sample_rate * 3) / sample_rate
            signal = sum(np.sin(2 * math.pi * note * time) for note in chord) * 0.15
            pieces.append(signal)
        mono = np.concatenate(pieces)
        stereo = np.column_stack([mono, mono * 0.9])
        mp3 = work / 'chords.mp3'
        # The verified FFmpeg build carries no MP3 encoder, and the analysis path
        # needs decoding only: write the probe MP3 with the bundled libsndfile,
        # which is the same library the worker decodes through.
        import soundfile
        soundfile.write(str(mp3), stereo, sample_rate, format='MP3')
        decoded, decoded_rate = soundfile.read(str(mp3))
        assert decoded_rate == sample_rate, (decoded_rate, sample_rate)
        assert len(decoded) > sample_rate, len(decoded)
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() in {'SYSTEMROOT', 'WINDIR', 'PATH'}}
        environment.update({
            'HOME': str(work), 'USERPROFILE': str(work), 'APPDATA': str(work), 'LOCALAPPDATA': str(work),
            'TEMP': str(work), 'TMP': str(work), 'HF_HOME': str(root / 'models/hf-cache'),
            'HF_MODULES_CACHE': str(work / 'hf-modules'), 'NUMBA_CACHE_DIR': str(work / 'numba'),
            'MPLCONFIGDIR': str(work / 'matplotlib'), 'TORCH_HOME': str(work / 'torch'),
            'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1',
            'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1', 'OPENBLAS_NUM_THREADS': '1',
        })
        # The real NDJSON worker runs under a network-denying bootstrap, not a replacement model.
        bootstrap = ('import socket,runpy,sys; '
                     'deny=lambda *a,**k: (_ for _ in ()).throw(AssertionError("BGM smoke attempted network")); '
                     'socket.create_connection=deny; socket.socket.connect=deny; '
                     'runpy.run_path(sys.argv[1],run_name="__main__")')
        request = {'id': 'offline-mp3', 'method': 'analyse', 'params': {
            'audio_path': str(mp3), 'weights_path': str(root / 'models/J_all.ckpt'),
            'data_dir': str(root / 'models/data')}}
        completed = subprocess.run([sys.executable, '-I', '-B', '-X', 'utf8', '-c', bootstrap, str(worker)],
                                   input=json.dumps(request) + '\n', capture_output=True, text=True,
                                   encoding='utf-8', env=environment, cwd=work, timeout=600)
        if completed.returncode:
            raise RuntimeError(completed.stderr[-5000:] + completed.stdout[-2000:])
        messages = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
        handshake = next(row for row in messages if row['id'] == '__handshake__')
        assert handshake['result']['ready'], handshake
        answer = next(row for row in messages if row['id'] == 'offline-mp3')
        if answer['status'] != 'ok':
            raise RuntimeError(json.dumps(answer) + completed.stderr[-5000:])
        analysis = answer['result']
        assert all(math.isfinite(analysis[key]) and 1 <= analysis[key] <= 9 for key in ('valence', 'arousal')), analysis
        assert analysis['segments_used'] >= 1 and analysis['seconds'] >= 11
        assert not list(work.glob('dsh-bgm-*')), 'inference scratch was not cleaned'
        print(json.dumps({'offline_bgm': 'passed', 'python': sys.version.split()[0],
                          'valence': analysis['valence'], 'arousal': analysis['arousal'],
                          'seconds': analysis['seconds'], 'elapsed_seconds': analysis['elapsed_seconds']}))


if __name__ == '__main__':
    main()
