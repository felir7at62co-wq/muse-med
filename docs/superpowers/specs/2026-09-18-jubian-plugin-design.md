# Jubian tool plugin design

English | [中文](2026-09-18-jubian-plugin-design.zh.md)

- Date: 2026-09-18
- Status: pending review
- Scope: `packages/jubian/*` (new). **This round changes no code in `packages/bundle/muse-product`.**

## 1. Background and goals

Jubian (`web.jubianai.net`) is the only multimedia generation backend behind the MUSE short-drama product. Today it exists in exactly two forms:

1. roughly 3000 lines of adapter code interwoven with the MUSE governance layer (`packages/bundle/muse-product/src/jubian-*.ts`, 20 files, 3434 lines), most of which depends on MUSE-specific machinery such as Task admission, leases, receipts, and quotes;
2. a Python CLI (`jubianai-api/scripts/jubianai_api.py`, about 203 KB) that **product code never calls**, pinned by hash as archived knowledge only.

The consequence: no DSH session outside MUSE can query or operate a Jubian project.

**Goal**: turn every Jubian HTTP capability into one DSH plugin package, so that mounting it in any DSH mode is enough to query and operate Jubian, with the credential, the error semantics, and the audit standard defined in one place.

**Non-goals** (explicitly out of scope this round):

- do not modify or refactor MUSE; do not let MUSE depend on the new packages;
- do not provide compatibility commands for the old CLI (`create-video`, `submit-video-task`, or a direct `POST /admin/aigc/video/task/create`);
- do not support multiple accounts;
- do not cap spending (write tools work out of the box; whether to cap them is a separate later decision).

## 2. Package structure

Following the repository's existing convention: the directory is `packages/<group>/<name>` and the package name is `@deepseek-ai/dsh-<name>` (matching the 23 packages under `packages/tool-*`).

```
packages/jubian/
  jubian/         @deepseek-ai/dsh-jubian        纯库：HTTP 客户端、信封校验、稳定错误码、幂等账本
  jubian-api/     @deepseek-ai/dsh-jubian-api    类型化端点读写器（21 个端点）+ 业务字段解析
  tool-jubian/    @deepseek-ai/dsh-tool-jubian   Cordis 插件（Host 半）：注册 4 个工具、解析凭证
  client-jubian/  @deepseek-ai/dsh-client-jubian 设置页那一格：粘贴 token（Client 半，第 10 节阶段 4 才做）
```

The dependency direction is one-way, `jubian ← jubian-api ← tool-jubian`, and **not one edge points at MUSE**.

- `jubian` and `jubian-api` are pure libraries: they register no tool and consume no Cordis service, and vitest unit-tests them directly (the same shape as `dsh-skill` and `dsh-llm`).
- `tool-jubian` is a Host plugin row that any preset can mount with one line.
- `client-jubian` is the browser half, following the repository's existing convention that **a client interface is its own package** (as in `packages/client/ui-settings-plugin-inventory` and `packages/client/ui-settings-models`), because it needs its own client bundling configuration. It owns only the token-writing cell and does not affect whether the tools work: without it the tools still read and write, there is just no paste interface.

## 3. Endpoint inventory (21)

Statically extracted from product code; the citations are files and line numbers under `packages/bundle/muse-product/src/`.

### 3.1 Reads (17)

| Endpoint | Source |
|---|---|
| `GET /model/charge/getSelectList?taskType=1\|2\|10` | `jubian-catalog.ts:62,198` |
| `GET /model/charge/{standardId}` | `jubian-catalog.ts:75,99,204` |
| `GET /aigc/script/{scriptId}` | `jubian-catalog.ts:173` |
| `GET /aigc/episode/list?scriptId=&pageNum=&pageSize=` | `jubian-catalog.ts:132` |
| `GET /aigc/asset/{assetId}` | `jubian-asset-reader.ts:772,807,823,862` |
| `GET /aigc/asset/list?scriptId=&pageNum=&pageSize=` | `jubian-asset-reader.ts:452` |
| `GET /aigc/material/list?scriptId=&isUsed=1&pageNum=1&pageSize=1000` | `jubian-asset-reader.ts:775` |
| `GET /aigc/material/getGeneratedImageByAssetId?assetId=` | `jubian-asset-reader.ts:871` |
| `GET /aigc/storyboard/{storyboardId}` | `jubian-asset-reader.ts:428` |
| `GET /admin/aigc/video/task/{taskId}` | `jubian-asset-reader.ts:161,242,554,925` |
| `GET /admin/aigc/video/task/list?scriptId=&taskType=1&pageNum=` | `jubian-asset-reader.ts:491` |
| `POST /admin/aigc/video/task/sub/list` (query body `{aigcVideoTaskId}`, **read-only semantics**) | `jubian-asset-reader.ts:166,245,509,556,654` |

> Note: item 12 is a read endpoint whose verb is POST, because its query body carries `aigcVideoTaskId`. The tool layer must label it read-only.

**These 17 read endpoints are enough to reconstruct a Jubian project whole**: `script → episode/list → asset/list → material/list` (including `isLocal` and `hsAssetStatus`) `→ storyboard → video/task(+sub/list)`. Query capability depends on no MUSE machinery.

### 3.2 Writes (4)

| Endpoint | Verb | Source | Nature |
|---|---|---|---|
| `/aigc/asset` | POST (no parent) / PUT (with parent) | `jubian-image-sender.ts:88` | **Billable**: generation or regeneration of one image |
| `/aigc/storyboard` | POST to create / PUT to save | `jubian-storyboard-save.ts:99` | A PUT with `isGenerate:0` is free; `:1` is **billable** |
| `/aigc/storyboard/subtitleEraser` | POST | `jubian-storyboard-save.ts:99` | **Billable**: the subtitle erasure task |
| `/aigc/material/confirm/{materialId}` | **GET** | `jubian-casting.ts:33` | **Write · side-effecting GET** (confirm casting) |

> The last item is the only place in the repository where a read verb does a write. The tool description must state "do not retry" explicitly, or any idempotency framework will misjudge it.

## 4. Tool surface (4 tools / 21 methods)

Group by domain, not one tool per endpoint. The reason: tool schemas sit permanently in the request prefix, so the number of tools and the size of their parameter tables multiply per-turn token cost directly, and any change breaks the KV cache (`packages/bundle/muse-product/README.md:61-67`).

| Tool | Method | Endpoint | Billing label |
|---|---|---|---|
| `jubian_catalog` | `models` | getSelectList | read-only |
| | `rate` | model/charge/{id} | read-only |
| | `script` | aigc/script/{id} | read-only |
| | `episodes` | aigc/episode/list | read-only |
| `jubian_asset` | `get` | aigc/asset/{id} | read-only |
| | `list` | aigc/asset/list | read-only |
| | `materials` | aigc/material/list | read-only |
| | `generated_image` | material/getGeneratedImageByAssetId | read-only |
| | `confirm_casting` | material/confirm/{id} | **write · side-effecting GET** |
| `jubian_storyboard` | `get` | aigc/storyboard/{id} | read-only |
| | `create` | storyboard POST | write · free |
| | `save` | storyboard PUT (`isGenerate:0`) | write · free |
| | `generate` | storyboard PUT (`isGenerate:1`) | **billable · irreversible** |
| | `erase_subtitle` | storyboard/subtitleEraser | **billable** |
| `jubian_video` | `task` | video/task/{id} | read-only |
| | `tasks` | video/task/list | read-only |
| | `subtasks` | video/task/sub/list | read-only (verb is POST) |
| | `image_generate` | aigc/asset POST/PUT | **billable · irreversible** |

**Billing and side effects must be written into the tool description itself** — the model reads the description, not the source. At minimum it must cover:

- `generate` / `erase_subtitle` / `image_generate`: these charge real money, cannot be undone, and must not be retried blindly after a timeout;
- `confirm_casting`: a GET verb that has a side effect;
- `subtasks`: a POST verb that only reads.

Write methods are registered by default and work out of the box (exactly like reads), with no `writes` switch.

### 4.1 Pending mapping (to settle first in implementation)

The **input shape** of the following methods has not been extracted from product code in full; the spec pins only their source and their semantic boundary, and the source code is authoritative at implementation time:

| Method | Input source | Known constraints |
|---|---|---|
| `image_generate` | `jubian-image-request.ts:buildJubianImageRequest` | POST without a parent / PUT with one; request body ≤ 1 MiB; the token carries no whitespace |
| `storyboard.create` / `save` | `storyboard-save-payload.ts:buildStoryboardCreatePayload` / `buildStoryboardSavePayload` | request body ≤ 8 MiB; the `save` payload's `isGenerate` must be 0 |
| `storyboard.generate` | `storyboard-save-payload.ts:buildStoryboardGenerationPayload` | a saved `isGenerate:0` storyboard must already exist; `contentDurationMs` is a whole number of seconds from 4000 to 14000 |
| `erase_subtitle` | `jubian-subtitle-request.ts:buildJubianSubtitleRequest` | needs the decoded frame geometry and the approved pixel region |
| `confirm_casting` | `jubian-casting.ts` | `materialId` must match `^[1-9][0-9]*$`, and must be a generated material id, never a parent asset or an asynchronous task id |

## 5. Credential

**Ownership**: the key belongs to the plugin, the value belongs to the host. No package contains a secret.

| Item | Location |
|---|---|
| Key name (sole authority) | `JUBIANAI_ADMIN_TOKEN`, defined and exported by `tool-jubian` |
| Value store | `$DSH_HOME/.credentials.yaml`, read and written through the `credentials` service |
| Write interface | `tool-jubian` provides one "剧变" page in `settings.section`; `credentials.describe([ref])` reads the status and `credentials.set(ref, value)` writes it (following the existing practice in `packages/client/ui-settings-models/src/client/operations.ts:85,89`) |
| Environment override | `JUBIANAI_ADMIN_TOKEN`, for CI and containers |

**Credential precedence** (`packages/credentials/credentials-local/src/index.ts:5-10`):

```
继承的进程环境（只读，最高）
> $DSH_HOME/.credentials.yaml（provider 管理，可写）
> <启动目录>/.env
> $DSH_HOME/.env
```

The process environment wins, so `JUBIANAI_ADMIN_TOKEN=… dsh` overrides the settings page and makes it display as read-only. That is the intent, and the documentation must say so, to avoid the misjudgement that "my change had no effect".

**Forbidden**: any practice that copies `.credentials.yaml` or a plaintext token into `packages/jubian/`. That file is currently untracked by git, and once it enters a package it leaks with the checkout, whose remote is `deepseek-ai/deepseek-harness`.

**Token boundary repair**: follow the semantics of `jubian-credential.ts:12-23` — strip leading and trailing whitespace, one shell separator (`;`/`&`), and one pair of matching quotes; if whitespace remains inside the value, fail locally with `AUTHENTICATION_REQUIRED`, sending no request, recording nothing, and echoing nothing.

## 6. Idempotency ledger

It has exactly one purpose: when the network times out or a response is ambiguous, establish whether "this one actually went out" instead of guessing.

The record of every write method:

| Field | Meaning |
|---|---|
| `record_id` | `req_` + a monotonic ID |
| `at` | the timestamp before the request leaves |
| `method` | the tool method name |
| `idempotency_key` | **supplied by the caller through the tool input, required**; absent means `INVALID_ARGUMENT` and it is never generated for the caller (see below) |
| `request_sha256` | canonicalized hash of the request body |
| `quoted_amount` / `quote_standard_id` / `quote_observed_at` | the quote snapshot taken before the request leaves (when one is available) |
| `http_status` / `application_code` / `response_sha256` | filled in after the request returns; unfilled means unknown |
| `outcome` | `accepted` = HTTP 2xx with `application_code` 0 or 200; everything else (including timeouts, exceptions, and non-success codes) is `unknown` |

Implementation requirements:

- **`idempotency_key` is required and is never generated for the caller.** Its only purpose is to let the caller resend safely after a timeout. If the plugin generated one when it was missing, the resend would get a new key and bypass the existing record — precisely what this mechanism exists to prevent. A missing key is therefore an error, not a convenience.
- A repeated call with the same key **does not resend**; it returns the existing record directly and marks the result `replayed: true`.
- **Write one record before the request leaves and fill in the second after it returns**; a record left with only its first half by a crash or timeout is the unknown state, open to query and reconciliation;
- **never retry a write request automatically.** The caller alone decides after seeing the record left in the unknown state;
- Storage: NDJSON append-only, sharded by day, under `$DSH_HOME/jubian/ledger/` (path configurable).

## 7. Error handling

Five stable error codes, fully isolated from the remote response body, the remote message, and the token (`jubian-catalog.ts:8-17,239-243,265-267`):

| Code | Trigger |
|---|---|
| `AUTHENTICATION_REQUIRED` | no token / interior whitespace in the token / HTTP 401 or 403 / envelope code 401 or 403 |
| `PERMISSION_DENIED` | envelope code 403 while HTTP is 2xx (an HTTP-layer 403 always maps to `AUTHENTICATION_REQUIRED`) |
| `RATE_LIMITED` | HTTP 429 / envelope code 429 |
| `CONTRACT_CHANGED` | the response is not a JSON object, is not strictly UTF-8, exceeds the byte cap, or has an unexpected envelope shape |
| `NETWORK_ERROR` | connection failure, timeout, refused redirect, or any other non-2xx |

**One historical inconsistency, now resolved**: product code handles HTTP 403 two ways — `jubian-catalog.ts:241` maps it to `PERMISSION_DENIED` and `jubian-asset-reader.ts:306` maps it to `AUTHENTICATION_REQUIRED`. This design adopts the latter uniformly: at the HTTP layer both 401 and 403 mean "this token is unusable", and `PERMISSION_DENIED` arises only from `code: 403` inside the envelope (HTTP 2xx but rejected by the application layer). Implementation and tests follow that, and do not re-derive it.

The tool layer turns an error code into readable text for the model and **never carries the remote response body**.

## 8. HTTP client contract

```ts
class JubianClient {
  constructor(options: {
    credential: () => Promise<string>   // 注入式；tool-jubian 注 credentials，测试注固定值
    baseUrl?: string                    // 默认 https://web.jubianai.net/prod-api
    timeoutMs?: number                  // 默认 30000，上限 60000
    maxResponseBytes?: number           // 默认 2 MiB，上限 32 MiB
    ledger?: JubianLedger               // 省略即不记账（纯读场景）
  })
  request(input: {
    method: 'GET' | 'POST' | 'PUT'
    path: string
    body?: JsonObject
    signal?: AbortSignal
  }): Promise<{
    transport: { http_status: number | null; application_code: number | null }
    response_sha256: string | null
    data: unknown                       // 已通过信封与 code 校验后的 data
  }>
}
```

Fixed behavior (aligned item by item with the existing product implementation):

- a fixed origin, `redirect: 'error'`, a single attempt, and **no retry**;
- the timeout combines `AbortSignal.timeout` with that call's own signal;
- read as a stream and truncate at `maxResponseBytes`, reporting `CONTRACT_CHANGED` when the cap is exceeded;
- strict UTF-8 decoding (`fatal: true`), the payload must be a JSON object, and `code` must be 0 or 200;
- both `code === 0` and `200` count as success (the remote has produced both).

**No logic that reads a business field by name may appear in `jubian` or `jubian-api`** — only envelope shape checks; business-field parsing stays in each reader inside `jubian-api`, so a field the provider adds upstream cannot make a tool fail.

## 9. Tests

- Unit: every boundary of `trimBearerToken` / `isUsableBearerToken`; the envelope and error-code mapping; idempotency-key computation and the ledger's append-then-fill.
- Contract: pin each reader's field parsing with recorded response samples; a new sample is a new case.
- Network: every test runs through an injected `fetch` double; **the default suite sends no real network request**.
- Write path: verify a real submission with one explicit, manually enabled opt-in case (skipped by default).

## 10. Implementation order

1. `packages/jubian/jubian` + `packages/jubian/jubian-api`: the client, the error codes, the ledger, and credential repair; wire up only `/model/charge/getSelectList` first and use it to verify the login state and the envelope.
2. `packages/jubian/tool-jubian`: register the 4 tools, **registering read methods only at this stage** (12 of the 17 read endpoints).
3. Land the write methods one by one, each of which must have the ledger first: `image_generate` → `storyboard.create`/`save` → `generate` → `erase_subtitle` → `confirm_casting`.
   - Why that order: from "most like an ordinary POST" to "a GET with a side effect" risk rises, and the earlier stages build the credibility of the ledger and the error handling for the later ones.
4. `packages/jubian/client-jubian`: the token-writing interface in that one settings-page cell.
   - Optional. Everything works without it (an environment variable, or editing `.credentials.yaml` directly), but only with it is the package "mount it and go".
5. Documentation: `packages/jubian/tool-jubian/README.md` records the endpoint table, the billing labels, the credential precedence, and the ledger location.

**Once stages 1–3 ship, any DSH mode can read and write Jubian**; stage 4 only removes the friction of first-time configuration.

## 11. Risks

1. **A third-party implementation with no official documentation.** The response shapes of `web.jubianai.net` may change, and every shape here is inferred backwards from product code and the archived `references/api-contract.md`. Mitigation: layer the envelope apart from business parsing (end of section 8).
2. **Static extraction is not runtime verification.** The inventory in section 3 comes from code and no endpoint was checked by issuing a real request. Mitigation: implementation step 1 verifies the login state and the envelope with one read-only endpoint, then confirms the rest one by one.
3. **The input shape of the write methods is not fully extracted** (section 4.1). That is the first task of implementation, not a detail that can be skipped.
4. **`isGenerate` is coupled to billing.** The same `/aigc/storyboard` PUT is free with `:0` and billable with `:1`, so the tool layer must split the two into two methods and must not merge them into one method with a boolean parameter.
5. **The credential precedence silently overrides the settings page** (section 5).
