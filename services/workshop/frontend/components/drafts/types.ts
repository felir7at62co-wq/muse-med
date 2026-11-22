/**
 * Drafts 业务组件共享类型
 *
 * 后端 /v1/stages/drafts 当前返回的字段名各异，这里做统一映射。
 */

import type { DraftStatus } from '@/components/ui';

export type DraftRow = {
  id: number;
  title: string;
  user_input: string;
  status: string; // 后端原始 status: draft / outline_done / outline_locked / running / generating / queued / completed / imported / ...
  created_at: string;
  updated_at: string;
  quality_score?: number | null;
  last_polish_p0?: number | null; // 最近一次自动打磨残留硬伤数(p0_left); 无打磨则 undefined/null
  auto_batch_job_id?: number | null;
  is_favorite?: boolean;
  chapter_count?: number;
  storyboard_count?: number;
  expected_chapters?: number;
  cover_url?: string | null;
  // 来源用户 (仅管理员视角由后端附带, 普通用户为 undefined)
  owner_label?: string | null;
  owner_display_name?: string | null;
  owner_username?: string | null;
};

export type Tag = {
  id: number;
  name: string;
  color: string;
  count?: number;
};

/**
 * 把后端 status 字符串映射到 6 类标准 DraftStatus（PLAN §31.1）
 */
export function mapDraftStatus(raw: string | null | undefined): DraftStatus {
  if (!raw) return 'not_started';
  const s = raw.toLowerCase();
  // ⚠️ 必须最先判: 下面没有哪个分支能兜住它, 会一路落到结尾的 'not_started'。
  // 那样用户看到"未开始"会以为视频白传了, 而不是"已中断、可续跑"。
  // (video_running 含 "running" → 仍归"生成中", 反推确实在跑, 这没问题。)
  if (s.includes('interrupt')) return 'interrupted';
  if (s.includes('generating') || s.includes('running') || s.includes('queued')) return 'generating';
  if (s === 'draft') return 'ideating';
  if (s === 'completed' || s === 'imported' || s.includes('done') || s.includes('locked')) return 'completed';
  if (s.includes('failed') || s.includes('error')) return 'failed';
  if (s.includes('archived')) return 'archived';
  return 'not_started';
}

/**
 * 计算草稿生成进度百分比 (用于 DraftCard 进度条)
 */
export function getDraftProgress(d: DraftRow): number | null {
  const expected = d.expected_chapters || 0;
  const generated = d.chapter_count || 0;
  if (expected <= 0) return null;
  return Math.min(100, Math.round((generated / expected) * 100));
}

/**
 * 创作概览 KPI 聚合
 */
export type DraftStats = {
  total: number;
  generating: number;
  completed: number;
  ideating: number;
};

export function computeStats(drafts: DraftRow[]): DraftStats {
  let generating = 0;
  let completed = 0;
  let ideating = 0;
  for (const d of drafts) {
    const m = mapDraftStatus(d.status);
    if (m === 'generating') generating++;
    else if (m === 'completed') completed++;
    else if (m === 'ideating' || m === 'not_started') ideating++;
  }
  return { total: drafts.length, generating, completed, ideating };
}
