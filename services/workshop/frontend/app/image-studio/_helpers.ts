import type { Tone } from '@/components/ui/_statusColors';
import type { ImageJob } from '@/lib/imageStudio';

export function mapStatus(s: string): Tone {
  if (s === 'succeeded') return 'success';
  if (s === 'failed') return 'danger';
  if (s === 'interrupted' || s === 'canceled') return 'warning';
  if (s === 'running' || s === 'pending') return 'info';
  return 'muted';
}

export function statusLabel(s: string): string {
  return (
    {
      pending: '排队中',
      running: '生成中',
      succeeded: '完成',
      failed: '失败',
      interrupted: '已中断',
      canceled: '已取消',
    } as Record<string, string>
  )[s] || s;
}

export type StatusFilter = 'all' | 'active' | 'done' | 'failed';

export function inFilter(job: ImageJob, f: StatusFilter): boolean {
  if (f === 'all') return true;
  if (f === 'active') return job.status === 'pending' || job.status === 'running';
  if (f === 'done') return job.status === 'succeeded';
  if (f === 'failed') return job.status === 'failed' || job.status === 'interrupted' || job.status === 'canceled';
  return true;
}

export const isActive = (j: ImageJob) => j.status === 'pending' || j.status === 'running';
export const isTerminal = (j: ImageJob) =>
  j.status === 'succeeded' || j.status === 'failed' || j.status === 'interrupted' || j.status === 'canceled';
export const canRetry = (j: ImageJob) =>
  j.status === 'failed' || j.status === 'interrupted' || j.status === 'canceled';

export function elapsed(job: ImageJob): string {
  if (!job.created_at) return '';
  const start = new Date(job.created_at).getTime();
  const end = job.updated_at && isTerminal(job) ? new Date(job.updated_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

export type KpiCounts = { active: number; pending: number; doneToday: number; failed: number };

export function computeKpis(jobs: ImageJob[]): KpiCounts {
  const today = new Date().toDateString();
  let active = 0, pending = 0, doneToday = 0, failed = 0;
  for (const j of jobs) {
    if (j.status === 'running') active += 1;
    if (j.status === 'pending') pending += 1;
    if (j.status === 'succeeded' && j.created_at && new Date(j.created_at).toDateString() === today) doneToday += 1;
    if (j.status === 'failed' || j.status === 'interrupted' || j.status === 'canceled') failed += 1;
  }
  return { active, pending, doneToday, failed };
}

export function promptOf(job: ImageJob): string {
  const p = (job.params as Record<string, unknown> | null)?.prompt;
  return typeof p === 'string' ? p : '';
}
