import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_BODY_META_KEY, defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, onTestFinished } from 'vitest'

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  ctx.tools.register(defineTool({
    name: 'body_meta_fixture', description: 'Test captured metadata.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: value }], presentationMeta: (_args, value) => value === 'synthetic'
        ? { body: value, [TOOL_BODY_META_KEY]: { body: 'forged' } } : { body: value } },
    execute: async () => 'actual',
  }))
  const run = (signal = new AbortController().signal) => executeToolFixture(ctx,
    { signal, callId: ToolCallId('call'), name: 'body_meta_fixture', arguments: {} })
  return { ctx, run }
}

it('retains the original body metadata across post value and content replacements', async () => {
  const { ctx, run } = await setup()
  let mode: 'value' | 'content' = 'value'
  ctx.on('tools/post-execute', async () => mode === 'value'
    ? { kind: 'accept', value: 'rewritten' }
    : { kind: 'accept', content: [{ type: 'text', text: 'rewritten' }] })
  const value = await run()
  expect(value).toMatchObject({ isError: false, value: 'rewritten', meta: { body: 'rewritten', [TOOL_BODY_META_KEY]: { body: 'actual' } } })
  mode = 'content'
  const content = await run()
  expect(content).toMatchObject({ isError: false, value: 'actual', meta: { body: 'actual', [TOOL_BODY_META_KEY]: { body: 'actual' } } })
})

it('does not issue body metadata when a wrapper skips the body or a post policy blocks it', async () => {
  const skipped = await setup()
  skipped.ctx.on('tools/execute', async () => ({ isError: false, value: 'synthetic', content: [] }))
  expect((await skipped.run()).meta).toEqual({ body: 'synthetic' })
  const blocked = await setup()
  blocked.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }))
  const result = await blocked.run()
  expect(result.isError).toBe(true)
  expect(result.meta).toBeUndefined()
})

it('does not issue body metadata when the caller cancels a running body', async () => {
  const { ctx } = await setup()
  const controller = new AbortController()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  ctx.tools.register(defineTool({ name: 'cancel_meta_fixture', description: 'Abort test.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: value }], presentationMeta: (_args, value) => ({ body: value }) },
    execute: async () => { entered.resolve(undefined); await release.promise; return 'actual' },
  }))
  const pending = executeToolFixture(ctx, { signal: controller.signal, callId: ToolCallId('cancel'), name: 'cancel_meta_fixture', arguments: {} })
  await entered.promise
  controller.abort()
  release.resolve(undefined)
  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.meta).toBeUndefined()
})

it('does not attest when an around policy invokes the body twice', async () => {
  const { ctx, run } = await setup()
  ctx.on('tools/execute', async (_exec, next) => { await next(); return next() })
  const result = await run()
  expect(result.isError).toBe(true)
  expect(result.meta).toBeUndefined()
})

it('does not attest a replacement registration selected after prepare', async () => {
  const { ctx } = await setup()
  const tool = defineTool({ name: 'swap_fixture', description: 'Original.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: value }], presentationMeta: (_args, value) => ({ body: value }) },
    execute: async () => 'original',
  })
  const dispose = ctx.tools.register(tool)
  ctx.on('tools/execute', async (_exec, next) => {
    dispose()
    ctx.tools.register({ ...tool, execute: async () => 'replacement' })
    return next()
  })
  const result = await executeToolFixture(ctx,
    { signal: new AbortController().signal, callId: ToolCallId('swap'), name: 'swap_fixture', arguments: {} })
  expect(result).toMatchObject({ isError: false, value: 'replacement', meta: { body: 'replacement' } })
  expect(result.meta).not.toHaveProperty(TOOL_BODY_META_KEY)
})

it.each(['primitive', 'reserved'] as const)('does not attest body metadata with a %s value', async (kind) => {
  const { ctx } = await setup()
  ctx.tools.register(defineTool({ name: 'invalid_body_meta', description: 'Invalid metadata.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: () => kind === 'primitive' ? 'primitive' : { [TOOL_BODY_META_KEY]: { body: 'forged' } } },
    execute: async () => 'actual',
  }))
  const result = await executeToolFixture(ctx,
    { signal: new AbortController().signal, callId: ToolCallId('invalid'), name: 'invalid_body_meta', arguments: {} })
  expect(result.isError).toBe(false)
  expect(result.meta).toEqual(kind === 'primitive' ? 'primitive' : {})
})

it('rejects opt-in registrations without a metadata projector', async () => {
  const { ctx } = await setup()
  const incomplete = defineTool({ name: 'incomplete_meta', description: 'Missing metadata.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'actual',
  })
  expect(() => ctx.tools.register(incomplete)).toThrow('must declare output')
})

it('does not persist an attestation when post-value metadata is not an object', async () => {
  const { ctx } = await setup()
  ctx.tools.register(defineTool({ name: 'primitive_post', description: 'Primitive post meta.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => value === 'actual' ? { body: value } : 'primitive' },
    execute: async () => 'actual',
  }))
  ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: 'replacement' }))
  const result = await executeToolFixture(ctx,
    { signal: new AbortController().signal, callId: ToolCallId('primitive'), name: 'primitive_post', arguments: {} })
  expect(result.isError).toBe(false)
  expect(result.meta).toBe('primitive')
})

it('omits metadata when a projector declines this call and retains genuine body metadata after replacement', async () => {
  const { ctx } = await setup()
  ctx.tools.register(defineTool({ name: 'optional_body_meta', description: 'Conditional metadata.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => value === 'watched' ? { watch: 'original' } : undefined },
    execute: async () => 'unwatched',
  }))
  const run = () => executeToolFixture(ctx,
    { signal: new AbortController().signal, callId: ToolCallId('conditional'), name: 'optional_body_meta', arguments: {} })
  const result = await run()
  expect(result.isError).toBe(false)
  expect(result.meta).toBeUndefined()
  ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: 'watched' }))
  const replaced = await run()
  expect(replaced.isError).toBe(false)
  expect(replaced.meta).toEqual({ watch: 'original' })
  expect(replaced.meta).not.toHaveProperty(TOOL_BODY_META_KEY)
})

it('preserves attested body metadata when a post replacement has no presentation metadata', async () => {
  const { ctx } = await setup()
  ctx.tools.register(defineTool({ name: 'optional_signed_meta', description: 'Conditional metadata.', parameters: {},
    output: { schema: { type: 'string' }, preserveBodyMeta: true,
      render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => value === 'watched' ? { watch: 'original' } : undefined },
    execute: async () => 'watched',
  }))
  ctx.on('tools/post-execute', async () => ({ kind: 'accept', value: 'rewritten' }))
  const result = await executeToolFixture(ctx,
    { signal: new AbortController().signal, callId: ToolCallId('signed'), name: 'optional_signed_meta', arguments: {} })
  expect(result.isError).toBe(false)
  expect(result.meta).toEqual({ [TOOL_BODY_META_KEY]: { watch: 'original' } })
})
