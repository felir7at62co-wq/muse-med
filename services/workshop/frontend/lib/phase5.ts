/**
 * Phase 5 前端 API client.
 * - 角色管理 (characters / relationships / warnings)
 * - 安全报告 (safety-reports / safety-risks)
 * - 导出任务 (export-jobs)
 * - 续写偏好 (extend-config)
 * - 邮箱验证码 (email/send-code, email/verify-code)
 * - Agent 浮窗附件 / 产出物 (agent/conversations/{cid}/{attachments|artifacts})
 */
import { authFetch } from "./auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

async function jget<T = any>(path: string): Promise<T> {
  const r = await authFetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
  return r.json();
}

async function jpost<T = any>(path: string, body?: any): Promise<T> {
  const r = await authFetch(`${BASE}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.detail || `POST ${path} ${r.status}`);
  }
  return r.json();
}

async function jpatch<T = any>(path: string, body?: any): Promise<T> {
  const r = await authFetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`PATCH ${path} ${r.status}`);
  return r.json();
}

async function jput<T = any>(path: string, body?: any): Promise<T> {
  const r = await authFetch(`${BASE}${path}`, {
    method: "PUT",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`PUT ${path} ${r.status}`);
  return r.json();
}

async function jdel<T = any>(path: string): Promise<T> {
  const r = await authFetch(`${BASE}${path}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`DELETE ${path} ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// 1. 角色
// ---------------------------------------------------------------------------

export interface Character {
  id: number;
  draft_id: number;
  name: string;
  role: string;
  appearance: string;
  personality: string;
  backstory: string;
  avatar_url: string;
  avatar_prompt: string;
  traits: string[];
  sort_order: number;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface CharacterIn {
  name: string;
  role?: string;
  appearance?: string;
  personality?: string;
  backstory?: string;
  avatar_url?: string;
  avatar_prompt?: string;
  traits?: string[];
  sort_order?: number;
}

export const phase5Characters = {
  list: (draftId: number) => jget<{ items: Character[] }>(`/v1/drafts/${draftId}/characters`),
  create: (draftId: number, body: CharacterIn) => jpost<Character>(`/v1/drafts/${draftId}/characters`, normalizeCharacterIn(body)),
  update: (draftId: number, cid: number, body: CharacterIn) => jpatch<Character>(`/v1/drafts/${draftId}/characters/${cid}`, normalizeCharacterIn(body)),
  remove: (draftId: number, cid: number) => jdel(`/v1/drafts/${draftId}/characters/${cid}`),
};

function normalizeCharacterIn(body: CharacterIn): any {
  return {
    name: body.name,
    role: body.role || "",
    appearance: body.appearance || "",
    personality: body.personality || "",
    backstory: body.backstory || "",
    avatar_url: body.avatar_url || "",
    avatar_prompt: body.avatar_prompt || "",
    traits: body.traits || [],
    sort_order: body.sort_order || 0,
  };
}

export interface Relationship {
  id: number;
  from: number;
  to: number;
  type: string;
  strength: number;
  description: string;
}

export const phase5Relationships = {
  list: (draftId: number) => jget<{ items: Relationship[] }>(`/v1/drafts/${draftId}/characters/relationships`),
  create: (draftId: number, body: { from_character_id: number; to_character_id: number; relation_type?: string; strength?: number; description?: string }) =>
    jpost<{ id: number }>(`/v1/drafts/${draftId}/characters/relationships`, body),
  remove: (draftId: number, rid: number) => jdel(`/v1/drafts/${draftId}/characters/relationships/${rid}`),
};

export const phase5Warnings = {
  list: (draftId: number) => jget<{ items: any[] }>(`/v1/drafts/${draftId}/characters/warnings`),
  scan: (draftId: number) => jpost<{ ok: boolean; queued: boolean }>(`/v1/drafts/${draftId}/characters/warnings/scan`),
  resolve: (draftId: number, wid: number) => jpatch<{ ok: boolean }>(`/v1/drafts/${draftId}/characters/warnings/${wid}/resolve`),
};

// ---------------------------------------------------------------------------
// 2. 安全报告
// ---------------------------------------------------------------------------

export interface SafetyReport {
  id: number;
  draft_id: number;
  scope: string;
  overall: "pass" | "warning" | "fail";
  summary: string;
  total_issues: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  unresolved_count: number;
  scores: Record<string, number>;
  created_at?: string;
  risks?: SafetyRisk[];
}

export interface SafetyRisk {
  id: number;
  category: string;
  severity: "high" | "medium" | "low";
  keyword: string;
  snippet: string;
  chapter_order?: number;
  position?: number;
  reason: string;
  suggestion: string;
  is_resolved: boolean;
}

export const phase5Safety = {
  list: (draftId: number) => jget<{ items: SafetyReport[] }>(`/v1/drafts/${draftId}/safety-reports`),
  get: (draftId: number, reportId: number) => jget<SafetyReport>(`/v1/drafts/${draftId}/safety-reports/${reportId}`),
  create: (draftId: number, body: any) => jpost<{ id: number; total: number }>(`/v1/drafts/${draftId}/safety-reports`, body),
  resolveRisk: (draftId: number, riskId: number) => jpost<{ ok: boolean; unresolved: number }>(`/v1/drafts/${draftId}/safety-risks/${riskId}/resolve`),
};

// ---------------------------------------------------------------------------
// 3. 导出任务
// ---------------------------------------------------------------------------

export interface ExportJob {
  id: number;
  draft_id: number;
  kind: string;
  status: "pending" | "running" | "done" | "failed";
  progress: number;
  output_url: string;
  error: string;
  created_at?: string;
  finished_at?: string;
  config?: any;
}

export const phase5Exports = {
  list: (draftId?: number) => {
    const q = draftId ? `?draft_id=${draftId}` : "";
    return jget<{ items: ExportJob[] }>(`/v1/export-jobs${q}`);
  },
  create: (body: { draft_id: number; kind: string; config?: any }) => jpost<{ id: number; status: string }>(`/v1/export-jobs`, body),
  get: (jobId: number) => jget<ExportJob>(`/v1/export-jobs/${jobId}`),
};

// ---------------------------------------------------------------------------
// 4. 续写偏好
// ---------------------------------------------------------------------------

export interface ExtendConfig {
  default_target_episodes: number;
  default_chunk_size: number;
  default_word_target: number;
  default_provider: string;
  forced_level: string | null;
  user_guidance_template: string;
}

export const phase5ExtendCfg = {
  get: (draftId: number) => jget<ExtendConfig>(`/v1/drafts/${draftId}/extend-config`),
  set: (draftId: number, body: ExtendConfig) => jput<ExtendConfig>(`/v1/drafts/${draftId}/extend-config`, body),
};

// ---------------------------------------------------------------------------
// 5. 邮箱验证码
// ---------------------------------------------------------------------------

export const phase5Email = {
  send: (email: string, purpose = "register") =>
    jpost<{ ok: boolean; dev_code?: string; expires_at: string }>(`/v1/auth/email/send-code`, { email, purpose }),
  verify: (email: string, code: string, purpose = "register") =>
    jpost<{ ok: boolean }>(`/v1/auth/email/verify-code`, { email, code, purpose }),
};

// ---------------------------------------------------------------------------
// 6. Agent 浮窗附件 / 产出物
// ---------------------------------------------------------------------------

export interface AgentAttachment {
  id: number;
  message_id?: number;
  kind: string;
  filename: string;
  oss_url: string;
  size_bytes: number;
  mime_type: string;
  created_at?: string;
}

export interface AgentArtifact {
  id: number;
  message_id?: number;
  kind: string;
  title: string;
  content: string;
  metadata: any;
  is_pinned: boolean;
  created_at?: string;
}

export const phase5Agent = {
  listAttachments: (convId: number) => jget<{ items: AgentAttachment[] }>(`/v1/agent/conversations/${convId}/attachments`),
  addAttachment: (convId: number, body: any) => jpost<{ id: number }>(`/v1/agent/conversations/${convId}/attachments`, body),
  listArtifacts: (convId: number) => jget<{ items: AgentArtifact[] }>(`/v1/agent/conversations/${convId}/artifacts`),
  addArtifact: (convId: number, body: any) => jpost<{ id: number }>(`/v1/agent/conversations/${convId}/artifacts`, body),
  togglePin: (artifactId: number) => jpatch<{ is_pinned: boolean }>(`/v1/agent/artifacts/${artifactId}/pin`),
  deleteArtifact: (artifactId: number) => jdel(`/v1/agent/artifacts/${artifactId}`),
};
