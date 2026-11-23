import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import type { ScriptArtifact } from '../shared/types';
import { authenticatedFetch, captureRequestIdentity, request } from './api';

type Notify = (message: string, error?: boolean) => void;

/** Downloads verified file bytes before recording the successful retrieval in the user's shelf. */
export async function downloadAndShelve(script: ScriptArtifact): Promise<{ shelved: boolean; message: string }> {
  const checkIdentity = captureRequestIdentity();
  const response = await authenticatedFetch(`/api/scripts/${encodeURIComponent(script.id)}/download`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`剧本下载失败（${response.status}），没有加入书架`);
  const blob = await response.blob();
  if (blob.size !== script.byteLength) throw new Error('剧本文件大小校验失败，没有加入书架');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== script.sha256.toLowerCase()) throw new Error('剧本文件校验失败，没有加入书架');
  checkIdentity();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = script.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  try {
    await request('/api/bookshelf', { method: 'POST', body: JSON.stringify({ scriptId: script.id }) });
    return { shelved: true, message: '剧本已下载并加入书架' };
  } catch (error) {
    return { shelved: false, message: `文件已下载，但书架记录未保存：${error instanceof Error ? error.message : '请稍后重试'}` };
  }
}

export function ScriptDownload({ script, notify, onChanged, label = '下载剧本', pending = false }: {
  script?: ScriptArtifact | null; notify: Notify; onChanged: () => void; label?: string; pending?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (!script) return;
    setBusy(true);
    try {
      const result = await downloadAndShelve(script);
      notify(result.message, !result.shelved);
      if (result.shelved) onChanged();
    } catch (error) { notify(error instanceof Error ? error.message : '下载失败', true); }
    finally { setBusy(false); }
  };
  return <button className={`button script-download ${script ? 'button-soft' : 'script-unavailable'}`} data-testid="script-download" disabled={pending || !script || busy} onClick={() => void download()} title={pending ? '连接后核对当前剧本文件状态' : script?.fileName || '尚未关联真实剧本文件'}>{busy ? <LoaderCircle className="spin" size={14} /> : script ? <Download size={14} /> : null}{pending ? '剧本待核对' : busy ? '下载中…' : script ? label : '暂无剧本'}</button>;
}
