/** Typed assertions for derived source locations exposed by the registered manuscript tools. */
import { z } from 'zod'
import { manuscriptRelationshipSchema } from '../src/manuscript-relationships.ts'

const heading = z.object({ line: z.number().int().positive(), text: z.string(), label: z.string() })
const section = z.object({
  section_index: z.number().int().positive(), source_scene_id: z.string().nullable(),
  kind: z.enum(['scene', 'episode_body', 'unassigned']), episode: z.string(), episode_number: z.string().nullable(),
  episode_label: z.string().nullable(), episode_basis: z.enum(['episode_heading', 'scene_number', 'unassigned']),
  episode_index: z.number().int().positive().nullable(), scene_id: z.string().nullable(), scene_episode_label: z.string().nullable(),
  episode_scene_consistency: z.enum(['matches', 'conflict', 'not_compared']),
  heading: z.string().nullable(), heading_line: z.number().int().positive().nullable(), heading_setting: z.string().nullable(),
  episode_heading: heading.nullable(), scene_heading: heading.nullable(),
  start_line: z.number().int().positive(), end_line: z.number().int().positive(),
  previous_scene_index: z.number().int().positive().nullable(), next_scene_index: z.number().int().positive().nullable(),
})
const selectedSection = section.extend({ selected_start_line: z.number().int().positive(), selected_end_line: z.number().int().positive() })
const navigationReference = section.pick({ section_index: true, source_scene_id: true, episode: true,
  scene_id: true, heading: true, start_line: true, end_line: true })

/** Actual source title sections and whole-section neighbors returned for a quoted or read range. */
export const sourceRangeContextSchema = z.object({ start_line: z.number().int().positive(), end_line: z.number().int().positive(),
  crosses_episodes: z.boolean(), crosses_scenes: z.boolean(),
  sections: z.array(selectedSection.extend({
    previous_section: section.nullable(), next_section: section.nullable() })),
})

/** Source pages retain selected ownership and only minimal, same-version adjacent navigation. */
export const sourcePageContextSchema = sourceRangeContextSchema.extend({ sections: z.array(selectedSection.extend({
  previous_section: navigationReference.nullable(), next_section: navigationReference.nullable(),
})) })

const relationshipSourceContext = sourceRangeContextSchema.extend({ sections: z.array(selectedSection),
  citation_labels: z.array(z.object({ start_line: z.number(), end_line: z.number(), episode: z.string(),
    scene_id: z.string().nullable(), source_scene_id: z.string().nullable() })),
  source_path: z.string(), source_sha256: z.string(),
  time_basis: z.array(z.object({ kind: z.enum(['quote', 'episode_heading', 'scene_heading']),
    start_line: z.number().int().positive(), end_line: z.number().int().positive(), quote: z.string(), value: z.string() })),
  line_labels: z.array(z.object({ line: z.number().int().positive(), kind: z.enum(['heading', 'action', 'dialogue', 'other']),
    speaker_label: z.string().nullable(), voice_marker: z.string().nullable(), speaker_annotation: z.string().nullable(),
    speech_column: z.number().int().positive().nullable() })),
  notice: z.string(),
})

/** Active relationship projection retains its authored fields and computed source locations. */
export const reportedRelationshipSchema = manuscriptRelationshipSchema.extend({ source_contexts: z.array(relationshipSourceContext) })

/** Stale or unsupported notes retain their complete authored data and concrete reread reasons. */
export const recheckRelationshipSchema = manuscriptRelationshipSchema.extend({ scope_issues: z.array(z.object({
  field: z.enum(['evidence', 'episode', 'scene_id', 'story_time', 'context', 'contextual_name']),
  code: z.enum(['source_unavailable', 'range_unavailable', 'quote_mismatch', 'unassigned', 'mismatch',
    'unsupported_time', 'structured_scope_required', 'term_not_in_body', 'speaker_unresolved', 'speaker_ambiguous', 'speaker_mismatch']),
  message: z.string(),
})) })

/**
 * Read the actual tool's complete report by following its declared collection requests.
 * @param request - Registered or owner-local manuscript request dispatcher.
 * @returns Complete audit data for focused semantic assertions, including all bounded pages.
 */
export async function readAuditCollections(request: (args: object) => Promise<unknown>): Promise<unknown> {
  const first = await request({ action: 'audit' })
  const directory = z.object({ summary: z.unknown(), report_sections: z.array(z.object({
    section: z.string(), total_items: z.number(), request: z.record(z.string(), z.unknown()),
  })) })
  const manifest = directory.extend({ report_paged: z.literal(true) }).safeParse(first)
  if (!manifest.success) return first
  const itemDirectory = directory.extend({ report_item_paged: z.literal(true), report_offset: z.number().int().positive() })
  const readDirectory = async (current: z.infer<typeof directory>): Promise<unknown> => {
    const groups = new Map<string, unknown[]>()
    for (const section of current.report_sections) {
      const rows: unknown[] = []
      let cursor: Record<string, unknown> | null = section.request
      while (cursor) {
        const page = z.object({ items: z.array(z.unknown()), continuation: z.record(z.string(), z.unknown()).nullable() })
          .parse(await request(cursor))
        for (const row of page.items) {
          const nested = itemDirectory.safeParse(row)
          rows.push(nested.success ? await readDirectory(nested.data) : row)
        }
        if (rows.length > section.total_items || (page.continuation && page.items.length === 0)) throw Error('Audit did not advance')
        cursor = page.continuation
      }
      if (rows.length !== section.total_items) throw Error('Incomplete audit collection')
      groups.set(section.section, rows)
    }
    const restore = (value: unknown): unknown => {
      const reference = z.strictObject({ report_section: z.string(), total_items: z.number() }).safeParse(value)
      if (reference.success) {
        const rows = groups.get(reference.data.report_section)
        if (!rows) throw Error('Audit collection was not read')
        return rows
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, restore(entry)]))
      }
      return value
    }
    return restore(current.summary)
  }
  return readDirectory(manifest.data)
}
