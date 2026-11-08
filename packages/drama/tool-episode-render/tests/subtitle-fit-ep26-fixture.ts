/** Archived EP26 cue 28: millisecond SRT end, source-bound word end 333 microseconds later. */
import type { SpeechCoverageReport, SpeechCoverageWord } from '../src/speech-coverage.ts'
import type { SubtitleCue } from '../src/types.ts'

export const ep26Cue: SubtitleCue = { index: 28, startSeconds: 64.408, endSeconds: 66.368,
  text: '可我现在每天按时起每天都干活' }
const words: readonly SpeechCoverageWord[] = [
  { id: '6:6', shot: 6, clip_index: 6, word_index: 6, text: '可',
    source_start_seconds: 1.2, source_end_seconds: 1.44, start_seconds: 64.408333, end_seconds: 64.648333 },
  { id: '6:7', shot: 6, clip_index: 6, word_index: 7, text: '我',
    source_start_seconds: 1.44, source_end_seconds: 1.56, start_seconds: 64.648333, end_seconds: 64.768333 },
  { id: '6:8', shot: 6, clip_index: 6, word_index: 8, text: '现',
    source_start_seconds: 1.56, source_end_seconds: 1.68, start_seconds: 64.768333, end_seconds: 64.888333 },
  { id: '6:9', shot: 6, clip_index: 6, word_index: 9, text: '在',
    source_start_seconds: 1.68, source_end_seconds: 1.76, start_seconds: 64.888333, end_seconds: 64.968333 },
  { id: '6:10', shot: 6, clip_index: 6, word_index: 10, text: '每',
    source_start_seconds: 1.76, source_end_seconds: 1.88, start_seconds: 64.968333, end_seconds: 65.088333 },
  { id: '6:11', shot: 6, clip_index: 6, word_index: 11, text: '天',
    source_start_seconds: 1.88, source_end_seconds: 2, start_seconds: 65.088333, end_seconds: 65.208333 },
  { id: '6:12', shot: 6, clip_index: 6, word_index: 12, text: '按',
    source_start_seconds: 2, source_end_seconds: 2.12, start_seconds: 65.208333, end_seconds: 65.328333 },
  { id: '6:13', shot: 6, clip_index: 6, word_index: 13, text: '时',
    source_start_seconds: 2.12, source_end_seconds: 2.24, start_seconds: 65.328333, end_seconds: 65.448333 },
  { id: '6:14', shot: 6, clip_index: 6, word_index: 14, text: '起',
    source_start_seconds: 2.28, source_end_seconds: 2.52, start_seconds: 65.488333, end_seconds: 65.728333 },
  { id: '6:15', shot: 6, clip_index: 6, word_index: 15, text: '每',
    source_start_seconds: 2.52, source_end_seconds: 2.64, start_seconds: 65.728333, end_seconds: 65.848333 },
  { id: '6:16', shot: 6, clip_index: 6, word_index: 16, text: '天',
    source_start_seconds: 2.64, source_end_seconds: 2.72, start_seconds: 65.848333, end_seconds: 65.928333 },
  { id: '6:17', shot: 6, clip_index: 6, word_index: 17, text: '都',
    source_start_seconds: 2.72, source_end_seconds: 2.84, start_seconds: 65.928333, end_seconds: 66.048333 },
  { id: '6:18', shot: 6, clip_index: 6, word_index: 18, text: '干',
    source_start_seconds: 2.84, source_end_seconds: 3, start_seconds: 66.048333, end_seconds: 66.208333 },
  { id: '6:19', shot: 6, clip_index: 6, word_index: 19, text: '活',
    source_start_seconds: 3, source_end_seconds: 3.16, start_seconds: 66.208333, end_seconds: 66.368333 },
]

/** Fresh report rows preserve the archived measured word times for each test.
 * @returns The complete matched words without claiming independent listening verification.
 */
export function ep26Evidence(): SpeechCoverageReport {
  return { schema_version: 1, assessment: 'asr_candidate_comparison', listening_verified: false,
    subtitle_path: '', subtitle_sha256: '', evidence_sha256: '87e5f228038a7e63b6d84cc218c20b61ad3347d1b899eb9632a03a04784b9cce',
    evidence_complete: true, sources: [], words: words.map(word => ({ ...word })),
    matches: words.map(word => ({ word_id: word.id, cue_index: 28, text: word.text, precision: 'word' })),
    findings: [], warnings: [] }
}
