"""Read-only core and delivery video ban checks; no media tools are executed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILLS = Path(__file__).resolve().parents[2] / 'skills'
sys.path.insert(0, str(SKILLS / 'tweet-drama-core' / 'scripts'))


class VideoBanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.tmp.cleanup)
        self.project = Path(self.tmp.name)
        self.source = self.project / 'video/11/shot_003.mp4'
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b'banned version')
        self.row = dict(sha256=hashlib.sha256(self.source.read_bytes()).hexdigest(), labels=['人物对调'], reason='', banned=True, updated_at='2026-01-01T00:00:00.000Z', video=str(self.source))
        self.save()

    def save(self):
        (self.project / 'video-bans.json').write_text(json.dumps(dict(version=1, videos=[self.row])), encoding='utf-8')

    def test_unban_and_same_path_new_bytes_allowed(self):
        from video_bans import check_videos
        self.row['banned'] = False
        self.save()
        check_videos(self.project, [self.source])
        self.row['banned'] = True
        self.save()
        self.source.write_bytes(b'new version')
        check_videos(self.project, [self.source])

    def test_clean_master_not_blocked_by_unused_banned_shot(self):
        spec = importlib.util.spec_from_file_location('delivery', SKILLS / 'tweet-drama-delivery/scripts/assemble_delivery.py')
        delivery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(delivery)
        master = self.project / 'clean-master.mp4'
        master.write_bytes(b'clean confirmed master')
        config = self.project / '_probe/delivery-config'
        config.mkdir(parents=True)
        (config / 'confirmed-films.json').write_text(json.dumps({'films': {'11': str(master)}}))
        self.assertEqual(delivery.pick_master(self.project, 11), master)

    def test_delivery_rejects_banned_master(self):
        spec = importlib.util.spec_from_file_location('delivery', SKILLS / 'tweet-drama-delivery/scripts/assemble_delivery.py')
        delivery = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(delivery)
        config = self.project / '_probe/delivery-config'
        config.mkdir(parents=True)
        (config / 'confirmed-films.json').write_text(json.dumps({'films': {'11': str(self.source)}}))
        with self.assertRaisesRegex(ValueError, '人物对调'):
            delivery.pick_master(self.project, 11)

    def test_state_surfaces_tags_without_review_manifest(self):
        from pipeline_state import PipelineState
        state = PipelineState(self.project)
        complete, evidence, missing = state._reviewed_sources(['11'])
        self.assertEqual(complete, [])
        self.assertIn('人物对调', ' '.join(missing))

    def test_absent_list_and_other_project_do_not_ban(self):
        from video_bans import check_videos
        other = self.project / 'other-project'
        other.mkdir()
        check_videos(other, [self.source])

    def test_missing_project_mapping_is_explicit(self):
        from video_bans import find_project
        with self.assertRaisesRegex(ValueError, 'explicit project'):
            find_project(self.source.parent)
        (self.project / 'project_config.json').write_text('{}')
        self.assertEqual(find_project(self.source.parent), self.project)

    def test_manual_status_does_not_hide_projected_ban(self):
        from pipeline_state import PipelineState
        state = PipelineState(self.project)
        state.set('export', 'completed')
        result = state.project_stages(dry_run=True)['export']
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['projected'], 'blocked')
        self.assertIn('人物对调', result['note']['video_bans'])

    def test_unreadable_list_fails_closed(self):
        from video_bans import read_bans
        with patch.object(Path, 'read_text', side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(ValueError, 'cannot read'):
                read_bans(self.project)

    def test_invalid_timestamp_and_relative_path_rejected(self):
        from video_bans import read_bans
        for field, value in [('updated_at', '2026-02-31T00:00:00.000Z'), ('updated_at', 'yesterday'), ('video', 'relative.mp4')]:
            original = self.row[field]
            self.row[field] = value
            self.save()
            with self.assertRaises(ValueError):
                read_bans(self.project)
            self.row[field] = original

    def test_bad_list_fails_closed(self):
        from video_bans import check_videos
        for data in ('{', '{"version":1,"videos":{}}', '{"version":1,"videos":[{}]}'):
            (self.project / 'video-bans.json').write_text(data)
            with self.assertRaises(ValueError):
                check_videos(self.project, [self.source])


if __name__ == '__main__':
    unittest.main()
