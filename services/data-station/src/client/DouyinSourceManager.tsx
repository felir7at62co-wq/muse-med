import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, ExternalLink, LoaderCircle, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { DouyinSourceInput, DouyinSourceValidation, ManagedDouyinSource } from '../shared/types';
import { request } from './api';
import { displayTitle } from './components';

interface SourceList { sources: ManagedDouyinSource[]; maxSources: number; }
interface SourceForm extends Omit<DouyinSourceInput, 'includeKeywords' | 'excludeKeywords'> {
  includeText: string;
  excludeText: string;
}
interface Editor { id: string | null; updatedAt?: string; form: SourceForm; }

function blankForm(): SourceForm {
  return { label: '', videoId: '', mode: 'creator', expectedAuthor: '', includeText: '',
    excludeText: '教程，教学，直播，带货，测评，全流程', enabled: true, maxVideos: 8 };
}

function editForm(source: ManagedDouyinSource): SourceForm {
  return { label: source.label, videoId: source.videoId, mode: source.mode, expectedAuthor: source.expectedAuthor,
    includeText: source.includeKeywords.join('，'), excludeText: source.excludeKeywords.join('，'),
    enabled: source.enabled, maxVideos: source.maxVideos };
}

function keywords(value: string): string[] {
  return [...new Set(value.split(/[,，、;；\n]+/u).map(item => item.trim()).filter(Boolean))];
}

function sourceInput(form: SourceForm): DouyinSourceInput {
  return { label: form.label.trim(), videoId: form.videoId.trim(), mode: form.mode,
    expectedAuthor: form.expectedAuthor.trim(), includeKeywords: keywords(form.includeText),
    excludeKeywords: keywords(form.excludeText), enabled: form.enabled, maxVideos: form.mode === 'video' ? 1 : form.maxVideos };
}

function sourceDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

/** Administrator controls for explicitly selected public videos and creator windows. */
export function DouyinSourceManager({ notify }: { notify: (text: string, error?: boolean) => void }) {
  const [list, setList] = useState<SourceList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [formError, setFormError] = useState('');
  const [validation, setValidation] = useState<DouyinSourceValidation | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const mounted = useRef(false);
  const loadSerial = useRef(0);
  const formElement = useRef<HTMLFormElement>(null);
  const busy = action !== null;

  const load = useCallback(async () => {
    const serial = ++loadSerial.current;
    setLoading(true); setError('');
    try {
      const value = await request<SourceList>('/api/admin/douyin/sources');
      if (mounted.current && serial === loadSerial.current) setList(value);
    } catch (reason) {
      if (mounted.current && serial === loadSerial.current) setError(reason instanceof Error ? reason.message : '来源列表暂时无法读取');
    } finally {
      if (mounted.current && serial === loadSerial.current) setLoading(false);
    }
  }, []);

  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadSerial.current++; }; }, [load]);

  const beginEditing = (source?: ManagedDouyinSource) => {
    setEditor({ id: source?.id ?? null, updatedAt: source?.updatedAt, form: source ? editForm(source) : blankForm() });
    setFormError(''); setValidation(null); setRemovingId(null);
  };
  const closeEditor = () => { setEditor(null); setFormError(''); setValidation(null); };
  const changeForm = (fields: Partial<SourceForm>) => {
    setEditor(current => current ? { ...current, form: { ...current.form, ...fields } } : null);
    setValidation(null); setFormError('');
  };

  const validate = async () => {
    if (!editor || busy || !formElement.current?.reportValidity()) return;
    setAction('validate'); setFormError(''); setValidation(null);
    try {
      const value = await request<DouyinSourceValidation>('/api/admin/douyin/sources/validate', { method: 'POST', body: JSON.stringify(sourceInput(editor.form)) });
      if (!mounted.current) return;
      setValidation(value);
      if (!editor.form.expectedAuthor.trim()) setEditor(current => current ? { ...current, form: { ...current.form, expectedAuthor: value.author } } : null);
    } catch (reason) {
      if (mounted.current) setFormError(reason instanceof Error ? reason.message : '来源核对未完成，请稍后重试');
    } finally { if (mounted.current) setAction(null); }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || busy) return;
    setAction('save'); setFormError('');
    try {
      await request(editor.id ? `/api/admin/douyin/sources/${encodeURIComponent(editor.id)}` : '/api/admin/douyin/sources', {
        method: editor.id ? 'PUT' : 'POST', body: JSON.stringify(sourceInput(editor.form)),
        ...(editor.updatedAt ? { headers: { 'If-Match': editor.updatedAt } } : {}),
      });
      if (!mounted.current) return;
      closeEditor();
      await load();
      if (mounted.current) notify('抖音来源已保存，下次采集使用新配置');
    } catch (reason) {
      if (mounted.current) setFormError(reason instanceof Error ? reason.message : '来源保存未完成，请稍后重试');
    } finally { if (mounted.current) setAction(null); }
  };

  const toggle = async (source: ManagedDouyinSource) => {
    if (busy) return;
    setAction(source.id); setError(''); setRemovingId(null);
    try {
      await request(`/api/admin/douyin/sources/${encodeURIComponent(source.id)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: !source.enabled }),
      });
      if (!mounted.current) return;
      await load();
      if (mounted.current) notify(`${source.label}已${source.enabled ? '停用' : '启用'}`);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '来源状态更新未完成');
    } finally { if (mounted.current) setAction(null); }
  };

  const remove = async (source: ManagedDouyinSource) => {
    if (busy) return;
    setAction(source.id); setError('');
    try {
      await request(`/api/admin/douyin/sources/${encodeURIComponent(source.id)}`, { method: 'DELETE' });
      if (!mounted.current) return;
      setRemovingId(null);
      if (editor?.id === source.id) closeEditor();
      await load();
      if (mounted.current) notify('来源已移除，已采集的作品仍保留');
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '来源移除未完成');
    } finally { if (mounted.current) setAction(null); }
  };

  return <section className="panel douyin-source-manager" aria-label="抖音来源管理" data-testid="douyin-source-manager">
    <div className="douyin-source-heading"><div><h2>抖音来源管理</h2><p>选择要持续关注的剧情作者或视频。每次采集读取已启用来源的公开窗口，保留原始发布时间。</p></div><div className="douyin-source-heading-actions">
      <button className="button button-outline" onClick={() => void load()} disabled={busy || loading} aria-label="刷新抖音来源"><RefreshCw size={14} className={loading ? 'spin' : ''} />刷新</button>
      <button className="button button-primary" onClick={() => beginEditing()} disabled={busy || !list || list.sources.length >= list.maxSources} aria-label="新增抖音来源"><Plus size={15} />新增来源</button>
    </div></div>
    <div className="douyin-source-summary"><span>{list ? `${list.sources.filter(source => source.enabled).length} 个已启用 · 共 ${list.sources.length} / ${list.maxSources} 个来源` : loading ? '正在读取来源…' : '来源暂时无法读取'}</span><span>当前是视频监测，尚未接入全站短剧榜或自动发现。</span></div>
    {error && <div className="douyin-source-error" role="alert"><span>{error}</span><button onClick={() => void load()} disabled={busy || loading}>重新读取</button></div>}
    {editor && <form ref={formElement} className="douyin-source-editor" aria-label={editor.id ? '编辑抖音来源' : '新增抖音来源'} data-testid="douyin-source-editor" onSubmit={event => void save(event)}>
      <div className="douyin-source-editor-heading"><h3>{editor.id ? '编辑来源' : '新增来源'}</h3><button className="icon-button" type="button" aria-label="关闭来源编辑" disabled={busy} onClick={closeEditor}><X size={17} /></button></div>
      <fieldset disabled={busy} className="douyin-source-fields">
        <label><span>来源名称</span><input required maxLength={100} value={editor.form.label} onChange={event => changeForm({ label: event.target.value })} placeholder="例如：寒尸录 · 屿竹影像" /></label>
        <label><span>采集方式</span><select value={editor.form.mode} onChange={event => changeForm({ mode: event.target.value as SourceForm['mode'], maxVideos: event.target.value === 'video' ? 1 : 8 })}><option value="creator">作者近期窗口</option><option value="video">指定视频</option></select></label>
        <label className="douyin-source-field-wide"><span>{editor.form.mode === 'creator' ? '作者定位视频 ID 或官方链接' : '视频 ID 或官方链接'}</span><input required maxLength={1000} value={editor.form.videoId} onChange={event => changeForm({ videoId: event.target.value })} placeholder="粘贴官方视频链接，或输入视频 ID" /><small>{editor.form.mode === 'creator' ? '用该作者的一条公开视频定位账号，再读取当前公开窗口。' : '只更新指定视频的数据。'}</small></label>
        <label><span>核对作者名称（选填）</span><input maxLength={100} value={editor.form.expectedAuthor} onChange={event => changeForm({ expectedAuthor: event.target.value })} placeholder="留空时从官方页面核对" /></label>
        <label><span>每次最多采集视频数</span><input type="number" required min={1} max={20} step={1} disabled={editor.form.mode === 'video'} value={editor.form.maxVideos} onChange={event => changeForm({ maxVideos: Number(event.target.value) })} /><small>{editor.form.mode === 'video' ? '指定视频固定为 1 条。' : '1–20 条；以来源实际公开的窗口为准。'}</small></label>
        <label><span>只采这些关键词（选填）</span><textarea rows={2} maxLength={4000} value={editor.form.includeText} onChange={event => changeForm({ includeText: event.target.value })} placeholder="建议填写剧名，例如：寒尸录，神豹奇缘" /><small>包含任一关键词即可，用逗号或换行分隔。</small></label>
        <label><span>排除关键词（选填）</span><textarea rows={2} maxLength={4000} value={editor.form.excludeText} onChange={event => changeForm({ excludeText: event.target.value })} placeholder="例如：教程，教学，直播" /><small>命中任一关键词就排除，帮助分开剧情与其他动态。</small></label>
        <label className="douyin-source-enabled"><input type="checkbox" checked={editor.form.enabled} onChange={event => changeForm({ enabled: event.target.checked })} /><span>启用此来源</span></label>
      </fieldset>
      {formError && <p className="douyin-source-form-error" role="alert">{formError}</p>}
      {validation && <div className="douyin-source-validation" role="status" data-testid="douyin-source-validation"><div><CheckCircle2 size={17} /><strong>来源核对通过 · {validation.author}</strong><span>{validation.count} 条样本</span></div><p>仅核对来源，未将样本加入作品库。</p><ul>{validation.works.map(work => <li key={work.sourceId}><a href={work.sourceUrl} target="_blank" rel="noreferrer">{displayTitle(work)}<ExternalLink size={11} /></a>{work.title === null && <small>来源 ID：{work.sourceId}</small>}<small>{work.publishedAt ? `发布于 ${sourceDate(work.publishedAt)}` : '来源未提供发布时间'}</small></li>)}</ul><details><summary>查看本次核对范围</summary><p>{validation.coverage}</p></details></div>}
      <div className="douyin-source-editor-footer"><p>首次保存或更换定位视频、关键词时会核对来源；作品数据由后续采集更新。</p><div><button type="button" className="button button-outline" disabled={busy} onClick={closeEditor}>取消编辑</button><button type="button" className="button button-outline" disabled={busy} onClick={() => void validate()}>{action === 'validate' ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}{action === 'validate' ? '正在核对…' : '验证来源'}</button><button type="submit" className="button button-primary" disabled={busy}>{action === 'save' && <LoaderCircle size={14} className="spin" />}{action === 'save' ? '正在保存…' : '保存来源'}</button></div></div>
    </form>}
    {list?.sources.length === 0 && <div className="douyin-source-empty"><strong>还没有配置来源</strong><p>添加要关注的作者或视频后，再启动采集。移除或停用的来源不会自动恢复。</p></div>}
    <div className="douyin-source-list" aria-busy={loading || busy}>{list?.sources.map(source => <article className={`douyin-source-row${source.enabled ? '' : ' douyin-source-disabled'}`} data-testid="douyin-source-row" data-source-id={source.id} key={source.id}>
      <div className="douyin-source-row-main"><div className="douyin-source-row-title"><strong>{source.label}</strong><span className={`douyin-source-state${source.enabled ? ' douyin-source-state-enabled' : ''}`}>{source.enabled ? '已启用' : '已停用'}</span><span className="douyin-source-mode">{source.mode === 'creator' ? '作者近期窗口' : '指定视频'}</span></div><p>{source.expectedAuthor || '待核对作者'}<span>·</span>每次最多 {source.mode === 'video' ? 1 : source.maxVideos} 条<span>·</span>{source.validatedAt ? `验证于 ${sourceDate(source.validatedAt)}` : '采集时核对身份'}</p><div className="douyin-source-row-meta"><a href={`https://jingxuan.douyin.com/m/video/${encodeURIComponent(source.videoId)}`} target="_blank" rel="noreferrer">定位视频 {source.videoId}<ExternalLink size={11} /></a><button type="button" onClick={() => setExpandedId(expandedId === source.id ? null : source.id)} aria-expanded={expandedId === source.id} aria-label={`查看${source.label}筛选条件`}>筛选条件{expandedId === source.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button></div>{expandedId === source.id && <dl className="douyin-source-keywords"><div><dt>只采关键词</dt><dd>{source.includeKeywords.length ? source.includeKeywords.join('、') : '未限制关键词'}</dd></div><div><dt>排除关键词</dt><dd>{source.excludeKeywords.length ? source.excludeKeywords.join('、') : '未设置'}</dd></div></dl>}</div>
      <div className="douyin-source-row-actions">{removingId === source.id ? <div className="douyin-source-remove-confirm"><span>仅移除来源，保留作品数据。</span><button className="button button-outline" disabled={busy} onClick={() => setRemovingId(null)}>取消</button><button className="button button-outline douyin-source-remove" disabled={busy} onClick={() => void remove(source)}>确认移除</button></div> : <><button className="button button-outline" disabled={busy || loading} onClick={() => beginEditing(source)} aria-label={`编辑${source.label}`}>编辑</button><button className="button button-outline" disabled={busy || loading} onClick={() => void toggle(source)} aria-label={`${source.enabled ? '停用' : '启用'}${source.label}`}>{action === source.id && <LoaderCircle size={12} className="spin" />}{source.enabled ? '停用' : '启用'}</button><button className="icon-button douyin-source-remove" disabled={busy || loading} onClick={() => setRemovingId(source.id)} aria-label={`移除${source.label}`}><Trash2 size={14} /></button></>}</div>
    </article>)}</div>
  </section>;
}
