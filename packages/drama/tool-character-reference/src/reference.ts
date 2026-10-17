/** Read-only model-tool projection over the Host-owned character library. */
import type {
  CharacterLibraryEntry,
  CharacterMatchResult,
  CharacterRecommendationRequest,
  CharacterRoleClass,
} from '@deepseek-ai/dsh-character-library'

/** Bounded role requirements supplied by the Agent from the current screenplay. */
export interface CharacterReferenceRequest {
  readonly character_id: string
  readonly role_description: string
  readonly role_class: CharacterRoleClass
  readonly supporting_use_reason?: string
  readonly collection?: 'ancient' | 'urban' | 'all'
  readonly required_era?: string
  readonly gender?: string
  readonly style_terms?: readonly string[]
  readonly trait_terms?: readonly string[]
  readonly role_terms?: readonly string[]
}

/** Least-capability search required by the model-facing tool. */
export interface CharacterLibraryMatcher {
  matchCandidates(
    request: CharacterRecommendationRequest,
    signal?: AbortSignal,
  ): Promise<CharacterMatchResult>
}

/** Host-owned reader for one role in the current Session project. */
export interface CharacterRoleAuthority {
  read(
    projectDirectory: string,
    characterId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly characterId: string; readonly roleClass: CharacterRoleClass }>
}

interface CharacterReferenceCandidate {
  readonly catalog_asset_id: string
  readonly original_asset_id: string
  readonly image_sha256: string
  readonly collection: 'ancient' | 'urban'
  readonly format: CharacterLibraryEntry['format']
  readonly metadata_status: CharacterLibraryEntry['metadataStatus']
  readonly category: string | null
  readonly setting: string | null
  readonly art_style: string | null
  readonly era: string[]
  readonly gender: string | null
  readonly appearance: string[]
  readonly tags: string[]
  readonly matched_evidence: string[]
}

/** Model-visible bounded search result; a candidate is not a use grant. */
export interface CharacterReferenceResult {
  readonly status: 'candidates' | 'no_match'
  readonly character_id: string
  readonly candidates: CharacterReferenceCandidate[]
  readonly reason: string
  readonly uncertainty: string[]
  readonly read_only: true
  readonly can_publish: false
  readonly can_reuse: false
  readonly can_bind: false
  readonly apply_allowed: false
  readonly local_writes: 0
  readonly remote_writes: 0
  readonly paid_requests: 0
}

const SAFETY = {
  read_only: true,
  can_publish: false,
  can_reuse: false,
  can_bind: false,
  apply_allowed: false,
  local_writes: 0,
  remote_writes: 0,
  paid_requests: 0,
} as const

function safeText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`drama_character_references requires a bounded ${field}.`)
  }
  const result = value.trim()
  if (result.length === 0 || result.length > max || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(result)) {
    throw new Error(`drama_character_references requires a bounded ${field}.`)
  }
  return result
}

function roleClass(value: unknown): CharacterRoleClass {
  if (value !== 'lead' && value !== 'important_support' && value !== 'support' && value !== 'extra') {
    throw new Error('drama_character_references requires a valid role_class claim.')
  }
  return value
}

function safeTerms(value: readonly string[] | undefined, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  const untrusted: unknown = value
  if (!Array.isArray(untrusted) || untrusted.length > 16) {
    throw new Error(`drama_character_references accepts at most 16 ${field}.`)
  }
  const terms: string[] = []
  for (const item of untrusted as readonly unknown[]) {
    if (typeof item !== 'string') {
      throw new Error(`drama_character_references requires bounded ${field}.`)
    }
    terms.push(safeText(item, 80, field))
  }
  const result = [...new Set(terms)]
  return result.length === 0 ? undefined : result
}

interface ValidatedCharacterReferenceRequest {
  readonly characterId: string
  readonly claimedRole: CharacterRoleClass
  readonly query: string
  readonly supportingUseReason?: string
  readonly collection?: 'ancient' | 'urban' | 'all'
  readonly requiredEra?: string
  readonly gender?: string
  readonly styleTerms?: readonly string[]
  readonly traitTerms?: readonly string[]
  readonly roleTerms?: readonly string[]
}

function validatedRequest(request: CharacterReferenceRequest): ValidatedCharacterReferenceRequest {
  const characterId = safeText(request.character_id, 128, 'character_id')
  const claimedRole = roleClass(request.role_class)
  const query = safeText(request.role_description, 200, 'role_description')
  const supportingUseReason = request.supporting_use_reason === undefined
    ? undefined
    : safeText(request.supporting_use_reason, 300, 'supporting_use_reason')
  const requiredEra = request.required_era === undefined
    ? undefined
    : safeText(request.required_era, 80, 'required_era')
  const gender = request.gender === undefined ? undefined : safeText(request.gender, 80, 'gender')
  const styleTerms = safeTerms(request.style_terms, 'style_terms')
  const traitTerms = safeTerms(request.trait_terms, 'trait_terms')
  const roleTerms = safeTerms(request.role_terms, 'role_terms')
  return {
    characterId,
    claimedRole,
    query,
    ...(supportingUseReason === undefined ? {} : { supportingUseReason }),
    ...(request.collection === undefined ? {} : { collection: request.collection }),
    ...(requiredEra === undefined ? {} : { requiredEra }),
    ...(gender === undefined ? {} : { gender }),
    ...(styleTerms === undefined ? {} : { styleTerms }),
    ...(traitTerms === undefined ? {} : { traitTerms }),
    ...(roleTerms === undefined ? {} : { roleTerms }),
  }
}

function serviceRequest(
  request: ValidatedCharacterReferenceRequest,
  authoritativeRole: CharacterRoleClass,
): CharacterRecommendationRequest {
  return {
    roleClass: authoritativeRole,
    query: request.query,
    ...(request.supportingUseReason === undefined ? {} : { supportingUseReason: request.supportingUseReason }),
    ...(request.collection === undefined ? {} : { collection: request.collection }),
    ...(request.requiredEra === undefined ? {} : { requiredEra: request.requiredEra }),
    ...(request.gender === undefined ? {} : { gender: request.gender }),
    ...(request.styleTerms === undefined ? {} : { styleTerms: request.styleTerms }),
    ...(request.traitTerms === undefined ? {} : { traitTerms: request.traitTerms }),
    ...(request.roleTerms === undefined ? {} : { roleTerms: request.roleTerms }),
  }
}

/**
 * Ask the domain service for bounded candidates and project only safe fields.
 * @param library Host-owned read-only character matcher.
 * @param authority Host-owned reader of the current project's role classification.
 * @param projectDirectory Current Session's project directory, supplied by Host.
 * @param request Bounded role requirements from the Agent.
 * @param signal Optional cancellation signal.
 * @returns Bounded metadata candidates or no match, without use permission.
 */
export async function matchCharacterReferences(
  library: CharacterLibraryMatcher,
  authority: CharacterRoleAuthority,
  projectDirectory: string,
  request: CharacterReferenceRequest,
  signal?: AbortSignal,
): Promise<CharacterReferenceResult> {
  const validated = validatedRequest(request)
  const directory = safeText(projectDirectory, 4096, 'current project workspace')
  signal?.throwIfAborted()
  const authoritative = await authority.read(directory, validated.characterId, signal)
  if (authoritative.characterId !== validated.characterId || authoritative.roleClass !== validated.claimedRole) {
    throw new Error('drama_character_references role_class conflicts with the current project bible.')
  }
  signal?.throwIfAborted()
  const result = await library.matchCandidates(serviceRequest(validated, authoritative.roleClass), signal)
  const base = {
    character_id: validated.characterId,
    reason: result.reason,
    uncertainty: [...result.uncertainties],
    ...SAFETY,
  }
  if (result.status === 'no_match') return { ...base, status: 'no_match', candidates: [] }
  if (result.candidates.length === 0 || result.candidates.length > 3) {
    throw new Error('drama_character_references requires one to three bounded candidates.')
  }
  return {
    ...base,
    status: 'candidates',
    candidates: result.candidates.map(({ entry, matched, imageSha256 }) => {
      if (!/^[a-f0-9]{64}$/u.test(imageSha256)) {
        throw new Error('drama_character_references requires a verified image SHA-256.')
      }
      return {
        catalog_asset_id: entry.catalogAssetId,
        original_asset_id: entry.originalAssetId,
        image_sha256: imageSha256,
        collection: entry.collection,
        format: entry.format,
        metadata_status: entry.metadataStatus,
        category: entry.category,
        setting: entry.setting,
        art_style: entry.artStyle,
        era: [...entry.era],
        gender: entry.gender,
        appearance: [...entry.appearance],
        tags: [...entry.tags],
        matched_evidence: [...matched],
      }
    }),
  }
}
