/** Actual OCR and complete-review artifact layouts with deterministic unit-test executions. */
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { fileSha256 } from '../src/cache.ts'
import type { SourceQaVerifier } from '../src/source-qa.ts'

export function sourceQaOcrLine(text: string) {
  return { text, bounding_box: { x: 100, y: 900, width: 300, height: 45 },
    words: [{ text, bounding_box: { x: 100, y: 900, width: 300, height: 45 } }] }
}

export async function sourceQaFixture(project: string, media: string, label = 'selected') {
  const ocrPath = join(project, `${label}-ocr.json`)
  const inspectionPath = join(project, `${label}-observation.json`)
  const frame = { id: 'ocr-frame-1', requested_seconds: 0, timestamp_seconds: 0,
    image_width: 720, image_height: 1280, lines: [] as ReturnType<typeof sourceQaOcrLine>[] }
  const ocr = { schema_version: 1, evidence_algorithm: 'decoded-pts-spatial-v2', path: media, source_version: 'test-source-version', duration_seconds: 5,
    text_source: 'ocr', language_requested: 'zh-Hans-CN', language_used: 'zh-Hans-CN',
    interval: { start_seconds: 0, end_seconds: 5 }, scan_status: 'complete', text_status: 'no_text_detected',
    coverage: { planned_frame_count: 10, processed_frame_count: 10, failed_frame_count: 0,
      frame_interval_seconds: 0.5, scanned_ranges: [{ start_seconds: 0, end_seconds: 5 }],
      unscanned_ranges: [] as { start_seconds: number; end_seconds: number; reason: string }[], failed_timestamps_seconds: [] },
    frames: Array.from({ length: 10 }, (_, index) => ({ ...frame, id: `ocr-frame-${index + 1}`,
      requested_seconds: index * 0.5, timestamp_seconds: index * 0.5 })),
    segments: [] as { text: string; start_seconds: number; end_seconds: number; evidence_frame_ids: string[] }[] }
  const inspection = { id: `review-${label}`, episode: '24', path: media, source_version: 'test-source-version',
    duration: 5, scanned_until: 5, scan_complete: true,
    frames: [{ id: 'F00001', time: 2.5, decoded_time: 2.5, reasons: ['continuity'], exposed: true,
      image: { attachmentId: 'test-image-1', mediaType: 'image/png', bytes: 100, width: 720, height: 1280 },
      observation: { visible: '画面中的人物正在桌旁交谈', change: '人物抬手', uncertainty: '' } }] }
  const declaration = { media_path: media, media_sha256: await fileSha256(media),
    ocr: { path: ocrPath, sha256: '' },
    inspection: { path: inspectionPath, sha256: '', session_id: 'test-source-session', review_id: inspection.id },
    text_decisions: [] as {
      segment_index: number
      text: string
      start_seconds: number
      end_seconds: number
      kind: string
      reason: string
      observation_frame_ids: string[]
    }[] }
  const save = async () => {
    await writeFile(ocrPath, JSON.stringify(ocr))
    await writeFile(inspectionPath, JSON.stringify(inspection))
    declaration.ocr.sha256 = await fileSha256(ocrPath)
    declaration.inspection.sha256 = await fileSha256(inspectionPath)
    return declaration
  }
  await save()
  return { ocr, inspection, declaration, save }
}

/** Pure validation tests stub the independent Host proof, which has its own real Session regressions. */
export const verifiedSourceQaFixture: SourceQaVerifier = async () => {}
