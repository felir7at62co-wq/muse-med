'use client';
import * as React from 'react';
import { authFetch } from '../../lib/auth';
import { UserNav } from '../_UserNav';
import { AppShell } from '@/components/layout/AppShell';
import { Card, Button } from '@/components/ui';
import { Eraser, Download } from 'lucide-react';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

type LegacyJob = { id: number; title: string; status: string; total: number; created_at: string | null };

/**
 * 去 AI 味工作室 —— 2026-10-30 起停用（用户裁定："这个页面很落后，根本就不该使用"）。
 *
 * 去 AI 味现在在剧本工作台的对话栏 / 交给 Agent 里发起，**直接改在草稿里**（或按用户要求
 * 改在副本里），每集先留历史，改了哪里用顶栏「看改动」看。不再出"独立清洗稿"。
 *
 * 本页只保留旧清洗稿的下载，免得用户以前跑出来的结果找不到；不再提供新的提交入口。
 */
export default function DeaiStudioRetired() {
  const [jobs, setJobs] = React.useState<LegacyJob[]>([]);

  React.useEffect(() => {
    (async () => {
      try {
        const r = await authFetch(`${BASE}/v1/deai`);
        if (r.ok) setJobs(((await r.json()).items || []).filter((j: LegacyJob) => j.status === 'done'));
      } catch { /* 拿不到旧记录不影响主流程 */ }
    })();
  }, []);

  async function download(job: LegacyJob) {
    const r = await authFetch(`${BASE}/v1/deai/${job.id}/download`);
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${job.title || 'deai'}-去AI味.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <AppShell
      topBar={{
        left: (
          <h1 className="text-section-title text-ink-primary flex items-center gap-2">
            <Eraser className="w-5 h-5 text-primary" /> 去 AI 味
          </h1>
        ),
        right: <UserNav />,
      }}
    >
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <Card className="p-5 space-y-2 text-sm text-ink-primary">
          <p className="font-semibold">去 AI 味已经搬到剧本工作台里了</p>
          <p>打开要处理的剧，在右侧对话栏说「去 AI 味」，或交给 Agent。它会直接改在这部剧里，
            每集改之前都会存历史版本；改完点顶部任务栏的「看改动」逐集对照，不满意的集可以在历史里恢复。</p>
          <p>想保留原稿，就说「去 AI 味，建个副本」—— 会复制出一部新剧，改在副本里。</p>
        </Card>
        {jobs.length > 0 && (
          <Card className="p-5">
            <p className="text-sm font-semibold mb-3 text-ink-primary">以前生成的清洗稿（仅供下载）</p>
            <div className="divide-y divide-line">
              {jobs.map((j) => (
                <div key={j.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="flex-1 truncate text-ink-primary">{j.title}</span>
                  <span className="text-xs text-ink-muted">
                    {j.total} 集 · {j.created_at ? j.created_at.slice(0, 10) : ''}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => download(j)}>
                    <Download className="w-3.5 h-3.5 mr-1" />下载
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
