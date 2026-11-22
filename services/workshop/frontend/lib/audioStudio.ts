// 音频生成工作台 API 封装 (调度/接口向生图看齐)
import { authFetch } from './auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export type AudioAsset = {
  id: number;
  seq: number;
  fmt: string | null;
  url: string;
};

export type AudioJob = {
  id: number;
  provider: string;
  model: string | null;
  status: string; // pending|running|succeeded|failed|interrupted|canceled
  progress: number;
  error: string | null;
  text: string | null;
  ref_url: string | null;
  created_at: string | null;
  updated_at: string | null;
  assets: AudioAsset[];
};

export async function uploadRefAudio(file: File): Promise<{ oss_key: string; filename: string; url: string }> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await authFetch(`${BASE}/v1/audio-studio/upload-ref`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error((await r.text()) || '上传失败');
  return r.json();
}

export async function generateAudio(body: {
  text: string;
  ref_audio_oss_key: string;
  ref_audio_filename?: string;
}): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/audio-studio/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()) || '发起生成失败');
  return r.json();
}

export async function listAudioJobs(limit = 30): Promise<AudioJob[]> {
  const r = await authFetch(`${BASE}/v1/audio-studio/jobs?limit=${limit}`);
  if (!r.ok) return [];
  return r.json();
}

export async function cancelAudioJob(jobId: number): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/audio-studio/jobs/${jobId}/cancel`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '取消失败');
  return r.json();
}

export async function regenerateAudioJob(jobId: number): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/audio-studio/jobs/${jobId}/regenerate`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '重新生成失败');
  return r.json();
}

export async function deleteAudioJob(jobId: number): Promise<{ ok: boolean; deleted: number[] }> {
  const r = await authFetch(`${BASE}/v1/audio-studio/jobs/${jobId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.text()) || '删除失败');
  return r.json();
}

export async function getAudioConcurrency(): Promise<{ limit: number; running: number; pending: number }> {
  const r = await authFetch(`${BASE}/v1/audio-studio/concurrency`);
  if (!r.ok) throw new Error((await r.text()) || '获取并发信息失败');
  return r.json();
}

export function isAudioActive(j: AudioJob): boolean {
  return j.status === 'pending' || j.status === 'running';
}

export async function downloadAudio(url: string, filename: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const blob = await resp.blob();
  const a = document.createElement('a');
  const objUrl = URL.createObjectURL(blob);
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}