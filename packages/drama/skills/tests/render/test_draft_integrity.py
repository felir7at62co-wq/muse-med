"""Saved JSON integrity checks; synthetic splits are not editor trim acceptance."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-draft-build/scripts/draft_integrity.py'
SPEC = importlib.util.spec_from_file_location('draft_integrity_tests_subject', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

IDENTITY = 'AAAAAAAA-1111-4111-8111-111111111111'
OTHER_IDENTITY = 'BBBBBBBB-2222-4222-8222-222222222222'


class SavedIdentityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.draft = self.root / '候选-EP42'
        self.draft.mkdir()
        self.meta_path = self.draft / 'draft_meta_info.json'
        self.index_path = self.root / 'root_meta_info.json'
        self.meta = {'draft_id': IDENTITY.lower(), 'draft_name': self.draft.name,
                     'draft_fold_path': str(self.draft)}
        self.row = {'draft_id': IDENTITY, 'draft_name': self.draft.name,
                    'draft_fold_path': str(self.draft)}
        self.save()

    def save(self, rows=None):
        self.meta_path.write_text(json.dumps(self.meta), encoding='utf-8-sig')
        self.index_path.write_text(json.dumps({'all_draft_store': [self.row] if rows is None else rows}),
                                   encoding='utf-8-sig')

    def verify(self):
        return MODULE.verify_saved_identity(self.draft, self.root, IDENTITY)

    def test_uuid_case_and_path_separators_preserve_files(self):
        self.row['draft_fold_path'] = str(self.draft).replace('\\', '/') + '/./'
        self.save([{'draft_name': 'unrelated', 'draft_id': 'legacy-id', 'draft_fold_path': 'old-relative'},
                   None, self.row])
        before = {path: path.read_bytes() for path in (self.meta_path, self.index_path)}
        self.assertIsNone(self.verify())
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_index_identity_mismatch_is_rejected_without_repair(self):
        self.row['draft_id'] = OTHER_IDENTITY
        self.save()
        before = self.index_path.read_bytes()
        with self.assertRaisesRegex(ValueError, '根索引 draft_id.*不一致.*保留现有草稿.*新名称'):
            self.verify()
        self.assertEqual(self.index_path.read_bytes(), before)

    def test_expected_id_must_match_saved_metadata(self):
        self.meta['draft_id'] = OTHER_IDENTITY
        self.save()
        with self.assertRaisesRegex(ValueError, '保存目录的 draft_id'):
            self.verify()

    def test_duplicate_and_missing_index_records_are_rejected(self):
        for rows in ([self.row, dict(self.row)], []):
            with self.subTest(rows=len(rows)):
                self.save(rows)
                with self.assertRaisesRegex(ValueError, '记录缺失或重复'):
                    self.verify()

    def test_conflicting_name_or_uuid_points_to_another_folder(self):
        for field in ('draft_name', 'draft_id'):
            with self.subTest(field=field):
                other = {'draft_fold_path': str(self.root / 'another'), 'draft_name': 'another',
                         'draft_id': OTHER_IDENTITY, field: self.row[field]}
                self.save([self.row, other])
                with self.assertRaisesRegex(ValueError, '指向另一保存目录'):
                    self.verify()

    def test_malformed_readable_identity_is_failure_not_unavailable(self):
        for document in ({}, {'all_draft_store': None}, []):
            with self.subTest(document=document):
                self.index_path.write_text(json.dumps(document), encoding='utf-8')
                with self.assertRaises(ValueError) as caught:
                    self.verify()
                self.assertNotIsInstance(caught.exception, MODULE.DraftIntegrityUnavailable)

    def test_missing_or_opaque_identity_is_explicitly_unavailable(self):
        self.index_path.unlink()
        with self.assertRaises(MODULE.DraftIntegrityUnavailable):
            self.verify()
        for raw in (b'opaque encrypted content', b'\xff\xfe'):
            with self.subTest(raw=raw):
                self.index_path.write_bytes(raw)
                with self.assertRaises(MODULE.DraftIntegrityUnavailable):
                    self.verify()

    def test_readable_meta_contradictions_are_not_hidden_by_unavailable_index(self):
        for field, value, message in (
                ('draft_id', OTHER_IDENTITY, '保存目录的 draft_id'),
                ('draft_id', 'not-a-uuid', '不是有效 UUID'),
                ('draft_fold_path', str(self.root / 'another'), 'draft_fold_path 指向另一目录'),
                ('draft_name', None, 'draft_name 格式错误')):
            for index_state in ('missing', 'opaque'):
                with self.subTest(field=field, index_state=index_state):
                    self.meta = {'draft_id': IDENTITY, 'draft_name': self.draft.name,
                                 'draft_fold_path': str(self.draft), field: value}
                    self.save()
                    if index_state == 'missing':
                        self.index_path.unlink()
                    else:
                        self.index_path.write_bytes(b'opaque encrypted index')
                    with self.assertRaisesRegex(ValueError, message) as caught:
                        self.verify()
                    self.assertNotIsInstance(caught.exception, MODULE.DraftIntegrityUnavailable)

    def test_readable_index_contradictions_are_not_hidden_by_unavailable_meta(self):
        for problem in ('wrong-id', 'wrong-path', 'missing-row', 'duplicate-row', 'bad-name'):
            for meta_state in ('missing', 'opaque'):
                with self.subTest(problem=problem, meta_state=meta_state):
                    row = {'draft_id': IDENTITY, 'draft_name': self.draft.name,
                           'draft_fold_path': str(self.draft)}
                    rows = [row]
                    if problem == 'wrong-id':
                        row['draft_id'] = OTHER_IDENTITY
                    elif problem == 'wrong-path':
                        row['draft_fold_path'] = str(self.root / 'another')
                    elif problem == 'missing-row':
                        rows = []
                    elif problem == 'duplicate-row':
                        rows.append(dict(row))
                    else:
                        row['draft_name'] = None
                    self.save(rows)
                    if meta_state == 'missing':
                        self.meta_path.unlink()
                    else:
                        self.meta_path.write_bytes(b'opaque encrypted metadata')
                    with self.assertRaises(ValueError) as caught:
                        self.verify()
                    self.assertNotIsInstance(caught.exception, MODULE.DraftIntegrityUnavailable)

    def test_one_correct_identity_document_cannot_verify_missing_counterpart(self):
        self.meta_path.unlink()
        with self.assertRaises(MODULE.DraftIntegrityUnavailable):
            self.verify()
        self.save()
        self.meta_path.write_bytes(b'opaque encrypted metadata')
        self.index_path.write_bytes(b'opaque encrypted index')
        with self.assertRaises(MODULE.DraftIntegrityUnavailable):
            self.verify()

    def test_invalid_relevant_fields_cannot_be_ignored(self):
        for field, value in (('draft_fold_path', 'relative'), ('draft_id', 'not-a-uuid'), ('draft_name', None)):
            with self.subTest(field=field):
                self.row = {'draft_id': IDENTITY, 'draft_name': self.draft.name,
                            'draft_fold_path': str(self.draft), field: value}
                self.save()
                with self.assertRaises(ValueError):
                    self.verify()

    def test_meta_path_mismatch_and_root_escape_are_rejected(self):
        self.meta['draft_fold_path'] = str(self.root / 'another')
        self.save()
        with self.assertRaisesRegex(ValueError, 'draft_fold_path 指向另一目录'):
            self.verify()
        with self.assertRaisesRegex(ValueError, '指定草稿根目录'):
            MODULE.verify_saved_identity(self.draft, self.draft, IDENTITY)
        with self.assertRaisesRegex(ValueError, '指定草稿根目录'):
            MODULE.verify_saved_identity(self.draft.parent.parent, self.root, IDENTITY)


class EmbeddedSourceRangeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / '正文 原片.mp4'
        self.content = {'materials': {'videos': [
            {'id': 'body', 'type': 'video', 'path': str(self.source), 'duration': 4_000_000},
            {'id': 'ending', 'type': 'photo', 'path': str(self.root / 'ending.png'), 'duration': 0}],
            'audios': [{'id': 'old-audio', 'duration': 'legacy'}]}, 'tracks': [
                {'type': 'video', 'segments': [self.segment(500_000, 1_000_000, 0, 1_000_000),
                                               {'material_id': 'ending', 'source_timerange': None}]},
                {'type': 'audio', 'segments': [{'material_id': 'old-audio', 'speed': 0}]},
                {'type': 'text', 'segments': [{'material_id': 'text', 'source_timerange': None}]}]}

    @staticmethod
    def segment(start, duration, target_start, target_duration, speed=1):
        return {'material_id': 'body', 'source_timerange': {'start': start, 'duration': duration},
                'target_timerange': {'start': target_start, 'duration': target_duration}, 'speed': speed}

    def verify(self, content=None, durations=None):
        return MODULE.verify_embedded_source_ranges(self.content if content is None else content,
                                                     [self.source], durations)

    def test_nonzero_start_and_legacy_audio_unselected_ending_are_untouched(self):
        before = copy.deepcopy(self.content)
        self.assertIsNone(self.verify(durations={self.source: 4_000_000}))
        self.assertEqual(self.content, before)

    def test_split_roundtrip_preserves_valid_source_target_relation(self):
        segments = self.content['tracks'][0]['segments']
        segments[0:1] = [self.segment(500_000, 400_000, 0, 400_000),
                         self.segment(900_000, 600_000, 400_000, 600_000)]
        path = self.root / 'synthetic-split.json'
        path.write_text(json.dumps(self.content), encoding='utf-8')
        saved = json.loads(path.read_text(encoding='utf-8'))
        self.assertIsNone(self.verify(saved, {self.source: 4_000_000}))
        self.assertEqual([item['source_timerange']['start'] for item in saved['tracks'][0]['segments'][:2]],
                         [500_000, 900_000])

    def test_speed_relation_allows_only_microsecond_quantization(self):
        segment = self.content['tracks'][0]['segments'][0]
        for speed, source, target in ((1.5, 1_000_000, 666_666), (2, 1_000_000, 500_000),
                                      (0.5, 500_000, 1_000_000)):
            with self.subTest(speed=speed):
                segment.update(self.segment(0, source, 0, target, speed))
                self.verify()
        segment.update(self.segment(0, 1_000_002, 0, 1_000_000))
        with self.assertRaisesRegex(ValueError, 'speed 不一致'):
            self.verify()
        segment.update(self.segment(0, 1_100_000, 0, 1_000_000))
        with self.assertRaisesRegex(ValueError, 'speed 不一致'):
            self.verify()

    def test_invalid_speed_does_not_pass(self):
        for speed in (0, -1, True, '1', float('inf'), float('nan')):
            with self.subTest(speed=speed):
                self.content['tracks'][0]['segments'][0]['speed'] = speed
                with self.assertRaisesRegex(ValueError, 'speed 必须是有限正数'):
                    self.verify()

    def test_invalid_integer_ranges_and_duration_are_rejected(self):
        for window in ('source_timerange', 'target_timerange'):
            for field, value in (('start', -1), ('start', 0.0), ('start', True),
                                 ('duration', 0), ('duration', -1), ('duration', 1.0), ('duration', True)):
                with self.subTest(window=window, field=field, value=value):
                    bad = copy.deepcopy(self.content)
                    bad['tracks'][0]['segments'][0][window][field] = value
                    with self.assertRaisesRegex(ValueError, '整数微秒'):
                        self.verify(bad)
        self.content['materials']['videos'][0]['duration'] = True
        with self.assertRaisesRegex(ValueError, 'material.duration'):
            self.verify()

    def test_source_end_must_fit_material_duration(self):
        self.content['tracks'][0]['segments'][0] = self.segment(3_500_001, 500_000, 0, 500_000)
        with self.assertRaisesRegex(ValueError, '超出 material.duration'):
            self.verify()
        self.content['tracks'][0]['segments'][0] = self.segment(3_500_000, 500_000, 0, 500_000)
        self.verify()

    def test_full_source_probe_rejects_inflated_metadata(self):
        with self.assertRaisesRegex(ValueError, 'material.duration 超出探测'):
            self.verify(durations={self.source: 3_999_999})
        self.content['materials']['videos'][0]['duration'] = 1_500_000
        self.assertIsNone(self.verify(durations={self.source: 4_000_000}))

    def test_container_audio_tail_does_not_invalidate_a_playable_video_window(self):
        self.content['materials']['videos'][0]['duration'] = 74_210_975
        self.content['tracks'][0]['segments'][0] = self.segment(0, 74_166_667, 0, 74_166_667)
        self.assertIsNone(MODULE.verify_embedded_source_ranges(
            self.content, [self.source], {self.source: 74_210_975},
            source_window_durations={self.source: 74_166_667}))
        self.content['tracks'][0]['segments'][0] = self.segment(0, 74_166_668, 0, 74_166_668)
        with self.assertRaisesRegex(ValueError, 'source_timerange 超出探测的视频可用时长'):
            MODULE.verify_embedded_source_ranges(
                self.content, [self.source], {self.source: 74_210_975},
                source_window_durations={self.source: 74_166_667})

    def test_playable_window_probe_mapping_must_cover_selected_sources(self):
        for measured in ({}, {self.source: 0}, {self.source: 4_000_000.0}, []):
            with self.subTest(measured=measured):
                with self.assertRaises(ValueError):
                    MODULE.verify_embedded_source_ranges(
                        self.content, [self.source], source_window_durations=measured)

    def test_probe_mapping_must_cover_all_selected_sources(self):
        for measured in ({}, {self.source: 0}, {self.source: 4_000_000.0}, []):
            with self.subTest(measured=measured):
                with self.assertRaises(ValueError):
                    self.verify(durations=measured)

    def test_changed_path_unreferenced_video_and_duplicate_id_are_rejected(self):
        for change in ('path', 'reference', 'duplicate', 'type'):
            with self.subTest(change=change):
                bad = copy.deepcopy(self.content)
                if change == 'path':
                    bad['materials']['videos'][0]['path'] = str(self.root / 'unselected.mp4')
                elif change == 'reference':
                    bad['tracks'][0]['segments'][0]['material_id'] = 'not-body'
                elif change == 'duplicate':
                    bad['materials']['videos'].append(dict(bad['materials']['videos'][0]))
                else:
                    bad['materials']['videos'][0]['type'] = 'photo'
                with self.assertRaises(ValueError):
                    self.verify(bad)

    def test_native_resource_uri_and_windows_path_forms_match(self):
        material = self.content['materials']['videos'][0]
        material['path'] = self.source.as_uri()
        self.verify()
        material['path'] = 'local:///C:/media/%E6%AD%A3%E6%96%87.mp4'
        self.assertIsNone(MODULE.verify_embedded_source_ranges(
            self.content, [r'c:\media\正文.mp4'], {r'C:\MEDIA\正文.mp4': 4_000_000}))

    def test_separate_material_ids_may_reference_same_selected_file(self):
        duplicate = dict(self.content['materials']['videos'][0], id='body-again')
        self.content['materials']['videos'].append(duplicate)
        segment = self.segment(2_000_000, 1_000_000, 1_000_000, 1_000_000)
        segment['material_id'] = 'body-again'
        self.content['tracks'][0]['segments'].append(segment)
        self.verify()

    def test_unreadable_structure_and_empty_selection_cannot_pass(self):
        for content in (None, {}, {'materials': {'videos': []}, 'tracks': []}):
            with self.subTest(content=content):
                with self.assertRaises(ValueError):
                    MODULE.verify_embedded_source_ranges(content, [self.source])
        with self.assertRaises(ValueError):
            MODULE.verify_embedded_source_ranges(self.content, [])


if __name__ == '__main__':
    unittest.main()
