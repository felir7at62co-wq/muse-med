'use client';
import * as React from 'react';
import { Camera, Mountain, Move, Sun, Palette, Ban, User, Sparkles } from 'lucide-react';

/**
 * ShotPromptCard — 视频镜头卡 7 字段拆分 (PLAN §11 / 11 号设计图)
 *
 * 把单行 video_prompt 文本拆成 7 字段结构化卡片:
 *  - subject 主体  (User 图标 / 紫)
 *  - scene 场景    (Mountain / 蓝)
 *  - camera 镜头   (Camera / 青)
 *  - action 动作   (Move / 绿)
 *  - light 光线    (Sun / 黄)
 *  - style 风格    (Palette / 粉)
 *  - negative 负向 (Ban / 红)
 *
 * 解析策略:
 *  1. 优先识别中文方括号标签【主体】【场景】【镜头】【动作】【光线】【风格】【负向】
 *  2. 其次识别 prompt engineering 常见英文标签: Subject:, Scene:, Camera:, Action:, Lighting:, Style:, Negative:
 *  3. 都没识别到就把整段塞 description, 不做拆分
 *
 * 数据来源: ScriptVideoPrompt.video_prompt (单行文本) 或 plan_json (结构化)
 */

const FIELDS = [
  { key: 'subject', label: '主体', icon: User, color: 'text-primary', border: 'border-primary/40', bg: 'bg-primary/10' },
  { key: 'scene', label: '场景', icon: Mountain, color: 'text-info', border: 'border-info/40', bg: 'bg-info/10' },
  { key: 'camera', label: '镜头', icon: Camera, color: 'text-cyan', border: 'border-cyan/40', bg: 'bg-cyan/10' },
  { key: 'action', label: '动作', icon: Move, color: 'text-success', border: 'border-success/40', bg: 'bg-success/10' },
  { key: 'light', label: '光线', icon: Sun, color: 'text-warning', border: 'border-warning/40', bg: 'bg-warning/10' },
  { key: 'style', label: '风格', icon: Palette, color: 'text-pink-400', border: 'border-pink-400/40', bg: 'bg-pink-400/10' },
  { key: 'negative', label: '负向', icon: Ban, color: 'text-danger', border: 'border-danger/40', bg: 'bg-danger/10' },
] as const;

type FieldKey = typeof FIELDS[number]['key'];
type Parsed = Partial<Record<FieldKey, string>> & { description?: string };

const ZH_PATTERNS: Record<FieldKey, RegExp> = {
  subject: /【\s*主体\s*】|【\s*subject\s*】/i,
  scene: /【\s*场景\s*】|【\s*scene\s*】/i,
  camera: /【\s*镜头\s*】|【\s*camera\s*】/i,
  action: /【\s*动作\s*】|【\s*action\s*】/i,
  light: /【\s*光线\s*】|【\s*光照\s*】|【\s*lighting\s*】|【\s*light\s*】/i,
  style: /【\s*风格\s*】|【\s*style\s*】/i,
  negative: /【\s*负向\s*】|【\s*禁忌\s*】|【\s*negative\s*】/i,
};

const EN_PATTERNS: Record<FieldKey, RegExp> = {
  subject: /^\s*(?:subject|主体)\s*[:：]/i,
  scene: /^\s*(?:scene|场景)\s*[:：]/i,
  camera: /^\s*(?:camera|cam|镜头)\s*[:：]/i,
  action: /^\s*(?:action|act|动作)\s*[:：]/i,
  light: /^\s*(?:lighting|light|光线)\s*[:：]/i,
  style: /^\s*(?:style|风格)\s*[:：]/i,
  negative: /^\s*(?:negative|neg|negative\s*prompt|负向)\s*[:：]/i,
};

export function parseShotPrompt(text: string, struct?: any): Parsed {
  if (!text && !struct) return {};
  // 1) 若 plan_json 有结构化字段, 直接用
  if (struct && typeof struct === 'object') {
    const out: Parsed = {};
    for (const f of FIELDS) {
      const v = (struct as any)[f.key];
      if (typeof v === 'string' && v.trim()) (out as any)[f.key] = v.trim();
    }
    if (Object.keys(out).length > 0) return out;
  }
  if (!text) return {};

  // 2) 尝试中文方括号拆分: 把全文按【xxx】切分,逐段归类
  const result: Parsed = {};
  const allZh = Object.entries(ZH_PATTERNS).map(([k, re]) => ({ key: k as FieldKey, re }));
  // 找出每个标签出现的位置
  type Hit = { key: FieldKey; index: number; matchEnd: number };
  const hits: Hit[] = [];
  for (const { key, re } of allZh) {
    const m = text.match(re);
    if (m && m.index !== undefined) {
      hits.push({ key, index: m.index, matchEnd: m.index + m[0].length });
    }
  }
  if (hits.length >= 2) {
    hits.sort((a, b) => a.index - b.index);
    for (let i = 0; i < hits.length; i++) {
      const cur = hits[i];
      const next = hits[i + 1];
      const start = cur.matchEnd;
      const end = next ? next.index : text.length;
      const v = text.slice(start, end).trim().replace(/^[,，。；;]+|[,，。；;]+$/g, '');
      if (v) result[cur.key] = v;
    }
    return result;
  }

  // 3) 尝试英文行式拆分: 按行分, 每行匹配 "Key: value"
  const lines = text.split(/\r?\n/);
  let matchedAny = false;
  for (const line of lines) {
    for (const f of FIELDS) {
      const re = EN_PATTERNS[f.key];
      if (re.test(line)) {
        const v = line.replace(re, '').trim();
        if (v) {
          result[f.key] = v;
          matchedAny = true;
        }
        break;
      }
    }
  }
  if (matchedAny) return result;

  // 4) 都没匹配: 整段塞 description
  return { description: text.trim() };
}

export function ShotPromptCard({
  prompt,
  planJson,
  duration,
  shotNos,
  className,
}: {
  prompt: string;
  planJson?: any;
  duration?: number;
  shotNos?: number[];
  className?: string;
}) {
  const parsed = React.useMemo(() => parseShotPrompt(prompt || '', planJson), [prompt, planJson]);

  // 如果只有 description (没拆开), 退化为单段展示
  if (parsed.description && Object.keys(parsed).length === 1) {
    return (
      <div className={`rounded-lg border border-line bg-surface-base/40 p-3 ${className || ''}`}>
        <div className="flex items-center gap-2 mb-2 text-xs text-ink-muted">
          <Sparkles className="w-3.5 h-3.5" />
          <span>未结构化 prompt</span>
          {duration && <span className="ml-auto">⏱ {duration}s</span>}
          {shotNos && shotNos.length > 0 && <span>分镜 {shotNos.join(',')}</span>}
        </div>
        <p className="text-sm text-ink-primary whitespace-pre-wrap leading-relaxed">{parsed.description}</p>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border border-line bg-surface-base/40 p-3 ${className || ''}`}>
      {/* 头部 meta */}
      <div className="flex items-center gap-2 mb-3 text-xs text-ink-muted">
        <Sparkles className="w-3.5 h-3.5 text-primary" />
        <span className="font-medium text-ink-secondary">7 字段拆分</span>
        {duration !== undefined && <span className="ml-auto">⏱ {duration}s</span>}
        {shotNos && shotNos.length > 0 && (
          <span className="px-1.5 py-0.5 bg-surface-overlay rounded">
            分镜 {shotNos.join(',')}
          </span>
        )}
      </div>

      {/* 7 字段网格 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {FIELDS.map((f) => {
          const v = parsed[f.key];
          if (!v) return null;
          const Icon = f.icon;
          return (
            <div
              key={f.key}
              className={`p-2 rounded border ${f.border} ${f.bg} flex items-start gap-2`}
            >
              <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${f.color}`} />
              <div className="min-w-0 flex-1">
                <div className={`text-[10px] font-bold uppercase tracking-wider mb-0.5 ${f.color}`}>
                  {f.label}
                </div>
                <div className="text-xs text-ink-primary leading-snug whitespace-pre-wrap">
                  {v}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 缺失字段提示 */}
      {(() => {
        const missing = FIELDS.filter((f) => !parsed[f.key]).map((f) => f.label);
        if (missing.length === 0 || missing.length === FIELDS.length) return null;
        return (
          <div className="mt-2 text-[11px] text-ink-muted">
            未识别: {missing.join(' / ')}{' '}
            <span className="opacity-70">(原 prompt 未含对应字段标签)</span>
          </div>
        );
      })()}
    </div>
  );
}
