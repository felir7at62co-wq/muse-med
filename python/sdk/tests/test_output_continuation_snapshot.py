"""Project same-turn output continuation through the shipped Python SDK runtime."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
CASE = ROOT / 'snapshots' / 'sdk' / 'output-continuation'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_output_continuation_snapshot(tmp_path: Path) -> None:
    link = tmp_path / 'home' / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai' / 'dsh-llm-replay'
    link.parent.mkdir(parents=True)
    link.symlink_to(ROOT / 'packages' / 'test-support' / 'llm-replay', target_is_directory=True)
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / 'home'),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(str(CASE / 'cordis.yml'), str(CASE / 'cordis.snapshot.yml')),
        provider='deepseek-official',
        model='deepseek-v4-flash',
        env={
            'DSH_TELEMETRY_DISABLED': '1',
            'DSH_SNAPSHOT': 'replay',
            'DSH_SNAPSHOT_FILE': str(CASE / 'session.v4.jsonl'),
        },
    ) as harness:
        result = harness.run('Print the three answer segments in order.')
    endings = [event['data'] for event in result.events if event['type'] == 'turn/end']
    continuations = [event['data']['source'] for event in result.events
                     if event['type'] == 'user/message'
                     and event['data']['source']['kind'] == 'output-continuation']
    segments = [''.join(block['text'] for block in event['data']['message']['content']
                        if block['type'] == 'text')
                for event in result.events if event['type'] == 'assistant/message']
    actual = {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'endings': endings,
        'continuations': continuations,
        'segments': segments,
    }
    expected = Path(__file__).with_name('expected') / 'output-continuation.json'
    assert actual == json.loads(expected.read_text())
