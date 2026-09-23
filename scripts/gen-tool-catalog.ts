/**
 * Generate `docs/tool-catalog.md` from schemas collected by booting each tool
 * plugin. Runtime registration is the source of truth for computed schemas;
 * the manifest is checked against every on-disk `tool-*` package. `--check`
 * verifies the committed artifact. The original decision is recorded in
 * `.agents/notes/archived/process/2026-07-02-tool-schema-catalog.md`.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import GoalService from '@deepseek-ai/dsh-goal'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebSearchExa from '@deepseek-ai/dsh-web-search-exa'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-http'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as ToolSubagentListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as ToolBashPersistent from '@deepseek-ai/dsh-tool-bash-persistent'
import * as ToolPwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'
import CordisHostRunner from '@deepseek-ai/dsh-cordis-host-runner'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolPresent from '@deepseek-ai/dsh-tool-present'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as ToolPty from '@deepseek-ai/dsh-tool-terminal'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as ToolSchedule from '@deepseek-ai/dsh-schedule'
import Lsp from '@deepseek-ai/dsh-lsp'
import * as ToolLsp from '@deepseek-ai/dsh-tool-lsp'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import * as StagehandBrowserTools from '@deepseek-ai/dsh-experimental-browser-use-stagehand-native'
import type TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import * as ToolTeam from '@deepseek-ai/dsh-experimental-tool-agent-team'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolJubian from '@deepseek-ai/dsh-tool-jubian'
import * as ToolShotScript from '@deepseek-ai/dsh-tool-shot-script'
import * as ToolBgmCompose from '@deepseek-ai/dsh-tool-bgm-compose'
import * as PerceptionBgm from '@deepseek-ai/dsh-perception-bgm'
import * as ToolEpisodeRender from '@deepseek-ai/dsh-tool-episode-render'
import * as ToolDramaAssets from '@deepseek-ai/dsh-tool-drama-assets'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { registerListSubagentModels } from '../packages/subagent/tool-subagent/src/list-models.ts'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import WorkflowEngine from '@deepseek-ai/dsh-workflow'
import type { WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import { githubSlug } from './verify-md-links.ts'

/** Attachment seam marker that makes the attachments-conditional `read_image` schema harvestable. */
class CatalogAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = Object.freeze({
    maxImageBytes: 1,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1,
    maxImagePixels: 1,
    maxImageDimension: 1,
    mediaTypes: Object.freeze(['image/png'] as const),
  })

  override validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('gen-tool-catalog: attachment validation is unreachable during schema harvest'))
  }

  override saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('gen-tool-catalog: attachment writes are unreachable during schema harvest'))
  }

  override readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('gen-tool-catalog: attachment reads are unreachable during schema harvest'))
  }
}

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/tool-catalog.md'

/** Workflow tools expose their schemas without executing a program. */
class CatalogWorkflowEngine extends WorkflowEngine {
  start(_request: WorkflowStartRequest): WorkflowRun {
    throw new Error('gen-tool-catalog: workflow execution is unavailable during schema harvest')
  }
}

/**
 * Register the descriptor needed to mount schema-producing consumers. Declares
 * the full capability set of the shipped in-process providers so consumers
 * mount under their shipped defaults (tool-subagent's default numeric maxDepth
 * requires `depthLimit`).
 */
function registerCatalogSubagentProvider(ctx: Context, name: string): void {
  const provider: SubagentProvider = {
    name,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('tool-catalog provider cannot start a child')),
    // Declared so consumers configured for continuable background mode mount.
    prepareContinuable: () => Promise.reject(new Error('tool-catalog provider cannot prepare a child')),
  }
  ctx.subagents.registerProvider(provider)
}

/** Minted child-scope keys for packages whose tools are never global. */
const catalogChildScopes = new WeakMap<Context, Agent>()

/**
 * Install one scope-local tool package into an agent-like child scope for
 * schema harvest, without starting a model, Agent loop, or persistence backend.
 * @param ctx - catalog context owning the scope.
 * @param mountScoped - package installer for the scoped context.
 * @param key - agent-like scope key exposed to the package's scope selector.
 * @param inject - services the package installer must await before mounting.
 */
async function mountCatalogChildScope(
  ctx: Context,
  mountScoped: (childCtx: Context) => void,
  key: Agent = { id: SessionId('tool-catalog-child') } as Agent,
  inject: string[] = ['tools', 'systemPrompt', 'subagents'],
): Promise<void> {
  await ctx.plugin(Object.assign((inner: Context) => {
    mountScoped(createScope(inner, key).ctx)
  }, { inject }))
  catalogChildScopes.set(ctx, key)
}

/**
 * Tool package plus its hand-maintained boot recipe. The caller mounts the
 * prompt and registry; each recipe supplies only package-specific seams and
 * config, while `dir` participates in the completeness check.
 */
export interface ToolPackage {
  /** The npm package name, used as the catalog section heading. */
  pkg: string
  /** The `packages/<group>/<dir>` leaf name — matched by the completeness guard. */
  dir: string
  /**
   * Repo-relative implementation source linked per harvested tool. Packages
   * whose tools share one plugin may use a string; split plugins map each tool
   * name to its own source.
   */
  source: string | Readonly<Record<string, string>>
  /** Services or owning runtimes the package requires at execution time. */
  requires: string[]
  /** Session events or other visible state the tools write or affect. */
  writes: string[]
  /** Additional model-visible names shipped by example/app config. */
  shippedNames?: string[]
  /** Plug the injected seams + the tool plugin onto a context that already
   * carries `systemPrompt` + `tools`. */
  mount: (ctx: Context) => Promise<void>
  /** Agent-like scope key whose tool view is catalogued instead of the global view. */
  scope?: (ctx: Context) => Agent
  /**
   * Config for the caller's `ToolRuntime` mount. The registry itself ships a
   * model-facing tool (`run_code`, registered under a non-native `mode`), so
   * ITS catalog entry boots the registry in the mode that exposes it;
   * every other entry uses the default (native) registry.
   */
  toolsConfig?: ToolsConfig
  /**
   * A deployment note rendered after the package's tools, for a fact that
   * booting the package alone cannot show. The registered tool NAME can be a
   * load-time config (`tool-subagent`'s `toolName`), so one package may appear
   * under several names across deployments — the boot yields the package
   * DEFAULT, and this note records the shipped alternatives the model sees.
   */
  note?: string
}

/**
 * The boot manifest: every shipped tool package (a `tool-*` leaf under
 * `packages/`). Ordered by package name (the render order); the completeness
 * guard proves it is exhaustive against the on-disk glob.
 */
const TOOL_PACKAGES: ToolPackage[] = [
  {
    pkg: '@deepseek-ai/dsh-mcp-resources',
    dir: 'mcp-resources',
    source: 'packages/mcp/mcp-resources/src/tools.ts',
    requires: ['ctx.tools', 'ctx.mcpResources'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(McpResources)
      ctx.mcpResources.register('catalog', {
        request: () => Promise.reject(new Error('gen-tool-catalog: MCP requests are unreachable during schema harvest')),
      })
    },
  },
  {
    pkg: '@deepseek-ai/dsh-experimental-browser-use-stagehand-native',
    dir: 'browser-use-stagehand-native',
    source: 'packages/experimental/browser-use-stagehand-native/src/index.ts',
    requires: ['ctx.browserUse', 'ctx.agents', 'ctx.tools', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(BrowserUseRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StagehandBrowserTools, {
        mode: 'launch', model: { modelName: 'openai/gpt-5.4-mini', apiKey: 'catalog-placeholder' },
      })
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-ask-user',
    dir: 'tool-ask-user',
    source: 'packages/interaction/tool-ask-user/src/index.ts',
    requires: ['ctx.tools', 'ctx.userQuestions'],
    writes: ['tool/call', 'tool/result after a UI/provider answers the question'],
    async mount(ctx) {
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(ToolAskUser)
    },
    note:
      'ask_user_question pauses the tool call until the active UI provider returns a human answer.',
  },
  {
    pkg: '@deepseek-ai/dsh-tools',
    dir: 'tools',
    source: 'packages/core/tools/src/ptc.ts',
    requires: ['ctx.tools', 'ctx.ptcRuntime (execution time)', 'ctx.systemPrompt'],
    writes: ['tool/call', 'one tool/ptc-dispatch-start + tool/ptc-dispatch pair per bridged sub-call', 'tool/result'],
    // The registry's OWN tool: run_code exists only under a non-native mode
    // (the registry registers it in its constructor; the PTC runtime is read
    // at assembly/execution time, so the schema harvest needs none mounted).
    toolsConfig: { mode: 'ptc' },
    async mount() {},
    note:
      'Owned by the tool registry as a reserved transport outside filterable capability layers under `mode: ptc` / `mode: both` (see the PTC mode Agent Note). Under `ptc` it is the registry\'s only wire contribution; the other visible capabilities are declared in a generated SDK section in the loaded runtime\'s language, and a program calls them through bindings scheduled under the native concurrency contract (submission-ordered starts and policy; concurrency-safe bodies overlap up to `maxParallelSubCalls`) that re-enter the complete guarded tool pipeline and link each nested execution to this outer result.',
  },
  {
    pkg: '@deepseek-ai/dsh-plan-mode',
    dir: 'plan-mode',
    source: 'packages/plan/plan-mode/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.userQuestions (execution time, opportunistic)'],
    writes: ['tool/call', 'plan/mode inactive on an approved review', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(PlanModeController, { section: 'Tool catalog schema harvest.' })
    },
    note:
      'exit_plan_mode stays in the model-facing schema while planning is inactive so transitions add no tool-catalog churn on top of the plan-policy change. Its execute path rejects calls outside plan mode; in plan mode it presents the plan over the user-questions seam (approve / keep planning with feedback), and approval logs plan mode inactive at the step boundary.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-bash',
    dir: 'tool-bash',
    source: 'packages/shell/tool-bash/src/index.ts',
    requires: ['ctx.tools', 'ctx.shell', 'ctx.systemPrompt', 'ctx.shellEnv', 'ctx.jobs at call time for run_in_background'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(BashEnvPlugin)
      await ctx.plugin(LocalBashExecutor)
      await ctx.plugin(ToolBash)
    },
    note:
      'The bash tool is the model-facing consumer of the bash executor seam. A `run_in_background` run registers with the generic `ctx.jobs` runtime and is collected/stopped through the `job_*` tools from `@deepseek-ai/dsh-tool-jobs`; the `enableRunInBackground` config (default true) removes the parameter entirely when disabled.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-present',
    dir: 'tool-present',
    source: 'packages/fs/tool-present/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs', 'ctx.sessionProjections'],
    writes: ['tool/call', 'deliverables/presented after a successful final result', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(ToolPresent)
    },
    note: 'Deliveries belong to the calling Session; Web ui-deliverables supplies source-file opening and cards.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-pwsh',
    dir: 'tool-pwsh',
    source: 'packages/shell/tool-pwsh/src/index.ts',
    requires: ['ctx.tools', 'ctx.shell', 'ctx.systemPrompt', 'ctx.shellEnv', 'ctx.jobs at call time for run_in_background'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The pwsh tool consumes the bash executor seam; the schema harvest
      // mounts the pwsh-local implementation so the inject resolves without
      // executing anything (registration never spawns a process).
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(BashEnvPlugin)
      await ctx.plugin(PwshLocalExecutor)
      await ctx.plugin(ToolPwsh)
    },
    note:
      'The pwsh tool is the PowerShell-dialect consumer of the bash executor seam for Windows compositions (a PowerShell executor such as `@deepseek-ai/dsh-pwsh-local` backs `ctx.shell`); it mirrors the bash tool call-for-call minus sandbox controls — `run_in_background` runs register with the generic `ctx.jobs` runtime and are collected/stopped through the `job_*` tools, and the managed `DSH_*` environment comes from `@deepseek-ai/dsh-shell-env`. Each call runs in a fresh process (no persistent PTY session), with native `C:\\...` paths and `$env:NAME` variables.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-cordis',
    dir: 'tool-cordis',
    source: 'packages/extensions/tool-cordis/src/index.ts',
    requires: ['ctx.tools', 'ctx.dynamicCordisRunner'],
    writes: ['tool/call', 'tool/result', 'process-local dynamic package lifecycle'],
    async mount(ctx) {
      await ctx.plugin(CordisHostRunner)
      await ctx.plugin(ToolCordis)
    },
    note:
      'Not in any shipped tree (a deliberate opt-in — dynamic package code reaches the real runtime, see .agents/notes/implemented/feature/2026-07-08-self-referential-cordis-toolset.md). The toolset injects `ctx.dynamicCordisRunner` from `@deepseek-ai/dsh-cordis-host-runner`, which owns the definition registry and the vm sandbox; a composition missing it never activates the tools. A running package may register ADDITIONAL model-visible tools until it is stopped, undefined, or DSH restarts; a full changed request header logs those tool-set changes.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-bash-persistent',
    dir: 'tool-bash-persistent',
    source: 'packages/shell/tool-bash-persistent/src/index.ts',
    requires: ['ctx.tools', 'ctx.terminals', 'an owning Agent at execution time'],
    writes: ['tool/call', 'PTY shell state', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(ToolBashPersistent)
    },
    note:
      'One owner-isolated persistent bash tool; deployment composition supplies the PTY backend and may override the model-facing environment description.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-pwsh-persistent',
    dir: 'tool-pwsh-persistent',
    source: 'packages/shell/tool-pwsh-persistent/src/index.ts',
    requires: ['ctx.tools', 'ctx.terminals', 'an owning Agent at execution time'],
    writes: ['tool/call', 'PTY shell state', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(ToolPwshPersistent)
    },
    note:
      'One owner-isolated persistent pwsh tool, the Windows counterpart of the persistent bash tool; deployment composition supplies a pwsh-dialect PTY backend and may override the model-facing environment description.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-str-replace-editor',
    dir: 'tool-str-replace-editor',
    source: 'packages/fs/tool-str-replace-editor/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs'],
    writes: ['tool/call', 'fs/observed after view presence/absence, edit absence, or successful mutation', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(ToolStrReplaceEditor)
    },
    note:
      'Standalone view/create/unique literal replace/line insert tool over the filesystem seam; it composes with any shell or terminal API.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-fs',
    dir: 'tool-fs',
    source: 'packages/fs/tool-fs/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs', 'ctx.systemPrompt', 'ctx.attachments (image-tool registration)', 'ctx.llm + an image-capable route (image-tool execution)'],
    writes: ['tool/call', 'fs/write-intent or fs/edit-intent for mutations', 'fs/observed after read presence/absence or successful file operation', 'durable attachment (read_image)', 'tool/result'],
    async mount(ctx) {
      // The tool needs `fs`; the bare provider is sufficient because policy
      // changes behavior, not schema shape. The catalog seam marker opts into
      // the attachments-conditional image schema without attachment I/O.
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(CatalogAttachmentStore)
      await ctx.plugin(ToolFs)
    },
    note:
      'The read-before-write/edit policy is added by `@deepseek-ai/dsh-fs-observation-policy` (an `fs/*` event-gate plugin, no schema change); a deployment that loads these tools is expected to also load it. The image tool is not registered without `ctx.attachments`; its schema is route-independent, and execution refuses unless the exact routed model declares image input.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-fs-search',
    dir: 'tool-fs-search',
    source: 'packages/fs/tool-fs-search/src/index.ts',
    requires: ['ctx.tools', 'ctx.subprocess', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tools inject `subprocess` (search spawns the packaged ripgrep
      // binary through the seam, not ctx.fs); registration itself never
      // spawns, so the real local service is inert here. `ctx.spillStore` is
      // optional (read via ctx.get) and does not affect the schemas, so no
      // spill backend is mounted.
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
    },
    note:
      'glob and grep are unconditional discovery tools that spawn the packaged ripgrep binary (`@vscode/ripgrep`) through ctx.subprocess as ordinary foreground calls (never background jobs) — no host `rg` install and no shell layer. The catalog uses `sampleOverCapGlobResults: true`; deployments must choose that behavior explicitly. Capped results save the complete formatted list through the optional ctx.spillStore backend; returned locators are follow-up-readable/searchable when the backend exposes local paths in co-located deployments.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-terminal',
    dir: 'tool-terminal',
    source: 'packages/terminal/tool-terminal/src/index.ts',
    requires: ['ctx.tools', 'ctx.terminals', 'ctx.systemPrompt', 'ctx.jobs at call time for run_in_background'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(ToolPty)
    },
    note:
      'The six terminal tools are opt-in and complement one-shot shell/filesystem tools. `terminal_send(run_in_background: true)` registers with `ctx.jobs`; TUI, named key sequences, BEL, resize, auto-start, and cross-agent sharing are absent from the schema.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-goal',
    dir: 'tool-goal',
    source: 'packages/goal/tool-goal/src/index.ts',
    requires: ['ctx.tools', 'ctx.agents', 'ctx.goals', 'ctx.systemPrompt', 'a calling Agent in an authorized open turn'],
    writes: ['tool/call', 'goal/change for mutations', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(GoalService)
      await ctx.plugin(ToolGoal)
    },
    note:
      'create, edit, pause, and resume require direct-human root authority; complete and blocked also accept the exact current goal round. The default blocked lower bound is three admitted rounds.',
  },
  {
    pkg: '@deepseek-ai/dsh-schedule',
    dir: 'schedule',
    source: 'packages/schedule/schedule/src/tools.ts',
    requires: ['ctx.tools', 'ctx.sessions', 'Session persistence', 'a future live root Agent'],
    writes: ['tool/call', 'schedule/change create or delete', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create(SessionId('tool-catalog-schedule'))
      const agent = { id: session.id, session } as Agent
      await mountCatalogChildScope(ctx, (childCtx) => {
        ToolSchedule.registerScheduleTools(ctx, childCtx, agent, () => {})
      }, agent, ['tools', 'systemPrompt'])
    },
    scope: ctx => catalogChildScopes.get(ctx) as Agent,
    note:
      'Registered only inside live root Agent scopes created after the opt-in Schedule plugin loads. '
      + 'Version 1 accepts after_seconds, explicit absolute at, and bounded fixed-rate every_seconds, '
      + 'and discloses session-local delivery; '
      + 'management reads and mutations require the shared Session persistence barrier.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-lsp',
    dir: 'tool-lsp',
    source: 'packages/lsp/tool-lsp/src/index.ts',
    requires: ['ctx.tools', 'ctx.lsp', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tool registers from the seam alone; the schema does not depend on any provider.
      await ctx.plugin(Lsp)
      await ctx.plugin(ToolLsp)
    },
    note:
      'The lsp tool keeps provider selection and language-server subprocesses behind ctx.lsp, so its model-visible schema stays stable across providers. Requires a registered provider (e.g. `@deepseek-ai/dsh-lsp-stdio`) at runtime; without one, a query returns the structured `LSP_UNAVAILABLE` error rather than changing the schema.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-ralph',
    dir: 'tool-ralph',
    source: 'packages/workflow/tool-ralph/src/index.ts',
    requires: ['ctx.tools', 'ctx.workflowEngine', 'ctx.subagents', 'ctx.systemPrompt', 'a calling Agent (exec.agent parents every fresh round)'],
    writes: ['tool/call', 'tool/result', 'workflow and child session events during execution'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(CatalogWorkflowEngine)
      await ctx.plugin(ToolRalph, { subagentProvider: 'mock' })
    },
    note:
      'A fixed foreground workflow starts one fresh structured child per round; the model selects only the immutable objective and an optional round cap.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-skill',
    dir: 'tool-skill',
    source: 'packages/skill/tool-skill/src/index.ts',
    requires: ['ctx.tools', 'ctx.agents', 'ctx.skills'],
    writes: ['tool/call', 'tool/result', 'user/message replacement catalogs via agent.inject()'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillFileSystem, {
        dshHome: resolve(root, '.tmp/tool-catalog/.dsh'),
        agentsHome: resolve(root, '.tmp/tool-catalog/.agents'),
      })
      await ctx.plugin(ToolSkill)
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-session-query',
    dir: 'tool-session-query',
    source: 'packages/session-query/tool-session-query/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.sessionQuery', 'a calling Agent for workspace authority'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
      await ctx.plugin(ToolSessionQuery)
    },
    note:
      'The five read-only tools hide provider cursors and authorize every result from the immutable calling agent session. The package is opt-in; compositions that need enforced deadlines or bounded inline output also mount the generic timeout or spill policies.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-subagent',
    dir: 'tool-subagent',
    source: {
      list_subagent_models: 'packages/subagent/tool-subagent/src/list-models.ts',
      subagent: 'packages/subagent/tool-subagent/src/index.ts',
    },
    requires: ['ctx.tools', 'ctx.subagents', 'ctx.systemPrompt', 'ctx.llm for model discovery and selected-route validation'],
    writes: ['tool/call', 'tool/result', 'child session events through the chosen provider'],
    shippedNames: ['subagent', 'subagent_fork'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LlmRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(ToolSubagent, { provider: 'mock' })
      registerListSubagentModels(ctx, { routes: [{ provider: 'mock', model: 'mock' }] })
    },
    note:
      'The registered delegation name is the load-time `toolName` config (default `subagent`); the default schema above has model selection off, while the discovery schema is shown as the fixed companion available in an enabled Session. Web presets sample the Plugins preference for each new top-level Session and preserve that decision for its child Sessions; `subagent_fork` remains fixed-route. Each instance independently controls whether it reads model-selection settings and its background behavior through `modelSelectionSettings`, `backgroundMode`, and `enableRunInBackground`.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-subagent-control',
    dir: 'tool-subagent-control',
    source: {
      interrupt_agent: 'packages/subagent/tool-subagent-control/src/index.ts',
      list_agents: 'packages/subagent/tool-subagent-control/src/list-agents.ts',
      send_message: 'packages/subagent/tool-subagent-control/src/index.ts',
    },
    requires: ['ctx.tools', 'ctx.subagents', 'ctx.agents and ctx.sessionProjections (list_agents only)'],
    writes: ['tool/call', 'tool/result', 'child session events through ctx.subagents'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionStore)
      await ctx.plugin(ToolSubagentControl)
      await ctx.plugin(ToolSubagentListAgents)
    },
    note:
      'The globally named control tools over continuable background subagents: provider-bound `tool-subagent` instances register distinct delegation tools, while this package registers `send_message` and `interrupt_agent` once, plus `list_agents` from its separately loaded `/list-agents` plugin (whose catalog rows use the sessionProjections and live Agent registries).',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-jobs',
    dir: 'tool-jobs',
    source: 'packages/jobs/tool-jobs/src/index.ts',
    requires: ['ctx.tools', 'ctx.jobs', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result', 'user/message via agent.inject() for background completion notices'],
    async mount(ctx) {
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolJobs)
    },
    note:
      'The kind-agnostic background-job controller: background bash commands, PTY sends, and subagents are read, listed, and killed through the same three tools. Loading the plugin attaches the controller that arms producers\' `ctx.jobs.start()`.',
  },
  {
    pkg: '@deepseek-ai/dsh-experimental-tool-agent-team',
    dir: 'tool-agent-team',
    source: 'packages/experimental/tool-agent-team/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.agentTeams', 'an exact live Team member Agent'],
    writes: ['tool/call', 'team/member', 'team/message/queued', 'team/message/delivered', 'team/task', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create(SessionId('tool-catalog-team-lead'))
      let agent!: Agent
      const membership = {
        get root() { return agent },
        id: session.id,
        role: 'lead' as const,
        name: 'lead',
      }
      ctx.provide('agentTeams', {
        tryMembership: (candidate: Agent) => candidate === agent ? membership : undefined,
        membership: () => membership,
      } as unknown as TeamService)
      await ctx.plugin(Object.assign(async (inner: Context) => {
        agent = {
          id: session.id,
          session,
          options: {},
          status: 'idle',
        } as unknown as Agent
        Object.assign(agent, { ctx: createScope(inner, agent).ctx })
        await inner.agents.register(agent)
      }, { inject: ['tools', 'systemPrompt', 'agents', 'agentTeams'] }))
      await ctx.plugin(ToolTeam)
      catalogChildScopes.set(ctx, agent)
    },
    scope: ctx => catalogChildScopes.get(ctx) as Agent,
    note:
      'All nine tools are scoped to implicit Team Leads and durable teammates. The shipped dsh-base bundle keeps the package disabled; the documented Agent Teams profile patch enables it while disabling the legacy continuable-child control names.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-todo',
    dir: 'tool-todo',
    source: 'packages/todo/tool-todo/src/index.ts',
    requires: ['ctx.tools', 'owning Agent session'],
    writes: ['tool/call', 'todo/write', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    },
    note:
      'todo_write is session-owned state; UIs render the latest todo/write event as a checklist. `allowParallelInProgress` is required with no default, so the catalog states its choice: `true`, whose description invites several `in_progress` items. A deployment choosing `false` receives the same tool with a description asking for exactly one active task.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-workflow',
    dir: 'tool-workflow',
    source: 'packages/workflow/tool-workflow/src/index.ts',
    requires: ['ctx.tools', 'ctx.workflowEngine', 'ctx.systemPrompt', 'a calling Agent (exec.agent parents the script children)'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(CatalogWorkflowEngine)
      await ctx.plugin(ToolWorkflow)
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-web',
    dir: 'tool-web',
    source: 'packages/web/tool-web/src/index.ts',
    requires: ['ctx.tools', 'ctx.web', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Mount search and fetch providers so both tools register. Their schemas
      // do not depend on provider identity or availability.
      await ctx.plugin(WebRuntime)
      await ctx.plugin(WebSearchExa)
      await ctx.plugin(WebFetchLocal)
      await ctx.plugin(ToolWeb)
    },
    note:
      'web_search and web_fetch keep provider selection behind ctx.web so model-visible schemas stay stable across backend swaps.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-jubian',
    dir: 'tool-jubian',
    source: 'packages/jubian/tool-jubian/src/index.ts',
    requires: ['ctx.tools', 'ctx.credentials'],
    writes: ['tool/call', 'tool/result', 'Jubian two-phase write ledger (NDJSON record pairs under its configured root)'],
    async mount(ctx) {
      // The row injects `credentials`: it resolves JUBIANAI_ADMIN_TOKEN on every
      // call, so the harvest needs a provider that satisfies the injection
      // without reading the operator's real store.
      await ctx.plugin(LocalCredentialProvider, {
        path: join(tmpdir(), 'dsh-tool-catalog', 'credentials.yaml'),
        dshHome: join(tmpdir(), 'dsh-tool-catalog'),
        watch: false,
      })
      await ctx.plugin(ToolJubian, { ledgerRoot: join(tmpdir(), 'dsh-tool-catalog', 'jubian-ledger') })
    },
    note:
      'Every paid write (image_generate, generate, erase_subtitle, upscale) requires a caller-supplied idempotency_key and records its intent in the ledger before the request leaves; '
      + 'erase_subtitle and upscale are asynchronous and return as soon as the provider accepts the task, so a caller re-reads `subtasks` instead of waiting on the call.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-shot-script',
    dir: 'tool-shot-script',
    source: 'packages/drama/tool-shot-script/src/index.ts',
    requires: ['ctx.tools', 'the project layout it reads and writes (episodes/, prompts/, matches/, episode_packages/)'],
    writes: ['tool/call', 'tool/result', 'on compile: the compiled prompt, the matched JSON, and the episode package under the project root'],
    async mount(ctx) {
      await ctx.plugin(ToolShotScript)
    },
    note:
      'The three methods share one schema: `validate` and `preview` only read, and `compile` writes the matched JSON and the episode package, returning each package\'s '
      + '`content_duration_ms`, its submitted whole-second length, and the prompt-ordered `material_keys` that `jubian_storyboard` `select_assets` must match. '
      + 'A script with any hard failure returns that failure list and writes nothing.',
  },
  {
    pkg: '@deepseek-ai/dsh-perception-bgm',
    dir: 'perception-bgm',
    source: 'packages/perception/perception-bgm/src/index.ts',
    requires: ['ctx.tools', 'a local track index or configured public catalogue; Python and model resources only for index/inspect'],
    writes: ['tool/call', 'tool/result', 'on index: the local emotion index; on download: verified audio in the configured cache'],
    async mount(ctx) {
      await ctx.plugin(PerceptionBgm)
    },
    note:
      '`match` ranks candidates without choosing a track; public mode returns IDs and URLs without downloading. '
      + '`download` accepts a selected catalogue track ID and returns a verified local file. '
      + 'The default is local-index mode; public matching requires deployment configuration. '
      + '`index` and `inspect` start Python only when executed, never during schema collection. '
      + 'The MERT analysis backbone is non-commercial (CC-BY-NC-4.0); audio rights remain separate.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-bgm-compose',
    dir: 'tool-bgm-compose',
    source: 'packages/drama/tool-bgm-compose/src/index.ts',
    requires: ['ctx.tools', 'ctx.subprocess', 'ffmpeg and ffprobe on PATH (or configured)', 'an episode timeline and explicit BGM plan'],
    writes: ['tool/call', 'tool/result', 'on compose: a 48 kHz stereo PCM WAV and adjacent generation report under the project root'],
    async mount(ctx) {
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(ToolBgmCompose)
    },
    note:
      '`preview` validates complete story coverage and reports source hashes, offsets, measured mean volume, and gains without publishing; '
      + '`compose` crossfades the selected tracks and publishes only after the staged WAV passes ffprobe; `verify` measures an existing WAV without rewriting it. '
      + 'The tool does not choose music or call `bgm_match`; the agent owns plot interpretation and final track selection.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-episode-render',
    dir: 'tool-episode-render',
    source: 'packages/drama/tool-episode-render/src/index.ts',
    requires: ['ctx.tools', 'ffmpeg and ffprobe on PATH (or configured), the project layout it reads and writes (video/, audio/, editing/, exports/)'],
    writes: [
      'tool/call',
      'tool/result',
      'on prepare: video/<episode>/shot_00N.mp4, audio/<episode>.wav, editing/<episode>-timeline.json, editing/<episode>.srt',
      'on render: the delivered MP4 and the render log under exports/.render_cache/<episode>/',
      'on drama_video ban/unban: project-local video-bans.json; media bytes are unchanged',
    ],
    async mount(ctx) {
      await ctx.plugin(ToolEpisodeRender)
    },
    note:
      '`drama_video` stores reversible, labelled SHA256 exclusions without review evidence; release is not approval. '
      + '`drama_render` refuses banned selected bytes in `prepare`/`render`, while `verify` reports risks without deleting media. '
      + 'Its three methods: `prepare` lays out render inputs without encoding picture, `render` produces the delivery and reports its measured '
      + 'resolution, frame rate, bitrate, duration, size, and encoder, and `verify` checks the delivered file. The delivery style is fixed — 1440x2560 at '
      + '60 fps, 24M target with a 30M ceiling and a 4.6 Mbps floor, SimHei 68 subtitles with the single bottom-right AI-content mark, and a two-second ending '
      + 'frozen from the last shot\u2019s proved tail frame. A render that cannot proceed throws with its repair instruction; a delivered file that misses the '
      + 'specification returns `ok: false` with per-check repairs.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-drama-assets',
    dir: 'tool-drama-assets',
    source: 'packages/drama/tool-drama-assets/src/index.ts',
    requires: ['ctx.tools', 'ctx.credentials', 'the project layout it reads and writes (assets_manifest.json, _probe/asset-reconcile.json)'],
    writes: ['tool/call', 'tool/result', 'on reconcile: _probe/asset-reconcile.json under the project root'],
    async mount(ctx) {
      // Like the Jubian row: this one also injects `credentials` and resolves the
      // token per read, so the harvest mounts the same stub provider.
      await ctx.plugin(LocalCredentialProvider, {
        path: join(tmpdir(), 'dsh-tool-catalog', 'credentials.yaml'),
        dshHome: join(tmpdir(), 'dsh-tool-catalog'),
        watch: false,
      })
      await ctx.plugin(ToolDramaAssets)
    },
    note:
      'Two methods over one evidence file: `reconcile` reads the remote project\u2019s asset and material lists and the manifest and writes the evidence the host\u2019s '
      + 'reconcile gate reads, and `dispose` records one disposition in it without any remote read. '
      + 'The tool never calls a Jubian write method and never bills; the disposition verdicts (`blocking`, `ignored_without_note`, `ready`) are the gate\u2019s inputs.',
  },
]

/** One package's contribution to the catalog: its schemas plus attribution. */
interface CatalogPackage {
  pkg: string
  sources: Readonly<Record<string, string>>
  requires: string[]
  writes: string[]
  shippedNames?: string[]
  schemas: ToolSchema[]
  /** A deployment note (see {@link ToolPackage.note}), rendered after the tools. */
  note?: string
}

/** The whole catalog: one entry per booted tool package, in manifest order. */
export type ToolCatalog = CatalogPackage[]

/**
 * Assert the boot manifest covers every shipped tool package on disk (a
 * `tool-*` leaf under `packages/`).
 * Booting has no source declaration to enumerate, so this glob restores the
 * "a new tool cannot be silently undocumented" guarantee: an unlisted package
 * fails the generator (and the freshness gate) until it is added to
 * {@link TOOL_PACKAGES}. Exported for a direct negative test.
 *
 * `scanRoot` defaults to the repo root; a test may point it at a fixture tree.
 */
export function assertManifestComplete(packages: ToolPackage[] = TOOL_PACKAGES, scanRoot: string = root): void {
  const onDisk = globSync('packages/*/tool-*', { cwd: scanRoot }).map(p => basename(p)).sort()
  const listed = new Set(packages.map(p => p.dir))
  const missing = onDisk.filter(dir => !listed.has(dir))
  if (missing.length > 0) {
    throw new Error(
      `gen-tool-catalog: ${missing.length} tool package(s) not in the boot manifest: ${missing.join(', ')}. `
      + 'Add each to TOOL_PACKAGES in scripts/gen-tool-catalog.ts so its schema is catalogued.',
    )
  }
}

/**
 * Assert one manifest entry actually registered a tool.
 *
 * A tool package that boots without registering anything is a broken boot, not
 * an empty catalog section. The usual cause is an `inject` the entry's `mount`
 * does not satisfy: cordis leaves the plugin PENDING, every step here still
 * succeeds, and the generator writes a catalog missing that package's tools.
 * The freshness gate stays green because regeneration reproduces the omission.
 * {@link assertManifestComplete} cannot see this: the
 * package IS listed, it just contributed nothing.
 * @param entry - the manifest entry that was booted.
 * @param harvested - how many schemas its boot registered.
 * @throws when the boot registered no tool at all.
 */
export function assertToolsHarvested(entry: ToolPackage, harvested: number): void {
  if (harvested > 0) return
  throw new Error(
    `gen-tool-catalog: ${entry.pkg} booted without registering a single tool. `
    + 'Its plugin is most likely PENDING on a service this manifest entry does not mount — '
    + `compare the plugin's inject with mount() and requires: ${entry.requires.join(', ')}.`,
  )
}

/**
 * Boot each tool package on a fresh Context and harvest its model-facing
 * schemas. A fresh Context per package keeps attribution clean (each entry's
 * schemas come from exactly that package) and isolates a boot failure to its
 * own entry. Disposed after harvest so no executor/provider outlives the run.
 */
export async function collectToolCatalog(packages: ToolPackage[] = TOOL_PACKAGES): Promise<ToolCatalog> {
  assertManifestComplete(packages)
  const catalog: ToolCatalog = []
  for (const entry of packages) {
    const ctx = new Context()
    // Dispose in `finally` so a throw from `mount`/`schemas()` after earlier
    // plugins mounted still tears the context down (no leaked executor/provider
    // fiber) — the repo's "dispose must reach quiescence" rule.
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime, entry.toolsConfig ?? {})
      await entry.mount(ctx)
      const schemas = ctx.tools.schemas(entry.scope?.(ctx)).sort((a, b) => a.name.localeCompare(b.name))
      assertToolsHarvested(entry, schemas.length)
      catalog.push({
        pkg: entry.pkg,
        sources: Object.fromEntries(schemas.map(schema => [
          schema.name,
          toolSource(entry, schema.name),
        ])),
        requires: entry.requires,
        writes: entry.writes,
        schemas,
        ...entry.shippedNames !== undefined ? { shippedNames: entry.shippedNames } : {},
        ...entry.note !== undefined ? { note: entry.note } : {},
      })
    } finally {
      await ctx.fiber.dispose()
    }
  }
  return catalog
}

/** Resolve one harvested tool to the plugin source that registered it. */
function toolSource(entry: ToolPackage, toolName: string): string {
  if (typeof entry.source === 'string') return entry.source
  const source = entry.source[toolName]
  if (source === undefined) {
    throw new Error(
      `gen-tool-catalog: ${entry.pkg} has no source mapping for harvested tool ${toolName}`,
    )
  }
  return source
}

/** Render one tool's entry: name, description, JSON-Schema parameters, source. */
function renderTool(schema: ToolSchema, source: string): string[] {
  const out = [`### \`${schema.name}\``, '']
  if (schema.description) out.push(schema.description, '')
  out.push('```json', JSON.stringify(schema.parameters, null, 2), '```', '')
  out.push(`Source: [\`${source}\`](../${source})`, '')
  return out
}

function codeList(values: string[] | undefined): string {
  return values?.length ? values.map(value => `\`${value}\``).join(', ') : '-'
}

function tableCell(value: string | undefined): string {
  return value ? value.replace(/\|/g, '\\|').replace(/\n/g, '<br>') : '-'
}

/** Render the full catalog (pure, deterministic given the manifest-ordered input). */
export function render(catalog: ToolCatalog): string {
  const lines: string[] = [
    '<!-- Generated by scripts/gen-tool-catalog.ts — do not edit by hand.',
    '     Run `pnpm run gen-tool-catalog` to regenerate. -->',
    '',
    '# Tool Schema Catalog',
    '',
    'Every model-facing tool a shipped plugin contributes to `ctx.tools`: the `name`, `description`, and JSON-Schema `parameters` the model receives via the system-prompt assembly. It complements the [subsystem pages](subsystems/core.md) (the types plus each page\'s generated Cordis API region) — this page is the *tools* the agent is offered.',
    '',
    'This file is GENERATED and verified fresh by `pnpm run verify-tool-catalog` (part of `doc-sync`) — do not edit it by hand. Unlike the cordis catalog (a pure source-AST pass), this generator BOOTS each tool plugin on a real context and reads `ctx.tools.schemas()`, because a tool schema is not statically knowable (runtime-spread enums, concatenated descriptions, config-driven names, raw-JSON-Schema MCP tools). A completeness guard globs `packages/*/tool-*` and fails if any package is missing from the generator\'s boot manifest, so a new tool cannot be silently undocumented.',
    '',
    'Scope: shipped product tools under `packages/*/tool-*` and explicitly listed tool providers such as `perception-bgm`, each booted with its DEFAULT config, except where a Config field is REQUIRED with no default — there the generator must choose, and the per-package note records which branch this page shows. The registered tool NAME can be a load-time config (e.g. `tool-subagent`\'s `toolName`), so a deployment may expose a package under a different or additional name — a per-package note records those shipped aliases where they exist. The `examples/` demo tools (e.g. `echo`) are excluded, matching the cordis catalog\'s packages-only scope.',
    '',
    '## Tool Package Map',
    '',
    'This table connects model-visible tool names to the plugin package and service seams behind them. Exact JSON Schemas follow in the package sections below.',
    '',
    '| Tool package | Model-visible names | Requires | Writes / affects | Shipped aliases | Deployment note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...catalog.map(entry => `| \`${entry.pkg}\` | ${codeList(entry.schemas.map(schema => schema.name))} | ${codeList(entry.requires)} | ${codeList(entry.writes)} | ${codeList(entry.shippedNames)} | ${tableCell(entry.note)} |`),
    '',
  ]
  for (const entry of catalog) {
    lines.push(`<a id="${githubSlug(entry.pkg)}"></a>`, '', `## \`${entry.pkg}\``, '')
    for (const schema of entry.schemas) {
      // Collection validated that every harvested schema has a source.
      const source = entry.sources[schema.name] as string
      lines.push(...renderTool(schema, source))
    }
    if (entry.note) lines.push(entry.note, '')
  }
  return lines.join('\n')
}

/** CLI entry: default writes the catalog, `--check` fails if the committed copy
 * is stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed file nor calls process.exit. */
async function main(): Promise<void> {
  const content = render(await collectToolCatalog())
  if (process.argv.includes('--check')) {
    let committed: string | null = null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // Only ENOENT (not yet generated) is expected; a present-but-unreadable
      // file is not a state this repo produces. Either way the remedy is the
      // same — regenerate — so treat a read failure as "stale".
      committed = null
    }
    if (committed === content) {
      console.log(`gen-tool-catalog: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-tool-catalog: ${OUT} is stale. Run \`pnpm run gen-tool-catalog\` and commit ${OUT}.`)
    const committedLines = committed?.split('\n') ?? []
    const generatedLines = content.split('\n')
    const lineCount = Math.max(committedLines.length, generatedLines.length)
    for (let index = 0; index < lineCount; index += 1) {
      if (committedLines[index] === generatedLines[index]) continue
      console.error(`gen-tool-catalog: first difference at line ${index + 1}`)
      console.error(`  committed: ${JSON.stringify(committedLines[index])}`)
      console.error(`  generated: ${JSON.stringify(generatedLines[index])}`)
      break
    }
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-tool-catalog: wrote ${OUT}.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
