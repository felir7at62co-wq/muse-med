/** Model-free Hongguo command consumer, launched only through a dsh profile. */
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, open, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HongguoDownloadClient } from './client.js';
import { HongguoTasks } from './tasks.js';
import { validTaskId, validRunId } from './task-store.js';
import { DownloadError, safeError } from './errors.js';

export const name = 'muse-hongguo-cli';
export const inject = ['cmdlineArgs', 'subprocess', 'sandboxPolicy'];
const commands = ['info', 'download', 'jobs', 'list', 'status', 'pause', 'resume', 'cancel', 'retry', 'remove'];
const controlCommands = new Set(['status', 'pause', 'resume', 'cancel', 'retry', 'remove']);
const fail = message => { throw new DownloadError('invalid_arguments', message); };
const help = `Usage: dsh --profile hongguo <command> [options]

Commands:
  info --series <id>                  inspect a catalog without downloading
  download --series <id>              download and wait; repeat --series for more titles
  jobs                               list tasks in this workspace
  status <task-id>                    inspect a task and its current run
  pause|cancel <task-id>              request a stop and report its acknowledgement
  resume|retry <task-id>              continue the recorded task and wait
  remove <task-id>                    remove a stopped task record; keep media files

Options:
  -s, --series <id>                   repeatable series ID
  -e, --episodes <1,2,3>              explicit positive episode numbers
  -q, --quality <1080p|720p|auto>      quality for this download
  -o, --output <directory>            default: workspace downloads directory
      --source-mode <legacy|public|manifest>
      --permission-mode <workspace-write|read-only|danger-full-access>
      --owner-session <session-id>    explicitly select an existing Session owner
      --run-id <run-id>               stop only this exact task run
      --request-id <request-id>       stable pause/cancel request identity
      --json                         results are always one JSON line on stdout
  -h, --help                         show help without creating a task

Run from the intended workspace. Progress goes to stderr. External output requires
an explicit danger-full-access permission. Ctrl+C stops foreground work and retains
verified progress. Pending stop requests are not reported as completed.
`;

/**
 * Parse app arguments without file or network effects.
 * @param {string[]} args Argument snapshot from the dsh launcher.
 * @returns {object} Help request or validated command arguments.
 */
export function parseCliArguments(args) {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
    series: { type: 'string', multiple: true, short: 's' }, episodes: { type: 'string', short: 'e' },
    quality: { type: 'string', short: 'q' }, output: { type: 'string', short: 'o' },
    'source-mode': { type: 'string' }, 'permission-mode': { type: 'string' },
    'owner-session': { type: 'string' }, 'run-id': { type: 'string' }, 'request-id': { type: 'string' },
  } });
  if (values.help) return { command: 'help' };
  const command = positionals[0];
  if (!commands.includes(command)) fail('Choose info, download, jobs, status, pause, resume, cancel, retry or remove; use --help');
  const control = controlCommands.has(command);
  if (positionals.length !== (control ? 2 : 1)) fail(control ? 'This command requires exactly one task ID' : 'Unexpected positional arguments');
  if (control && !validTaskId(positionals[1])) fail('Task ID must be an ID returned by the task library');
  const accepted = new Set(['json', 'permission-mode']);
  if (control || command === 'jobs' || command === 'list') accepted.add('owner-session');
  if (command === 'info' || command === 'download') { accepted.add('series'); accepted.add('source-mode'); }
  if (command === 'download') for (const key of ['episodes', 'quality', 'output']) accepted.add(key);
  if (command === 'pause' || command === 'cancel') for (const key of ['run-id', 'request-id']) accepted.add(key);
  if (Object.keys(values).some(key => !accepted.has(key))) fail('An option does not apply to this command');
  for (const key of ['owner-session', 'run-id', 'request-id', 'output']) {
    if (values[key] !== undefined && (!values[key].trim() || values[key].includes('\0'))) fail(`${key} must be nonempty and contain no NUL bytes`);
  }
  if (values['run-id'] !== undefined && !validRunId(values['run-id'])) fail('run-id must be an ID returned by task status');
  const permissionMode = values['permission-mode'] ?? 'workspace-write';
  if (permissionMode !== undefined && !['workspace-write', 'read-only', 'danger-full-access'].includes(permissionMode)) fail('Invalid permission mode');
  const sourceMode = values['source-mode'];
  if (sourceMode !== undefined && !['legacy', 'public', 'manifest'].includes(sourceMode)) fail('Invalid source mode');
  if (values.quality !== undefined && !['1080p', '720p', 'auto'].includes(values.quality)) fail('quality must be 1080p, 720p or auto');
  const seriesIds = values.series;
  if (command === 'info' || command === 'download') {
    if (!seriesIds?.length || new Set(seriesIds).size !== seriesIds.length
      || seriesIds.some(id => !id || id.includes('\0') || (sourceMode !== 'manifest' && !/^\d+$/.test(id)))) fail('Provide nonduplicate --series IDs; Hongguo IDs must be decimal strings');
  }
  let episodes;
  if (values.episodes !== undefined) {
    const parts = values.episodes.split(',');
    if (parts.some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) fail('episodes must be comma-separated positive integers');
    episodes = parts.map(Number);
    if (new Set(episodes).size !== episodes.length) fail('episodes must not repeat');
  }
  const download = { ...(seriesIds ? { seriesIds } : {}), ...(sourceMode ? { sourceMode } : {}),
    ...(episodes ? { episodes } : {}), ...(values.quality ? { quality: values.quality } : {}), ...(values.output ? { outputDir: values.output } : {}) };
  return { command: command === 'jobs' ? 'list' : command, download, taskId: control ? positionals[1] : undefined,
    permissionMode, selectedOwnerSessionId: values['owner-session'], expectedRunId: values['run-id'], requestId: values['request-id'] };
}

/**
 * Read or exclusively create a stable local operator identity.
 * @param {string} profileDirectory Dedicated CLI profile directory.
 * @returns {Promise<string>} Operator UUID; corrupt records fail without replacement.
 */
export async function readCliOperator(profileDirectory) {
  const path = join(profileDirectory, 'hongguo-cli-operator.json');
  const read = async () => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new DownloadError('invalid_cli_identity', 'CLI operator record is not a valid private file');
    let value;
    try { value = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { throw new DownloadError('invalid_cli_identity', 'CLI operator record is invalid; existing ownership was preserved'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)) throw new DownloadError('invalid_cli_identity', 'CLI operator record is invalid; existing ownership was preserved');
    return value.id;
  };
  try { return await read(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const id = randomUUID(), temporary = join(profileDirectory, `.hongguo-operator-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(JSON.stringify({ version: 1, id }) + '\n'); } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) { if (error.code === 'EEXIST') return read(); throw error; }
    return id;
  } finally { await rm(temporary); }
}

/**
 * Dispatch a command through the same library as Muse tools.
 * @param {object} request Validated command arguments.
 * @param {object} client Catalog and media download client.
 * @param {object} tasks Task lifecycle owner shared with chat tools.
 * @param {object} caller Canonical workspace, operator identity and file policy.
 * @param {AbortSignal} signal Owned operation cancellation.
 * @param {Function} onProgress Optional stderr progress sink.
 * @returns {Promise<object>} Safe library result; pending control remains pending.
 */
export async function executeCliCommand(request, client, tasks, caller, signal, onProgress) {
  if (request.command === 'info') return client.info(request.download, signal);
  if (request.command === 'download') return tasks.download(request.download, caller, { signal, onProgress });
  const args = { action: request.command, ...(request.taskId ? { taskId: request.taskId } : {}) };
  if (request.command === 'pause' || request.command === 'cancel') {
    let expectedRunId = request.expectedRunId;
    if (expectedRunId === undefined) {
      const status = await tasks.control({ action: 'status', taskId: request.taskId }, caller, signal);
      if (status.ok === false) return status;
      expectedRunId = status.task?.runId;
      if (typeof expectedRunId !== 'string' || !expectedRunId) return { ok: false, code: 'run_unavailable', message: 'Task has no confirmed run to stop; inspect its status' };
    }
    args.expectedRunId = expectedRunId;
    args.requestId = request.requestId ?? randomUUID();
  }
  return tasks.control(args, caller, signal);
}

/**
 * Bind CLI work to successful dsh startup and joined disposal.
 * @param {object} ctx Launcher context carrying subprocess and policy services.
 * @param {object} config Validated downloader and task configuration.
 */
export function apply(ctx, config = {}) {
  const exit = ctx.get('appExit'), ready = ctx.get('appReady'), profile = ctx.get('profileContext');
  if (!exit || !ready || !profile?.dir) throw new Error('Hongguo CLI requires a dsh profile launcher');
  let request;
  try { request = parseCliArguments(ctx.get('cmdlineArgs').get()); }
  catch (error) {
    process.stderr.write(`hongguo: ${error.code === 'invalid_arguments' ? error.message : 'Invalid arguments; use --help'}\n`);
    exit(2); return;
  }
  if (request.command === 'help') { process.stdout.write(help); exit(0); return; }
  const lifetime = new AbortController();
  const client = new HongguoDownloadClient(config, { subprocess: ctx.subprocess });
  const tasks = new HongguoTasks(config, { client });
  let work, disposed = false;
  const cancelReady = ready.onReady(() => {
    work = (async () => {
      const cwd = await realpath(process.cwd());
      const operatorId = await readCliOperator(profile.dir);
      lifetime.signal.throwIfAborted();
      const policy = ctx.sandboxPolicy.resolve({ mode: request.permissionMode });
      const caller = { kind: 'cli', operatorId, cwd, policy,
        ...(request.selectedOwnerSessionId ? { selectedOwnerSessionId: request.selectedOwnerSessionId } : {}) };
      return executeCliCommand(request, client, tasks, caller, lifetime.signal,
        progress => { process.stderr.write(`${JSON.stringify(progress)}\n`); });
    })().catch(error => ({ ok: false, complete: false, ...safeError(error) }));
    void work.then(result => {
      if (disposed) return;
      process.stdout.write(`${JSON.stringify(result)}\n`);
      exit(result.ok === false || result.control?.state === 'rejected' ? 1 : result.control?.state === 'pending' ? 3 : 0);
    });
  });
  ctx.effect(() => async () => {
    disposed = true;
    cancelReady(); lifetime.abort();
    if (work) await work;
    const releases = await Promise.allSettled([tasks.dispose(), client.dispose()]);
    const errors = releases.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Hongguo CLI cleanup failed');
  });
}
