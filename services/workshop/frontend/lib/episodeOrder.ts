/**
 * 批量文件夹反推 — 分组与集号推断（纯函数，无 React 依赖）
 *
 * 输入是 `<input webkitdirectory>` 选出来的一整棵目录树:
 *
 *     大文件夹 / 剧名 / 01.mp4, 02.mp4, ...
 *
 * 输出是「每个子文件夹 = 一个剧 = 一个草稿」的分组结果, 每集带推断出的集号。
 *
 * ⛔ 这里最容易犯、后果最严重的错是**用字符串排序定集顺序** ——
 * "10.mp4" 会排到 "2.mp4" 前面, 于是整部剧的剧情顺序被打乱,
 * 而反推出来的剧本看上去是「正常的」, 用户往往到很后面才发现。
 * 所以集号一律**解析成数字**再排, 解析不出来的宁可标「需确认」让用户拍板,
 * 也不静默猜。
 */

import { cnToNum } from "./replaceDetect";

/** 与后端 video_routes.py 的白名单保持一致 */
const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".mpeg", ".mpg", ".3gp", ".flv", ".wmv",
]);

/** 直接躺在根目录下、不属于任何子文件夹的文件, 归到这个桶 */
export const UNGROUPED_TITLE = "未分组";

export type ParsedEpisode = {
  file: File;
  /** webkitRelativePath, 形如 "大文件夹/剧名/01.mp4"; 兼作续传 scope 与刷新后的重认键 */
  relPath: string;
  /** 展示用的裸文件名 */
  name: string;
  size: number;
  /** 推断出的集号(1 起); null = 没解析出来 */
  epNo: number | null;
  /** 集号是解析出来的(true) 还是靠自然序兜底的(false) */
  confident: boolean;
};

export type ReviewReason = "unparsed" | "duplicate" | "gap";

export type DramaGroup = {
  /** 子文件夹名 = 剧名 = 草稿标题 */
  title: string;
  /** 已按集号升序排好 */
  episodes: ParsedEpisode[];
  /** 被过滤掉的非视频文件名 */
  skipped: string[];
  /** 非空 = 需要用户确认后才能跑 */
  reviewReasons: ReviewReason[];
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/** 文件名去掉扩展名 */
function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? name : name.slice(0, i);
}

/**
 * 从**文件名**推断集号。抓不到返回 null。
 *
 * 按优先级短路 —— 顺序不能随便调:
 *   1. 第X集/话/章   (中文数字也认)
 *   2. S01E12        (季集格式, 取 E 段; 必须排在 EP 之前, 否则 "S01E12" 会被
 *                     第 3 条的 /E(\d+)/ 抢先匹配到 —— 结果一样, 但语义不清)
 *   3. EP12 / E12 / ep_12
 *   4. 文件名里**唯一**的数字组 ("01.mp4" / "12-初见.mp4" / "逆袭_003.mp4")
 *
 * ⚠ 第 4 条特意要求「唯一」: "2024_01.mp4" 有两个数字组, 猜哪个都可能错,
 * 宁可返回 null 让整组进「需确认」, 也不赌。
 */
export function parseEpisodeFromFilename(filename: string): number | null {
  const s = stem(filename || "");
  if (!s) return null;

  // 1. 第X集 / 第X话 / 第X章
  const cn = s.match(/第\s*([0-9]{1,3}|[一二两三四五六七八九十]{1,4})\s*[集章话]/);
  if (cn) {
    const n = cnToNum(cn[1]);
    if (n != null && n > 0) return n;
  }

  // 2. S01E12 / s1e12
  const se = s.match(/[Ss]\s*\d{1,2}\s*[Ee]\s*(\d{1,3})/);
  if (se) {
    const n = parseInt(se[1], 10);
    if (n > 0) return n;
  }

  // 3. EP12 / E12 / ep_12 / ep-12
  const ep = s.match(/\b[Ee][Pp]?[\s_-]*(\d{1,3})\b/);
  if (ep) {
    const n = parseInt(ep[1], 10);
    if (n > 0) return n;
  }

  // 4. 唯一的数字组
  const nums = s.match(/\d+/g);
  if (nums && nums.length === 1) {
    const n = parseInt(nums[0], 10);
    if (n > 0) return n;
  }

  return null;
}

/** 自然序比较器: "2.mp4" < "10.mp4", 而不是字符串序的反过来 */
const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * 判定一组集是否需要用户确认。
 * 返回空数组 = 可以放心自动跑。
 */
function detectReviewReasons(episodes: ParsedEpisode[]): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (episodes.length === 0) return reasons;

  if (episodes.some((e) => !e.confident)) reasons.push("unparsed");

  const seen = new Set<number>();
  for (const e of episodes) {
    if (e.epNo == null) continue;
    if (seen.has(e.epNo)) {
      reasons.push("duplicate");
      break;
    }
    seen.add(e.epNo);
  }

  // 集号不连续(缺集)。只在全部解析成功时才有意义判断。
  // ⚠ 必须先去重再比: [1,1] 的 span 是 1、length 是 2, 不去重会把「重号」
  // 误报成「缺集」, 用户看到的就是「缺第  集」这种空列表。
  if (!reasons.includes("unparsed")) {
    const nums = [...new Set(episodes.map((e) => e.epNo!))].sort((a, b) => a - b);
    const expectedSpan = nums[nums.length - 1] - nums[0] + 1;
    if (expectedSpan !== nums.length) reasons.push("gap");
  }

  return reasons;
}

/**
 * 把一棵目录树按「第一层子文件夹」分组。
 *
 * webkitRelativePath 形如 `大文件夹/剧名/01.mp4`:
 *   - parts[0] 是用户选中的根, 恒定, 丢掉
 *   - parts[1] 是剧名 —— 就是分组键, 也是草稿标题
 *   - 更深的层级(`大文件夹/剧名/1080p/01.mp4`)仍归到 parts[1], 忽略中间目录
 *   - 只有两段(`大文件夹/散装.mp4`)说明文件直接躺在根下, 归入「未分组」
 */
export function groupByFolder(input: FileList | File[]): DramaGroup[] {
  const files = Array.from(input);
  const buckets = new Map<string, { videos: File[]; skipped: string[] }>();

  for (const f of files) {
    const relPath = (f as any).webkitRelativePath || f.name;
    const parts = String(relPath).split("/").filter(Boolean);
    const title = parts.length >= 3 ? parts[1] : UNGROUPED_TITLE;

    let bucket = buckets.get(title);
    if (!bucket) {
      bucket = { videos: [], skipped: [] };
      buckets.set(title, bucket);
    }

    // macOS 的 .DS_Store、Windows 的 Thumbs.db 之类不值得报给用户看
    if (f.name.startsWith(".") || f.name === "Thumbs.db") continue;

    if (VIDEO_EXTS.has(extOf(f.name))) bucket.videos.push(f);
    else bucket.skipped.push(f.name);
  }

  const groups: DramaGroup[] = [];

  for (const [title, bucket] of buckets) {
    if (bucket.videos.length === 0 && bucket.skipped.length === 0) continue;

    // 先按文件名自然序排一遍, 作为「解析不出集号」时的兜底顺序
    const sorted = [...bucket.videos].sort((a, b) => naturalCollator.compare(a.name, b.name));

    const episodes: ParsedEpisode[] = sorted.map((file, idx) => {
      const parsed = parseEpisodeFromFilename(file.name);
      return {
        file,
        relPath: (file as any).webkitRelativePath || file.name,
        name: file.name,
        size: file.size,
        // 解析不出来时先用自然序位次占位, 但 confident=false 会把整组标成「需确认」
        epNo: parsed ?? idx + 1,
        confident: parsed != null,
      };
    });

    // 再按集号升序。同号的按自然序稳定排列, 便于用户在界面上看出是哪两个撞了
    episodes.sort((a, b) => {
      const d = (a.epNo ?? 0) - (b.epNo ?? 0);
      return d !== 0 ? d : naturalCollator.compare(a.name, b.name);
    });

    groups.push({
      title,
      episodes,
      skipped: bucket.skipped,
      reviewReasons: detectReviewReasons(episodes),
    });
  }

  // 剧与剧之间也用自然序, 「未分组」永远垫底
  groups.sort((a, b) => {
    if (a.title === UNGROUPED_TITLE) return 1;
    if (b.title === UNGROUPED_TITLE) return -1;
    return naturalCollator.compare(a.title, b.title);
  });

  return groups;
}

/** 把 reviewReasons 翻译成给用户看的话 */
export function describeReview(g: DramaGroup): string {
  const parts: string[] = [];
  if (g.reviewReasons.includes("unparsed")) {
    const n = g.episodes.filter((e) => !e.confident).length;
    parts.push(`${n} 个文件认不出集号`);
  }
  if (g.reviewReasons.includes("duplicate")) {
    const seen = new Set<number>();
    const dups = new Set<number>();
    for (const e of g.episodes) {
      if (e.epNo == null) continue;
      if (seen.has(e.epNo)) dups.add(e.epNo);
      seen.add(e.epNo);
    }
    parts.push(`第 ${[...dups].sort((a, b) => a - b).join("、")} 集重号`);
  }
  if (g.reviewReasons.includes("gap")) {
    const present = new Set(g.episodes.map((e) => e.epNo!));
    const nums = [...present].sort((a, b) => a - b);
    const missing: number[] = [];
    let truncated = false;
    for (let i = nums[0]; i <= nums[nums.length - 1]; i++) {
      if (present.has(i)) continue;
      if (missing.length >= 6) { truncated = true; break; }
      missing.push(i);
    }
    // 缺集列表可能为空(理论上不该走到这), 空的话别渲染成「缺第  集」
    if (missing.length > 0) {
      parts.push(`缺第 ${missing.join("、")} ${truncated ? "等集" : "集"}`);
    }
  }
  return parts.join("；");
}

/** 重排后重新编号: 界面上拖动改序后调用, 让集号回到 1..N 连续 */
export function renumber(episodes: ParsedEpisode[]): ParsedEpisode[] {
  return episodes.map((e, i) => ({ ...e, epNo: i + 1, confident: true }));
}

/**
 * 单部剧上传（一次多选一堆视频、不分文件夹）用的排序：按文件名里的集号升序，
 * 认不出集号的按自然序排在最后。
 *
 * ⚠️ 2026-10-29 生产事故（草稿 #3034）：上传弹窗原样沿用浏览器给的顺序，
 * Windows 文件选择框多选返回的是 001、008…100、002…007，99 集就按这个编了集号，
 * 第 2–7 集的剧情被反推到了全剧末尾，用户到第 11 集才发现。
 */
export function sortByEpisodeNo<T>(items: T[], nameOf: (x: T) => string): T[] {
  const keyed = items.map((it, i) => {
    const name = nameOf(it);
    return { it, i, name, ep: parseEpisodeFromFilename(name) };
  });
  keyed.sort((a, b) => {
    if (a.ep != null && b.ep != null && a.ep !== b.ep) return a.ep - b.ep;
    if ((a.ep == null) !== (b.ep == null)) return a.ep == null ? 1 : -1;
    return naturalCollator.compare(a.name, b.name) || a.i - b.i;
  });
  return keyed.map((k) => k.it);
}

/**
 * 按文件名检查一组集：认不出集号 / 重号 / 缺集。
 * 返回给用户看的一句话；空串 = 没发现问题。口径与批量反推的「需确认」一致。
 */
export function reviewEpisodeNames(names: string[]): string {
  const episodes: ParsedEpisode[] = names.map((name) => {
    const epNo = parseEpisodeFromFilename(name);
    return { file: null as unknown as File, relPath: name, name, size: 0, epNo, confident: epNo != null };
  });
  const reviewReasons = detectReviewReasons(episodes);
  if (reviewReasons.length === 0) return "";
  return describeReview({ title: "", episodes, skipped: [], reviewReasons });
}
