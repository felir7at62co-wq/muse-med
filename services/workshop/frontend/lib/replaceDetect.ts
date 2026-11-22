/**
 * 对话工坊「一键替换」的识别器 —— 纯函数, 无 state / 无网络 / 无 LLM。
 *
 * 背景: 用户在对话工坊让 AI 改某一集, 然后手动复制粘贴进右侧草稿。超级 Agent
 * 本可自动替换, 但它靠 detect_intent 再发一次 LLM 请求才出卡片, 慢到没人用
 * (dev 库 agent_operations 表 0 行)。这里改用纯客户端识别: 零延迟、零成本、
 * 结果确定, AI 回复一出来按钮就在。
 *
 * ## 为什么类型主要靠"对话模式"而不是文本特征
 * 四类产物里只有剧本有强格式特征(【场】/△/角色：), 而章节原文、小说、推文
 * 都是纯散文 —— adapt_products/prompts.py 里 NOVEL_SYSTEM/TWEET_SYSTEM 明确
 * 要求"不要标题编号、不要解说、不要 markdown 代码块", 所以这三类在文本层面
 * **无法区分**(想分辨小说/推文只能数"我"字, 必错)。
 * 因此: 用户选的对话模式 = 用户的显式声明, 优先级最高; 文本特征只作兜底。
 */
import { textToShots } from "./scriptText";

/** 可替换的目标类型。与后端存储一一对应。 */
export type ReplaceKind = "storyboard" | "chapter" | "novel" | "tweet";

export const KIND_LABEL: Record<ReplaceKind, string> = {
  storyboard: "剧本",
  chapter: "章节原文",
  novel: "小说",
  tweet: "推文",
};

/** 集号的量词: 剧本/小说/推文按"集", 章节原文按"章"(与附件选择器一致)。 */
export const KIND_UNIT: Record<ReplaceKind, string> = {
  storyboard: "集", chapter: "章", novel: "集", tweet: "集",
};

/** 对话模式 key → 替换目标类型。模式是用户的显式声明, 判定类型时优先级最高。 */
const MODE_TO_KIND: Record<string, ReplaceKind> = {
  storyboards: "storyboard",
  chapters: "chapter",
  novel: "novel",
  tweet: "tweet",
};

export type Detection = {
  /** 切出的正文(已去掉寒暄/解说) */
  body: string;
  /** 推断的目标类型; null = 认不出, chip 要求用户选 */
  kind: ReplaceKind | null;
  /** 推断的集号; null = 认不出, chip 要求用户选 */
  chapterOrder: number | null;
  /** kind 与 chapterOrder 都确定时为 true —— 此时 chip 无需用户点开确认 */
  confident: boolean;
  /** kind='storyboard' 但解析不出场头: 不给替换按钮, 提示改投章节 */
  storyboardUnparseable: boolean;
  /** 解析出的场次数(仅 storyboard 有意义, 用于 chip 副标题) */
  sceneCount: number;
};

// ---------------------------------------------------------------------------
// 正文 / 注释切分
// ---------------------------------------------------------------------------

/** 开场寒暄/说明: "好的, 我按你的要求…" / "为了契合…我为你重写了第一集" */
const OPENING_RE = /^(好的|明白|收到|没问题|了解|以下是|这是|下面是|我来|已经|根据你|按照你|如你所说|为了|考虑到|本集|这一集|注意|说明)/;
/** 收尾追问/总结: "以上就是…" / "需要我再调整吗?" */
const CLOSING_RE = /^(以上|这样|如需|如果你|需要我|要不要|还需要|希望这|你觉得|请问|另外|补充|备注)/;

/**
 * 尾部"说明"类小节的标题。AI 很爱在正文后附一段自我点评
 * (设计亮点说明 / 改写说明 / 修改要点 / 人称统一 …), 这些绝不能进正文。
 * 命中后, 从该标题起到结尾全部不选。
 *
 * ⚠ 前缀刻意写成"任意 0-6 个非标点字符", 而不是枚举「设计|修改|改动…」——
 * 枚举是无底洞: 用户已连续两轮反馈新变体("设计亮点说明"→"改写说明")。
 * 这里只认"短行 + 以说明类词结尾 + 可选冒号"这个**结构**。
 * 结构判定仍可能漏, 但漏了也只是多选一段, 用户点一下就能去掉(高亮可点选)。
 */
const TRAILING_SECTION_RE = /^#{0,6}\s*\**\s*[^\n。！？!?，,；;：:]{0,6}?(亮点|说明|要点|思路|逻辑|点评|解析|总结|概要|备注|建议)\s*(说明|如下)?\s*[:：]?\s*\**\s*$/;

/**
 * 正文特征: 剧本场头 / 动作行 / 台词行 / 【】标记。
 *
 * ⚠ 台词行的判定要排除"以…：结尾的解说句"。`^[^：:]{1,12}[：:]` 本身会把
 * "好的，以下是修改后的内容：" 也当成台词(冒号前恰好 12 字内), 导致开场白
 * 被误判成正文而保留下来。故台词行额外要求: 冒号后还有内容, 且冒号前不含逗号
 * (人物名不会带逗号)。
 */
function looksLikeBody(p: string): boolean {
  if (/^【场/.test(p) || /^△/.test(p) || /【[^】]+】/.test(p)) return true;
  const m = p.match(/^([^：:\n]{1,12})[：:](.*)$/);
  return !!m && !/[，,、]/.test(m[1]) && m[2].trim().length > 0;
}

/**
 * 去掉 Markdown 修饰, 只保留纯文本。
 *
 * 为什么必须做: 剧本/小说/推文入库的都是**纯文本正文**, 草稿页不渲染 Markdown。
 * 把 `**林浩**：` `### 场景` `---` 原样写进去, 用户在草稿里看到的就是一堆
 * 星号井号(用户实测反馈的正是这个问题)。
 */
export function stripMarkdown(text: string): string {
  return (text || "")
    .split("\n")
    .map((ln) => {
      let s = ln;
      s = s.replace(/^\s{0,3}#{1,6}\s+/, "");        // ### 标题(# 后必须有空格, 免伤"#1")
      s = s.replace(/^\s{0,3}#{1,6}(?=\S)/, "");     // ###标题(无空格写法)
      s = s.replace(/^\s{0,3}>\s?/, "");             // > 引用
      s = s.replace(/^\s{0,3}([-*+])\s+/, "");       // - 无序列表(保留有序列表的数字)
      s = s.replace(/\*\*\*(.+?)\*\*\*/g, "$1");     // ***粗斜***
      s = s.replace(/\*\*(.+?)\*\*/g, "$1");         // **粗体**
      s = s.replace(/(?<!\*)\*(?!\s)([^*\n]+?)\*/g, "$1");  // *斜体*(不动 △*)
      s = s.replace(/__(.+?)__/g, "$1");             // __粗体__
      s = s.replace(/`([^`\n]+)`/g, "$1");           // `行内代码`
      s = s.replace(/^\s*[-*_]{3,}\s*$/, "");        // --- 分隔线 → 整行清空
      return s.trimEnd();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")                      // 清空分隔线后的多余空行
    .trim();
}

/**
 * 从 AI 回复里切出"可替换的正文", 剔除解说性内容并去掉 Markdown 修饰。
 *
 * 优先级:
 *   1. 有 ``` 围栏 → 取围栏内(围栏外的解说天然被排除, 最可靠)
 *   2. 无围栏 → 按段落逐段剥离首尾的解说段, 并砍掉尾部"设计说明"整节
 *
 * ⚠ 首尾要**循环**剥离而不是各剥一段: AI 的开场白经常是
 *   "为了契合…我为你重写了第一集。" + "本集重点强化了…" 两段以上。
 */
export function extractBody(text: string): string {
  const raw = (text || "").replace(/\r\n/g, "\n");
  if (!raw.trim()) return "";

  // 1) 代码围栏: 取最长的一段(AI 有时同时给示例和正文, 正文通常更长)
  const fences = [...raw.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (fences.length > 0) {
    return stripMarkdown(fences.reduce((a, b) => (b.length > a.length ? b : a)).trim());
  }

  // 2) 无围栏: 按空行分段处理
  let paras = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length === 0) return "";

  // 2a) 砍掉尾部"设计亮点说明"整节(标题 + 其后所有内容)
  const secIdx = paras.findIndex((p) => TRAILING_SECTION_RE.test(p.split("\n")[0].trim()));
  // 只在它确实位于后半部分时才砍, 避免正文开头就叫"说明"的极端情况
  if (secIdx > 0 && secIdx >= paras.length / 2) paras = paras.slice(0, secIdx);

  // 2b) 定位正文起点。
  // 不能"遇到不匹配就停": AI 的开场常是 标题行 + 若干说明段, 例如
  //   "重写第一集" / "为了契合…我为你重写了第一集。" / "本集重点强化了…"
  // 其中标题行不匹配 OPENING_RE, 一停就把整段前言留下了(用户实测踩到的正是这个)。
  //
  // 但也不能见到"像正文"的段就无脑从那里切: 正文自己的开头几段可能是普通叙述
  // (如"林浩说明了来意。"), 后面才出现台词行 —— 那样会把正文开头削掉。
  // 折中: 只跳过**确实像解说**的前导段(命中 OPENING_RE, 或是不含正文特征的
  // 短标题行), 一旦遇到既不像解说、也不是标题的段落就停下。
  while (paras.length > 1) {
    const p = stripMarkdown(paras[0]);
    if (looksLikeBody(paras[0])) break;                   // 已是正文
    const isExplain = OPENING_RE.test(p);
    // 短标题行: 不含句末标点、长度很短(如"重写第一集"), 且后面还有内容
    const isTitle = p.length <= 20 && !/[。！？!?]$/.test(p);
    if (!isExplain && !isTitle) break;
    paras.shift();
  }
  // 2c) 循环剥离结尾的追问/总结段
  while (paras.length > 1 && !looksLikeBody(paras[paras.length - 1])
         && CLOSING_RE.test(stripMarkdown(paras[paras.length - 1]))) {
    paras.pop();
  }
  // 2d) 去掉首尾残留的分隔线段
  while (paras.length && /^[-*_]{3,}$/.test(paras[0])) paras.shift();
  while (paras.length && /^[-*_]{3,}$/.test(paras[paras.length - 1])) paras.pop();

  return stripMarkdown(paras.join("\n\n"));
}

/** 一个段落及其"是否算正文"的判定结果。用于在气泡里高亮 + 让用户点选调整。 */
export type Segment = {
  /** 原始段落文本(未去 Markdown, 用于在气泡里原样比对/渲染) */
  raw: string;
  /** 去掉 Markdown 修饰后的文本 —— 真正写入草稿的是这个 */
  clean: string;
  /** 默认是否选中(即自动判断的结果) */
  suggested: boolean;
};

/**
 * 把 AI 回复切成段落, 并逐段判断"是不是要写进草稿的正文"。
 *
 * 为什么要暴露到段落粒度: 靠正则猜"改写说明:"这类前缀是无底洞 —— 每出现一个
 * 新变体就得回来补一次(用户已连续反馈两轮)。改成把判断结果**可见化**:
 * 气泡里高亮选中的段, 用户点一下就能加/减, 猜错的成本从"写脏数据"降到"点一下"。
 */
export function segmentReply(text: string): Segment[] {
  const raw = (text || "").replace(/\r\n/g, "\n");
  if (!raw.trim()) return [];

  // 有代码围栏时: 围栏内是正文, 围栏外一律不是(这个信号最强, 直接分段返回)
  if (/```[^\n]*\n[\s\S]*?```/.test(raw)) {
    const segs: Segment[] = [];
    const re = /```[^\n]*\n([\s\S]*?)```/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const before = raw.slice(last, m.index).trim();
      if (before) segs.push({ raw: before, clean: stripMarkdown(before), suggested: false });
      const inner = m[1].trim();
      if (inner) segs.push({ raw: m[0], clean: stripMarkdown(inner), suggested: true });
      last = m.index + m[0].length;
    }
    const tail = raw.slice(last).trim();
    if (tail) segs.push({ raw: tail, clean: stripMarkdown(tail), suggested: false });
    return segs;
  }

  const paras = raw.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return [];

  // 尾部"设计亮点说明/改写说明"整节: 从标题起到结尾全部不选
  let sectionFrom = paras.findIndex((p) => TRAILING_SECTION_RE.test(p.split("\n")[0].trim()));
  if (!(sectionFrom > 0 && sectionFrom >= paras.length / 2)) sectionFrom = -1;

  // 前导解说区: 与 extractBody 同一套判定(命中解说词, 或无句末标点的短标题行)
  let bodyStart = 0;
  while (bodyStart < paras.length - 1) {
    const p = stripMarkdown(paras[bodyStart]);
    if (looksLikeBody(paras[bodyStart])) break;
    const isTitle = p.length <= 20 && !/[。！？!?]$/.test(p);
    if (!OPENING_RE.test(p) && !isTitle) break;
    bodyStart++;
  }

  return paras.map((p, i) => {
    const clean = stripMarkdown(p);
    let suggested = i >= bodyStart;
    if (sectionFrom >= 0 && i >= sectionFrom) suggested = false;
    // 结尾的追问/总结段
    if (suggested && !looksLikeBody(p) && CLOSING_RE.test(clean)) suggested = false;
    // 纯分隔线不算正文
    if (/^[-*_]{3,}$/.test(clean)) suggested = false;
    if (!clean) suggested = false;
    return { raw: p, clean, suggested };
  });
}

// ---------------------------------------------------------------------------
// 集号推断
// ---------------------------------------------------------------------------

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** "十二" → 12; "二十" → 20; "三十五" → 35。只处理 100 以内, 够用。 */
export function cnToNum(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (!s) return null;
  const idx = s.indexOf("十");
  if (idx === -1) return CN_NUM[s] ?? null;
  const tens = idx === 0 ? 1 : CN_NUM[s.slice(0, idx)] ?? null;
  if (tens == null) return null;
  const rest = s.slice(idx + 1);
  if (!rest) return tens * 10;
  const ones = CN_NUM[rest] ?? null;
  return ones == null ? null : tens * 10 + ones;
}

/** 从一句话里抓「第X集/章/话」。抓不到返回 null。 */
export function parseEpisodeNo(text: string): number | null {
  const m = (text || "").match(/第\s*([0-9]{1,3}|[一二两三四五六七八九十]{1,4})\s*[集章话]/);
  if (!m) return null;
  return cnToNum(m[1]);
}

// ---------------------------------------------------------------------------
// 类型推断
// ---------------------------------------------------------------------------

/**
 * 从用户原话里抓「转写成 X / 改写成 X」的目标类型。
 *
 * ⚠ 这条规则很关键: "根据第一集原文转写成小说" 的源是原文、目标是小说,
 * 同集号但不同产物。若只推断集号不推断类型, 会把小说正文写回原文
 * —— 直接覆盖掉源头。故「转写成 X」时目标一律是 X, 绝不写回原文。
 */
export function parseTargetKind(userMsg: string): ReplaceKind | null {
  const t = userMsg || "";
  // "转写成/改写成/写成/生成/变成 + 类型", 类型词允许跟在几个字之后
  const m = t.match(/(?:转写|改写|重写|写|生成|变|做)\s*成[^\n]{0,6}?(剧本|分镜|小说|推文|原文|正文|章节)/);
  if (m) {
    const w = m[1];
    if (w === "剧本" || w === "分镜") return "storyboard";
    if (w === "小说") return "novel";
    if (w === "推文") return "tweet";
    return "chapter";   // 原文 / 正文 / 章节
  }
  return null;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export type DetectInput = {
  /** AI 回复原文 */
  replyText: string;
  /** 当前选中的对话模式 key (novel/tweet/storyboards/chapters/...) */
  mode: string | null;
  /** 触发这条回复的用户消息 */
  userMsg: string;
  /** 本轮引用过的章节集号(📎 附件) */
  attachedOrder?: number | null;
  /** 右侧分屏正在看的集号 */
  splitOrder?: number | null;
  /** 用户在气泡里手动选中的文字; 有值时一律优先 */
  selectedText?: string | null;
  /** 用户点选后的段落集合(段落下标 → 是否选中)。传入时覆盖自动判断。 */
  segmentPicks?: Record<number, boolean> | null;
};

export function detectReplaceable(input: DetectInput): Detection {
  const { replyText, mode, userMsg, attachedOrder, splitOrder, selectedText, segmentPicks } = input;

  // 正文来源优先级:
  //   1. 划选的文字(最强的用户意图)
  //   2. 段落点选结果(高亮里加/减过的)
  //   3. 自动判断
  const sel = (selectedText || "").trim();
  const segs = segmentReply(replyText);
  let body: string;
  if (sel) {
    body = sel;
  } else if (segs.length) {
    body = segs
      .filter((sg, i) => (segmentPicks && i in segmentPicks) ? segmentPicks[i] : sg.suggested)
      .map((sg) => sg.clean)
      .filter(Boolean)
      .join("\n\n")
      .trim();
  } else {
    body = extractBody(replyText);
  }

  // --- 类型 ---
  // 1) 用户原话里的"转写成 X" 最明确(它同时防止写回源头)
  // 2) 当前对话模式 = 用户的显式声明
  // 3) 文本特征兜底: 能解析出场头就是剧本
  let kind: ReplaceKind | null = parseTargetKind(userMsg);
  if (!kind && mode) kind = MODE_TO_KIND[mode] ?? null;

  const shots = body ? textToShots(body) : [];
  // 有场头才算真的剧本格式(textToShots 对纯散文会造一个隐式场, 不能当数据用)
  const sceneCount = shots.filter((s) => s.scene_no != null || s.shot_type || s.location).length;
  if (!kind && sceneCount > 0) kind = "storyboard";

  // --- 集号 ---
  const chapterOrder =
    parseEpisodeNo(userMsg) ??
    (attachedOrder ?? null) ??
    (splitOrder ?? null);

  // 剧本闸门: 目标是剧本却解析不出场头 → 硬塞会把整段挤进一个隐式场的 action,
  // 表面成功、结构烂掉。此时不给替换按钮。
  const storyboardUnparseable = kind === "storyboard" && body.length > 0 && sceneCount === 0;

  return {
    body,
    kind,
    chapterOrder,
    confident: kind != null && chapterOrder != null && !storyboardUnparseable,
    storyboardUnparseable,
    sceneCount,
  };
}
