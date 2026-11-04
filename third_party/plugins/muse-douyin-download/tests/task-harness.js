/** Artifact-plane harness: build workspace peers before running these Node tests. */
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../../../vendor/cordis/lib/index.js';
import LocalJobs from '../../../../packages/jobs/jobs-local/lib/index.js';
import * as ToolJobs from '../../../../packages/jobs/tool-jobs/lib/index.js';
import LocalFileSystem from '../../../../packages/fs/fs-local/lib/index.js';
import SandboxPolicy from '../../../../packages/sandbox/sandbox-policy/lib/index.js';
import { SessionId } from '../../../../packages/core/session/lib/index.js';
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '../../../../packages/test-support/agent-loop-testkit/lib/index.js';
import { resolveConfig } from '../src/runner.js';
import { DouyinTasks } from '../src/tasks.js';
import { mediaReceipt } from './task-fixtures.js';

export async function taskHarness(t, options = {}) {
  const directory = options.directory ?? await realpath(await mkdtemp(join(tmpdir(), 'muse-douyin-tasks-')));
  const workspace = join(directory, 'workspace'), settingsHome = join(directory, 'home');
  const ctx = new Context(), handles = [], executors = [], releases = new Set(), calls = [];
  const close = async () => {
    const failures = [];
    const finish = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await Promise.all([...releases].map(release => finish(release)));
    await Promise.all(executors.map(executor => finish(() => executor.dispose())));
    await Promise.all(handles.map(handle => finish(() => handle.dispose())));
    await finish(() => ctx.fiber.dispose());
    if (options.keepDirectory !== true) await finish(() => rm(directory, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, 'Task fixture teardown failed');
  };
  t?.after(close);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(settingsHome, { recursive: true, mode: 0o700 });
  await mountAgentLoopTestDependencies(ctx);
  await ctx.plugin(LocalFileSystem, { cwd: workspace });
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: workspace });
  await ctx.plugin(LocalJobs);
  const controller = await ctx.plugin(ToolJobs, { completionDelivery: 'quiet' });
  await mountAgentLoopTestHarness(ctx);
  let agentOrdinal = 0, callOrdinal = 0;
  const makeAgent = async (id = 'task-owner-' + ++agentOrdinal, cwd = workspace) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } });
    handles.push(handle);
    return { agent: handle.agent, dispose: () => handle.dispose() };
  };
  const owner = await makeAgent(options.ownerId);
  const settings = resolveConfig({ pythonExecutable: process.execPath, ffprobeExecutable: process.execPath, ffmpegExecutable: process.execPath, settingsHome, ...options.settings });
  const acquireVideo = async (agent, url, publicOnly, signal, transport) => {
    calls.push({ agent, url, publicOnly, signal, ...transport });
    signal.throwIfAborted();
    return options.acquireVideo ? options.acquireVideo(agent, url, publicOnly, signal, transport) : mediaReceipt(agent, url);
  };
  const makeTasks = async (extra = {}) => {
    const tasks = new DouyinTasks(ctx, settings, { acquireVideo, ...extra });
    executors.push(tasks);
    await tasks.ready();
    return tasks;
  };
  const tasks = await makeTasks();
  const download = (args, { callId = 'task-call-' + ++callOrdinal, agent = owner.agent, signal = new AbortController().signal } = {}) => tasks.download(args, agent, { callId, signal });
  const control = (args, agent = owner.agent, signal = new AbortController().signal) => tasks.control(args, agent, signal);
  const jobTool = (name, args, agent = owner.agent) => ctx.tools.execute({ name, arguments: args, callId: 'job-tool-' + ++callOrdinal, signal: new AbortController().signal, agent });
  const settle = async accepted => ctx.jobs.wait(accepted.downloadTask.jobId, 30000, owner.agent.id);
  const status = accepted => control({ action: 'status', taskId: accepted.downloadTask.id });
  return { directory, workspace, settingsHome, settings, ctx, controller, owner, calls, releases, tasks, makeTasks, makeAgent, download, control, jobTool, settle, status, close };
}
