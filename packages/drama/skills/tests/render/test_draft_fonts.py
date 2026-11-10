"""Managed font identity and retained-file checks do not depend on installed OS fonts."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def managed_font(root, family='Managed Test Font'):
    """A small SFNT-name fixture tests metadata, not actual glyph rendering."""
    root.mkdir(parents=True, exist_ok=True)
    (root.parent / 'licenses').mkdir(exist_ok=True)
    encoded = family.encode('utf-16-be')
    names = struct.pack('>HHH', 0, 1, 18) + struct.pack('>HHHHHH', 3, 1, 0x409, 1, len(encoded), 0) + encoded
    content = struct.pack('>4sHHHH', b'\x00\x01\x00\x00', 1, 0, 0, 0)
    content += struct.pack('>4sIII', b'name', 0, 28, len(names)) + names
    font = root / 'ZhuqueFangsong-Regular.ttf'
    font.write_bytes(content)
    notice = root.parent / 'licenses/LICENSE-ZhuqueFangsong.txt'
    notice.write_text('SIL OPEN FONT LICENSE fixture\n', encoding='utf-8')
    files = [{'path': prefix + path.name, 'bytes': path.stat().st_size,
              'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
             for path, prefix in ((font, 'fonts/'), (notice, 'licenses/'))]
    (root.parent / 'media-runtime.json').write_text(json.dumps({'files': files}), encoding='utf-8')
    return font, notice


class ManagedFontTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fonts = load('test_managed_draft_fonts', 'draft_fonts.py')

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='draft-fonts-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.folder = self.root / 'media/fonts'
        self.font, self.notice = managed_font(self.folder)
        self.environment = patch.dict(os.environ, {'MUSE_FONTS_DIR': str(self.folder)})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_resolves_internal_family_and_copies_exact_bytes_without_os_installation(self):
        resolved = self.fonts.resolve_managed_font('Managed Test Font')
        self.assertEqual(resolved['source_path'], str(self.font))
        target = self.root / 'new-draft'
        selected = self.fonts.retain_managed_font(resolved, target)
        self.assertEqual(Path(selected['path']).read_bytes(), self.font.read_bytes())
        self.assertEqual(Path(selected['license_path']).read_bytes(), self.notice.read_bytes())
        self.assertTrue(Path(selected['path']).is_relative_to(target))
        with self.assertRaises(FileExistsError):
            self.fonts.retain_managed_font(resolved, target)

    def test_filename_is_not_accepted_as_family_and_absent_directory_is_not_invented(self):
        self.assertIsNone(self.fonts.resolve_managed_font('ZhuqueFangsong-Regular'))
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(self.fonts.resolve_managed_font('Managed Test Font'))

    def test_manifest_mismatch_missing_notice_and_duplicate_family_are_rejected(self):
        self.font.write_bytes(self.font.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'manifest'):
            self.fonts.resolve_managed_font('Managed Test Font')
        managed_font(self.folder)
        self.notice.unlink()
        with self.assertRaisesRegex(ValueError, 'licence'):
            self.fonts.resolve_managed_font('Managed Test Font')
        managed_font(self.folder)
        (self.folder / 'duplicate.ttf').write_bytes(self.font.read_bytes())
        with self.assertRaisesRegex(ValueError, 'multiple'):
            self.fonts.resolve_managed_font('Managed Test Font')

    def test_changed_source_is_rejected_before_copy(self):
        selected = self.fonts.resolve_managed_font('Managed Test Font')
        self.notice.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.fonts.retain_managed_font(selected, self.root / 'new-draft')

    def test_invalid_font_and_name_table_bounds_are_rejected(self):
        for value in (b'not-font', b'\x00\x01\x00\x00' + b'\x00' * 8,
                      self.font.read_bytes()[:-1]):
            with self.subTest(bytes=len(value)):
                self.font.write_bytes(value)
                with self.assertRaises(ValueError):
                    self.fonts.family_names(self.font)

    def test_source_symlinks_are_rejected(self):
        link = self.folder / 'linked.ttf'
        try:
            link.symlink_to(self.font)
        except OSError as error:
            self.skipTest(f'OS symlink creation unavailable: {error}')
        with self.assertRaisesRegex(ValueError, 'regular'):
            self.fonts.family_names(link)


class SavedFontTests(ManagedFontTests):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            cls.generator = load('test_saved_local_font_generator', 'jianying_draft.py')
        except ImportError as error:
            raise unittest.SkipTest(f'Optional draft library unavailable: {error}')

    def selected(self):
        choice = self.generator.draft_font_choice('Managed Test Font')
        return self.fonts.retain_managed_font(choice, self.root / 'draft')

    def content(self, selected):
        span = {'font': {'id': '', 'path': selected['path']}}
        return {'tracks': [{'type': 'text', 'name': '字幕轨道', 'segments': [{'material_id': 'caption'}]}],
                'materials': {'texts': [{'id': 'caption', 'content': json.dumps({'styles': [span], 'text': '测试'})}]}}

    def test_all_saved_spans_and_local_bytes_are_checked(self):
        selected = self.selected()
        content = self.content(selected)
        verify = self.generator.verify_saved_subtitle_font
        self.assertEqual(verify(content, selected, expected_subtitle_count=1)['status'], 'localFileBound')
        self.assertTrue(verify(content, selected, expected_subtitle_count=1)['delivery_ready'])
        self.assertFalse(verify(content, selected, expected_subtitle_count=2)['delivery_ready'])
        deleted = self.content(selected)
        deleted['tracks'] = []
        self.assertFalse(verify(deleted, {**selected, 'delivery_ready': True})['delivery_ready'])
        wrong = self.content(selected)
        wrong['materials']['texts'][0]['content'] = json.dumps({'styles': [{'font': {'id': '', 'path': 'other.ttf'}}]})
        self.assertFalse(verify(wrong, selected)['delivery_ready'])
        Path(selected['path']).write_bytes(b'changed')
        self.assertFalse(verify(content, selected)['delivery_ready'])

    def test_license_tampering_is_not_hidden_by_matching_font_path(self):
        selected = self.selected()
        content = self.content(selected)
        Path(selected['license_path']).write_bytes(b'changed')
        self.assertFalse(self.generator.verify_saved_subtitle_font(content, selected)['delivery_ready'])

    def test_source_receipt_retains_font_notice_and_review_hash_and_rejects_changed_font(self):
        selected = self.selected()
        draft = Path(selected['path']).parents[2]
        stage = self.root / 'stage'
        stage.mkdir()
        video, timeline, subtitle = [stage / name for name in ('clip.mp4', 'timeline.json', 'caption.srt')]
        video.write_bytes(b'retained-video-fixture')
        timeline.write_text('{}', encoding='utf-8')
        subtitle.write_text('1\n00:00:00,000 --> 00:00:01,000\n测试\n', encoding='utf-8')
        content = self.content(selected)
        content['tracks'].append({'type': 'video', 'name': '视频轨道', 'segments': [{'material_id': 'video'}]})
        content['materials']['videos'] = [{'id': 'video', 'path': str(video)}]
        content['materials']['audios'] = []
        checked = self.generator.verify_saved_subtitle_font(content, selected, expected_subtitle_count=1)
        (draft / 'draft_content.json').write_text(json.dumps(content), encoding='utf-8')
        (draft / 'draft_meta_info.json').write_text('{}', encoding='utf-8')
        review = draft / 'muse-review.json'
        review.write_text(json.dumps({'subtitle_font': checked}), encoding='utf-8')
        retained = [{'source': str(path), 'retained': str(path), 'sha256': self.fonts.file_hash(path)}
                    for path in (video, timeline, subtitle)]
        with patch.object(sys, 'path', [str(SCRIPTS), *sys.path]):
            receipts = load('test_local_font_receipt', 'generate_draft_request.py')
            output = Path(receipts.write_episode_source_receipt(
                draft, stage, 1, retained, timeline, subtitle, {1: video}))
            record = json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(record['subtitle_font']['review_sha256'], self.fonts.file_hash(review))
            self.assertIn(selected['path'], [item['path'] for item in record['materials']])
            self.assertIn(selected['license_path'], [item['path'] for item in record['materials']])
            self.assertIn('muse-review.json', [item['path'] for item in record['files']])
            preserved = output.read_bytes()
            Path(selected['path']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'do not match'):
                receipts.write_episode_source_receipt(draft, stage, 1, retained, timeline, subtitle, {1: video})
            self.assertEqual(output.read_bytes(), preserved)


if __name__ == '__main__':
    unittest.main()
