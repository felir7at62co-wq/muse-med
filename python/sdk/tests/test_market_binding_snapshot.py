"""Retain required market bindings through the Python SDK and ordinary built sdk profile."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
CASE = ROOT / 'snapshots' / 'session' / 'muse-skill-market-version-binding'
INPUT = (
    'Load the version-bound-review Skill, switch its default publication from version one to version two, '
    'load it again in this executed Session, then exercise the blank Session created before the switch and a fresh Session. '
    'Observe the full actual Skill results and bindings. Reply exactly SKILL_VERSION_BINDING_VERIFIED.'
)


@pytest.mark.skipif(not CLI.is_file(), reason='requires the built dsh sdk profile and market activation entry')
def test_market_binding_snapshot(tmp_path: Path) -> None:
    scope = tmp_path / 'home' / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai'
    scope.mkdir(parents=True)
    (scope / 'dsh-llm-replay').symlink_to(
        ROOT / 'packages' / 'test-support' / 'llm-replay', target_is_directory=True,
    )
    with DeepSeekHarness(
        dsh_bin=str(CLI), dsh_home=str(tmp_path / 'home'), cwd=str(tmp_path), runtime_cwd=str(tmp_path),
        profile='sdk', patches=(str(CASE / 'cordis.snapshot.yml'),),
        provider='deepseek-official', model='deepseek-v4-flash',
        initialize_timeout_seconds=110, request_timeout_seconds=110,
        env={
            'DEEPSEEK_API_KEY': '', 'DSH_TELEMETRY_DISABLED': '1', 'DSH_EXAMPLE_MODE': 'lib',
            'DSH_SNAPSHOT': 'replay', 'DSH_SNAPSHOT_FILE': str(CASE / 'session.v4.jsonl'),
            'DSH_SNAPSHOT_CHILD_FILES': os.pathsep.join(str(CASE / name) for name in (
                'session.1.v4.jsonl', 'session.2.v4.jsonl',
            )),
        },
    ) as harness:
        result = harness.run(INPUT)
    bindings = [event for event in result.events if event['type'] == 'muse-market/bound']
    assert len(bindings) == 1
    first_request = next(event for event in result.events if event['type'] == 'request/header')
    assert bindings[0]['seq'] < first_request['seq']
    lifecycle = {}
    tool_results = [event for event in result.events if event['type'] == 'tool/result']
    assert len(tool_results) == 5
    for event in tool_results:
        message = event['data']['message']
        assert message.get('isError') is not True
        if message['toolCallId'] in {'call_version_2', 'call_version_4', 'call_version_5'}:
            text = ''.join(block['text'] for block in message['content'] if block['type'] == 'text')
            lifecycle[message['toolCallId']] = json.loads(text)
    for event in bindings:
        assert not {'ignorable', 'skipped', 'unreported'} & event.keys()
    actual = {
        'finalResponse': result.final_response, 'finishReason': result.finish_reason,
        'bindingEvents': [{'type': event['type'], 'data': event['data']} for event in bindings],
        'lifecycle': lifecycle, 'proof': json.loads((tmp_path / 'market-version-proof.json').read_text()),
    }
    expected = Path(__file__).with_name('expected') / 'market-binding.json'
    assert actual == json.loads(expected.read_text())
    root_notifications = [notification.payload['event'] for notification in result.notifications
                          if notification.method == 'session.event'
                          and notification.payload['sessionId'] == result.session_id]
    assert [event for event in root_notifications if event['type'] == 'muse-market/bound'] == bindings
    assert sum(event['type'] == 'request/header' for event in result.events) == 1
