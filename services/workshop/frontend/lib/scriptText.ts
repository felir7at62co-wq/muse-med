/**
 * 剧本「全文视图」⇄「分镜结构」双向转换 (需求1 路线A)
 *
 * shots_json 是唯一真相; 全文视图把它拼成可编辑纯文本, 保存/切回时再解析回结构。
 * 采用可逆轻量格式, 贴合现有 △动作 / 角色:台词 约定。
 *
 * 单场格式:
 *   【场 {scene_no}｜{shot_type}｜{time_loc} {location}｜出场：A、B｜{duration}s】
 *   △动作行 (action, 可多行)
 *   角色：台词 (dialogue)
 *   注：备注 (notes)
 * 字段缺省允许; 解析尽量鲁棒, 不丢字。
 */

export type Shot = {
  shot_no?: number;
  scene_no?: string;
  time_loc?: string;
  shot_type?: string;
  location?: string;
  characters?: string[];
  action?: string;
  dialogue?: string;
  notes?: string;
  duration?: number;
  elements?: any[]; // 后端有序元素数组(动作/对白按拍摄时序穿插), 是渲染的首选真相
  [k: string]: any; // 保留未知字段(透传)
};

const HEAD_OPEN = "【场";
const HEAD_CLOSE = "】";

/**
 * 场头里承载"额外字段"的段前缀。
 *
 * ## 为什么需要它
 * 场头（`【场 2-1｜中景｜…】`）只装得下几个固定字段，而 shot 里还有
 * `subtitle` / `is_flashback` / `shot_no` 等。此前它们**完全不进全文**，
 * 于是用户在全文字视图里点一次「保存」就被永久抹掉 ——
 * 其中 `subtitle` 会进 Word / txt 导出（`export_docx.py:63`、`export_text.py:21`），
 * 也就是**保存一次，字幕就从后续所有导出里消失**。
 *
 * ## 为什么用 `@` 而不是复用「注：」
 * 「注：」在数据里已经有明确语义（= `notes`），混用会让 notes 被污染。
 * `@` 开头的段在既有场头里不会自然出现，且解析上有明确优先级。
 *
 * ## 形如
 *   【场 2-1｜中景｜日 内…｜出场：…｜5s｜@shot_no=1｜@subtitle=大楚后宫｜@is_flashback=0】
 */
const EXTRA_PREFIX = "@";

/**
 * parseHead 认作 shot_type 的固定词表（与那里的判断**必须逐字一致**）。
 *
 * 两处各写一遍是刻意的取舍：写成共享常量要跨函数传参、而它们分属
 * "生成文本"与"解析文本"两个方向，改动时机不同。但**改了这里就必须改那里** ——
 * 不一致的后果是 shot_type 静默丢字段（保存一次就没了）。
 */
const SHOT_TYPE_RE = /^(远景|全景|中景|近景|特写|大特写|空镜|航拍|跟拍|推镜|拉镜|摇镜|俯拍|仰拍)/;

/**: 走 `@k=v` 通道的字段。**只放场头装不下、且会被下游读的**。
 *  加字段前先问：它在后端有消费方吗？没有就别加 —— 免得场头越来越长。 */
const EXTRA_KEYS = ["shot_no", "subtitle", "is_flashback", "narration", "ost", "monologue"] as const;

function encodeExtraField(shot: Shot, k: string): string | null {
  const v = (shot as any)[k];
  if (v === undefined || v === null || v === "") {
    // `shot_no` 缺席时**不发** `@shot_no=` —— textToShots 会按位置补 i+1，
    // 而绝大多数数据里 shot_no 本来就等于位置号，发与不发结果相同。
    // 只有"缺席"这一种情况补出来的值与原来不同（原为 undefined），
    // 但那 3/8839 条属于存量脏数据，且"有编号"比"保持无编号"更有用，
    // 所以接受这一处规范化，而不是为它再发明一个哨兵值。
    return null;
  }
  const s = escapeExtra(typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  return `${EXTRA_PREFIX}${k}=${s}`;
}

/** 单行安全形态 → 原文。**必须单趟扫描**，不能用链式 replace：
 *   `raw.replace(/\\n/g,'\n').replace(/\\p/g,'｜')` 会先吃掉 `\\n` 里的 `\n`，
 *   而反过来先还原 `\\` 又会把转义序列破坏掉。单趟按"遇到 \ 再看下一个字符"决定，
 *   天然可逆（含结尾反斜杠、字面量 `\n`、换行与竖线组合等 8 个用例验证过）。 */
function unescapeExtra(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === "n") { out += "\n"; i++; continue; }
      if (n === "p") { out += "｜"; i++; continue; }
      if (n === "\\") { out += "\\"; i++; continue; }
    }
    out += raw[i];
  }
  return out;
}

/** 文本 → 单行安全形态（转义反斜杠、换行、场头分隔符）。
 *  与 `unescapeExtra` 配对，必须成对使用。 */
function escapeExtra(s: string): string {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/[\n\r]+/g, "\\n")
    .replace(/｜/g, "\\p");
}

/**
 * 把"非常规元素"整体编码成一行文本（见 shotsToText 的兜底分支）。
 *
 * 为什么走 JSON 而不是"按动作渲染"：类型本身有语义 —— `subtitle` 不是画面描写，
 * 当成动作渲染虽然保住了字，却改变了它在分镜里的含义与下游解释。
 */
function encodeElPayload(e: any): string {
  return escapeExtra(JSON.stringify(e));
}

function decodeElPayload(s: string): any {
  return JSON.parse(unescapeExtra(s));
}

function decodeExtraField(kv: string, out: Partial<Shot>): void {
  // 无 `=` 的标记段（如 `@tl_dup`）：只设一个内部标记，由 parseHead 消费。
  if (!kv.includes("=")) {
    if (kv === "tl_dup") (out as any)._tl_dup = true;
    return;
  }
  const i = kv.indexOf("=");
  const k = kv.slice(0, i);
  const raw = kv.slice(i + 1);
  if (k === "shot_no") {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n)) out.shot_no = n;
    return;
  }
  if (k === "is_flashback") {
    out.is_flashback = raw === "1" || raw === "true";
    return;
  }
  if (k === "tl_only") {
    (out as any)._tl_only = raw;      // "t" | "l"
    return;
  }
  if (k === "shot_type") {
    // 不在固定词表里的写法（如「中近景 -> 特写」），由 `@shot_type=` 原样带回
    out.shot_type = unescapeExtra(raw);
    return;
  }
  // 还原转义（含换行）—— 见 unescapeExtra 的说明。
  (out as any)[k] = unescapeExtra(raw);
}

/**
 * 把一个镜头的 action(多段△画面) 与 dialogue(多段角色台词) 按逻辑顺序**交错**成有序行,
 * 解决"先堆全部画面、再堆全部对话"导致的观看割裂。
 *
 * 策略(尽量贴合观看逻辑, 纯前端启发式, 不依赖后端):
 *   1. action 按行拆成动作段(actLines), dialogue 按行拆成台词(dlgLines, 形如「角色：台词」)。
 *   2. 逐条台词, 找"最近一条尚未配对、且提及该台词角色"的动作段, 台词紧跟其后。
 *   3. 找不到对应角色的动作时, 台词就近附加到当前已输出的最后一个动作后; 仍没有则先落一条台词。
 *   4. 所有未被"带出"的动作段, 保持原相对顺序补齐。
 * 返回混合序列: { type: 'action' | 'dialogue', text, speaker? }[]
 */
export type ScriptLine = { type: "action" | "dialogue"; text: string; speaker?: string };

export function interleaveActionDialogue(action?: string, dialogue?: string): ScriptLine[] {
  const actLines = String(action || "")
    .split("\n")
    .map((s) => s.replace(/^△+/, "").trim())
    .filter(Boolean);
  const dlgLines = String(dialogue || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const parseSpeaker = (t: string) => t.match(/^([^：:【]{1,12})[【：:]/)?.[1]?.trim();

  // 只有一方有内容: 直接顺序输出
  if (!dlgLines.length) return actLines.map((t) => ({ type: "action" as const, text: t }));
  if (!actLines.length) {
    return dlgLines.map((t) => ({ type: "dialogue" as const, text: t, speaker: parseSpeaker(t) }));
  }

  const usedAct = new Array(actLines.length).fill(false);
  const usedDlg = new Array(dlgLines.length).fill(false);
  const out: ScriptLine[] = [];
  let lastActIdx = -1;

  const flushActionsUpTo = (idx: number) => {
    for (let k = lastActIdx + 1; k <= idx; k++) {
      if (!usedAct[k]) { out.push({ type: "action", text: actLines[k] }); usedAct[k] = true; }
    }
    lastActIdx = Math.max(lastActIdx, idx);
  };

  // 第一遍: 按"动作里提及说话角色名"精确配对(能配上多少配多少)
  let matchedCount = 0;
  dlgLines.forEach((dlg, di) => {
    const speaker = parseSpeaker(dlg);
    if (!speaker) return;
    let hitIdx = -1;
    for (let k = lastActIdx + 1; k < actLines.length; k++) {
      if (!usedAct[k] && actLines[k].includes(speaker)) { hitIdx = k; break; }
    }
    if (hitIdx === -1) {
      for (let k = 0; k < actLines.length; k++) {
        if (!usedAct[k] && actLines[k].includes(speaker)) { hitIdx = k; break; }
      }
    }
    if (hitIdx !== -1) {
      flushActionsUpTo(hitIdx);
      out.push({ type: "dialogue", text: dlg, speaker });
      usedDlg[di] = true;
      matchedCount++;
    }
  });

  const remainingAct = usedAct.filter((u) => !u).length;
  const remainingDlg = usedDlg.filter((u) => !u).length;

  // 如果精确配对命中率很低(<30% 台词被配上), 说明画面描述里基本不含角色名 →
  // 放弃"角色名匹配"结果, 改用"按比例均匀交替"整体重排, 避免"全台词压全动作"。
  if (matchedCount < dlgLines.length * 0.3) {
    const acts = actLines.map((t) => ({ type: "action" as const, text: t }));
    const dlgs = dlgLines.map((t) => ({ type: "dialogue" as const, text: t, speaker: parseSpeaker(t) }));
    return weaveByRatio(acts, dlgs);
  }

  // 否则: 已精确配对的保持在 out; 剩余动作/台词按比例均匀交织后接在末尾
  if (remainingAct || remainingDlg) {
    const acts: ScriptLine[] = [];
    for (let k = 0; k < actLines.length; k++) if (!usedAct[k]) acts.push({ type: "action", text: actLines[k] });
    const dlgs: ScriptLine[] = [];
    dlgLines.forEach((t, di) => { if (!usedDlg[di]) dlgs.push({ type: "dialogue", text: t, speaker: parseSpeaker(t) }); });
    out.push(...weaveByRatio(acts, dlgs));
  }
  return out;
}

/**
 * 把两组行按数量比例均匀交织(而非一组全部在前、另一组全部在后)。
 * 例: 5 动作 3 台词 → 动/动/白/动/白/动/白/动 之类, 让画面与对白视觉交替。
 */
function weaveByRatio(a: ScriptLine[], b: ScriptLine[]): ScriptLine[] {
  const out: ScriptLine[] = [];
  const na = a.length, nb = b.length;
  if (!na) return b.slice();
  if (!nb) return a.slice();
  let ia = 0, ib = 0;
  // 用"较多的一组"当主轴, 均匀插入另一组
  const total = na + nb;
  for (let step = 0; step < total; step++) {
    // 目标: 已输出中 a 的占比逼近 na/total
    const wantA = (ia + ib === 0) ? true : ia / (ia + ib) < na / total;
    if (ia < na && (wantA || ib >= nb)) { out.push(a[ia++]); }
    else if (ib < nb) { out.push(b[ib++]); }
    else if (ia < na) { out.push(a[ia++]); }
  }
  return out;
}

/** 把一集 shots 数组拼成可编辑全文。 */
export function shotsToText(shots: Shot[]): string {
  if (!Array.isArray(shots) || shots.length === 0) return "";
  const blocks = shots.map((s, i) => {
    const segs: string[] = [];
    segs.push(String(s.scene_no ?? s.shot_no ?? i + 1));
    // ⚠️ parseHead 只把**匹配固定词表**的那段认成 shot_type
    // （`远景|全景|中景|近景|特写|大特写|空镜|航拍|跟拍|推镜|拉镜|摇镜|俯拍|仰拍`开头）。
    // 「中近景 -> 特写」「过肩中景」这类写法不匹配 → 读回来时整段被吞进 location，
    // shot_type 直接丢失（实测 8839 个 shot 里 2 条）。
    // 词表是白名单，不可能穷举模型的所有写法，所以不匹配时改用 `@shot_type=` 通道带出。
    if (s.shot_type && SHOT_TYPE_RE.test(String(s.shot_type))) {
      segs.push(s.shot_type);
    } else if (s.shot_type) {
      segs.push(`${EXTRA_PREFIX}shot_type=${String(s.shot_type).replace(/｜/g, "\\p")}`);
    }
    // ⚠️ 曾经这里写 `[s.time_loc, s.location].filter(Boolean).join(" ")`，
    // 而**95% 的存量数据里 time_loc 与 location 是完全相同的字符串**
    // （生成侧把同一个值写进了两个字段）。于是场头里同一串出现两次：
    //   【场 2-1｜中景｜日 内 未央宫寝殿 日 内 未央宫寝殿｜出场：…】
    // 而 parseHead 只取第一个 token 当 time_loc、剩余全塞进 location，
    // 于是**保存一次就把这两个字段改坏**：
    //   time_loc: "日 内 未央宫寝殿" → "日"
    //   location: "日 内 未央宫寝殿" → "内 未央宫寝殿 日 内 未央宫寝殿"
    // （实测 8151 份剧本里 45375/47751 个 shot 命中这个形状）
    // 相同时只写一次，两种数据形状都能正确往返。
    const hasTl = !!s.time_loc, hasLoc = !!s.location;
    const tlSame = hasTl && hasLoc && s.time_loc === s.location;
    const tlPart = hasTl ? (tlSame ? s.time_loc : [s.time_loc, s.location].filter(Boolean).join(" "))
                         : (s.location || "");
    const tl = String(tlPart || "").trim();
    if (tl) {
      segs.push(tl);
      // 一个串要还原成几个字段，光靠文本判不出来（"日 内 客厅"既可能是
      // time_loc+location 拼的，也可能本身就是一个 location）。所以显式打标记，
      // 让还原是**确定的**而不是靠长度猜 —— 存量 95% 的数据都命中"两者相同"那支，
      // 猜错就是把这 4.5 万个 shot 改坏。
      if (tlSame) segs.push(`${EXTRA_PREFIX}tl_dup`);
      // 只有一个字段有值：标明是哪一个，否则解析端会把它同时塞进两边
      // （实测 17/363 个 shot 是"只有 location、没有 time_loc"）。
      else if (hasTl && !hasLoc) segs.push(`${EXTRA_PREFIX}tl_only=t`);
      else if (!hasTl && hasLoc) segs.push(`${EXTRA_PREFIX}tl_only=l`);
    }
    if (s.characters && s.characters.length) segs.push("出场：" + s.characters.join("、"));
    if (s.duration != null) segs.push(`${s.duration}s`);
    // 场头装不下、但下游会读的字段（subtitle 会进 Word/txt 导出）。
    // 不写出去 = 全文字视图保存一次就永久丢掉。
    for (const k of EXTRA_KEYS) {
      const seg = encodeExtraField(s, k);
      if (seg) segs.push(seg);
    }
    const head = `${HEAD_OPEN} ${segs.join("｜")}${HEAD_CLOSE}`;

    const lines: string[] = [head];
    // 优先用后端有序 elements(动作/对白本就按拍摄时序穿插), 全文视图/导出即贴合观看时序;
    // 无 elements 时才回退到 action/dialogue 的启发式交错。
    const els = (s as any).elements as any[] | undefined;
    if (Array.isArray(els) && els.length) {
      els.forEach((e) => {
        if (e?.type === "action") {
          const c = String(e.content || "").trim();
          // ⚠️ 元素内容里的**换行必须压平**。一个元素写成多行时，续行会被
          // textToShots 当成**独立的一行内容**，于是 elements 数量变多、
          // 位置整体错位（实测：`△光幕文字：【系统当前能量：120/500】\n【检测到…】`
          // 这类多行提示词会让 10 个元素变成 11 个）。
          // 压平后用 `@action_ml=` 通道原样带回，保证数量与内容都不变。
          if (c.includes("\n")) {
            lines.push(`${EXTRA_PREFIX}action_ml=${escapeExtra(c)}`);
          } else if (c) {
            lines.push(c.startsWith("△") ? c : `△${c}`);
          }
        } else if (e?.type === "dialogue") {
          // 打标记的两种情形：
          //   ① 名字里含括号 —— 与 `(mode)`/`【action】` 的括号天然歧义
          //      （`录音（顾承泽声音）(VO)【从音响中传出】：…` 会被截成「录音」；
          //        以 `【` 开头的名字更糟，整行解析失败、掉进 action 兜底）；
          //   ② 名字**为空** —— 写出后行首就是 `【动作】：内容`，
          //      解析端会把它当成动画行。
          const chName = String(e.character || "");
          const needNameMark = chName === "" || /[（()）【】/]/.test(chName);
          if (needNameMark) {
            lines.push(`${EXTRA_PREFIX}name=${escapeExtra(chName)}`);
          }
          const line =
            String(e.character || "").trim() +
            (String(e.mode || "").trim() ? `(${e.mode})` : "") +
            (String(e.action || "").trim() ? `【${e.action}】` : "") +
            "：" +
            String(e.content || "").trim();
          // ⚠️ 台词内容里也可能含**换行**（群众齐喊、多段吟诵）。
          // 直接 push 多行，续行会被 textToShots 当成独立的一行内容 ——
          // 一条台词裂成几条，elements 数量暴增、位置整体错位
          // （实测：9 → 11、9 → 12）。含换行时整条走 `@dlg=` 通道编码。
          if (line.includes("\n")) {
            if (needNameMark) lines.pop();     // 名字已随 JSON 一起带走，标记不再需要
            lines.push(`${EXTRA_PREFIX}dlg=${encodeElPayload({ ...e, type: "dialogue" })}`);
          } else if (line.replace(/[：]/g, "").trim()) {
            lines.push(line);
          }
        } else if (e?.type === "flashback_start") {
          // ⚠️ 闪回标记也是 elements 的一员（后端 storyboard_gen 会产出）。
          // 此前这里只认 action/dialogue，于是这两个标记在全文里**彻底消失**：
          // 用户保存一次，闪回区间就没了（实测第 3 集镜 3 从 12 个元素掉到 10 个）。
          // 用与场头同样的 `@` 通道承载，保证往返可逆。
          lines.push(`${EXTRA_PREFIX}flashback_start`);
        } else if (e?.type === "flashback_end") {
          lines.push(`${EXTRA_PREFIX}flashback_end`);
        } else {
          // 兜底：**任何**没有被上面认领的元素都不能直接丢掉。
          // 实测存量里出现过两类：`type` 为 undefined 的（23 条）、
          // 以及 `type: "subtitle"` 这种非常规类型（1 条）。
          // 上面那种 if/else 链会把它们静默吞掉 —— 保存一次就少一个元素。
          //
          // 用 `@el=` 承载**整个元素的 JSON**：既保住顺序与数量，也不丢任何字段。
          // 走 JSON 而不是"按动作渲染"是因为类型本身有语义（subtitle 不是画面描写），
          // 当成动作渲染虽然保住了字，却改变了它在分镜里的含义。
          lines.push(`${EXTRA_PREFIX}el=${encodeElPayload(e)}`);
        }
      });
    } else {
      const seq = interleaveActionDialogue(s.action, s.dialogue);
      seq.forEach((ln) => {
        if (ln.type === "action") lines.push(ln.text.startsWith("△") ? ln.text : `△${ln.text}`);
        else lines.push(ln.text);
      });
    }
    if (s.notes) {
      // notes 可能多行(场合并时追加产生), 每行都带"注："前缀, 保证往返可逆
      String(s.notes).split("\n").forEach((n) => {
        const t = n.trim();
        if (t) lines.push(`注：${t}`);
      });
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/** 解析单场场头 -> 部分字段。 */
function parseHead(line: string): Partial<Shot> {
  // 去掉【场 ... 】外壳
  const inner = line
    .replace(/^【\s*场\s*/, "")
    .replace(/】\s*$/, "")
    .trim();
  const parts = inner.split(/[｜|]/).map((p) => p.trim());
  const out: Partial<Shot> = {};
  // 先扫一遍"要不要还原成两个字段"的标记段。
  // ⚠️ 必须**先**扫再走主循环：这些标记写在场头末尾，而 time_loc 分支在它们之前执行，
  // 一趟解析会在标志还没设上时就去读它 —— 那是"看起来生效、实际永远为假"的经典写法。
  // 且标记有两种形状（`@tl_dup` 无值、`@tl_only=l` 带值），只筛无 `=` 的会漏掉后者。
  const marks = parts.filter(
    (p) => p === `${EXTRA_PREFIX}tl_dup` || p.startsWith(`${EXTRA_PREFIX}tl_only=`),
  );
  for (const m of marks) decodeExtraField(m.slice(EXTRA_PREFIX.length), out);
  parts.forEach((p, idx) => {
    if (!p) return;
    // 场头装不下的字段（subtitle / is_flashback / shot_no 等），
    // 由 shotsToText 以 `@k=v` 段写在场头里。见下方 EXTRA_PREFIX 的说明。
    if (p.startsWith(EXTRA_PREFIX)) {
      decodeExtraField(p.slice(EXTRA_PREFIX.length), out);
      return;
    }
    if (p.startsWith("出场：") || p.startsWith("出场:")) {
      const names = p.replace(/^出场[：:]/, "").split(/[、,，]/).map((x) => x.trim()).filter(Boolean);
      out.characters = names;
    } else if (/^\d+\s*s$/i.test(p)) {
      out.duration = parseInt(p, 10);
    } else if (idx === 0) {
      out.scene_no = p;
      // ⚠️ 不要在这里推 shot_no。
      // 存量数据里 scene_no 是 "2-1" 这种形态，parseInt("2-1") = 2，
      // 于是每个 shot 的 shot_no 都被**场号的整数部分**覆盖掉：
      // 原 shot_no=2 的镜头，保存回来变成 1（实测 8/11 个 shot 命中）。
      // 场头里本来就没有 shot_no 的位置 —— 它由 shotsToText 以 `@shot_no=` 段
      // 显式写出（见 encodeExtraField），没有该段时才由 textToShots 按位置补。
    } else if (!out.shot_type && SHOT_TYPE_RE.test(p)) {
      out.shot_type = p;
    } else if (!out.time_loc || !out.location) {
      // 场头里的时间/地点是**一个空格分隔的串**，要拆回两个字段。
      //
      // 这里不需要猜：shotsToText 在两者相同时会额外写一个 `@tl_dup` 标记
      // （见那里的注释），本分支据此精确还原。判据是标记，不是长度启发式。
      const sp = p.split(/\s+/);
      if ((out as any)._tl_dup) {
        out.time_loc = p;
        out.location = p;
      } else if ((out as any)._tl_only === "t") {
        out.time_loc = p;           // 只有 time_loc 有值，location 保持缺省
      } else if ((out as any)._tl_only === "l") {
        out.location = p;           // 只有 location 有值
      } else if (sp.length === 1) {
        out.time_loc = p;
        out.location = p;      // 单 token 无法拆，两边都给（与存量行为一致）
      } else {
        out.time_loc = sp[0];
        out.location = sp.slice(1).join(" ");
      }
    } else if (!out.location) {
      out.location = p;
    }
  });
  // ⚠️ 内部标记不能落进 shot：`textToShots` 是 `{ ...parseHead(line) }` 展开的，
  // 这两个下划线字段会跟着进对象、被 `PUT /storyboards/batch` 存进 shots_json。
  // 实测确认过它们确实会漏（`_tl_dup` 出现在落库字段里），所以在出口清掉。
  delete (out as any)._tl_dup;
  delete (out as any)._tl_only;
  return out;
}

/** 解析"角色(情绪)【动作】：台词"行 → dialogue element 字段 */
function parseDialogueLine(line: string): { character: string; mode?: string; action?: string; content: string } | null {
  // ⚠️ 这里**不能**用一个正则搞定，两个方向都会翻车（都是实测踩出来的）：
  //
  //  · 动作块用 `[^【】]*`（非贪婪、不许嵌套）→ 动作里含**嵌套方括号**时
  //    在第一个内层 `【` 处断开，整行匹配失败 → 台词被当成动作行。
  //    例：`陆乘风(OS)【…花字特效：【系统你玩我呢？！】】：系统…`
  //  · 动作块用 `【([\s\S]*)】`（贪婪到最后一个 `】`）→ 反过来，
  //    当**台词内容本身**含 `【` 时会多吃掉一段。
  //    例：`系统音(VO)【机械音】：【系统规则三】宿主需…` → 动作被吃成「机械音】：【系统规则」
  //
  // 正确做法是**配对计数**：从动作块开头的 `【` 数到与之配对的 `】`。
  // 与角色名的 `{1,12}` 配合时要注意用**贪婪**（`{1,12}` 而非 `{1,12}?`）——
  // 非贪婪会让名字只吃 1 个字（`姜瑶(OS)…` 解析出角色名「姜」）。
  const mi = line.match(/^([^：:（(【]{1,12})(?:[（(]([^（）()]*)[）)])?\s*/);
  if (!mi) return null;
  const out: { character: string; mode?: string; action?: string; content: string } = {
    character: mi[1].trim(),
    content: "",
  };
  if (mi[2]?.trim()) out.mode = mi[2].trim();

  let rest = line.slice(mi[0].length);
  if (rest.startsWith("【")) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "【") depth++;
      else if (rest[i] === "】") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) return null;              // 方括号不配对 → 不是台词行
    if (rest.slice(1, end).trim()) out.action = rest.slice(1, end).trim();
    rest = rest.slice(end + 1);
  }
  const c = rest.match(/^[：:]([\s\S]*)$/);
  if (!c) return null;                     // 动作块之后没有冒号 → 不是台词行
  out.content = c[1].trim();
  return out;
}

/** 把一集全文解析回 shots 数组。鲁棒兜底: 无场头时整段当单场 action。

 * 同步构建有序 elements(动作/对白按用户书写顺序), 保证保存后分镜视图/全文视图
 * 的行序与用户编辑时完全一致(不依赖启发式交错恢复顺序)。
 */
export function textToShots(text: string): Shot[] {
  const raw = (text || "").replace(/\r\n/g, "\n");
  if (!raw.trim()) return [];

  const lines = raw.split("\n");
  const shots: Shot[] = [];
  let cur: Shot | null = null;
  const actionBuf: string[] = [];
  const dialogueBuf: string[] = [];
  let elementsBuf: any[] = [];
  /** `@name=` 段携带的角色名，套给紧随其后的那条对白。
   *  ⚠️ 必须配一个**独立的布尔标记**：名字可能是**空串**（无角色名的对白），
   *  而 `pendingName &&` 对空串为假 —— 那会让"标记了空名字"与"没有标记"
   *  变成同一件事，空名对白又掉回 action 兜底。 */
  let pendingName = "";
  let pendingNameSet = false;

  const flush = () => {
    if (!cur) return;
    if (actionBuf.length) cur.action = actionBuf.join("\n");
    if (dialogueBuf.length) cur.dialogue = dialogueBuf.join("\n");
    if (elementsBuf.length) cur.elements = elementsBuf;
    shots.push(cur);
    cur = null;
    actionBuf.length = 0;
    dialogueBuf.length = 0;
    elementsBuf = [];
    pendingName = "";
    pendingNameSet = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith(HEAD_OPEN)) {
      flush();
      cur = { ...parseHead(line) };
      continue;
    }
    // 闪回标记（由 shotsToText 以 `@flashback_start` / `@flashback_end` 写出）：
    // 它们是 elements 的一员，不是动作行 —— 不要落进 actionBuf。
    if (line === `${EXTRA_PREFIX}flashback_start`) {
      if (!cur) cur = {};
      elementsBuf.push({ type: "flashback_start" });
      continue;
    }
    // `@name=` —— 上一条对白的角色名（含括号，无法从文本反推）。
    // 它紧跟在写出它的那行**之前**，所以先存起来，等解析出该行时套用。
    if (line.startsWith(`${EXTRA_PREFIX}name=`)) {
      pendingName = unescapeExtra(line.slice(EXTRA_PREFIX.length + "name=".length));
      pendingNameSet = true;
      continue;
    }
    if (line === `${EXTRA_PREFIX}flashback_end`) {
      if (!cur) cur = {};
      elementsBuf.push({ type: "flashback_end" });
      continue;
    }
    // `@el_keep`：原元素**没有 type**（存量数据里的偶发形状），且内容为空。
    // 单靠文本无法还原成"无 type"，只能记一个占位，保住 elements 的数量与顺序 ——
    // 数量错位会让下游按序号对齐的逻辑整体串位（实测差 1 位就使整集比对全错）。
    if (line === `${EXTRA_PREFIX}el_keep`) {
      if (!cur) cur = {};
      elementsBuf.push({ type: undefined });
      continue;
    }
    // `@dlg=`：内容含换行的对白元素（整条走 JSON，见 shotsToText）。
    if (line.startsWith(`${EXTRA_PREFIX}dlg=`)) {
      if (!cur) cur = {};
      try {
        const el = decodeElPayload(line.slice(EXTRA_PREFIX.length + "dlg=".length));
        elementsBuf.push(el);
        dialogueBuf.push(
          `${el.character || ""}(${el.mode || ""})：${el.content || ""}`.trim(),
        );
      } catch {
        elementsBuf.push({ type: "dialogue", character: "", content: "" });
      }
      continue;
    }
    // `@action_ml=`：内容含换行的 action 元素（压平成一行写出，见 shotsToText）。
    // 不还原的话它会被当成一条普通动作行，元素数量与内容都会错。
    if (line.startsWith(`${EXTRA_PREFIX}action_ml=`)) {
      if (!cur) cur = {};
      const c = unescapeExtra(line.slice(EXTRA_PREFIX.length + "action_ml=".length));
      actionBuf.push(c);
      elementsBuf.push({ type: "action", content: c });
      continue;
    }
    // `@el=`：非常规元素的完整 JSON（见 shotsToText 里的兜底分支）。
    if (line.startsWith(`${EXTRA_PREFIX}el=`)) {
      if (!cur) cur = {};
      try {
        elementsBuf.push(decodeElPayload(line.slice(EXTRA_PREFIX.length + "el=".length)));
      } catch {
        // JSON 坏了也不能丢位 —— 保住数量优先
        elementsBuf.push({ type: undefined });
      }
      continue;
    }
    // `@name=` 标记者：下一行**必定是对白**（那是写出这个标记的唯一场景）。
    // 必须先于下面的通用分支判断 —— 含括号的角色名会让 parseDialogueLine
    // 匹配失败，从而掉进 action 兜底，把对白降级成动作、还让 pendingName
    // 泄漏到后面那条对白上（实测把「白薇」的台词挂到了「录音（白薇声音）」名下）。
    if (pendingNameSet && !line.startsWith(HEAD_OPEN)) {
      const rest = line.startsWith("△") ? line.replace(/^△/, "").trim() : line;
      const head = pendingName;
      // 名字之后的 `(mode)【action】：内容` 仍要照常还原。
      // ⚠️ 这里不能用 `rest.startsWith(head)` 去切 —— 名字里的括号会在写出时
      // 被成对写入，但**空白**可能被规范化过（trim / 换行替换），导致前缀对不上，
      // 于是 mode/action 全丢。改成"找名字最后一个字符之后的分隔位置"，
      // 对名字里含 `【系统女声】` 这种以括号开头/结尾的都成立。
      const at = rest.indexOf(head);
      const after = at >= 0 ? rest.slice(at + head.length) : rest;
      const tail = after.trim();
      const m = tail.match(/^(?:[（(]([^（）()]*)[）)])?(?:【([^【】]*)】)?[：:](.*)$/);
      if (m) {
        const el: any = { type: "dialogue", character: head, content: (m[3] || "").trim() };
        if (m[1]?.trim()) el.mode = m[1].trim();
        if (m[2]?.trim()) el.action = m[2].trim();
        elementsBuf.push(el);
        dialogueBuf.push(head + "：" + el.content);
      } else {
        const i = tail.search(/[：:]/);
        const content = i >= 0 ? tail.slice(i + 1).trim() : tail;
        elementsBuf.push({ type: "dialogue", character: head, content });
        dialogueBuf.push(head + "：" + content);
      }
      pendingName = "";
      pendingNameSet = false;
      continue;
    }
    // 没有场头就出现内容 -> 起一个隐式场
    if (!cur) cur = {};

    if (line.startsWith("△")) {
      const c = line.replace(/^△/, "").trim();
      actionBuf.push(c);
      elementsBuf.push({ type: "action", content: c });
    } else if (line.startsWith("注：") || line.startsWith("注:")) {
      // 追加而非覆盖: 场头被删导致两场合并时, 前一场的"注"不能被后一场覆盖丢失
      const n = line.replace(/^注[：:]/, "").trim();
      cur.notes = cur.notes ? `${cur.notes}\n${n}` : n;
    } else if (parseDialogueLine(line) && !line.startsWith("出场")) {
      // 角色：台词
      //
      // ⚠️ 这里**不能**用 `^[^：:]{1,12}[：:]` 当守卫。那个写法把
      // 「角色名 + (模式) + 【动作】」**整串**限制在 12 字内，而
      // parseDialogueLine 允许的是"角色名 ≤12 字 **再加上**括号/方头括号"。
      // 于是舞台提示一长就触发误判：
      //   嘉和帝【语气平静却极具压迫感】：誰說公主就不能繼承大業了？
      //   ↑ 前缀 15 字 > 12 → 被归成**动作行**
      // 后果不是报错，是**静默降级**：该台词从 dialogue 变 action，
      // 分镜视图不再当台词渲染，而且保存后永久定型（实测 10.3% 的对白命中）。
      // 判据直接复用 parseDialogueLine —— 它才是"能不能解析成台词"的权威。
      dialogueBuf.push(line);
      const d = parseDialogueLine(line);
      if (d) elementsBuf.push({ type: "dialogue", ...d, ...(pendingName ? { character: pendingName } : {}) });
      else elementsBuf.push({ type: "dialogue", character: pendingName || "", content: line });
      pendingName = "";
    } else {
      // 兜底: 归到 action, 不丢字
      actionBuf.push(line);
      elementsBuf.push({ type: "action", content: line });
    }
  }
  flush();

  // 重排 shot_no 连续
  shots.forEach((s, i) => {
    if (s.shot_no == null) s.shot_no = i + 1;
  });
  return shots;
}

/** 整部剧本(多集)拼成全文, 集间用集头分隔。用于"全文视图"统一编辑。 */
export function storyboardsToFullText(
  storyboards: { chapter_order: number; shots_json?: Shot[] | null }[],
): string {
  return storyboards
    .slice()
    .sort((a, b) => a.chapter_order - b.chapter_order)
    .map((sb) => `═══ 第${sb.chapter_order}集 ═══\n\n${shotsToText(sb.shots_json || [])}`)
    .join("\n\n\n");
}

/** 把全文按"第X集"集头切回 {chapter_order, shots_json}[]。

 * 防丢字设计:
 * - 首个集头之前的内容不丢弃, 并入第一个识别到的集(用户删多行时可能误删首集头);
 * - 同一集号出现多次(误粘贴/改错集号)时合并 shots, 不覆盖丢内容。
 */
export function fullTextToStoryboards(
  text: string,
): { chapter_order: number; shots_json: Shot[] }[] {
  const raw = (text || "").replace(/\r\n/g, "\n");
  const re = /═+\s*第\s*(\d+)\s*集\s*═+/g;
  const marks: { order: number; idx: number; len: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    marks.push({ order: parseInt(m[1], 10), idx: m.index, len: m[0].length });
  }
  if (marks.length === 0) return [];

  // 逐段解析; 首个集头前的残留内容(通常是被误删集头的整集正文)并入第一段, 不静默丢弃
  const byOrder = new Map<number, Shot[]>();
  const orderSeq: number[] = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].idx + marks[i].len;
    const end = i + 1 < marks.length ? marks[i + 1].idx : raw.length;
    let body = raw.slice(start, end);
    if (i === 0 && marks[0].idx > 0) {
      const leading = raw.slice(0, marks[0].idx).trim();
      if (leading) body = `${leading}\n${body}`;
    }
    const shots = textToShots(body);
    if (byOrder.has(marks[i].order)) {
      byOrder.get(marks[i].order)!.push(...shots); // 重复集号: 合并不覆盖
    } else {
      byOrder.set(marks[i].order, shots);
      orderSeq.push(marks[i].order);
    }
  }
  return orderSeq.map((order) => ({ chapter_order: order, shots_json: byOrder.get(order)! }));
}