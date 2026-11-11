/** Bounded facts from one selected work and one document generation. */
import type {
  DouyinDataAggregation, DouyinDataSnapshot, DouyinObservationReference, DouyinVideoId,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

type Origin = DouyinObservationReference['source']
type Reason = DouyinDataAggregation['reason']
const countKeys = ['play_count', 'digg_count', 'comment_count', 'share_count', 'collect_count'] as const

/** Keep selected facts with their individual observation sources. */
export class DouyinDataAccumulator {
  private base: DouyinDataSnapshot | undefined
  private counts: DouyinDataSnapshot['counts'] | undefined
  private description: string | null = null
  private authorName: string | null = null
  private publishedAt: number | null = null
  private seriesTitle: string | null = null
  private observedAt = ''
  private readonly references: Record<'counts' | 'series' | 'description' | 'authorName' | 'publishedAt', DouyinObservationReference | null> = {
    counts: null, series: null, description: null, authorName: null, publishedAt: null,
  }
  private readonly countReferences: Record<typeof countKeys[number], DouyinObservationReference | null> = {
    play_count: null, digg_count: null, comment_count: null, share_count: null, collect_count: null,
  }

  /** @param target - The task's exact selected work. */
  constructor(private readonly target: DouyinVideoId) {}

  /** @returns Whether counters and a visible series were both observed. */
  get paired(): boolean { return this.references.counts !== null && this.references.series !== null }

  /** @returns Whether at least one validated observation was admitted. */
  get hasObservation(): boolean { return this.base !== undefined }

  /**
   * @param value - An observation already checked against the task's document and lease.
   * @param source - The page probe or the observed detail response.
   * @returns False for an identity or explicit value conflict.
   */
  add(value: DouyinDataSnapshot, source: Origin): boolean {
    if (value.targetVideoId !== this.target || (this.base !== undefined && value.source !== this.base.source)) return false
    const meta = value.metadata, ref: DouyinObservationReference = { source, observedAt: value.observedAt }
    if (meta?.seriesTitle != null && (source !== 'page' || meta.seriesSource !== 'visible-series-list')) return false
    if ((this.description !== null && meta?.description != null && this.description !== meta.description)
      || (this.authorName !== null && meta?.authorName != null && this.authorName !== meta.authorName)
      || (this.publishedAt !== null && meta?.publishedAt != null && this.publishedAt !== meta.publishedAt)
      || (this.seriesTitle !== null && meta?.seriesTitle != null && this.seriesTitle !== meta.seriesTitle)) return false
    if (this.counts !== undefined) {
      for (const key of countKeys) {
        const previous = this.counts[key], next = value.counts[key]
        if (previous.value !== null && next.value !== null && (previous.value !== next.value
          || previous.precision === next.precision && previous.display !== next.display)) return false
      }
    }
    this.base ??= value
    this.observedAt = value.observedAt
    this.counts ??= { ...value.counts }
    const selected = { ...this.counts }
    for (const key of countKeys) {
      if (this.countReferences[key] === null && value.counts[key].value !== null) {
        selected[key] = value.counts[key]
        this.countReferences[key] = ref
        this.references.counts ??= ref
      } else if (selected[key].precision === 'rounded' && value.counts[key].precision === 'exact') {
        selected[key] = value.counts[key]
        this.countReferences[key] = ref
      }
    }
    this.counts = selected
    if (this.description === null && meta?.description != null) { this.description = meta.description; this.references.description = ref }
    if (this.authorName === null && meta?.authorName != null) { this.authorName = meta.authorName; this.references.authorName = ref }
    if (this.publishedAt === null && meta?.publishedAt != null) { this.publishedAt = meta.publishedAt; this.references.publishedAt = ref }
    if (this.seriesTitle === null && meta?.seriesTitle != null) { this.seriesTitle = meta.seriesTitle; this.references.series = ref }
    return true
  }

  /**
   * @param reason - Why the task stopped collecting.
   * @returns The selected observations and their separate source times.
   */
  result(reason: Reason): DouyinDataSnapshot {
    if (this.base === undefined) throw new Error('Cannot finish an empty Douyin aggregation')
    return { ...this.base, observedAt: this.observedAt, counts: this.counts ?? this.base.counts,
      metadata: { description: this.description, authorName: this.authorName, publishedAt: this.publishedAt,
        seriesTitle: this.seriesTitle, seriesSource: this.seriesTitle === null ? null : 'visible-series-list' },
      aggregation: { status: reason === 'paired' ? 'complete' : 'partial', reason,
        observations: { ...this.references, counts: { ...this.countReferences } } } }
  }
}
