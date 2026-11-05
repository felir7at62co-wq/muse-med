/** Local design harness rendering the production market components with an in-memory adapter. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketSectionProps } from '../../src/client/MarketSection.tsx'
import { MarketCreatorPanel, MarketPage, MarketSettingsLink } from '../../src/client/MarketPage.tsx'
import type { MarketCreatorKind } from '../../src/client/MarketCreatorPage.tsx'
import type { MarketActions } from '../../src/client/market-mount.ts'
import type { MarketInstallation } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import { marketZh, marketEn, type MarketLocaleKey } from '../../src/client/market-locales.ts'
import { marketFixture } from '../market-fixture.client.ts'
import '../../../ui-theme/src/styles/base.css'
import '../../../ui-theme/src/styles/design-platform.css'
import '../../../ui-theme/src/styles/gradient-shadow-text.css'
import '../../../ui-theme/src/styles/corner-shape.css'
import '../../../ui-theme/src/styles/scrollbar.css'
import '../../../ui-theme/src/styles/focus.css'
import './preview.css'

const local = new Map<string, MarketInstallation>()
const cloud = new Map<string, MarketRelease>(marketFixture.map(row => [row.id, row]))
let scenario = 'normal', failNext = false
const actions: MarketActions = {
  legacyCatalog: async () => [],
  catalog: async (query, kind, mine) => {
    if (scenario === 'read-failure' && failNext) { failNext = false; throw Error('generic') }
    if (scenario === 'empty') return []
    return [...cloud.values()].filter(row => (mine || row.status === 'published') && (!kind || row.manifest.kind === kind)
      && `${row.manifest.title} ${row.manifest.description} ${row.publisher}`.includes(query))
  },
  installed: async () => [...local.values()],
  sources: async () => ({ website: '/#market',     skills: [{ name: 'storyboard-starter', description: '分镜入门工作法' }] }),
  identity: async () => ({ publishers: [{ id: 'a'.repeat(32), title: 'Muse 联调制作组' }], admin: scenario === 'admin-review' }),
  install: async (id) => {
    if (scenario === 'download-failure' && failNext) { failNext = false; throw Error('generic') }
    const release = cloud.get(id)
    if (!release) throw Error('generic')
    const item = { release, enabled: false }; local.set(id, item); return item
  },
  installLegacy: async () => { throw Error('preview-only') },
  enable: async (id, enabled) => {
    if (scenario === 'enable-failure' && failNext) { failNext = false; throw Error('release-in-use') }
    const previous = local.get(id)
    if (!previous) throw Error('generic')
    const item = { ...previous, enabled }; local.set(id, item); return item
  },
  remove: async (id) => { local.delete(id) },
  prepare: async () => { throw Error('preview-only') },
  importPackage: async () => { throw Error('preview-only') },
  exportPackage: async () => { throw Error('preview-only') },
  publishDraft: async () => { throw Error('preview-only') },
  review: async (id, revision, action, note) => {
    const row = cloud.get(id)
    if (!row || row.revision !== revision) throw Error('cloud-conflict')
    const status = action === 'submit' ? 'pending' : action === 'approve' ? 'published' : action === 'reject' ? 'rejected' : 'withdrawn'
    const result: MarketRelease = { ...row, status, revision: revision + 1, reviewNote: note }
    cloud.set(id, result); return result
  },
}

function Preview() {
  const [english, setEnglish] = useState(false), [dark, setDark] = useState(false)
  const [panel, setPanel] = useState('market'), [mode, setMode] = useState('normal'), [instance, setInstance] = useState(0)
  const [creatorKind, setCreatorKind] = useState<MarketCreatorKind>('skill')
  const [outcome, setOutcome] = useState<{ key: keyof typeof marketZh; failed: boolean; sequence: number }>()
  const t: MarketSectionProps['t'] = (key, args) => {
    const copy = english ? marketEn : marketZh
    let text = Object.hasOwn(copy, key) ? copy[key as MarketLocaleKey] : key
    for (const [name, value] of Object.entries(args ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
  const reportOutcome: MarketSectionProps['reportOutcome'] = (key, failed) => {
    setOutcome(previous => ({ key, failed, sequence: (previous?.sequence ?? 0) + 1 }))
  }
  return <div className="preview-shell">
    <div className="preview-workspace"><details className="preview-debug"><summary>前后端集成分支预览 · 两个 Skill · 页面操作仍使用模拟数据</summary>
      <header className="preview-header"><span>本页复用市场主区域组件</span>
        <div><label>接口演练<select aria-label="接口演练" value={mode} onChange={(event) => {
          scenario = event.target.value; failNext = true; local.clear()
          cloud.clear(); for (const row of marketFixture) cloud.set(row.id, scenario === 'admin-review'
            ? { ...row, status: 'pending' } : row)
          if (scenario === 'enable-failure') local.set(marketFixture[0]!.id, { release: marketFixture[0]!, enabled: false })
          setMode(scenario); setInstance(value => value + 1); setOutcome(undefined); setPanel('market')
        }}><option value="normal">正常</option><option value="read-failure">读取失败一次</option><option value="empty">空列表</option>
          <option value="download-failure">下载失败一次</option><option value="enable-failure">启用失败一次</option>
          <option value="admin-review">管理员审核演示</option></select></label>
        <button onClick={() =>{  setEnglish(value => !value) }}>{english ? '中文' : 'English'}</button>
        <button onClick={() => { setDark(!dark); document.body.toggleAttribute('data-ds-dark-theme', !dark) }}>{dark ? '浅色' : '深色'}</button>
        <Button onClick={() =>{  setPanel(panel === 'market' ? 'settings' : 'market') }}>{panel === 'market' ? '设置入口预览' : '返回市场'}</Button>
        </div></header><p className="preview-note">已按后端字段对齐；本页不连接云端。可选择管理员审核演示，检查五种发行状态；Skill 形象按用途自动匹配</p></details>
    <main id="market" className="preview-canvas">{panel === 'market'
      ? <MarketPage key={instance} actions={actions} t={t} reportOutcome={reportOutcome}
        onOpenCreator={(kind) => { setCreatorKind(kind); setPanel('creator') }} />
      : panel === 'creator'
        ? <MarketCreatorPanel actions={actions} getInitialKind={() => creatorKind}
          onBack={() => { setPanel('market') }} t={t} reportOutcome={reportOutcome} />
        : <div className="preview-settings"><h1>设置入口预览</h1><MarketSettingsLink t={t}
          onOpen={() =>{  setPanel('market') }} close={() =>{  setPanel('market') }} /></div>}</main>
    {outcome && <Toast key={outcome.sequence} text={t(outcome.key)} {...(outcome.failed ? {} : { tone: 'success' as const })}
      onDone={() =>{  setOutcome(undefined) }} />}
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
