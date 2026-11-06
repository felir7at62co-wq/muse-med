/** Two Skills using the current market release fields. */
import type { MarketRelease } from '@deepseek-ai/dsh-muse-market/types'
import type { MarketPresentation } from '../src/client/MarketCharacter.tsx'
import { directorAnimation } from './character-generation-fixture.client.ts'

/** In-memory examples, never records of uploaded or approved publications. */
export const marketFixture: MarketRelease[] = [
  {
    id: '1'.repeat(32) as MarketRelease['id'], publisherId: 'a'.repeat(32) as MarketRelease['publisherId'],
    publisher: 'Muse 联调制作组', sha256: 'c9a51813a11505a5e4267dc1eeaab46b7ffb069f80e4f1c012251b233d56ee78',
    bytes: 589, status: 'published', reviewNote: '', revision: 1, createdAt: '2026-11-02T00:00:00Z',
    manifest: { formatVersion: 1, kind: 'skill', name: 'storyboard-director', title: '分镜导演',
      description: '把剧本拆成可执行的镜头，整理景别、人物调度与画面衔接。', version: '1.0.0',
      license: '仅限联调', category: '分镜创作', examples: ['把这段剧本拆成 6 个镜头，并说明转场方式'],
      requirements: ['在 Muse 中配置可用模型'], skills: [{ name: 'storyboard-director', path: 'skills/storyboard-director/SKILL.md' }] },
  },
  {
    id: '2'.repeat(32) as MarketRelease['id'], publisherId: 'a'.repeat(32) as MarketRelease['publisherId'],
    publisher: 'Muse 联调制作组', sha256: '150bc249b149e3578174394bed6990e04e90549dec06e775e1b40c1a8bcb58b2',
    bytes: 929, status: 'published', reviewNote: '', revision: 1, createdAt: '2026-11-02T00:00:00Z',
    manifest: { formatVersion: 1, kind: 'skill', name: 'storyboard-starter', title: '分镜入门工作法',
      description: '从剧本信息提取到镜头清单，按步骤整理一份可交付的分镜初稿。', version: '1.0.0',
      license: '仅限联调', category: '方法与资源', examples: ['检查我的分镜草稿，找出节奏与衔接问题'],
      requirements: ['在 Muse 中配置可用模型'], skills: [{ name: 'storyboard-starter', path: 'skills/storyboard-starter/SKILL.md' }] },
  },
]

/** Historical Bot metadata used to verify Skill-only consumers reject mixed older results. */
export const marketBotFixture: MarketRelease = {
  ...marketFixture[0]!, id: '3'.repeat(32) as MarketRelease['id'],
  manifest: { ...marketFixture[0]!.manifest, kind: 'bot', title: 'Historical Bot', skills: [], plugins: [] },
}

/** Display-only sample data awaiting agreement on its service-side location. */
export const marketPresentations: Readonly<Record<string, MarketPresentation>> = {
  ['1'.repeat(32)]: { role: '镜镜 · 分镜导演', introduction: '我是分镜导演，帮你把剧本拆成镜头，整理景别与画面衔接。',
    animation: directorAnimation,
    posterUrl: new URL('../src/client/assets/storyboard-director-chibi.png', import.meta.url).href },
}
