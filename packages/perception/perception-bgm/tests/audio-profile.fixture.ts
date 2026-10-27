/** Synthetic audio inference metadata, unrelated to any user track or real model evaluation. */
import { STORY_TAGS } from '../src/story.ts'

/** Create bounded, hash-linked inference metadata for catalogue and story tests.
 * @param sha256 - Exact fixture audio digest used by the owning test.
 * @returns A fresh JSON-compatible profile whose scores are synthetic test values.
 */
export function audioProfileFixture(sha256: string) {
  return { version: 1, source_sha256: sha256, analysis_method: 'sampled_clap_cosine_v1',
    model_id: 'laion/clap-htsat-unfused', model_revision: '8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a',
    recipe_sha256: `sha256:${'b'.repeat(64)}`, human_reviewed: false,
    analyzed_at: '2026-10-27T06:00:00Z', duration_seconds: 60, sample_count: 2, sampled_seconds: 20,
    estimated_tempo_bpm: 80, rms_dbfs: -18, peak_dbfs: -1,
    tags: [{ tag: 'family', similarity: 0.4 }, { tag: 'gentle', similarity: 0.35 }],
    instruments: [{ tag: 'piano', similarity: 0.5 }],
    vocals: [{ tag: 'instrumental', similarity: 0.45 }, { tag: 'singing', similarity: 0.1 }, { tag: 'speech', similarity: 0.05 }],
    windows: [{ start_seconds: 0, end_seconds: 10, tags: [{ tag: 'family', similarity: 0.4 }] },
      { start_seconds: 50, end_seconds: 60, tags: [{ tag: 'gentle', similarity: 0.4 }] }],
    tag_scores: Object.fromEntries(STORY_TAGS.map(tag => [tag, tag === 'family' ? 0.4 : tag === 'gentle' ? 0.35 : 0.2])),
    review_note: 'Synthetic fixture; not an audio evaluation or human audition.' }
}
