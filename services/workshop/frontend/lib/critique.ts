// 评审精修 API 封装
import { authFetch } from './auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export type CritiqueRun = {
  id: number;
  draft_id: number;
  source: string;
  intensity: string;
  status: string; // pending|running|succeeded|failed|interrupted|canceled
  progress: number;
  applied: number;
  error: string | null;
  params: Record<string, unknown> | null;
  progress_json: any | null;
  created_at: string | null;
  updated_at: string | null;
};

export type CritiqueIssue = {
  round: number;
  theme: string | null;
  role: string | null;
  severity: string | null;
  confidence: number;
  issue: string | null;
  evidence: string | null;
  fix_hint: string | null;
  locator: any;
  // D5.1: 钩子体检的结构化字段（仅 audience_reviewer 产出 hook_audit 时存在）
  role_kind?: string | null;
  hook_score?: number | null;
  variables?: Record<string, string> | null;
  rewrite_strategy?: string[] | null;
  // D1/D5.3: 门禁结构问题码（存在时提示走"改契约重生成"而非行级重写）
  code?: string | null;
  episode?: number | null;
};

export async function startCritique(draftId: number, body: {
  source: string;
  intensity: string;
  episodes?: number[] | null;
  editor_model?: string;
  focus?: string | null;
}): Promise<{ run_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/critique/drafts/${draftId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.text()) || '启动失败');
  return r.json();
}

export async function listCritiqueRuns(draftId: number): Promise<CritiqueRun[]> {
  const r = await authFetch(`${BASE}/v1/critique/drafts/${draftId}/runs`);
  if (!r.ok) return [];
  return r.json();
}

export async function getCritiqueRun(runId: number): Promise<CritiqueRun> {
  const r = await authFetch(`${BASE}/v1/critique/runs/${runId}`);
  if (!r.ok) throw new Error('查询失败');
  return r.json();
}

export async function getCritiqueResult(runId: number): Promise<{
  run: CritiqueRun;
  result: any;
  issues_by_episode: Record<string, CritiqueIssue[]>;
}> {
  const r = await authFetch(`${BASE}/v1/critique/runs/${runId}/result`);
  if (!r.ok) throw new Error('查询结果失败');
  return r.json();
}

export async function applyCritique(runId: number, episodes?: number[] | null): Promise<{ applied_episodes: number[]; skipped_episodes?: number[] }> {
  const r = await authFetch(`${BASE}/v1/critique/runs/${runId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ episodes: episodes ?? null }),
  });
  if (!r.ok) throw new Error((await r.text()) || '采纳失败');
  return r.json();
}

export async function cancelCritique(runId: number): Promise<{ run_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/critique/runs/${runId}/cancel`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '取消失败');
  return r.json();
}

// 断点续跑: 把 failed/interrupted/canceled 的任务重新拉起, 跳过已完成的集
export async function resumeCritique(runId: number): Promise<{ run_id: number; status: string }> {
  const r = await authFetch(`${BASE}/v1/critique/runs/${runId}/resume`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.text()) || '续跑失败');
  return r.json();
}

// 是否可断点续跑 (未完成且非进行中)
export function isCritiqueResumable(run: CritiqueRun): boolean {
  return run.status === 'failed' || run.status === 'interrupted' || run.status === 'canceled';
}

// 导出"精修全过程"Word (建议/采纳/驳回 + 前后对照)，触发浏览器下载
export async function downloadCritiqueLog(runId: number): Promise<void> {
  const r = await authFetch(`${BASE}/v1/critique/runs/${runId}/log.docx`);
  if (!r.ok) throw new Error((await r.text()) || '导出失败');
  const blob = await r.blob();
  // 从响应头取文件名 (filename*=UTF-8''...)，取不到则用默认名
  let filename = `精修过程_run${runId}.docx`;
  const cd = r.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (m) {
    try { filename = decodeURIComponent(m[1]); } catch { /* keep default */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function isCritiqueActive(run: CritiqueRun): boolean {
  return run.status === 'pending' || run.status === 'running';
}

// ── 设定圣经 (v2): 常驻 draft, 总览页构建/微调, 精修优先读取 ──
export type StoryBible = {
  world?: { era?: string; locale?: string; tech_level?: string; is_fictional?: boolean; anachronism_terms?: string[] };
  characters?: Array<{ canonical?: string; aliases?: string[]; identity?: string; first_episode?: number }>;
  name_whitelist?: string[];
  address_matrix?: Array<{ from?: string; to?: string; term?: string; relation?: string }>;
  core_drive?: { protagonist?: string; goal?: string; locked_keywords?: string[] };
  trope_labels?: string[];
};

export async function getStoryBible(draftId: number): Promise<StoryBible> {
  const r = await authFetch(`${BASE}/v1/critique/drafts/${draftId}/story-bible`);
  if (!r.ok) return {};
  const d = await r.json();
  return d.bible || {};
}

export async function buildStoryBible(draftId: number, source = 'chapter'): Promise<StoryBible> {
  const r = await authFetch(`${BASE}/v1/critique/drafts/${draftId}/story-bible/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  if (!r.ok) throw new Error((await r.text()) || '构建圣经失败');
  const d = await r.json();
  return d.bible || {};
}

export async function saveStoryBible(draftId: number, bible: StoryBible): Promise<StoryBible> {
  const r = await authFetch(`${BASE}/v1/critique/drafts/${draftId}/story-bible`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bible }),
  });
  if (!r.ok) throw new Error((await r.text()) || '保存圣经失败');
  const d = await r.json();
  return d.bible || {};
}

export const INTENSITY_LABEL: Record<string, string> = {
  light: '轻量（单模型·2轮·约10×）',
  standard: '标准（2模型·4轮·约30×）',
  full: '全量（3模型·6轮·约80×）',
};

export const ROLE_LABEL: Record<string, string> = {
  logic_reviewer: '逻辑/连续性审查员',
  character_reviewer: '人物/情感审查员',
  audience_reviewer: '观众/完播率审查员',
  dialogue_reviewer: '台词/文风审查员',
  genre_reviewer: '题材/套路审查员',
  rule_ai_cliche: '规则·AI腔词典',
  rule_repeat: '规则·重复检测',
  rule_narration: '规则·旁白占比',
  // 2026-09-19：旁白逐条降级建议（与"旁白占比"分工：那条报比例，这条报逐条怎么改）
  rule_narration_level: '规则·旁白降级建议',
  rule_scene_name: '规则·场景名一致性',
  // v2 新增
  chief_editor: '总编辑',
  global_auditor: '全局总览审计',
  gate_anachronism: '闸门·时代违禁词',
  gate_name_drift: '闸门·姓名漂移',
  gate_address: '闸门·称谓冲突',
  gate_drive: '闸门·驱动力漂移',
  gate_trope_repeat: '闸门·桥段重复',
};

export const THEME_LABEL: Record<string, string> = {
  structure: '结构/逻辑',
  character: '人物/动机',
  deai: '台词去AI感',
  pacing: '节奏/钩子',
};

// 模型 id -> 面向用户的名称 (与草稿页模型切换器一致)
export const MODEL_LABEL: Record<string, string> = {
  gemini: '🌐 跨世界观模型',
  deepseek: '🧠 通用模型',
  gpt5: '⚡ 逻辑专项模型',
  qwen: '🦜 兜底模型',
};

export function modelLabel(id: string): string {
  return MODEL_LABEL[id] || id;
}

// ============ 剧本 JSON -> 可读文本 ============
// 精修结果区的 original/refined 对剧本(storyboard)源是一段 shots JSON 字符串，
// 直接展示是大量代码。这里把它转成面向用户的剧本式纯文本（场次/动作/对白）。
// 兼容编辑模型产出的 JSON 损坏（与后端 _repair_json 同款三类修复）。

function repairStoryboardJson(s: string): string {
  // D1 键起始引号丢失/被写成反斜杠或制表符: {\type" / {	ype" / ,\content" -> {"type" / ,"content"
  s = s.replace(/([{,]\s*)[\\\t]?([A-Za-z_][A-Za-z0-9_]*)("\s*:)/g, '$1"$2$3');
  // D2 值内裸引号对（空括号写成带引号）: ("") / （""） -> () / （）
  s = s.split('("")').join('()').split('（""）').join('（）');
  // D3 元素第二个键名缺失、冒号顶替逗号: {"type":"action":"..."} -> {"type":"action","content":"..."}
  s = s.replace(/("type"\s*:\s*"[A-Za-z_]+")\s*:\s*(")/g, '$1, "content": $2');
  return s;
}

function tryParseShots(raw: string): any[] | null {
  const t = (raw || '').trim();
  if (!t) return null;
  // 截取最外层数组
  const i = t.indexOf('[');
  const j = t.lastIndexOf(']');
  const body = i !== -1 && j !== -1 && j > i ? t.slice(i, j + 1) : t;
  for (const cand of [body, repairStoryboardJson(body)]) {
    try {
      const parsed = JSON.parse(cand);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try next */ }
  }
  return null;
}

const _VALID_ELEM_TYPES = new Set([
  'action', 'dialogue', 'flashback_start', 'flashback_end',
  'subtitle', 'narration', 'ost', 'monologue',
]);

// 把单个分镜渲染成可读文本块
function renderShot(shot: any): string[] {
  const lines: string[] = [];
  const sceneNo = shot.scene_no || '';
  const timeLoc = shot.time_loc || shot.location || '';
  const chars: string[] = Array.isArray(shot.characters) ? shot.characters : [];
  // 场次头
  const head: string[] = [];
  if (sceneNo) head.push(`场 ${sceneNo}`);
  if (timeLoc) head.push(timeLoc);
  if (head.length) lines.push(`【${head.join(' · ')}】`);
  if (chars.length) lines.push(`人物：${chars.join('、')}`);
  if (shot.subtitle) lines.push(`字幕：${shot.subtitle}`);

  // 元素优先；若 elements 有损坏(缺 type)则回退 action/dialogue（与后端 docx 同策略）
  const elements: any[] = Array.isArray(shot.elements) ? shot.elements : [];
  const elementsOk = elements.length > 0 && elements.every(
    (e) => e && typeof e === 'object' && _VALID_ELEM_TYPES.has(e.type)
  );

  if (elementsOk) {
    for (const e of elements) {
      if (e.type === 'action') {
        const c = String(e.content || '').replace(/^△+/, '').trim();
        if (c) lines.push(`　${c}`);
      } else if (e.type === 'dialogue') {
        const name = e.character || '';
        const mode = e.mode ? `(${e.mode})` : '';
        const act = e.action ? `（${e.action}）` : '';
        lines.push(`${name}${mode}${act}：${e.content || ''}`);
      } else if (e.type === 'flashback_start') {
        lines.push('【快速闪回】');
      } else if (e.type === 'flashback_end') {
        lines.push('【闪回结束】');
      }
    }
  } else {
    // 回退：用 action / dialogue 汇总字段（内容完整、无损坏）
    if (shot.action) {
      for (const ln of String(shot.action).split('\n')) {
        const c = ln.replace(/^△+/, '').trim();
        if (c) lines.push(`　${c}`);
      }
    }
    if (shot.dialogue) {
      for (const ln of String(shot.dialogue).split('\n')) {
        const t = ln.trim();
        if (t) lines.push(t);
      }
    }
  }
  return lines;
}

// 对外：把精修结果的 original/refined 文本转为可读形态。
// 章节正文(纯文本)原样返回；剧本(JSON)转成剧本式文本；解析失败原样返回。
export function formatCritiqueText(raw: string, isStoryboard?: boolean): string {
  if (!raw) return '';
  // 章节正文：非 JSON，直接返回
  const looksJson = raw.trim().startsWith('[') || raw.trim().startsWith('{');
  if (!isStoryboard && !looksJson) return raw;
  const shots = tryParseShots(raw);
  if (!shots) return raw; // 解析不了就原样（不至于丢内容）
  const blocks: string[] = [];
  shots.forEach((shot, idx) => {
    if (!shot || typeof shot !== 'object') return;
    const shotLines = renderShot(shot);
    if (shotLines.length) blocks.push(shotLines.join('\n'));
    else blocks.push(`（镜头 ${idx + 1}）`);
  });
  return blocks.join('\n\n');
}
