/**
 * 对话气泡「在右侧定位」的匹配器 —— 纯函数, 无 state / 无网络 / 无 LLM。
 *
 * ## 为什么需要三级匹配, 而不是一句 indexOf
 * 用户要的是"把 AI 在对话里引用的那段原文, 在右边找出来"。但 AI 引用的文字
 * 与草稿里**经常差一两个字符**:
 *   · 标点: AI 写 `!` 而草稿是 `！`; AI 写 `...` 而草稿是 `……`
 *   · 引号: AI 写 `"` 而草稿是 `""`
 *   · 错字: 用户给的实例里 AI 把「装个大逼」写成了「技个大道」
 * 只做精确 indexOf 会大面积找不到 —— 而"找不到"对用户是**沉默的失败**,
 * 他会以为功能坏了。所以逐级放宽:
 *   L1 精确        命中即 exact, 可信度 100%
 *   L2 归一化      把标点/引号/省略号/空白统一到等价类后再找, 仍是**整段**相等
 *   L3 最长公共子串  只要求六成以上字符连续相同 —— 这一级**必须**标"相近"
 *
 * ## ⚠️ 归一化只做"等价类合并", 绝不增删字符
 * 每一步都带一张 `归一化下标 → 原文下标` 的映射表, 才能把命中区间**映射回原文**
 * 去做高亮和替换。一旦某步改变了长度(比如把 `……` 直接改写成 `...`), 映射就断了,
 * 高亮会错位。所以多字符等价(省略号/重复标点)只能靠"折叠连续重复字符"实现
 * (canon2) —— 它删掉的都是彼此等价的字符, 映射取该段首字符即可。
 *
 * ## 为什么 L3 不能全量跑 DP
 * 一集正文上万字、一本小说几十万字, O(n·m) 会卡死主线程。先用 6 字 shingle
 * 做**廉价预筛**把候选位置收敛到一两处, 再在 ±一句 的小窗口里跑 DP。
 */

/** 命中方式。UI 据此决定是"精确"还是必须标"相近"。 */
export type LocateKind = 'exact' | 'normalized' | 'fuzzy';

export type Hit = {
  order: number;
  /** 在**原文**里的起止(左闭右开), 可直接用于高亮与替换 */
  start: number;
  end: number;
  kind: LocateKind;
  /** 仅 kind==='exact' 为 true。UI 拿它区分两种视觉。 */
  exact: boolean;
  /** 0~1。L1/L2 恒为 1(归一化后整段一致); L3 是命中长度占引文的比例。 */
  similarity: number;
};

/** L3 的准入门槛: 连续相同的字符要占到引文的这个比例, 否则宁可不报。 */
const FUZZY_MIN_RATIO = 0.6;

/** shingle 长度。中文按字取 6 —— 太短会命中太多噪音, 太长则容错变差。 */
const SHINGLE = 6;

// ---------------------------------------------------------------------------
// 归一化(带下标映射)
// ---------------------------------------------------------------------------

/**
 * 单字符等价类: 全角 ↔ 半角 标点、各种引号、省略号、破折号。
 *
 * ⚠️ 只登记**确实等价**的字符。不要为了"多匹配上"把 `·` 也并进 `.` ——
 * 那样会把「沈知念·林」这类名字里的间隔号吃掉, 造成错误命中。
 */
const PUNCT: Record<string, string> = {
  '，': ',', '、': ',', '。': '.', '．': '.', '！': '!', '？': '?',
  '：': ':', '；': ';', '（': '(', '）': ')', '【': '[', '】': ']',
  '《': '<', '》': '>',
  '“': '"', '”': '"', '＂': '"', '"': '"',
  '‘': "'", '’': "'", '＇': "'", "'": "'",
  '—': '-', '－': '-', '–': '-', '─': '-',
  '～': '~', '〜': '~',
  '…': '.', '⋮': '.', '⋯': '.',
};

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
    || ch === '　' || ch === ' ' || ch === ' ' || ch === ' ';
}

/** 第一级归一: 逐字符映射, 严格 1:1, 因此映射表与原文一一对应。 */
function canon1(s: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let c = ch;
    if (isSpace(ch)) c = ' ';
    else if (PUNCT[ch]) c = PUNCT[ch];
    out.push(c);
    map.push(i);
  }
  return { text: out.join(''), map };
}

/** 可以折叠连续重复的字符 —— 只限标点与空白, 绝不能折叠正文用字。 */
const COLLAPSIBLE = new Set([',', '.', '!', '?', ';', ':', '-', '~', ' ']);

/** 第二级归一: 折叠连续重复的等价字符(`……`→`.`, `！！！`→`!`, 多个空格→一个)。 */
function canon2(s: string, map: number[]): { text: string; map: number[] } {
  const out: string[] = [];
  const m: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (out.length && COLLAPSIBLE.has(ch) && out[out.length - 1] === ch) continue;
    out.push(ch);
    m.push(map[i]);
  }
  return { text: out.join(''), map: m };
}

/** 完整归一化, 带回原文的下标映射。 */
function normalize(s: string): { text: string; map: number[] } {
  const a = canon1(s);
  return canon2(a.text, a.map);
}

// ---------------------------------------------------------------------------
// L3: 最长公共子串(带窗口收敛)
// ---------------------------------------------------------------------------

/**
 * 从 shingle 命中**反推对齐偏移**, 并对偏移投票。
 *
 * ## 为什么不是"最长公共子串"
 * LCS 对**中间**的差异极不敏感地坏掉: 引文 50 字、正中有一个错字, 匹配就被
 * 劈成两段各 25 字, 取最长只有 25 —— 算下来 50%, 连 60% 的门槛都过不去,
 * 于是一条只错一个字的引文被判为"找不到"。这正是用户实例的样子
 * (AI 把「装个大逼」写成「技个大道」), 所以 LCS 不能用。
 *
 * ## 偏移投票为什么能解决
 * 引文里的每个 6 字窗口, 若在正文里也出现, 那么"正文位置 − 引文位置"就是
 * 一个**候选对齐偏移**。真偏移会被大量窗口投中(错几个字不影响其余窗口),
 * 噪音偏移只会零星撞上。取票数最高的几个偏移, 再逐个按"逐字相符率"打分 ——
 * 打分只看每个位置是否相等, **中间的错字只扣自己那一分**, 不再连累整段。
 */
function candidateOffsets(text: string, q: string): number[] {
  // 引文各 shingle → 它在引文里的首次位置(重复的取首次即可)
  const pos = new Map<string, number>();
  for (let i = 0; i + SHINGLE <= q.length; i++) {
    const k = q.slice(i, i + SHINGLE);
    if (!pos.has(k)) pos.set(k, i);
  }
  // 引文比 shingle 还短: 模糊匹配没有意义(两个字的"相近"毫无约束力)
  if (pos.size === 0) return [];

  const votes = new Map<number, number>();
  for (let j = 0; j + SHINGLE <= text.length; j++) {
    const i = pos.get(text.slice(j, j + SHINGLE));
    if (i === undefined) continue;
    const off = j - i;
    votes.set(off, (votes.get(off) || 0) + 1);
  }
  // 真偏移票数最高, 但错字附近的偏移也会投到几票, 多取几个逐个打分更稳
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map((e) => e[0]);
}

/**
 * 按某个对齐偏移给引文与正文打分: 逐字比对, 返回相符率与**收紧后**的区间。
 *
 * 收紧: 只取"首个相符位置 ~ 末个相符位置"。这样前后多出的不相等字符
 * (偏移没对得特别齐时难免) 不会被高亮进去, 划出来的正是那一段。
 */
function scoreAlignment(q: string, text: string, off: number): { ratio: number; start: number; end: number } {
  const n = q.length;
  const from = Math.max(0, off);
  const to = Math.min(text.length, off + n);
  if (to <= from) return { ratio: 0, start: 0, end: 0 };
  let match = 0, first = -1, last = -1;
  for (let k = from; k < to; k++) {
    const qi = k - off;
    if (qi < 0 || qi >= n) continue;
    if (text[k] === q[qi]) {
      match++;
      if (first < 0) first = k;
      last = k;
    }
  }
  return { ratio: match / n, start: first, end: last + 1 };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 命中排序: 精确优先 → 相似度高优先 → 集号小的优先。 */
function sortHits(hits: Hit[]): Hit[] {
  return hits.sort((a, b) =>
    (Number(b.exact) - Number(a.exact))
    || (b.similarity - a.similarity)
    || (a.order - b.order)
    || (a.start - b.start));
}

/**
 * 在 `pieces`(当前页签的全部块)里找 `quote`。
 *
 * 返回**全部**命中, 供 UI 做"第 1/3 处"翻页。找不到返回空数组 ——
 * 调用方据此显示"当前页签里没有", 而不是静默什么都不做。
 *
 * ⚠️ 调用方只传**当前页签**的数据。刻意不跨页签搜索: 页签是用户的语境,
 * 在"推文"里选中一句话却跳到"剧本"的高亮, 会让人以为定位错了。
 */
export function locateQuote(
  pieces: { order: number; text: string }[],
  quote: string,
): Hit[] {
  const q = (quote || '').trim();
  if (!q || !pieces?.length) return [];

  // ---- L1 精确 ----
  const exactHits: Hit[] = [];
  for (const p of pieces) {
    const t = p.text || '';
    if (!t) continue;
    let i = t.indexOf(q);
    while (i !== -1) {
      exactHits.push({
        order: p.order, start: i, end: i + q.length,
        kind: 'exact', exact: true, similarity: 1,
      });
      i = t.indexOf(q, i + q.length);
    }
  }
  if (exactHits.length) return sortHits(exactHits);

  // ---- L2 / L3 都在归一化文本上做 ----
  const nq = normalize(q);
  if (!nq.text) return [];
  const qLen = nq.text.length;

  const normHits: Hit[] = [];
  const fuzzyHits: Hit[] = [];

  for (const p of pieces) {
    const raw = p.text || '';
    if (!raw) continue;
    const np = normalize(raw);
    if (!np.text) continue;

    // ---- L2 归一化后整段相等 ----
    let i = np.text.indexOf(nq.text);
    while (i !== -1) {
      normHits.push({
        order: p.order,
        start: np.map[i],
        end: np.map[i + qLen - 1] + 1,
        kind: 'normalized', exact: false, similarity: 1,
      });
      i = np.text.indexOf(nq.text, i + qLen);
    }
    if (normHits.length) continue;    // 这一块已有整段命中, 不必再跑模糊

    // ---- L3 偏移投票 + 对齐打分 ----
    let best = { ratio: 0, start: 0, end: 0 };
    for (const off of candidateOffsets(np.text, nq.text)) {
      const sc = scoreAlignment(nq.text, np.text, off);
      if (sc.ratio > best.ratio) best = sc;
      if (best.ratio === 1) break;     // 已是满分, 无需再看别的偏移
    }
    const sim = best.ratio;
    if (sim >= FUZZY_MIN_RATIO && best.end > best.start) {
      // 夹一下: 映射表理论上够用, 但防御性地挡住越界, 免得高亮切出 undefined
      const s = best.start, e = best.end - 1;
      if (s >= 0 && e < np.map.length && np.map[s] != null && np.map[e] != null) {
        fuzzyHits.push({
          order: p.order,
          start: np.map[s],
          end: np.map[e] + 1,
          kind: 'fuzzy', exact: false, similarity: sim,
        });
      }
    }
  }

  if (normHits.length) return sortHits(normHits);
  return sortHits(fuzzyHits);
}

/** 给人看的一句话说明。UI 直接用它做提示, 免得各处的措辞不一致。 */
export function hitLabel(h: Hit): string {
  if (h.kind === 'exact') return '精确匹配';
  if (h.kind === 'normalized') return '标点/符号与原文不同（已按归一化定位）';
  return `相近段落：连续相同约 ${Math.round(h.similarity * 100)}%`;
}
