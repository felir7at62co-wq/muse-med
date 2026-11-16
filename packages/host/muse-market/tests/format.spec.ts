/** Portable Skill frontmatter retains invocation controls and refuses invalid YAML. */
import { describe, expect, it } from 'vitest'
import { marketSkill } from '../src/format.ts'

function instructions(fields = ''): string {
  return `---\nname: fixture-skill\ndescription: Review a scene.\n${fields}---\n  Keep the original scene.  \n`
}

describe('publication Skill frontmatter', () => {
  it('uses current invocation defaults and omits absent optional metadata', () => {
    expect(marketSkill(instructions(), 'fixture-skill')).toEqual({
      description: 'Review a scene.', content: 'Keep the original scene.',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  })

  it.each([
    ['true', false], ['1', false], ['"1"', false], ['"TRUE"', false], ['"yes"', false], ['"On"', false],
    ['false', true], ['0', true], ['"0"', true], ['"FALSE"', true], ['"no"', true], ['"Off"', true],
  ])('retains model invocation control %s', (value, modelInvocable) => {
    expect(marketSkill(instructions(`disable-model-invocation: ${value}\n`), 'fixture-skill').invocation)
      .toEqual({ modelInvocable, userInvocable: true })
  })

  it.each(['false', '0', '"0"', '"FALSE"', '"no"', '"Off"'])(
    'retains the explicit user invocation refusal %s', (value) => {
      expect(marketSkill(instructions(`user-invocable: ${value}\n`), 'fixture-skill').invocation)
        .toEqual({ modelInvocable: true, userInvocable: false })
    })

  it.each(['null', '[]', '{}', '2', '"perhaps"'])(
    'refuses unsupported invocation value %s', (value) => {
      expect(() => marketSkill(instructions(`disable-model-invocation: ${value}\n`), 'fixture-skill'))
        .toThrow('invalid-skill')
    })

  it.each([
    'name: fixture-skill\ndescription: Missing delimiters.',
    '---\nname: fixture-skill\ndescription: Empty body.\n---\n  ',
    instructions('description: Duplicate key.\n'),
    instructions('metadata: !unsupported value\n'),
    instructions().replace('description: Review a scene.', 'description: [unclosed'),
    instructions().replace('name: fixture-skill', 'name: another-skill'),
  ])('refuses incomplete, ambiguous or mismatched instructions %#', (body) => {
    expect(() => marketSkill(body, 'fixture-skill')).toThrow('invalid-skill')
  })

  it('ignores optional fields with unsupported types while preserving valid instructions', () => {
    expect(marketSkill(instructions('whenToUse: [later]\nmetadata: [private]\n'), 'fixture-skill'))
      .toEqual(marketSkill(instructions(), 'fixture-skill'))
  })
})
