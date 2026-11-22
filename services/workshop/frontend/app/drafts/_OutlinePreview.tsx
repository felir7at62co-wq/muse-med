"use client";
import { useMemo, useState } from "react";
import { Trash2, AlertTriangle, ArrowDownToLine, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Card } from "@/components/ui/Card";
import { confirmAsync, notifyWarning } from "@/lib/dialog";

export type OutlineEpisode = { order: number; title: string; summary: string };

/**
 * 大纲导入预览 + 纠错 (需求3)。
 * - 缺集(断号): 自动补"空集卡片"(summary 空), 提示"第X集大纲为空"
 * - 删除空集 → 后续顺延; 全局"按出现顺序重排 1..N"
 * - 乱序倒退: 高亮警示 + 一键"并入上一集"/"确实是本集" + 可选 AI 辅助判断
 */
export function OutlinePreview({
  episodes,
  onChange,
}: {
  episodes: OutlineEpisode[];
  onChange: (next: OutlineEpisode[]) => void;
}) {
  // 计算"展开后"的列表: 在断号处插入空集卡片
  const display = useMemo(() => buildDisplay(episodes), [episodes]);
  const emptyCount = display.filter((e) => !e.summary.trim()).length;
  // 重号检测。
  // ⚠️ buildDisplay 用 Map.set(order) 建表, 同一个集号只会留下**最后一条**,
  // 于是重号条目在预览里是彻底看不见的 —— 但创建时提交的是完整的 episodes[],
  // 后端再按出现顺序重排 1..N。用户因此看到「预览 60 集, 建出来 67 集」。
  // 这里把差额显式摆出来, 不让它再静默。
  const dupCount = episodes.length - new Set(episodes.map((e) => e.order)).size;
  // 乱序检测: 原始 episodes 里 order 非单调递增的位置
  const disorderIdx = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < episodes.length; i++) {
      if (episodes[i].order <= episodes[i - 1].order) out.push(i);
    }
    return new Set(out);
  }, [episodes]);

  function update(order: number, patch: Partial<OutlineEpisode>) {
    onChange(episodes.map((e) => (e.order === order ? { ...e, ...patch } : e)));
  }

  function removeByOrder(order: number) {
    onChange(episodes.filter((e) => e.order !== order));
  }

  // 删除某个"空集卡片"(它不在 episodes 里, 是 display 补出来的)
  async function deleteEmptySlot(order: number) {
    // 空集本就不在 episodes; 删除 = 把它后面所有集 order 前移 1, 填补这个空位
    //
    // ⚠️ 这是**改动所有后续集号**的动作（审计 §3.2 点名要求明示影响范围）：
    //    第 7 集删掉之后，原来的第 8 集变成第 7 集……用户如果只看到"删除空集"四个字，
    //    不会意识到自己刚刚把后面几十集的编号整体挪了一位（而集号是下游
    //    分镜/生图/成片的挂载键）。所以先报出将受影响的范围再动手。
    const affected = episodes.filter((e) => e.order > order).length;
    if (affected > 0) {
      const ok = await confirmAsync({
        title: `删除第 ${order} 集（空集）`,
        description:
          `第 ${order + 1} 集起的 ${affected} 集将整体前移一位：` +
          `原来的第 ${order + 1} 集 → 第 ${order} 集，以此类推。\n` +
          `下游已生成的分镜/生图按集号挂载，集号变了它们会对不上。`,
        confirmText: "删除并前移",
        tone: "danger",
      });
      if (!ok) return;
    }
    onChange(episodes.map((e) => (e.order > order ? { ...e, order: e.order - 1 } : e)));
  }

  function renumberSequential() {
    const sorted = [...episodes].sort((a, b) => a.order - b.order);
    onChange(sorted.map((e, i) => ({ ...e, order: i + 1 })));
  }

  // 乱序: "这不是集号" → 并入上一集正文
  function mergeIntoPrev(idx: number) {
    if (idx <= 0) return;
    const cur = episodes[idx];
    const prev = episodes[idx - 1];
    const merged = episodes
      .filter((_, i) => i !== idx)
      .map((e) =>
        e.order === prev.order
          ? { ...e, summary: (e.summary + "\n" + cur.summary).trim() }
          : e,
      );
    onChange(merged);
  }

  return (
    <div className="space-y-3">
      {/* 顶部纠错工具条 */}
      <div className="flex items-center gap-2 flex-wrap text-sm">
        <span className="text-ink-secondary">共 {display.length} 集</span>
        {dupCount > 0 && (
          <span className="text-danger">（实际会创建 {episodes.length} 集）</span>
        )}
        {emptyCount > 0 && (
          <span className="flex items-center gap-1 text-warning">
            <AlertTriangle className="w-4 h-4" />
            {emptyCount} 个空集 (需补充或删除后才能创建)
          </span>
        )}
        <Button variant="secondary" size="sm" onClick={renumberSequential} className="ml-auto" title="忽略原标号, 按当前出现顺序重排为 1..N">
          按顺序重排 1..N
        </Button>
      </div>

      {dupCount > 0 && (
        <Card padding="sm" className="bg-danger/10 border-danger/40">
          <p className="text-xs text-danger">
            ⚠️ 有 <b>{dupCount}</b> 条内容跟别的集撞了集号，
            <b>在上面的列表里被盖住看不见</b>，但创建时会照样建出来
            —— 所以你会看到「预览 {display.length} 集、建出来 {episodes.length} 集」。
            <br />
            常见原因：正文里的「1.」「(2)」「一、」等节拍编号被当成了集号。
            请点右上角「按顺序重排 1..N」把它们全部显形，再逐条把不是集号的用
            「这不是集号·并入上一集」并回去。
          </p>
        </Card>
      )}

      {disorderIdx.size > 0 && (
        <Card padding="sm" className="bg-warning/10 border-warning/40">
          <p className="text-xs text-warning">
            ⚠️ 检测到集号倒退(可能是正文里的"第N集"被误识别)。请在对应卡片上选择「这不是集号·并入上一集」或手动改集号。
          </p>
        </Card>
      )}

      <div className="space-y-2 max-h-[55vh] overflow-y-auto">
        {display.map((ep, dispIdx) => {
          const isEmpty = !ep.summary.trim();
          // 找到它在原始 episodes 里的下标(空集为 -1)
          const realIdx = episodes.findIndex((e) => e.order === ep.order && !isEmpty);
          const isDisorder = realIdx >= 0 && disorderIdx.has(realIdx);
          return (
            <div
              key={`${ep.order}-${dispIdx}`}
              className={`border rounded-md p-3 ${
                isEmpty
                  ? "border-warning/50 bg-warning/5"
                  : isDisorder
                  ? "border-danger/50 bg-danger/5"
                  : "border-line bg-surface-base"
              }`}
            >
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="text-primary font-bold">第{ep.order}集</span>
                {isEmpty ? (
                  <>
                    <span className="text-warning text-xs flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> 大纲为空(断号补位)
                    </span>
                    <Button variant="ghost" size="sm" className="ml-auto text-danger" onClick={() => void deleteEmptySlot(ep.order)} title="删除此空集；⚠️ 后续集会整体前移一位（集号变化）">
                      <Trash2 className="w-3.5 h-3.5" /> 删除空集
                    </Button>
                  </>
                ) : (
                  <>
                    <Input
                      value={ep.title}
                      onChange={(e) => update(ep.order, { title: e.target.value })}
                      placeholder="集名(可空)"
                      className="!py-1 max-w-[260px]"
                    />
                    <div className="ml-auto flex gap-1">
                      {isDisorder && (
                        <Button
                          variant="secondary"
                          size="sm"
                          leftIcon={<ArrowDownToLine className="w-3 h-3" />}
                          onClick={() => mergeIntoPrev(realIdx)}
                          title="这其实是上一集内容里的'第N集'字样, 并入上一集"
                        >
                          这不是集号·并入上一集
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="text-danger" onClick={() => removeByOrder(ep.order)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
              {isEmpty ? (
                <Textarea
                  value=""
                  onChange={(e) => {
                    // 用户给空集补内容 → 把它插入 episodes
                    const val = e.target.value;
                    if (!val.trim()) return;
                    const next = [...episodes, { order: ep.order, title: "", summary: val }].sort((a, b) => a.order - b.order);
                    onChange(next);
                  }}
                  rows={2}
                  placeholder="（此集大纲为空，可在此补充内容，或点上方「删除空集」让后续集顺延）"
                  className="text-xs"
                />
              ) : (
                <Textarea
                  value={ep.summary}
                  onChange={(e) => update(ep.order, { summary: e.target.value })}
                  rows={3}
                  className="text-xs leading-relaxed"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 在断号处插入空集卡片, 返回连续展示列表。导出供导入弹窗做空集校验。 */
export function buildContinuous(episodes: OutlineEpisode[]): OutlineEpisode[] {
  return buildDisplay(episodes);
}

/** 在断号处插入空集卡片, 返回连续展示列表。 */
function buildDisplay(episodes: OutlineEpisode[]): OutlineEpisode[] {
  if (!episodes.length) return [];
  const sorted = [...episodes].sort((a, b) => a.order - b.order);
  const out: OutlineEpisode[] = [];
  const minOrder = sorted[0].order;
  const maxOrder = sorted[sorted.length - 1].order;
  const byOrder = new Map<number, OutlineEpisode>();
  sorted.forEach((e) => byOrder.set(e.order, e));
  for (let o = minOrder; o <= maxOrder; o++) {
    const hit = byOrder.get(o);
    out.push(hit || { order: o, title: "", summary: "" });
  }
  return out;
}