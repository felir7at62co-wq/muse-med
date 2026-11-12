// @vitest-environment jsdom
/** Directory rows present persisted counts and localized refusal actions without rendering cursor JSON. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { allowAllAccess, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { SkillCatalogRow } from '../src/client/SkillCatalogRow.tsx'
import { zh, en, ja, es, fr, de, ru, pt } from '../src/client/locales.ts'

type Props = Parameters<typeof SkillCatalogRow>[0]
const t: Props['t'] = makeTranslate(zh, commonZh)
afterEach(cleanup)

const unused = (): never => { throw new Error('This row reads only its frozen call and locale props') }
const standard: GlobalStandardProps & SessionStandardProps = {
  sessionId: 'catalog-row-session' as Props['sessionId'],
  useSession: unused, useProjection: unused, useConversation: unused, useInput: unused,
  useChat: unused, useTrajectory: unused, usePanelInfo: unused, useSessions: unused,
  useSessionStatus: unused, useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
  ...allowAllAccess, useContextMenu: contextMenuHook(),
  inputActions: { insertQuote: unused, captureInsertion: unused, insertText: unused, setDraft: unused, persistDraft: unused,
    addAttachments: unused, removeAttachment: unused, pruneAttachments: unused, submit: unused },
}

function settled(over: Partial<ToolResultNode> = {}): ToolResultNode {
  return { kind: 'tool-result', seq: 3, time: 3000, callId: 'catalog-call', name: 'skill_catalog',
    args: PartialArguments.fromObject({ query: 'scene' }), call: { name: 'skill_catalog', argsRaw: '{"query":"scene"}' },
    callTime: 2000, isError: false, subCalls: [],
    content: [{ type: 'text', text: '{"nextCursor":{"sessionId":"private-session","digest":"private-digest"}}' }],
    meta: { kind: 'skill-catalog', count: 2, totalMatched: 4, hasMore: true }, ...over }
}

function props(block: Props['block']): Props {
  const base = { ...standard, callId: block.callId, toolName: 'skill_catalog', t,
    useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }),
    loadImage: vi.fn<ToolCallOwnerProps['loadImage']>(), openFile: vi.fn(), inspect: vi.fn() }
  if ('kind' in block) return { ...base, phase: 'result', block }
  if (block.phase === 'preparing') return { ...base, phase: 'preparing', block }
  return { ...base, phase: 'start', block }
}

describe('SkillCatalogRow', () => {
  it('shows page counts and remaining results without displaying private cursor fields', () => {
    const view = render(<SkillCatalogRow {...props(settled())} />)
    expect(screen.getByText('查找技能')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('本页 2 项，共 4 项 · 还有更多结果')
    expect(view.container.textContent).not.toContain('private-session')
    expect(view.container.textContent).not.toContain('digest')
    view.rerender(<SkillCatalogRow {...props(settled({ meta: { kind: 'skill-catalog', count: 0, totalMatched: 0, hasMore: false } }))} />)
    expect(screen.getByRole('status').textContent).toBe('本页 0 项，共 0 项')
  })

  it.each([
    ['SKILL_CATALOG_STALE_CURSOR', '目录已更新，请重新查询'],
    ['SKILL_CATALOG_FOREIGN_CURSOR', '此分页来自另一会话，请重新查询'],
    ['SKILL_CATALOG_INVALID_REQUEST', '分页参数无效，请重新查询'],
    ['SKILL_CATALOG_INCOMPLETE', '暂时无法完整读取目录，请稍后重试'],
    ['OTHER_FAILURE', '查询失败，请重试'],
    ['interrupted', '查询已中止'],
  ])('presents the durable %s refusal in plain language', (code, copy) => {
    const view = render(<SkillCatalogRow {...props(settled({ isError: true, error: { name: 'SkillCatalogError', code } }))} />)
    expect(screen.getByRole('status').textContent).toBe(copy)
    expect(view.container.textContent).not.toContain('private-session')
    expect(view.container.querySelector('[data-tool="skill_catalog"]')?.getAttribute('data-state'))
      .toBe(code === 'interrupted' ? 'stopped' : 'error')
  })

  it('renders preparation and running without cursor argument parsing', () => {
    const view = render(<SkillCatalogRow {...props({ phase: 'preparing', args: PartialArguments.EMPTY,
      callId: 'catalog-call', name: 'skill_catalog', turn: 1, step: 1, time: 1000, subCalls: [] })} />)
    expect(screen.getByRole('status').textContent).toBe('准备查询技能')
    view.rerender(<SkillCatalogRow {...props({ phase: 'start', args: PartialArguments.fromText('{"cursor":'), argsRaw: '{"cursor":',
      callId: 'catalog-call', name: 'skill_catalog', turn: 1, step: 1, time: 2000, subCalls: [] })} />)
    expect(screen.getByRole('status').textContent).toBe('正在查询技能')
  })

  it('uses a completed observation when historical or malformed presentation metadata cannot supply counts', () => {
    const view = render(<SkillCatalogRow {...props(settled({ meta: undefined }))} />)
    expect(screen.getByRole('status').textContent).toBe('查询完成')
    view.rerender(<SkillCatalogRow {...props(settled({ meta: { kind: 'skill-catalog', count: -1, totalMatched: 2, hasMore: false } }))} />)
    expect(screen.getByRole('status').textContent).toBe('查询完成')
  })

  it.each([
    { kind: 'skill-catalog', totalMatched: 4, hasMore: true },
    { kind: 'skill-catalog', count: 2, hasMore: true },
    { kind: 'skill-catalog', count: 2, totalMatched: 4 },
  ])('keeps partial historical metadata %j from inventing page counts or a next page', (meta) => {
    const view = render(<SkillCatalogRow {...props(settled({ meta }))} />)
    expect(screen.getByRole('status').textContent).toBe('查询完成')
    expect(view.container.textContent).not.toContain('private-session')
    expect(view.container.textContent).not.toContain('digest')
    view.rerender(<SkillCatalogRow {...props(settled())} />)
    expect(screen.getByRole('status').textContent).toBe('本页 2 项，共 4 项 · 还有更多结果')
  })

  it('provides the same directory keys in every supported dictionary', () => {
    const keys = Object.keys(zh).filter(key => key.startsWith('catalog.')).sort()
    expect(keys).toHaveLength(12)
    for (const dictionary of [en, ja, es, fr, de, ru, pt]) {
      expect(Object.keys(dictionary).filter(key => key.startsWith('catalog.')).sort()).toEqual(keys)
    }
  })
})
