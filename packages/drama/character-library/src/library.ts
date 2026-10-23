/** Host-owned character-reference business rules over a least-capability object store. */
import { Context, Service } from '@deepseek-ai/cordis'
import { CharacterCatalogError, loadCharacterAssets, parseCharacterMetadata } from '@deepseek-ai/dsh-character-asset-catalog'
import type { CatalogAssetId, CharacterMetadataRecord, CharacterObjectReader, CharacterStorageSourceId } from '@deepseek-ai/dsh-character-asset-catalog'
import { CHARACTER_LIBRARY_PREFIXES, CHARACTER_LIBRARY_SOURCE_ID, DEFAULT_PREVIEW_BYTES, MAX_BROWSE_LIMIT, MAX_MATCH_CANDIDATES, MAX_LIST_PAGES_PER_PREFIX, MAX_LIST_PAGE_SIZE, MAX_METADATA_BYTES, MAX_PREVIEW_BYTES, collectionFor, prefixFor } from './constants.ts'
import { CharacterLibraryError, type CharacterLibraryFailureStage } from './errors.ts'
import type { CharacterLibraryObjectStore } from './store.ts'
import type { CharacterLibraryBrowseRequest, CharacterLibraryBrowseResult, CharacterLibraryDetailRequest, CharacterLibraryEntry, CharacterLibraryPrefix, CharacterLibraryPreview, CharacterLibraryPreviewRequest, CharacterRecommendationCandidate, CharacterMatchResult, CharacterRecommendationRequest, CharacterRecommendationResult, CharacterLibraryStatus } from './types.ts'
import { assertSafeKey, boundedList, boundedText, detectDecodableImage, digest, failRequest, metadataCandidate } from './validation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned public character-reference business service. */
    characterLibrary: CharacterLibrary
  }
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const SAFE_RESULT = {
  canPublish: false,
  canReuse: false,
  canBind: false,
  applyAllowed: false,
} as const
const CATALOG_ID_PREFIX = 'character:' + CHARACTER_LIBRARY_SOURCE_ID + ':'
const CATALOG_SOURCE_ID = CHARACTER_LIBRARY_SOURCE_ID as CharacterStorageSourceId
interface RecordAtPrefix {
  readonly prefix: CharacterLibraryPrefix
  readonly record: CharacterMetadataRecord
  readonly metadataSha256: string
}

interface ScoredRecord {
  readonly item: RecordAtPrefix
  readonly candidate: CharacterRecommendationCandidate
}

type ScoredResult =
  | {
    readonly status: 'scored'
    readonly records: readonly ScoredRecord[]
    readonly supportReason: string | undefined
    readonly requiredEra: string | undefined
  }
  | {
    readonly status: 'no_match'
    readonly reason: string
    readonly uncertainties: readonly string[]
  }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function enabled(value: unknown): boolean {
  return value === true
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
}

function safeTags(record: CharacterMetadataRecord): readonly string[] {
  const value = record.raw.metadata.tags
  if (!Array.isArray(value) || value.length > 32) return []
  const tags: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 80
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(item)) return []
    tags.push(item)
  }
  return tags
}

function toEntry(item: Pick<RecordAtPrefix, 'prefix' | 'record'>): CharacterLibraryEntry {
  const { record, prefix } = item
  return {
    catalogAssetId: record.identity.catalog_asset_id,
    originalAssetId: record.identity.original_asset_id,
    collection: collectionFor(prefix),
    format: record.raw.format,
    metadataStatus: record.adapted.metadata_status_class,
    metadataKey: record.derived.metadata_key,
    imageKey: record.derived.image_key,
    category: record.adapted.category,
    setting: record.adapted.setting,
    artStyle: record.adapted.art_style,
    era: record.adapted.era ?? [],
    gender: record.adapted.gender,
    appearance: (record.adapted.appearance ?? []).map(
      (claim: NonNullable<CharacterMetadataRecord['adapted']['appearance']>[number]) => claim.value,
    ),
    tags: safeTags(record),
    safety: SAFE_RESULT,
  }
}

function prefixSelection(collection: CharacterLibraryBrowseRequest['collection']): readonly CharacterLibraryPrefix[] {
  if (collection === undefined || collection === 'all') return CHARACTER_LIBRARY_PREFIXES
  return [prefixFor(collection)]
}

function browseFingerprint(request: CharacterLibraryBrowseRequest): string {
  const key = JSON.stringify({
    collection: request.collection ?? 'all',
    query: request.query ?? '',
    metadataStatus: request.metadataStatus ?? null,
  })
  return digest(Buffer.from(key)).slice(0, 16)
}

function offsetFromCursor(cursor: string | undefined, fingerprint: string): number {
  if (cursor === undefined) return 0
  const match = /^v1:(0|[1-9][0-9]{0,6}):([0-9a-f]{16})$/.exec(cursor)
  if (!match || match[2] !== fingerprint) failRequest('browse')
  return Number(match[1])
}

function validateCatalogId(value: CatalogAssetId | string, stage: 'detail' | 'preview'): string {
  if (typeof value !== 'string' || value.length > 256
    || !value.startsWith(CATALOG_ID_PREFIX)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.slice(CATALOG_ID_PREFIX.length))) {
    failRequest(stage)
  }
  return value
}

function validatePage(
  value: unknown,
  prefix: CharacterLibraryPrefix,
  limit: number,
): { readonly keys: readonly string[]; readonly nextCursor: string | null } {
  if (!object(value) || !Array.isArray(value.objects) || value.objects.length > limit) {
    throw new CharacterLibraryError('LIST_FAILED', 'browse')
  }
  const nextCursor = value.nextCursor
  if (nextCursor !== null && (typeof nextCursor !== 'string'
    || nextCursor.length === 0 || nextCursor.length > 512
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(nextCursor))) {
    throw new CharacterLibraryError('LIST_FAILED', 'browse')
  }
  const keys: string[] = []
  for (const candidate of value.objects) {
    if (!object(candidate) || typeof candidate.key !== 'string'
      || typeof candidate.bytes !== 'number' || !Number.isSafeInteger(candidate.bytes)
      || candidate.bytes < 0
      || (candidate.etag !== null && typeof candidate.etag !== 'string')) {
      throw new CharacterLibraryError('LIST_FAILED', 'browse')
    }
    assertSafeKey(candidate.key, prefix)
    if (metadataCandidate(candidate.key, prefix)) {
      if (candidate.bytes > MAX_METADATA_BYTES) {
        throw new CharacterLibraryError('CATALOG_REJECTED', 'browse')
      }
      keys.push(candidate.key)
    }
  }
  return { keys, nextCursor }
}

function validateGet(value: unknown, key: string, maxBytes: number, stage: CharacterLibraryFailureStage) {
  if (!object(value)) throw new CharacterLibraryError('PREVIEW_UNAVAILABLE', stage)
  const { data, bytes, etag, contentType } = value
  if (value.key !== key || !(data instanceof Uint8Array)
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes !== data.byteLength
    || bytes > maxBytes
    || (etag !== null && typeof etag !== 'string')
    || (contentType !== null && typeof contentType !== 'string')) {
    throw new CharacterLibraryError('PREVIEW_UNAVAILABLE', stage)
  }
  return { key, data, bytes, etag, contentType }
}

function validateMetadataHead(
  value: unknown,
  key: string,
  stage: 'detail' | 'preview',
): void {
  if (!object(value) || value.key !== key
    || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0 || value.bytes > MAX_METADATA_BYTES
    || (value.etag !== null && typeof value.etag !== 'string')
    || (value.contentType !== null && typeof value.contentType !== 'string')) {
    throw new CharacterLibraryError('CATALOG_REJECTED', stage)
  }
}

function recordCorpus(entry: CharacterLibraryEntry): string {
  return normalized([
    entry.category,
    entry.setting,
    entry.artStyle,
    ...entry.era,
    entry.gender,
    ...entry.appearance,
    ...entry.tags,
  ].filter((value): value is string => value !== null).join(' '))
}

function eraClass(value: string): 'ancient' | 'modern' | '1980s' | null {
  const text = normalized(value)
  if (/1980|1980s|80年代|八十年代/.test(text)) return '1980s'
  if (/古装|古代|ancient|historical|wuxia|仙侠/.test(text)) return 'ancient'
  if (/现代|都市|modern|contemporary|urban/.test(text)) return 'modern'
  return null
}

function artStyleClass(value: string): 'realistic' | 'illustration' | null {
  const text = normalized(value)
  if (/realistic|photo|live.action|真人|写实|摄影|实拍/u.test(text)) return 'realistic'
  if (/anime|illustrat|cartoon|动漫|动画|插画|二次元/u.test(text)) return 'illustration'
  return null
}

function scoreEntry(
  entry: CharacterLibraryEntry,
  request: {
    readonly query?: string
    readonly requiredEra?: string
    readonly gender?: string
    readonly styleTerms: readonly string[]
    readonly traitTerms: readonly string[]
    readonly roleTerms: readonly string[]
  },
): CharacterRecommendationCandidate | null {
  if (entry.metadataStatus === 'rejected_claim') return null
  const corpus = recordCorpus(entry)
  const matched: string[] = []
  let score = 0
  if (request.requiredEra !== undefined) {
    const wanted = eraClass(request.requiredEra)
    const declared = entry.era.map(eraClass)
      .filter((value): value is 'ancient' | 'modern' | '1980s' => value !== null)
    if (wanted !== null && declared.length > 0 && !declared.includes(wanted)) return null
    if (wanted !== null && declared.includes(wanted)) {
      score += 6
      matched.push('era')
    } else if (corpus.includes(normalized(request.requiredEra))) {
      score += 3
      matched.push('era-text')
    }
  }
  if (request.gender !== undefined
    && entry.gender !== null
    && normalized(entry.gender) === normalized(request.gender)) {
    score += 4
    matched.push('gender')
  }
  const addTerms = (terms: readonly string[], weight: number, kind: string): void => {
    for (const term of terms) {
      if (corpus.includes(normalized(term))) {
        score += weight
        matched.push(kind + ':' + term)
      }
    }
  }
  const declaredStyle = entry.artStyle === null ? null : artStyleClass(entry.artStyle)
  if (declaredStyle !== null && request.styleTerms.some(term => artStyleClass(term) === declaredStyle)) {
    score += 6
    matched.push('art_style:' + declaredStyle)
  }
  addTerms(request.styleTerms.filter(term => declaredStyle === null || artStyleClass(term) !== declaredStyle), 2, 'style')
  addTerms(request.traitTerms, 2, 'trait')
  addTerms(request.roleTerms, 2, 'role')
  if (request.query !== undefined) {
    const terms = normalized(request.query).split(/\s+/u).filter(Boolean)
    for (const term of terms) {
      if (corpus.includes(term)) {
        score++
        matched.push('query:' + term)
      }
    }
  }
  return score > 0 ? { entry, score, matched } : null
}

function matchUncertainties(
  candidates: readonly CharacterRecommendationCandidate[],
  requiredEra: string | undefined,
): readonly string[] {
  return [
    ...new Set([
      ...candidates.map(candidate => 'metadata_status:' + candidate.entry.metadataStatus),
      ...(requiredEra === undefined || candidates.every(candidate => candidate.entry.era.length > 0)
        ? [] : ['era_unconfirmed']),
    ]),
  ]
}

/** Host domain service. The store provider owns credentials and all network behavior. */
export class CharacterLibrary extends Service {
  static inject = ['characterLibraryObjectStore']

  private readonly store: CharacterLibraryObjectStore

  constructor(ctx: Context) {
    super(ctx, 'characterLibrary')
    this.store = ctx.characterLibraryObjectStore
  }

  /**
   * Report the mounted service boundary without doing object-store IO.
   * @returns Read and pending-ingest readiness for the mounted provider.
   */
  status(): CharacterLibraryStatus {
    let configured = false
    try {
      const status = this.store.status()
      configured = enabled(status.readConfigured)
    } catch {
      // Readiness is fail-closed so a broken provider cannot make the UI look configured.
    }
    return {
      configured,
      sourceId: CHARACTER_LIBRARY_SOURCE_ID,
      readOnly: true,
      uploadPending: 'unavailable',
    }
  }

  /**
   * List and adapt a bounded set of catalog metadata records.
   * @param request - Collection, filter, page size, and optional cursor.
   * @param signal - Optional cancellation signal.
   * @returns A bounded page of catalog entries and its continuation cursor.
   */
  async browse(
    request: CharacterLibraryBrowseRequest = {},
    signal?: AbortSignal,
  ): Promise<CharacterLibraryBrowseResult> {
    signal?.throwIfAborted()
    const query = request.query === undefined ? undefined : boundedText(request.query, 200, 'browse')
    const limit = request.limit ?? 20
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BROWSE_LIMIT) failRequest('browse')
    const normalizedRequest: CharacterLibraryBrowseRequest = query === undefined
      ? request
      : { ...request, query }
    this.assertReadConfigured('browse')
    const fingerprint = browseFingerprint(normalizedRequest)
    const offset = offsetFromCursor(request.cursor, fingerprint)
    const records = await this.scan(prefixSelection(request.collection), signal)
    const filtered = records
      .map(toEntry)
      .filter(entry => request.metadataStatus === undefined || entry.metadataStatus === request.metadataStatus)
      .filter(entry => query === undefined || recordCorpus(entry).includes(normalized(query)))
    const entries = filtered.slice(offset, offset + limit)
    const nextOffset = offset + entries.length
    return {
      entries,
      nextCursor: nextOffset < filtered.length ? `v1:${String(nextOffset)}:${fingerprint}` : null,
      scanned: records.length,
    }
  }

  /**
   * Resolve one stable catalog identity without reading its image.
   * @param request - Stable catalog asset identity to resolve.
   * @param signal - Optional cancellation signal.
   * @returns The adapted catalog entry.
   */
  async detail(
    request: CharacterLibraryDetailRequest,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryEntry> {
    const target = validateCatalogId(request.catalogAssetId, 'detail')
    this.assertReadConfigured('detail')
    const item = await this.find(target, 'detail', signal)
    return toEntry(item)
  }

  /**
   * Read and verify one bounded image preview entirely in memory.
   * @param request - Catalog identity and optional image byte bound.
   * @param signal - Optional cancellation signal.
   * @returns Verified raster bytes with their measured identity.
   */
  async preview(
    request: CharacterLibraryPreviewRequest,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryPreview> {
    const target = validateCatalogId(request.catalogAssetId, 'preview')
    const maxBytes = request.maxBytes ?? DEFAULT_PREVIEW_BYTES
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PREVIEW_BYTES) failRequest('preview')
    if (request.expectedSha256 !== undefined
      && !/^[0-9a-f]{64}$/.test(request.expectedSha256)) failRequest('preview')
    this.assertReadConfigured('preview')
    const item = await this.find(target, 'preview', signal)
    return this.previewItem(item, maxBytes, request.expectedSha256, signal)
  }

  private async previewItem(
    item: RecordAtPrefix,
    maxBytes: number,
    expectedSha256?: string,
    signal?: AbortSignal,
  ): Promise<CharacterLibraryPreview> {
    const reads = new Map<string, ReturnType<typeof validateGet>>()
    const readState = { identityMismatch: false }
    const reader: CharacterObjectReader = {
      read: async (_source: CharacterStorageSourceId, key: string) => {
        const bound = key === item.record.derived.metadata_key ? MAX_METADATA_BYTES : maxBytes
        const result = validateGet(await this.store.get(key, bound, signal), key, bound, 'preview')
        if (key === item.record.derived.metadata_key
          && digest(result.data) !== item.metadataSha256) {
          readState.identityMismatch = true
          throw new CharacterLibraryError('IMAGE_MISMATCH', 'preview')
        }
        reads.set(key, result)
        return result.data
      },
    }
    let verified
    try {
      [verified] = await loadCharacterAssets(
        CATALOG_SOURCE_ID,
        [item.record.derived.metadata_key],
        reader,
      )
    } catch (error) {
      if (readState.identityMismatch) throw new CharacterLibraryError('IMAGE_MISMATCH', 'preview')
      if (error instanceof CharacterCatalogError && error.code === 'IMAGE_MISMATCH') {
        throw new CharacterLibraryError('IMAGE_MISMATCH', 'preview')
      }
      throw new CharacterLibraryError('PREVIEW_UNAVAILABLE', 'preview')
    }
    /* v8 ignore next -- the catalog loader returns one record for the one explicit metadata key. */
    if (verified === undefined) throw new CharacterLibraryError('PREVIEW_UNAVAILABLE', 'preview')
    if (verified.identity.catalog_asset_id !== item.record.identity.catalog_asset_id
      || verified.identity.original_asset_id !== item.record.identity.original_asset_id
      || verified.derived.metadata_key !== item.record.derived.metadata_key
      || verified.derived.image_key !== item.record.derived.image_key
      || expectedSha256 !== undefined && verified.observed.sha256 !== expectedSha256) {
      throw new CharacterLibraryError('IMAGE_MISMATCH', 'preview')
    }
    const image = reads.get(verified.derived.image_key)
    /* v8 ignore next -- a verified catalog record exists only after its image reader completed. */
    if (image === undefined) throw new CharacterLibraryError('PREVIEW_UNAVAILABLE', 'preview')
    const detected = await detectDecodableImage(image.data)
    signal?.throwIfAborted()
    if (detected === null || image.contentType !== null && image.contentType !== detected.mediaType) {
      throw new CharacterLibraryError('IMAGE_INVALID', 'preview')
    }
    return {
      catalogAssetId: verified.identity.catalog_asset_id,
      metadataStatus: verified.adapted.metadata_status_class,
      data: Uint8Array.from(image.data),
      contentType: detected.mediaType,
      bytes: verified.observed.bytes,
      sha256: verified.observed.sha256,
      safety: SAFE_RESULT,
    }
  }

  /**
   * Select one best read-only reference or require review for an exact top-score tie.
   * @param request - Bounded role and appearance requirements.
   * @param signal - Optional cancellation signal.
   * @returns A recommendation, review request, or no-match result without use permission.
   */
  async recommend(
    request: CharacterRecommendationRequest,
    signal?: AbortSignal,
  ): Promise<CharacterRecommendationResult> {
    const scored = await this.scoreCandidates(request, signal)
    if (scored.status === 'no_match') return { ...scored, applyAllowed: false }
    const { supportReason, requiredEra } = scored
    const candidates = scored.records.map(({ candidate }) => candidate)
    const topScore = Math.max(...candidates.map(candidate => candidate.score))
    const top = candidates.filter(candidate => candidate.score === topScore)
    const uncertainties = matchUncertainties(top, requiredEra)
    const roleExplanation = supportReason === undefined ? '' : ' Story context: ' + supportReason
    if (top.length > 1) {
      return {
        status: 'needs_review',
        candidates: top,
        reason: 'Multiple candidates share the highest semantic score; catalog IDs did not break the tie.'
          + roleExplanation,
        uncertainties,
        applyAllowed: false,
      }
    }
    const [winner] = top as [CharacterRecommendationCandidate, ...CharacterRecommendationCandidate[]]
    return {
      status: 'recommended',
      candidate: winner,
      reason: 'One candidate has the unique highest semantic score.' + roleExplanation,
      uncertainties,
      applyAllowed: false,
    }
  }

  /**
   * Rank at most three metadata matches and measure their original-image digests.
   * @param request - Bounded role and appearance requirements.
   * @param signal - Optional cancellation signal.
   * @returns Verified image identities for visual selection, without use permission.
   */
  async matchCandidates(
    request: CharacterRecommendationRequest,
    signal?: AbortSignal,
  ): Promise<CharacterMatchResult> {
    const scored = await this.scoreCandidates(request, signal)
    if (scored.status === 'no_match') return { ...scored, applyAllowed: false }
    const ranked = [...scored.records].sort((left, right) =>
      right.candidate.score - left.candidate.score
        || String(left.candidate.entry.catalogAssetId).localeCompare(
          String(right.candidate.entry.catalogAssetId), 'en-US', { sensitivity: 'variant' },
        )).slice(0, MAX_MATCH_CANDIDATES)
    const candidates = []
    for (const { item, candidate } of ranked) {
      signal?.throwIfAborted()
      const preview = await this.previewItem(item, DEFAULT_PREVIEW_BYTES, undefined, signal)
      candidates.push({ ...candidate, imageSha256: preview.sha256 })
    }
    return {
      status: 'candidates',
      candidates,
      reason: 'Ranked metadata candidates for visual selection; use still requires separate authorization.'
        + (scored.supportReason === undefined ? '' : ' Story context: ' + scored.supportReason),
      uncertainties: [
        ...matchUncertainties(candidates, scored.requiredEra),
        ...(scored.records.length > MAX_MATCH_CANDIDATES ? ['candidate_limit_reached'] : []),
      ],
      applyAllowed: false,
    }
  }

  private async scoreCandidates(
    request: CharacterRecommendationRequest,
    signal?: AbortSignal,
  ): Promise<ScoredResult> {
    if (!['lead', 'important_support', 'support', 'extra'].includes(request.roleClass)) failRequest('recommend')
    const supportReason = request.supportingUseReason === undefined
      ? undefined
      : boundedText(request.supportingUseReason, 300, 'recommend')
    const query = request.query === undefined ? undefined : boundedText(request.query, 200, 'recommend')
    const requiredEra = request.requiredEra === undefined
      ? undefined : boundedText(request.requiredEra, 80, 'recommend')
    const gender = request.gender === undefined ? undefined : boundedText(request.gender, 80, 'recommend')
    const styleTerms = boundedList(request.styleTerms, 16, 80, 'recommend')
    const traitTerms = boundedList(request.traitTerms, 16, 80, 'recommend')
    const roleTerms = boundedList(request.roleTerms, 16, 80, 'recommend')
    if (query === undefined && requiredEra === undefined && gender === undefined
      && styleTerms.length === 0 && traitTerms.length === 0 && roleTerms.length === 0) {
      return {
        status: 'no_match',
        reason: 'No bounded character requirements were supplied.',
        uncertainties: [],
      }
    }
    this.assertReadConfigured('recommend')
    const records = await this.scan(
      request.collection === undefined || request.collection === 'all'
        ? CHARACTER_LIBRARY_PREFIXES : [prefixFor(request.collection)],
      signal,
    )
    const scored = records
      .map(item => ({ item, candidate: scoreEntry(toEntry(item), {
        ...(query === undefined ? {} : { query }),
        ...(requiredEra === undefined ? {} : { requiredEra }),
        ...(gender === undefined ? {} : { gender }),
        styleTerms,
        traitTerms,
        roleTerms,
      }) }))
      .filter((record): record is ScoredRecord => record.candidate !== null)
    if (scored.length === 0) {
      return {
        status: 'no_match',
        reason: 'No catalog candidate satisfied the declared requirements.'
          + (supportReason === undefined ? '' : ' Story context: ' + supportReason),
        uncertainties: [],
      }
    }
    return { status: 'scored', records: scored, supportReason, requiredEra }
  }

  private assertReadConfigured(stage: 'browse' | 'detail' | 'preview' | 'recommend'): void {
    let configured = false
    try {
      configured = enabled(this.store.status().readConfigured)
    } catch {
      // Treat provider readiness failures as unconfigured without exposing provider details.
    }
    if (!configured) throw new CharacterLibraryError('UNCONFIGURED', stage)
  }

  private async scan(
    prefixes: readonly CharacterLibraryPrefix[],
    signal?: AbortSignal,
  ): Promise<readonly RecordAtPrefix[]> {
    const keys: { readonly prefix: CharacterLibraryPrefix; readonly key: string }[] = []
    for (const prefix of prefixes) {
      let cursor: string | undefined
      const cursors = new Set<string>()
      for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES_PER_PREFIX; pageNumber++) {
        signal?.throwIfAborted()
        let raw
        try {
          raw = await this.store.list({
            prefix,
            ...(cursor === undefined ? {} : { cursor }),
            limit: MAX_LIST_PAGE_SIZE,
          }, signal)
        } catch {
          throw new CharacterLibraryError('LIST_FAILED', 'browse')
        }
        const page = validatePage(raw, prefix, MAX_LIST_PAGE_SIZE)
        keys.push(...page.keys.map(key => ({ prefix, key })))
        if (page.nextCursor === null) {
          cursor = undefined
          break
        }
        if (cursors.has(page.nextCursor)) throw new CharacterLibraryError('LIST_FAILED', 'browse')
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
        if (pageNumber === MAX_LIST_PAGES_PER_PREFIX - 1) {
          throw new CharacterLibraryError('LIST_BOUND_EXCEEDED', 'browse')
        }
      }
    }
    keys.sort((left, right) => left.key.localeCompare(right.key))
    const seenKeys = new Set<string>()
    const seenIds = new Set<string>()
    const records: RecordAtPrefix[] = []
    for (const { prefix, key } of keys) {
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      const { record, metadataSha256 } = await this.readRecord(key, signal)
      const id = String(record.identity.catalog_asset_id)
      const originalAssetId = String(record.identity.original_asset_id)
      if (key !== `${prefix}${originalAssetId}/metadata.json`
        || record.derived.metadata_key !== key) {
        throw new CharacterLibraryError('CATALOG_REJECTED', 'browse')
      }
      if (seenIds.has(id)) throw new CharacterLibraryError('CATALOG_REJECTED', 'browse')
      seenIds.add(id)
      records.push({ prefix, record, metadataSha256 })
    }
    return records
  }

  private async readRecord(
    key: string,
    signal?: AbortSignal,
    stage: CharacterLibraryFailureStage = 'browse',
  ): Promise<{ readonly record: CharacterMetadataRecord; readonly metadataSha256: string }> {
    let response
    try {
      response = validateGet(
        await this.store.get(key, MAX_METADATA_BYTES, signal),
        key,
        MAX_METADATA_BYTES,
        stage,
      )
    } catch (error) {
      if (error instanceof CharacterLibraryError) throw error
      throw new CharacterLibraryError('LIST_FAILED', stage)
    }
    let json: string
    try {
      json = TEXT_DECODER.decode(response.data)
    } catch {
      throw new CharacterLibraryError('CATALOG_REJECTED', stage)
    }
    try {
      return {
        record: parseCharacterMetadata(json, CATALOG_SOURCE_ID, key),
        metadataSha256: digest(response.data),
      }
    } catch {
      throw new CharacterLibraryError('CATALOG_REJECTED', stage)
    }
  }

  private async find(
    target: string,
    stage: 'detail' | 'preview',
    signal?: AbortSignal,
  ): Promise<RecordAtPrefix> {
    const originalAssetId = target.slice(CATALOG_ID_PREFIX.length)
    const records: RecordAtPrefix[] = []
    for (const prefix of CHARACTER_LIBRARY_PREFIXES) {
      signal?.throwIfAborted()
      const key = `${prefix}${originalAssetId}/metadata.json`
      assertSafeKey(key, prefix)
      let head
      try {
        head = await this.store.head(key, signal)
      } catch {
        throw new CharacterLibraryError('LIST_FAILED', stage)
      }
      if (head === null) continue
      validateMetadataHead(head, key, stage)
      const { record, metadataSha256 } = await this.readRecord(key, signal, stage)
      if (String(record.identity.catalog_asset_id) !== target) {
        throw new CharacterLibraryError('CATALOG_REJECTED', stage)
      }
      records.push({ prefix, record, metadataSha256 })
    }
    if (records.length === 0) throw new CharacterLibraryError('ASSET_NOT_FOUND', stage)
    if (records.length > 1) throw new CharacterLibraryError('CATALOG_REJECTED', stage)
    const [found] = records
    /* v8 ignore next -- the preceding length check guarantees one exact record. */
    if (found === undefined) throw new CharacterLibraryError('ASSET_NOT_FOUND', stage)
    return found
  }


}

export default CharacterLibrary
