"use client";
/**
 * 改稿对照块 (Diff Block)
 *
 * 设计（用户明确要求）：AI 改文本时，对话块左右两部分 —— 左边原文、右边改后。
 * 不做任务卡、不做时间线，就是普通对话里的一段消息体。
 *
 * 输入是 AI 按约定格式输出的 fenced code block：
 *
 *   ```diffblock
 *   第3集·概要
 *   - …证据时间戳有漏洞。与此同时，陆知衡动用私人资源调取监控…
 *   + …证据时间戳有漏洞。另一头，陆知衡动用私人关系调出监控…
 *
 *   第16集·伏笔
 *   - Vanguard Trust
 *   + 先锋信托
 *   ```
 *
 * 解析规则宽松（AI 偶尔会漏空行、用全角符号），解析不出来就原样当代码显示，
 * 不让用户看到一坨坏掉的 UI。
 */

export type DiffChange = { where: string; before: string; after: string };

const FENCE_RE = /```diffblock\s*\n([\s\S]*?)```/g;

/** 把 AI 输出的文本拆成「普通文本段」与「改动块」的序列。 */
export function splitDiffBlocks(text: string): Array<
  { kind: "text"; content: string } | { kind: "diff"; changes: DiffChange[] }
> {
  const out: Array<{ kind: "text"; content: string } | { kind: "diff"; changes: DiffChange[] }> = [];
  if (!text) return out;
  let last = 0;
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > last) {
      const t = text.slice(last, m.index);
      if (t.trim()) out.push({ kind: "text", content: t });
    }
    const changes = parseDiffBody(m[1]);
    if (changes.length) out.push({ kind: "diff", changes });
    else out.push({ kind: "text", content: "```\n" + m[1] + "```" });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const t = text.slice(last);
    if (t.trim()) out.push({ kind: "text", content: t });
  }
  return out;
}

/** 解析块体：位置行 + 若干 `-`/`+` 行。宽松容错。 */
export function parseDiffBody(body: string): DiffChange[] {
  const changes: DiffChange[] = [];
  const lines = String(body || "").split("\n");
  let where = "";
  let before: string[] = [];
  let after: string[] = [];

  const flush = () => {
    if (before.length || after.length) {
      changes.push({
        where: where || "改动",
        before: before.join("\n").trim(),
        after: after.join("\n").trim(),
      });
    }
    before = [];
    after = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    // 全角减号/加号也认（AI 偶尔用错）
    if (line.startsWith("-") || line.startsWith("－") || line.startsWith("−")) {
      before.push(line.slice(1).trim());
    } else if (line.startsWith("+") || line.startsWith("＋")) {
      after.push(line.slice(1).trim());
    } else {
      // 非 +/- 行 = 新的改动起点，先把上一组收尾
      flush();
      where = line.trim().replace(/^【|】$/g, "");
    }
  }
  flush();
  return changes.filter((c) => c.before || c.after);
}

/** 单个改动块：左原文 / 右改后。 */
function DiffCard({ change, index }: { change: DiffChange; index: number }) {
  const identical = change.before === change.after;
  return (
    <div className="my-2 rounded-lg border border-line overflow-hidden bg-surface-base/40">
      <div className="px-3 py-1.5 text-xs text-ink-secondary bg-surface-overlay/40 border-b border-line">
        {index + 1}. {change.where}
      </div>
      <div className="grid grid-cols-2 divide-x divide-line">
        <div className="p-3 min-w-0">
          <div className="text-[11px] text-ink-muted mb-1">原文</div>
          <div className="text-sm text-ink-secondary whitespace-pre-wrap break-words">
            {change.before || <span className="text-ink-muted">（无）</span>}
          </div>
        </div>
        <div className="p-3 min-w-0">
          <div className="text-[11px] text-success mb-1">改后</div>
          <div className="text-sm text-ink-primary whitespace-pre-wrap break-words">
            {change.after || <span className="text-ink-muted">（删除）</span>}
          </div>
        </div>
      </div>
      {identical && (
        <div className="px-3 py-1 text-[11px] text-ink-muted border-t border-line">
          这一处改动前后相同（可能是模型误报）
        </div>
      )}
    </div>
  );
}

/**
 * 渲染一段 AI 回复：普通文字 + 改动对照。
 *
 * renderText 由调用方注入（对话工坊传的是 ReactMarkdown），这样普通段落
 * 仍能享受原有的 Markdown 渲染，而改动块单独走两栏布局。
 */
export function DiffAwareText({
  text,
  renderText,
}: {
  text: string;
  renderText?: (t: string) => React.ReactNode;
}) {
  const parts = splitDiffBlocks(text);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "text" ? (
          <div key={i}>
            {renderText ? (
              renderText(p.content)
            ) : (
              <span className="whitespace-pre-wrap">{p.content}</span>
            )}
          </div>
        ) : (
          <div key={i}>
            {p.changes.map((c, j) => (
              <DiffCard key={j} change={c} index={j} />
            ))}
          </div>
        )
      )}
    </>
  );
}

/** 消息里是否含改动块（用于决定走哪条渲染路径）。 */
export function hasDiffBlock(text: string): boolean {
  return /```diffblock\s*\n[\s\S]*?```/.test(text || "");
}
