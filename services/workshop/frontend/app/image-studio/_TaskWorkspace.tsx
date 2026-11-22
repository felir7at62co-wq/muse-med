'use client';

import React, { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs } from '@/components/ui/Tabs';
import { Skeleton } from '@/components/ui/Skeleton';
import type { ImageJob, Workflow } from '@/lib/imageStudio';
import { describeSize, classifyError, downloadImage, downloadImages } from '@/lib/imageStudio';
import { HoverZoomThumb, useLightbox } from './_imageExtras';
import {
  mapStatus, statusLabel, type StatusFilter, inFilter,
  isActive, canRetry, elapsed, promptOf, type KpiCounts,
} from './_helpers';

export type ViewMode = 'grid' | 'list';

type Asset = ImageJob['assets'][number];

type Props = {
  jobs: ImageJob[];
  kpis: KpiCounts;
  filter: StatusFilter;
  setFilter: (f: StatusFilter) => void;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  loading: boolean;
  onCancel: (id: number) => void;
  onRetry: (id: number) => void;
  onUpscale: (assetId: number) => void;
  onRegenerate: (id: number) => void;
  onDelete: (id: number) => void;
  onTweak: (job: ImageJob) => void;
  // 批量
  selected: Set<number>;
  toggleSelect: (id: number) => void;
  onBatchRegenerate: () => void;
  onBatchDelete: () => void;
  clearSelect: () => void;
  workflows?: Workflow[];
};

// 任务参考图条 (悬停放大 + 点击 Lightbox)
function RefStrip({ urls }: { urls: string[] }) {
  if (!urls || urls.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-micro text-muted-foreground mb-1">参考图 ({urls.length})</div>
      <div className="flex items-center gap-2 flex-wrap">
        {urls.map((u, i) => <HoverZoomThumb key={i} url={u} alt={`ref-${i}`} allUrls={urls} index={i} />)}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex flex-col items-center px-3 py-2 rounded-md bg-white/[0.04] border border-line min-w-[72px]">
      <span className={`text-title font-semibold ${tone}`}>{value}</span>
      <span className="text-micro text-muted-foreground">{label}</span>
    </div>
  );
}

// 单图: 真实比例显示, 悬停放大, 点击 Lightbox, 下载/高清按钮
function AssetTile({ a, groupUrls, groupIndex, onUpscale }: {
  a: Asset; groupUrls: string[]; groupIndex: number; onUpscale: (id: number) => void;
}) {
  const lb = useLightbox();
  return (
    <div className="rounded-md overflow-hidden border group relative bg-black/20 flex items-center justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={a.url}
        alt={`asset-${a.id}`}
        loading="lazy"
        decoding="async"
        onClick={() => lb.open(groupUrls, groupIndex)}
        className="w-full h-auto max-h-[420px] object-contain cursor-zoom-in group-hover:opacity-90"
      />
      {a.kind === 'upscaled' ? (
        <span className="absolute top-1 left-1"><Badge tone="success">超清</Badge></span>
      ) : (
        <button
          onClick={() => onUpscale(a.id)}
          className="absolute bottom-1 right-1 text-micro px-2 py-0.5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition"
        >高清放大</button>
      )}
      <button
        onClick={() => downloadImage(a.url, `image-${a.id}.png`)}
        className="absolute top-1 right-1 text-micro px-2 py-0.5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition"
        title="下载此图"
      >下载</button>
      {a.width && a.height && (
        <span className="absolute bottom-1 left-1 text-micro px-1.5 py-0.5 rounded bg-black/50 text-white">{a.width}×{a.height}</span>
      )}
    </div>
  );
}

function AssetGrid({ assets, onUpscale }: { assets: Asset[]; onUpscale: (id: number) => void }) {
  if (assets.length === 0) return null;
  const urls = assets.map((a) => a.url);
  return (
    <div className="grid grid-cols-2 desktop:grid-cols-3 gap-3">
      {assets.map((a, i) => <AssetTile key={a.id} a={a} groupUrls={urls} groupIndex={i} onUpscale={onUpscale} />)}
    </div>
  );
}

// 可折叠分组 (标题右侧可放操作, 如"下载全部")
function CollapsibleGroup({ title, count, defaultOpen, actions, children }: {
  title: string; count: number; defaultOpen: boolean; actions?: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-line">
      <div className="w-full flex items-center justify-between px-3 py-2 text-caption text-ink-secondary">
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 hover:opacity-80">
          <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          {title}
          <span className="text-micro text-muted-foreground">({count})</span>
        </button>
        <div className="flex items-center gap-2">
          {actions}
          <button onClick={() => setOpen((v) => !v)} className="text-micro text-muted-foreground hover:opacity-80">{open ? '收起' : '展开'}</button>
        </div>
      </div>
      {open && <div className="p-3 pt-0">{children}</div>}
    </div>
  );
}

function DownloadGroupBtn({ assets, prefix }: { assets: Asset[]; prefix: string }) {
  const [busy, setBusy] = useState(false);
  if (assets.length === 0) return null;
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadImages(assets.map((a, i) => ({ url: a.url, filename: `${prefix}-${a.id || i}.png` })));
        } finally { setBusy(false); }
      }}
      className="text-micro px-2 py-0.5 rounded border border-line hover:bg-white/[0.06] disabled:opacity-50"
      title="一键下载本组全部图片"
    >{busy ? '下载中…' : '下载全部'}</button>
  );
}

// 任务参数标签 (尺寸/比例/画质/工作流)
function ParamTags({ job, workflowNames }: { job: ImageJob; workflowNames?: Record<string, string> }) {
  const p = (job.params || {}) as Record<string, unknown>;
  const sizeStr = typeof p.size === 'string' ? p.size : undefined;
  const d = describeSize(sizeStr);
  const wf = typeof p.workflow === 'string' ? p.workflow : null;
  const tags: string[] = [];
  if (d) { tags.push(d.ratio, d.quality, d.px); }
  if (wf) tags.push(`工作流:${(workflowNames && workflowNames[wf]) || wf}`);
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mb-2">
      {tags.map((t, i) => (
        <span key={i} className="text-micro px-1.5 py-0.5 rounded bg-white/[0.06] text-ink-secondary border border-line">{t}</span>
      ))}
    </div>
  );
}

function ErrorBlock({ error }: { error: string }) {
  const c = classifyError(error);
  if (!c) return null;
  return (
    <div className="mb-3 text-caption">
      <span className="inline-block px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30 mr-2">{c.label}</span>
      <span className="text-red-400/90">{c.hint}</span>
    </div>
  );
}

function JobCard({ job, subJobs, onCancel, onRetry, onUpscale, onRegenerate, onDelete, onTweak, selected, toggleSelect, workflowNames }: {
  job: ImageJob; subJobs?: ImageJob[];
  onCancel: (id: number) => void; onRetry: (id: number) => void; onUpscale: (id: number) => void;
  onRegenerate: (id: number) => void; onDelete: (id: number) => void; onTweak: (job: ImageJob) => void;
  selected: boolean; toggleSelect: (id: number) => void;
  workflowNames?: Record<string, string>;
}) {
  const p = promptOf(job);
  const subs = subJobs || [];
  const hdAssets: Asset[] = subs.flatMap((c) => c.assets.filter((a) => a.kind === 'upscaled'));
  const hasHd = subs.length > 0;
  const hdReady = hdAssets.length > 0;

  return (
    <Card className={`p-4 ${selected ? 'ring-2 ring-primary' : ''}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="checkbox" checked={selected} onChange={() => toggleSelect(job.id)}
            className="w-4 h-4 rounded border-line accent-primary" title="选择 (批量操作)"
          />
          <span className="text-caption text-muted-foreground">#{job.id}</span>
          <Badge tone={mapStatus(job.status)}>{statusLabel(job.status)}</Badge>
          {job.kind === 'upscale' && <Badge tone="info">放大</Badge>}
          <span className="text-caption text-muted-foreground">{job.model}</span>
          <span className="text-micro text-muted-foreground">{elapsed(job)}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {isActive(job) && (
            <Button variant="ghost" className="h-7 px-2 text-caption" onClick={() => onCancel(job.id)}>取消</Button>
          )}
          {canRetry(job) && (
            <Button variant="outline" className="h-7 px-2 text-caption" onClick={() => onRetry(job.id)}>重试</Button>
          )}
          {!isActive(job) && (
            <Button variant="outline" className="h-7 px-2 text-caption" title="参数全不变重新生成为新任务" onClick={() => onRegenerate(job.id)}>重新生成</Button>
          )}
          {!isActive(job) && (
            <Button variant="ghost" className="h-7 px-2 text-caption" title="把该任务参数回填到左侧控制台微调" onClick={() => onTweak(job)}>微调</Button>
          )}
          {!isActive(job) && (
            <Button variant="ghost" className="h-7 px-2 text-caption text-red-400 hover:text-red-300" onClick={() => onDelete(job.id)}>删除</Button>
          )}
        </div>
      </div>

      <RefStrip urls={job.ref_urls || []} />
      <ParamTags job={job} workflowNames={workflowNames} />

      {p && <p className="text-caption text-muted-foreground mb-2 line-clamp-2">{p}</p>}

      {(() => {
        const op = (job.params as Record<string, unknown> | null)?.optimized_prompt;
        if (typeof op !== 'string' || !op.trim()) return null;
        return (
          <details className="mb-2 rounded-md border border-line bg-white/[0.03]">
            <summary className="cursor-pointer select-none px-2 py-1 text-micro text-ink-secondary">
              ✨ 已优化提示词（点击展开）
            </summary>
            <p className="px-2 pb-2 pt-1 text-caption text-muted-foreground whitespace-pre-wrap">{op}</p>
          </details>
        );
      })()}

      {isActive(job) && <Progress percent={job.progress} className="mb-3" />}
      {(job.status === 'failed' || job.status === 'interrupted' || job.status === 'canceled') && job.error && (
        <ErrorBlock error={job.error} />
      )}

      {job.assets.length > 0 && (
        <div className="space-y-3">
          <CollapsibleGroup
            title="原图组"
            count={job.assets.length}
            defaultOpen={!hdReady}
            actions={<DownloadGroupBtn assets={job.assets} prefix={`job${job.id}-orig`} />}
          >
            <AssetGrid assets={job.assets} onUpscale={onUpscale} />
          </CollapsibleGroup>

          {hasHd && (
            <CollapsibleGroup
              title="高清图组"
              count={hdAssets.length}
              defaultOpen={true}
              actions={<DownloadGroupBtn assets={hdAssets} prefix={`job${job.id}-hd`} />}
            >
              <div className="space-y-3">
                {subs.map((c) => (
                  <div key={c.id}>
                    <div className="flex items-center gap-2 mb-1">
                      <Badge tone="info">放大 #{c.id}</Badge>
                      <Badge tone={mapStatus(c.status)}>{statusLabel(c.status)}</Badge>
                      <span className="text-micro text-muted-foreground">{elapsed(c)}</span>
                      {isActive(c) && <Button variant="ghost" className="h-6 px-2 text-micro" onClick={() => onCancel(c.id)}>取消</Button>}
                      {canRetry(c) && <Button variant="outline" className="h-6 px-2 text-micro" onClick={() => onRetry(c.id)}>重试</Button>}
                    </div>
                    {isActive(c) && <Progress percent={c.progress} className="mb-2" />}
                    {c.error && (c.status === 'failed' || c.status === 'canceled') && (
                      <ErrorBlock error={c.error} />
                    )}
                    <AssetGrid assets={c.assets} onUpscale={onUpscale} />
                  </div>
                ))}
              </div>
            </CollapsibleGroup>
          )}
        </div>
      )}
    </Card>
  );
}

function ListRow({ job, onCancel, onRetry }: { job: ImageJob; onCancel: (id: number) => void; onRetry: (id: number) => void }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-line bg-white/[0.02]">
      <span className="text-caption text-muted-foreground w-12">#{job.id}</span>
      <Badge tone={mapStatus(job.status)}>{statusLabel(job.status)}</Badge>
      {job.kind === 'upscale' && <Badge tone="info">放大</Badge>}
      <div className="flex-1 min-w-0">
        {isActive(job) ? <Progress percent={job.progress} /> : <span className="text-caption text-muted-foreground truncate block">{promptOf(job) || job.model}</span>}
      </div>
      <span className="text-micro text-muted-foreground w-16 text-right">{elapsed(job)}</span>
      {isActive(job) && <Button variant="ghost" className="h-7 px-2 text-caption" onClick={() => onCancel(job.id)}>取消</Button>}
      {canRetry(job) && <Button variant="outline" className="h-7 px-2 text-caption" onClick={() => onRetry(job.id)}>重试</Button>}
    </div>
  );
}

export function TaskWorkspace(props: Props) {
  const {
    jobs, kpis, filter, setFilter, view, setView, loading,
    onCancel, onRetry, onUpscale, onRegenerate, onDelete, onTweak,
    selected, toggleSelect, onBatchRegenerate, onBatchDelete, clearSelect,
  } = props;
  const workflowNames: Record<string, string> = {};
  for (const w of (props.workflows || [])) workflowNames[w.id] = w.name;

  const childrenMap = new Map<number, ImageJob[]>();
  for (const j of jobs) {
    if (j.kind === 'upscale' && j.parent_job_id != null) {
      const arr = childrenMap.get(j.parent_job_id) || [];
      arr.push(j);
      childrenMap.set(j.parent_job_id, arr);
    }
  }
  const topLevel = jobs.filter((j) => !(j.kind === 'upscale' && j.parent_job_id != null));
  const filtered = topLevel.filter((j) => {
    if (inFilter(j, filter)) return true;
    const kids = childrenMap.get(j.id) || [];
    return kids.some((k) => inFilter(k, filter));
  });

  const filterItems = [
    { value: 'all', label: '全部' },
    { value: 'active', label: `进行中 ${kpis.active + kpis.pending}` },
    { value: 'done', label: '已完成' },
    { value: 'failed', label: `失败 ${kpis.failed}` },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Kpi label="进行中" value={kpis.active} tone="text-blue-400" />
        <Kpi label="排队" value={kpis.pending} tone="text-amber-400" />
        <Kpi label="今日完成" value={kpis.doneToday} tone="text-emerald-400" />
        <Kpi label="失败" value={kpis.failed} tone="text-red-400" />
        <div className="ml-auto flex items-center gap-1 rounded-md border border-line p-0.5">
          <button onClick={() => setView('grid')} className={`px-2 py-1 text-caption rounded ${view === 'grid' ? 'bg-white/[0.12] text-ink-primary' : 'text-muted-foreground'}`}>网格</button>
          <button onClick={() => setView('list')} className={`px-2 py-1 text-caption rounded ${view === 'list' ? 'bg-white/[0.12] text-ink-primary' : 'text-muted-foreground'}`}>列表</button>
        </div>
      </div>

      {/* 批量操作条 */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-md border border-primary/40 bg-primary/5">
          <span className="text-caption">已选 {selected.size} 个任务</span>
          <Button variant="outline" className="h-7 px-2 text-caption" onClick={onBatchRegenerate}>批量重新生成</Button>
          <Button variant="ghost" className="h-7 px-2 text-caption text-red-400 hover:text-red-300" onClick={onBatchDelete}>批量删除</Button>
          <button className="ml-auto text-micro text-muted-foreground hover:opacity-80" onClick={clearSelect}>取消选择</button>
        </div>
      )}

      <Tabs items={filterItems} value={filter} onChange={(v) => setFilter(v as StatusFilter)} />

      {loading && jobs.length === 0 ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title="没有匹配的任务" description="换个筛选条件，或在左侧发起新的生成" />
      ) : view === 'list' ? (
        <div className="space-y-2">
          {filtered.map((j) => (
            <React.Fragment key={j.id}>
              <ListRow job={j} onCancel={onCancel} onRetry={onRetry} />
              {(childrenMap.get(j.id) || []).map((c) => (
                <div key={c.id} className="ml-6"><ListRow job={c} onCancel={onCancel} onRetry={onRetry} /></div>
              ))}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((j) => (
            <JobCard
              key={j.id} job={j} subJobs={childrenMap.get(j.id)}
              onCancel={onCancel} onRetry={onRetry} onUpscale={onUpscale}
              onRegenerate={onRegenerate} onDelete={onDelete} onTweak={onTweak}
              selected={selected.has(j.id)} toggleSelect={toggleSelect} workflowNames={workflowNames}
            />
          ))}
        </div>
      )}
    </div>
  );
}