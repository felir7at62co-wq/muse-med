/**
 * AI 输出的「显示」与「写入」分离（用户 2026-09-20 要求）
 *
 * ## 问题
 * 模型经常回带格式的文本（`### 标题`、`**重点**`、`- 列表`）。
 * 直接把原文铺在界面上，用户看到的是 `###` `**` 这些符号，很困惑 ——
 * 而它们本来就只是**给渲染器看的标记**，不是内容。
 *
 * ## 但显示和写入要用不同的形态
 *   · **显示**：渲染成标题/加粗/列表（人读得舒服）
 *   · **写入草稿**：剥成纯文本（剧本正文里出现 `###` 是脏数据，
 *     而且剧本有自己的格式约定 —— 场次头/△动作/角色：台词）
 *
 * 所以本模块只做**一件事**：把 Markdown 剥成纯文本。
 * 显示侧用 `react-markdown` 渲染，不经过这里。
 *
 * ## 为什么不用 `remove-markdown` 之类的现成库
 * 那些库面向"通用 Markdown → 纯文本"，会顺手做很多我们不想要的事
 * （链接转脚注、表格转 CSV、强调符全删）。剧本正文需要的是
 * **保守**的剥离：只去掉确定是标记的部分，其余原样保留。
 * 宁可少剥（留个把符号）也不要多剥（吃掉正文里的合法字符）。
 */

/** 去掉行内的强调标记：`**粗**` `*斜*` `__粗__` `_斜_` `~~删~~` `` `码` `` */
function stripInlineMarks(line: string): string {
  return line
    // 行内代码先处理：反引号里的内容原样保留，只去掉反引号本身
    .replace(/`([^`]*)`/g, '$1')
    // **粗** / __粗__（要求成对，避免吃掉单个下划线）
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    // *斜* / _斜_
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1$2')
    // ~~删除~~
    .replace(/~~([^~]+)~~/g, '$1');
}

/**
 * 把 Markdown 文本剥成适合写进剧本正文的纯文本。
 *
 * 保留：段落、换行、列表项的文字内容
 * 去掉：标题的 `#`、强调符、引用符 `>`、围栏代码块的 ```、图片/链接的语法外壳、
 *       水平线
 */
export function markdownToPlainText(md: string): string {
  const src = String(md ?? '');
  if (!src) return '';

  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    const line = raw;

    // 围栏代码块：去掉 ``` 行本身，内容原样留下
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) { out.push(line); continue; }

    // 水平线（--- / *** / ___）：整行去掉
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue;

    // 标题：去掉前导 #，内容留下（保留层级语义靠空行区分，不带符号）
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(stripInlineMarks(h[2]).trim());
      continue;
    }

    // 引用：去掉前导 >
    const q = line.match(/^\s{0,3}>\s?(.*)$/);
    if (q) {
      out.push(stripInlineMarks(q[1]).trim());
      continue;
    }

    // 列表：去掉前导 - / * / + / 1. —— 保留内容。
    // ⚠️ 不保留"•"之类的替代符号：剧本正文用不上，且 △ 才是动作行标记。
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      out.push(stripInlineMarks(li[2]).trim());
      continue;
    }

    // 表格行：去掉分隔行，其余去掉竖线收边
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')) continue;

    out.push(stripInlineMarks(line));
  }

  // 图片 ![alt](url) → alt；链接 [text](url) → text
  let text = out.join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 收掉因去标记产生的多余空行（最多留一个）
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * 显示用：判断这段文本是否含 Markdown 标记。
 *
 * 只有含标记时才走 `<ReactMarkdown>` 渲染 —— 纯文本走原来的
 * `whitespace-pre-wrap`，避免 Markdown 把正文里的换行/缩进重排掉
 * （剧本正文对缩进敏感，走一遍 Markdown 会丢掉段首空格）。
 */
export function looksLikeMarkdown(text: string): boolean {
  const s = String(text ?? '');
  if (!s) return false;
  return (
    /^\s{0,3}#{1,6}\s+\S/m.test(s) ||     // 标题
    /\*\*[^*\n]+\*\*/.test(s) ||          // 加粗
    /^\s*([-*+]|\d+[.)])\s+\S/m.test(s) || // 列表
    /^\s{0,3}>\s?\S/m.test(s) ||          // 引用
    /`[^`\n]+`/.test(s) ||                // 行内代码
    /^\s*(```|~~~)/m.test(s) ||           // 围栏代码
    /\[[^\]]+\]\([^)]+\)/.test(s)         // 链接
  );
}

/**
 * 复制到**外部**（微信/Word/记事本…）时用：把 Markdown 转成"结构保留"的纯文本。
 *
 * ## 为什么要和 `markdownToPlainText` 分开（2026-10-09 用户反馈）
 * 用户把对话回复粘贴到外部，会连同 `###` `**` 一起带出去 —— 看着像"带着
 * 一堆乱码符号"。根因在**复制按钮**：它把 `m.content`（模型原文）原样写进
 * 剪贴板，而界面上是渲染过的，所以"屏幕上没问题、粘出去有问题"。
 *
 * 不能直接复用 `markdownToPlainText`：那是为**写进剧本正文**设计的，会
 * **去掉列表编号**（`1.` 整段丢掉，注释里写明"△ 才是动作行标记"）。
 * 那对剧本是对的，对"复制出去给人看"就是**丢信息**（步骤序号没了）。
 * 两个用途的要求正好相反，所以另起一个，别互相将就。
 *
 * ## 与渲染结果保持一致
 * 加粗/斜体/行内代码**只去符号留文字**，于是复制出来的内容与屏幕上
 * 看到的一致（渲染后本来也就只有文字）。标题去 `#`、引用去 `>`、
 * 列表保留 `-` / `1.` 作为可见的层级线索（这在外部编辑器里是"人话"），
 * 链接只留文字、图片只留 alt —— 与 react-markdown 的渲染观感对齐。
 *
 * ## 纯文本原样返回
 * 若文本本来就没有 Markdown 标记，**一个字都不动**（早返回）。
 * 这样纯文本回复不受影响，也避免误伤那些"看起来像标记但其实不是"
 * 的正文（示例：以 `*` 开头的台词、单个下划线）。
 */
export function markdownForClipboard(md: string): string {
  const src = String(md ?? '');
  if (!src) return '';
  // 没有标记就原样返回 —— 不做任何无谓的加工。
  if (!looksLikeMarkdown(src)) return src;

  const out: string[] = [];
  let inFence = false;

  for (const line of src.replace(/\r\n/g, '\n').split('\n')) {
    // 围栏代码块：去掉 ``` 行，内容原样保留（复制代码时不该丢内容）
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }

    /**
     * 水平线（`---` / `***` / `___`）：整行去掉。
     *
     * ⚠️ 别漏了这条 —— 实测真实 AI 回复里 `***` 很常见（当章节分隔用），
     * 界面上渲染成一条横线（用户看到的是分隔，不是星号），但复制出去
     * 会变成字面的 `***`，正是用户报的那种"乱码符号"。
     *
     * 去掉这一行即可：上下本来就是空行，收掉多余的连续空行后正好剩一个
     * 段落间隔，分隔感还在、符号没了。
     *
     * 判据要求**整行只有这三种字符**（3 个以上），所以 `***粗斜体***`
     * 这种行内写法不会被误当水平线。
     */
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue;

    // 标题：去 # 留文字
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) { out.push(stripInlineMarks(h[2]).trim()); continue; }

    // 引用：去 > 留文字
    const q = line.match(/^\s{0,3}>\s?(.*)$/);
    if (q) { out.push(stripInlineMarks(q[1]).trim()); continue; }

    // 无序列表：**保留** `-` 作为可见层级（外面的人看得懂）
    const ul = line.match(/^\s*([-*+])\s+(.*)$/);
    if (ul) { out.push('- ' + stripInlineMarks(ul[2]).trim()); continue; }

    // 有序列表：**保留编号**（这是与 markdownToPlainText 最关键的区别）
    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) { out.push(`${ol[1]}. ` + stripInlineMarks(ol[2]).trim()); continue; }

    out.push(stripInlineMarks(line));
  }

  let text = out.join('\n')
    // 图片 ![alt](url) → alt；链接 [text](url) → text（与渲染观感一致）
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 收掉多余空行（最多留一个空行，别在外部编辑器里拉出一大片空白）
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.replace(/^\s+|\s+$/g, '');
}
