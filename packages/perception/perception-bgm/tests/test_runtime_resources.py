"""Offline regression checks; no model imports, downloads or audio inference."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
REVISION = '12af15fef9d0ac838c3f475bfbbf26d2060dd4f5'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ResourcesTest(unittest.TestCase):
    def test_analysis_uses_private_temp_and_cleans_success_and_failure(self):
        with patch.dict(sys.modules, {name: MagicMock() for name in
                                     ('numpy', 'torch', 'torchaudio', 'yaml', 'mert')}):
            pipeline = load_module('emo_pipeline', ROOT / 'python/emo_pipeline.py')
            with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as root:
                root = Path(root)
                data = root / 'data'
                data.mkdir()
                (data / 'run_config.yaml').write_text('unused', encoding='utf-8')
                audio = root / 'test.wav'
                audio.write_bytes(b'unused')
                waveform = MagicMock()
                waveform.shape = (1, 24000)
                sys.modules['torchaudio'].load.return_value = (waveform, 24000)
                sys.modules['yaml'].safe_load.return_value = {'feature': {}, 'model': {}}
                embedding = MagicMock()
                embedding.shape = (1536,)
                paths = []
                barrier = Barrier(2)

                def key(_body, scratch):
                    paths.append(scratch)
                    scratch.mkdir(parents=True, exist_ok=True)
                    (scratch / 'chords.lab').write_text('test', encoding='utf-8')
                    barrier.wait(timeout=5)
                    if len(paths) > 0 and scratch == paths[0]:
                        raise ValueError('key failed')
                    return 'C', 'major'

                def analyse():
                    try:
                        pipeline.analyse(audio, data, root / 'absent.ckpt')
                    except ValueError as error:
                        return str(error)

                with patch.object(pipeline, 'split_segments', return_value=([waveform], 0)), \
                     patch.object(pipeline, 'mert_embedding', return_value=embedding), \
                     patch.object(pipeline, 'recognise_chords', return_value='lab'), \
                     patch.object(pipeline, 'key_from_lab', side_effect=key), \
                     patch.object(pipeline, 'normalize_chords', side_effect=ValueError('after key')):
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        results = list(pool.map(lambda _: analyse(), range(2)))
                self.assertCountEqual(results, ['key failed', 'after key'])
                self.assertEqual(len(set(paths)), 2)
                for path in paths:
                    self.assertFalse(path.is_relative_to(data))
                    self.assertFalse(path.exists(), f'Leaked scratch: {path}')
                self.assertEqual(sorted(p.name for p in data.iterdir()), ['run_config.yaml'])

    def test_mert_model_and_processor_use_frozen_revision(self):
        transformers = MagicMock()
        with patch.dict(sys.modules, {'torch': MagicMock(), 'numpy': MagicMock(),
                                     'transformers': transformers}):
            mert = load_module('mert_test', ROOT / 'python/vendored/mert.py')
            mert.FeatureExtractorMERT(device='cpu')
        for loader in (transformers.AutoModel, transformers.Wav2Vec2FeatureExtractor):
            self.assertEqual(loader.from_pretrained.call_args.args, ('m-a-p/MERT-v1-95M',))
            self.assertEqual(loader.from_pretrained.call_args.kwargs.get('revision'), REVISION)
            self.assertTrue(loader.from_pretrained.call_args.kwargs['trust_remote_code'])


if __name__ == '__main__':
    unittest.main()
