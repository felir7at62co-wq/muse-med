'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Drawer } from '@/components/ui/Drawer';
import { useToast } from '@/components/ui/Toast';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { Loader2, Upload, Mic, Download, RefreshCw, X, Trash2 } from 'lucide-react';
import {
  type AudioJob,
  uploadRefAudio, generateAudio, listAudioJobs,
  cancelAudioJob, regenerateAudioJob, deleteAudioJob,
  getAudioConcurrency, isAudioActive, downloadAudio,
} from '@/lib/audioStudio';

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中', running: '生成中', succeeded: '已完成',
  failed: '失败', interrupted: '已中断', canceled: '已取消',
};
const STATUS_TONE: Record<string, string> = {
  pending: 'text-info', running: 'text-warning', succeeded: 'text-success',
  failed: 'text-danger', interrupted: 'text-ink-muted', canceled: 'text-ink-muted',
};

export default function AudioStudioPage() {
  const toast = useToast();
  const isMobile = useIsMobile();

  // 控制台态
  const [text, setText] = useState('');
  const [refKey, setRefKey] = useState('');
  const [refName, setRefName] = useState('');
  const [refUrl, setRefUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 工作区态
  const [jobs, setJobs] = useState<AudioJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [concurrency, setConcurrency] = useState<{ limit: number; running: number; pending: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [js, conc] = await Promise.all([listAudioJobs(50), getAudioConcurrency().catch(() => null)]);
      setJobs(js);
      setConcurrency(conc);
      return js;
    } catch {
      return [] as AudioJob[];
    } finally {
      setLoading(false);
    }
  }, []);

  const ensurePolling = useCallback((js: AudioJob[]) => {
    const anyActive = js.some(isAudioActive);
    if (anyActive && !timerRef.current) {
      timerRef.current = setInterval(async () => {
        const next = await refresh();
        if (!next.some(isAudioActive) && timerRef.current) {
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
    refresh().then(ensurePolling);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [refresh, ensurePolling]);

  useEffect(() => { ensurePolling(jobs); }, [jobs, ensurePolling]);

  const onPickFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadRefAudio(file);
      setRefKey(res.oss_key);
      setRefName(res.filename);
      setRefUrl(res.url);
      toast.success('参考音色已上传');
    } catch (e) {
      toast.error(`参考音色上传失败: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, [toast]);

  const onSubmit = async () => {
    if (!text.trim()) { toast.error('请填写要合成的文本'); return; }
    if (!refKey) { toast.error('请先上传参考音色音频'); return; }
    setSubmitting(true);
    try {
      await generateAudio({ text: text.trim(), ref_audio_oss_key: refKey, ref_audio_filename: refName || 'ref.flac' });
      toast.success('已提交，后台自动调度');
      const js = await refresh();
      ensurePolling(js);
      if (isMobile) setDrawerOpen(false);
    } catch (e) {
      toast.error(`提交失败: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const onCancel = async (id: number) => {
    try { await cancelAudioJob(id); toast.success(`已取消 #${id}`); const js = await refresh(); ensurePolling(js); }
    catch (e) { toast.error(`取消失败: ${(e as Error).message}`); }
  };
  const onRegenerate = async (id: number) => {
    try { const r = await regenerateAudioJob(id); toast.success(`已重新生成，新任务 #${r.job_id}`); const js = await refresh(); ensurePolling(js); }
    catch (e) { toast.error(`重新生成失败: ${(e as Error).message}`); }
  };
  const onDelete = async (id: number) => {
    if (!window.confirm(`确认删除任务 #${id}？其产出音频记录将一并移除。`)) return;
    try { await deleteAudioJob(id); toast.success(`已删除 #${id}`); await refresh(); }
    catch (e) { toast.error(`删除失败: ${(e as Error).message}`); }
  };

  const consoleNode = (
    <div className="space-y-4">
      <div>
        <label className="block text-caption text-ink-secondary mb-1.5">参考音色 (上传一段目标音色的音频)</label>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.flac,.wav,.mp3,.m4a"
          className="hidden"
          onChange={(e) => onPickFile(e.target.files?.[0] || null)}
        />
        <Button
          variant="secondary"
          size="md"
          className="w-full"
          loading={uploading}
          leftIcon={!uploading ? <Upload className="w-4 h-4" /> : undefined}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? '上传中…' : refKey ? '重新上传音色' : '上传参考音色'}
        </Button>
        {refUrl && (
          <div className="mt-2 space-y-1">
            <div className="text-caption text-ink-muted truncate">{refName}</div>
            <audio controls src={refUrl} className="w-full h-9" />
          </div>
        )}
      </div>

      <div>
        <label className="block text-caption text-ink-secondary mb-1.5">合成文本</label>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          placeholder="输入要用该音色朗读的文本，支持多行。换行处会自然停顿。"
        />
        <div className="text-caption text-ink-muted mt-1 text-right">{text.length} 字</div>
      </div>

      <Button
        variant="primary"
        size="lg"
        className="w-full"
        loading={submitting}
        leftIcon={!submitting ? <Mic className="w-4 h-4" /> : undefined}
        onClick={onSubmit}
        disabled={!refKey || !text.trim()}
      >
        {submitting ? '提交中…' : '🎙️ 生成音频'}
      </Button>

      {concurrency && (
        <div className="text-caption text-ink-muted text-center">
          并发上限 {concurrency.limit}（与生图共享）· 你的运行中 {concurrency.running} / 排队 {concurrency.pending}
        </div>
      )}
    </div>
  );

  const workspaceNode = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-card-title font-semibold text-ink-primary">生成任务</h2>
        <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => refresh()}>
          刷新
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-ink-muted">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-ink-muted">
          <Mic className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p>还没有音频任务。上传参考音色 + 输入文本，点「生成音频」开始。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const active = isAudioActive(job);
            return (
              <div key={job.id} className="rounded-lg border border-line bg-surface-base/60 p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-ink-primary">#{job.id}</span>
                      <span className={`text-caption ${STATUS_TONE[job.status] || 'text-ink-muted'} flex items-center gap-1`}>
                        {active && <Loader2 className="w-3 h-3 animate-spin" />}
                        {STATUS_LABEL[job.status] || job.status}
                      </span>
                      <span className="text-caption text-ink-muted">{job.model}</span>
                    </div>
                    {job.text && (
                      <p className="text-caption text-ink-secondary mt-1 line-clamp-2">{job.text}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {active && (
                      <Button variant="ghost" size="sm" leftIcon={<X className="w-3.5 h-3.5" />} onClick={() => onCancel(job.id)}>
                        取消
                      </Button>
                    )}
                    {!active && (
                      <Button variant="ghost" size="sm" leftIcon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => onRegenerate(job.id)}>
                        重新生成
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" leftIcon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => onDelete(job.id)}>
                      删除
                    </Button>
                  </div>
                </div>

                {active && (
                  <div className="h-1.5 bg-surface-overlay rounded-full overflow-hidden mb-2">
                    <div className="h-full bg-gradient-to-r from-primary to-cyan transition-all" style={{ width: `${job.progress || 0}%` }} />
                  </div>
                )}

                {job.error && job.status === 'failed' && (
                  <div className="text-caption text-danger bg-danger/10 border border-danger/30 rounded p-2 mb-2">{job.error}</div>
                )}

                {job.ref_url && (
                  <div className="mb-2">
                    <div className="text-caption text-ink-muted mb-0.5">参考音色</div>
                    <audio controls src={job.ref_url} className="w-full h-9" />
                  </div>
                )}

                {job.assets.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-caption text-ink-muted">产出音频</div>
                    {job.assets.map((a) => (
                      <div key={a.id} className="flex items-center gap-2">
                        <audio controls src={a.url} className="flex-1 h-9" />
                        <Button
                          variant="ghost" size="sm" leftIcon={<Download className="w-3.5 h-3.5" />}
                          onClick={() => downloadAudio(a.url, `audio_${job.id}_${a.seq}.${a.fmt || 'flac'}`)}
                        >
                          下载
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <AppShell fluid>
      <div className="w-full">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-title font-semibold">音频生成</h1>
            <p className="text-caption text-muted-foreground mt-1">语音克隆 TTS：上传参考音色 + 文本，合成同音色配音。产出保留 30 天。</p>
          </div>
          {isMobile && <Button onClick={() => setDrawerOpen(true)}>新建生成</Button>}
        </div>

        {isMobile ? (
          <>
            {workspaceNode}
            <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} side="bottom" title="音频控制台">
              <div className="p-4 max-h-[80vh] overflow-y-auto">{consoleNode}</div>
            </Drawer>
          </>
        ) : (
          <div className="grid grid-cols-[440px_1fr] gap-6 items-start">
            <div className="sticky top-4 rounded-lg border border-line bg-white/[0.02] p-4">
              {consoleNode}
            </div>
            {workspaceNode}
          </div>
        )}
      </div>
    </AppShell>
  );
}