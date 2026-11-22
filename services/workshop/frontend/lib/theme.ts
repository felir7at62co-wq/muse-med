/**
 * 主题管理:CSS变量注入 + 偏好存储 + 同步到后端
 */
import { authFetch } from "./auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const THEME_KEY = "drama_theme_config";

export type ThemeConfig = {
  mode?: "light" | "dark" | "auto";
  /**
   * 中性色基线。决定"底色/文字/描边"这一整组的温度，与 primary_color 正交。
   *
   * 为什么必须与 mode 分开: mode 只管明暗, 而「纸感」需要的是**暖色中性**
   * (米白底 + 暖黑字 + 淡褐描边)。只换主色会得到"冷白底 + 棕按钮", 不是书页。
   * 见 app/globals.css 里 html.paper 段的详细说明。
   *
   * 取值:
   *   "paper" —— 纸感暖色 (默认, 见 §6.1 的色板)
   *   省略    —— 沿用 mode 决定的冷色基线 (即改造前的行为)
   */
  palette?: "paper" | "default";
  primary_color?: string;   // #hex
  accent_color?: string;
  // 历史字段(背景图/模糊等)已下线; 保留为可选以兼容旧 localStorage/后端数据, UI 不再暴露。
  bg_type?: "gradient" | "solid" | "image" | "default";
  bg_value?: string;
  bg_opacity?: number;
  bg_blur?: number;
};

export const DEFAULT_THEME: ThemeConfig = {
  mode: "light",
  // 纸感为默认基线 —— 新版设计以书页感为基调 (PLAN-剧本平台全面升级 §6)
  palette: "paper",
  primary_color: "#8B5E34",  // 赭石棕
  accent_color: "#7A8B6F",   // 暖灰绿
};

// 精简主题预设: 明暗为"模式", 这里只定义"主色"(与模式正交)。
// 每项含 primary/accent 及其 hover 派生(浅一档), 供 applyTheme 注入多档明度变量。
export const PRESET_COLORS = [
  { name: "赭石棕(默认)", primary: "#8B5E34", primaryHover: "#A67144", accent: "#7A8B6F", accentHover: "#8F9F83" },
  { name: "深蓝", primary: "#3b82f6", primaryHover: "#60a5fa", accent: "#06b6d4", accentHover: "#22d3ee" },
  { name: "翡翠绿", primary: "#10b981", primaryHover: "#34d399", accent: "#14b8a6", accentHover: "#2dd4bf" },
  { name: "经典紫", primary: "#8b5cf6", primaryHover: "#a78bfa", accent: "#ec4899", accentHover: "#f472b6" },
  { name: "石墨灰", primary: "#64748b", primaryHover: "#94a3b8", accent: "#94a3b8", accentHover: "#cbd5e1" },
  { name: "暖橙", primary: "#f97316", primaryHover: "#fb923c", accent: "#f59e0b", accentHover: "#fbbf24" },
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/** 由主色 hex 派生一档更亮的 hover 色 (找不到预设时兜底用)。 */
function lighten(hex: string, amount = 0.22): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
}

/** 在 PRESET_COLORS 里按 primary 找配套 hover/accent; 找不到则现算。 */
function resolvePalette(cfg: ThemeConfig) {
  const primary = cfg.primary_color || DEFAULT_THEME.primary_color!;
  const accent = cfg.accent_color || DEFAULT_THEME.accent_color!;
  const hit = PRESET_COLORS.find(
    (p) => p.primary.toLowerCase() === primary.toLowerCase(),
  );
  return {
    primary,
    primaryHover: hit?.primaryHover || lighten(primary),
    accent: hit?.accent || accent,
    accentHover: hit?.accentHover || lighten(accent),
  };
}

/**
 * 应用主题到DOM(CSS变量 + data-theme属性)
 */
export function applyTheme(cfg: ThemeConfig) {
  if (typeof document === "undefined") return;
  const full = { ...DEFAULT_THEME, ...cfg };
  const root = document.documentElement;

  // 主色: 注入 channel 形式 "R G B" 的多档明度变量 (供 tokens.ts 的语义色引用)
  const pal = resolvePalette(full);
  const setRgb = (name: string, hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    root.style.setProperty(name, `${r} ${g} ${b}`);
  };
  setRgb("--c-primary", pal.primary);
  setRgb("--c-primary-hover", pal.primaryHover);
  setRgb("--c-accent", pal.accent);
  setRgb("--c-accent-hover", pal.accentHover);
  // 兼容旧变量 (globals.css 里 .bg-purple-* 等历史规则仍引用 --color-primary/-accent)
  setRgb("--color-primary", pal.primary);
  setRgb("--color-accent", pal.accent);
  root.style.setProperty("--color-primary-hex", pal.primary);
  root.style.setProperty("--color-accent-hex", pal.accent);

  // 模式 (明/暗/跟随系统)
  // ⚠️ 兜底必须与 DEFAULT_THEME.mode 一致（light）。
  // 原来写的是 "dark"，在 paper 强制走浅色的年代无害；解绑明暗之后，
  // 老用户存的配置里若 mode 键存在但为 undefined，就会被兜底成深色 ——
  // 等于给一批人无声换了主题。
  let mode = full.mode || DEFAULT_THEME.mode || "light";
  if (mode === "auto") {
    mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.setAttribute("data-theme", mode);

  // 中性色基线 (纸感 / 默认冷色)。
  //
  // ⚠️ paper 必须**同时**带 html.light 类: globals.css 里 html.light 段承载了大量
  // 既有适配(表单控件、原生 select 选项弹层、渐变底色修正等), 丢掉它会让这些地方
  // 变回暗色样式。paper 段排在 light 段之后, 所以它能覆盖中性色而不影响那些适配。
  const isPaper = (full.palette || "default") === "paper";
  root.classList.toggle("paper", isPaper);

  // 明暗一律按 mode 决定 —— paper 只管"中性色的温度"，不再绑定明度。
  //
  // ⚠️ 这里原来是 `const useLight = isPaper || mode !== "dark"`，
  // 即**纸感强制走浅色**。后果是 v2 用户在主题设置里点「深色」毫无反应
  // （2026-09-24 用户反馈）。暖色与明暗本来正交，纸感也可以是墨夜的，
  // 所以深色纸感由 globals.css 的 `html.paper.dark` 段承载。
  //
  // ⚠️ 深色下**不加 `light` 类**是有意的：globals.css 168 行起有一大片
  // `html.light [class*=bg-slate-*] { background: 白 }` 之类的遗留强制适配，
  // 深色带上它会把卡片、输入框统统涂白（那层曾把隐形 textarea 涂成白色）。
  if (mode !== "dark") {
    root.classList.add("light");
    root.classList.remove("dark");
  } else {
    root.classList.add("dark");
    root.classList.remove("light");
  }
}

/**
 * 从localStorage读
 */
export function loadLocalTheme(): ThemeConfig {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw) return { ...DEFAULT_THEME, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_THEME;
}

/**
 * 保存到localStorage + 同步到后端
 */
export async function saveTheme(cfg: ThemeConfig, syncServer = true) {
  localStorage.setItem(THEME_KEY, JSON.stringify(cfg));
  applyTheme(cfg);
  if (syncServer) {
    try {
      await authFetch(`${BASE}/v1/auth/me/theme`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
    } catch {}
  }
}

/**
 * 应用初始化:从后端加载,失败则用localStorage
 */
export async function initTheme() {
  // 先用localStorage立即生效
  applyTheme(loadLocalTheme());
  // 异步拉后端最新
  try {
    const res = await authFetch(`${BASE}/v1/auth/me/theme`);
    if (res.ok) {
      const serverCfg = await res.json();
      if (serverCfg && Object.keys(serverCfg).length > 0) {
        localStorage.setItem(THEME_KEY, JSON.stringify(serverCfg));
        applyTheme(serverCfg);
      }
    }
  } catch {}
}

/** 上传背景图 */
export async function uploadThemeBg(file: File): Promise<{ url: string; ok: boolean; error?: string }> {
  if (file.size > 10 * 1024 * 1024) {
    return { ok: false, url: "", error: "文件超过10MB" };
  }
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await authFetch(`${BASE}/v1/auth/me/theme-bg`, {
      method: "POST", body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "上传失败" }));
      return { ok: false, url: "", error: err.detail };
    }
    const data = await res.json();
    return { ok: true, url: data.url };
  } catch (e: any) {
    return { ok: false, url: "", error: String(e) };
  }
}
