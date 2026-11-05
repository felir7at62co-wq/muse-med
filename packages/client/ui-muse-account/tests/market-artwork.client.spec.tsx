// @vitest-environment jsdom
/** Automatic Skill characters, normalized portraits, and accessible introductions. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MarketAuthorPreview } from '../src/client/MarketAuthorPreview.tsx'
import { MarketSkillArtwork } from '../src/client/MarketCatalogArtwork.tsx'
import { MarketArtwork, MarketCharacter } from '../src/client/MarketCharacter.tsx'
import { MarketReleaseCard } from '../src/client/MarketReleaseCard.tsx'
import { marketFailure } from '../src/client/market-errors.ts'
import { marketPresetPortraitUrls } from '../src/client/market-preset-portrait-urls.ts'
import { marketPresetPortraits } from '../src/client/market-preset-portraits.ts'
import { resolveMarketSkillArtwork } from '../src/client/market-skill-artwork.ts'
import { stockDirectorAnimation } from '../src/client/market-stock-art.ts'
import { marketFixture } from './market-fixture.client.ts'

afterEach(cleanup)

const blank = { name: '', title: '', description: '', category: '' }
const skill = marketFixture[1]!

it('renders every profession character with shared framing and preserves accessible fallback after an image failure', () => {
  const view = render(<MarketSkillArtwork metadata={blank} label="Skill" />)
  for (const { id } of marketPresetPortraits) {
    view.rerender(<MarketSkillArtwork metadata={{ ...blank, presetPortrait: id }} label="Skill" />)
    const image = screen.getByRole('img', { name: 'Skill' })
    expect(image.getAttribute('src')).toBe(marketPresetPortraitUrls[id])
    expect(image.getAttribute('style')).toContain('scale(')
  }
  fireEvent.error(screen.getByRole('img', { name: 'Skill' }))
  expect(screen.getByRole('img', { name: 'Skill' }).localName).toBe('span')
  view.rerender(<MarketSkillArtwork metadata={{ ...blank, name: 'anime-3d-assets' }} label="3D asset Skill" />)
  expect(screen.getByRole('img', { name: '3D asset Skill' }).getAttribute('src')).toBe(marketPresetPortraitUrls['3d-asset-artist'])
})

it('assigns purpose-specific characters from primary Skill identity, package identity, and metadata', () => {
  const cases = [
    ['anime-3d-assets', '3d-asset-artist'],
    ['audio-transcribe', 'sound-designer'],
    ['commercial-drama-poster', 'commercial-poster-designer'],
    ['douyin-download', 'media-archivist'],
    ['guzhuang-sweet-romance-3d', 'character-designer'],
    ['jubian-asset-library', 'asset-librarian'],
    ['jubian-snatch', 'media-archivist'],
    ['media-link-import', 'media-archivist'],
    ['muse-dialogue-polish', 'dialogue-polish'],
    ['muse-episode-design', 'episode-planner'],
    ['muse-llm-wiki', 'knowledge-librarian'],
    ['muse-project-participation', 'production-manager'],
    ['muse-script-doctor', 'screenplay-editor'],
    ['muse-script-editing', 'screenplay-editor'],
    ['muse-storyboard-checklist', 'storyboard-reviewer'],
    ['novel-to-script', 'novel-adaptation'],
    ['office-docx', 'document-specialist'],
    ['office-pptx', 'presentation-designer'],
    ['office-xlsx', 'spreadsheet-analyst'],
    ['screenplay-format', 'screenplay-editor'],
    ['screenplay-project', 'project-bible'],
    ['shot-script-creator-16-9', 'horizontal-storyboard-director'],
    ['shot-script-creator-9-16', 'vertical-storyboard-director'],
    ['storyboard-starter', 'storyboard-reviewer'],
    ['transcript-to-novel', 'adaptation-planner'],
    ['transcript-to-script', 'adaptation-planner'],
    ['trope-adaptation', 'adaptation-planner'],
    ['tweet-drama-asset-extract', 'asset-librarian'],
    ['tweet-drama-asset-vision-check', 'visual-consistency-reviewer'],
    ['tweet-drama-background-render', 'compositor'],
    ['tweet-drama-core', 'production-manager'],
    ['tweet-drama-delivery', 'delivery-coordinator'],
    ['tweet-drama-draft-build', 'video-editor'],
    ['tweet-drama-early-shot-script', 'horizontal-storyboard-director'],
    ['tweet-drama-key-manager', 'workflow-automation'],
    ['tweet-drama-pipeline', 'workflow-automation'],
    ['tweet-drama-project-bible', 'project-bible'],
    ['tweet-drama-project-inspect', 'video-qa'],
    ['tweet-drama-script-convert', 'screenplay-editor'],
    ['tweet-drama-script-split', 'episode-planner'],
    ['tweet-drama-shot-asset-match', 'asset-librarian'],
    ['tweet-drama-voice-continuity', 'voice-casting'],
    ['urban-sweet-romance-3d', 'character-designer'],
    ['video-review', 'video-qa'],
    ['wechat-shortdrama-harvest', 'media-archivist'],
  ] as const
  for (const [name, portrait] of cases) {
    expect(resolveMarketSkillArtwork({ ...blank, name: 'muse/skills/' + name })).toBe(portrait)
    expect(resolveMarketSkillArtwork({ ...blank, name: 'renamed-package', title: 'Other purpose', skills: [{ name }] })).toBe(portrait)
  }
  expect(resolveMarketSkillArtwork({ ...blank, title: '字幕校对' })).toBe('subtitle-specialist')
  expect(resolveMarketSkillArtwork({ ...blank, category: '视频剪辑' })).toBe('video-editor')
  expect(resolveMarketSkillArtwork({ ...blank, description: 'Prepare voice references' })).toBe('voice-casting')
  expect(resolveMarketSkillArtwork(blank)).toBe('document-specialist')
})

it('shows the same 3D Skill character in author preview and a published card with an accessible purpose introduction', () => {
  const metadata = { ...skill.manifest, name: 'anime-3d-assets', title: '3D 动漫漫剧资产', description: '设计人物、场景、道具的 PBR 材质',
    skills: [{ name: 'anime-3d-assets', path: 'skills/anime-3d-assets/SKILL.md' }] }
  const view = render(<>
    <MarketAuthorPreview metadata={metadata} version="0.1.1" publisher="Creator" skillNames={['anime-3d-assets']} t={key => key} />
    <MarketReleaseCard release={{ ...skill, manifest: metadata }} t={key => key}><span>Download</span></MarketReleaseCard>
  </>)
  const preview = within(screen.getByRole('complementary', { name: 'preview' }))
  const card = within(view.container.querySelector('article')!)
  const previewImage = preview.getByRole('img', { name: metadata.title })
  const publishedImage = card.getByRole('img', { name: metadata.title })
  expect(previewImage.getAttribute('src')).toBe(marketPresetPortraitUrls['3d-asset-artist'])
  expect(publishedImage.getAttribute('src')).toBe(previewImage.getAttribute('src'))
  expect(publishedImage.getAttribute('style')).toBe(previewImage.getAttribute('style'))
  fireEvent.click(card.getAllByRole('button', { name: 'introduce' })[0]!)
  expect(card.getAllByText(metadata.description)).toHaveLength(2)
})

it('retains the correct artwork label and supplied framing after a failed custom portrait', () => {
  const base = { label: 'Director', sampleLabel: 'Default artwork' }
  const view = render(<MarketArtwork {...base} posterUrl="/preview.png" />)
  fireEvent.error(screen.getByRole('img', { name: 'Director' }))
  expect(screen.getByRole('img', { name: 'Director' }).localName).toBe('span')
  expect(screen.getByText('Default artwork')).toBeDefined()
  view.rerender(<MarketArtwork {...base} posterUrl="/replacement.png" posterFraming={[0.75, 10, -2]} />)
  const replacement = screen.getByRole('img', { name: 'Director' })
  expect(replacement.getAttribute('src')).toBe('/replacement.png')
  expect(replacement.getAttribute('style')).toContain('scale(0.75)')
  expect(screen.queryByText('Default artwork')).toBeNull()
})

it('introduces the Skill character by pointer, focus or touch and dismisses it with Escape', () => {
  const presentation = { role: 'Storyboard Skill', introduction: 'I plan shots' }
  const view = render(<MarketCharacter presentation={presentation} artwork={<span>Original artwork</span>}
    introduceLabel="Meet the Skill" sampleLabel="Default artwork" />)
  const [portrait, caption] = screen.getAllByRole('button', { name: 'Meet the Skill' })
  const character = view.container.firstElementChild!
  expect(character.getAttribute('data-introducing')).toBe('false')
  fireEvent.pointerEnter(character)
  expect(character.getAttribute('data-introducing')).toBe('true')
  fireEvent.pointerLeave(character)
  fireEvent.focus(portrait!)
  fireEvent.blur(portrait!, { relatedTarget: caption! })
  expect(character.getAttribute('data-introducing')).toBe('true')
  fireEvent.blur(caption!, { relatedTarget: document.body })
  expect(character.getAttribute('data-introducing')).toBe('false')
  fireEvent.click(portrait!)
  expect(portrait!.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('I plan shots')).toBeDefined()
  fireEvent.keyDown(caption!, { key: 'Enter' })
  expect(caption!.getAttribute('aria-expanded')).toBe('true')
  fireEvent.keyDown(caption!, { key: 'Escape' })
  expect(caption!.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('I plan shots')).toBeNull()
  fireEvent.click(caption!)
  expect(screen.getByText('I plan shots')).toBeDefined()
  fireEvent.click(caption!)
  expect(screen.queryByText('I plan shots')).toBeNull()
  expect(screen.getByText('Original artwork')).toBeDefined()
})

it('keeps custom sprite dimensions independent from stock director framing', () => {
  const animation = { ...stockDirectorAnimation, sheetUrl: '/custom-sheet.png', cellWidth: 200, cellHeight: 100 }
  const presentation = { role: 'Custom director', introduction: 'I plan shots', animation }
  const view = render(<MarketCharacter presentation={presentation} introduceLabel="Meet the Skill" sampleLabel="Default artwork" />)
  const sprite = view.container.querySelector('svg[viewBox="0 0 200 100"]')
  expect(sprite?.getAttribute('style')).toBeNull()
  expect(sprite?.querySelector('image')?.getAttribute('href')).toBe('/custom-sheet.png')
  view.rerender(<MarketCharacter presentation={{ ...presentation, animation: stockDirectorAnimation }}
    introduceLabel="Meet the Skill" sampleLabel="Default artwork" />)
  expect(view.container.querySelector('svg[viewBox="0 0 627 627"]')?.getAttribute('style')).toContain('scale(1.2084)')
})

it('previews an unfinished Skill with a character, title, and source guidance', () => {
  render(<MarketAuthorPreview metadata={blank} version="" publisher="" skillNames={[]} t={key => key} />)
  const preview = within(screen.getByRole('complementary', { name: 'preview' }))
  expect(preview.getByRole('heading', { name: 'untitledSkill' })).toBeDefined()
  expect(preview.getByRole('img', { name: 'untitledSkill' }).getAttribute('src')).toBe(marketPresetPortraitUrls['document-specialist'])
  expect(preview.getByText('publisherPending · versionPending')).toBeDefined()
  expect(preview.getByText('noSelectedSkills')).toBeDefined()
  expect(preview.queryByRole('textbox')).toBeNull()
})

it('shows known market errors without leaking unknown upstream details', () => {
  expect(marketFailure(Error('login-required'))).toBe('error.login-required')
  expect(marketFailure(Error('private upstream diagnostic'))).toBe('error.generic')
  expect(marketFailure('login-required')).toBe('error.generic')
})
