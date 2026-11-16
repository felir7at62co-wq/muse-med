"""Keep video-frame removal notices intact through the built Python SDK profile."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
CASE = ROOT / 'snapshots' / 'session' / 'muse-video-review-lifecycle'


@pytest.mark.skipif(not CLI.is_file(), reason='requires the built dsh SDK runtime')
def test_frame_removal_notice_preserves_observations_and_sdk_events(tmp_path: Path) -> None:
    scope = tmp_path / 'home' / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai'
    scope.mkdir(parents=True)
    for name, package in [('dsh-llm-replay', 'test-support/llm-replay'),
                          ('dsh-tool-video-inspect', 'perception/tool-video-inspect')]:
        (scope / name).symlink_to(ROOT / 'packages' / package, target_is_directory=True)
    (tmp_path / 'fixture.mp4').write_text('Deterministic media source for the external-process fixture.\n')
    (tmp_path / 'unrelated.md').write_text('A separate document whose delivery does not complete video observations.\n')
    policy = tmp_path / 'policy.yml'
    policy.write_text(json.dumps([{'id': 'sandbox-policy', 'config': {'mode': 'danger-full-access'}}]))
    rows = [json.loads(line) for line in (CASE / 'session.v4.jsonl').read_text().splitlines()]
    user = next(row['data'] for row in rows if row['type'] == 'user/message'
                and row['data']['source']['kind'] == 'user')
    task = '\n'.join(block['text'] for block in user['content'] if block['type'] == 'text')
    with DeepSeekHarness(
        dsh_bin=str(CLI), dsh_home=str(tmp_path / 'home'), cwd=str(tmp_path), runtime_cwd=str(tmp_path),
        profile='sdk', patches=(str(CASE / 'cordis.snapshot.yml'), str(policy)),
        provider='deepseek-official', model='deepseek-v4-flash',
        env={'DEEPSEEK_API_KEY': '', 'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay',
             'DSH_SNAPSHOT_FILE': str(CASE / 'session.v4.jsonl')},
    ) as harness:
        result = harness.run(task)
    assert result.finish_reason == 'completed'
    events = result.events
    offloads = [event for event in events if event['type'] == 'image/offload']
    assert len(offloads) == 1
    assert '该帧图已在之前的步骤中展示给你' in offloads[0]['data']['notice']
    assert offloads[0]['data']['targets'][0]['imageIndexes'] == [0, 1]
    observations = [event['data'] for event in events if event['type'] == 'video/review'
                    and event['data'].get('kind') == 'update']
    assert any(any(frame.get('observation') for frame in row['frames']) for row in observations)
    streamed = [notification.payload['event'] for notification in result.notifications
                if notification.method == 'session.event'
                and notification.payload['sessionId'] == result.session_id]
    assert streamed == events
