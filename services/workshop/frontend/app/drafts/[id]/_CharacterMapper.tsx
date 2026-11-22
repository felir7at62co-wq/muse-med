"use client";
import { authFetch } from "../../../lib/auth";
import { useEffect, useMemo, useState } from "react";
import { Users, Check, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Character = {
  alias?: string;
  name?: string;
  role?: string;
  appearance?: string;
  first_seen_episode?: number;
};

/**
 * 角色批量替换面板 — Phase 3 重做版,接入 UI Kit (Card / Button / Badge / Input)。
 *
 * 后端: POST /v1/drafts/{id}/character-replace
 *
 * 把视频反推产物里的占位代号(男1/女1/男2/...)批量替换为用户填写的真实姓名。
 */
export function CharacterMapper({
  draftId,
  characters,
  characterMapping,
  onApplied,
}: {
  draftId: number;
  characters: Character[];
  characterMapping: Record<string, string>;
  onApplied: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ chapters_updated: number; storyboards_updated: number } | null>(null);

  const placeholderRe = /^(?:男|女|老|童)\d+$|^路人$|^旁白$/;

  const pendingChars = useMemo(() => {
    return (characters || []).filter((c) => {
      const alias = c.alias || c.name || "";
      return placeholderRe.test(alias);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters]);

  const historyEntries = useMemo(() => {
    return Object.entries(characterMapping || {});
  }, [characterMapping]);

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const c of pendingChars) {
      const alias = c.alias || c.name || "";
      if (alias) init[alias] = "";
    }
    setEdits(init);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChars.length]);

  if (pendingChars.length === 0 && historyEntries.length === 0) {
    return null;
  }

  const filledCount = Object.values(edits).filter((v) => v.trim()).length;

  function setEdit(alias: string, value: string) {
    setEdits({ ...edits, [alias]: value });
  }

  async function applyMapping() {
    const mapping: Record<string, string> = {};
    for (const [alias, real] of Object.entries(edits)) {
      const r = (real || "").trim();
      if (r) mapping[alias] = r;
    }
    if (Object.keys(mapping).length === 0) {
      setError("请至少填写一个真实姓名");
      return;
    }
    for (const real of Object.values(mapping)) {
      if (placeholderRe.test(real)) {
        setError(`真实姓名不能也是占位形式(${real})`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    setLastResult(null);
    try {
      const res = await authFetch(`${BASE}/v1/drafts/${draftId}/character-replace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      if (!res.ok) {
        const txt = await res.text();
        setError(`替换失败: ${txt.slice(0, 200)}`);
        return;
      }
      const data = await res.json();
      setLastResult({
        chapters_updated: data.chapters_updated || 0,
        storyboards_updated: data.storyboards_updated || 0,
      });
      setEdits({});
      onApplied();
    } catch (e: any) {
      setError(e?.message || "请求失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding="none" className="mb-4 border-warning/40 overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-surface-overlay/30 transition"
      >
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-warning" />
          <h3 className="text-base font-bold text-ink-primary">角色命名</h3>
          {pendingChars.length > 0 && (
            <Badge tone="warning" size="sm">
              {pendingChars.length} 个代号待确认
            </Badge>
          )}
          {historyEntries.length > 0 && (
            <Badge tone="success" size="sm">
              已确认 {historyEntries.length} 个
            </Badge>
          )}
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-ink-muted" />
        ) : (
          <ChevronUp className="w-4 h-4 text-ink-muted" />
        )}
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-3 border-t border-line">
          <p className="text-xs text-ink-secondary mt-3">
            视频反推时角色统一用 <b>男1/女1/男2</b> 这种占位代号。在下方填写真实姓名,
            点击"一键应用替换"会把占位代号在所有章节正文、剧本、角色卡里全局替换为你填写的姓名。
          </p>

          {pendingChars.length > 0 && (
            <div className="border border-line rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-xs text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 text-left w-20">代号</th>
                    <th className="px-3 py-2 text-left w-20">角色定位</th>
                    <th className="px-3 py-2 text-left">外貌</th>
                    <th className="px-3 py-2 text-left w-40">真实姓名</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingChars.map((c) => {
                    const alias = c.alias || c.name || "";
                    return (
                      <tr key={alias} className="border-t border-line">
                        <td className="px-3 py-2 font-mono text-warning">{alias}</td>
                        <td className="px-3 py-2 text-xs text-ink-muted">{c.role || "—"}</td>
                        <td className="px-3 py-2 text-xs text-ink-muted">{c.appearance || "—"}</td>
                        <td className="px-3 py-2">
                          <Input
                            value={edits[alias] || ""}
                            onChange={(e) => setEdit(alias, e.target.value)}
                            disabled={saving}
                            placeholder="留空表示暂不替换"
                            size="sm"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {historyEntries.length > 0 && (
            <details className="bg-surface-base/50 border border-line rounded p-2">
              <summary className="cursor-pointer text-xs text-ink-secondary">
                查看已确认的映射 ({historyEntries.length})
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {historyEntries.map(([alias, real]) => (
                  <span
                    key={alias}
                    className="px-2 py-0.5 text-xs bg-success/10 border border-success/40 rounded"
                  >
                    <span className="text-ink-muted font-mono">{alias}</span>
                    <span className="text-ink-muted"> → </span>
                    <span className="text-success font-semibold">{real}</span>
                  </span>
                ))}
              </div>
            </details>
          )}

          {error && (
            <div className="bg-danger/10 border border-danger/40 rounded p-2 text-xs text-danger flex items-start gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {lastResult && (
            <div className="bg-success/10 border border-success/40 rounded p-2 text-xs text-success flex items-start gap-2">
              <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                已应用替换: 影响 {lastResult.chapters_updated} 个章节正文,{" "}
                {lastResult.storyboards_updated} 个剧本文件
              </span>
            </div>
          )}

          {pendingChars.length > 0 && (
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs text-ink-muted">
                已填写 {filledCount} / {pendingChars.length} 个
              </span>
              <Button
                variant="primary"
                size="md"
                loading={saving}
                leftIcon={!saving ? <Check className="w-4 h-4" /> : undefined}
                disabled={filledCount === 0}
                onClick={applyMapping}
              >
                {saving ? "替换中…" : "一键应用替换(覆盖全剧)"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
