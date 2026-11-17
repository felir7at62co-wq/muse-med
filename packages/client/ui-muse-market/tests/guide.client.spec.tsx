// @vitest-environment jsdom
/** Guide dismissal preserves previous visits and keeps manual learning available. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketGuide, rememberMarketGuide, shouldShowMarketGuide } from '../src/client/MarketGuide.tsx'
import type { MarketTranslate } from '../src/client/market-actions.ts'

const t = ((key: string) => key) as MarketTranslate
beforeEach(() => { window.localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('market guide', () => {
  it('uses the existing dismissal key without storing market or account data', () => {
    expect(shouldShowMarketGuide()).toBe(true)
    rememberMarketGuide()
    expect(shouldShowMarketGuide()).toBe(false)
    expect(window.localStorage.length).toBe(1)
    expect(window.localStorage.getItem('dsh.muse-market.guide.v1')).toBe('seen')
  })

  it('allows the manual guide when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked') })
    expect(shouldShowMarketGuide()).toBe(false)
    expect(() => { rememberMarketGuide() }).not.toThrow()
    render(<MarketGuide t={t} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'guideTitle' })).toBeTruthy()
  })

  it('shows all three lessons and supports returning to a preceding step', () => {
    const close = vi.fn()
    render(<MarketGuide t={t} onClose={close} />)
    expect(screen.getByRole('heading', { name: 'guideFind' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'guideNext' }))
    expect(screen.getByRole('heading', { name: 'guideInstall' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'guidePrevious' }))
    expect(screen.getByRole('heading', { name: 'guideFind' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'guideNext' }))
    fireEvent.click(screen.getByRole('button', { name: 'guideNext' }))
    expect(screen.getByRole('heading', { name: 'guideUse' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'guideStart' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('can be skipped at the first step without advancing', () => {
    const close = vi.fn()
    render(<MarketGuide t={t} onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: 'guideSkip' }))
    expect(close).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'guideFind' })).toBeTruthy()
  })

  it('explains browser downloads and returns from the final lesson without claiming installation', () => {
    const close = vi.fn()
    render(<MarketGuide t={t} web onClose={close} />)
    fireEvent.click(screen.getByRole('button', { name: 'guideClose' }))
    expect(close).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'guideNext' }))
    expect(screen.getByRole('heading', { name: 'guideWebInstall' })).toBeTruthy()
    expect(screen.getByText('guideWebInstallBody')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'guideNext' }))
    expect(screen.getByRole('heading', { name: 'guideWebUse' })).toBeTruthy()
    expect(screen.getByText('guideWebUseBody')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'guidePrevious' }))
    expect(screen.getByRole('heading', { name: 'guideWebInstall' })).toBeTruthy()
  })
})
