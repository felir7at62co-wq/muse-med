/**
 * 模型清单 — 前端唯一来源。
 *
 * ## 为什么必须由后端下发, 不能再在前端写死
 *
 * 改这版之前, 三个入口各自写死了一份三选一的 MODELS 常量, 且**三份互不一致**
 * (精修默认 gpt5、裂变默认 gemini、改编默认 deepseek, 连排序都不同)。加一个型号
 * 要改三处, 漏一处就出现"同一个模型在 A 页能选、B 页不能选"。更要命的是"稳"标:
 * 哪些模型三渠道全通是**每天都在变**的事实(中转站会掉线/停号/满载), 写死在前端
 * 的清单必然过期, 而过期的方向最糟 —— 用户照着一个假"稳"标去跑整本精修。
 *
 * 所以清单、分组、稳标全部来自 GET /v1/models/catalog(后端现算), 前端只负责渲染。
 *
 * ## 提交给后端的值形如 "gemini:gemini-3.8-flash"
 *
 * 冒号前是厂商、后是具体型号。后端 get_llm 一处解析(见 models/catalog.py),
 * 沿途几十层函数原样透传。不带冒号的旧值("gemini")仍然合法 = 用该厂商的默认型号,
 * 所以库里的历史作业记录、以及本文件的兜底清单都不需要迁移。
 */
import { authFetch } from './auth';

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || '';

export type ModelItem = {
  provider: string;
  model: string;
  /** 提交给后端的值, 形如 "gemini:gemini-3.8-flash" */
  value: string;
  label: string;
  /** 已知坑的一句话提醒(如"轻量档, 长文生成偏弱"), 可能为空 */
  note: string;
  /** "稳" = 实测该型号配置的每条渠道都通; 由后端现算, 前端不得推断 */
  stable: boolean;
  channels_ok: number;
  channels_total: number;
  checked_at: string | null;
  /** 为什么稳/不稳, 给 tooltip 用 */
  reason: string;
};

export type ModelGroup = {
  provider: string;
  label: string;
  /** 是否走多渠道兜底。⚠ 具体是哪几家中转站**不下发给普通用户** */
  relay: boolean;
  models: ModelItem[];
};

export type ModelCatalog = {
  groups: ModelGroup[];
  /**
   * provider -> **这个用户**的默认值, 形如 { gemini: "gemini:gemini-3.8-flash" }。
   *
   * 后端已经把三级回落算完了(用户偏好 > 平台默认 > env > 代码常量), 前端拿到的
   * 就是最终值, 不要在这里再叠一层判断。
   */
  defaults: Record<string, string>;
  /** 用户自己设过的偏好; 没设过是 null。仅供 UI 标注"这是你选的", 不参与取值 */
  user_preference?: string | null;
  /** 不含个人偏好的平台默认, 同样只用于 UI 对比展示 */
  platform_defaults?: Record<string, string>;
};

/**
 * 后端不可达时的兜底: 只给各厂商的"默认型号", 即不带冒号的老值。
 * 刻意**不**在这里列举具体型号 —— 那就等于把写死清单换个地方重演一遍。
 * 老值语义是"用该厂商的 env 默认模型", 永远有效, 不会让用户卡在无法提交。
 *
 * ⚠️ 厂商名单必须与后端 catalog.VENDORS 一致(2026-10-10 新增五个第三方分组)。
 * 这里少一个的后果不是报错, 而是后端不可达时该厂商**整个从下拉里消失** ——
 * 用户会以为平台没这个能力, 而不是知道"只是暂时取不到清单"。
 */
export const FALLBACK_CATALOG: ModelCatalog = {
  groups: [
    { provider: 'gemini', label: 'Gemini', relay: true, models: [] },
    { provider: 'claude', label: 'Claude', relay: true, models: [] },
    { provider: 'gpt5', label: 'GPT', relay: true, models: [] },
    { provider: 'grok', label: 'Grok', relay: true, models: [] },
    { provider: 'deepseek', label: 'DeepSeek', relay: false, models: [] },
    { provider: 'mini', label: 'MiniMax', relay: true, models: [] },
    { provider: 'kimi', label: 'Kimi', relay: true, models: [] },
    { provider: 'glm', label: 'GLM', relay: true, models: [] },
    { provider: 'qwenapi', label: '通义千问', relay: true, models: [] },
    { provider: 'doubao', label: '豆包', relay: true, models: [] },
  ].map((g) => ({
    ...g,
    models: [
      {
        provider: g.provider,
        model: '',
        value: g.provider,
        label: `${g.label}（默认型号）`,
        note: '模型清单暂时取不到, 已退回该厂商默认型号',
        stable: false,
        channels_ok: 0,
        channels_total: 0,
        checked_at: null,
        reason: '清单接口不可达',
      },
    ],
  })),
  defaults: {
    gemini: 'gemini', deepseek: 'deepseek', gpt5: 'gpt5', grok: 'grok',
    claude: 'claude', mini: 'mini', kimi: 'kimi', glm: 'glm',
    qwenapi: 'qwenapi', doubao: 'doubao',
  },
};

/**
 * 模块级缓存 + 在途请求去重。
 *
 * 一个页面里可能同时挂着精修 / 改编 / 裂变三个选择器, 不去重就是三次同样的请求。
 * TTL 5 分钟: "稳"标本就来自周期探测(默认 6 小时一轮), 再快也没有新信息;
 * 需要立刻看最新值时用 refreshModelCatalog()。
 */
const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; data: ModelCatalog } | null = null;
let inflight: Promise<ModelCatalog> | null = null;

async function fetchCatalog(): Promise<ModelCatalog> {
  const r = await authFetch(`${BASE}/v1/models/catalog`);
  if (!r.ok) throw new Error(`catalog ${r.status}`);
  const d = (await r.json()) as ModelCatalog;
  if (!d?.groups?.length) throw new Error('catalog empty');
  return d;
}

export async function loadModelCatalog(): Promise<ModelCatalog> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = fetchCatalog()
    .then((d) => {
      cache = { at: Date.now(), data: d };
      return d;
    })
    .catch(() => {
      // 取不到清单不能挡住用户干活: 退回"厂商默认型号", 功能照常可用
      return FALLBACK_CATALOG;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function refreshModelCatalog(): Promise<ModelCatalog> {
  cache = null;
  return loadModelCatalog();
}

/**
 * 记住"我默认用哪个模型", 下次各处的默认选择就是它。
 *
 * ⚠ 只该在**用户主动选择**时调用(ModelSelect 的 onChange 第二个参数 === 'user')。
 * 自动对齐时调用会把当时的平台默认写死成个人偏好, 此后管理员升级平台默认这个人
 * 也跟不上了。
 *
 * 写成功后必须清缓存: defaults 是后端算好下发的, 不清的话这个页面在 TTL 内
 * (最长 5 分钟)还会拿着旧 defaults, 用户会觉得"我选了但没记住"。
 *
 * 失败只 warn 不抛: 偏好没存上最多是下次再选一次, 不值得打断用户正在做的事。
 */
export async function saveModelPreference(value: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/v1/models/preference`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: value || null }),
    });
    if (!r.ok) throw new Error(`preference ${r.status}`);
    cache = null;
    return true;
  } catch (e) {
    console.warn('保存模型偏好失败(不影响本次操作):', e);
    return false;
  }
}

/**
 * 把一个已有的选择值对齐到当前清单。
 *
 * 三种情况都要能落地:
 *   "gpt5"                     老值/兜底值 → 保留(= 该厂商默认型号), 后端认
 *   "gemini:gemini-3.8-flash"  仍在清单里 → 原样保留
 *   "gemini:已下架的型号"        清单里没了 → 退回该厂商的默认值, 而不是留一个死选项
 * 找不到对应厂商时返回清单里的第一个可选值, 保证 select 永远有值可显示。
 */
export function resolveModelValue(current: string, cat: ModelCatalog): string {
  const all = cat.groups.flatMap((g) => g.models);
  if (all.some((m) => m.value === current)) return current;
  const provider = (current || '').split(':')[0];
  const group = cat.groups.find((g) => g.provider === provider);
  if (group) {
    const def = cat.defaults[provider];
    if (def && group.models.some((m) => m.value === def)) return def;
    if (group.models.length) return group.models[0].value;
    return provider; // 该厂商没列型号时, 光厂商名也是合法值
  }
  return all[0]?.value || current;
}

/** 下拉里每个 option 的后缀: 稳 / 几条路可用。⚠ 不暴露渠道名。 */
export function modelBadge(m: ModelItem): string {
  if (m.stable) return '稳';
  if (m.channels_total <= 1) return m.channels_ok ? '单线路' : '';
  if (m.channels_ok > 0) return `${m.channels_ok}/${m.channels_total} 线路`;
  return m.checked_at ? '暂不可用' : '未实测';
}

/**
 * provider id → 人话厂商名（如 `qwenapi` → 「通义千问」）。
 *
 * ⚠️ 2026-10-10 新增。此前草稿页是**三选一的三元表达式**
 * （`vendor === 'deepseek' ? … : vendor === 'grok' ? … : 'Gemini'`），
 * 兜底那个分支把**所有未知厂商都写成 "Gemini"**。以前厂商只有四个、
 * 且都在那个表达式里，所以看不出问题；新增五个分组之后，
 * 选「Kimi」会弹出"切换到 Gemini"—— 提示与实际完全相反。
 *
 * 优先用清单里的 label（后端下发的，唯一事实来源）；清单里还没有该分组时
 * （比如接口不可达、走了 FALLBACK_CATALOG）退回兜底表，最后才回落 id 本身 ——
 * 宁可显示 `qwenapi` 这种 id，也不要**编造**一个错误的厂商名。
 */
export function vendorLabel(provider: string, cat?: ModelCatalog | null): string {
  const g = cat?.groups.find((x) => x.provider === provider);
  if (g?.label) return g.label;
  const fb = FALLBACK_CATALOG.groups.find((x) => x.provider === provider);
  return fb?.label || provider || '';
}
