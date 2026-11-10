"""Observe real durable admission IDs through the built ordinary SDK profile."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
CASE = ROOT / 'packages' / 'sdk' / 'client' / 'tests' / 'fixtures' / 'durable-inbox-runtime'
SESSION = 'sdk-durable-inbox-primary'
TASK = 'Keep this original SDK input and reply once.'


def hydrate(value: object, human: str, filtered: str) -> object:
    if isinstance(value, str):
        return value.replace('{{humanMessage}}', human).replace('{{filteredMessage}}', filtered)
    if isinstance(value, list):
        return [hydrate(item, human, filtered) for item in value]
    if isinstance(value, dict):
        return {key: hydrate(item, human, filtered) for key, item in value.items()}
    return value


@pytest.mark.skipif(not CLI.is_file(), reason='requires the built dsh sdk profile with durable inbox claims')
def test_durable_inbox_runtime(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scope = tmp_path / 'home' / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai'
    scope.mkdir(parents=True)
    (scope / 'dsh-llm-replay').symlink_to(ROOT / 'packages' / 'test-support' / 'llm-replay', target_is_directory=True)
    with DeepSeekHarness(
        dsh_bin=str(CLI), dsh_home=str(tmp_path / 'home'), cwd=str(tmp_path), runtime_cwd=str(tmp_path),
        profile='sdk', patches=(str(CASE / 'cordis.patch.yml'),),
        provider='sdk-claim-replay', model='claim-model',
        env={'DEEPSEEK_API_KEY': '', 'DSH_TELEMETRY_DISABLED': '1', 'DSH_EXAMPLE_MODE': 'lib',
             'DSH_SNAPSHOT': 'replay', 'DSH_SNAPSHOT_FILE': str(CASE / 'reply.json'),
             'DSH_SNAPSHOT_OVERRIDE': str(CASE / 'reply.json')},
    ) as harness:
        # Observe the real transport response without replacing the wire or its decoder.
        raw = harness.client._request_raw
        receipts: list[object] = []

        def observe(method: str, params: object = None, **options: object) -> object:
            response = raw(method, params, **options)
            if method == 'session/query':
                receipts.append(response)
            return response

        monkeypatch.setattr(harness.client, '_request_raw', observe)
        result = harness.run(TASK, session_id=SESSION)
    assert len(receipts) == 1
    receipt = receipts[0]
    assert isinstance(receipt, dict) and receipt['kind'] == 'prompt' and isinstance(receipt['messageId'], str)
    human_id = receipt['messageId']
    assert result.session_id == SESSION
    notifications = [notification.payload['event'] for notification in result.notifications
                     if notification.method == 'session.event' and notification.payload['sessionId'] == SESSION]
    assert notifications == result.events
    inserted = [message for event in result.events if event['type'] == 'agent/inbox/spliced'
                for message in event['data']['inserted']]
    original = [message for message in inserted if message['id'] == human_id]
    assert len(original) == 1
    filtered = next(message for message in inserted if message['id'] != human_id)
    assert filtered['id'] != human_id
    admitted = [event['data'] for event in result.events if event['type'] == 'user/message'
                and event['data']['source']['kind'] == 'user']
    assert [message['id'] for message in admitted] == [human_id]
    claims = [{'type': event['type'], 'data': event['data']} for event in result.events
              if event['type'].startswith('agent/inbox/claim')]
    header = next(event['data']['header'] for event in result.events if event['type'] == 'request/header')
    end = next(event['data'] for event in result.events if event['type'] == 'turn/end')
    assert result.finish_reason == 'completed', end
    assert result.final_response == 'SDK_DURABLE_CLAIM_OK'
    proof = json.loads((tmp_path / 'sdk-durable-inbox-proof.json').read_text())
    assert proof['humanMessageId'] == human_id
    assert proof['filteredMessageId'] == filtered['id']
    actual = {
        'sessionId': result.session_id, 'queryReceipt': receipt, 'humanEnqueueReceipts': len(original),
        'originalHuman': original[0], 'claims': claims, 'admittedUserMessages': admitted,
        'modelRequest': header['config'], 'finalResponse': result.final_response,
        'finishReason': result.finish_reason, 'turnEnd': end,
        'proof': {'sessionId': proof['sessionId'], 'humanMessageId': proof['humanMessageId'],
                  'filteredMessageId': proof['filteredMessageId'], 'requests': proof['requests'],
                  'humanWasModelInput': human_id in proof['modelMessageIds'],
                  'filteredWasModelInput': filtered['id'] in proof['modelMessageIds']},
    }
    expected = json.loads((Path(__file__).with_name('expected') / 'durable-inbox-runtime.json').read_text())
    assert actual == hydrate(expected, human_id, filtered['id'])
