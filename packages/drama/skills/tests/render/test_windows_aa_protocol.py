"""Run the shipped PowerShell adapter against a synthetic native command peer."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ADAPTER = (Path(__file__).resolve().parents[2]
           / 'skills/tweet-drama-draft-build/scripts/windows/aa-draft.ps1')

# This peer reproduces the observed add-video metadata bug. It does not claim to
# emulate the editor's storage format or prove actual editor compatibility.
PEER = r'''
$ErrorActionPreference = 'Stop'
$callArguments = @($args)
$global:LASTEXITCODE = 0
$statePath = Join-Path $env:MUSE_PROTOCOL_FIXTURE 'state.json'
$callsPath = Join-Path $env:MUSE_PROTOCOL_FIXTURE 'calls.jsonl'
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::AppendAllText($callsPath, ((@{ arguments = $callArguments } | ConvertTo-Json -Depth 20 -Compress) + "`n"), $utf8)

function Flag([string] $Name) {
  $index = [Array]::IndexOf($script:callArguments, $Name)
  if ($index -lt 0) { return $null }
  return $script:callArguments[$index + 1]
}
function Micros([string] $Value) { return [long]($Value -replace 'us$', '') }
function Result([object] $Value) {
  @{ err_code = 0; err_msg = ''; result = $Value } | ConvertTo-Json -Depth 30 -Compress
}
function Save-State {
  [IO.File]::WriteAllText($script:statePath, ($script:state | ConvertTo-Json -Depth 30 -Compress), $script:utf8)
  $content = @{ materials = @{ videos = @($script:state.segments | ForEach-Object { $_.material }) };
                tracks = @(@{ type = 'video'; segments = @($script:state.segments | ForEach-Object {
                  @{ id = $_.id; material_id = $_.material.id; source_timerange = $_.source_timerange;
                     target_timerange = $_.target_timerange; volume = $_.volume }
                }) }) }
  [IO.File]::WriteAllText((Join-Path $script:state.draft_path 'draft_content.json'),
                        ($content | ConvertTo-Json -Depth 30 -Compress), $script:utf8)
}

if ($callArguments[0] -eq '--version') { 'fixture CLI'; return }
if ($callArguments -contains '--help') {
  $flags = '--ref --dir --resource --start --duration --track --width --height --seg-id --linear --content --size --color --outline-width --x --y --ratio --source-start --source-duration --is-photo --include-tracks'
  if ($env:MUSE_PROTOCOL_MISSING_SOURCE_DURATION -eq '1' -and $callArguments[1] -eq 'video' -and $callArguments[2] -eq 'replace') {
    $flags = $flags.Replace(' --source-duration', '')
  }
  $flags
  return
}

$verb = ($callArguments[0..2] -join ' ')
if ($verb -eq 'draft project list') { Result @{ projects = @() }; return }
if ($verb -eq 'draft project create') {
  $reference = Flag '--ref'
  $draftPath = Join-Path (Flag '--dir') $reference.Substring('local://'.Length)
  New-Item -ItemType Directory -Path $draftPath | Out-Null
  $script:state = @{ draft_path = $draftPath; segments = @() }
  Save-State
  Result @{ ref = $reference; draft_id = 'AAAAAAAA-1111-4111-8111-111111111111' }
  return
}

$script:state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($verb -eq 'draft video add') {
  $id = 'video-' + (@($state.segments).Count + 1)
  $duration = Micros (Flag '--duration')
  $resource = Flag '--resource'
  $row = [pscustomobject]@{
    id = $id
    material = @{ id = ('material-' + $id); path = $resource; duration = [long]3000000 }
    source_timerange = @{ start = [long]0; duration = $duration }
    target_timerange = @{ start = (Micros (Flag '--start')); duration = $duration }
    volume = [double]1
  }
  $state.segments = @($state.segments) + @($row)
  Save-State
  Result @{ segment_ids = @($id) }
  return
}
if ($verb -eq 'draft video replace') {
  if ($env:MUSE_PROTOCOL_FAIL_REPLACE -eq '1') {
    $global:LASTEXITCODE = 37
    @{ err_code = 37; err_msg = 'fixture source replacement failed' } | ConvertTo-Json -Compress
    return
  }
  $segment = @($state.segments | Where-Object { $_.id -eq (Flag '--seg-id') })
  if ($segment.Count -ne 1) { throw 'Replacement did not address one saved segment' }
  if ($segment[0].material.path -cne (Flag '--resource')) { throw 'Replacement changed the selected source' }
  if ((Micros (Flag '--source-start')) -ne 0) { throw 'Replacement changed the source start' }
  $segment[0].material.duration = Micros (Flag '--source-duration')
  Save-State
  Result @{ segment_ids = @($segment[0].id) }
  return
}
if ($verb -eq 'draft video volume') {
  $segment = @($state.segments | Where-Object { $_.id -eq (Flag '--seg-id') })
  if ($segment.Count -ne 1) { throw 'Volume did not address one saved segment' }
  $segment[0].volume = [double](Flag '--linear')
  Save-State
  Result @{ segment_ids = @($segment[0].id) }
  return
}
if ($verb -eq 'draft blueprint sync') {
  if ($callArguments -contains '--workspace') { throw 'Unexpected workspace export' }
  if ($callArguments -notcontains '--include-tracks') { throw 'Missing track readback' }
  Result @{ fixture = 'material-duration-state'; segments = @($state.segments) }
  return
}
if ($verb -eq 'draft extract --ref') { Result @{ json_result = '[]' }; return }
if ($callArguments[0] -eq 'draft' -and $callArguments[1] -eq 'config') { Result @{ configured = $true }; return }
throw ('Unexpected fixture command: ' + $verb)
'''


@unittest.skipUnless(os.name == 'nt', 'The native PowerShell adapter runs on Windows')
class WindowsAaProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='muse-aa-protocol-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.drafts = self.root / 'drafts'
        self.drafts.mkdir()
        self.peer = self.root / 'native-peer.ps1'
        self.peer.write_text(PEER, encoding='utf-8-sig')
        self.plan_path = self.root / 'plan.json'
        self.result_path = self.root / 'receipt.json'
        self.sources = [self.root / 'source one.mp4', self.root / '第二段.mp4']
        for index, source in enumerate(self.sources):
            source.write_bytes(f'synthetic media {index}'.encode())
        self.original_bytes = {path: path.read_bytes() for path in self.sources}
        self.plan = {
            'schema_version': 1, 'audio_mode': 'embedded', 'name': 'candidate-protocol',
            'ref': 'local://candidate-protocol', 'drafts_dir': str(self.drafts),
            'draft_path': str(self.drafts / 'candidate-protocol'), 'ratio': '16:9',
            'delivery': {'width': 1920, 'height': 1080, 'fps': 30, 'add_watermark': False},
            'draft_style': {'subtitle': {}, 'watermark': {}},
            'audio': {'master_gain': 0.8, 'bgm_gain': 0.25},
            'native_subtitles': [], 'native_duration_us': 28_066_667,
            'native_videos': [
                {'path': str(self.sources[0]), 'source_duration_us': 26_080_000,
                 'start_us': 0, 'duration_us': 26_066_667, 'width': 1920, 'height': 1080},
                {'path': str(self.sources[1]), 'source_duration_us': 17_400_000,
                 'start_us': 26_066_667, 'duration_us': 2_000_000, 'width': 1920, 'height': 1080},
            ],
        }

    def invoke(self, **environment):
        self.plan_path.write_text(json.dumps(self.plan), encoding='utf-8')
        system_modules = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/Modules'
        powershell = system_modules.parent / 'powershell.exe'
        result = subprocess.run([
            str(powershell), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', str(ADAPTER), '-PlanPath', str(self.plan_path),
            '-ResultPath', str(self.result_path), '-NativeHost',
        ], env={**os.environ, 'JY_CLI': str(self.peer), 'MUSE_PROTOCOL_FIXTURE': str(self.root),
                'PSModulePath': str(system_modules),
                'MUSE_PROTOCOL_MISSING_SOURCE_DURATION': '', 'MUSE_PROTOCOL_FAIL_REPLACE': '', **environment},
            capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertTrue(self.result_path.is_file(), result.stderr)
        receipt = json.loads(self.result_path.read_text(encoding='utf-8-sig'))
        calls = [json.loads(line)['arguments'] for line in (self.root / 'calls.jsonl').read_text(encoding='utf-8-sig').splitlines()]
        self.assertEqual({path: path.read_bytes() for path in self.sources}, self.original_bytes)
        return result, receipt, calls

    @staticmethod
    def value(arguments, option):
        return arguments[arguments.index(option) + 1]

    def assert_preserved_materials(self):
        result, receipt, calls = self.invoke()
        self.assertEqual(result.returncode, 0, receipt)
        self.assertTrue(receipt['ok'])
        self.assertEqual(receipt['runtime']['cli_sha256'], hashlib.sha256(self.peer.read_bytes()).hexdigest())
        state = json.loads((self.root / 'state.json').read_text(encoding='utf-8-sig'))
        self.assertEqual(receipt['body_segment_ids'], ['video-1', 'video-2'])
        self.assertEqual(len(state['segments']), 2)
        mutations = [args for args in calls if args[:2] == ['draft', 'video'] and '--help' not in args]
        self.assertEqual([args[2] for args in mutations], ['add', 'replace', 'volume'] * 2)
        for index, (saved, expected) in enumerate(zip(state['segments'], self.plan['native_videos'])):
            add, replace, volume = mutations[index * 3:index * 3 + 3]
            self.assertEqual(self.value(replace, '--seg-id'), saved['id'])
            self.assertEqual(self.value(volume, '--seg-id'), saved['id'])
            self.assertEqual(self.value(replace, '--resource'), self.value(add, '--resource'))
            self.assertEqual(self.value(replace, '--source-start'), '0us')
            self.assertEqual(self.value(replace, '--source-duration'), f'{expected["source_duration_us"]}us')
            self.assertEqual(saved['material']['duration'], expected['source_duration_us'])
            self.assertEqual(saved['source_timerange'], {'start': 0, 'duration': expected['duration_us']})
            self.assertEqual(saved['target_timerange'], {'start': expected['start_us'], 'duration': expected['duration_us']})
            self.assertEqual(saved['volume'], 0.8)
        readback = [args for args in calls if args[:3] == ['draft', 'blueprint', 'sync'] and '--help' not in args]
        self.assertEqual(len(readback), 1)
        self.assertIn('--include-tracks', readback[0])
        self.assertNotIn('--workspace', readback[0])
        self.assertEqual(receipt['material_readback']['fixture'], 'material-duration-state')
        self.assertEqual(receipt['material_readback']['segments'], state['segments'])
        self.assertEqual(receipt['events'][-1]['step'], 'readback-materials')

    def test_full_source_durations_are_restored_without_retiming_segments(self):
        self.assert_preserved_materials()

    def test_repeated_source_keeps_distinct_segment_ids_and_intervals(self):
        self.plan['native_videos'][1]['path'] = str(self.sources[0])
        self.plan['native_videos'][1]['source_duration_us'] = 26_080_000
        self.assert_preserved_materials()

    def test_missing_source_duration_capability_fails_before_creating_a_draft(self):
        result, receipt, calls = self.invoke(MUSE_PROTOCOL_MISSING_SOURCE_DURATION='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(receipt['ok'])
        self.assertIn('source-duration', receipt['error'])
        self.assertFalse(Path(self.plan['draft_path']).exists())
        self.assertFalse(any(args[:3] == ['draft', 'project', 'create'] and '--help' not in args for args in calls))

    def test_source_replacement_failure_keeps_the_partial_candidate_and_stops(self):
        result, receipt, calls = self.invoke(MUSE_PROTOCOL_FAIL_REPLACE='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(receipt['ok'])
        self.assertIn('fixture source replacement failed', receipt['error'])
        draft = Path(self.plan['draft_path'])
        self.assertTrue((draft / 'draft_content.json').is_file())
        state = json.loads((self.root / 'state.json').read_text(encoding='utf-8-sig'))
        self.assertEqual(len(state['segments']), 1)
        self.assertEqual(state['segments'][0]['material']['duration'], 3_000_000)
        self.assertEqual(receipt['events'][-1]['step'], 'body-source-duration')
        self.assertEqual(receipt['events'][-1]['state'], 'started')
        self.assertNotIn('material_readback', receipt)
        self.assertFalse(any(args[:3] == ['draft', 'blueprint', 'sync'] and '--help' not in args for args in calls))


if __name__ == '__main__':
    unittest.main()
