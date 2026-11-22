/**
 * 状态色映射 — 6 业务状态 + 5 任务状态 + 5 风险等级 + 5 记忆类型 + 6 关系类型
 * 全部从 PLAN_UI_REVAMP §37 + AUDIT 获得.
 *
 * 用于 StatusBadge / TagChip 等组件统一着色.
 */

export type Tone =
  | 'primary'
  | 'cyan'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'muted';

/** Tailwind class 组合 — bg / text / border */
export const toneClasses: Record<Tone, { bg: string; text: string; border: string; dot: string }> = {
  primary: {
    bg: 'bg-primary-subtle',
    text: 'text-primary',
    border: 'border-primary/40',
    dot: 'bg-primary',
  },
  cyan: {
    bg: 'bg-cyan-subtle',
    text: 'text-cyan',
    border: 'border-cyan/40',
    dot: 'bg-cyan',
  },
  success: {
    bg: 'bg-success-subtle',
    text: 'text-success',
    border: 'border-success/40',
    dot: 'bg-success',
  },
  warning: {
    bg: 'bg-warning-subtle',
    text: 'text-warning',
    border: 'border-warning/40',
    dot: 'bg-warning',
  },
  danger: {
    bg: 'bg-danger-subtle',
    text: 'text-danger',
    border: 'border-danger/40',
    dot: 'bg-danger',
  },
  info: {
    bg: 'bg-info-subtle',
    text: 'text-info',
    border: 'border-info/40',
    dot: 'bg-info',
  },
  muted: {
    bg: 'bg-white/5',
    text: 'text-ink-muted',
    border: 'border-line',
    dot: 'bg-ink-muted',
  },
};

/* ───── DraftStatus ───── */
export type DraftStatus =
  | 'not_started'
  | 'ideating'
  | 'generating'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'archived';

export const draftStatusMeta: Record<DraftStatus, { label: string; tone: Tone }> = {
  not_started: { label: '未开始', tone: 'muted' },
  ideating: { label: '构思中', tone: 'warning' },
  generating: { label: '生成中', tone: 'primary' },
  completed: { label: '已完成', tone: 'success' },
  // 视频反推/长任务被进程重启打断。既不是"还在跑"也不是"失败"——
  // 素材还在，点续跑就能接着做，所以单独给一档，别混进"未开始"里让用户以为没动过。
  interrupted: { label: '已中断', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  archived: { label: '已归档', tone: 'muted' },
};

/* ───── BatchJobStatus ───── */
export type BatchJobStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';

export const batchJobStatusMeta: Record<BatchJobStatus, { label: string; tone: Tone }> = {
  queued: { label: '等待中', tone: 'info' },
  running: { label: '执行中', tone: 'primary' },
  success: { label: '已完成', tone: 'success' },
  error: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'muted' },
};

/* ───── RiskLevel (5 级，新增 info) ───── */
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const riskLevelMeta: Record<RiskLevel, { label: string; tone: Tone }> = {
  critical: { label: '严重', tone: 'danger' },
  high: { label: '高', tone: 'danger' },
  medium: { label: '中', tone: 'warning' },
  low: { label: '低', tone: 'success' },
  info: { label: '提示', tone: 'info' },
};

/* ───── MemoryType (5 类专属色) ───── */
export type MemoryType =
  | 'genre_preference'
  | 'writing_habit'
  | 'character_pref'
  | 'model_preference'
  | 'user_profile';

export const memoryTypeMeta: Record<MemoryType, { label: string; tone: Tone }> = {
  genre_preference: { label: '题材偏好', tone: 'primary' },
  writing_habit: { label: '写作习惯', tone: 'success' },
  character_pref: { label: '角色偏好', tone: 'warning' },
  model_preference: { label: '模型偏好', tone: 'info' },
  user_profile: { label: '用户资料', tone: 'muted' },
};

/* ───── RelationType (6 类关系色) ───── */
export type RelationType = 'kinship' | 'ally' | 'enemy' | 'exploit' | 'trust' | 'other';

export const relationTypeMeta: Record<RelationType, { label: string; tone: Tone }> = {
  kinship: { label: '亲属', tone: 'primary' },
  ally: { label: '同盟', tone: 'info' },
  enemy: { label: '敌对', tone: 'danger' },
  exploit: { label: '利用', tone: 'warning' },
  trust: { label: '信任', tone: 'success' },
  other: { label: '其他', tone: 'muted' },
};
