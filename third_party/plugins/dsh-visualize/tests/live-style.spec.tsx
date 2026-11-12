// @vitest-environment jsdom

/**
 * A card still streaming has no persisted meta, so its style comes from the
 * page: the node half writes the configured style into every page the web
 * server renders (style.spec.ts), and the browser half renders live cards in
 * it. Without that value it falls back to the last card created on the page —
 * never to an update, which keeps its card's original style.
 */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PAGE_CONFIG_GLOBAL, STYLES, type StyleId } from '../src/style.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { VisualizeCard } from '../src/client/VisualizeCard.tsx'

const FRAGMENT = '<div id="lab">hi</div>'

/** Render one toolview block and return the srcdoc of its frame. */
function render(block: Parameters<typeof VisualizeCard>[0]['block']): string {
  const container = document.createElement('div')
  document.body.append(container)
  act(() => createRoot(container).render(<VisualizeCard callId="call-1" block={block} />))
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
}

const running = {
  phase: 'start' as const, callId: 'call-1', name: 'visualize', turn: 1, step: 1, time: 0, subCalls: [],
  argsRaw: JSON.stringify({ fragment: FRAGMENT }), args: PartialArguments.fromText(JSON.stringify({ fragment: FRAGMENT })),
}

/** A settled call with persisted meta in `style`. */
function settled(style: StyleId, args: Record<string, unknown>) {
  return {
    kind: 'tool-result' as const,
    seq: 1, time: 0, callId: 'call-1', name: 'visualize', callTime: 0, subCalls: [],
    args: PartialArguments.fromText(JSON.stringify(args)),
    isError: false,
    content: [],
    call: { name: 'visualize', argsRaw: JSON.stringify(args) },
    meta: { kind: 'visualize', fragment: FRAGMENT, title: 'Lab', mode: 'inline', path: '', style },
  }
}

/** Whether a frame document carries a style's own webfont. */
const inStyle = (doc: string, style: StyleId) => doc.includes(STYLES[style].fontHref!.replaceAll('&', '&amp;'))

describe('live card style', () => {
  beforeAll(() => {
    window.matchMedia ??= (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    document.body.innerHTML = ''
    delete (globalThis as Record<string, unknown>)[PAGE_CONFIG_GLOBAL]
  })

  it('renders a streaming card in the style the node half configured for the page', () => {
    // A finished card in another style must not decide the next one.
    render(settled('paper', { fragment: FRAGMENT }))
    ;(globalThis as Record<string, unknown>)[PAGE_CONFIG_GLOBAL] = { style: 'sketch' }
    expect(inStyle(render(running), 'sketch')).toBe(true)
  })

  it('falls back to the last created card, not to an update of an older one', () => {
    render(settled('editorial', { fragment: FRAGMENT }))
    render(settled('paper', { action: 'update', path: 'p.paper.html', title: 'Lab', old_str: 'a', new_str: 'b' }))
    const doc = render(running)
    expect(inStyle(doc, 'editorial')).toBe(true)
    expect(inStyle(doc, 'paper')).toBe(false)
  })
})
