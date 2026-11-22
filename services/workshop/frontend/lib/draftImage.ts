// 草稿内「生图」版块 API 封装
import { authFetch } from './auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export type EpisodeMode = 'none' | 'single' | 'grid9';

export type ImageTaskCard = {
  id: number;
  mode: 'single' | 'grid9';
  group_index: number;
  shot_indexes: number[];
  status: string; // pending|running|succeeded|failed
  progress: number;
  error: string | null;
  model: string | null;
  size: string | null;
  ref_urls: string[];
  result_urls: string[];
};

export type EpisodeImage = {
  chapter_order: number;
  mode: EpisodeMode;
  prompt_count: number;
  image_prompt_count: number;
  tasks: ImageTaskCard[];
};

export type CharacterImage = {
  id: number;
  url: string | null;
  episodes: number[];
  seq: number;
};

export type DraftCharacter = {
  id: number;
  name: string;
  images: CharacterImage[];
};

export async function listImageTasks(draftId: number): Promise<{ episodes: EpisodeImage[]; running: boolean }> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/image-tasks`);
  if (!r.ok) return { episodes: [], running: false };
  return r.json();
}

export async function setImageConfig(
  draftId: number,
  items: { chapter_order: number; mode: EpisodeMode }[],
): Promise<void> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/image-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!r.ok) throw new Error((await r.text()) || '保存模式失败');
}

export async function runImageTasks(
  draftId: number,
  body: { chapter_orders?: number[] | null; model: string; size: string },
): Promise<{ started: number; episodes: { chapter_order: number; mode: string; tasks: number }[]; message: string }> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/image-tasks/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()) || '发起生图失败');
  return r.json();
}

export async function regenerateImageTask(draftId: number, taskId: number): Promise<void> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/image-tasks/${taskId}/regenerate`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '重生失败');
}

export async function deleteImageTask(draftId: number, taskId: number): Promise<void> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/image-tasks/${taskId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.text()) || '删除失败');
}

// ── 角色垫图 ──────────────────────────────────────────────

export async function listCharacters(draftId: number): Promise<DraftCharacter[]> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/characters-image`);
  if (!r.ok) return [];
  return (await r.json()).characters || [];
}

export async function createCharacter(draftId: number, name: string): Promise<{ id: number; name: string }> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/characters-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error((await r.text()) || '新建角色失败');
  return r.json();
}

export async function deleteCharacter(draftId: number, charId: number): Promise<void> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/characters-image/${charId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.text()) || '删除角色失败');
}

export async function uploadCharacterImage(
  draftId: number,
  charId: number,
  file: File,
  episodes: number[],
): Promise<CharacterImage> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('episodes', episodes.join(','));
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/characters-image/${charId}/images`, {
    method: 'POST',
    body: fd,
  });
  if (!r.ok) throw new Error((await r.text()) || '上传形象失败');
  return r.json();
}

export async function patchCharacterImage(
  draftId: number,
  imageId: number,
  episodes: number[],
): Promise<void> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/characters-image/images/${imageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodes }),
  });
  if (!r.ok) throw new Error((await r.text()) || '更新形象失败');
}

export async function deleteCharacterImage(draftId: number, imageId: number): Promise<void> {
  const r = await authFetch(`${BASE}/v1/drafts/${draftId}/characters-image/images/${imageId}`, { method: 'DELETE' });
  if (!r.ok) throw new Error((await r.text()) || '删除形象失败');
}

export const IMAGE_MODELS = [
  { value: 'gpt-image-2', label: 'Image2 (GPT)' },
  { value: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (Gemini)' },
  { value: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Gemini)' },
] as const;

export const EPISODE_MODE_LABELS: Record<EpisodeMode, string> = {
  none: '不生图',
  single: '一镜一图',
  grid9: '九镜一图',
};