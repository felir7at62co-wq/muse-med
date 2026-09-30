// Account-private project participation, built on immutable Wiki evidence and cited revisions.
import {createHash} from 'node:crypto';

const statuses = {planned: '计划参与', in_progress: '进行中', completed: '已完成', blocked: '受阻', cancelled: '已取消'};
const contributionMarker = '<!-- muse-project-contribution-v1 -->';
const projectMarker = '<!-- muse-project-overview-v1 -->';
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(value)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const safeProjectKey = value => safeKey(value) && value.length <= 75;
const fail = message => { throw Object.assign(new Error(message), {wikiError: true}); };

function normalizedRecord(args) {
  return {project_key: args.project_key, project_title: args.project_title.trim(), contribution_id: args.contribution_id,
    stage: args.stage.trim(), status: args.status, content: args.content.trim(), artifacts: args.artifacts.map(value => value.replaceAll('\\', '/'))};
}
function evidenceText(record) {
  return [`项目：${record.project_title}`, `项目标识：${record.project_key}`, `参与阶段：${record.stage}`,
    `状态：${statuses[record.status]}`, '', record.content, '', '产物引用：', ...record.artifacts.map(value => '- ' + value)].join('\n');
}
function recordText(record) {
  return `${contributionMarker}\n# ${record.stage} · ${statuses[record.status]}\n\n${evidenceText(record)}\n\n## 记录字段\n\n\x60\x60\x60json\n${JSON.stringify(record)}\n\x60\x60\x60\n`;
}

/** Read only intact recorder-owned contribution pages for authorized portfolio projection.
 * @param {string} body Complete stored contribution Markdown.
 * @returns {object|null} Bounded report fields, or null for unrecognized or edited pages.
 */
export function parseProjectParticipationRecord(body) {
  if (typeof body !== 'string' || body.length > 30000 || !body.startsWith(contributionMarker + '\n')) return null;
  const at = body.lastIndexOf('\n\n## 记录字段\n\n\x60\x60\x60json\n');
  if (at < 0 || !body.endsWith('\n\x60\x60\x60\n')) return null;
  let record;
  try { record = JSON.parse(body.slice(at + '\n\n## 记录字段\n\n\x60\x60\x60json\n'.length, -5)); }
  catch { return null; }
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 7
    || !safeProjectKey(record.project_key) || !safeKey(record.contribution_id) || !Object.hasOwn(statuses, record.status)
    || typeof record.project_title !== 'string' || !record.project_title.trim() || record.project_title.length > 160
    || typeof record.stage !== 'string' || !record.stage.trim() || record.stage.length > 100
    || typeof record.content !== 'string' || !record.content.trim() || record.content.length > 5000
    || !Array.isArray(record.artifacts) || record.artifacts.length > 20
    || record.artifacts.some(value => typeof value !== 'string' || !value.trim() || value.length > 240
      || /:\/\/|^[A-Za-z]:[/\\]|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)|[?&#\r\n\x00-\x1f]/u.test(value))) return null;
  return recordText(normalizedRecord(record)) === body ? normalizedRecord(record) : null;
}

/** Save one reported contribution and refresh its account-private project overview.
 * @param {object} args Stable project/milestone keys, status, summary and relative artifact references.
 * @param {Function} call Wiki dispatcher already bound to the authenticated account.
 * @returns {Promise<object>} Read-back record IDs, revisions and overview synchronization status.
 */
export async function recordProjectParticipation(args, call) {
  if (args.scope !== undefined && args.scope !== 'private' || args.project_id !== undefined
    || !safeProjectKey(args.project_key) || !safeKey(args.contribution_id)
    || !Object.hasOwn(statuses, args.status)
    || typeof args.project_title !== 'string' || !args.project_title.trim() || args.project_title.length > 160
    || typeof args.stage !== 'string' || !args.stage.trim() || args.stage.length > 100
    || typeof args.content !== 'string' || !args.content.trim() || args.content.length > 5000
    || !Array.isArray(args.artifacts) || args.artifacts.length > 20
    || args.artifacts.some(value => typeof value !== 'string' || !value.trim() || value.length > 240
      || /:\/\/|^[A-Za-z]:[/\\]|^[/\\]|(?:^|[/\\])\.\.(?:[/\\]|$)|[?&#\r\n\x00-\x1f]/u.test(value))) {
    fail('Project participation requires stable keys, an explicit status, a summary and relative artifact references.');
  }
  const projectKey = 'muse-' + args.project_key;
  const pageId = `project-contributions/${projectKey}/${args.contribution_id}`;
  const overviewId = `projects/${projectKey}`;
  const privateCall = (name, value = {}) => call(name, {...value, scope: 'private'});
  async function pages(folder) {
    const items = [];
    let start = 0;
    do {
      const result = await privateCall('wiki_directory', {folder, start, limit: 50});
      items.push(...result.items);
      start = result.next_start;
    } while (start !== null);
    return items;
  }
  async function read(id) {
    let result = await privateCall('wiki_read', {id});
    let body = result.body;
    const first = result;
    while (result.next_start !== null) {
      result = await privateCall('wiki_read', {id, start: result.next_start, revision: first.revision});
      body += result.body;
    }
    return {...first, body};
  }
  const record = normalizedRecord(args);
  const stage = record.stage, title = record.project_title;
  const evidence = evidenceText(record);
  const source = (await privateCall('wiki_capture_source', {title: `${title} · ${stage}`.slice(0, 200),
    text: evidence, source: `participation/${args.project_key}/${args.contribution_id}`})).source;
  const citation = {id: source.id, start: 0, end: Math.min(6000, Array.from(evidence).length)};
  const body = recordText(record);
  async function write(page_id, pageTitle, text, marker, folder) {
    const existing = (await pages(folder)).find(item => item.id === 'private/wiki/' + page_id);
    if (existing) {
      const current = await read(existing.id);
      if (!current.body.startsWith(marker + '\n') || marker === contributionMarker && !parseProjectParticipationRecord(current.body)) {
        fail('Project participation page was edited outside the recorder; preserve it and resolve the conflict.');
      }
      if (current.body === text && current.title === pageTitle) return current;
    }
    const saved = await privateCall('wiki_write_page', {page_id, title: pageTitle, text,
      expected_revision: existing?.revision ?? 0, citations: [citation]});
    const actual = await read(saved.id);
    if (actual.sha256 !== createHash('sha256').update(text).digest('hex')) fail('Project participation readback differs from the requested record.');
    return actual;
  }
  const contribution = await write(pageId, `${stage} · ${statuses[args.status]}`, body, contributionMarker,
    `project-contributions/${projectKey}`);
  const details = await pages(`project-contributions/${projectKey}`);
  const overviewText = `${projectMarker}\n# ${title}\n\n项目标识：${args.project_key}\n\nMuse 参与记录：${details.length} 项。状态为阶段汇报，不代表整部项目已完成。\n\n`
    + details.slice(0, 50).map(item => `- [[${item.id.slice('private/wiki/'.length)}]] — ${item.title}`).join('\n')
    + `\n\n完整参与内容可分页浏览目录：project-contributions/${projectKey}。\n`;
  const output = {recorded_status: args.status, completion_basis: 'agent-report', source,
    contribution: {id: contribution.id, revision: contribution.revision}, contributions: details.length};
  try {
    const project = await write(overviewId, title, overviewText, projectMarker, 'projects');
    return {...output, status: 'synced', project: {id: project.id, revision: project.revision}, verified_readback: true};
  } catch (error) {
    if (!error.wikiError) throw error;
    return {...output, status: 'partial', project: {id: 'private/wiki/' + overviewId, sync: 'retry-required'},
      next: 'The contribution is saved; retry this same record to refresh the project overview. Do not claim the overview is synchronized.'};
  }
}
