"use client";
/**
 * D6: 单集「戏剧契约」折叠区。
 *
 * 设计原则（见 PLAN-剧情结构与戏剧契约-v3.md §10.1）：
 *   - **默认折叠**，折叠态只显示一行灰色摘要，普通用户观感与改前一致；
 *   - 展开后是结构化编辑区，高级用户可直接改集合同（这是新增的控制力）；
 *   - 老数据没有这些字段时不渲染（返回 null），行为与改前完全一致。
 *
 * 契约字段由 AI 在大纲生成时自动填，用户不需要手填任何一个。
 */
import { useState } from "react";

export type EpisodeContract = {
  order?: number;
  core_push?: string;
  /** 2026-11-04：集纲标签 —— 这一集爽在哪、对手做了什么、兑现哪条卖点。 */
  payoff_moment?: string;
  payoff_kind?: string;
  opponent_move?: string;
  selling_point?: string;
  value_shift?: { from?: string; to?: string };
  stakes?: string;
  escalation?: string;
  hook_in?: { responds_to?: string; mode?: string };
  hook_out?: { type?: string; strength?: string; leads_to?: string };
  plant?: string[];
  payoff?: string[];
  forbidden?: string[];
  audience_knows_delta?: string;
  char_knows_delta?: Record<string, string>;
  /** 2026-09-19：本集情绪强度峰值 1-10。**0 或缺失 = 未标注**（老数据）。 */
  emotion_intensity?: number;
  /** 2026-09-19：本集的权力关系，决定台词该给谁说什么。 */
  power?: { aggressor?: string; defender?: string; focus?: string };
  /**
   * 2026-10-09：本集**场景节拍** —— 按顺序演哪几拍。
   *
   * 这是下游写正文/剧本时"演什么"的清单。此前它根本不存在，
   * 剧本步骤只拿到一句 synopsis（实测扩写倍率 46~56 倍），
   * 于是模型自己编大纲里没有的情节。它比 synopsis 更细，
   * 也是用户在界面上**唯一**能看到"这一集具体怎么演"的地方。
   */
  beats?: { at?: string; who?: string; action?: string; turn?: string }[];
};

/** 该集是否含任何契约信息（老数据全空 → 不渲染本组件）。 */
export function hasContract(ep: EpisodeContract | null | undefined): boolean {
  if (!ep) return false;
  const vs = ep.value_shift || {};
  const pw = ep.power || {};
  return Boolean(
    ep.core_push || ep.stakes || ep.escalation ||
    ep.payoff_moment || ep.opponent_move || ep.selling_point ||
    (vs.from && vs.to) ||
    ep.hook_out?.type || ep.hook_out?.leads_to ||
    (ep.plant || []).length || (ep.payoff || []).length || (ep.forbidden || []).length ||
    // 2026-09-19：只填了新字段的集也要能展开（否则那些集在界面上"没有契约"）
    (ep.emotion_intensity || 0) > 0 ||
    pw.aggressor || pw.defender || pw.focus ||
    // 2026-10-09：只有节拍的集同样要能展开
    (ep.beats || []).length > 0
  );
}

/** 折叠态的一行摘要：出口钩 + 升级标记。 */
function summarize(ep: EpisodeContract): string {
  const bits: string[] = [];
  const n = (ep.beats || []).length;
  if (n) bits.push(`${n} 个节拍`);
  const t = ep.hook_out?.type;
  if (t) bits.push(`出口钩: ${t}`);
  if (ep.hook_out?.strength) bits.push(`强度 ${ep.hook_out.strength}`);
  if (ep.escalation) bits.push("有升级说明");
  if (ep.payoff_kind) bits.push(`爽点: ${ep.payoff_kind}`);
  if ((ep.plant || []).length) bits.push(`埋 ${ep.plant!.length} 伏笔`);
  if ((ep.payoff || []).length) bits.push(`收 ${ep.payoff!.length} 伏笔`);
  return bits.join(" · ") || "已填写契约";
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-1">
      <div className="w-28 shrink-0 text-xs text-ink-secondary pt-1">{label}</div>
      <div className="flex-1 text-sm">{children}</div>
    </div>
  );
}

function Tag({ children, tone = "default" }: { children: React.ReactNode; tone?: string }) {
  const cls =
    tone === "warn"
      ? "bg-warning/15 text-warning border-warning/30"
      : tone === "info"
        ? "bg-info/15 text-info border-info/30"
        : "bg-surface-overlay text-ink-secondary border-line-strong";
  return (
    <span className={`inline-block px-2 py-0.5 mr-1 mb-1 text-xs rounded border ${cls}`}>
      {children}
    </span>
  );
}

export default function ContractFold({
  ep,
  issues = [],
}: {
  ep: EpisodeContract;
  issues?: { level: string; message: string; fix_hint?: string }[];
}) {
  const [open, setOpen] = useState(false);
  if (!hasContract(ep)) return null;

  const vs = ep.value_shift || {};
  const hi = ep.hook_in || {};
  const ho = ep.hook_out || {};
  const errors = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level !== "error");

  return (
    <div className="mt-2 border border-line rounded-lg bg-surface-base/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-overlay/40 transition rounded-lg"
      >
        <span className="text-xs text-ink-secondary">{open ? "▾" : "▸"}</span>
        <span className="text-xs font-medium text-ink-secondary">戏剧契约</span>
        <span className="text-xs text-ink-secondary truncate flex-1">{summarize(ep)}</span>
        {errors.length > 0 && (
          <span className="text-xs text-danger shrink-0">● {errors.length} 结构问题</span>
        )}
        {errors.length === 0 && warns.length > 0 && (
          <span className="text-xs text-warning shrink-0">● {warns.length} 提醒</span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 border-t border-line">
          {issues.length > 0 && (
            <div className="mt-2 mb-1">
              {issues.map((it, i) => (
                <div
                  key={i}
                  className={`text-xs ${it.level === "error" ? "text-danger" : "text-warning"}`}
                >
                  {it.level === "error" ? "结构问题" : "提醒"}: {it.message}
                  {it.fix_hint && (
                    <span className="text-ink-secondary block ml-4">→ {it.fix_hint}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 2026-10-09：场景节拍 —— 放在最前面，因为它是「这一集按顺序演哪几拍」，
              是用户在界面上唯一能看到"具体怎么演"的地方（比 synopsis 更细）。
              在此之前，大纲里根本没有这一层，剧本步骤只能凭一句概要自己编。 */}
          {(ep.beats || []).length > 0 && (
            <Row label="场景节拍">
              <ol className="space-y-1">
                {ep.beats!.map((b, i) => (
                  <li key={i} className="text-sm">
                    <span className="text-ink-muted tabular-nums mr-1">{i + 1}.</span>
                    {b.at && <span className="text-ink-secondary">[{b.at}] </span>}
                    {b.who && <span className="text-ink-muted">在场：{b.who} </span>}
                    {b.action && <span>{b.action}</span>}
                    {b.turn && (
                      <div className="text-xs text-ink-secondary mt-0.5">→ {b.turn}</div>
                    )}
                  </li>
                ))}
              </ol>
            </Row>
          )}
          {ep.core_push && <Row label="核心推进点">{ep.core_push}</Row>}
          {/* 2026-11-04：爽点。放在推进点之后、价值转变之前 —— 用户先看"这一集爽在哪"。 */}
          {(ep.payoff_moment || ep.payoff_kind) && (
            <Row label="本集爽点">
              {ep.payoff_kind && <Tag tone="info">{ep.payoff_kind}</Tag>}
              {ep.payoff_moment}
            </Row>
          )}
          {ep.opponent_move && <Row label="对手动作">{ep.opponent_move}</Row>}
          {ep.selling_point && <Row label="兑现卖点">{ep.selling_point}</Row>}
          {vs.from && vs.to && (
            <Row label="价值转变">
              <span className="text-ink-secondary">{vs.from}</span>
              <span className="mx-1">→</span>
              <span>{vs.to}</span>
            </Row>
          )}
          {ep.stakes && <Row label="失败代价">{ep.stakes}</Row>}
          {ep.escalation && <Row label="升级点">{ep.escalation}</Row>}
          {/* 2026-09-19 新增。⚠️ 强度 0 = 未标注（老数据），**不显示** ——
              那与"强度确实是 1"是两件事，显示成 0 会让人以为这一集很平。 */}
          {(ep.emotion_intensity || 0) > 0 && (
            <Row label="情绪强度">
              <span className="tabular-nums">{ep.emotion_intensity}</span>
              <span className="text-ink-muted"> / 10</span>
              <span className="ml-2 text-ink-muted text-xs">
                {({ 1: "平铺直叙", 2: "平铺直叙", 3: "平铺直叙",
                    4: "有起伏", 5: "有起伏", 6: "有起伏",
                    7: "强冲突", 8: "强冲突",
                    9: "情绪顶点", 10: "情绪顶点" } as Record<number, string>)[
                      Math.min(10, Math.max(1, Math.round(ep.emotion_intensity || 0)))]}
              </span>
            </Row>
          )}
          {ep.power && (ep.power.aggressor || ep.power.defender || ep.power.focus) && (
            <Row label="权力关系">
              <span className="text-ink-secondary">施压</span>{" "}
              {ep.power.aggressor || "（未写）"}
              <span className="mx-1 text-ink-muted">→</span>
              <span className="text-ink-secondary">承受</span>{" "}
              {ep.power.defender || "（未写）"}
              {ep.power.focus && (
                <div className="text-xs text-ink-muted mt-0.5">争的是：{ep.power.focus}</div>
              )}
            </Row>
          )}
          {(hi.responds_to || hi.mode) && (
            <Row label="开场回应">
              {hi.responds_to}
              {hi.mode && <Tag tone="info">{hi.mode}</Tag>}
            </Row>
          )}
          {(ho.type || ho.leads_to) && (
            <Row label="结尾卡点">
              {ho.type && <Tag>{ho.type}</Tag>}
              {ho.strength && <Tag tone="info">{ho.strength}</Tag>}
              {ho.leads_to && <span className="text-ink-secondary">→ {ho.leads_to}</span>}
            </Row>
          )}
          {(ep.plant || []).length > 0 && (
            <Row label="须埋伏笔">
              {ep.plant!.map((p, i) => (
                <Tag key={i} tone="info">{p}</Tag>
              ))}
            </Row>
          )}
          {(ep.payoff || []).length > 0 && (
            <Row label="须收伏笔">
              {ep.payoff!.map((p, i) => (
                <Tag key={i}>{p}</Tag>
              ))}
            </Row>
          )}
          {ep.audience_knows_delta && (
            <Row label="观众新知道">{ep.audience_knows_delta}</Row>
          )}
          {ep.char_knows_delta && Object.keys(ep.char_knows_delta).length > 0 && (
            <Row label="角色新知道">
              {Object.entries(ep.char_knows_delta).map(([k, v]) => (
                <div key={k} className="text-xs">
                  {k}: {v}
                </div>
              ))}
            </Row>
          )}
          {(ep.forbidden || []).length > 0 && (
            <Row label="本集禁止">
              {ep.forbidden!.map((f, i) => (
                <Tag key={i} tone="warn">{f}</Tag>
              ))}
            </Row>
          )}
        </div>
      )}
    </div>
  );
}
