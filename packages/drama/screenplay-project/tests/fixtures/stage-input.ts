/** Project records converted to model-command inputs with absent optional fields. */
import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { ProjectFile, ProjectRequest, REQUEST_STORY } from '../../src/schema.ts'

type Candidate = ProjectFile['candidates'][number]
type Stage = Extract<ProjectRequest, { method: 'stage' }>

/**
 * Copy durable scenes without explicit undefined properties in model inputs.
 * @param scenes - Parsed candidate scenes.
 * @returns Stage command scenes.
 */
export function stageScenes(scenes: Candidate['scenes']): Stage['scenes'] {
  return scenes.map(scene => ({
    location: scene.location, time: scene.time, layer: scene.layer, transition: scene.transition,
    characters: scene.characters,
    ...(scene.setting === undefined ? {} : { setting: scene.setting }),
    ...(scene.voice_only_characters === undefined ? {} : { voice_only_characters: scene.voice_only_characters }),
    beats: scene.beats.map(beat => ({
      kind: beat.kind, text: beat.text, fact_ids: beat.fact_ids,
      requires_knowledge: beat.requires_knowledge, witnesses: beat.witnesses,
      ...(beat.actor === undefined ? {} : { actor: beat.actor }),
      ...(beat.audible_in_scene === undefined ? {} : { audible_in_scene: beat.audible_in_scene }),
      ...(beat.hook === undefined ? {} : { hook: beat.hook }),
      ...(beat.sync_with === undefined ? {} : { sync_with: beat.sync_with }),
      ...(beat.synchrony_reason === undefined ? {} : { synchrony_reason: beat.synchrony_reason }),
    })),
  }))
}

/**
 * Copy sampled coverage without explicit undefined intervals in model inputs.
 * @param coverage - Parsed inventory coverage.
 * @returns Stage command coverage.
 */
export function stageCoverage(coverage: NonNullable<Candidate['coverage']>): NonNullable<Stage['coverage']> {
  return { required_beats: coverage.required_beats, windows: coverage.windows.map(window => ({
    source_id: window.source_id, start: window.start, count: window.count,
    ...(window.interval === undefined ? {} : { interval: window.interval }),
  })) }
}

/**
 * Copy story notes without undefined optional source and revision references.
 * @param notes - Parsed adaptation notes.
 * @returns Stage command story notes.
 */
export function stageStoryNotes(notes: NonNullable<Candidate['story_adaptation']>['notes']): NonNullable<InferValue<(typeof REQUEST_STORY)['oneOf'][9]>['story_notes']> {
  return { inventory_id: notes.inventory_id, mapping: notes.mapping,
    dispositions: notes.dispositions, scene_changes: notes.scene_changes,
    editor_comments: notes.editor_comments, unresolved: notes.unresolved,
    ...(notes.input_candidate_id === undefined ? {} : { input_candidate_id: notes.input_candidate_id }),
    changes: notes.changes.map(change => ({ reason: change.reason,
      ...(change.source === undefined ? {} : { source: { unit_id: change.source.unit_id,
        ...(change.source.fact_id === undefined ? {} : { fact_id: change.source.fact_id }) } }),
      ...(change.before === undefined ? {} : { before: change.before }),
      ...(change.after === undefined ? {} : { after: change.after }),
    })),
  }
}
