# 人物参考库

[English](character-library.md) | 中文

Host 管理的[人物库](../../packages/drama/character-library/README.zh.md)通过对象存储服务读取历史人物参考。[TOS 提供方](../../packages/drama/character-library-tos/README.zh.md)使用 Host 凭据引用，从固定前缀执行有界读取。[模型工具](../../packages/drama/tool-character-reference/README.zh.md)检索候选并将校验后的图片加入会话；它们不审批、上传、绑定或生成资产。

对于已登录用户本人委托生成并上传的图片，独立的剧变工具可直接询问该用户来源及本项目参考生图权利。Host 在签发一次项目私有授权、托管上传精确字节并允许预算内生图前，重读项目、角色、Catalog 身份与 SHA。这不是公共库审核：`pending_review` 不变，原图与衍生图不能自动确认出演、正式绑定、发布或供其他用户、项目复用。付费结果未知时仍只能用原幂等键对账。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcharacterlibrary--characterlibrary"></a>

### `ctx.characterLibrary` — `CharacterLibrary`

Host domain service. The store provider owns credentials and all network behavior.

```ts cordis-catalog
/**
 * Report the mounted service boundary without doing object-store IO.
 * @returns Read and pending-ingest readiness for the mounted provider.
 */
status(): CharacterLibraryStatus

/**
 * List and adapt a bounded set of catalog metadata records.
 * @param request - Collection, filter, page size, and optional cursor.
 * @param signal - Optional cancellation signal.
 * @returns A bounded page of catalog entries and its continuation cursor.
 */
async browse( request: CharacterLibraryBrowseRequest = {}, signal?: AbortSignal, ): Promise<CharacterLibraryBrowseResult>

/**
 * Resolve one stable catalog identity without reading its image.
 * @param request - Stable catalog asset identity to resolve.
 * @param signal - Optional cancellation signal.
 * @returns The adapted catalog entry.
 */
async detail( request: CharacterLibraryDetailRequest, signal?: AbortSignal, ): Promise<CharacterLibraryEntry>

/**
 * Read and verify one bounded image preview entirely in memory.
 * @param request - Catalog identity and optional image byte bound.
 * @param signal - Optional cancellation signal.
 * @returns Verified raster bytes with their measured identity.
 */
async preview( request: CharacterLibraryPreviewRequest, signal?: AbortSignal, ): Promise<CharacterLibraryPreview>

/**
 * Select one best read-only reference or require review for an exact top-score tie.
 * @param request - Bounded role and appearance requirements.
 * @param signal - Optional cancellation signal.
 * @returns A recommendation, review request, or no-match result without use permission.
 */
async recommend( request: CharacterRecommendationRequest, signal?: AbortSignal, ): Promise<CharacterRecommendationResult>

/**
 * Rank at most three metadata matches and measure their original-image digests.
 * @param request - Bounded role and appearance requirements.
 * @param signal - Optional cancellation signal.
 * @returns Verified image identities for visual selection, without use permission.
 */
async matchCandidates( request: CharacterRecommendationRequest, signal?: AbortSignal, ): Promise<CharacterMatchResult>
```

Source: [`packages/drama/character-library/src/library.ts`](../../packages/drama/character-library/src/library.ts)

<a id="ctxcharacterlibraryobjectstore--characterlibraryobjectstore-abstract-seam"></a>

### `ctx.characterLibraryObjectStore` — `CharacterLibraryObjectStore` (abstract seam)

Least-capability object store. It deliberately has no delete, copy, ACL, policy or presigned-URL operation.

```ts cordis-catalog
/**
 * Report deployment readiness without constructing an SDK client or doing network IO.
 * @returns The provider's read and write readiness flags.
 */
abstract status(): CharacterLibraryObjectStoreStatus

/**
 * List one bounded page below a fixed reviewed prefix.
 * @param request - Prefix, cursor, and page bound.
 * @param signal - Optional cancellation signal.
 * @returns A page of object descriptors and continuation cursor.
 */
abstract list( request: CharacterLibraryObjectListRequest, signal?: AbortSignal, ): Promise<CharacterLibraryObjectListPage>

/**
 * Read metadata without fetching the object body.
 * @param key - Object key to inspect.
 * @param signal - Optional cancellation signal.
 * @returns Object metadata, or null when absent.
 */
abstract head(key: string, signal?: AbortSignal): Promise<CharacterLibraryObjectHead | null>

/**
 * Read at most maxBytes into memory; providers enforce the bound before or during transfer.
 * @param key - Object key to read.
 * @param maxBytes - Maximum accepted object body length.
 * @param signal - Optional cancellation signal.
 * @returns The bounded object body and provider metadata.
 */
abstract get(key: string, maxBytes: number, signal?: AbortSignal): Promise<CharacterLibraryObjectGet>
```

Source: [`packages/drama/character-library/src/store.ts`](../../packages/drama/character-library/src/store.ts)

<a id="ctxcharacterreferenceauthority--characterreferenceauthority"></a>

### `ctx.characterReferenceAuthority` — `CharacterReferenceAuthority`

Host-only current-project and image identity reader; use authorization is separate.

```ts cordis-catalog
/**
 * Re-read the current project and candidate bytes, rejecting any changed identity.
 * @param session - Current Agent Session whose Host-owned project binding is authoritative.
 * @param request - Expected project, character, Catalog, and image identities.
 * @param signal - Optional execution cancellation.
 * @returns Verified project identity, role, image status, content type, digest, and bytes.
 */
read( session: Session, request: CharacterReferenceAuthorityRequest, signal?: AbortSignal, ): Promise<AuthoritativeCharacterReference>
```

Types: [Session](session.zh.md)

Source: [`packages/drama/tool-character-reference/src/authority.ts`](../../packages/drama/tool-character-reference/src/authority.ts)
<!-- END GENERATED cordis-surface -->
