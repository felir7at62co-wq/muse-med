'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Drawer';
import { useToast } from '@/components/ui/Toast';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  IMAGE_MODELS, TEXT_ONLY_MODELS, REF_PROCESS_MODEL, MAX_REF_IMAGES, resolveSize, describeSize,
  type ImageJob, type Preset, type Workflow,
  generate, listJobs, listPresets, uploadRef, upscale,
  cancelJob, retryJob, regenerateJob, deleteJob, getConcurrency, listWorkflows,
} from '@/lib/imageStudio';
import { ConsoleSidebar, type RefImage } from './_ConsoleSidebar';
import { TaskWorkspace, type ViewMode } from './_TaskWorkspace';
import { computeKpis, type StatusFilter, isActive } from './_helpers';
import { LightboxProvider } from './_imageExtras';

export default function ImageStudioPage() {
  const toast = useToast();
  const isMobile = useIsMobile();

  // 控制台表单态
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetId, setPresetId] = useState<number | null>(null);
  const [model, setModel] = useState<string>(IMAGE_MODELS[0].value);
  const [aspect, setAspect] = useState<string>('1:1');
  const [quality, setQuality] = useState<string>('2K');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [n, setN] = useState<number>(1);
  const [prompt, setPrompt] = useState('');
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [autoHd, setAutoHd] = useState(true);
  const [optimizePrompt, setOptimizePrompt] = useState(false);
  const [autoPolish, setAutoPolish] = useState(false);

  // 工作区态
  const [jobs, setJobs] = useState<ImageJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [view, setView] = useState<ViewMode>('grid');
  const [concurrency, setConcurrency] = useState<{ limit: number; running: number; pending: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const PAGE_SIZE = 50;

  const refresh = useCallback(async () => {
    try {
      const [js, conc] = await Promise.all([listJobs(PAGE_SIZE), getConcurrency().catch(() => null)]);
      setJobs(js);
      setConcurrency(conc);
      if (js.length >= PAGE_SIZE) setHasMore(true);
      return js;
    } catch {
      return [] as ImageJob[];
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载更多: 以当前已加载数为 offset 往后翻一页, 追加去重
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const more = await listJobs(PAGE_SIZE, jobs.length);
      if (more.length > 0) {
        setJobs((prev) => {
          const seen = new Set(prev.map((j) => j.id));
          return [...prev, ...more.filter((m) => !seen.has(m.id))];
        });
      }
      if (more.length < PAGE_SIZE) setHasMore(false);
    } catch { /* 保留已加载 */ }
    finally { setLoadingMore(false); }
  }, [jobs.length]);

  const ensurePolling = useCallback((js: ImageJob[]) => {
    const anyActive = js.some(isActive);
    if (anyActive && !timerRef.current) {
      timerRef.current = setInterval(async () => {
        const next = await refresh();
        if (!next.some(isActive) && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }, 3000);
    } else if (!anyActive && timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [refresh]);

  useEffect(() => {
    listPresets().then(setPresets).catch(() => {});
    listWorkflows().then(setWorkflows).catch(() => {});
    refresh().then(ensurePolling);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [refresh, ensurePolling]);

  useEffect(() => {
    const wf = workflows.find((w) => w.id === workflowId);
    if (wf?.default_quality) setQuality(wf.default_quality);
  }, [workflowId, workflows]);

  useEffect(() => { ensurePolling(jobs); }, [jobs, ensurePolling]);

  // ── 参考图 ──────────────────────────────────────────────
  const onPickFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files) return;
    const list = Array.from(files as ArrayLike<File>);
    if (list.length === 0) return;
    setRefs((prev) => {
      const room = MAX_REF_IMAGES - prev.length;
      if (room <= 0) { toast.error(`最多 ${MAX_REF_IMAGES} 张参考图`); return prev; }
      return prev;
    });
    const room = MAX_REF_IMAGES - refs.length;
    for (const f of list.slice(0, Math.max(0, room))) {
      const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      setRefs((prev) => [...prev, { oss_key: '', url: '', uploading: true, tmpId }]);
      try {
        const res = await uploadRef(f);
        setRefs((prev) => prev.map((r) => (r.tmpId === tmpId ? { ...r, oss_key: res.oss_key, url: res.url, uploading: false } : r)));
      } catch (e) {
        setRefs((prev) => prev.filter((r) => r.tmpId !== tmpId));
        toast.error(`参考图上传失败: ${(e as Error).message}`);
      }
    }
  }, [refs.length, toast]);
  const removeRef = (tmpId: string) => setRefs((prev) => prev.filter((r) => r.tmpId !== tmpId));
  const setRefLabel = (tmpId: string, label: string) =>
    setRefs((prev) => prev.map((r) => (r.tmpId === tmpId ? { ...r, label } : r)));

  // 粘贴 (Ctrl+V) 添加参考图
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgs: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) imgs.push(f);
        }
      }
      if (imgs.length > 0) { e.preventDefault(); onPickFiles(imgs); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onPickFiles]);

    const isRefProcess = model === REF_PROCESS_MODEL;
  const onSubmit = async () => {
    if (refs.some((r) => r.uploading)) { toast.error('参考图还在上传中，请稍候'); return; }
    // 参考图处理: 必须有上传图 + 至少勾选 高清/润色 之一
    if (isRefProcess) {
      const ready = refs.filter((r) => r.oss_key);
      if (ready.length === 0) { toast.error('参考图处理需要至少上传 1 张图'); return; }
      if (!autoHd && !autoPolish) { toast.error('请至少勾选 高清 或 图片润色'); return; }
    } else if (!prompt.trim() && refs.length === 0) {
      toast.error('请填写提示词或上传参考图'); return;
    }
    setSubmitting(true);
    try {
      const wf = workflows.find((w) => w.id === workflowId);
      const effAspect = wf?.force_aspect || aspect;
      const effSize = resolveSize(effAspect, quality);
      // 纯文生图模型(人像专用): 不带参考图/提示词优化/图片润色 (与置灰一致, 仅高清保留)
      const textOnly = TEXT_ONLY_MODELS.has(model);
      // 参考图处理: 带上传图 + 高清/润色; 工作流/数量/比例/画质 全部不传(后端忽略);
      //   提示词仅勾选润色时由后端拼到 #146
      if (isRefProcess) {
        const ready = refs.filter((r) => r.oss_key);
        await generate({
          model, prompt: prompt.trim(), n: 1, size: effSize, preset_id: null,
          ref_image_keys: ready.map((r) => r.oss_key),
          auto_hd: autoHd, auto_polish: autoPolish,
          optimize_prompt: false, workflow: null,
        });
        toast.success('已提交，后台逐张处理');
        const js2 = await refresh();
        ensurePolling(js2);
        if (isMobile) setDrawerOpen(false);
        return;
      }
      const readyRefs = textOnly ? [] : refs.filter((r) => r.oss_key);
      await generate({
        model, prompt: prompt.trim(), n, size: effSize, preset_id: presetId,
        ref_image_keys: readyRefs.map((r) => r.oss_key),
        ref_labels: readyRefs.map((r) => (r.label || '').trim()),
        auto_hd: autoHd, workflow: workflowId,
        optimize_prompt: textOnly ? false : optimizePrompt,
        auto_polish: textOnly ? false : autoPolish,
      });
      toast.success('已提交，后台自动调度');
      // 保留控制台内容(工作流/模型/参考图/提示词等), 便于用户小改后继续生成
      const js = await refresh();
      ensurePolling(js);
      if (isMobile) setDrawerOpen(false);
    } catch (e) {
      toast.error(`提交失败: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // ── 工作区操作 ──────────────────────────────────────────
  const onCancel = async (id: number) => {
    try { await cancelJob(id); toast.success(`已取消 #${id}`); const js = await refresh(); ensurePolling(js); }
    catch (e) { toast.error(`取消失败: ${(e as Error).message}`); }
  };
  const onRetry = async (id: number) => {
    try { const r = await retryJob(id); toast.success(`已重试，新任务 #${r.job_id}`); const js = await refresh(); ensurePolling(js); }
    catch (e) { toast.error(`重试失败: ${(e as Error).message}`); }
  };
  const onUpscale = async (assetId: number) => {
    try { const r = await upscale(assetId); toast.success(`已提交高清放大，任务 #${r.job_id}`); const js = await refresh(); ensurePolling(js); }
    catch (e) { toast.error(`高清放大失败: ${(e as Error).message}`); }
  };
  const onRegenerate = async (id: number) => {
    try { const r = await regenerateJob(id); toast.success(`已重新生成，新任务 #${r.job_id}`); const js = await refresh(); ensurePolling(js); }
    catch (e) { toast.error(`重新生成失败: ${(e as Error).message}`); }
  };
  const onDelete = async (id: number) => {
    if (!window.confirm(`确认删除任务 #${id}？其产出图记录将一并移除。`)) return;
    try { await deleteJob(id); toast.success(`已删除 #${id}`); setSelected((s) => { const n = new Set(s); n.delete(id); return n; }); await refresh(); }
    catch (e) { toast.error(`删除失败: ${(e as Error).message}`); }
  };
  // 微调: 把任务参数完整回填控制台 (含参考图/标注/工作流)
  const onTweak = (job: ImageJob) => {
    const p = (job.params || {}) as Record<string, unknown>;
    if (typeof p.prompt === 'string') setPrompt(p.prompt);
    if (job.model) setModel(job.model);
    if (typeof p.n === 'number') setN(Math.max(1, Math.min(4, p.n)));
    const d = describeSize(typeof p.size === 'string' ? p.size : undefined);
    if (d) { setAspect(d.ratio); setQuality(d.quality); }
    if (typeof p.workflow === 'string') setWorkflowId(p.workflow);
    else setWorkflowId(null);
    if (typeof p.preset_id === 'number') setPresetId(p.preset_id);
    else setPresetId(null);
    if (typeof p.auto_hd === 'boolean') setAutoHd(p.auto_hd);
    if (typeof p.auto_polish === 'boolean') setAutoPolish(p.auto_polish);
    // 回填参考图: oss_key(用于重新提交) + 已签名 url(用于预览) + label(标注)
    const keys = (p.ref_image_keys as string[] | undefined) || [];
    const labels = (p.ref_labels as string[] | undefined) || [];
    const urls = job.ref_urls || [];
    if (keys.length > 0) {
      const restored: RefImage[] = keys.map((k, i) => ({
        oss_key: k,
        url: urls[i] || '',
        label: labels[i] || '',
        tmpId: `tweak_${job.id}_${i}_${Math.random().toString(36).slice(2)}`,
      }));
      setRefs(restored);
    } else {
      setRefs([]);
    }
    toast.info('参数已回填到控制台，可调整后再生成。');
    if (isMobile) setDrawerOpen(true);
  };

  // ── 批量 ────────────────────────────────────────────────
  const toggleSelect = (id: number) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const clearSelect = () => setSelected(new Set());
  const onBatchRegenerate = async () => {
    const ids = Array.from(selected);
    let ok = 0;
    for (const id of ids) {
      try { await regenerateJob(id); ok++; } catch { /* 跳过 */ }
    }
    toast.success(`已批量重新生成 ${ok}/${ids.length} 个任务`);
    clearSelect();
    const js = await refresh(); ensurePolling(js);
  };
  const onBatchDelete = async () => {
    const ids = Array.from(selected);
    if (!window.confirm(`确认批量删除 ${ids.length} 个任务？此操作不可恢复。`)) return;
    let ok = 0;
    for (const id of ids) {
      try { await deleteJob(id); ok++; } catch { /* 跳过 */ }
    }
    toast.success(`已批量删除 ${ok}/${ids.length} 个任务`);
    clearSelect();
    await refresh();
  };

  const kpis = useMemo(() => computeKpis(jobs), [jobs]);

  const consoleNode = (
    <ConsoleSidebar
      state={{ presets, presetId, model, aspect, quality, n, prompt, refs, submitting, concurrency, autoHd, optimizePrompt, autoPolish, workflows, workflowId }}
      on={{ setPresetId, setModel, setAspect, setQuality, setN, setPrompt, onPickFiles, removeRef, setRefLabel, onSubmit, setAutoHd, setOptimizePrompt, setAutoPolish, setWorkflowId }}
    />
  );

  const workspaceProps = {
    jobs, kpis, filter, setFilter, view, setView, loading,
    onCancel, onRetry, onUpscale, onRegenerate, onDelete, onTweak,
    selected, toggleSelect, onBatchRegenerate, onBatchDelete, clearSelect, workflows,
  };

  return (
    <LightboxProvider>
      <AppShell fluid>
        <div className="w-full">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-title font-semibold">生图工作台</h1>
              <p className="text-caption text-muted-foreground mt-1">多任务并发生成与调度，产出保留 30 天。</p>
            </div>
            {isMobile && (
              <Button onClick={() => setDrawerOpen(true)}>新建生成</Button>
            )}
          </div>

          {isMobile ? (
            <>
              <TaskWorkspace {...workspaceProps} />
              <LoadMoreBar
                hasMore={hasMore}
                loading={loadingMore}
                count={jobs.length}
                onClick={loadMore}
              />
              <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} side="bottom" title="创作控制台">
                <div className="p-4 max-h-[80vh] overflow-y-auto">{consoleNode}</div>
              </Drawer>
            </>
          ) : (
            <div className="grid grid-cols-[440px_1fr] gap-6 items-start">
              <div className="sticky top-4 rounded-lg border border-line bg-white/[0.02] p-4">
                {consoleNode}
              </div>
              <div>
                <TaskWorkspace {...workspaceProps} />
                <LoadMoreBar
                  hasMore={hasMore}
                loading={loadingMore}
                  count={jobs.length}
                  onClick={loadMore}
                />
              </div>
            </div>
          )}
        </div>
      </AppShell>
    </LightboxProvider>
  );
}

/** 任务列表底部"加载更多"。已加载全部时显示提示, 避免用户以为旧任务丢失。 */
function LoadMoreBar({
  hasMore,
  loading,
  count,
  onClick,
}: {
  hasMore: boolean;
  loading: boolean;
  count: number;
  onClick: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1 py-6">
      {hasMore ? (
        <Button variant="secondary" onClick={onClick} loading={loading}>
          {loading ? '加载中…' : '加载更多历史任务'}
        </Button>
      ) : (
        <p className="text-caption text-muted-foreground">已加载全部 {count} 个任务</p>
      )}
    </div>
  );
}
