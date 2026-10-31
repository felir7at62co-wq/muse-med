// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { ContextMeter, type ContextMeterProps } from '../src/client/skeleton/ContextMeter.tsx'
import { contextOccupancy } from '../src/client/context-occupancy.ts'
import css from '../src/client/skeleton/ContextMeter.module.css'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh) as ContextMeterProps['t']
const tEn = makeTranslate(en, commonEn) as ContextMeterProps['t']

const BREAKDOWN = { systemTokens: 120, toolsTokens: 21_500, messageTokens: 477_000 }

const segmentClass = css.segment
if (segmentClass === undefined) throw new Error('segment class missing from ContextMeter.module.css')

function projections(values: Record<string, unknown>): ContextMeterProps['useProjection'] {
  return (key: string) => values[key]
}

function meter(values: Record<string, unknown>, translate: ContextMeterProps['t'] = t) {
  return render(<ContextMeter useProjection={projections(values)} t={translate} />)
}

describe('ContextMeter', () => {
  it('computes occupancy only when both a numerator and capacity are known', () => {
    expect(contextOccupancy({ pressureTokens: 32_000, projectedTokens: 6_000, contextWindow: 128_000 }))
      .toEqual({ percent: 5, usedTokens: 6_000, contextWindow: 128_000 })
    expect(contextOccupancy({ pressureTokens: 32_000, contextWindow: 128_000 }))
      .toEqual({ percent: 25, usedTokens: 32_000, contextWindow: 128_000 })
    expect(contextOccupancy({ pressureTokens: 32_000 })).toBeNull()
    expect(contextOccupancy({ contextWindow: 128_000 })).toBeNull()
    expect(contextOccupancy(undefined)).toBeNull()
    expect(contextOccupancy({ pressureTokens: 300_000, contextWindow: 128_000 })?.percent).toBe(100)
  })

  it('uses a recorded zero estimate before usage and avoids pairing an unmeasured target with legacy pressure', () => {
    expect(contextOccupancy({ workingContextTokens: 0, workingTokenLimit: 475_000, contextWindow: 1_000_000 }))
      .toEqual({ percent: 0, usedTokens: 0, contextWindow: 1_000_000, workingTokenLimit: 475_000 })
    expect(contextOccupancy({ projectedTokens: 498_000, workingTokenLimit: 475_000, contextWindow: 1_000_000 }))
      .toEqual({ percent: 50, usedTokens: 498_000, contextWindow: 1_000_000 })
    expect(contextOccupancy({ projectedTokens: 498_000, workingContextTokens: 300_000, contextWindow: 1_000_000 }))
      .toEqual({ percent: 50, usedTokens: 498_000, contextWindow: 1_000_000 })
  })

  it('renders nothing until both pressure and capacity are known', () => {
    expect(meter({}).container.textContent).toBe('')
    expect(meter({ contextPressure: { pressureTokens: 32_000 } }).container.textContent).toBe('')
    expect(meter({ contextPressure: { contextWindow: 128_000 } }).container.textContent).toBe('')
  })

  it('uses the working budget without clipping its reading or changing model capacity', () => {
    expect(contextOccupancy({
      projectedTokens: 449_000, contextWindow: 1_000_000, workingTokenLimit: 475_000, workingContextTokens: 534_000,
    }))
      .toEqual({ percent: 112, usedTokens: 534_000, contextWindow: 1_000_000, workingTokenLimit: 475_000 })
  })

  it.each([
    { translate: t, name: '工作上下文 105%', modelLabel: '模型总窗口', composition: '分项为组成估算，不与总量相加', target: '最近一次请求的上下文估算；达到工作目标会尝试压缩' },
    { translate: tEn, name: '105% of working context target', modelLabel: 'Model window', composition: 'Composition estimates do not add up to the total', target: 'Context estimate for the latest request; reaching the target triggers compaction' },
  ])('shows working and model budgets separately with localized copy: $name', ({ translate, name, modelLabel, composition, target }) => {
    const view = meter({
      contextPressure: { projectedTokens: 449_000, contextWindow: 1_000_000, workingTokenLimit: 475_000, workingContextTokens: 498_000 },
      contextBreakdown: BREAKDOWN,
    }, translate)
    const trigger = view.getByRole('button', { name })
    fireEvent.click(trigger)
    const panel = view.getByRole('dialog')
    expect(panel.textContent).toContain('~498K / 475K')
    expect(panel.textContent).toContain(modelLabel + '1M')
    expect(panel.textContent).toContain(composition)
    expect(panel.textContent).toContain(target)
    const circumference = 2 * Math.PI * 5.5
    expect(trigger.querySelector('circle:last-child')?.getAttribute('stroke-dasharray'))
      .toBe(`${circumference} ${circumference}`)
    const widths = Array.from(panel.getElementsByClassName(segmentClass), node => Number.parseFloat((node as HTMLElement).style.width))
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100)
  })

  it('keeps the expanded working-context panel portaled and inside the viewport', () => {
    const width = 264
    const height = 340
    const anchor = vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(window.innerWidth - 44, window.innerHeight - 24, 28, 20))
    const panelWidth = vi.spyOn(HTMLDivElement.prototype, 'offsetWidth', 'get').mockReturnValue(width)
    const panelHeight = vi.spyOn(HTMLDivElement.prototype, 'offsetHeight', 'get').mockReturnValue(height)
    try {
      const view = meter({
        contextPressure: { workingContextTokens: 498_000, contextWindow: 1_000_000, workingTokenLimit: 475_000 },
        contextBreakdown: BREAKDOWN,
      })
      fireEvent.click(view.getByRole('button', { name: '工作上下文 105%' }))
      const panel = view.getByRole('dialog')
      expect(panel.parentElement).toBe(document.body)
      expect(Number.parseFloat(panel.style.left)).toBe(window.innerWidth - width - 12)
      expect(Number.parseFloat(panel.style.top)).toBeGreaterThanOrEqual(12)
      expect(Number.parseFloat(panel.style.top) + height).toBeLessThanOrEqual(window.innerHeight - 12)
    } finally {
      anchor.mockRestore()
      panelWidth.mockRestore()
      panelHeight.mockRestore()
    }
  })

  it('uses the new model window after a working budget is removed', () => {
    let values: Record<string, unknown> = {
      contextPressure: { projectedTokens: 449_000, contextWindow: 1_000_000, workingTokenLimit: 475_000, workingContextTokens: 498_000 },
    }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    fireEvent.click(view.getByRole('button', { name: '工作上下文 105%' }))
    values = { contextPressure: { projectedTokens: 32_000, contextWindow: 128_000 } }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.getByRole('button', { name: '上下文已用 25%' })).not.toBeNull()
    expect(view.getByRole('dialog').textContent).toContain('~32K / 128K')
    expect(view.getByRole('dialog').textContent).not.toContain('475K')
    expect(view.getByRole('dialog').textContent).not.toContain('模型总窗口')
  })

  it('shows the occupancy ring and opens the breakdown panel on click', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    const panel = view.queryByRole('dialog')!
    expect(panel.textContent).toContain('~32K / 128K')
    expect(panel.textContent).toContain('25%')
    expect(panel.textContent).toContain('上下文已用')
    expect(panel.textContent).toContain('系统提示词~120')
    expect(panel.textContent).toContain('工具定义~21.5K')
    expect(panel.textContent).toContain('对话消息~477K')
    // The occupancy bar splits into one colored segment per composition row.
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(3)
    // Clicking the trigger again toggles the panel shut.
    fireEvent.click(trigger)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('lets each locale own the headline word order around the reading', () => {
    const values = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    const zhView = meter(values)
    fireEvent.click(zhView.getByRole('button', { name: '上下文已用 25%' }))
    // The reading follows the label in Chinese and leads it in English; both
    // headers read as one sentence rather than a concatenated fragment.
    expect(zhView.queryByRole('dialog')!.textContent)
      .toMatch(/^上下文已用25%/)
    const enView = meter(values, tEn)
    fireEvent.click(enView.getByRole('button', { name: '25% of context used' }))
    expect(enView.queryByRole('dialog', { name: 'of context used' })!.textContent)
      .toMatch(/^25%of context used/)
  })

  it('draws no bar segment at zero occupancy', () => {
    const view = meter({
      contextPressure: { pressureTokens: 0, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 0%' }))
    const panel = view.queryByRole('dialog')!
    // `.segment` carries a min-width, so a zero-width part would still paint a
    // filled sliver over an empty context.
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(0)
    expect(panel.textContent).toContain('~0 / 128K')
  })

  it('reads the ring from the projected figure so a compaction shows at once', () => {
    // Same provider sample, a surface a compaction just shrank: the ring must
    // follow the projection rather than the sample it is anchored to.
    const view = meter({
      contextPressure: { pressureTokens: 32_000, projectedTokens: 3_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 2%' })
    fireEvent.click(trigger)
    expect(view.queryByRole('dialog')!.textContent).toContain('~3K / 128K')
  })

  it('omits the composition rows while the contextBreakdown projection is absent', () => {
    const view = meter({ contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 } })
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    const panel = view.queryByRole('dialog')!
    expect(panel.textContent).toContain('~32K / 128K')
    expect(panel.textContent).not.toContain('系统提示词')
    expect(panel.textContent).not.toContain('对话消息')
    // Without composition shares, the bar falls back to one plain segment.
    expect(panel.getElementsByClassName(segmentClass)).toHaveLength(1)
  })

  it('closes when capacity disappears and stays closed when it returns', () => {
    let values: Record<string, unknown> = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    const view = render(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    fireEvent.click(view.getByRole('button', { name: '上下文已用 25%' }))
    expect(view.queryByRole('dialog')).not.toBeNull()

    values = { contextPressure: { pressureTokens: 32_000 }, contextBreakdown: BREAKDOWN }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.container.textContent).toBe('')

    values = {
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    }
    view.rerender(<ContextMeter useProjection={(key: string) => values[key]} t={t} />)
    expect(view.getByRole('button', { name: '上下文已用 25%' }).getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('closes on outside pointerdown and Escape — but not inside clicks', () => {
    const view = meter({
      contextPressure: { pressureTokens: 32_000, contextWindow: 128_000 },
      contextBreakdown: BREAKDOWN,
    })
    const trigger = view.getByRole('button', { name: '上下文已用 25%' })
    const openPanel = () => {
      fireEvent.click(trigger)
      return view.queryByRole('dialog')!
    }
    // A pointerdown inside the panel keeps it open; outside closes it.
    const again = openPanel()
    fireEvent.pointerDown(again)
    expect(view.queryByRole('dialog')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
    // Escape.
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
  })
})
