// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { OfficialBrandMark, type BrandInjected } from '../src/client/Brand.tsx'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  document.head.querySelectorAll('link[rel="icon"]').forEach((link) => { link.remove() })
})

const HOLES = [
  'sidebar.brand.mark',
  'conversation.hero.brand.mark',
] as const

const NAME_HOLE = 'sidebar.brand.name'

async function bench(declare = true) {
  const ctx = new Context()
  let colorScheme: 'light' | 'dark' = 'light'
  const getTheme = () => ({ active: { colorScheme } })
  ctx.provide('theme', { getTheme } as never)
  const setTheme = (scheme: 'light' | 'dark') => {
    colorScheme = scheme
    ctx.emit('theme/change', getTheme() as never)
  }
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries([...HOLES, NAME_HOLE].map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles, setTheme }
}

describe('official browser-brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares slots and the application theme service', () => {
    expect(inject).toEqual(['slots', 'theme'])
  })

  it('keeps the favicon black in both themes and restores it on teardown', async () => {
    const icon = document.createElement('link')
    icon.rel = 'icon'
    icon.type = 'image/png'
    icon.href = '/original.png'
    document.head.append(icon)
    const subject = await bench()
    subject.setTheme('dark')
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(icon.getAttribute('href')).toBe('./muse-med-logo-black.webp')
    expect(icon.type).toBe('image/webp')
    subject.setTheme('light')
    expect(icon.getAttribute('href')).toBe('./muse-med-logo-black.webp')
    await fiber.dispose()
    expect(icon.href).toContain('/original.png')
    expect(icon.type).toBe('image/png')
    subject.setTheme('dark')
    expect(icon.href).toContain('/original.png')
  })

  it('brands local builds as well as release builds', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    await fiber.dispose()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(0)
  })

  it('fills declarations before or after apply and removes every occupant on teardown', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    before.disposeHoles?.()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('preserves the sidebar name and build metadata supplied by its owner', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'official')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    expect(subject.slots.entries(NAME_HOLE)).toHaveLength(0)
  })

  it('renders black artwork in light themes and white artwork in dark themes at owner sizes', async () => {
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const { hooks } = (subject.slots.entries(HOLES[0])[0]!.inject as unknown as () => BrandInjected)()
    const useLogo = <T,>(select: (url: string) => T) => select(hooks.logo.getSnapshot())
    const mark = render(<OfficialBrandMark size={34} useLogo={useLogo} />)
    expect(mark.container.querySelector('img')?.getAttribute('src')).toBe('./muse-med-logo-black.webp')
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('34')
    expect(mark.container.querySelector('img')?.getAttribute('alt')).toBe('')
    subject.setTheme('dark')
    mark.rerender(<OfficialBrandMark size={24} useLogo={useLogo} />)
    expect(mark.container.querySelector('img')?.getAttribute('src')).toBe('./muse-med-logo-white.webp')
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('24')
    await fiber.dispose()
  })
})
