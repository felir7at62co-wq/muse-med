/**
 * 角色一致性 — 花名册(registry) + 角色圣经(bible) 前端 API client.
 * 对应后端 /v1/stages/drafts/{id}/characters (GET/PUT) 与 .../characters/extract (POST)。
 */
import { authFetch } from "./auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

export type Stance = "正" | "反" | "中立";

export interface RegistryChar {
  name: string;
  aliases: string[];
  one_line: string;
}

export interface BibleChar {
  name: string;
  stance: Stance;
  traits: string[];
  motivation: string;
  relation: string;
  speech_style: string;
}

export interface RegistryDoc {
  version?: number;
  updated_at?: string;
  characters: RegistryChar[];
}

export interface BibleDoc {
  version?: number;
  updated_at?: string;
  confirmed?: boolean;
  characters: BibleChar[];
}

export interface CharactersResponse {
  registry: RegistryDoc;
  bible: BibleDoc;
}

const P = (draftId: number) => `${BASE}/v1/stages/drafts/${draftId}/characters`;

export const characterBible = {
  async get(draftId: number): Promise<CharactersResponse> {
    const r = await authFetch(P(draftId));
    if (!r.ok) throw new Error(`加载角色设定失败 (${r.status})`);
    return r.json();
  },

  async save(
    draftId: number,
    payload: { bible?: BibleDoc; registry?: RegistryDoc }
  ): Promise<CharactersResponse & { ok: boolean }> {
    const r = await authFetch(P(draftId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || `保存失败 (${r.status})`);
    }
    return r.json();
  },

  async extract(draftId: number): Promise<CharactersResponse & { ok: boolean; count: number }> {
    const r = await authFetch(`${P(draftId)}/extract`, { method: "POST" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || `抽取失败 (${r.status})`);
    }
    return r.json();
  },
};