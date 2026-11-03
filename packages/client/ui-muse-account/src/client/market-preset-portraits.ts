/** Localized labels and deterministic recommendations for built-in Bot portraits. */
import type { MarketPresetPortraitId } from '@deepseek-ai/dsh-muse-market/types'

/** Selectable portrait and its labels in the market's supported languages. */
export interface MarketPresetPortrait {
  readonly id: MarketPresetPortraitId
  readonly name: string
  readonly nameEn: string
  readonly group: 'script' | 'direction' | 'visual' | 'masters'
}

type PortraitEntry = readonly [group: MarketPresetPortrait['group'], name: string, nameEn: string, aliases: string]

const entries = {
  'short-drama-writer': ['script', '短剧编剧', 'Short Drama Writer', '短剧创作|短剧剧本|剧本创作|短剧脚本|剧本生成|编剧|scriptwriting|script writer|screenwriter'],
  'screenplay-editor': ['script', '剧本编辑', 'Screenplay Editor', '剧本修改|剧本优化|剧本审阅|剧本润色|剧本审校|剧本医生|脚本优化|script editing|script editor|script doctor|screenplay'],
  'dialogue-polish': ['script', '台词润色', 'Dialogue Editor', '台词优化|台词校对|对白润色|对白优化|对话润色|dialogue polish|dialogue revision'],
  'adaptation-planner': ['script', '改编策划', 'Adaptation Planner', '剧本改编|改编方案|内容改编|故事改编|adaptation plan|script adaptation'],
  'outline-architect': ['script', '剧情大纲', 'Story Outline Writer', '故事大纲|大纲策划|大纲生成|情节梳理|剧情结构|story outline|plot outline'],
  'episode-planner': ['script', '分集策划', 'Episode Planner', '分集大纲|分集规划|集数规划|分集梗概|episode outline|episode planning'],
  'plot-continuity': ['script', '剧情连贯性审校', 'Plot Continuity Reviewer', '剧情连贯|剧情漏洞|情节审校|逻辑漏洞|剧情逻辑|plot continuity|plot holes|story continuity'],
  'character-biography': ['script', '人物小传', 'Character Biography Writer', '角色小传|人物背景|人物传记|角色传记|角色背景故事|character biography|character backstory'],
  'novel-adaptation': ['script', '小说改编', 'Novel Adaptation Writer', '网文改编|文学改编|小说转剧本|网文转剧本|novel adaptation|book to screenplay'],
  'storyboard-reviewer': ['script', '分镜审阅', 'Storyboard Reviewer', '分镜审查|分镜审核|分镜审校|分镜质检|分镜检查|storyboard review|storyboard qa'],
  'horizontal-storyboard-director': ['direction', '横屏分镜导演', 'Landscape Storyboard Director', '横屏分镜|横版分镜|横屏镜头|分镜导演|分镜创作|分镜脚本|分镜生成|landscape storyboard|horizontal storyboard|storyboard director|storyboarding|storyboard'],
  'vertical-storyboard-director': ['direction', '竖屏分镜导演', 'Vertical Storyboard Director', '竖屏分镜|竖版分镜|竖屏镜头|portrait storyboard|vertical storyboard|vertical shot list'],
  'short-drama-director': ['direction', '短剧导演', 'Short Drama Director', '短剧执导|短剧导戏|短剧编导|导演|drama director|series director'],
  'blocking-coach': ['direction', '场面调度指导', 'Blocking Coach', '场面调度|演员走位|动作走位|表演调度|舞台调度|actor blocking|scene blocking'],
  cinematographer: ['direction', '摄影指导', 'Cinematographer', '摄影策划|摄影方案|镜头语言|拍摄指导|电影摄影|cinematography|director of photography|camera direction'],
  'lighting-designer': ['direction', '灯光设计', 'Lighting Designer', '灯光方案|布光|打光|光照设计|lighting design|lighting setup|lighting plan'],
  'shot-continuity': ['direction', '场记', 'Script Supervisor', '镜头连续性|拍摄连续性|镜头衔接记录|场记表|shot continuity|script supervision'],
  'shot-compiler': ['direction', '镜头组接师', 'Shot Assembly Editor', '镜头组接|镜头衔接|镜头拼接|镜头整理|shot assembly|shot sequencing'],
  'animatic-planner': ['direction', '动态分镜策划', 'Animatic Planner', '动态分镜|分镜动画|动态预演|动画预演|animatic|previsualization|previs'],
  'virtual-camera-operator': ['direction', '虚拟摄像操作员', 'Virtual Camera Operator', '虚拟摄像|虚拟摄影机|虚拟机位|虚拟相机|virtual camera|virtual cinematography'],
  '3d-asset-artist': ['visual', '3D资产师', '3D Asset Artist', '3d资产|三维资产|3d建模|三维建模|3d模型|3d assets|3d modeling|3d model'],
  'character-designer': ['visual', '角色设计师', 'Character Designer', '角色设计|人设设计|人物造型|人设图|角色概念|character design|character concept'],
  'environment-designer': ['visual', '场景设计师', 'Environment Designer', '场景设计|环境设计|背景设计|场景概念|environment design|background design|set design'],
  'prop-designer': ['visual', '道具设计师', 'Prop Designer', '道具设计|道具概念|影视道具|prop design|prop concept'],
  'costume-designer': ['visual', '服装设计师', 'Costume Designer', '服装设计|戏服设计|造型搭配|服装搭配|costume design|wardrobe design'],
  'makeup-stylist': ['visual', '妆造师', 'Makeup Stylist', '妆容设计|妆造|化妆|发型设计|makeup design|hair and makeup|makeup'],
  'commercial-poster-designer': ['visual', '商业海报设计师', 'Commercial Poster Designer', '商业海报|海报设计|剧宣海报|宣传海报|电影海报|主视觉海报|poster design|movie poster|key art|poster'],
  'visual-consistency-reviewer': ['visual', '视觉一致性审阅员', 'Visual Consistency Reviewer', '视觉一致性|角色一致性|画风一致性|画面一致性|visual consistency|style consistency|character consistency'],
  'image-prompt-designer': ['visual', '图像提示词设计师', 'Image Prompt Designer', '图像提示词|图片提示词|生图提示词|绘图提示词|文生图|图像生成|image prompt|image generation|text to image'],
  'asset-librarian': ['visual', '素材管理员', 'Asset Librarian', '素材管理|素材库|资产目录|素材标签|asset library|asset catalog|asset management'],
  'video-editor': ['masters', '剪辑师', 'Video Editor', '视频剪辑|影视剪辑|粗剪|精剪|剪片|剪辑|video editing|film editing|timeline edit'],
  'sound-designer': ['masters', '声音设计师', 'Sound Designer', '音效设计|声音设计|混音|拟音|音频处理|sound design|sound effects|audio mixing|foley'],
  'subtitle-specialist': ['masters', '字幕师', 'Subtitle Specialist', '字幕生成|字幕翻译|字幕校对|字幕制作|字幕|subtitling|subtitles|captioning|captions|srt'],
  'voice-casting': ['masters', '配音选角', 'Voice Casting Director', '配音演员|配音选角|角色配音|配音|配音导演|voice casting|voiceover|dubbing|voice acting'],
  colorist: ['masters', '调色师', 'Colorist', '影视调色|视频调色|色彩校正|调色|color grading|colour grading|color correction'],
  compositor: ['masters', '特效合成师', 'VFX Compositor', '特效合成|视觉特效|影视特效|画面合成|抠像|compositing|vfx|chroma key'],
  'delivery-coordinator': ['masters', '交付协调', 'Delivery Coordinator', '成片交付|交付清单|视频交付|交付流程|media delivery|deliverables|delivery checklist'],
  'video-qa': ['masters', '视频质检', 'Video QA Reviewer', '视频检查|成片质检|视频审查|成片审查|video quality|video review|quality control'],
  'music-supervisor': ['masters', '音乐统筹', 'Music Supervisor', '背景音乐|音乐选曲|配乐|音乐授权|music supervision|soundtrack|music selection|bgm'],
  'media-archivist': ['masters', '媒体归档', 'Media Archivist', '视频归档|影像归档|成片归档|媒体备份|media archive|video archive|archive media'],
  'production-manager': ['masters', '制片统筹', 'Production Manager', '制作统筹|制作计划|拍摄排期|项目排期|制片管理|production planning|production scheduling|production management'],
  'budget-coordinator': ['masters', '预算管理', 'Budget Coordinator', '制作预算|制片预算|项目预算|成本核算|预算|budgeting|cost estimation|cost tracking'],
  'project-bible': ['masters', '项目设定管理', 'Project Bible Curator', '项目设定|世界观设定|故事设定集|剧集设定集|剧集宝典|project bible|series bible|story bible|worldbuilding'],
  'research-assistant': ['masters', '资料研究', 'Research Assistant', '资料搜集|资料检索|背景调查|查找资料|信息检索|research support|desk research|source research|research'],
  'knowledge-librarian': ['masters', '知识库管理员', 'Knowledge Librarian', '知识库管理|知识库建设|知识管理|知识库|knowledge base|knowledge management|documentation library'],
  'document-specialist': ['masters', '文档编辑', 'Document Specialist', '文档生成|文档排版|文档处理|文档润色|文档撰写|办公文档|文档|document editing|document writing|word processing'],
  'spreadsheet-analyst': ['masters', '表格分析', 'Spreadsheet Analyst', '数据分析|电子表格|数据表格|工作表|表格|spreadsheet|data analysis|excel|csv'],
  'presentation-designer': ['masters', '演示设计', 'Presentation Designer', '演示文稿|汇报幻灯片|幻灯片|幻灯片排版|演示文档|presentation design|slides|slide deck|powerpoint|ppt'],
  'coding-assistant': ['masters', '编程助手', 'Coding Assistant', '软件开发|代码生成|代码审查|代码调试|编程|程序员|写代码|coding|code review|software development|debugging|codex|claude code'],
  'workflow-automation': ['masters', '流程自动化', 'Workflow Automation Engineer', '工作流自动化|自动化流程|工作流|流程编排|任务编排|workflow automation|workflow orchestration|workflow|automation'],
} satisfies Record<MarketPresetPortraitId, PortraitEntry>

/** Catalog order also resolves equal-strength recommendations. */
export const marketPresetPortraits: readonly MarketPresetPortrait[] = (Object.keys(entries) as MarketPresetPortraitId[]).map((id) => {
  const [group, name, nameEn] = entries[id]
  return { id, name, nameEn, group }
})

type PortraitLabelKey = `presetPortrait.${MarketPresetPortraitId}`

function labels(field: 'name' | 'nameEn'): Record<PortraitLabelKey, string> {
  return Object.fromEntries(marketPresetPortraits.map(row => [`presetPortrait.${row.id}`, row[field]])) as Record<PortraitLabelKey, string>
}

/** Simplified Chinese portrait labels for the market dictionary. */
export const marketPresetPortraitLabelsZh = labels('name')

/** English portrait labels for the market dictionary. */
export const marketPresetPortraitLabelsEn = labels('nameEn')

/** Find a selectable preset from a UI or wire identifier.
 * @param id Candidate identifier.
 * @returns The preset, or undefined for unknown and legacy identifiers.
 */
export function findMarketPresetPortrait(id: string): MarketPresetPortrait | undefined {
  return marketPresetPortraits.find(portrait => portrait.id === id)
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const matchers = marketPresetPortraits.map(portrait => ({
  portrait,
  terms: [...new Set([portrait.name, portrait.nameEn, portrait.id, ...entries[portrait.id][3].split('|')].map(normalize))]
    .map((value) => {
      const han = /\p{Script=Han}/u.test(value)
      const length = han ? value.length : value.split(' ').length * 2
      return { value, han, length }
    }),
}))

const fallback = marketPresetPortraits.find(portrait => portrait.id === 'screenplay-editor')
if (!fallback) throw new Error('Missing screenplay editor portrait')

/** Recommend a preset from bilingual purpose and manifest metadata. Higher-specificity
 * phrases outrank generic terms, with explicit purpose and title weighted above summaries.
 * @param fields Bot purpose and optional manifest metadata.
 * @returns Best-scoring preset, or the screenplay editor for unrecognized purposes.
 */
export function matchMarketPresetPortrait(fields: {
  purpose?: string
  title?: string
  description?: string
  category?: string
  tags?: readonly string[]
}): MarketPresetPortrait {
  const sources = [
    { weight: 6, value: normalize(fields.purpose ?? '') },
    { weight: 5, value: normalize(fields.title ?? '') },
    { weight: 3, value: normalize(fields.category ?? '') },
    { weight: 2, value: normalize(fields.description ?? '') },
    ...fields.tags?.map(tag => ({ weight: 2, value: normalize(tag) })) ?? [],
  ]
  let best = fallback, bestScore = 0
  for (const { portrait, terms } of matchers) {
    let score = 0
    for (const { weight, value } of sources) {
      for (const term of terms) {
        const found = term.han ? value.includes(term.value) : ` ${value} `.includes(` ${term.value} `)
        if (found) score = Math.max(score, weight * (term.length + (term.value === value ? 8 : 0)))
      }
    }
    if (score > bestScore) { best = portrait; bestScore = score }
  }
  return best
}
