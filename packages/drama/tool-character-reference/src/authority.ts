/** Host-internal authoritative read for a project-bound character reference image. */
import {
  MAX_PREVIEW_BYTES,
  type CharacterLibraryPreview,
  type CharacterRoleClass,
} from '@deepseek-ai/dsh-character-library'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import type { Session } from '@deepseek-ai/dsh-session'
import { readAuthoritativeProjectCharacterIdentity } from './project-role.ts'

/** Internal request tying one immutable image identity to one current project character. */
export interface CharacterReferenceAuthorityRequest {
  readonly scriptId: number
  readonly characterId: string
  readonly catalogAssetId: string
  readonly expectedSha256: string
}

/** Trusted Host result. Local paths and object-store keys are intentionally absent. */
export interface AuthoritativeCharacterReference {
  readonly projectDirectory: string
  readonly scriptId: number
  readonly characterId: string
  readonly characterName: string
  readonly roleClass: CharacterRoleClass
  readonly catalogAssetId: string
  readonly imageSha256: string
  readonly metadataStatus: CharacterLibraryPreview['metadataStatus']
  readonly contentType: CharacterLibraryPreview['contentType']
  readonly data: Uint8Array
}

/** Host-only current-project and image identity reader; use authorization is separate. */
export interface CharacterReferenceAuthority {
  /**
   * Re-read the current project and candidate bytes, rejecting any changed identity.
   * @param session - Current Agent Session whose Host-owned project binding is authoritative.
   * @param request - Expected project, character, Catalog, and image identities.
   * @param signal - Optional execution cancellation.
   * @returns Verified project identity, role, image status, content type, digest, and bytes.
   */
  read(
    session: Session,
    request: CharacterReferenceAuthorityRequest,
    signal?: AbortSignal,
  ): Promise<AuthoritativeCharacterReference>
}

/** Least-capability current-project resolver shared with the model-facing tools. */
export interface CharacterReferenceProjectResolver {
  readonly resolveCurrent: (session: Session) => Promise<string>
}

/** Least-capability image reader required by the authority. */
export interface CharacterReferencePreviewReader {
  preview(
    request: { readonly catalogAssetId: string; readonly expectedSha256: string; readonly maxBytes: number },
    signal?: AbortSignal,
  ): Promise<CharacterLibraryPreview>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-internal, current-project character reference reader. */
    characterReferenceAuthority: CharacterReferenceAuthority
  }
}

function boundedIdentity(value: string, max: number, field: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > max || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) {
    throw new Error(`Character reference authority requires a bounded ${field}.`)
  }
  return normalized
}

function requestIdentity(request: CharacterReferenceAuthorityRequest): CharacterReferenceAuthorityRequest {
  if (!Number.isSafeInteger(request.scriptId) || request.scriptId <= 0) {
    throw new Error('Character reference authority requires a valid project identity.')
  }
  const expectedSha256 = request.expectedSha256.toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error('Character reference authority requires a verified image SHA-256.')
  }
  return {
    scriptId: request.scriptId,
    characterId: boundedIdentity(request.characterId, 128, 'character identity'),
    catalogAssetId: boundedIdentity(request.catalogAssetId, 256, 'Catalog identity'),
    expectedSha256,
  }
}

/**
 * Create the Host-internal reader over the same current-project resolver used by the tools.
 * @param settings - Validated project settings used for authoritative bible reads.
 * @param library - Read-only Catalog image reader.
 * @param projects - Session-aware Host project resolver shared with the tools.
 * @returns Fail-closed project and image authority.
 */
export function createCharacterReferenceAuthority(
  settings: SettingsForms,
  library: CharacterReferencePreviewReader,
  projects: CharacterReferenceProjectResolver,
): CharacterReferenceAuthority {
  return {
    read: async (session, untrusted, signal) => {
      const request = requestIdentity(untrusted)
      signal?.throwIfAborted()
      const projectDirectory = await projects.resolveCurrent(session)
      signal?.throwIfAborted()
      const character = await readAuthoritativeProjectCharacterIdentity(
        settings,
        projectDirectory,
        request.scriptId,
        request.characterId,
        signal,
      )
      signal?.throwIfAborted()
      const preview = await library.preview({
        catalogAssetId: request.catalogAssetId,
        expectedSha256: request.expectedSha256,
        maxBytes: MAX_PREVIEW_BYTES,
      }, signal)
      signal?.throwIfAborted()
      if (preview.catalogAssetId !== request.catalogAssetId || preview.sha256 !== request.expectedSha256) {
        throw new Error('Character reference authority rejected a changed image identity.')
      }
      if (preview.metadataStatus === 'rejected_claim') {
        throw new Error('Character reference authority rejected a withdrawn Catalog record.')
      }
      return {
        projectDirectory,
        scriptId: character.scriptId,
        characterId: character.characterId,
        characterName: character.characterName,
        roleClass: character.roleClass,
        catalogAssetId: preview.catalogAssetId,
        imageSha256: preview.sha256,
        metadataStatus: preview.metadataStatus,
        contentType: preview.contentType,
        data: preview.data,
      }
    },
  }
}
