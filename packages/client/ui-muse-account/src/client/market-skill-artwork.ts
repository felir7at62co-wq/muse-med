/** Resolve a Skill's cover from the same metadata in discovery, authoring, and ZIP previews. */
import type { MarketSkillGlyphId } from './MarketSkillGlyph.tsx'

type MarketSkillArtworkId = MarketSkillGlyphId | 'storyboard'

/** Identity and purpose fields shared by published and local Skill metadata. */
export interface MarketSkillArtworkMetadata {
  name: string
  title: string
  description: string
  category: string
  skills?: readonly { name: string }[]
}

const artworkByName = new Map<string, MarketSkillArtworkId>([
  ['anime-3d-assets', 'cube'],
  ['audio-transcribe', 'sound'],
  ['commercial-drama-poster', 'poster'],
  ['douyin-download', 'download'],
  ['guzhuang-sweet-romance-3d', 'portrait'],
  ['jubian-asset-library', 'folder'],
  ['jubian-snatch', 'download'],
  ['media-link-import', 'link'],
  ['muse-dialogue-polish', 'dialogue'],
  ['muse-episode-design', 'calendar'],
  ['muse-llm-wiki', 'book'],
  ['muse-project-participation', 'calendar'],
  ['muse-script-doctor', 'qa'],
  ['muse-script-editing', 'pen'],
  ['muse-storyboard-checklist', 'storyboard'],
  ['novel-to-script', 'translate'],
  ['office-docx', 'document'],
  ['office-pptx', 'presentation'],
  ['office-xlsx', 'table'],
  ['screenplay-format', 'document'],
  ['screenplay-project', 'qa'],
  ['shot-script-creator-16-9', 'frames-wide'],
  ['shot-script-creator-9-16', 'frames-vertical'],
  ['storyboard-starter', 'storyboard'],
  ['transcript-to-novel', 'book'],
  ['transcript-to-script', 'translate'],
  ['trope-adaptation', 'workflow'],
  ['tweet-drama-asset-extract', 'image'],
  ['tweet-drama-asset-vision-check', 'research'],
  ['tweet-drama-background-render', 'clapper'],
  ['tweet-drama-core', 'workflow'],
  ['tweet-drama-delivery', 'package'],
  ['tweet-drama-draft-build', 'captions'],
  ['tweet-drama-early-shot-script', 'camera'],
  ['tweet-drama-key-manager', 'key'],
  ['tweet-drama-pipeline', 'workflow'],
  ['tweet-drama-project-bible', 'book'],
  ['tweet-drama-project-inspect', 'qa'],
  ['tweet-drama-script-convert', 'translate'],
  ['tweet-drama-script-split', 'frames'],
  ['tweet-drama-shot-asset-match', 'link'],
  ['tweet-drama-voice-continuity', 'voice'],
  ['urban-sweet-romance-3d', 'portrait'],
  ['video-review', 'video-qa'],
  ['wechat-shortdrama-harvest', 'download'],
])

const artworkByCategory = new Map<string, MarketSkillArtworkId>([
  ['分镜创作', 'storyboard'], ['镜头分镜', 'storyboard'], ['storyboard', 'storyboard'],
  ['剧本创作', 'pen'], ['script', 'pen'], ['writing', 'pen'],
  ['角色与资产', 'cube'], ['assets', 'cube'],
  ['媒体与交付', 'clapper'], ['短剧制作', 'clapper'], ['media', 'clapper'],
  ['海报宣发', 'poster'], ['poster', 'poster'],
  ['制作工具', 'terminal'], ['tools', 'terminal'],
  ['办公文档', 'document'], ['office', 'document'], ['documents', 'document'],
  ['编程开发', 'code'], ['code', 'code'], ['coding', 'code'],
])

const purposePatterns: readonly (readonly [RegExp, MarketSkillArtworkId])[] = [
  [/(?:横屏|16\s*:\s*9).*(?:分镜|镜头脚本)/u, 'frames-wide'],
  [/(?:竖屏|9\s*:\s*16).*(?:分镜|镜头脚本)/u, 'frames-vertical'],
  [/分镜|镜头脚本|\bstoryboard\b/u, 'storyboard'],
  [/表格|\b(?:excel|xlsx|spreadsheet)\b/u, 'table'],
  [/演示文稿|\b(?:powerpoint|pptx|slides)\b/u, 'presentation'],
  [/海报|\bposter\b/u, 'poster'],
  [/密钥|\bapi keys?\b/u, 'key'],
  [/资产库|\basset library\b/u, 'folder'],
  [/画面提示词|图像提示词|\bimage prompts?\b/u, 'prompt'],
  [/语音转写|\btranscription\b/u, 'sound'],
  [/声线|配音|\bvoice\b/u, 'voice'],
  [/字幕|\b(?:subtitles?|captions?)\b/u, 'captions'],
  [/台词|对白|\bdialogue\b/u, 'dialogue'],
  [/剪辑|\bvideo editing\b/u, 'edit'],
  [/视频审阅|视频质检|\bvideo review\b/u, 'video-qa'],
  [/核对|审核|检查|验收|\bquality check\b/u, 'qa'],
  [/素材导入|媒体导入|视频获取|\b(?:download|media import)\b/u, 'download'],
  [/翻译|格式转换|\b(?:translation|convert)\b/u, 'translate'],
  [/知识库|\b(?:wiki|knowledge base)\b/u, 'book'],
  [/流水线|自动化|\b(?:pipeline|workflow)\b/u, 'workflow'],
  [/打包交付|交付模板|\bdelivery package\b/u, 'package'],
  [/剧本|\bscreenplay\b/u, 'pen'],
]

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function namedArtwork(value: string): MarketSkillArtworkId | undefined {
  return artworkByName.get(normalized(value).replace(/^muse\/skills\//u, ''))
}

/** Select an illustration using the bundled Skill name, package identity, and stated purpose.
 * @param metadata Metadata available before and after packaging a Skill.
 * @returns The shared cover identifier. Unknown purposes use a document illustration.
 */
export function resolveMarketSkillArtwork(metadata: MarketSkillArtworkMetadata): MarketSkillArtworkId {
  const primarySkill = metadata.skills?.[0]
  const named = (primarySkill && namedArtwork(primarySkill.name)) ?? namedArtwork(metadata.name)
  if (named) return named

  const title = normalized(metadata.title)
  const titled = purposePatterns.find(([pattern]) => pattern.test(title))?.[1]
  const declared = titled ?? artworkByCategory.get(normalized(metadata.category))
  if (declared) return declared

  const description = normalized(metadata.description)
  const described = purposePatterns.filter(([pattern]) => pattern.test(description))
  return (described.length === 1 ? described.at(0)?.[1] : undefined) ?? 'document'
}
