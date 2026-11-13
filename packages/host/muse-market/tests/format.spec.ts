/** Instruction frontmatter uses the filesystem provider's invocation aliases. */
import { expect, it } from 'vitest'
import { marketSkill } from '../src/format.ts'
import { instructions } from './fixtures.ts'

it.each(['1', '"1"', 'true', 'yes', 'ON'] as const)('reads disabling invocation value %s from YAML', (value) => {
  expect(marketSkill(instructions.replace('disable-model-invocation: yes', `disable-model-invocation: ${value}`), 'fixture-skill')
    .invocation.modelInvocable).toBe(false)
})

it.each(['0', '"0"', 'false', 'no', 'OFF'] as const)('reads permitting invocation value %s from YAML', (value) => {
  expect(marketSkill(instructions.replace('disable-model-invocation: yes', `disable-model-invocation: ${value}`), 'fixture-skill')
    .invocation.modelInvocable).toBe(true)
})

it('uses the provider defaults when invocation switches are absent', () => {
  const body = instructions.replace('disable-model-invocation: yes\n', '').replace('user-invocable: on\n', '')
  expect(marketSkill(body, 'fixture-skill').invocation).toEqual({ modelInvocable: true, userInvocable: true })
})

it.each(['2', 'perhaps', '[]'] as const)('refuses unsupported invocation value %s without coercing it', (value) => {
  expect(() => marketSkill(instructions.replace('disable-model-invocation: yes', `disable-model-invocation: ${value}`), 'fixture-skill'))
    .toThrow('invalid-skill')
})

it.each([
  'No frontmatter', '---\nname: fixture-skill\n---\n',
  '---\nname: fixture-skill\nname: duplicate\n---\nBody',
  '---\nname: fixture-skill\ndescription: !unrecognized Description\n---\nBody',
] as const)('refuses absent, empty or invalid frontmatter %j', (body) => {
  expect(() => marketSkill(body, 'fixture-skill')).toThrow('invalid-skill')
})
