"use client";

// 对话工坊 v3 · 动作栏（按**意图**分组, 不按草稿页的 tab 分）
//
// 设计约束（来自用户原话，逐条对应）：
//   1. 「用户可能根本不知道什么命令能触发什么，也不知道我们的平台能做什么。
//      而复杂的教程他们一定不会看」
//      → 每个按钮 title 里写"点了会发生什么"的人话；每个分组只有一句小标题；
//        首次进入时在按钮上方飘一行一次性引导（localStorage 只出现一次，不打扰）。
//   2. 「不能让用户在各个页面中来回跳转」——主体是对话工坊
//      → 这些按钮**全部长在对话工坊的输入框上方**。用户从头到尾不离开这个页面：
//        体检结果以卡片形式出现在对话流里，点「让 AI 改这个」就地改，改完在
//        同一条对话里接着聊。草稿页只是"看结果"的地方，不是必经之路。
//   3. 按钮**点击即发**（2026-09 改）—— 以前是"把一句人话填进输入框、等用户按发送"。
//      改的理由：那一步在用户眼里是纯粹的额外操作（点一次按钮 + 再按一次回车），
//      而且很容易漏（点了按钮以为已经发了，其实还停在输入框）。现在按钮带结构化字段
//      直接走后端确定性分支（check/fix/rewrite/generate/deai），点一下必然出结果。
//      手打消息仍然走纯对话，两条路互不干扰。
//   4. 检查/精修/去AI味这些能力**只能从按钮进来**，自然语言不再触发 —— 用户原话：
//      "操作链显然提升了，bug 率也在增加"。语义收口在后端的 action 字段，不在模型判断。
//
// 三组意图（用户给的 5 个入口收进这三组里）：
//   查 = 检查结构 / 检查文风 / 查一致性 / 检查分镜      （体检，只读）
//   生 = 生成大纲 / 生成正文 / 生成剧本 / 一键生成整本    （生成，长任务）
//   改 = 精修这批 / 让 AI 改选中问题                     （改写，覆写）
// 「总览[一键体检]」= 查组的整卡入口, 一次跑四类。

import { useState } from "react";
import {
  ShieldCheck, Palette, Users, Film, Sparkles, ChevronDown,
  PenLine, Wand2, BookOpen, Layers, Loader2, X, GraduationCap, Check, Eraser, GitCompare,} from "lucide-react";

export type ActionSpec = {
  key: string;                       // 稳定 id（用于"用过没有"的记忆）
  label: string;
  hint: string;                      // hover 时的人话说明：点了会发生什么
  send: string;                      // 作为 user_input 发出去的那句话（进对话流，用户能看到自己点了什么）
  action: "check" | "fix" | "rewrite" | "generate" | "deai" | null;
  kinds?: string[];                  // check 用
  genKind?: "outline" | "chapters" | "storyboards" | "novel" | "tweet";  // generate 用
  // 补充说明（如"秒出·不花钱"）。
  // ⚠️ 必须渲染成 absolute 浮层、**不能**再影响按钮宽度 —— 见下面按钮处的注释。
  chip?: string;
};

export type RewriteTarget = 'chapter' | 'storyboard';

export type ActionScope = {
  start_ep: number | null;
  end_ep: number | null;
  /**
   * 「精修这批」改哪一层：正文（原文）还是剧本（分镜）。
   *
   * ⚠️ 没有"自动"这一项，而且是**必选**（默认落在剧本上，因为精修的定位是打磨
   * 可拍摄的剧本）。2026-10-06 用户裁定：改哪一层必须由用户说了算。
   * 此前是后端按"有剧本就整本按剧本"偷偷决定的 —— 用户圈了想改正文的集，
   * 系统去剧本表找不到就整批失败，他还不知道系统替他选了层。
   *
   * 生成类动作（生成正文/剧本）不看这个字段，它们各自有明确的 genKind。
   */
  target: RewriteTarget;
};

export const CHECK_ACTIONS: ActionSpec[] = [
  {
    key: "check_structure", label: "检查结构", chip: "秒出·不花钱",
    hint: "检查大纲：分集节奏、契约字段缺没缺、钩子够不够。纯规则检查，不调模型、不扣费、秒出结果。",
    send: "帮我检查一下大纲结构，看看分集节奏和该有的字段有没有缺。",
    action: "check", kinds: ["structure"],
  },
  {
    key: "check_style", label: "检查文风", chip: "秒出·不花钱",
    hint: "检查中文文风：翻译腔、AI 味、滥用破折号、句子过长。纯规则检查，不调模型、不扣费。",
    send: "帮我检查一下文风，看有没有翻译腔、AI 味、破折号滥用这些问题。",
    action: "check", kinds: ["style"],
  },
  {
    key: "check_consistency", label: "查一致性", chip: "要调模型",
    hint: "查跨集一致性：人名漂移、设定前后矛盾、时间线冲突。人名部分是零成本规则检查，语义部分要调模型。",
    send: "帮我查一下全剧的一致性问题，重点看人名、设定和时间线有没有前后矛盾。",
    action: "check", kinds: ["consistency"],
  },
  {
    key: "check_script", label: "检查分镜", chip: "秒出·不花钱",
    hint: "检查剧本格式：场次能不能被系统拆开、场景/人物/台词写法是否规范。格式坏了下游出不了片。",
    send: "帮我检查一下剧本格式，看场次和台词写法是不是规范、能不能被系统解析。",
    action: "check", kinds: ["script"],
  },
  {
    key: "check_divergence", label: "查大纲分岔", chip: "秒出·不花钱",
    hint: "查「大纲计划 vs 稿子实际」对不上的地方：人物是不是提前/推迟死了、该埋的伏笔埋没埋、该收的收没收。"
      + "只告诉你哪儿不一致，不会替你改任何东西。",
    send: "帮我查一下大纲和实际稿子有哪些对不上的地方。",
    action: "check", kinds: ["divergence"],
  },
  {
    key: "check_all", label: "一键体检", chip: "全查一遍",
    hint: "五类一起查（结构 + 文风 + 一致性 + 剧本 + 大纲分岔），出一张完整报告卡。想先摸清整部剧的底细就点这个。",
    send: "帮我做一次完整体检，结构、文风、一致性、剧本、大纲分岔都要查。",
    action: "check",
  },
];

// 生成类三件事。**用户原话**："生成大纲/生成正文/生成剧本三个功能不需要这么显眼
// （用户常用的反而应该是专业方法中的那些预设）"。
// 所以它们不再各占一颗带色药丸，收进一个低调的「生成 ▾」下拉，摆在专业方法旁边。
//
// 另外这三条**不再依赖 Agent 循环**：以前它们 action=null，只把一句人话填进输入框
// （"帮我写一版分集大纲。"），指望模型自己读懂并调 start_generation —— 实测经常
// 直接就报错/什么都没发生（agent_jobs 表里 gen_* 一行都没有，说明错在入队之前）。
// 现在它们带着 action="generate" + genKind 走确定性的后端分支，点一下必然产生作业。
export const GEN_ACTIONS: ActionSpec[] = [
  {
    key: "gen_outline", label: "生成大纲",
    hint: "按你给的题材/集数重新生成一版分集大纲（长任务，可以关页面，跑完直接生效）。",
    send: "帮我写一版分集大纲。",
    action: "generate", genKind: "outline",
  },
  {
    key: "gen_chapters", label: "生成正文",
    hint: "按现有大纲生成/续写正文（长任务，几十集会在后台分批跑完）。需要先有大纲。你在上面圈了范围就只做那几集；只想要一两集的话，直接说「写第3集」，AI 会当场把正文写给你，不用等后台。",
    send: "按大纲把正文生成出来。",
    action: "generate", genKind: "chapters",
  },
  {
    key: "gen_storyboards", label: "生成剧本",
    hint: "把正文改写成可拍摄的剧本（场次/场景/人物/台词），生成的剧本能被系统解析成镜头。需要先有正文。圈了范围就只做那几集。",
    send: "把正文改写成剧本。",
    action: "generate", genKind: "storyboards",
  },
  {
    key: "gen_novel", label: "生成小说", chip: "要调模型",
    hint: "把现有正文逐章改写成小说体（增加描写与心理）。产出在右栏「小说」页签，"
      + "不改动原稿。长任务，可以关页面。",
    send: "把正文改写成小说版。",
    action: "generate", genKind: "novel",
  },
  {
    key: "gen_tweet", label: "生成推文", chip: "要调模型",
    hint: "把现有正文逐章改写成第一人称推文体。主角由 AI 自动挑一个并在回执里告诉你，"
      + "想换人直接在对话里说。产出在右栏「推文」页签，不改动原稿。",
    send: "把正文改写成推文版。",
    action: "generate", genKind: "tweet",
  },
];

export const FIX_ACTIONS: ActionSpec[] = [
  {
    key: "rewrite_scoped", label: "精修这批",
    hint: "对选定的集做整批重写：先通读全剧做诊断，再逐批重写。会**覆写**草稿（每集存历史可回滚），范围外的集一字不碰。先用上面的范围按钮圈好集数再点。",
    send: "把我圈的这批集精修一遍：",
    action: "rewrite",
  },
  {
    key: "deai_clean", label: "去 AI 味", chip: "改原稿",
    hint: "清掉 AI 腔（句式同构、段末升华、排比堆叠、形容词通胀），**直接改在这部剧里**。只改文字腔调，场次、行数、说话人都不变；每集改之前先存历史，跑完点顶栏「看改动」逐集对照，不满意的集可在历史里恢复。按上面圈的范围处理，不圈 = 全剧。长任务，可以关页面。",
    send: "帮我把这部剧去一下 AI 味。",
    action: "deai",
  },
  {
    key: "deai_copy", label: "去 AI 味（副本）", chip: "原稿不动",
    hint: "先把这部剧完整复制一份，**改在副本里**，原稿一个字都不动。跑完对话里会给出副本的链接。按上面圈的范围处理，不圈 = 全剧。",
    send: "帮我把这部剧去一下 AI 味，建个副本改在副本里，原稿别动。",
    action: "deai",
  },
];

const GUIDE_KEY = "chat_studio_actionbar_seen";

export default function ActionBar({
  disabled,
  busy,
  draftId,
  maxEp,
  scope,
  onScopeChange,
  onPick,
  modes,
  selectedMode,
  onModeChange,
  genKind,
  genJob,
  onGenPick,
}: {
  disabled?: boolean;
  busy?: boolean;
  draftId: number | null;
  maxEp: number | null;
  scope: ActionScope;
  onScopeChange: (s: ActionScope) => void;
  onPick: (a: ActionSpec) => void;
  // 专业方法（原「对话模式」pill 排）：/v1/agent/modes 下发的隐藏提示词框架。
  // 它和上面三组是**正交**的两件事 —— 上面选"干什么"，这里选"用哪套方法干"。
  // 原来它独占一整行、和动作栏抢位置；现在收成一个下拉放在最右，需要时才展开。
  modes: { key: string; label: string; desc: string }[];
  selectedMode: string | null;
  onModeChange: (key: string | null) => void;
  // 生成类（原「生」组）收进下拉后的状态：最近一次点了哪一项、当前有没有生成作业在跑。
  // 下拉按钮上显示"生成中 · 生成正文 45%"，用户不展开也知道后台在干活。
  genKind: "outline" | "chapters" | "storyboards" | "novel" | "tweet" | null;
  genJob: { id: number; kind: string; progress: number | null; note: string | null } | null;
  onGenPick: (a: ActionSpec) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // 一次性引导：只出现一次，用户关掉就永久消失（localStorage）。
  // "复杂的教程他们一定不会看" —— 所以不写教程，只在这里飘一行，出现一次。
  const [guide, setGuide] = useState(() => {
    try { return !localStorage.getItem(GUIDE_KEY); } catch { return false; }
  });
  const dismissGuide = () => {
    setGuide(false);
    try { localStorage.setItem(GUIDE_KEY, "1"); } catch { /* 隐私模式等, 忽略 */ }
  };

  const noDraft = !draftId;
  // ⚠️ 「生」**不在**这里 —— 用户要求它别那么显眼，见上面 GEN_ACTIONS 的注释。
  // 三颗带色药丸会跟"查/改"抢注意力，而用户真正常用的是「专业方法」里的预设。
  const groups: { key: string; title: string; items: ActionSpec[]; tone: string }[] = [
    { key: "check", title: "查", items: CHECK_ACTIONS, tone: "text-primary" },
    { key: "fix", title: "改", items: FIX_ACTIONS, tone: "text-warning" },
  ];
  const genPicked = GEN_ACTIONS.find((g) => g.key === `gen_${genKind}`);
  const genBusy = genJob != null;

  const epOpts = maxEp && maxEp > 0 ? Array.from({ length: maxEp }, (_, i) => i + 1) : [];

  return (
    <div className="border-t border-line bg-surface-base/60 px-3 pt-2 pb-1.5">
      {guide && (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5">
          <Sparkles className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
          <div className="text-[11px] leading-snug text-ink-secondary flex-1">
            下面这些按钮<span className="text-ink-primary font-medium">点一下就开始跑</span>
            （查体检、改稿、生成都在这儿）。想跟 AI 随便聊，直接在下面打字发就行 ——
            聊出来的文本可以选中后一键写进草稿。
          </div>
          <button onClick={dismissGuide} className="p-0.5 rounded hover:bg-surface-overlay shrink-0" title="知道了，不再提示">
            <X className="w-3 h-3 text-ink-muted" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {groups.map((g) => (
          <div key={g.key} className="flex items-center gap-1">
            <span className={`text-[10px] font-bold ${g.tone} w-3 text-center`}>{g.title}</span>
            {g.items.map((it) => (
              <button
                key={it.key}
                disabled={disabled || noDraft}
                onClick={() => onPick(it)}
                title={noDraft
                  ? "先在右侧选一部剧本（或把对话关联到草稿），这类操作需要先有剧本。"
                  : it.hint}
                className="relative group px-2 py-1 rounded-full border border-line bg-surface-overlay hover:border-primary/60 hover:bg-surface-raised disabled:opacity-40 disabled:cursor-not-allowed text-[11px] text-ink-secondary hover:text-ink-primary transition flex items-center gap-1"
              >
                <IconFor k={it.key} />
                {it.label}
                {/* 补充说明走 absolute 浮层，**不占布局**。
                    这里曾经写的是 `hidden group-hover:inline` —— 鼠标一进按钮，
                    chip 从 display:none 变成 inline，按钮瞬间变宽 → 外层 flex-wrap
                    重新折行 → 指针离开按钮 → chip 缩回 → 布局复原 → 指针又落回按钮……
                    如此往复就是用户看到的"整个工具条上下快速闪烁"。
                    只有查类按钮带 chip，所以只有它们闪。改成浮层后按钮宽度恒定，
                    悬停不再触发任何重排。 */}
                {it.chip && (
                  <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block whitespace-nowrap rounded bg-surface-overlay border border-line px-1.5 py-0.5 text-[10px] text-ink-muted shadow-lg z-40">
                    {it.chip}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}

        {/* 范围选择：对"改"和"生"都有意义（查找的是全剧）。放在这里是因为用户圈范围
            和点"精修这批"/"生成正文"是同一个动作的两半，分开摆会让他先点按钮再回头找范围。
            生成大纲是整本行为，没有范围语义 —— 后端会忽略，前端也不给它带。 */}
        <div className="relative flex items-center gap-1">
          <button
            disabled={disabled || noDraft}
            onClick={() => setOpen(open === "scope" ? null : "scope")}
            title="精修/生成的范围：整本，或只处理你圈的这几集（范围外的集一字不碰）"
            className={`flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] transition disabled:opacity-40 ${
              open === "scope" ? "bg-surface-raised border-primary/60" : "bg-surface-overlay border-line hover:bg-surface-raised"
            }`}
          >
            <Layers className="w-3 h-3 text-primary shrink-0" />
            <span className="text-ink-primary">{scopeLabel(scope)}</span>
            <ChevronDown className="w-3 h-3 text-ink-muted" />
          </button>
          {open === "scope" && (
            <div className="absolute bottom-full right-3 mb-1 z-40 w-64 bg-surface-raised border border-line rounded-lg shadow-xl p-2.5">
              <div className="text-[11px] text-ink-secondary mb-1.5">
                {busy ? <Loader2 className="w-3 h-3 inline animate-spin mr-1" /> : null}
                精修 / 生成的范围
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                <button onClick={() => { onScopeChange({ ...scope, start_ep: null, end_ep: null }); setOpen(null); }}
                  className={`px-2 py-0.5 rounded-full text-[11px] border ${!scope.start_ep && !scope.end_ep ? "bg-primary text-white border-primary" : "bg-surface-overlay border-line"}`}>
                  整本
                </button>
              </div>
              {epOpts.length === 0 ? (
                <div className="text-[10px] text-ink-muted">草稿里还没有集，生成之后再选范围。</div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
                    <span>从</span>
                    <select
                      value={scope.start_ep ?? ""}
                      onChange={(e) => onScopeChange({ ...scope, start_ep: e.target.value ? Number(e.target.value) : null })}
                      className="bg-surface-overlay border border-line rounded px-1.5 py-0.5 text-[11px] outline-none focus:border-primary"
                    >
                      <option value="">第 1 集</option>
                      {epOpts.map((n) => <option key={n} value={n}>第 {n} 集</option>)}
                    </select>
                    <span>到</span>
                    <select
                      value={scope.end_ep ?? ""}
                      onChange={(e) => onScopeChange({ ...scope, end_ep: e.target.value ? Number(e.target.value) : null })}
                      className="bg-surface-overlay border border-line rounded px-1.5 py-0.5 text-[11px] outline-none focus:border-primary"
                    >
                      <option value="">第 {maxEp} 集</option>
                      {epOpts.map((n) => <option key={n} value={n}>第 {n} 集</option>)}
                    </select>
                  </div>
                  <div className="text-[10px] text-ink-muted mt-1.5 leading-snug">
                    「精修这批」诊断会通读全剧（跨集矛盾只有通读才看得出），但
                    <span className="text-ink-primary">只有范围内的集会被改写</span>
                    ；「生成正文 / 生成剧本」则<span className="text-ink-primary">只做范围内的集</span>，
                    范围外一字不碰。
                  </div>
                </>
              )}

              {/* 改哪一层 —— 「精修这批」专用。
                  ⚠️ 只对 rewrite 有意义，不摆"自动"这一项：用户裁定改哪一层必须自己说了算。
                  层不存在时不在这里禁用（前端不知道逐层存在性，硬禁用会误伤），
                  由后端给出人话失败提示。 */}
              <div className="mt-2.5 pt-2 border-t border-line">
                <div className="text-[11px] text-ink-secondary mb-1">「精修这批」改哪一份稿子</div>
                <div className="flex gap-1">
                  {([['storyboard', '剧本', '可拍摄的分镜稿'],
                    ['chapter', '正文', '原文 / 小说体']] as const).map(([k, label, desc]) => (
                    <button
                      key={k}
                      onClick={() => onScopeChange({ ...scope, target: k })}
                      title={desc}
                      className={`flex-1 px-2 py-1 rounded border text-[11px] transition ${
                        scope.target === k
                          ? 'bg-primary/15 border-primary/60 text-ink-primary'
                          : 'bg-surface-overlay border-line text-ink-secondary hover:bg-surface-raised'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="text-[10px] text-ink-muted mt-1 leading-snug">
                  只改这一层，不会动另一层。选的那一层没有内容时会给提示，不会自动换成另一层。
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 生成（原「生」组）：用户原话"生成大纲/生成正文/生成剧本不需要这么显眼"，
            故从三颗带色药丸收成一个低调下拉，紧靠专业方法。

            这个 div 带的 `ml-auto` 是这一行**唯一**的右推器：它把"生成 + 专业方法"
            两个下拉一起顶到右边。上面"查/改"两组会因为宽度折行，若别的元素也挂
            ml-auto，就会被折到第二行、掉到范围选择下面，看上去像另一组功能。 */}
        <div className="relative ml-auto flex items-center gap-1">
          <button
            disabled={disabled || noDraft || genBusy}
            onClick={() => setOpen(open === "gen" ? null : "gen")}
            title={noDraft
              ? "先在右侧选一部剧本（或把对话关联到草稿），生成需要先有剧本。"
              : "按你已有的内容往下生成：大纲 / 正文 / 剧本。点开选一项。"}
            className={`flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] transition disabled:opacity-40 ${
              open === "gen" || genKind || genBusy
                ? "bg-surface-raised border-line"
                : "bg-surface-overlay border-line hover:bg-surface-raised"
            }`}
          >
            {genBusy
              ? <Loader2 className="w-3 h-3 text-emerald-500 shrink-0 animate-spin" />
              : <Sparkles className={`w-3 h-3 shrink-0 ${genKind ? "text-emerald-500" : "text-ink-muted"}`} />}
            <span className={genKind || genBusy ? "text-ink-secondary" : "text-ink-muted"}>
              {genBusy
                ? `生成中${genJob?.progress != null ? ` ${genJob.progress}%` : ""}`
                : genPicked ? genPicked.label : "生成"}
            </span>
            <ChevronDown className="w-3 h-3 text-ink-muted" />
          </button>
          {open === "gen" && (
            <div className="absolute bottom-full right-0 mb-1 z-40 w-72 bg-surface-raised border border-line rounded-lg shadow-xl p-1">
              <div className="px-2.5 py-1.5 text-[10px] text-ink-muted leading-snug">
                按现有内容往下生成。三条都是长任务，可以关掉页面，跑完直接生效。
              </div>
              {GEN_ACTIONS.map((it) => (
                <button
                  key={it.key}
                  disabled={disabled || noDraft}
                  onClick={() => { onGenPick(it); setOpen(null); }}
                  className="w-full text-left px-2.5 py-1.5 rounded hover:bg-surface-overlay transition disabled:opacity-40"
                >
                  <div className="flex items-center gap-1.5 text-[11px] text-ink-primary font-medium">
                    <IconFor k={it.key} />
                    {it.label}
                    {genKind === it.genKind && <Check className="w-3 h-3 text-primary ml-auto" />}
                  </div>
                  <div className="text-[10px] text-ink-muted mt-0.5 leading-snug">{it.hint}</div>
                </button>
              ))}
              {genJob && (
                <div className="px-2.5 py-1.5 mt-0.5 border-t border-line text-[10px] text-ink-secondary leading-snug">
                  作业 #{genJob.id} {genJob.note ? `· ${genJob.note}` : "进行中"}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 「回复方式」（原「专业方法」）：和上面三组**正交** —— 上面是"干什么"，
            这里是"回什么"。选中后后端注入隐藏提示词框架，决定 AI 用什么口径回你。
            2026-09 改名：原名"专业方法"太抽象，用户看不出选了会发生什么；
            "回复方式"直接对应"我想要什么形式的回答"。
            ⚠️ 其中「小说」「推文」两项不是格式而是**改写口径**（把原文变成小说体/
            第一人称推文），desc 里已点明，避免用户以为选了它们就只是换个排版。 */}
        {modes.length > 0 && (
          <div className="relative flex items-center gap-1">
            <button
              disabled={disabled}
              onClick={() => setOpen(open === "mode" ? null : "mode")}
              title="回复方式：告诉 AI 你想拿到什么形式的回复（可多选一个）。其中「小说」「推文」会把原文改写成另一种文体，不只是换格式。"
              className={`flex items-center gap-1 px-2 py-1 rounded-full border text-[11px] transition disabled:opacity-40 ${
                open === "mode" || selectedMode ? "bg-surface-raised border-primary/60" : "bg-surface-overlay border-line hover:bg-surface-raised"
              }`}
            >
              <GraduationCap className="w-3 h-3 text-primary shrink-0" />
              <span className={selectedMode ? "text-ink-primary" : "text-ink-secondary"}>
                {selectedMode ? (modes.find((m) => m.key === selectedMode)?.label ?? "回复方式") : "回复方式"}
              </span>
              <ChevronDown className="w-3 h-3 text-ink-muted" />
            </button>
            {open === "mode" && (
              <div className="absolute bottom-full right-0 mb-1 z-40 w-72 max-h-80 overflow-y-auto bg-surface-raised border border-line rounded-lg shadow-xl p-1">
                <div className="px-2.5 py-1.5 text-[10px] text-ink-muted leading-snug">
                  想让 AI 用什么方式回你？（不影响上面的按钮，只改它怎么答）
                </div>
                {modes.map((mo) => {
                  const active = selectedMode === mo.key;
                  return (
                    <button
                      key={mo.key}
                      onClick={() => { onModeChange(active ? null : mo.key); setOpen(null); }}
                      className={`w-full text-left px-2.5 py-1.5 rounded transition ${active ? "bg-primary/10" : "hover:bg-surface-overlay"}`}
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-ink-primary font-medium">
                        {mo.label}
                        {active && <Check className="w-3 h-3 text-primary ml-auto" />}
                      </div>
                      <div className="text-[10px] text-ink-muted mt-0.5 leading-snug">{mo.desc}</div>
                    </button>
                  );
                })}
                {selectedMode && (
                  <button
                    onClick={() => { onModeChange(null); setOpen(null); }}
                    className="w-full text-left px-2.5 py-1.5 rounded text-[11px] text-ink-muted hover:text-danger hover:bg-surface-overlay transition"
                  >
                    不用方式（清除）
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function scopeLabel(s: ActionScope): string {
  const a = s.start_ep, b = s.end_ep;
  let base: string;
  if (a && b) base = `第${Math.min(a, b)}-${Math.max(a, b)}集`;
  else if (a) base = `第${a}集起`;
  else if (b) base = `到第${b}集`;
  else base = "整本";
  // 带上层级，让用户在点「精修这批」之前就能从按钮上看出要改的是哪一份稿子 ——
  // 这正是这次改动要解决的痛点（以前层是后端偷偷定的，按钮上完全看不出来）。
  return `${base}·${s.target === 'chapter' ? '正文' : '剧本'}`;
}

function IconFor({ k }: { k: string }) {
  const c = "w-3 h-3 shrink-0";
  if (k.startsWith("check_")) {
    if (k === "check_style") return <Palette className={`${c} text-primary`} />;
    if (k === "check_consistency") return <Users className={`${c} text-primary`} />;
    if (k === "check_script") return <Film className={`${c} text-primary`} />;
    if (k === "check_divergence") return <GitCompare className={`${c} text-primary`} />;
    if (k === "check_all") return <ShieldCheck className={`${c} text-primary`} />;
    return <BookOpen className={`${c} text-primary`} />;
  }
  if (k === "rewrite_scoped") return <Wand2 className={`${c} text-warning`} />;
  // 去 AI 味：和「去 AI 味工作室」页头用同一个 Eraser 图标，用户一眼认得出是同一件事。
  if (k === "deai_clean") return <Eraser className={`${c} text-warning`} />;
  if (k === "gen_chapters") return <PenLine className={`${c} text-emerald-500`} />;
  return <Sparkles className={`${c} text-emerald-500`} />;
}
