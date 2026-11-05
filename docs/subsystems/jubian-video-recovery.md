# Jubian video recovery

English | [中文](jubian-video-recovery.zh.md)

The [Jubian tools package](../../packages/jubian/tool-jubian/README.md) records review decisions for recovered project media and exposes their delivery status. Desktop Host providers use approved media to create editor drafts or render an episode from its authored plan.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxapprovedclipdraft--approvedclipdraftservice"></a>

### `ctx.approvedClipDraft` — `ApprovedClipDraftService`

Host provider for creating editable local drafts from approved media.

```ts cordis-catalog
/**
 * Create or recover the editor draft for the supplied reviewed media.
 * @param input - Selected project, absolute media path, exact SHA-256 and task ID.
 * @param signal - Cancellation of local draft generation.
 * @returns The saved editor draft identity and open verification.
 */
create(input: { projectDir: string; path: string; sha256: string; taskId: number; subtitlePath?: string }, signal?: AbortSignal): Promise<{ path: string; name: string; editorOpenVerified: boolean }>

/**
 * Render the verified draft to a new local MP4.
 * @param input - Exact draft identity and absolute output path.
 * @param signal - Cancellation of editor automation.
 * @returns The completed export path.
 */
export?(input: { draftName: string; draftPath: string; outputPath: string }, signal?: AbortSignal): Promise<{ path: string }>
```

Source: [`packages/jubian/tool-jubian/src/types.ts`](../../packages/jubian/tool-jubian/src/types.ts)

<a id="ctxapprovedepisoderenderer--approvedepisoderenderer"></a>

### `ctx.approvedEpisodeRenderer` — `ApprovedEpisodeRenderer`

Host renderer that composes a project-authored episode from approved clips.

```ts cordis-catalog
/**
 * Render and inspect an episode using the current deployment's media tools.
 * @param input - Approved sources and explicit project-owned editing inputs.
 * @param signal - Cancellation of rendering and verification.
 * @returns Render measurements and checks from the episode renderer.
 */
render(input: { readonly projectDir: string readonly episode: number readonly clips: readonly { readonly shot: number; readonly path: string; readonly sha256: string }[] readonly timelinePath: string readonly subtitlePath: string readonly mixProfilePath: string readonly bgmPath?: string readonly inputHashes: ApprovedEpisodeInputHashes /** Absolute private candidate path. The renderer must not replace an existing file. */ readonly outputPath: string }, signal: AbortSignal): Promise<{ readonly durationSeconds: number readonly checks: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[] }>
```

Source: [`packages/jubian/tool-jubian/src/types.ts`](../../packages/jubian/tool-jubian/src/types.ts)

<a id="ctxjubianvideorecovery--jubianvideorecovery"></a>

### `ctx.jubianVideoRecovery` — `JubianVideoRecovery`

Project recovery settings and explicit human decisions over the authenticated Gateway.

```ts cordis-catalog
/**
 * Read the saved switch and reports belonging to the selected project.
 * @returns The current settings and report rows without provider URLs or credentials.
 */
@Remote async status(): Promise<VideoRecoveryStatus>

/**
 * Save the local operator's choice and switch the background worker.
 * @param input - Switch value and, when changing it, the absolute project directory.
 * @returns The persisted configuration and the newly selected project's reports.
 */
@Remote async configure(input: VideoRecoveryConfigurationInput): Promise<VideoRecoveryStatus>

/**
 * Read a report, record a decision, or reopen a rejected artifact for one more review.
 * @param input - Recorded submission key and the exact digest for any change.
 * @returns The current report, its durable decision and any earlier rejection.
 */
@Remote async review(input: VideoRecoveryReviewInput): Promise<VideoRecoveryReview>

/**
 * Capture and decode one local derivative before making it the review target.
 * @param input - Submission key, current digest and project-relative MP4 path.
 * @returns The active derivative, decoder results and updated review digest.
 */
@Remote async adopt(input: VideoRecoveryAdoptionInput): Promise<VideoRecoveryReview>

/**
 * Publish the exact approved MP4 as a project export without an editor.
 * @param input - Submission key and its approved review digest.
 * @returns The report with the direct delivery receipt.
 */
@Remote async deliverApprovedMp4(input: ApprovedClipDeliveryInput): Promise<VideoRecoveryReview>

/**
 * Render and verify the selected episode from its exact approved report set.
 * @param input - Episode number and the current authored plan digest.
 * @returns The durable project-relative MP4 receipt.
 */
@Remote async deliverApprovedEpisode(input: { episode: number; digest: string }): Promise<ApprovedEpisodeDeliverySummary>

/**
 * Create the editor draft from the exact approved project artifact.
 * @param input - Submission key and its approved review digest.
 * @returns The report and saved draft identity.
 */
@Remote async createDraft(input: ApprovedClipDeliveryInput): Promise<VideoRecoveryReview>

/**
 * Create or reuse the approved draft, render a new MP4, and verify both tracks.
 * @param input - Submission key and exact approved review digest.
 * @returns The report with the new export and comparison scores.
 */
@Remote async deliverApprovedClip(input: ApprovedClipDeliveryInput): Promise<VideoRecoveryReview>

/**
 * Verify a local editor export against the artifact reviewed for the draft.
 * @param input - Submission key, approved digest and project-relative export path.
 * @returns The report with the export digest and comparison results.
 */
@Remote async verifyExport(input: VideoRecoveryAdoptionInput): Promise<VideoRecoveryReview>
```

Source: [`packages/jubian/tool-jubian/src/video-recovery-service.ts`](../../packages/jubian/tool-jubian/src/video-recovery-service.ts)
<!-- END GENERATED cordis-surface -->
