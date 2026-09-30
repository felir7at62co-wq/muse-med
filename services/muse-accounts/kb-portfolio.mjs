// Authorized project summaries over canonical, account-private participation records.
import {validId} from './store.mjs';
import {parseProjectParticipationRecord} from './kb-participation.mjs';

const overviewMarker = '<!-- muse-project-overview-v1 -->';
const projectKeyPattern = '[A-Za-z0-9][A-Za-z0-9_-]{0,74}';
const contributionPath = new RegExp('^private/wiki/project-contributions/muse-(' + projectKeyPattern + ')/([A-Za-z0-9][A-Za-z0-9_-]{0,79})$');
const overviewPath = new RegExp('^private/wiki/projects/muse-(' + projectKeyPattern + ')$');
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,74}$/.test(value)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
const fail = message => { throw Object.assign(new Error(message), {wikiError: true}); };

/** Project recorder-owned work for its owner or an explicitly authorized portfolio reader.
 * @param {object} args Optional account/project selectors and bounded list pagination.
 * @param {object} options Authenticated identity, current account store, explicit readers and account-bound Wiki dispatcher.
 * @returns {Promise<object>} Paged project counts or reported contributions, without raw sources or unrelated Wiki text.
 */
export async function readProjectPortfolio(args, {account, mode, accounts, portfolioReaders, call}) {
  if (!['account', 'admin'].includes(mode)) fail('Account login is required for private and project Wiki.');
  if (args.account_id !== undefined && !validId(args.account_id)
    || args.project_key !== undefined && !safeKey(args.project_key)
    || args.start !== undefined && (!Number.isInteger(args.start) || args.start < 0 || args.start > 1_000_000)
    || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) {
    fail('Invalid portfolio selectors or pagination.');
  }
  if (typeof accounts?.get !== 'function') fail('Portfolio account catalog is not configured.');
  const actor = accounts.get(account.id);
  if (!actor || actor.disabled) fail('Document does not exist or is not authorized.');
  const privileged = portfolioReaders.has(actor.id);
  if (!privileged && args.account_id !== undefined && args.account_id !== actor.id) fail('Document does not exist or is not authorized.');
  let owners;
  if (args.account_id !== undefined) {
    const selected = accounts.get(args.account_id);
    if (!selected || selected.disabled) fail('Document does not exist or is not authorized.');
    owners = [selected];
  } else if (privileged) {
    if (typeof accounts.list !== 'function') fail('Portfolio account catalog is not configured.');
    owners = [...new Set(accounts.list().map(value => value.id))].map(id => accounts.get(id)).filter(value => value && !value.disabled);
  } else owners = [actor];

  async function directory(owner, folder) {
    const items = [];
    let start = 0;
    do {
      const result = await call('wiki_directory', {scope: 'private', folder, start, limit: 50}, owner);
      items.push(...result.items); start = result.next_start;
    } while (start !== null);
    return items;
  }
  async function read(owner, id) {
    const first = await call('wiki_read', {scope: 'private', id}, owner);
    let body = first.body, start = first.next_start;
    while (start !== null) {
      const next = await call('wiki_read', {scope: 'private', id, start, revision: first.revision}, owner);
      body += next.body; start = next.next_start;
    }
    return {...first, body};
  }

  const projects = [], contributions = [];
  let excluded = 0;
  for (const owner of owners) {
    const overviews = new Map(), grouped = new Map();
    for (const entry of await directory(owner, 'projects')) {
      const match = overviewPath.exec(entry.id);
      if (!match || args.project_key !== undefined && args.project_key !== match[1]) continue;
      const page = await read(owner, entry.id);
      if (page.body.startsWith(overviewMarker + '\n')) overviews.set(match[1], page);
    }
    for (const entry of await directory(owner, 'project-contributions')) {
      const match = contributionPath.exec(entry.id);
      if (!match || args.project_key !== undefined && args.project_key !== match[1]) continue;
      const page = await read(owner, entry.id), record = parseProjectParticipationRecord(page.body);
      if (!record || record.project_key !== match[1] || record.contribution_id !== match[2]) { excluded++; continue; }
      const identity = {id: owner.id, username: owner.username};
      const item = {...record, owner: identity, project_id: 'private/wiki/projects/muse-' + record.project_key,
        id: entry.id, revision: page.revision};
      contributions.push(item);
      if (!grouped.has(record.project_key)) grouped.set(record.project_key, []);
      grouped.get(record.project_key).push(item);
    }
    for (const [project_key, details] of grouped) {
      const overview = overviews.get(project_key);
      const counts = {planned: 0, in_progress: 0, completed: 0, blocked: 0, cancelled: 0};
      for (const item of details) counts[item.status]++;
      projects.push({owner: {id: owner.id, username: owner.username}, project_key,
        project_title: overview && details.some(item => item.project_title === overview.title) ? overview.title : details[0].project_title,
        project_id: 'private/wiki/projects/muse-' + project_key, overview_present: !!overview,
        contribution_count: details.length, status_counts: counts});
    }
  }
  const selected = args.project_key === undefined ? projects : contributions;
  selected.sort((left, right) => left.owner.id.localeCompare(right.owner.id)
    || left.project_key.localeCompare(right.project_key)
    || (left.contribution_id ?? '').localeCompare(right.contribution_id ?? ''));
  const start = args.start ?? 0, limit = args.limit ?? 30;
  return {access: privileged ? 'portfolio-admin' : 'own', view: args.project_key === undefined ? 'projects' : 'contributions',
    completion_basis: 'agent-report', items: selected.slice(start, start + limit), total: selected.length,
    next_start: start + limit < selected.length ? start + limit : null, excluded_records: excluded};
}
