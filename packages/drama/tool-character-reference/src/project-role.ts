/** Authoritative project-role lookup for the character-reference tool. */
import type SettingsForms from '@deepseek-ai/dsh-settings'
import { readProjectBible } from '@deepseek-ai/dsh-drama-settings'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CharacterRoleClass } from '@deepseek-ai/dsh-character-library'

type JsonObject = { [key: string]: JsonValue }

/** Result of resolving one stable project character from the current project bible. */
export interface AuthoritativeProjectCharacter {
  readonly characterId: string
  readonly roleClass: CharacterRoleClass | null
}

/** Project and character identity read from one validated project-bible revision. */
export interface AuthoritativeProjectCharacterIdentity extends AuthoritativeProjectCharacter {
  readonly scriptId: number
  readonly characterName: string
  readonly roleClass: CharacterRoleClass
}

function isRoleClass(value: JsonValue | undefined): value is CharacterRoleClass {
  return value === 'lead' || value === 'important_support' || value === 'support' || value === 'extra'
}

function authoritativeCharacterName(value: JsonValue | undefined): string {
  if (typeof value !== 'string') {
    throw new Error('Character reference authority requires the current project character to have a name.')
  }
  const name = value.trim()
  if (name.length === 0 || name.length > 160 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new Error('Character reference authority requires a bounded current project character name.')
  }
  return name
}

/**
 * Resolve one character role from the current Session workspace's validated project bible.
 * @param settings - Live Settings service used by the authoritative project reader.
 * @param projectDirectory - Current Session workspace root.
 * @param characterId - Stable project character identity supplied by the model call.
 * @param signal - Optional execution cancellation checked around the filesystem read.
 * @returns The persisted character identity and role classification, or null when unclassified.
 */
export async function readAuthoritativeProjectCharacter(
  settings: SettingsForms,
  projectDirectory: string,
  characterId: string,
  signal?: AbortSignal,
): Promise<AuthoritativeProjectCharacter> {
  signal?.throwIfAborted()
  let project
  try {
    project = await readProjectBible(settings, projectDirectory)
  } catch (_error) {
    throw new Error('drama_character_references could not read the current project bible.')
  }
  signal?.throwIfAborted()
  if (project.status !== 'ready') {
    throw new Error('drama_character_references requires a configured current project bible.')
  }
  const bible = project.config.project_bible as JsonObject
  const characters = (bible.characters ?? []) as JsonObject[]
  const matches = characters
    .filter(row => row.character_id === characterId)
  if (matches.length !== 1) {
    throw new Error('drama_character_references requires character_id to identify exactly one current project character.')
  }
  const roleClass = matches[0]?.role_class
  if (roleClass !== undefined && !isRoleClass(roleClass)) {
    throw new Error('drama_character_references found an invalid current project role_class.')
  }
  return { characterId, roleClass: roleClass ?? null }
}

/**
 * Resolve one character together with its exact project identity from one project-bible read.
 * @param settings - Live Settings service used by the authoritative project reader.
 * @param projectDirectory - Host-resolved current project root.
 * @param expectedScriptId - Project identity claimed by the internal caller.
 * @param characterId - Stable project character identity claimed by the internal caller.
 * @param signal - Optional execution cancellation checked around the filesystem read.
 * @returns The persisted project, character, and role identities from the same bible revision.
 */
export async function readAuthoritativeProjectCharacterIdentity(
  settings: SettingsForms,
  projectDirectory: string,
  expectedScriptId: number,
  characterId: string,
  signal?: AbortSignal,
): Promise<AuthoritativeProjectCharacterIdentity> {
  signal?.throwIfAborted()
  let project
  try {
    project = await readProjectBible(settings, projectDirectory)
  } catch (_error) {
    throw new Error('Character reference authority could not read the current project bible.')
  }
  signal?.throwIfAborted()
  if (project.status !== 'ready') {
    throw new Error('Character reference authority requires a configured current project bible.')
  }
  const scriptId = project.config.jubian_script_id
  if (typeof scriptId !== 'number' || !Number.isSafeInteger(scriptId)
    || scriptId <= 0 || scriptId !== expectedScriptId) {
    throw new Error('Character reference authority rejected a conflicting current project identity.')
  }
  const bible = project.config.project_bible as JsonObject
  const characters = (bible.characters ?? []) as JsonObject[]
  const matches = characters.filter(row => row.character_id === characterId)
  if (matches.length !== 1) {
    throw new Error('Character reference authority requires exactly one current project character.')
  }
  const roleClass = matches[0]?.role_class
  if (!isRoleClass(roleClass)) {
    throw new Error('Character reference authority requires the current project character to have role_class.')
  }
  const characterName = authoritativeCharacterName(matches[0]?.name)
  return { scriptId, characterId, roleClass, characterName }
}
