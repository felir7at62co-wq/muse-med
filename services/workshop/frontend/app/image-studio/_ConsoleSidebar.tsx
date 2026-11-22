'use client';

import React, { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { FormField } from '@/components/ui/FormField';
import { Badge } from '@/components/ui/Badge';
import {
  IMAGE_MODELS, TEXT_ONLY_MODELS, REF_PROCESS_MODEL, IMAGE_ASPECTS, IMAGE_QUALITIES, MAX_REF_IMAGES,
  resolveSize, type Preset, type Workflow,
} from '@/lib/imageStudio';
import { HoverZoomThumb } from './_imageExtras';

export type RefImage = { oss_key: string; url: string; uploading?: boolean; tmpId: string; label?: string };

export type ConsoleState = {
  presets: Preset[];
  presetId: number | null;
  model: string;
  aspect: string;
  quality: string;
  n: number;
  prompt: string;
  refs: RefImage[];
  submitting: boolean;
  concurrency: { limit: number; running: number; pending: number } | null;
  autoHd: boolean;
  optimizePrompt: boolean;
  autoPolish: boolean;
  workflows: Workflow[];
  workflowId: string | null;
};

export type ConsoleHandlers = {
  setPresetId: (v: number | null) => void;
  setModel: (v: string) => void;
  setAspect: (v: string) => void;
  setQuality: (v: string) => void;
  setN: (v: number) => void;
  setPrompt: (v: string) => void;
  onPickFiles: (files: FileList | null) => void;
  removeRef: (tmpId: string) => void;
  setRefLabel: (tmpId: string, label: string) => void;
  onSubmit: () => void;
  setAutoHd: (v: boolean) => void;
  setOptimizePrompt: (v: boolean) => void;
  setAutoPolish: (v: boolean) => void;
  setWorkflowId: (v: string | null) => void;
};

export function ConsoleSidebar({ state, on }: { state: ConsoleState; on: ConsoleHandlers }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const { presets, presetId, model, aspect, quality, n, prompt, refs, submitting, concurrency, autoHd, optimizePrompt, autoPolish, workflows, workflowId } = state;
  // 人像专用等纯文生图模型: 参考图/提示词优化/图片润色 置灰禁用 (仅高清可用)
  const textOnly = TEXT_ONLY_MODELS.has(model);
  // 参考图处理: 不生图, 直接处理上传图; 工作流/数量/比例/画质/预置 全部置灰失效;
  //   参考图必填(不置灰); 提示词仅勾选润色时生效; 提示词优化置灰。
  const refProcess = model === REF_PROCESS_MODEL;
  const activePreset = presets.find((p) => p.id === presetId);
  const activeWf = workflows.find((w) => w.id === workflowId);
  const busy = refs.some((r) => r.uploading);
  const readyRefUrls = refs.filter((r) => !r.uploading && r.url).map((r) => r.url);
  const aspectLocked = !!activeWf?.force_aspect || refProcess;
  const effectiveAspect = activeWf?.force_aspect || aspect;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-body font-semibold">创作控制台</h2>
        {concurrency && (
          <Badge tone={concurrency.pending > 0 ? 'warning' : 'info'}>
            并发 {concurrency.running}/{concurrency.limit}
            {concurrency.pending > 0 ? ` · 排队 ${concurrency.pending}` : ''}
          </Badge>
        )}
      </div>

      {workflows.length > 0 && (
        <FormField label="工作流" hint={refProcess ? '参考图处理不使用工作流' : activeWf?.desc}>
          <Select value={refProcess ? '' : (workflowId || '')} onChange={(e) => on.setWorkflowId(e.target.value || null)} disabled={refProcess}>
            <option value="">普通生成</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
        </FormField>
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormField label="模型">
          <Select value={model} onChange={(e) => on.setModel(e.target.value)}>
            {IMAGE_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </Select>
        </FormField>
        <FormField label={refProcess ? '数量 (逐张处理)' : '数量'}>
          <Select value={String(n)} onChange={(e) => on.setN(Number(e.target.value))} disabled={!!activeWf || refProcess}>
            {[1, 2, 3, 4].map((v) => (
              <option key={v} value={v}>{v} 张</option>
            ))}
          </Select>
        </FormField>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormField label={refProcess ? '比例 (不适用)' : aspectLocked ? '比例 (工作流锁定)' : '比例'}>
          <Select value={effectiveAspect} onChange={(e) => on.setAspect(e.target.value)} disabled={aspectLocked}>
            {IMAGE_ASPECTS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </Select>
        </FormField>
        <FormField label={refProcess ? '画质 (不适用)' : '画质'} hint={refProcess ? undefined : resolveSize(effectiveAspect, quality)}>
          <Select value={quality} onChange={(e) => on.setQuality(e.target.value)} disabled={refProcess}>
            {IMAGE_QUALITIES.map((q) => (
              <option key={q.value} value={q.value}>{q.label}</option>
            ))}
          </Select>
        </FormField>
      </div>

      <FormField label="预置风格（可选）" hint={refProcess ? '参考图处理不使用预置风格' : (activePreset?.prefix_text ? `前缀: ${activePreset.prefix_text}` : undefined)}>
        <Select value={refProcess ? '' : (presetId == null ? '' : String(presetId))} onChange={(e) => on.setPresetId(e.target.value ? Number(e.target.value) : null)} disabled={refProcess}>
          <option value="">不使用</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>{p.category ? `[${p.category}] ` : ''}{p.name}</option>
          ))}
        </Select>
      </FormField>

      <FormField label="提示词" hint={refProcess ? '仅在勾选「图片润色」时生效，会追加到润色预置词后；不勾润色则忽略' : (activeWf ? '工作流会自动补充专业提示词' : undefined)}>
        <Textarea rows={4} value={prompt} onChange={(e) => on.setPrompt(e.target.value)} placeholder={refProcess ? '可选：补充润色方向（仅润色时生效）…' : '描述你想要的画面…'} />
      </FormField>

      <FormField
        label={refProcess ? `上传图（必填，最多 ${MAX_REF_IMAGES} 张，逐张处理）` : `参考图（图生图，可选，最多 ${MAX_REF_IMAGES} 张）`}
        hint={textOnly ? '人像专用为纯文生图，不支持参考图' : refProcess ? '上传要处理的图片，每张各自执行所勾选的 高清/润色' : '可给每张图填标注(如角色名)；提示词里写到该名字时会自动对应到这张参考图。支持点击/拖拽/粘贴添加'}
      >
        <div
          className={`flex flex-wrap gap-2 rounded-md p-1 transition-colors ${dragOver ? 'ring-2 ring-primary bg-primary/5' : ''} ${textOnly ? 'opacity-40 pointer-events-none' : ''}`}
          onDragOver={(e) => { if (textOnly) return; e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (textOnly) return;
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer?.files?.length) on.onPickFiles(e.dataTransfer.files);
          }}
        >
          {refs.map((r, i) => (
            <div key={r.tmpId} className="relative flex flex-col gap-1 w-16">
              <div className="relative">
                {r.uploading ? (
                  <div className="w-16 h-16 rounded-md border bg-muted flex items-center justify-center text-micro text-muted-foreground">上传中</div>
                ) : (
                  <HoverZoomThumb url={r.url} alt="ref" size="h-16 w-16" allUrls={readyRefUrls} index={readyRefUrls.indexOf(r.url)} />
                )}
                <span className="absolute bottom-0.5 left-0.5 bg-primary/90 text-white rounded px-1 text-[10px] leading-4 z-10">图{i + 1}</span>
                <button onClick={() => on.removeRef(r.tmpId)} className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full w-5 h-5 text-xs leading-5 text-center z-10" aria-label="移除">×</button>
              </div>
              <input
                value={r.label || ''}
                onChange={(e) => on.setRefLabel(r.tmpId, e.target.value)}
                placeholder="标注"
                title="给这张参考图起个名字(如角色名)，提示词里写到它会对应到本图"
                className="w-16 h-6 rounded border border-line bg-surface-base px-1 text-[11px] text-ink-primary placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          ))}
          {refs.length < MAX_REF_IMAGES && (
            <button onClick={() => fileRef.current?.click()} className="w-16 h-16 rounded-md border border-dashed flex items-center justify-center text-2xl text-muted-foreground hover:bg-muted self-start" aria-label="添加参考图">+</button>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { on.onPickFiles(e.target.files); if (fileRef.current) fileRef.current.value = ''; }} />
        </div>
      </FormField>

      <div className="flex items-center gap-3 pt-1">
        <label className="flex items-center gap-2 cursor-pointer select-none text-caption text-ink-secondary">
          <input type="checkbox" checked={autoHd} onChange={(e) => on.setAutoHd(e.target.checked)} className="w-4 h-4 rounded border-line accent-primary" />
          高清
        </label>
        <label
          className={`flex items-center gap-2 select-none text-caption text-ink-secondary ${(textOnly || refProcess) ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
          title={textOnly ? '人像专用不支持提示词优化' : refProcess ? '参考图处理不支持提示词优化' : '勾选后，先用所选模型对应的文本模型优化提示词，再用优化结果生图（优化结果会显示在任务卡中）'}
        >
          <input type="checkbox" disabled={textOnly || refProcess} checked={!(textOnly || refProcess) && optimizePrompt} onChange={(e) => on.setOptimizePrompt(e.target.checked)} className="w-4 h-4 rounded border-line accent-primary" />
          提示词优化
        </label>
        <label
          className={`flex items-center gap-2 select-none text-caption text-ink-secondary ${textOnly ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
          title={textOnly ? '人像专用不支持图片润色' : refProcess ? '对每张上传图进行 AI 润色（可在提示词框补充润色方向）' : '勾选后，对生成图进行 AI 润色（去瑕疵、增强细节，保持画面内容不变）；若同时勾选高清，则先放大再润色。润色结果会作为新图并列展示。'}
        >
          <input type="checkbox" disabled={textOnly} checked={!textOnly && autoPolish} onChange={(e) => on.setAutoPolish(e.target.checked)} className="w-4 h-4 rounded border-line accent-primary" />
          图片润色
        </label>
        <Button onClick={on.onSubmit} disabled={submitting || busy} className="flex-1">
          {submitting ? '提交中…' : '生成'}
        </Button>
      </div>
    </div>
  );
}
