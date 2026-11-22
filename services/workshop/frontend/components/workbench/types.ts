/**
 * 草稿工作台 (drafts/[id]) 通用类型
 */

/**
 * 草稿工作台 tab 联合类型.
 *
 * 命名注意 (与 page.tsx 内部 useState 类型保持一致, 不要乱改):
 *   - storyboards : 剧本 (历史命名, 后端字段也是 storyboards)
 *   - prompts     : 视频提示词 (历史命名, 后端 prompts 表)
 *   - export/extend: 伪 tab, 点击时仅弹出对应 modal, 不切换主区视图
 */
export type WorkbenchTab =
  | 'overview'
  | 'preview'
  | 'outline'
  | 'chapters'
  | 'storyboards'
  | 'novel'
  | 'tweet'
  | 'prompts'
  | 'images'
  | 'analysis'
  | 'safety'
  | 'characters'
  | 'export'
  | 'extend'
  | 'adapt'
  | 'critique';

export type DraftDetail = {
  id: number;
  title: string;
  status: string;
  user_input?: string;
  chapter_word_target?: number;
  episode_count?: number;
  expected_chapters?: number;
  cover_url?: string | null;
  outline?: any;
  chapters?: Array<{
    id: number;
    title?: string;
    locked?: boolean;
    word_count?: number;
    stale?: boolean;
    [k: string]: any;
  }>;
  storyboards?: Array<{ id: number; [k: string]: any }>;
  characters?: Array<{ id: number; [k: string]: any }>;
  outline_locked?: boolean;
  [k: string]: any;
};

/**
 * 计算工作台 KPI（4 项）
 *  - chapters: 已生成 / 计划
 *  - storyboards: 已生成剧本数
 *  - characters: 角色数（含 outline.characters fallback）
 *  - issues: 风险数（先用 0 占位，后续接 safety_reports.unresolved_count）
 */
export type WorkbenchKpiData = {
  chapters: { done: number; total: number };
  storyboards: number;
  characters: number;
  issues: number;
};

export function computeWorkbenchKpis(d: DraftDetail | null): WorkbenchKpiData {
  if (!d) return { chapters: { done: 0, total: 0 }, storyboards: 0, characters: 0, issues: 0 };
  const chapList = d.chapters || [];
  const storyboardCount = (d.storyboards || []).length;
  const characterCount =
    (d.characters || []).length || (d.outline?.characters?.length ?? 0);
  return {
    chapters: { done: chapList.length, total: d.expected_chapters || chapList.length || 0 },
    storyboards: storyboardCount,
    characters: characterCount,
    issues: 0,
  };
}
