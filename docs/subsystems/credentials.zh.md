# 用户凭据

[English](credentials.md) | 中文

[dsh-credentials](../../packages/credentials/credentials) 的凭据 seam 把机密挡在配置之外：settings 分节与 `cordis.yml` 条目携带的是*引用*（环境变量名），值归 [dsh-credentials-local](../../packages/credentials/credentials-local) 这类提供方所有，消费方每个操作解析一次引用——LLM（大语言模型）适配器每次模型请求解析一次，因此轮换后的凭据无需任何重启即可作用于紧随其后的下一次请求。一条 seam 级规则约束每个提供方：空的存储值在任何地方都视为不存在。

来源：[`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## 标识

引用以 POSIX 风格环境变量名命名一条凭据。brand 防止调用方将凭据引用与在包或进程之间传递的其他字符串混用；构造时校验 shell 标识符语法。

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

<a id="resolution"></a>
## 解析

`resolve(ref)` 返回值及提供该值的来源层（由提供方定义）；未配置期间返回 `undefined`。消费方在每个操作中重新解析，绝不跨操作缓存——这种按操作进行的读取正是热更新机制。

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}
```

## 描述

`describe(ref)` 在绝不暴露值的前提下回应配置界面：引用当前是否可解析、来自哪一层、`set` 当前能否成功。可选的 `masked` 字段携带提供方生成的脱敏预览，不包含完整凭据。本地提供方将其管理的文件排在启动环境之前，因此保存值总会成为生效且可写的那一层；移除后会重新使用启动环境或 `.env` 后备值。

```ts type-equiv
/**
 * Configuration facts and an optional provider-masked preview for one
 * reference. The full credential is never part of this view.
 */
interface CredentialInfo {
  /** Whether resolving the reference would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether the active provider can write this reference. */
  writable: boolean
  /** Provider-generated masked preview of a stored value; never the full value. */
  masked?: string
}
```

## 已提交的变更

`credentials/reference-updated (ref)` 在提供方管理的来源发生已提交变更后发出——`set`、`unset` 或在存储中观察到的外部编辑。进程环境自身的变化不可观测，永不发出事件。消费方不需要该事件（它们按操作重新解析）；它服务于配置界面刷新「已配置」徽标。

## 内嵌 Platform 凭证

PlatformSession 是 getPlatformSession 返回的仅限 Host 快照：origin 指定所配置的 Platform 签发来源，token 包含其已存账号凭证。userId 复制最近一次成功 getProfile 得到的稳定账号 ID；尚无一次成功读取或资料不含 ID 时为 null。快照复用该 ID，不自行发起资料请求，因此 ID 未知时只会让 userId 为 null，而不会延迟调用方；资料读取首次取得稳定 ID 或该 ID 变化时仅通知使用 `watch(signal, true)` 的 Host 订阅者，供标识使用方重新读取快照。使用方以 origin 和 userId 作为持久化浏览器存储的键，为 null 时退回临时存储。账号已退登或读取凭证期间凭证变化时不返回快照；签发来源不匹配时失败。原生使用方负责在凭证变化时使文档失效。账号 Remote API、AccountView 和 AccountDetails 均不包含此快照。

AccountDetails.balance 将充值钱包投影为 value、赠送钱包投影为 bonusWallets，分别保留币种和十进制余额字符串。查询失败不包含钱包数组。

赠金通知查询返回 AccountBonusBatch，包含当前 Platform 账号 id 和按服务端顺序排列的可通知订单。AccountBonusNotification 保留服务端消息与到期时间，不投影凭证。确认请求携带预期账号 id 和订单 id；账号变化后 Host 拒绝该请求。两项通知操作都通过 x-client-locale 传递发起界面的语言，不使用语言查询参数。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxauthorization--authorizationservice"></a>

### `ctx.authorization` — `AuthorizationService`

`ctx.authorization`: a registry of credential-obtaining flows, one attempt at a time per key.

```ts cordis-catalog
/**
 * Offer a way to obtain one credential. One flow per key: two plugins
 * claiming the same key would each write a record in their own format, and
 * whichever ran last would leave the other reading a payload it cannot parse.
 *
 * @param flow - the key it writes, its label, its methods, and its runner.
 * @returns Disposer that withdraws this flow.
 * @throws {AuthorizationError} code `DUPLICATE_FLOW` when the key is already claimed.
 */
registerFlow(flow: AuthorizationFlow): () => void

/**
 * Every registered flow, for a surface listing what can be authorized.
 * @returns one entry per flow, in registration order.
 */
list(): readonly AuthorizationEntry[]

/**
 * One registered flow.
 * @param key - the credential record to ask about.
 * @returns the entry, or undefined when no flow claims that key.
 */
describe(key: CredentialKey): AuthorizationEntry | undefined

/**
 * Withdraw the attempt running for a key, if any. Separate from the
 * request's own signal because a request/response transport answers a Cancel
 * button on a second call, with no handle on the first one's signal.
 * @param key - the credential record whose attempt should stop.
 */
cancel(key: CredentialKey): void

/**
 * Run one attempt to authorize a key, and report how it ended.
 *
 * One attempt per key at a time. A second caller is refused rather than
 * joined: the two would be prompting different humans through the same flow,
 * and the second would answer questions the first was asked.
 *
 * @param request - the key, the method, the surface, and the cancel signal.
 * @returns `authorized` once the flow's record is committed during this
 *   attempt and observed, or `cancelled` when the human declined or the
 *   caller withdrew.
 * @throws {AuthorizationError} code `NO_FLOW` when nothing claims the key,
 *   `UNKNOWN_METHOD` when the named method is not one the flow offers,
 *   `ALREADY_IN_FLIGHT` when an attempt is already running for the key, or
 *   `NOT_COMMITTED` when the flow resolved without committing a record
 *   during the attempt.
 */
async begin(request: AuthorizationRequest): Promise<AuthorizationOutcome>
```

Source: [`packages/credentials/authorization/src/index.ts`](../../packages/credentials/authorization/src/index.ts)

<a id="ctxcredentials--credentialprovider-abstract-seam"></a>

### `ctx.credentials` — `CredentialProvider` (abstract seam)

Abstract credential service over two key spaces that answer two questions.

A CredentialRef answers "what is behind this environment-variable name": the provider-managed store first, then ambient fallbacks such as the process environment and `.env` files. One seam-wide rule binds that half: an empty stored value is absent everywhere — `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a configured secret.

A CredentialKey answers "what credential does this plugin hold for this id". Nothing can layer here — an authorization grant has no environment to be read from — so presence of the record is the whole fact, and modifyRecord is the only write path because a correct write depends on the current value (a token refresh is read-decide-replace under one lock).

```ts cordis-catalog
/**
 * Resolve one reference to its current value. Resolution is per call:
 * consumers re-resolve at each operation and must not cache across
 * operations — that per-operation read is what makes a changed credential
 * reach the next operation without a restart.
 * @param ref - the reference to resolve.
 * @returns the value and its source, or `undefined` while unconfigured.
 */
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

/**
 * Describe one reference for configuration surfaces without exposing the
 * full value.
 * @param ref - the reference to describe.
 * @returns configured state, supplying source, writability, and optional masked preview.
 */
abstract describe(ref: CredentialRef): Promise<CredentialInfo>

/**
 * Durably store one value in the provider-managed writable source. The stored
 * value takes precedence over ambient fallbacks, and empty values are
 * rejected (use {@link unset}).
 * @param ref - the reference to store.
 * @param value - the non-empty secret value.
 */
abstract set(ref: CredentialRef, value: string): Promise<void>

/**
 * Remove one reference from the provider-managed writable source; removing
 * an absent reference is a no-op. Ambient fallback layers may become
 * effective again after removal.
 * @param ref - the reference to remove.
 */
abstract unset(ref: CredentialRef): Promise<void>

/**
 * Read one stored record. The value is returned as its owner wrote it; a
 * {@link GrantRecord} payload is not interpreted on the way out.
 * @param key - the record to read.
 * @returns the record, or `undefined` while none is stored.
 */
abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>

/**
 * Describe one record for configuration surfaces without exposing its value.
 * @param key - the record to describe.
 * @returns presence, discriminant, and writability.
 */
abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>

/**
 * Enumerate every stored record's address and tag. Unlike the reference
 * half, which has no enumeration because configuration surfaces learn which
 * references exist from settings schemas, records have no such discovery
 * path: a surface that cannot list them cannot show what a user is
 * authorized for, nor find an orphan left by an uninstalled plugin.
 * @returns every stored record, values excluded.
 */
abstract listRecords(): Promise<readonly CredentialRecordEntry[]>

/**
 * Serialized read-modify-write over one record — the only write path.
 * `mutate` sees the record as it stands at the moment the write is
 * exclusive, and returning `undefined` leaves the entry untouched. Exclusion
 * holds across processes where the backing store supports it, which is what
 * makes a token refresh safe: two processes rotating one refresh token
 * concurrently would otherwise lose whichever wrote first.
 * @param key - the record to modify.
 * @param mutate - receives the current record and returns its replacement, or `undefined` to leave it.
 * @returns the record after the write, or the current one when `mutate` declined.
 */
abstract modifyRecord( key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>, ): Promise<CredentialRecord | undefined>

/**
 * Remove one record; removing an absent record is a no-op.
 * @param key - the record to remove.
 */
abstract deleteRecord(key: CredentialKey): Promise<void>
```

Source: [`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

<a id="ctxcredentialscontroller--credentialscontroller"></a>

### `ctx.credentialsController` — `CredentialsController`

Host service backing the generated `ctx.remote.credentials` namespace. It carries every wire obligation the credential seam itself does not: the batch fan-out bound, the field-by-field view projection, the reference-grammar guard, and the refusal mapping. Full secret values cross in one direction only — no method here returns one.

```ts cordis-catalog
/**
 * Describe several references for one configuration surface. Batched because
 * a settings page describes every reference its rows name at once, and one
 * round trip keeps those rows from settling separately.
 * @param refs - reference names, at most {@link MAX_DESCRIBE_REFS}; a name outside the grammar
 *   rejects the whole call as `gateway/bad-request`.
 * @returns one view per requested name, keyed by that name.
 * @throws RemoteError when the request is invalid or no credential provider is mounted.
 */
@Remote async describe(refs: string[]): Promise<Record<string, CredentialInfo>>

/**
 * Store one value from a configuration surface. The value crosses the wire in
 * this direction only: no read path returns it.
 * @param ref - reference name to store under.
 * @param value - the non-empty secret value.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async set(ref: string, value: string): Promise<void>

/**
 * Remove one reference from a configuration surface.
 * @param ref - reference name to remove.
 * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
 */
@Remote async unset(ref: string): Promise<void>
```

Source: [`packages/api/settings-controller/src/credentials.ts`](../../packages/api/settings-controller/src/credentials.ts)

<a id="ctxdeepseekaccount--deepseekaccount"></a>

### `ctx.deepseekAccount` — `DeepSeekAccount`

Account login, credentials, and client-safe Remote operations.

```ts cordis-catalog
/**
 * Read stored-account presence and the latest login attempt.
 * @returns a snapshot without credentials or PKCE secrets.
 */
@Remote async getState(): Promise<AccountView>

/**
 * Query Platform profile independently of wallet balances.
 * A ready result whose stable profile ID first becomes available or changes notifies identity-enabled watch
 * consumers, so they re-read getPlatformSession; repeated IDs stay silent.
 * @param client - identity of the requesting UI for this call.
 * @returns profile outcome, or null if signed out or the grant changed during the query.
 */
@Remote async getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null>

/**
 * Query Platform recharge and bonus wallet balances independently of profile data.
 * @param client - identity of the requesting UI for this call.
 * @returns balance outcome, or null if signed out or the grant changed during the query.
 */
@Remote getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null>

/**
 * Query unconsumed account notifications in server order without reading profile data.
 * @param client - identity of the requesting UI for this call; its language selects the server-authored message.
 * @returns notifications with their next query delay, or null if signed out or the grant changed during the query.
 */
@Remote async getNotifications(client: AccountClientMetadata): Promise<AccountNotificationBatch | null>

/**
 * Query localized content of a notification, including one already consumed.
 * @param id - notification whose content is requested.
 * @param client - identity of the requesting UI; its language selects the localized content.
 * @returns content without changing consumption, or null if signed out or the grant changed.
 */
@Remote async getNotificationContent(id: AccountNotificationId, client: AccountClientMetadata): Promise<AccountNotification | null>

/**
 * Report a notification interaction; the backend decides consumption.
 * @param id - notification the user interacted with.
 * @param event - displayed frame, non-dismiss action click, or explicit dismissal.
 * @param client - identity of the requesting UI for this call.
 * @returns true once the server accepts the event; false if signed out or credentials changed during the call.
 */
@Remote async reportNotificationEvent(id: AccountNotificationId, event: AccountNotificationEvent, client: AccountClientMetadata): Promise<boolean>

/**
 * Remove an inference-rejected token only while it still matches the stored login.
 * @param token - token captured by the rejected inference request.
 * @returns after matching credentials are removed and the expiry notification is emitted.
 */
async rejectToken(token: string): Promise<void>

/**
 * Read existing login identity without creating a device or returning credentials.
 * @returns optional device/account identifiers and the provider's OS version string.
 */
async getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }>

/**
 * Read credentials for the configured embedded-page origin, bound to their account environment, and
 * pair them with the account ID from the last successful profile read; no profile request is made.
 * @returns a Host-only snapshot, or null while signed out or when the credential changed during the read.
 */
async getPlatformSession(): Promise<PlatformSession | null>

/**
 * Resolve a credential only for the inference origin allowed by the provider.
 * @param url - actual request destination or API base URL.
 * @returns stored token, or undefined for other origins or a signed-out account.
 */
async resolveToken(url: string): Promise<string | undefined>

/**
 * Join an active attempt or start browser authorization.
 * @param client - identity of the requesting UI; a new attempt captures it, and joining retains the original attempt's identity.
 * @param callbackOrigin - browser-accessible loopback HTTP origin, including any SSH local port.
 * @param loginSource - initiating UI, used to return from a failed exchange.
 * @returns the initial snapshot without waiting for browser approval.
 */
@Remote async startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView>

/**
 * Cancel only the named attempt; committing attempts settle before returning.
 * @param attemptId - attempt identity from this Host.
 * @returns state after cancellation or an already-started commit.
 */
@Remote async cancelSignIn(attemptId: SignInAttemptId): Promise<AccountView>

/**
 * Remove the local grant while retaining API keys; the provider revokes it in the background.
 * @param client - identity of the requesting UI, captured for the background revocation retries.
 * @returns the signed-out state after local removal; remote failures never restore the grant.
 */
@Remote signOut(client: AccountClientMetadata): Promise<AccountView>

/**
 * Inspect running work before sign-out.
 * @returns whether a running task's latest request uses the account route; false when the optional agents service is absent.
 */
@Remote hasRunningAccountTasks(): boolean

/**
 * Subscribe to live credential expiry without replay.
 * @param signal - subscription lifetime; provider disposal also ends it.
 * @returns expiry notifications emitted during the subscription.
 */
@Remote({ mode: 'stream' }) async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'>

/**
 * Subscribe to ordered updates including a complete initial snapshot.
 * @param signal - subscription lifetime; ending it never cancels login.
 * @param includeIdentityChanges - also notify when cached Platform identity changes; defaults to false.
 * @returns complete state with snapshot or credentials-changed event type; credential changes take priority when updates coalesce.
 */
watch(signal: AbortSignal, includeIdentityChanges: boolean = false): AsyncIterable<AccountUpdate>

/**
 * Stream account state without the Host-only identity subscription option.
 * @param signal - subscription lifetime.
 * @returns initial state, login progress, and credential-change updates.
 */
@Remote({ name: 'watch', mode: 'stream' }) watchState(signal: AbortSignal): AsyncIterable<AccountUpdate>
```

Source: [`packages/credentials/deepseek-account/src/index.ts`](../../packages/credentials/deepseek-account/src/index.ts)

<a id="ctxjingliuconnection--jingliuconnection"></a>

### `ctx.jingliuConnection` — `JingliuConnection`

Resolves user grants at execution time, keeping tokens outside model input and output.

```ts cordis-catalog
/** Resolve the active account on the selected deployment.
 * @returns A transport bound to this Muse login and Jingliu user.
 */
async connection(): Promise<JingliuSession>

/**
 * Find the project associated with this conversation and owner.
 * @param sessionId - Actual Muse conversation.
 * @param identity - Verified studio user.
 * @returns Its matching cloud selection.
 */
async selected(sessionId: string, identity: string): Promise<SelectedProject | null>

/**
 * Capture the signed-in production for an execution assignment.
 * @param sessionId - Routing conversation.
 * @returns Its confirmed project and current studio owner for a worker assignment.
 */
async assignmentProject(sessionId: SessionId): Promise<(SelectedProject & { owner: string }) | null>

/**
 * Bind the worker to the production captured by its Router.
 * @param worker - Worker receiving a recorded assignment.
 * @param project - Project selected when the user delegated the work.
 */
async inheritProject(worker: SessionId, project: SelectedProject & { owner: string }): Promise<void>

/**
 * Confirm a production for a local conversation and notify its Agent.
 * @param sessionId - Conversation shown to the user.
 * @param projectId - Project explicitly confirmed.
 * @param signal - User action lifetime.
 * @returns The native project title and ID.
 */
@Remote async selectProject(sessionId: SessionId, projectId: string, signal: AbortSignal): Promise<SelectedProject>

/**
 * Follow the production shown beside one conversation.
 * @param sessionId - Right sidebar's Session.
 * @param signal - Subscription lifetime.
 * @returns This Session's initial and updated project selection.
 */
@Remote({ mode: 'stream' }) async *watchProject(sessionId: SessionId, signal: AbortSignal): AsyncIterable<SelectedProject | null>

/**
 * List productions the current studio account can access.
 * @param signal - Panel cancellation.
 * @returns Projects visible to the signed-in studio user.
 */
@Remote async listProjects(signal: AbortSignal): Promise<StudioProject[]>

/**
 * Read the shared media catalog as the current studio user.
 * @param query - Filter and page offset for the shared library.
 * @param signal - Panel cancellation.
 * @returns A native catalog page.
 */
@Remote async sharedAssets(query: StudioLibraryQuery, signal: AbortSignal): Promise<StudioLibrary>

/**
 * Load a thumbnail without exposing the studio credential. With `localMedia` the image is downloaded once into this
 * account's cache folder in the Host home, `jingliu/media/<account>`, and returned as that file; otherwise it is returned
 * inline, up to 8 MiB.
 * @param path - Native thumbnail path in the current library.
 * @param signal - Panel cancellation.
 * @returns A preview image for this account.
 */
@Remote async thumbnail(path: string, signal: AbortSignal): Promise<StudioImage>

/**
 * Read the choices the studio offers for a new production.
 * @param signal - Panel cancellation.
 * @returns Modes with their art styles, frame ratios, resolutions and models.
 */
@Remote async catalog(signal: AbortSignal): Promise<StudioCatalog>

/**
 * Create a production as the signed-in studio user.
 * @param input - Its name and settings, each one the catalog offers or '' for the studio default.
 * @param signal - Form lifetime.
 * @returns The created production's id and title.
 */
@Remote async createProject(input: StudioNewProject, signal: AbortSignal): Promise<SelectedProject>

/**
 * Rename a production; later generations use the new name in their prompts.
 * @param projectId - The production.
 * @param title - Its new name.
 * @param signal - Form lifetime.
 * @returns The stored id and title.
 */
@Remote async renameProject(projectId: string, title: string, signal: AbortSignal): Promise<SelectedProject>

/**
 * Delete one shot of a production; the studio keeps no copy to restore.
 * @param projectId - The production the workbench shows.
 * @param shotId - The shot to delete.
 * @param signal - Card lifetime.
 * @returns Nothing once the studio confirms.
 */
@Remote async deleteShot(projectId: string, shotId: string, signal: AbortSignal): Promise<void>

/**
 * Read a project's configuration for the workbench.
 * @param projectId - Selected cloud project.
 * @param signal - Panel cancellation.
 * @returns Title, frame ratio, styles and models of the production.
 */
@Remote async projectConfig(projectId: string, signal: AbortSignal): Promise<StudioConfig>

/**
 * List a production's episodes.
 * @param projectId - Selected cloud project.
 * @param signal - Panel cancellation.
 * @returns Episodes in studio order.
 */
@Remote async episodeList(projectId: string, signal: AbortSignal): Promise<StudioEpisode[]>

/**
 * Read every shot of one episode with its full prompt.
 * @param projectId - Selected cloud project.
 * @param episode - Episode number.
 * @param signal - Panel cancellation.
 * @returns The episode's shots in order.
 */
@Remote async episodeShots(projectId: string, episode: number, signal: AbortSignal): Promise<StudioShot[]>

/**
 * Read one shot's video, first frame and version chain.
 * @param projectId - Selected cloud project.
 * @param shotId - Shot of that project.
 * @param signal - Panel cancellation.
 * @returns The shot's media.
 */
@Remote async shotMedia(projectId: string, shotId: string, signal: AbortSignal): Promise<StudioShotMedia>

/**
 * Read a production's assets and audio clips.
 * @param projectId - Selected cloud project.
 * @param signal - Panel cancellation.
 * @returns The workbench asset page's data.
 */
@Remote async projectAssets(projectId: string, signal: AbortSignal): Promise<StudioProjectAssets>

/**
 * Download a studio video once into the production's media folder of a conversation's workspace, for playback from
 * that file. Kept tool and draft files stay; other viewed files beyond `mediaCacheBytes` are removed, oldest first.
 * @param request - Conversation, production and stored video address.
 * @param signal - Playback cancellation.
 * @returns The absolute local file, or null when this Host keeps no local media or the conversation has no workspace.
 */
@Remote async localVideo(request: StudioVideoRequest, signal: AbortSignal): Promise<string | null>

/**
 * Stream a studio video for playback without exposing the studio credential, for a Host without local media.
 * @param path - Media path of a video in the current studio.
 * @param signal - Playback cancellation.
 * @returns The content type first, then base64 chunks of the file, up to 64 MiB.
 */
@Remote({ mode: 'stream' }) async *video(path: string, signal: AbortSignal): AsyncIterable<string>

/**
 * Read the current account allowance and usage.
 * @param signal - Panel cancellation.
 * @returns The current Jingliu account allowance.
 */
@Remote async balance(signal: AbortSignal): Promise<StudioBalance>

/**
 * Read the current account's credit and recent balance movements.
 * @param signal - Caller cancellation.
 * @returns The balance and up to 50 recent entries, or a null ledger when the account has none available.
 */
@Remote async billingDetails(signal: AbortSignal): Promise<StudioBillingDetails>

/**
 * Read the native settings of one production.
 * @param projectId - Selected cloud project.
 * @param signal - Panel cancellation.
 * @returns Preferences saved by both clients.
 */
@Remote async preferences(projectId: string, signal: AbortSignal): Promise<StudioPreferences>

/**
 * List available production settings and their stored values.
 * @param projectId - Selected project.
 * @param signal - Panel lifetime.
 * @returns Native model and resolution settings.
 */
@Remote async projectOptions(projectId: string, signal: AbortSignal): Promise<StudioOptions>

/**
 * Change one setting and verify the stored value.
 * @param projectId - Selected project.
 * @param key - Single field to update.
 * @param value - Model or resolution; empty uses the project default.
 * @param signal - Panel lifetime.
 * @returns Settings read back from the same project.
 */
@Remote async saveOption(projectId: string, key: StudioSetting, value: string, signal: AbortSignal): Promise<StudioOptions>

/**
 * Update how references appear in this production.
 * @param value - Preference explicitly changed by the user.
 * @param signal - Panel cancellation.
 * @returns A verified read from the same project and account.
 */
@Remote async savePreferences(value: StudioPreferences, signal: AbortSignal): Promise<StudioPreferences>
```

Types: [SessionId](core.zh.md)

Source: [`packages/drama/jingliu-connection/src/index.ts`](../../packages/drama/jingliu-connection/src/index.ts)

<a id="ctxjubiantoken--jubiantoken"></a>

### `ctx.jubianToken` — `JubianToken`

Host service backing the generated `ctx.remote.jubianToken` namespace: the Jubian admin token as the Web Settings page reads, writes, and clears it.

```ts cordis-catalog
/**
 * Describe the stored token without reading it.
 * @returns whether a value is configured, which source supplies it, and whether this deployment can write it.
 */
@Remote async describe(): Promise<CredentialInfo>

/**
 * Store one value under the fixed reference.
 * @param value - the token; an empty or whitespace-only value is refused.
 * @returns the same facts {@link describe} reports after the write.
 * @throws RemoteError when the value is empty, or when the provider refuses the write.
 */
@Remote async set(value: string): Promise<CredentialInfo>

/**
 * Remove the stored value. Removing an absent reference is a no-op.
 * @returns the same facts {@link describe} reports after the removal.
 * @throws RemoteError when the provider refuses the write.
 */
@Remote async unset(): Promise<CredentialInfo>
```

Source: [`packages/jubian/tool-jubian/src/token.ts`](../../packages/jubian/tool-jubian/src/token.ts)

<a id="ctxworkshopconnection--workshopconnection"></a>

### `ctx.workshopConnection` — `WorkshopConnection`

Opens Script Workshop sessions as the signed-in Muse user and serves the Client's draft editor and finalized-script library; native tokens never reach model input or output.

```ts cordis-catalog
/** Resolve the active Muse account on the configured Workshop.
 * @returns A session bound to this Muse login and Workshop user.
 */
async connection(): Promise<WorkbenchSession>

/**
 * One page of the finalized-script library, which every signed-in member can read.
 * @param request - Stage filter, title search, own scripts only, and page.
 * @returns The page, counts per stage for the same search, and whether this member may pick.
 */
@Remote('scripts') async scripts(request: ScriptListRequest): Promise<ScriptList>

/**
 * One script with its versions and the text of one version.
 * @param request - Script and optional version; the latest when omitted.
 * @returns The script, its versions and that version's episodes.
 */
@Remote('script') async script(request: ScriptReadRequest): Promise<ScriptDetail>

/**
 * Pick one version for production; the Workshop refuses members without the pick permission.
 * @param request - Script and version.
 * @returns The script's card after the pick.
 */
@Remote('pickScript') async pickScript(request: ScriptPickRequest): Promise<ScriptSummary>

/**
 * Record the Jingliu project a picked script became.
 * @param request - Script and the project's ID and title.
 * @returns The script's card, now in production.
 */
@Remote('scriptProduction') async scriptProduction(request: ScriptProductionRequest): Promise<ScriptSummary>

/** List accessible draft cards for the signed-in editor.
 * @param request - Search and page.
 * @returns Drafts and the next offset.
 */
@Remote async scriptDrafts(request: ScriptDraftListRequest): Promise<ScriptDraftList>

/** Create a blank draft or import an existing file into this editor's draft library.
 * @param request - Title, episodes or file, and an optional retry identifier.
 * @returns The new draft and its initial episodes.
 */
@Remote async createScriptDraft(request: ScriptDraftCreateRequest): Promise<ScriptDraft>

/** Read a draft's editable episodes and context.
 * @param request - Draft to open.
 * @returns Episode directory, context, and publication revision.
 */
@Remote async scriptDraft(request: ScriptDraftRequest): Promise<ScriptDraft>

/** Read the saved text of one episode and the editor's pending candidate.
 * @param request - Draft and episode to open.
 * @returns The saved text, revision and candidate if present.
 */
@Remote async scriptDraftEpisode(request: ScriptDraftEpisodeRequest): Promise<ScriptDraftEpisode>

/** Stage one chat-generated candidate for human review.
 * @param request - Exact base revision, proposed episode text and summary.
 * @param signal - Cancellation of the tool call.
 * @returns The pending candidate.
 */
async stageScriptDraftCandidate(request: ScriptDraftStageRequest, signal?: AbortSignal): Promise<ScriptDraftCandidate>

/** Apply the exact candidate reviewed in the editor.
 * @param request - Episode and candidate ID.
 * @returns The newly saved episode.
 */
@Remote async applyScriptDraftCandidate(request: ScriptDraftCandidateRequest): Promise<ScriptDraftEpisode>

/** Discard the exact pending candidate without editing the saved episode.
 * @param request - Episode and candidate ID.
 * @returns The saved episode.
 */
@Remote async discardScriptDraftCandidate(request: ScriptDraftCandidateRequest): Promise<ScriptDraftEpisode>

/** Save a manual edit to one episode.
 * @param request - Episode, displayed revision, and updated text.
 * @returns The saved episode.
 */
@Remote async saveScriptDraftEpisode(request: ScriptDraftSaveRequest): Promise<ScriptDraftEpisode>

/** Read the structured screenplay stored separately from an episode's source text.
 * @param request - Draft and episode to open.
 * @returns The structured screenplay, its revision, and whether it needs review after a source edit.
 */
@Remote async scriptDraftStoryboard(request: ScriptDraftEpisodeRequest): Promise<ScriptDraftStoryboard>

/** Save the structured screenplay displayed by the editor.
 * @param request - Episode, displayed revision, and updated screenplay.
 * @returns The saved structured screenplay.
 */
@Remote async saveScriptDraftStoryboard(request: ScriptDraftStoryboardSaveRequest): Promise<ScriptDraftStoryboard>

/** List the saved versions of one episode and layer.
 * @param request - Episode and layer to inspect.
 * @returns Version metadata.
 */
@Remote async scriptDraftHistory(request: ScriptDraftHistoryRequest): Promise<ScriptDraftHistory>

/** Read the exact historical version selected by the editor.
 * @param request - Episode, layer, and history entry.
 * @returns The selected historical content.
 */
@Remote async scriptDraftHistoryEntry(request: ScriptDraftHistoryEntryRequest): Promise<ScriptDraftHistoryEntry>

/** Restore a historical version as a new revision.
 * @param request - Historical entry and the current revision reviewed by the editor.
 * @returns The restored episode layer.
 */
@Remote async restoreScriptDraftHistory(request: ScriptDraftHistoryRestoreRequest): Promise<ScriptDraftHistoryRestore>

/** Download an authorized export of the saved draft or selected episode.
 * @param request - Content scope and format.
 * @returns Download metadata and file bytes encoded for the Client.
 */
@Remote async exportScriptDraft(request: ScriptDraftExportRequest): Promise<ScriptDraftExport>

/** Publish a reviewed draft revision to the finalized library.
 * @param request - Draft, revision, and publication metadata reviewed by the user.
 * @returns The finalized library card.
 */
@Remote async finalizeScriptDraft(request: ScriptDraftFinalizeRequest): Promise<ScriptSummary>
```

Source: [`packages/drama/workbench-connection/src/index.ts`](../../packages/drama/workbench-connection/src/index.ts)

<a id="authorization-events"></a>

### `authorization/*` events

<a id="authorizationsettled--emit"></a>

#### `authorization/settled` — emit

One authorization attempt has finished and released its key. Fires for every terminal outcome, failures included, so a surface watching a key it did not start (a second browser tab) learns the attempt is over.

```ts cordis-catalog
/**
 * One authorization attempt has finished and released its key. Fires for
 * every terminal outcome, failures included, so a surface watching a key it
 * did not start (a second browser tab) learns the attempt is over.
 * @mode emit
 * @param key - the credential record the finished attempt was authorizing.
 * @param settlement - how it ended, including the `failed` case its caller sees as a thrown error.
 */
'authorization/settled'(key: CredentialKey, settlement: AuthorizationSettlement): void
```

Source: [`packages/credentials/authorization/src/index.ts`](../../packages/credentials/authorization/src/index.ts)

<a id="credentials-events"></a>

### `credentials/*` events

<a id="credentialsrecord-updated--emit"></a>

#### `credentials/record-updated` — emit

Committed change to a stored credential record: a `modifyRecord` that wrote, a `deleteRecord` that removed, or an external edit observed in storage. Separate from `credentials/reference-updated` because the two key grammars are disjoint — a listener that received both on one event could not tell which space a subject belongs to. Listener failures are contained on the same terms as `credentials/reference-updated`.

```ts cordis-catalog
/**
 * Committed change to a stored credential record: a `modifyRecord` that
 * wrote, a `deleteRecord` that removed, or an external edit observed in
 * storage. Separate from `credentials/reference-updated` because the two key
 * grammars are disjoint — a listener that received both on one event could
 * not tell which space a subject belongs to. Listener failures are
 * contained on the same terms as `credentials/reference-updated`.
 * @param key - the record whose stored value changed.
 * @mode emit
 */
'credentials/record-updated'(key: CredentialKey): void
```

Source: [`packages/credentials/credentials/src/types.ts`](../../packages/credentials/credentials/src/types.ts)

<a id="credentialsreference-updated--emit"></a>

#### `credentials/reference-updated` — emit

Committed change to a provider-managed credential source: a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Listener failures are contained and logged — a sync throw and an async rejection alike — without changing the committed operation's outcome.

```ts cordis-catalog
/**
 * Committed change to a provider-managed credential source: a `set`, an
 * `unset`, or an external edit observed in storage. Ambient
 * process-environment changes are not observable and never emit. Listener
 * failures are contained and logged — a sync throw and an async rejection
 * alike — without changing the committed operation's outcome.
 * @param ref - the reference whose stored value changed.
 * @mode emit
 */
'credentials/reference-updated'(ref: CredentialRef): void
```

Source: [`packages/credentials/credentials/src/types.ts`](../../packages/credentials/credentials/src/types.ts)

<a id="deepseek-account-events"></a>

### `deepseek-account/*` events

<a id="deepseek-accountmodel-sign-in-required--emit"></a>

#### `deepseek-account/model-sign-in-required` — emit

An account model request requires the user to sign in.

```ts cordis-catalog
/** An account model request requires the user to sign in.
 * @mode emit
 */
'deepseek-account/model-sign-in-required'(): void
```

Source: [`packages/credentials/deepseek-account/src/types.ts`](../../packages/credentials/deepseek-account/src/types.ts)

<a id="deepseek-accountsession-expired--emit"></a>

#### `deepseek-account/session-expired` — emit

Server rejection removed the current account credential; this notification is not replayed.

```ts cordis-catalog
/** Server rejection removed the current account credential; this notification is not replayed.
 * @mode emit
 */
'deepseek-account/session-expired'(): void
```

Source: [`packages/credentials/deepseek-account/src/types.ts`](../../packages/credentials/deepseek-account/src/types.ts)

<a id="deepseek-accountsigned-out--emit"></a>

#### `deepseek-account/signed-out` — emit

Local grant removal has completed.

```ts cordis-catalog
/** Local grant removal has completed.
 * @mode emit
 */
'deepseek-account/signed-out'(): void
```

Source: [`packages/credentials/deepseek-account/src/index.ts`](../../packages/credentials/deepseek-account/src/index.ts)
<!-- END GENERATED cordis-surface -->

账号服务定义提供 getState、getProfile、getBalance、getNotifications、getNotificationContent、reportNotificationEvent、startSignIn、cancelSignIn、signOut、watch 及仅限 Host 的 resolveToken 和 getPlatformSession。平台提供者使用 AuthorizationFlow 和私有 GrantRecord 实现这些操作。AccountView 区分本地存在与服务器验证；尝试 ID 将取消绑定到单次本地流程。AccountUpdate 的 state 携带完整 AccountView，type 为 snapshot 时表示首次或进度更新，为 credentials-changed 时表示凭据写入或删除。待发送的凭据变化优先于进度更新。参见[账号包](../../packages/credentials/deepseek-account/README.zh.md)。

`AccountClientMetadata` 携带调用方 `DSH_CLIENT_VERSION` 提供的 `version`、当前界面 `locale`，以及操作发起时采样的 `timezoneOffsetSeconds`。偏移为本地时间减 UTC 的秒数：UTC+8 对应 `28800`。其中不含凭证。登录申请在兑换及取消期间保留发起时的元数据；退出操作为撤销重试保留其元数据。
