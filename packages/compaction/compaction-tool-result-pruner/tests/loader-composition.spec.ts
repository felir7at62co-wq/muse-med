import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner, { PRUNE_MARKER } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('compaction-tool-result-pruner real Loader composition', () => {
  it('loads and resolves the flat YAML plugin shape', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-compact-tool-result-prune-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
      '  config:',
      '    thresholdChars: 8192',
      '    headChars: 4096',
      '    tailChars: 1024',
      '    preserveToolNames: [skill]',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-session-projection') return SessionProjectionRegistry
        if (specifier === '@deepseek-ai/dsh-token-meter') return TokenMeter
        if (specifier === '@deepseek-ai/dsh-compaction-tool-result-pruner') return ToolResultPruner
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.get('toolResultPruner')).toBeInstanceOf(ToolResultPruner)
    expect(context.toolResultPruner.config).toEqual({
      thresholdChars: 8192,
      headChars: 4096,
      tailChars: 1024,
      preserveToolNames: ['skill'],
    })

    const session = Session.create(SessionId('loader-preserved-skill'))
    const instructions = `${'甲'.repeat(6000)}必要的逐镜身份与空间规则${'乙'.repeat(6500)}`
    const calls = [
      { id: ToolCallId('load-directing-skill'), name: 'skill', text: instructions },
      { id: ToolCallId('ordinary-output'), name: 'bash', text: 'x'.repeat(12500) },
    ]
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
        content: calls.map(call => ({ type: 'tool-call', id: call.id, name: call.name, arguments: '{}' })),
      }),
    }, { surfaceOp: 'append' })
    for (const call of calls) {
      session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: '{}' })
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: call.text }], isError: false }),
      }, { surfaceOp: 'append' })
    }
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(context.toolResultPruner.pruneSession(session).pruned.map(entry => entry.callId)).toEqual([ToolCallId('ordinary-output')])
    const replay = Session.create(session.id, session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    const results = replay.deriveMessages().flatMap(message => message.role === 'tool'
      ? [{ callId: message.toolCallId, text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }]
      : [])
    expect(results[0]?.text).toBe(instructions)
    expect(results[1]?.text).toBe(`${'x'.repeat(4096)}${PRUNE_MARKER}${'x'.repeat(1024)}`)
    expect(results.map(result => ({
      callId: result.callId,
      characters: Array.from(result.text).length,
      middleRule: result.text.includes('必要的逐镜身份与空间规则'),
      pruned: result.text.includes(PRUNE_MARKER),
    }))).toMatchInlineSnapshot(`
      [
        {
          "callId": "load-directing-skill",
          "characters": 12512,
          "middleRule": true,
          "pruned": false,
        },
        {
          "callId": "ordinary-output",
          "characters": 5159,
          "middleRule": false,
          "pruned": true,
        },
      ]
    `)
  })

  it('rejects stale config after plugin schema normalization', async () => {
    context = new Context()
    // Satisfy the declared injections first: config normalization runs in the
    // service constructor, which a pending fiber never reaches.
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(ToolResultPruner, {
      maxChars: 100,
    } as never)).rejects.toThrow(/unknown key "maxChars"/)
  })

  it.each([
    { preserveToolNames: 'skill' },
    { preserveToolNames: [42] },
    { preserveToolNames: [''] },
    { preserveToolNames: [' skill '] },
  ])('rejects invalid preserved names after plugin schema normalization: %j', async (config) => {
    context = new Context()
    await context.plugin(SessionProjectionRegistry)
    await context.plugin(TokenMeter)
    await expect(context.plugin(ToolResultPruner, config as never)).rejects.toThrow(/preserveToolNames/)
  })
})
