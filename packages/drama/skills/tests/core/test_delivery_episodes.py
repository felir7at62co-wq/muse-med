"""Offline delivery assembly with canonical two-, three-, and four-digit episode IDs."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = (Path(__file__).resolve().parents[2] /
          'skills/tweet-drama-delivery/scripts/assemble_delivery.py')


class DeliveryEpisodeTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('delivery_episode_tests', SCRIPT)
        self.delivery = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'path', sys.path.copy()):
            spec.loader.exec_module(self.delivery)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.project = Path(temporary.name).resolve()
        self.config = self.project / '_probe/delivery-config'
        self.config.mkdir(parents=True)
        episodes = (1, 14, 140, 1000, 9999)
        for episode in episodes:
            self.write(f'export/{episode}.mp4', f'master for episode {episode}'.encode())
        self.write('assets/lead_m.png', b'male fixture')
        self.write('assets/lead_f.png', b'female fixture')
        self.write('source/original/script.txt', b'original script')
        self.write('_probe/delivery-config/简介.txt', '简介'.encode())
        for name, data in {
            '_confirmed_episodes.json': {'confirmed': [{'episode': ep} for ep in episodes]},
            'confirmed-films.json': {'films': {f'{ep:02d}': f'export/{ep}.mp4' for ep in episodes}},
            '主角.json': {'male': ['lead_m.png'], 'female': ['lead_f.png']},
        }.items():
            (self.config / name).write_text(json.dumps(data), encoding='utf-8')

    def write(self, relative, data):
        path = self.project / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def assemble(self, episode):
        argv = ['assemble_delivery.py', '--project', str(self.project), '--episode', str(episode)]
        output = io.StringIO()
        with patch.object(sys, 'argv', argv), \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(self.delivery, 'find_ffprobe', return_value=None), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.delivery.main(), 0)
        return json.loads(output.getvalue().split('<<<ASSEMBLY_REPORT>>>')[1]
                          .split('<<<END_ASSEMBLY_REPORT>>>')[0])

    def films(self):
        return {path.name: path.read_bytes()
                for path in (self.project / 'delivery/00成片').iterdir()}

    def test_episode_140_can_be_reassembled_without_replacing_episode_14(self):
        self.assemble(14)
        self.assemble(140)
        self.write('export/140.mp4', b'updated episode 140')
        report = self.assemble(140)
        self.assertEqual(report['episode'], 140)
        self.assertEqual(report['film']['name'], '140.mp4')
        self.assertEqual(self.films(), {
            '14.mp4': b'master for episode 14',
            '140.mp4': b'updated episode 140',
        })

    def test_four_digit_episodes_survive_later_assembly_and_keep_full_ids(self):
        for episode in (1000, 9999, 1, 140):
            with self.subTest(episode=episode):
                report = self.assemble(episode)
                self.assertEqual(report['film']['name'], f'{episode:02d}.mp4')
        self.assertEqual(self.films(), {
            f'{episode:02d}.mp4': f'master for episode {episode}'.encode()
            for episode in (1, 140, 1000, 9999)
        })
        self.assertEqual({row['name'] for row in report['sections']['00成片']['files']},
                         set(self.films()))

    def test_noncanonical_film_names_block_assembly_without_changing_files(self):
        self.assemble(14)
        for name in ('1.mp4', '00.mp4', '0140.mp4', '10000.mp4', '140.mp4.bak', '140x.mp4'):
            with self.subTest(name=name):
                stray = self.write(f'delivery/00成片/{name}', b'preserve unrecognized file')
                before = self.films()
                with self.assertRaises(SystemExit) as raised:
                    self.assemble(140)
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(self.films(), before)
                stray.unlink()

    def test_out_of_range_episode_fails_before_gate_or_output_creation(self):
        for episode in (0, 10000):
            with self.subTest(episode=episode), \
                    patch.object(self.delivery, 'check_gate', side_effect=AssertionError('invalid episode reached gate')):
                with self.assertRaises(SystemExit) as raised:
                    self.assemble(episode)
                self.assertEqual(raised.exception.code, 2)
                self.assertFalse((self.project / 'delivery').exists())


if __name__ == '__main__':
    unittest.main()
