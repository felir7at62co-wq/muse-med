/** Project-role authority rejects unavailable and incomplete reader results without using model claims. */
import type SettingsForms from '@deepseek-ai/dsh-settings'
import { readProjectBible } from '@deepseek-ai/dsh-drama-settings'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { beforeEach, expect, it, vi } from 'vitest'
import { readAuthoritativeProjectCharacter, readAuthoritativeProjectCharacterIdentity } from '../src/project-role.ts'

vi.mock('@deepseek-ai/dsh-drama-settings', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-drama-settings')>(),
  readProjectBible: vi.fn(),
}))

const settings = {} as SettingsForms
const reader = vi.mocked(readProjectBible)
const character = { character_id: 'fixture_role', name: 'Fixture Role', role_class: 'support' }
function project(characters: JsonValue | undefined = [character], status = 'ready') {
  return { status, expected_revision: 'fixture-revision', preview_fingerprint: '', proposed: {}, affected_stages: [],
    current_settings_budget_cents: 0,
    config: { jubian_script_id: 91001, project_bible: characters === undefined ? {} : { characters } },
  } satisfies Awaited<ReturnType<typeof readProjectBible>>
}

beforeEach(() => { reader.mockReset(); reader.mockResolvedValue(project()) })

it('reads a persisted role and trimmed name through the same reader revision', async () => {
  reader.mockResolvedValue(project([{ ...character, name: '  Fixture Role  ' }]))
  const signal = new AbortController().signal
  await expect(readAuthoritativeProjectCharacter(settings, '/project', 'fixture_role', signal))
    .resolves.toEqual({ characterId: 'fixture_role', roleClass: 'support' })
  await expect(readAuthoritativeProjectCharacterIdentity(settings, '/project', 91001, 'fixture_role', signal))
    .resolves.toEqual({ scriptId: 91001, characterId: 'fixture_role', roleClass: 'support', characterName: 'Fixture Role' })
  expect(reader).toHaveBeenCalledWith(settings, '/project')
})

it.each([readAuthoritativeProjectCharacter, async (service: SettingsForms, directory: string, id: string) =>
  await readAuthoritativeProjectCharacterIdentity(service, directory, 91001, id)])(
  'redacts an unreadable project and requires a configured reader result', async (read) => {
    reader.mockRejectedValueOnce(new Error('private provider path /sensitive/project_config.json'))
    await expect(read(settings, '/project', 'fixture_role')).rejects.toThrow('could not read the current project bible')
    reader.mockResolvedValueOnce(project([], 'unconfigured'))
    await expect(read(settings, '/project', 'fixture_role')).rejects.toThrow('requires a configured current project bible')
  })

it('keeps an unclassified role explicit and rejects an invalid persisted classification', async () => {
  reader.mockResolvedValueOnce(project([{ character_id: 'fixture_role', name: 'Fixture Role' }]))
  await expect(readAuthoritativeProjectCharacter(settings, '/project', 'fixture_role'))
    .resolves.toEqual({ characterId: 'fixture_role', roleClass: null })
  reader.mockResolvedValueOnce(project([{ ...character, role_class: 'invented-role' }]))
  await expect(readAuthoritativeProjectCharacter(settings, '/project', 'fixture_role')).rejects.toThrow('invalid current project role_class')
})

it.each([undefined, [], [character, character]])('rejects a missing or ambiguous current character: %j', async (characters) => {
  const value = project(characters)
  if (characters === undefined) value.config.project_bible = {}
  reader.mockResolvedValue(value)
  await expect(readAuthoritativeProjectCharacter(settings, '/project', 'fixture_role')).rejects.toThrow('exactly one')
  await expect(readAuthoritativeProjectCharacterIdentity(settings, '/project', 91001, 'fixture_role')).rejects.toThrow('exactly one')
})

it.each([undefined, 42, '', '  ', 'x'.repeat(161), 'bad\u202e name'])(
  'does not authorize an incomplete or unsafe persisted character name: %j', async (name) => {
    reader.mockResolvedValue(project([{ ...character, ...(name === undefined ? { name: null } : { name }) }]))
    await expect(readAuthoritativeProjectCharacterIdentity(settings, '/project', 91001, 'fixture_role'))
      .rejects.toThrow('current project character')
  })
