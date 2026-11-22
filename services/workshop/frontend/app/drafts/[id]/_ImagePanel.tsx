'use client';

// 草稿工作台「生图」版块: 按集模式(不生图/一镜一图/九镜一图) + 统一调度 + 角色垫图
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listImageTasks,
  setImageConfig,
  runImageTasks,
  regenerateImageTask,
  deleteImageTask,
  listCharacters,
  createCharacter,
  deleteCharacter,
  uploadCharacterImage,
  patchCharacterImage,
  deleteCharacterImage,
  IMAGE_MODELS,
  EPISODE_MODE_LABELS,
  type EpisodeImage,
  type EpisodeMode,
  type DraftCharacter,
} from '../../../lib/draftImage';

const ASPECTS = [
  { value: '1024x1024', label: '1:1 方形' },
  { value: '1080x1920', label: '9:16 竖屏' },
  { value: '1920x1080', label: '16:9 横屏' },
  { value: '1024x1536', label: '2:3 竖屏' },
];
const QUALITY = [
  { value: '1K', long: 1920, label: '1K' },
  { value: '2K', long: 2560, label: '2K' },
  { value: '4K', long: 3840, label: '4K' },
];

function buildSize(aspect: string, quality: string): string {
  const [w, h] = aspect.split('x').map(Number);
  const q = QUALITY.find((x) => x.value === quality) || QUALITY[1];
  const long = q.long;
  if (w >= h) {
    const hh = Math.round((long * h) / w);
    return `${long}x${hh}`;
  }
  const ww = Math.round((long * w) / h);
  return `${ww}x${long}`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中', running: '生成中', succeeded: '完成', failed: '失败',
};

export default function ImagePanel({ draftId }: { draftId: number }) {
  const [episodes, setEpisodes] = useState<EpisodeImage[]>([]);
  const [chars, setChars] = useState<DraftCharacter[]>([]);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState<string>(IMAGE_MODELS[0].value);
  const [aspect, setAspect] = useState(ASPECTS[1].value);
  const [quality, setQuality] = useState('2K');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const [t, c] = await Promise.all([listImageTasks(draftId), listCharacters(draftId)]);
    setEpisodes(t.episodes);
    setRunning(t.running);
    setChars(c);
    setLoading(false);
  }, [draftId]);

  useEffect(() => { refresh(); }, [refresh]);

  // 有运行中任务时轮询
  useEffect(() => {
    if (running) {
      if (!pollRef.current) pollRef.current = setInterval(refresh, 4000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [running, refresh]);

  const changeMode = async (chapterOrder: number, mode: EpisodeMode) => {
    setEpisodes((prev) => prev.map((e) => (e.chapter_order === chapterOrder ? { ...e, mode } : e)));
    try {
      await setImageConfig(draftId, [{ chapter_order: chapterOrder, mode }]);
    } catch (e: any) {
      setMsg(e?.message || '保存失败');
      refresh();
    }
  };

  const runAll = async (chapterOrders?: number[]) => {
    setBusy(true);
    setMsg('');
    try {
      const size = buildSize(aspect, quality);
      const r = await runImageTasks(draftId, { chapter_orders: chapterOrders || null, model, size });
      setMsg(r.message);
      setRunning(true);
      await refresh();
    } catch (e: any) {
      setMsg(e?.message || '发起失败');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="p-6 text-sm text-ink-muted">加载中…</div>;

  return (
    <div className="space-y-6 p-1">
      {/* 顶部统一调度 */}
      <div className="rounded-lg border border-line bg-surface-raised p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs text-ink-secondary">
            模型
            <select className="mt-1 rounded border px-2 py-1.5 text-sm" value={model} onChange={(e) => setModel(e.target.value)}>
              {IMAGE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs text-ink-secondary">
            画面比例
            <select className="mt-1 rounded border px-2 py-1.5 text-sm" value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {ASPECTS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col text-xs text-ink-secondary">
            画质
            <select className="mt-1 rounded border px-2 py-1.5 text-sm" value={quality} onChange={(e) => setQuality(e.target.value)}>
              {QUALITY.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() => runAll()}
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? '发起中…' : '全部生图'}
          </button>
          {running && <span className="text-xs text-amber-600">● 有任务生成中…</span>}
        </div>
        <p className="text-xs text-ink-muted">
          九镜一图模式会把该集每 9 个镜头合成一张 3×3 大图再切成 9 张(按所选画面比例、放大到≥2K 保证切后清晰);角色垫图按提示词命中的角色名自动注入。
        </p>
        {msg && <p className="text-xs text-indigo-600">{msg}</p>}
      </div>

      {/* 角色垫图区 */}
      <CharacterSection
        draftId={draftId}
        chars={chars}
        episodeOrders={episodes.map((e) => e.chapter_order)}
        onChanged={refresh}
        setMsg={setMsg}
      />

      {/* 按集任务卡 */}
      <div className="space-y-4">
        {episodes.length === 0 && (
          <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-ink-muted">
            还没有提示词数据。请先在「提示词」版块规划并渲染,这里会按集自动列出生图任务。
          </div>
        )}
        {episodes.map((ep) => (
          <div key={ep.chapter_order} className="rounded-lg border border-line bg-surface-raised p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className="font-medium">第 {ep.chapter_order} 集</span>
                <span className="text-xs text-ink-muted">
                  {ep.image_prompt_count}/{ep.prompt_count} 个镜头有图提示词
                </span>
              </div>
              <div className="flex items-center gap-2">
                {(['none', 'single', 'grid9'] as EpisodeMode[]).map((m) => {
                  const on = ep.mode === m;
                  return (
                    <button
                      key={m}
                      onClick={() => changeMode(ep.chapter_order, m)}
                      aria-pressed={on}
                      className={`rounded-full px-3 py-1 text-xs transition ${
                        on
                          ? 'bg-indigo-600 text-white font-medium'
                          : 'bg-surface-overlay text-ink-secondary hover:bg-surface-overlay'
                      }`}
                    >
                      {on ? '● ' : ''}{EPISODE_MODE_LABELS[m]}
                    </button>
                  );
                })}
                <button
                  disabled={busy || ep.mode === 'none'}
                  onClick={() => runAll([ep.chapter_order])}
                  className="rounded border border-indigo-300 px-3 py-1 text-xs text-indigo-600 hover:bg-indigo-500/10 disabled:opacity-40"
                >
                  生成本集
                </button>
              </div>
            </div>

            {ep.tasks.length > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {ep.tasks.map((t) => (
                  <div key={t.id} className="rounded border border-line p-2">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
                      <span>{t.mode === 'grid9' ? `九宫格·镜${t.shot_indexes.join(',')}` : `镜 ${t.shot_indexes[0]}`}</span>
                      <span className={t.status === 'failed' ? 'text-red-500' : t.status === 'succeeded' ? 'text-green-600' : 'text-amber-600'}>
                        {STATUS_LABEL[t.status] || t.status}
                      </span>
                    </div>
                    {t.result_urls.length > 0 ? (
                      <div className={`grid gap-1 ${t.mode === 'grid9' ? 'grid-cols-3' : 'grid-cols-1'}`}>
                        {t.result_urls.map((u, i) => (
                          <a key={i} href={u} target="_blank" rel="noreferrer" className="block">
                            <img src={u} alt="" className="aspect-square w-full rounded object-cover" />
                          </a>
                        ))}
                      </div>
                    ) : (
                      <div className="flex aspect-square items-center justify-center rounded bg-surface-base text-[11px] text-ink-muted">
                        {t.status === 'running' ? `生成中 ${t.progress}%` : t.status === 'failed' ? (t.error || '失败') : '待生成'}
                      </div>
                    )}
                    <div className="mt-1 flex justify-end gap-2 text-[11px]">
                      <button onClick={() => regenerateImageTask(draftId, t.id).then(() => { setRunning(true); refresh(); })} className="text-indigo-600 hover:underline">重生</button>
                      <button onClick={() => deleteImageTask(draftId, t.id).then(refresh)} className="text-ink-muted hover:text-red-500">删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CharacterSection({
  draftId, chars, episodeOrders, onChanged, setMsg,
}: {
  draftId: number;
  chars: DraftCharacter[];
  episodeOrders: number[];
  onChanged: () => void;
  setMsg: (s: string) => void;
}) {
  const [newName, setNewName] = useState('');
  const fileRefs = useRef<Record<number, HTMLInputElement | null>>({});

  const addChar = async () => {
    const n = newName.trim();
    if (!n) return;
    try {
      await createCharacter(draftId, n);
      setNewName('');
      onChanged();
    } catch (e: any) { setMsg(e?.message || '新建失败'); }
  };

  const onPick = async (charId: number, f: File | null) => {
    if (!f) return;
    try {
      await uploadCharacterImage(draftId, charId, f, []); // 默认全集
      onChanged();
    } catch (e: any) { setMsg(e?.message || '上传失败'); }
  };

  const toggleEp = async (imageId: number, current: number[], ep: number) => {
    const next = current.includes(ep) ? current.filter((x) => x !== ep) : [...current, ep].sort((a, b) => a - b);
    try {
      await patchCharacterImage(draftId, imageId, next);
      onChanged();
    } catch (e: any) { setMsg(e?.message || '更新失败'); }
  };

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">角色垫图 <span className="text-xs font-normal text-ink-muted">(提示词命中角色名时自动注入对应形象)</span></h3>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addChar()}
            placeholder="角色姓名"
            className="rounded border px-2 py-1 text-sm"
          />
          <button onClick={addChar} className="rounded bg-surface-overlay px-3 py-1 text-sm text-white hover:bg-surface-base">+ 添加角色</button>
        </div>
      </div>

      {chars.length === 0 && <p className="text-xs text-ink-muted">尚未添加角色。添加角色并上传形象图后,凡提示词中出现该角色姓名的镜头会自动以对应形象做垫图。</p>}

      <div className="space-y-4">
        {chars.map((c) => (
          <div key={c.id} className="rounded border border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium text-sm">{c.name}</span>
              <div className="flex gap-2 text-xs">
                <button onClick={() => fileRefs.current[c.id]?.click()} className="text-indigo-600 hover:underline">+ 上传形象</button>
                <button onClick={() => deleteCharacter(draftId, c.id).then(onChanged)} className="text-ink-muted hover:text-red-500">删除角色</button>
                <input
                  ref={(el) => { fileRefs.current[c.id] = el; }}
                  type="file" accept="image/*" hidden
                  onChange={(e) => { onPick(c.id, e.target.files?.[0] || null); e.currentTarget.value = ''; }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {c.images.map((im) => (
                <div key={im.id} className="rounded border border-line p-2">
                  {im.url && <img src={im.url} alt="" className="aspect-square w-full rounded object-cover" />}
                  <div className="mt-1 text-[11px] text-ink-muted">适用集 {im.episodes.length === 0 ? '(全部)' : ''}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {episodeOrders.map((ep) => {
                      const on = im.episodes.includes(ep);
                      return (
                        <button
                          key={ep}
                          onClick={() => toggleEp(im.id, im.episodes, ep)}
                          aria-pressed={on}
                          title={on ? `第${ep}集 已选用` : `点击让第${ep}集启用此形象`}
                          className={`rounded px-1.5 py-0.5 text-[10px] transition ${
                            on
                              ? 'bg-indigo-600 text-white font-medium ring-1 ring-indigo-400'
                              : 'bg-surface-overlay text-ink-muted hover:bg-surface-overlay'
                          }`}
                        >{on ? '✓' : ''}{ep}</button>
                      );
                    })}
                  </div>
                  <button onClick={() => deleteCharacterImage(draftId, im.id).then(onChanged)} className="mt-1 text-[11px] text-ink-muted hover:text-red-500">删除形象</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}