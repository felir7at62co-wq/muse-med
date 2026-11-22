/**
 * 分镜「全文视图」往返无损回归测试
 *
 * ## 为什么需要它
 * `storyboardsToFullText` / `fullTextToStoryboards` 是一对**互为逆运算**的函数：
 * 用户在全文字视图里点一次「保存」，走的就是"文本 → 解析回 shots → 写库"。
 * 只要这两个函数对不齐，**一次保存就静默改坏数据**，而且不报错。
 *
 * 实测就是这么坏的（2026-09-20 修）：全库 47751 个 shot 里
 *   · 95% 的 `time_loc` 保存后从「日 内 未央宫寝殿」变成「日」
 *   · 10.3% 的对白被降级成动作
 *   · `subtitle` 保存即丢（而它会进 Word/txt 导出）
 * 三类都是"用真实数据跑一遍才发现"的，看代码看不出来。
 *
 * ## 怎么跑
 *     cd apps/web
 *     npx esbuild lib/scriptText.ts --format=esm --outfile=/tmp/st.mjs
 *     node scripts/check-scripttext-roundtrip.mjs /tmp/st.mjs [数据.json]
 *
 * `数据.json` 可选，格式 `[{chapter_order, shots_json:[...]}, ...]`（从库里导）。
 * 不给则用内置样本跑，覆盖已知的每一条边界。
 *
 * ## 判据
 * 只放行两处**有意**的规范化（`△` 装饰前缀、行尾空白），其余任何差异即失败。
 * 加字段/加通道后请同步扩充 CASES —— 这个文件的价值全在"钉住形状"。
 */
import { readFileSync } from 'fs';

const modPath = process.argv[2];
if (!modPath) {
  console.error('用法: node check-scripttext-roundtrip.mjs <编译后的 scriptText.mjs> [数据.json]');
  process.exit(2);
}
const { storyboardsToFullText, fullTextToStoryboards } = await import(modPath);

// ── 归一化：只放行有意的规范化 ──
const normContent = (s) => String(s ?? '').replace(/^[\s△]+/, '').replace(/\s+$/, '');
const normEl = (e) => ({
  type: e?.type ?? 'action',
  character: String(e?.character ?? '').trim(),
  mode: String(e?.mode ?? '').trim(),
  action: String(e?.action ?? '').trim(),
  content: normContent(e?.content),
});
const elSame = (a, b) => JSON.stringify(normEl(a)) === JSON.stringify(normEl(b));
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const eq = (a, b) => (isEmpty(a) && isEmpty(b)) ? true : JSON.stringify(a) === JSON.stringify(b);

const KEYS = ['shot_no', 'shot_type', 'time_loc', 'location', 'characters', 'duration', 'notes', 'subtitle', 'is_flashback'];

let fail = 0;
const bad = (msg) => { fail++; console.log('❌ ' + msg); };
const ok = (msg) => console.log('✅ ' + msg);

function checkOne(ep, label) {
  const back = fullTextToStoryboards(storyboardsToFullText([ep]))[0];
  const A = ep.shots_json, B = back?.shots_json;
  if (!B || A.length !== B.length) {
    bad(`${label} 镜头数 ${A.length} → ${B?.length}`);
    return;
  }
  for (let i = 0; i < A.length; i++) {
    for (const k of KEYS) {
      // 有意：原 shot_no 缺席时读回来按位置补号
      if (k === 'shot_no' && A[i].shot_no == null && B[i]?.shot_no === i + 1) continue;
      if (!eq(A[i][k], B[i]?.[k])) {
        bad(`${label} 镜${i + 1} 字段 ${k}: ${JSON.stringify(A[i][k])} → ${JSON.stringify(B[i]?.[k])}`);
      }
    }
    // 内部标记不得落库（曾被 `{...parseHead()}` 展开带进 shots_json）
    for (const k of Object.keys(B[i] || {})) {
      if (k.startsWith('_')) bad(`${label} 镜${i + 1} 落库字段含内部标记 ${k}`);
    }
    const EA = A[i].elements, EB = B[i]?.elements;
    if (!Array.isArray(EA) || !EA.length) continue;      // 走启发式路径，不逐元素比
    if (!Array.isArray(EB) || EA.length !== EB.length) {
      bad(`${label} 镜${i + 1} elements 数量 ${EA.length} → ${EB?.length}`);
      continue;
    }
    for (let j = 0; j < EA.length; j++) {
      if (!elSame(EA[j], EB[j])) {
        bad(`${label} 镜${i + 1} element#${j + 1}\n     原 ${JSON.stringify(normEl(EA[j])).slice(0, 140)}\n     返 ${JSON.stringify(normEl(EB[j])).slice(0, 140)}`);
      }
    }
  }
}

// ── 内置样本：每条对应一个实测踩过的坑 ──
const HEAD = (extra = '') => `【场 2-1｜中景｜日 内 未央宫寝殿｜${extra}】`;
const CASES = [
  {
    name: 'time_loc 与 location 相同（95% 存量数据）',
    shot: { scene_no: '2-1', time_loc: '日 内 未央宫寝殿', location: '日 内 未央宫寝殿', shot_no: 1,
            elements: [{ type: 'action', content: '△他推门进来。' }] },
  },
  {
    name: 'time_loc 与 location 不同',
    shot: { scene_no: '1-1', time_loc: '日', location: '内 客厅', shot_no: 1,
            elements: [{ type: 'action', content: '△坐下。' }] },
  },
  {
    name: '只有 location、没有 time_loc',
    shot: { scene_no: '1', location: '工商银行门口', shot_no: 1,
            elements: [{ type: 'action', content: '△排队。' }] },
  },
  {
    name: '长舞台提示的对白（曾被 12 字守卫降级成动作）',
    shot: { scene_no: '3-1', shot_no: 3,
            elements: [{ type: 'dialogue', character: '嘉和帝', action: '语气平静却极具压迫感', content: '誰說公主就不能繼承大業了？' }] },
  },
  {
    name: '动作里含嵌套方括号（花字特效）',
    shot: { scene_no: '1-1', shot_no: 1,
            elements: [{ type: 'dialogue', character: '陆乘风', mode: 'OS', action: '抓狂，花字特效：【系统你玩我呢？！】', content: '系统，你玩我呢？' }] },
  },
  {
    name: '台词内容里自带【】',
    shot: { scene_no: '1-2', shot_no: 2,
            elements: [{ type: 'dialogue', character: '系统音', mode: 'VO', action: '机械音', content: '【系统规则三】宿主需在三十日内成婚。' }] },
  },
  {
    name: '角色名含全角括号',
    shot: { scene_no: '1-3', shot_no: 3,
            elements: [{ type: 'dialogue', character: '录音（顾承泽声音）', mode: 'VO', action: '从音响中传出', content: '白薇那个蠢货……' }] },
  },
  {
    name: '角色名以【】开头',
    shot: { scene_no: '1-4', shot_no: 4,
            elements: [{ type: 'dialogue', character: '【系统女声】', mode: 'VO', action: '冰冷机械', content: '警告！' }] },
  },
  {
    name: '角色名为空',
    shot: { scene_no: '1-5', shot_no: 5,
            elements: [{ type: 'dialogue', character: '', action: '声音空灵而冰冷，在山谷间回荡', content: '这就是我给你准备的通道。' }] },
  },
  {
    name: '内容含换行的 action（曾被裂成两个元素）',
    shot: { scene_no: '1-6', shot_no: 6,
            elements: [{ type: 'action', content: '△光幕文字：【系统当前能量：120/500】\n【检测到有机废弃物10kg。是否提炼？】' }] },
  },
  {
    name: '内容含换行的对白（群众齐喊）',
    shot: { scene_no: '1-7', shot_no: 7,
            elements: [{ type: 'dialogue', character: '群众', content: '苏公子来了！\n真的是苏慕白！\n快让让！' }] },
  },
  {
    name: 'subtitle / is_flashback 必须保住（subtitle 会进 Word 导出）',
    shot: { scene_no: '1-8', shot_no: 8, subtitle: '大楚后宫 未央宫', is_flashback: true,
            notes: '备注一', elements: [{ type: 'action', content: '△转场。' }] },
  },
  {
    name: 'subtitle 里含换行',
    shot: { scene_no: '1-9', shot_no: 9, subtitle: '距离登基大典 仅剩半个时辰\n[实时倒计时 00:30:00]',
            elements: [{ type: 'action', content: '△倒计时。' }] },
  },
  {
    name: '闪回标记元素不得被吞',
    shot: { scene_no: '1-10', shot_no: 10,
            elements: [{ type: 'action', content: '△姜瑶愣住。' }, { type: 'flashback_start' },
                       { type: 'action', content: '△尸山血海。' }, { type: 'flashback_end' }] },
  },
  {
    name: 'shot_type 不在固定词表里',
    shot: { scene_no: '1-11', shot_no: 11, shot_type: '中近景 -> 特写',
            elements: [{ type: 'action', content: '△推进。' }] },
  },
  {
    name: '非常规元素类型（type 缺失 / subtitle）',
    shot: { scene_no: '1-12', shot_no: 12,
            elements: [{ type: 'action', content: '△正常。' }, { content: '无 type 的元素' },
                       { type: 'subtitle', content: '字幕元素' }] },
  },
];

console.log('① 内置样本（每条对应一个实测踩过的坑）');
for (const c of CASES) {
  const before = fail;
  checkOne({ chapter_order: 1, shots_json: [c.shot] }, c.name);
  if (fail === before) ok(c.name);
}

// ── 可选：真实数据 ──
if (process.argv[3]) {
  const data = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  console.log(`\n② 真实数据往返（${data.length} 集）`);
  let shots = 0;
  for (const ep of data) {
    shots += (ep.shots_json || []).length;
    checkOne(ep, `${ep.draft_id ?? '?'}/${ep.chapter_order}`);
  }
  if (fail === 0) ok(`${shots} 个 shot 全部无损`);
  else console.log(`   （共 ${shots} 个 shot）`);
}

console.log(fail === 0 ? '\n✅ 全部通过：全文视图保存不会损坏分镜数据' : `\n❌ ${fail} 处不一致`);
process.exit(fail ? 1 : 0);
