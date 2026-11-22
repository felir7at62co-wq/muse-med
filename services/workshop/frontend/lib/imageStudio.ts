// 生图工作台 API 封装
import { authFetch } from './auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export const IMAGE_MODELS = [
  { value: 'gpt-image-2', label: 'Image2 (GPT)' },
  { value: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (Gemini)' },
  { value: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Gemini)' },
  // 2026-09-11 接入, zx1 单渠道。支持参考图; 尺寸只近似遵守 (1024 方图会返回 1254)。
  { value: 'image2.5flare', label: 'image2.5flare' },
  { value: 'image2.5sunburst', label: 'image2.5sunburst' },
  { value: 'rh-portrait-t2i', label: '人像专用' },
  { value: 'ref-process', label: '参考图处理' },
] as const;

// 纯文生图模型: 不支持参考图/提示词优化/图片润色 (前端置灰这些选项, 仅高清可用)
export const TEXT_ONLY_MODELS = new Set<string>(['rh-portrait-t2i']);

// 参考图处理模型: 不生图, 直接对上传图各自走 高清/润色。
// 工作流/数量/比例/画质 全部失效(置灰); 参考图必填; 提示词仅勾选润色时生效。
export const REF_PROCESS_MODEL = 'ref-process';

// 全部 10 个实测可用的比例 (2026-08-15 双渠道实拍验证: gpt-image-2-c 与
// Nano Banana 系在两条渠道上均精确遵守, 偏差 <2%)
export const IMAGE_ASPECTS = [
  { value: '1:1', label: '1:1 方形' },
  { value: '9:16', label: '9:16 竖屏' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '2:3', label: '2:3 竖版' },
  { value: '3:2', label: '3:2 横版' },
  { value: '3:4', label: '3:4 竖版' },
  { value: '4:3', label: '4:3 横版' },
  { value: '4:5', label: '4:5 竖版' },
  { value: '5:4', label: '5:4 横版' },
  { value: '21:9', label: '21:9 超宽' },
] as const;

export const IMAGE_QUALITIES = [
  { value: '1K', label: '1K 标清' },
  { value: '2K', label: '2K 高清' },
  { value: '4K', label: '4K 超清' },
] as const;

const _RATIO: Record<string, [number, number]> = {
  '1:1': [1, 1], '9:16': [9, 16], '16:9': [16, 9],
  '2:3': [2, 3], '3:2': [3, 2], '3:4': [3, 4], '4:3': [4, 3],
  '4:5': [4, 5], '5:4': [5, 4], '21:9': [21, 9],
};
// 画质档位长边锚点。必须与后端 workflows.QUALITY_LONG_EDGE 及
// providers._size_to_image_size_tier 的阈值同口径。
// ⚠ 2026-08-15 修正: 原为 {1K:1920, 2K:2560, 4K:3840}, 会让"选 1K"的请求长边
//   1920 落进后端 2K 档、"选 2K"的 2560 落进 4K 档 —— 用户选低档却按高档出图付费。
const _LONG: Record<string, number> = { '1K': 1024, '2K': 2048, '4K': 3840 };

// 比例 + 画质 -> 像素 size 字符串 (与后端 workflows.resolve_size 对齐)
export function resolveSize(aspect: string, quality: string): string {
  const [wr, hr] = _RATIO[aspect] || [1, 1];
  const long = _LONG[quality] || 1024;
  let w: number, h: number;
  if (wr >= hr) { w = long; h = Math.round(long * hr / wr); }
  else { h = long; w = Math.round(long * wr / hr); }
  w = Math.max(64, Math.floor(w / 8) * 8);
  h = Math.max(64, Math.floor(h / 8) * 8);
  return `${w}x${h}`;
}

export type Workflow = {
  id: string;
  name: string;
  desc: string;
  force_aspect: string | null;
  default_quality: string | null;
};

export async function listWorkflows(): Promise<Workflow[]> {
  const r = await authFetch(`${BASE}/v1/image-studio/workflows`);
  if (!r.ok) return [];
  return (await r.json()).workflows || [];
}

export const MAX_REF_IMAGES = 9;

export type Preset = {
  id: number;
  name: string;
  category: string | null;
  prefix_text: string;
  negative_text: string | null;
};

export type ImageAsset = {
  id: number;
  seq: number;
  width: number | null;
  height: number | null;
  kind: string;
  url: string;
};

export type ImageJob = {
  id: number;
  kind: string;
  model: string | null;
  status: string; // pending|running|succeeded|failed|interrupted
  progress: number;
  error: string | null;
  params: Record<string, unknown> | null;
  ref_urls?: string[]; // 该任务用到的参考图签名预览 URL (后端从 params.ref_image_keys 生成)
  parent_job_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  assets: ImageAsset[];
};

export async function listPresets(): Promise<Preset[]> {
  const r = await authFetch(`${BASE}/v1/image-studio/presets`);
  if (!r.ok) return [];
  return r.json();
}

export async function uploadRef(file: File): Promise<{ oss_key: string; url: string }> {
  const fd = new FormData();
  fd.append('file', file);
  const r = await authFetch(`${BASE}/v1/image-studio/upload-ref`, {
    method: 'POST',
    body: fd,
  });
  if (!r.ok) throw new Error((await r.text()) || '上传失败');
  return r.json();
}

export async function generate(body: {
  auto_hd?: boolean;
  workflow?: string | null;
  model: string;
  prompt: string;
  n: number;
  size: string;
  preset_id?: number | null;
  ref_image_keys?: string[];
  ref_labels?: string[];
  optimize_prompt?: boolean;
  auto_polish?: boolean;
}): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/image-studio/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()) || '发起生成失败');
  return r.json();
}

export async function getJob(id: number): Promise<ImageJob> {
  const r = await authFetch(`${BASE}/v1/image-studio/jobs/${id}`);
  if (!r.ok) throw new Error('查询任务失败');
  return r.json();
}

export async function listJobs(limit = 30, offset = 0): Promise<ImageJob[]> {
  const r = await authFetch(`${BASE}/v1/image-studio/jobs?limit=${limit}&offset=${offset}`);
  if (!r.ok) return [];
  return r.json();
}

export async function upscale(assetId: number): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/image-studio/assets/${assetId}/upscale`, {
    method: 'POST',
  });
  if (!r.ok) throw new Error((await r.text()) || '发起高清放大失败');
  return r.json();
}

export async function cancelJob(jobId: number): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/image-studio/jobs/${jobId}/cancel`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '取消失败');
  return r.json();
}

export async function retryJob(jobId: number): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/image-studio/jobs/${jobId}/retry`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '重试失败');
  return r.json();
}

export async function regenerateJob(jobId: number): Promise<{ job_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/image-studio/jobs/${jobId}/regenerate`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '重新生成失败');
  return r.json();
}

export async function deleteJob(jobId: number): Promise<{ ok: boolean; deleted: number[] }> {
  const r = await authFetch(`${BASE}/v1/image-studio/jobs/${jobId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.text()) || '删除失败');
  return r.json();
}

export async function getConcurrency(): Promise<{ limit: number; running: number; pending: number }> {
  const r = await authFetch(`${BASE}/v1/image-studio/concurrency`);
  if (!r.ok) throw new Error((await r.text()) || '获取并发信息失败');
  return r.json();
}

// ── 下载工具 ─────────────────────────────────────────────
// 通过 fetch blob 强制下载 (而非新标签打开), 保留扩展名
export async function downloadImage(url: string, filename: string): Promise<void> {
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

// 批量下载一组图片 (顺序触发, 间隔避免浏览器拦截)
export async function downloadImages(items: { url: string; filename: string }[]): Promise<void> {
  for (const it of items) {
    try {
      await downloadImage(it.url, it.filename);
    } catch {
      // 单张失败不阻断其余
    }
    await new Promise((res) => setTimeout(res, 300));
  }
}

// ── size 反解 (像素 -> 比例/画质 标签) ───────────────────
function _gcd(a: number, b: number): number { return b ? _gcd(b, a % b) : a; }

export function describeSize(size?: string | null): { ratio: string; quality: string; px: string } | null {
  if (!size) return null;
  const m = /^(\d+)x(\d+)$/i.exec(String(size).trim());
  if (!m) return null;
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  if (!w || !h) return null;
  const g = _gcd(w, h) || 1;
  const ratio = `${w / g}:${h / g}`;
  const long = Math.max(w, h);
  // 与 _LONG 锚点 (1024/2048/3840) 对齐, 阈值取相邻锚点中点
  const quality = long >= 2944 ? '4K' : long >= 1536 ? '2K' : '1K';
  return { ratio, quality, px: `${w}×${h}` };
}

// ── 失败错误友好归类 ─────────────────────────────────────
export function classifyError(error?: string | null): { label: string; hint: string } | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (/(rate.?limit|429|too many|quota|qps|频率|限流)/.test(e)) {
    return { label: '限流/超额', hint: '请求过于频繁或额度用尽，稍后重试。' };
  }
  if (/(safety|content|policy|blocked|敏感|违规|审核)/.test(e)) {
    return { label: '内容安全', hint: '提示词或参考图可能触发内容安全策略，请调整后重试。' };
  }
  if (/(timeout|timed out|deadline|504|超时)/.test(e)) {
    return { label: '网关超时', hint: '上游响应超时，通常重试即可恢复。' };
  }
  if (/(50[023]|bad gateway|unavailable|网关|服务不可用)/.test(e)) {
    return { label: '上游异常', hint: '图像服务暂时不可用，稍后重试。' };
  }
  if (/(401|403|unauthorized|forbidden|api.?key|凭证|鉴权)/.test(e)) {
    return { label: '鉴权失败', hint: '服务凭证异常，请联系管理员检查 API Key。' };
  }
  return { label: '生成失败', hint: error };
}
