/** Authoritative project-role lookup for the character-reference tool. */
import type SettingsForms from '@deepseek-ai/dsh-settings'
import { readProjectBible } from '@deepseek-ai/dsh-drama-settings'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CharacterRoleClass } from '@deepseek-ai/dsh-character-library'

type JsonObject = { [key: string]: JsonValue }

/** Result of resolving one stable project character from the current project bible. */
export interface AuthoritativeProjectCharacter {
  readonly characterId: string
  readonly roleClass: CharacterRoleClass
}

function isRoleClass(value: JsonValue | undefined): value is CharacterRoleClass {
  return value === 'lead' || value === 'important_support' || value === 'support' || value === 'extra'
}

/**
 * Resolve one character role from the current Session workspace's validated project bible.
 * @param settings - Live Settings service used by the authoritative project reader.
 * @param projectDirectory - Current Session workspace root.
 * @param characterId - Stable project character identity supplied by the model call.
 * @param signal - Optional execution cancellation checked around the filesystem read.
 * @returns The exact persisted character identity and role classification.
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
  if (!isRoleClass(roleClass)) {
    throw new Error('drama_character_references requires the current project character to have role_class.')
  }
  return { characterId, roleClass }
}
