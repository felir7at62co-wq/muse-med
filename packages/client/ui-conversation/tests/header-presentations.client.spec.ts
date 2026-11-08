/** Header preferences restore previous plugins and the deployment default on disposal. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { HeaderPresentations } from '../src/client/conversation/header-presentations.ts'

it('notifies mounted consumers and restores preceding header preferences', async () => {
  const ctx = new Context()
  const registry = new HeaderPresentations(ctx)
  const seen: (string | undefined)[] = []
  const unsubscribe = registry.subscribe(() => { seen.push(registry.getSnapshot()) })
  expect(registry.getSnapshot()).toBeUndefined()
  const removeFirst = registry.register({ id: 'first', presentation: 'floating' })
  const removeSecond = registry.register({ id: 'second', presentation: 'standard' })
  expect(() => registry.register({ id: 'second', presentation: 'floating' })).toThrow('already registered')
  removeSecond()
  expect(registry.getSnapshot()).toBe('floating')
  removeFirst(); removeFirst()
  expect(registry.getSnapshot()).toBeUndefined()
  expect(seen).toEqual(['floating', 'standard', 'floating', undefined])
  unsubscribe()
  await ctx.fiber.dispose()
})
