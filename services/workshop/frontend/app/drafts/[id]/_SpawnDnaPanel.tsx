"use client";
import { useState } from "react";
import { Dna, ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

/**
 * 「提炼出的爆款 DNA」完整展示面板。
 *
 * 后端 EXTRACT_DNA_PROMPT 一共抽 9 个字段, 但过去卡片只显示 3 个
 * (爽点公式/情绪引擎/爆款基因) —— 信息量最大的 beat_rhythm(情绪节奏骨架)
 * 从来没露过面, 而露出来的 why_hit 恰恰是唯一没进创作简报的字段。
 * 这里把 9 个字段全部摊开, 让用户看得见 AI 到底"学到了什么"。
 */

type Rel = { model?: string; why_it_works?: string };
type Beat = { phase?: string; function?: string; intensity?: number | string };

export type Dna = {
  hook_formula?: string;
  emotional_engine?: string;
  relationship_model?: Rel[];
  opening_hook?: string;
  twist_patterns?: string[];
  beat_rhythm?: Beat[];
  signature_devices?: string[];
  audience?: string;
  why_hit?: string;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="text-ink-muted flex-shrink-0 w-[76px]">{label}</span>
      <div className="text-ink-secondary min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 情绪强度 1-5 → 一条可视化的小色条, 一眼看出全剧节奏起伏 */
function IntensityBar({ v }: { v: number }) {
  const n = Math.max(0, Math.min(5, Math.round(v || 0)));
  return (
    <span className="inline-flex gap-[2px] align-middle">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`w-1.5 h-3 rounded-[1px] ${
            i <= n ? "bg-primary" : "bg-surface-base border border-line"
          }`}
        />
      ))}
    </span>
  );
}

export function SpawnDnaPanel({ dna }: { dna: Dna }) {
  const [open, setOpen] = useState(false);
  if (!dna || (!dna.hook_formula && !dna.emotional_engine && !dna.why_hit)) return null;

  const rels = dna.relationship_model || [];
  const twists = dna.twist_patterns || [];
  const beats = dna.beat_rhythm || [];
  const devices = dna.signature_devices || [];
  const extra =
    rels.length + twists.length + beats.length + devices.length +
    (dna.opening_hook ? 1 : 0) + (dna.audience ? 1 : 0);

  return (
    <Card padding="sm" className="bg-primary-subtle/40 border-primary/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 text-xs font-medium text-primary mb-1.5"
      >
        <Dna className="w-3.5 h-3.5" /> 提炼出的爆款 DNA
        <span className="ml-auto flex items-center gap-1 text-ink-muted font-normal">
          {open ? "收起" : `展开全部 ${extra} 项细节`}
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>

      <div className="space-y-1.5">
        {dna.hook_formula && <Row label="爽点公式">{dna.hook_formula}</Row>}
        {dna.emotional_engine && <Row label="情绪引擎">{dna.emotional_engine}</Row>}
        {dna.why_hit && <Row label="爆款基因">{dna.why_hit}</Row>}

        {open && (
          <>
            {dna.opening_hook && <Row label="黄金开场">{dna.opening_hook}</Row>}
            {dna.audience && <Row label="目标受众">{dna.audience}</Row>}

            {rels.length > 0 && (
              <Row label="关系张力">
                <ul className="space-y-0.5">
                  {rels.map((r, i) => (
                    <li key={i}>
                      · {r.model}
                      {r.why_it_works && (
                        <span className="text-ink-muted">（{r.why_it_works}）</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Row>
            )}

            {twists.length > 0 && (
              <Row label="反转套路">
                <div className="flex flex-wrap gap-1">
                  {twists.map((t, i) => (
                    <Badge key={i} tone="muted" size="sm">{String(t)}</Badge>
                  ))}
                </div>
              </Row>
            )}

            {devices.length > 0 && (
              <Row label="招牌记忆点">
                <div className="flex flex-wrap gap-1">
                  {devices.map((d, i) => (
                    <Badge key={i} tone="muted" size="sm">{String(d)}</Badge>
                  ))}
                </div>
              </Row>
            )}

            {beats.length > 0 && (
              <Row label="情绪节奏">
                <div className="space-y-1">
                  <div className="text-[11px] text-ink-muted">
                    裂变时新作会逐阶段贴合这条曲线, 但用全新事件填充
                  </div>
                  {beats.map((b, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-10 flex-shrink-0 text-ink-muted">{b.phase}</span>
                      <IntensityBar v={Number(b.intensity) || 0} />
                      <span className="min-w-0 truncate">{b.function}</span>
                    </div>
                  ))}
                </div>
              </Row>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
