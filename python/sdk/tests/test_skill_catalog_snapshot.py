"""Preserve complete bounded Skill directory results through the ordinary built SDK profile."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
CASE = ROOT / 'snapshots' / 'session' / 'muse-skill-market-bounded-catalog'
SESSION = 'sdk-skill-catalog-primary'


def recorded_input() -> str:
    for line in (CASE / 'session.v4.jsonl').read_text().splitlines():
        event = json.loads(line)
        if event['type'] != 'agent/inbox/spliced':
            continue
        for message in event['data'].get('inserted', []):
            if message.get('source', {}).get('kind') == 'user':
                return '\n'.join(block['text'] for block in message['content'] if block['type'] == 'text')
    raise AssertionError('The recorded SDK scenario has no direct user input')


def hydrate(value: object, identities: dict[str, str], cwd: Path) -> object:
    if isinstance(value, str):
        value = re.sub(r'\{\{cwd\}\}([\\/][^\n]*)',
                       lambda match: str(cwd.joinpath(*re.split(r'[\\/]', match[1]))), value)
        for token, identity in identities.items():
            value = value.replace(token, identity)
        return value.replace('{{cwd}}', str(cwd))
    if isinstance(value, list):
        return [hydrate(item, identities, cwd) for item in value]
    if isinstance(value, dict):
        return {key: hydrate(item, identities, cwd) for key, item in value.items()}
    return value


@pytest.mark.skipif(not CLI.is_file(), reason='requires the built dsh sdk profile and bounded Skill tool')
def test_skill_catalog_snapshot(tmp_path: Path) -> None:
    scope = tmp_path / 'home' / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai'
    scope.mkdir(parents=True)
    (scope / 'dsh-llm-replay').symlink_to(ROOT / 'packages' / 'test-support' / 'llm-replay', target_is_directory=True)
    with DeepSeekHarness(
        dsh_bin=str(CLI), dsh_home=str(tmp_path / 'home'), cwd=str(tmp_path), runtime_cwd=str(tmp_path),
        profile='sdk', patches=(str(CASE / 'cordis.snapshot.yml'),),
        provider='deepseek-official', model='deepseek-v4-flash',
        env={'DEEPSEEK_API_KEY': '', 'DSH_TELEMETRY_DISABLED': '1', 'DSH_EXAMPLE_MODE': 'lib',
             'DSH_SNAPSHOT': 'replay', 'DSH_SNAPSHOT_FILE': str(CASE / 'session.v4.jsonl')},
    ) as harness:
        result = harness.run(recorded_input(), session_id=SESSION)
    assert result.session_id == SESSION
    notifications = [notification.payload['event'] for notification in result.notifications
                     if notification.method == 'session.event' and notification.payload['sessionId'] == result.session_id]
    assert notifications == result.events
    catalogs = [event['data'] for event in result.events if event['type'] == 'user/message'
                and event['data']['source']['kind'] == 'skill-catalog']
    assert catalogs
    for catalog in catalogs:
        assert catalog['source']['bounded'] is True
        assert 'incomplete' not in catalog['source']
    tools = [event['data'] for event in result.events if event['type'] == 'tool/result']
    calls = {event['data']['callId']: event['data'] for event in result.events if event['type'] == 'tool/call'}
    for previous, next_call in [('call_bounded_page_1', 'call_bounded_page_2'),
                                ('call_bounded_page_2', 'call_bounded_page_3')]:
        message = next(event['message'] for event in tools if event['message']['toolCallId'] == previous)
        page = json.loads(''.join(block['text'] for block in message['content'] if block['type'] == 'text'))
        assert json.loads(calls[next_call]['arguments'])['cursor'] == page['nextCursor']
        assert page['nextCursor']['sessionId'] == result.session_id
    for call_id, code in [('call_bounded_foreign', 'SKILL_CATALOG_FOREIGN_CURSOR'),
                          ('call_bounded_stale', 'SKILL_CATALOG_STALE_CURSOR'),
                          ('call_bounded_invalid', 'SKILL_CATALOG_INVALID_REQUEST')]:
        failure = next(event for event in tools if event['message']['toolCallId'] == call_id)
        assert failure['message']['isError'] is True
        assert failure['message']['content'] == [{'type': 'text', 'text': f'Error: {code}'}]
        assert failure['error']['name'] == 'SkillCatalogError'
        assert failure['error']['code'] == code
    expected_path = Path(__file__).with_name('expected') / 'skill-catalog.json'
    expected = json.loads(expected_path.read_text())
    identities = {'{{session:1}}': result.session_id}
    for value, actual in zip(expected['catalogMessages'], catalogs, strict=True):
        identities[value['id']] = actual['id']
    for value in expected['toolResults']:
        actual = next(event for event in tools if event['message']['toolCallId'] == value['message']['toolCallId'])
        identities[value['message']['id']] = actual['message']['id']
    actual = {'finalResponse': result.final_response, 'finishReason': result.finish_reason,
              'catalogMessages': catalogs, 'toolResults': tools,
              'proof': json.loads((tmp_path / 'market-catalog-proof.json').read_text())}
    assert actual == hydrate(expected, identities, tmp_path.resolve())
