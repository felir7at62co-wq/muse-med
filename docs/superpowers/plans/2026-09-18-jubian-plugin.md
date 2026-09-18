# 剧变（Jubian）工具插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/jubian/` 下新增三个包，把剧变的 21 个 HTTP 端点变成任意 DSH 模式可用的工具，不触碰 MUSE 一行代码。

**Architecture:** 三层。`@deepseek-ai/dsh-jubian` 是纯库：凭证修复、稳定错误码、固定 origin 的一次性 HTTP 客户端、幂等账本。`@deepseek-ai/dsh-jubian-api` 在此之上做类型化端点读写器，业务字段解析全部集中在这里。`@deepseek-ai/dsh-tool-jubian` 是 Cordis Host 插件，注册 4 个工具、从 `credentials` 服务解析 `JUBIANAI_ADMIN_TOKEN`。

**Tech Stack:** TypeScript（Node ESM，`tsc -b` 出 `lib/types`，tsdown 打包到 `lib`）、Cordis 插件、vitest、`@deepseek-ai/schemastery`（z）。

**依据文档：** `docs/superpowers/specs/2026-09-18-jubian-plugin-design.md`

---

## 关键前置事实（已核实，不要重新推导）

| 事实 | 出处 |
|---|---|
| tsdown 自动发现 `packages/*/*`，无需登记 | `tsdown.config.ts:20-21` |
| 但 `tsc -b` 需要在 `tsconfig.host.json` 的 `references` 里**显式登记**每个包 | `tsconfig.json:11-14` → `tsconfig.host.json` references |
| 测试 glob `packages/*/*/tests/**/*.ts` 自动覆盖新包 | `tsconfig.host.json` include |
| 远端 origin 固定 `https://web.jubianai.net/prod-api` | `jubian-catalog.ts:233` 等四处 |
| 成功信封：HTTP 2xx 且 `code` 为 `0` 或 `200` | `jubian-catalog.ts:267`、`jubian-asset-reader.ts:327` |
| HTTP 401/403 → `AUTHENTICATION_REQUIRED`；`PERMISSION_DENIED` 只来自信封 `code:403` | spec §7（已裁定统一） |
| token 修复：去首尾空白、一个 `;`/`&`、一对成对引号；内部空白即本地失败 | `jubian-credential.ts:12-23` |
| 视频模型选择器：`doubao-seedance-2-0-*`、`genType=3`、`9:16`、`720p`、`duration = contentMs/1000 + 1` | `jubian-video-model.ts:16-32` |
| `contentDurationMs` 必须是 4000–14000 的整千毫秒 | `storyboard-video-config.ts:11-12` |
| `erase_subtitle` 只接受 `quzimuToB` 或 `ark-erase-video-subtitle-pro` | `jubian-subtitle-request.ts:48-49` |

## 实施中发现的仓库机制（计划初版遗漏，已在实施中修正）

1. **新包必须在 `tsconfig.base.json` 的生成段登记路径别名**，否则 vitest 会按包 `exports` 去找 `lib/index.js` 并失败。
   机制见 `vitest.config.ts:16-20`（"paths must win over package exports so built lib/ never loads a second module-singleton copy"）。
   **做法：跑 `pnpm run gen-tsconfig-paths`，不要手改生成段**（该脚本另有 `--check` 由 CI 校验）。
   别名从包目录名生成，所以 `packages/jubian/jubian` → `@deepseek-ai/dsh-jubian` 自动对上。
2. **`tsconfig.host.json` 的 references 要与包的创建同步登记**，不能一次登记三个：后两个包尚不存在时 `tsc -b` 会因找不到项目而失败。Task 1 只登记 `jubian/jubian`，Task 6 加 `jubian-api`，Task 11 加 `tool-jubian`。
3. **仓库禁用非空断言**（oxlint `typescript/no-non-null-assertion`）。"先检查 `length !== 1` 再用 `arr[0]!`" 这种写法会被 pre-commit 拦下。改写为显式取值：
   ```ts
   const first = matches.length === 1 ? matches[0] : undefined
   if (first === undefined) invalid()
   ```
4. **读取器的错误文案是英文**（`JubianError` 的固定 message），所以断言用 `toThrow()` 而不写英文正则；工具描述与用户可见文案才用中文。
5. **`JubianError` 的 message 由错误码决定**，计划里若有 `toThrow(/catalogue/i)` 之类的正则断言，一律简化为 `toThrow()`。

## 本轮明确不做

- 不改 `packages/bundle/muse-product` 任何文件；不让新包依赖 MUSE。
- 不做 `client-jubian`（token 写入界面）。凭证通过环境变量或直接编辑 `$DSH_HOME/.credentials.yaml` 提供。
- 不做多账号、不做消费配额封顶。
- 不移植 MUSE 的 Task 准入/租约/收据体系。

## 文件结构

```
packages/jubian/
  jubian/
    package.json                              @deepseek-ai/dsh-jubian
    tsconfig.json
    src/credential.ts                         JUBIAN_TOKEN_REF、trimBearerToken、isUsableBearerToken
    src/error.ts                              JubianError + 五个错误码 + 映射
    src/ledger.ts                             幂等账本（NDJSON 按日分片）
    src/client.ts                             JubianClient.request
    src/index.ts                              re-export
    tests/credential.spec.ts
    tests/error.spec.ts
    tests/ledger.spec.ts
    tests/client.spec.ts
  jubian-api/
    package.json                              @deepseek-ai/dsh-jubian-api
    tsconfig.json
    src/catalog.ts                            models/rate/script/episodes 读取器 + 模型解析
    src/asset.ts                              asset/material 读取器
    src/storyboard.ts                         storyboard 读取器 + save/generate 载荷变换
    src/video.ts                              video task/subtask 读取器
    src/subtitle.ts                           erase 请求体编译
    src/index.ts                              re-export
    tests/*.spec.ts
  tool-jubian/
    package.json                              @deepseek-ai/dsh-tool-jubian
    tsconfig.json
    src/index.ts                              Cordis 插件：inject + 4 个工具注册
    src/methods.ts                            21 个方法的实现（纯函数，便于单测）
    tests/tools.spec.ts
```

---

## Phase 1 — `@deepseek-ai/dsh-jubian` 基础库

### Task 1: 包骨架 + 凭证模块

**Files:**
- Create: `packages/jubian/jubian/package.json`
- Create: `packages/jubian/jubian/tsconfig.json`
- Create: `packages/jubian/jubian/src/credential.ts`
- Create: `packages/jubian/jubian/tests/credential.spec.ts`
- Modify: `tsconfig.host.json`（在 references 数组内按字母序插入）

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian/tests/credential.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { JUBIAN_TOKEN_REF, isUsableBearerToken, trimBearerToken } from '../src/credential.ts'

describe('trimBearerToken', () => {
  it('repairs the paste artifacts a shell or a form leaves behind', () => {
    expect(trimBearerToken('  eyJhbGciOi.payload.sig  ')).toBe('eyJhbGciOi.payload.sig')
    expect(trimBearerToken('export TOKEN=eyJhbGci.payload.sig;')).toBe('export TOKEN=eyJhbGci.payload.sig')
    expect(trimBearerToken('eyJhbGci.payload.sig;')).toBe('eyJhbGci.payload.sig')
    expect(trimBearerToken('eyJhbGci.payload.sig&')).toBe('eyJhbGci.payload.sig')
    expect(trimBearerToken('"eyJhbGci.payload.sig"')).toBe('eyJhbGci.payload.sig')
    expect(trimBearerToken("'eyJhbGci.payload.sig'")).toBe('eyJhbGci.payload.sig')
  })

  it('never rewrites the token itself', () => {
    expect(trimBearerToken('eyJhbGci.payload.sig')).toBe('eyJhbGci.payload.sig')
    // A single unmatched quote is part of the value, not a paste artifact.
    expect(trimBearerToken('"eyJhbGci.payload.sig')).toBe('"eyJhbGci.payload.sig')
  })
})

describe('isUsableBearerToken', () => {
  it('accepts a token without whitespace and rejects everything else', () => {
    expect(isUsableBearerToken('eyJhbGci.payload.sig')).toBe(true)
    expect(isUsableBearerToken('')).toBe(false)
    expect(isUsableBearerToken('eyJ hbGci.payload')).toBe(false)
    expect(isUsableBearerToken('eyJhbGci\npayload')).toBe(false)
  })
})

describe('JUBIAN_TOKEN_REF', () => {
  it('is the one key name this plugin owns', () => {
    expect(JUBIAN_TOKEN_REF).toBe('JUBIANAI_ADMIN_TOKEN')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian/tests/credential.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/credential.ts"`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian/src/credential.ts`:

```ts
/**
 * The one credential key this plugin owns, plus the boundary repair every
 * Jubian reader applies before a bearer header is built.
 *
 * A secret pasted from a shell keeps the shell's separator (`export X=...;`)
 * and a settings form may keep the quotes the operator copied with it. Both
 * are paste artifacts, never part of a token. Only the boundary is repaired
 * here; an interior space still fails as an authentication problem rather
 * than being sent to the provider.
 */

/** The credential reference this plugin reads and writes; the plugin owns this name. */
export const JUBIAN_TOKEN_REF = 'JUBIANAI_ADMIN_TOKEN'

/**
 * Remove the paste artifacts around one secret value.
 * @param value - Stored or pasted secret.
 * @returns The value with surrounding whitespace, one trailing shell separator and one matching quote pair removed.
 */
export function trimBearerToken(value: string): string {
  let candidate = value.trim()
  if (candidate.endsWith(';') || candidate.endsWith('&')) candidate = candidate.slice(0, -1).trim()
  const first = candidate[0], last = candidate.at(-1)
  if (candidate.length >= 2 && (first === '"' || first === "'") && last === first) candidate = candidate.slice(1, -1).trim()
  return candidate
}

/**
 * Whether a repaired value is still something a bearer header may carry.
 * @param value - Repaired secret.
 * @returns True when the value is non-empty and free of whitespace.
 */
export function isUsableBearerToken(value: string): boolean {
  return value.length > 0 && !/\s/.test(value)
}
```

Create `packages/jubian/jubian/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-jubian",
  "description": "Jubian HTTP client, credential repair, stable error codes and idempotency ledger for the DeepSeek Harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/dsh-credentials": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-credentials": "workspace:^"
  }
}
```

Create `packages/jubian/jubian/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../../credentials/credentials"
    }
  ]
}
```

Modify `tsconfig.host.json`: 在 `references` 数组里按现有字母序插入（`packages/jubian/*` 排在 `packages/job*`/`packages/llm/*` 之前，具体位置以文件当前顺序为准）：

```json
    { "path": "./packages/jubian/jubian" },
    { "path": "./packages/jubian/jubian-api" },
    { "path": "./packages/jubian/tool-jubian" },
```

- [ ] **Step 4: 安装 workspace 链接**

Run: `pnpm install --filter @deepseek-ai/dsh-jubian`
Expected: 无错误，`packages/jubian/jubian/node_modules` 出现。

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian/tests/credential.spec.ts`
Expected: PASS，6 个用例全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/jubian/jubian tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(jubian): scaffold jubian package with credential repair"
```

---

### Task 2: 稳定错误码

**Files:**
- Create: `packages/jubian/jubian/src/error.ts`
- Create: `packages/jubian/jubian/tests/error.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian/tests/error.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { JubianError, codeForHttpStatus, failureForEnvelopeCode } from '../src/error.ts'

describe('codeForHttpStatus', () => {
  it('treats both 401 and 403 as a token that cannot be used', () => {
    expect(codeForHttpStatus(401)).toBe('AUTHENTICATION_REQUIRED')
    expect(codeForHttpStatus(403)).toBe('AUTHENTICATION_REQUIRED')
  })

  it('separates rate limiting from other transport failures', () => {
    expect(codeForHttpStatus(429)).toBe('RATE_LIMITED')
    expect(codeForHttpStatus(500)).toBe('NETWORK_ERROR')
    expect(codeForHttpStatus(404)).toBe('NETWORK_ERROR')
  })
})

describe('failureForEnvelopeCode', () => {
  it('maps only the application-level rejections an envelope can carry', () => {
    expect(failureForEnvelopeCode(401)).toBe('AUTHENTICATION_REQUIRED')
    expect(failureForEnvelopeCode(403)).toBe('PERMISSION_DENIED')
    expect(failureForEnvelopeCode(429)).toBe('RATE_LIMITED')
  })

  it('returns null for the two success codes so callers keep the data', () => {
    expect(failureForEnvelopeCode(0)).toBeNull()
    expect(failureForEnvelopeCode(200)).toBeNull()
  })
})

describe('JubianError', () => {
  it('carries a stable code and a message that never contains a provider body', () => {
    const error = new JubianError('CONTRACT_CHANGED')
    expect(error.code).toBe('CONTRACT_CHANGED')
    expect(error.name).toBe('JubianError')
    expect(error.message).toBe('Jubian response did not match the expected envelope')
    expect(error.message).not.toContain('{')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian/tests/error.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/error.ts"`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian/src/error.ts`:

```ts
/**
 * The five stable failure codes every Jubian call can produce.
 *
 * No provider message, provider body or nested transport cause ever reaches a
 * caller: a tool renders these codes, so a remote error text can never be
 * echoed into a model's context or a log.
 */

/** Stable failure categories shared by every Jubian reader. */
export type JubianErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'CONTRACT_CHANGED'
  | 'NETWORK_ERROR'

const MESSAGES: Record<JubianErrorCode, string> = {
  AUTHENTICATION_REQUIRED: 'Jubian login is unavailable or expired',
  PERMISSION_DENIED: 'Jubian account cannot access this resource',
  RATE_LIMITED: 'Jubian rate limit reached',
  CONTRACT_CHANGED: 'Jubian response did not match the expected envelope',
  NETWORK_ERROR: 'Jubian request failed',
}

/** One Jubian failure, carrying only its stable code. */
export class JubianError extends Error {
  /** Stable category for callers and tool output. */
  readonly code: JubianErrorCode
  /**
   * @param code - Stable failure category.
   */
  constructor(code: JubianErrorCode) {
    super(MESSAGES[code])
    this.name = 'JubianError'
    this.code = code
  }
}

/**
 * Translate an HTTP status into the stable code for it.
 *
 * Both 401 and 403 mean "this token cannot be used": the product has two
 * historical behaviours here and this package settles on the stricter one, so
 * a caller never has to tell an expired token from a forbidden one.
 * @param status - Response status.
 * @returns The stable code for a non-2xx response.
 */
export function codeForHttpStatus(status: number): JubianErrorCode {
  if (status === 401 || status === 403) return 'AUTHENTICATION_REQUIRED'
  if (status === 429) return 'RATE_LIMITED'
  return 'NETWORK_ERROR'
}

/**
 * Translate an application envelope `code` into a failure, or null when it is a success code.
 * @param code - Numeric `code` field of a parsed envelope.
 * @returns The stable code, or null for the two success codes.
 */
export function failureForEnvelopeCode(code: number): JubianErrorCode | null {
  if (code === 0 || code === 200) return null
  if (code === 401) return 'AUTHENTICATION_REQUIRED'
  if (code === 403) return 'PERMISSION_DENIED'
  if (code === 429) return 'RATE_LIMITED'
  return 'CONTRACT_CHANGED'
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian/tests/error.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/jubian/src/error.ts packages/jubian/jubian/tests/error.spec.ts
git commit -m "feat(jubian): add stable error codes"
```

---

### Task 3: 幂等账本

**Files:**
- Create: `packages/jubian/jubian/src/ledger.ts`
- Create: `packages/jubian/jubian/tests/ledger.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian/tests/ledger.spec.ts`:

```ts
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JubianLedger } from '../src/ledger.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-ledger-')) })

describe('JubianLedger', () => {
  it('records the intent before the request leaves and settles it afterwards', async () => {
    const ledger = new JubianLedger({ root })
    const began = await ledger.begin({
      idempotencyKey: 'k-1', method: 'image_generate', requestSha256: 'sha256:' + 'a'.repeat(64),
      quotedAmount: '1.20', quoteStandardId: 42, quoteObservedAt: '2026-09-18T00:00:00.000Z',
    })
    expect(began.replayed).toBe(false)
    expect(began.record.at).toBeTruthy()
    expect(began.record.outcome).toBeNull()

    await ledger.settle('k-1', {
      httpStatus: 200, applicationCode: 200, responseSha256: 'sha256:' + 'b'.repeat(64), outcome: 'accepted',
    })
    const found = await ledger.find('k-1')
    expect(found?.outcome).toBe('accepted')
    expect(found?.http_status).toBe(200)
    expect(found?.response_sha256).toBe('sha256:' + 'b'.repeat(64))
  })

  it('replays an existing key instead of sending a second paid request', async () => {
    const ledger = new JubianLedger({ root })
    const input = { idempotencyKey: 'k-2', method: 'image_generate' as const,
      requestSha256: 'sha256:' + 'c'.repeat(64) }
    await ledger.begin(input)
    const again = await ledger.begin(input)
    expect(again.replayed).toBe(true)
  })

  it('leaves a begin-only record as the unknown state a timeout produces', async () => {
    const ledger = new JubianLedger({ root })
    await ledger.begin({ idempotencyKey: 'k-3', method: 'storyboard_generate' as const,
      requestSha256: 'sha256:' + 'd'.repeat(64) })
    const found = await ledger.find('k-3')
    expect(found?.outcome).toBeNull()
    expect(found?.http_status).toBeNull()
  })

  it('appends one NDJSON line per event and never rewrites an earlier line', async () => {
    const ledger = new JubianLedger({ root })
    await ledger.begin({ idempotencyKey: 'k-4', method: 'image_generate' as const,
      requestSha256: 'sha256:' + 'e'.repeat(64) })
    await ledger.settle('k-4', { httpStatus: 500, applicationCode: null, responseSha256: null, outcome: 'unknown' })
    const files = await ledger.files()
    expect(files.length).toBe(1)
    const lines = (await readFile(files[0]!, 'utf8')).trim().split('\n')
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!).phase).toBe('begin')
    expect(JSON.parse(lines[1]!).phase).toBe('settle')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian/tests/ledger.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/ledger.ts"`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian/src/ledger.ts`:

```ts
/**
 * The write-path ledger: one append-only NDJSON record per paid or
 * state-changing call, written in two phases.
 *
 * The intent line lands before the request leaves; the settle line lands
 * after the response is read. A record with an intent and no settle line is
 * exactly the unknown state a timeout produces, and it is the only way to
 * answer "did that charge actually happen?" without guessing. A repeated
 * idempotency key never sends a second request.
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The write methods this ledger can record. */
export type JubianLedgerMethod =
  | 'image_generate'
  | 'storyboard_save'
  | 'storyboard_create'
  | 'storyboard_generate'
  | 'erase_subtitle'
  | 'confirm_casting'

/** A durable record of one write attempt. */
export interface JubianLedgerRecord {
  /** Monotonic per-process record identity. */
  record_id: string
  /** Set on the intent line; the settle line repeats it. */
  idempotency_key: string
  /** Tool method that produced this attempt. */
  method: JubianLedgerMethod
  /** ISO timestamp of the intent line. */
  at: string
  /** Canonical hash of the request body. */
  request_sha256: string
  /** Quoted amount observed before the request, when one was available. */
  quoted_amount: string | null
  /** Catalogue standard the quote came from. */
  quote_standard_id: number | null
  /** When the quote was observed. */
  quote_observed_at: string | null
  /** Response status, filled by the settle line. */
  http_status: number | null
  /** Application envelope code, filled by the settle line. */
  application_code: number | null
  /** Response body hash, filled by the settle line. */
  response_sha256: string | null
  /** `accepted` only for HTTP 2xx with an application code of 0 or 200; otherwise `unknown`, or null before settling. */
  outcome: 'accepted' | 'unknown' | null
}

/** What one `begin` call needs. */
export interface JubianLedgerBegin {
  idempotencyKey: string
  method: JubianLedgerMethod
  requestSha256: string
  quotedAmount?: string
  quoteStandardId?: number
  quoteObservedAt?: string
}

/** What one `settle` call records. */
export interface JubianLedgerSettlement {
  httpStatus: number | null
  applicationCode: number | null
  responseSha256: string | null
  outcome: 'accepted' | 'unknown'
}

/** The verdict of a `begin`: a fresh intent, or an existing record that must not be re-sent. */
export interface JubianLedgerBeginResult {
  replayed: boolean
  record: JubianLedgerRecord
}

export interface JubianLedgerOptions {
  /** Directory holding the per-day NDJSON files. */
  root: string
}

/**
 * Read one record out of the two lines that describe it.
 * @param lines - Parsed NDJSON lines in append order.
 * @returns The merged record, or undefined when no intent line exists.
 */
function fold(lines: Record<string, unknown>[]): JubianLedgerRecord | undefined {
  let record: JubianLedgerRecord | undefined
  for (const line of lines) {
    if (line.phase === 'begin') {
      record = {
        record_id: String(line.record_id), idempotency_key: String(line.idempotency_key),
        method: line.method as JubianLedgerMethod, at: String(line.at), request_sha256: String(line.request_sha256),
        quoted_amount: (line.quoted_amount as string | null) ?? null,
        quote_standard_id: (line.quote_standard_id as number | null) ?? null,
        quote_observed_at: (line.quote_observed_at as string | null) ?? null,
        http_status: null, application_code: null, response_sha256: null, outcome: null,
      }
    } else if (line.phase === 'settle' && record !== undefined && record.idempotency_key === line.idempotency_key) {
      record = { ...record, http_status: line.http_status as number | null,
        application_code: line.application_code as number | null,
        response_sha256: line.response_sha256 as string | null, outcome: line.outcome as 'accepted' | 'unknown' }
    }
  }
  return record
}

/** Append-only, two-phase ledger for paid and state-changing Jubian calls. */
export class JubianLedger {
  private readonly root: string
  private counter = 0

  constructor(options: JubianLedgerOptions) {
    this.root = options.root
  }

  private fileFor(now: Date): string {
    return join(this.root, `${now.toISOString().slice(0, 10)}.ndjson`)
  }

  /**
   * Read every record whose intent line carries this key.
   * @param idempotencyKey - Caller-supplied key.
   * @returns The merged record, or undefined when the key is new.
   */
  async find(idempotencyKey: string): Promise<JubianLedgerRecord | undefined> {
    const matches: Record<string, unknown>[] = []
    for (const file of await this.files()) {
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.idempotency_key === idempotencyKey) matches.push(parsed)
      }
    }
    return fold(matches)
  }

  /**
   * Persist the intent line, or replay the record an earlier call already wrote.
   * @param input - Key, method and request identity.
   * @returns Whether this call replayed an existing record.
   */
  async begin(input: JubianLedgerBegin): Promise<JubianLedgerBeginResult> {
    const existing = await this.find(input.idempotencyKey)
    if (existing !== undefined) return { replayed: true, record: existing }
    const now = new Date()
    this.counter += 1
    const record_id = `jub_${now.getTime().toString(36)}_${this.counter.toString(36)}`
    await mkdir(this.root, { recursive: true })
    await appendFile(this.fileFor(now), `${JSON.stringify({ phase: 'begin', record_id, idempotency_key: input.idempotencyKey,
      method: input.method, at: now.toISOString(), request_sha256: input.requestSha256,
      quoted_amount: input.quotedAmount ?? null, quote_standard_id: input.quoteStandardId ?? null,
      quote_observed_at: input.quoteObservedAt ?? null })}\n`, 'utf8')
    const record = await this.find(input.idempotencyKey)
    if (record === undefined) throw new Error('Jubian ledger intent did not persist')
    return { replayed: false, record }
  }

  /**
   * Persist the settlement line for one key.
   * @param idempotencyKey - The key whose intent line was already written.
   * @param settlement - Transport and application outcome.
   */
  async settle(idempotencyKey: string, settlement: JubianLedgerSettlement): Promise<void> {
    const now = new Date()
    await mkdir(this.root, { recursive: true })
    await appendFile(this.fileFor(now), `${JSON.stringify({ phase: 'settle', idempotency_key: idempotencyKey,
      settled_at: now.toISOString(), http_status: settlement.httpStatus,
      application_code: settlement.applicationCode, response_sha256: settlement.responseSha256,
      outcome: settlement.outcome })}\n`, 'utf8')
  }

  /**
   * List the ledger files in append order.
   * @returns Absolute paths of the per-day NDJSON files.
   */
  async files(): Promise<string[]> {
    try {
      const names = await readdir(this.root)
      return names.filter(name => name.endsWith('.ndjson')).sort().map(name => join(this.root, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian/tests/ledger.spec.ts`
Expected: PASS，4 个用例全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/jubian/src/ledger.ts packages/jubian/jubian/tests/ledger.spec.ts
git commit -m "feat(jubian): add two-phase idempotency ledger"
```

---

### Task 4: HTTP 客户端

**Files:**
- Create: `packages/jubian/jubian/src/client.ts`
- Create: `packages/jubian/jubian/tests/client.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian/tests/client.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { JubianClient } from '../src/client.ts'
import { JubianError } from '../src/error.ts'

const TOKEN = 'eyJhbGci.payload.sig'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function client(fetchImpl: typeof fetch, credential = async () => TOKEN) {
  return new JubianClient({ credential, fetch: fetchImpl })
}

describe('JubianClient.request', () => {
  it('sends one fixed-origin request with the repaired bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const client0 = client(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse({ code: 200, data: [{ id: 1 }] })
    }, async () => `  ${TOKEN};  `)
    const result = await client0.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=2' })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://web.jubianai.net/prod-api/model/charge/getSelectList?taskType=2')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.redirect).toBe('error')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(result.data).toEqual([{ id: 1 }])
    expect(result.transport).toEqual({ http_status: 200, application_code: 200 })
    expect(result.response_sha256).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('accepts both success codes and rejects everything else in the envelope', async () => {
    await expect(client(async () => jsonResponse({ code: 0, data: 'ok' })).request({ method: 'GET', path: '/x' }))
      .resolves.toMatchObject({ data: 'ok' })
    await expect(client(async () => jsonResponse({ code: 403, msg: 'no' })).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(client(async () => jsonResponse({ code: 500, msg: 'boom' })).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('maps transport failures without leaking the provider body', async () => {
    await expect(client(async () => jsonResponse({ msg: 'expired' }, 401)).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
    await expect(client(async () => jsonResponse({ msg: 'slow down' }, 429)).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED' })
    await expect(client(async () => jsonResponse({ msg: 'oops' }, 500)).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const thrown = await client(async () => { throw new Error('socket hang up') })
      .request({ method: 'GET', path: '/x' }).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(JubianError)
    expect((thrown as JubianError).message).not.toContain('socket hang up')
  })

  it('fails locally on an unusable token without issuing a request', async () => {
    let called = false
    const client0 = client(async () => { called = true; return jsonResponse({ code: 200, data: null }) },
      async () => 'has interior space')
    await expect(client0.request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' })
    expect(called).toBe(false)
  })

  it('rejects a non-JSON or non-object body as a contract change', async () => {
    await expect(client(async () => new Response('not json', { status: 200 })).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    await expect(client(async () => jsonResponse([1, 2, 3])).request({ method: 'GET', path: '/x' }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('bounds the response body by byte length', async () => {
    const huge = { code: 200, data: 'x'.repeat(4096) }
    const client0 = new JubianClient({ credential: async () => TOKEN, fetch: async () => jsonResponse(huge),
      maxResponseBytes: 512 })
    await expect(client0.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('sends a JSON body only when one is given', async () => {
    const seen: RequestInit[] = []
    const client0 = client(async (_url, init) => { seen.push(init ?? {}); return jsonResponse({ code: 200, data: 1 }) })
    await client0.request({ method: 'PUT', path: '/aigc/storyboard', body: { isGenerate: 0 } })
    expect(seen[0]!.method).toBe('PUT')
    expect(seen[0]!.body).toBe('{"isGenerate":0}')
    expect((seen[0]!.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian/tests/client.spec.ts`
Expected: FAIL — `Failed to resolve import "../src/client.ts"`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian/src/client.ts`:

```ts
/**
 * The one HTTP path to Jubian.
 *
 * Every rule the product's four adapters each implemented separately lives
 * here once: a fixed origin, no redirect following, a single attempt with no
 * retry, a byte bound on the response, strict UTF-8 decoding, an envelope
 * check that accepts both observed success codes, and a failure vocabulary
 * that never carries a provider body or the token.
 *
 * This module knows nothing about business fields. It returns the envelope's
 * `data` untouched; parsing belongs to the reader that asked for it, so a
 * field the provider adds never becomes an error here.
 */
import { createHash } from 'node:crypto'
import { isUsableBearerToken, trimBearerToken } from './credential.ts'
import { JubianError, codeForHttpStatus, failureForEnvelopeCode } from './error.ts'

/** Default provider origin; the path after it is the caller's. */
export const JUBIAN_DEFAULT_BASE_URL = 'https://web.jubianai.net/prod-api'

const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 60000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/** One request as a caller states it. */
export interface JubianRequest {
  method: 'GET' | 'POST' | 'PUT'
  /** Path including its query string, e.g. `/aigc/asset/123`. */
  path: string
  /** JSON body; omitted for a GET and for a POST that carries no body. */
  body?: Record<string, unknown>
  /** Caller cancellation, combined with the client's own timeout. */
  signal?: AbortSignal
}

/** What one completed request yields. */
export interface JubianResponse {
  /** Status and application code, for evidence and for the ledger. */
  transport: { http_status: number | null; application_code: number | null }
  /** Hash of the exact response bytes. */
  response_sha256: string | null
  /** The envelope's `data`, already proven to sit behind a success code. */
  data: unknown
}

export interface JubianClientOptions {
  /** Resolves the bearer token; the client repairs its boundary and never logs it. */
  credential: () => Promise<string>
  /** Origin override; defaults to {@link JUBIAN_DEFAULT_BASE_URL}. */
  baseUrl?: string
  timeoutMs?: number
  maxResponseBytes?: number
  /** Transport override, used by tests. */
  fetch?: typeof fetch
}

function hash(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Fixed-origin, single-attempt, byte-bounded Jubian transport. */
export class JubianClient {
  private readonly credential: () => Promise<string>
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maximum: number
  private readonly transport: typeof fetch

  constructor(options: JubianClientOptions) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maximum = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    if (typeof options.credential !== 'function') throw new TypeError('Jubian credential resolver must be a function')
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError(`Jubian timeoutMs must be an integer within 1..${MAX_TIMEOUT_MS}`)
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_RESPONSE_BYTES) {
      throw new TypeError(`Jubian maxResponseBytes must be an integer within 1..${MAX_RESPONSE_BYTES}`)
    }
    this.credential = options.credential
    this.baseUrl = options.baseUrl ?? JUBIAN_DEFAULT_BASE_URL
    this.timeoutMs = timeoutMs
    this.maximum = maximum
    this.transport = options.fetch ?? fetch
  }

  /**
   * Send one request and return its envelope `data`.
   * @param request - Method, path, optional body and cancellation.
   * @returns Transport evidence, the response hash and the envelope's data.
   * @throws {JubianError} With one of the five stable codes.
   */
  async request(request: JubianRequest): Promise<JubianResponse> {
    const stored = await this.resolveToken()
    const body = request.body === undefined ? undefined : JSON.stringify(request.body)
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
    let response: Response
    try {
      response = await this.transport(`${this.baseUrl}${request.path}`, {
        method: request.method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${stored}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        redirect: 'error',
        signal,
        ...(body === undefined ? {} : { body }),
      })
    } catch { throw new JubianError('NETWORK_ERROR') }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new JubianError(codeForHttpStatus(response.status))
    }
    const bytes = await this.readBounded(response)
    const response_sha256 = hash(bytes)
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new JubianError('CONTRACT_CHANGED') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JubianError('CONTRACT_CHANGED')
    const envelope = parsed as Record<string, unknown>
    const code = envelope.code
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new JubianError('CONTRACT_CHANGED')
    const failure = failureForEnvelopeCode(code)
    if (failure !== null) throw new JubianError(failure)
    return { transport: { http_status: response.status, application_code: code }, response_sha256, data: envelope.data }
  }

  private async resolveToken(): Promise<string> {
    let stored: string
    try { stored = await this.credential() } catch { throw new JubianError('AUTHENTICATION_REQUIRED') }
    const trimmed = trimBearerToken(stored)
    if (!isUsableBearerToken(trimmed)) throw new JubianError('AUTHENTICATION_REQUIRED')
    return trimmed
  }

  private async readBounded(response: Response): Promise<Uint8Array> {
    const reader = response.body?.getReader()
    if (!reader) throw new JubianError('CONTRACT_CHANGED')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > this.maximum) throw new JubianError('CONTRACT_CHANGED')
        chunks.push(chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error instanceof JubianError ? error : new JubianError('NETWORK_ERROR')
    } finally { reader.releaseLock() }
    const merged = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    return merged
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian/tests/client.spec.ts`
Expected: PASS，7 个用例全绿。

- [ ] **Step 5: 建 index 并提交**

Create `packages/jubian/jubian/src/index.ts`:

```ts
/** Jubian HTTP transport, credential repair, stable error codes and the write-path ledger. */
export { JUBIAN_TOKEN_REF, isUsableBearerToken, trimBearerToken } from './credential.ts'
export { JubianError, codeForHttpStatus, failureForEnvelopeCode } from './error.ts'
export type { JubianErrorCode } from './error.ts'
export { JubianLedger } from './ledger.ts'
export type { JubianLedgerBegin, JubianLedgerBeginResult, JubianLedgerMethod, JubianLedgerOptions,
  JubianLedgerRecord, JubianLedgerSettlement } from './ledger.ts'
export { JUBIAN_DEFAULT_BASE_URL, JubianClient } from './client.ts'
export type { JubianClientOptions, JubianRequest, JubianResponse } from './client.ts'
```

```bash
git add packages/jubian/jubian/src/index.ts packages/jubian/jubian/src/client.ts packages/jubian/jubian/tests/client.spec.ts
git commit -m "feat(jubian): add fixed-origin HTTP client"
```

---

### Task 5: 真实登录态验证（只读、零费用）

**Files:**
- Create: `packages/jubian/jubian/tests/live-read.spec.ts`

- [ ] **Step 1: 写 opt-in 验证用例**

Create `packages/jubian/jubian/tests/live-read.spec.ts`:

```ts
/**
 * One real, read-only call against the live provider.
 *
 * It proves the stored credential authenticates and that the envelope shape
 * this package assumes is the shape the provider actually sends. It is
 * skipped unless the operator opts in, because the default suite must never
 * touch the network.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JubianClient, JUBIAN_TOKEN_REF } from '../src/index.ts'

const enabled = process.env.DSH_JUBIAN_LIVE === '1'

/** Read the token straight from the harness credential document, without the credentials service. */
async function storedToken(): Promise<string> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const text = await readFile(join(home, '.credentials.yaml'), 'utf8')
  const line = text.split('\n').find(row => row.trimStart().startsWith(`${JUBIAN_TOKEN_REF}:`))
  if (line === undefined) throw new Error(`${JUBIAN_TOKEN_REF} is absent from the credential document`)
  return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '')
}

describe.skipIf(!enabled)('live read-only call', () => {
  it('reads the image model catalogue', async () => {
    const client = new JubianClient({ credential: storedToken })
    const result = await client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=2' })
    expect(result.transport.http_status).toBe(200)
    expect(Array.isArray(result.data)).toBe(true)
    const rows = result.data as Record<string, unknown>[]
    expect(rows.some(row => row.modelId === 'gpt-image-2')).toBe(true)
  }, 30000)
})
```

- [ ] **Step 2: 默认套件下确认它被跳过**

Run: `npx vitest run packages/jubian/jubian/tests/live-read.spec.ts`
Expected: PASS（1 skipped）

- [ ] **Step 3: 带 token 真跑一次**

先确认 token 存在（只打印键名与长度，不打印值）：

```powershell
$f = Join-Path $env:DSH_HOME '.credentials.yaml'
$line = (Get-Content $f | Where-Object { $_ -match '^\s*JUBIANAI_ADMIN_TOKEN:' })
"key present: $([bool]$line), value length: $((($line -split ':',2)[1]).Trim().Length)"
```

Run: `$env:DSH_JUBIAN_LIVE='1'; npx vitest run packages/jubian/jubian/tests/live-read.spec.ts`

Expected: PASS。**若返回 `AUTHENTICATION_REQUIRED`，停止后续 Phase 并报告** —— 说明 token 已失效或 envelope 形状与假设不符，此时先修客户端而不是继续往上盖工具。

- [ ] **Step 4: 提交**

```bash
git add packages/jubian/jubian/tests/live-read.spec.ts
git commit -m "test(jubian): add opt-in live read-only credential check"
```

---

## Phase 2 — `@deepseek-ai/dsh-jubian-api` 读取器

### Task 6: 包骨架 + 目录读取器

**Files:**
- Create: `packages/jubian/jubian-api/package.json`
- Create: `packages/jubian/jubian-api/tsconfig.json`
- Create: `packages/jubian/jubian-api/src/catalog.ts`
- Create: `packages/jubian/jubian-api/tests/catalog.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian-api/tests/catalog.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readEpisodes, readModels, readScript } from '../src/catalog.ts'

const IMAGE_MODEL = { id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 }] }

describe('readModels', () => {
  it('passes catalogue rows through and rejects a non-array', () => {
    expect(readModels([IMAGE_MODEL])).toEqual([IMAGE_MODEL])
    expect(() => readModels({ nope: true })).toThrow(/catalogue/i)
  })
})

describe('readScript', () => {
  it('keeps the identity and name fields a project read needs', () => {
    expect(readScript({ id: 2708, name: '山海自有相逢处', productionType: 2, extra: 'ignored' }))
      .toEqual({ script_id: 2708, name: '山海自有相逢处', production_type: 2 })
  })

  it('rejects a payload without a usable identity', () => {
    expect(() => readScript({ name: 'x' })).toThrow(/script/i)
    expect(() => readScript(null)).toThrow(/script/i)
  })
})

describe('readEpisodes', () => {
  it('reads one envelope page into rows plus its total', () => {
    expect(readEpisodes({ total: 2, rows: [{ id: 1, name: '第1集' }, { id: 2, name: '第2集' }] }))
      .toEqual({ total: 2, rows: [{ episode_id: 1, name: '第1集' }, { episode_id: 2, name: '第2集' }] })
  })

  it('rejects a payload that is not a page', () => {
    expect(() => readEpisodes({ total: 2 })).toThrow(/episode/i)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian-api/tests/catalog.spec.ts`
Expected: FAIL — 无法解析 `../src/catalog.ts`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian-api/src/catalog.ts`:

```ts
/**
 * Catalogue, screenplay and episode reads.
 *
 * These readers parse business fields, which the transport deliberately does
 * not. Each one takes an already-validated envelope `data` and either returns
 * the fields it promises or throws `INVALID_ARGUMENT`, so a provider that
 * adds a field never breaks a caller.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(message: string): never { throw new JubianError('CONTRACT_CHANGED') }
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) invalid('Catalogue or page rows are absent')
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('Catalogue row is not an object')
    return row as Record<string, unknown>
  })
}
function positiveInteger(value: unknown, field: string): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid(`Invalid ${field}`)
  return candidate
}
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Model catalogue selectors this plugin reads. */
export const MODEL_TASK_TYPES = { video: 1, image: 2, subtitleErasure: 10 } as const

/**
 * Return the raw catalogue rows for one task type.
 * @param data - Envelope `data` from `/model/charge/getSelectList`.
 * @returns The rows, unchanged.
 */
export function readModels(data: unknown): Record<string, unknown>[] {
  return rows(data)
}

/**
 * Read the identity fields of one remote screenplay.
 * @param data - Envelope `data` from `/aigc/script/{scriptId}`.
 * @returns The project identity a caller needs to address the remote project.
 */
export function readScript(data: unknown): { script_id: number; name: string | null; production_type: number | null } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('Script payload is not an object')
  const record = data as Record<string, unknown>
  const id = record.id ?? record.scriptId
  if (typeof id !== 'number' && typeof id !== 'string') invalid('Script payload has no identity')
  return { script_id: positiveInteger(id, 'script id'), name: optionalText(record.name),
    production_type: typeof record.productionType === 'number' ? record.productionType : null }
}

/**
 * Read one page of episodes.
 * @param data - Envelope `data` from `/aigc/episode/list`.
 * @returns The page total and its episode rows.
 */
export function readEpisodes(data: unknown): { total: number; rows: { episode_id: number; name: string | null }[] } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('Episode payload is not a page')
  const record = data as Record<string, unknown>
  const row = record.rows
  if (!Array.isArray(row)) invalid('Episode page has no rows array')
  return { total: typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : row.length,
    rows: rows(row).map(item => ({ episode_id: positiveInteger(item.id ?? item.episodeId, 'episode id'),
      name: optionalText(item.name) })) }
}
```

Create `packages/jubian/jubian-api/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-jubian-api",
  "description": "Typed Jubian endpoint readers over the Jubian transport",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/dsh-jubian": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-jubian": "workspace:^"
  }
}
```

Create `packages/jubian/jubian-api/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../jubian"
    }
  ]
}
```

- [ ] **Step 4: 安装并运行测试**

Run: `pnpm install --filter @deepseek-ai/dsh-jubian-api`
Then: `npx vitest run packages/jubian/jubian-api/tests/catalog.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/jubian-api pnpm-lock.yaml
git commit -m "feat(jubian-api): add catalogue, script and episode readers"
```

---

### Task 7: 资产与材质读取器

**Files:**
- Create: `packages/jubian/jubian-api/src/asset.ts`
- Create: `packages/jubian/jubian-api/tests/asset.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian-api/tests/asset.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readAssetList, readAssetPage, readGeneratedImage, readMaterialList } from '../src/asset.ts'

describe('readAssetList / readAssetPage', () => {
  it('reads a paged asset list with its total', () => {
    expect(readAssetList({ total: 1, rows: [{ id: 83749, name: '陆沉舟', assetType: 1 }] }))
      .toEqual({ total: 1, rows: [{ asset_id: 83749, name: '陆沉舟', asset_type: 1 }] })
  })

  it('reads one asset and keeps the local-upload flag', () => {
    expect(readAssetPage({ id: 83749, name: '陆沉舟', assetType: 1, isLocal: 1, hsAssetStatus: 'Active' }))
      .toEqual({ asset_id: 83749, name: '陆沉舟', asset_type: 1, is_local: true, status: 'Active' })
    expect(readAssetPage({ id: 1, name: 'x', assetType: 2, isLocal: 0, hsAssetStatus: null }))
      .toEqual({ asset_id: 1, name: 'x', asset_type: 2, is_local: false, status: null })
  })
})

describe('readMaterialList', () => {
  it('reads the subject-setting rows a shot match selects from', () => {
    const data = { total: 1, rows: [{ id: 900, assetId: 83749, materialName: '陆沉舟｜低调投资顾问装',
      materialUrl: 'https://x/y.png', materialType: 1, isUsed: 1, hsAssetStatus: 'Active' }] }
    expect(readMaterialList(data)).toEqual({ total: 1, rows: [{ material_id: 900, asset_id: 83749,
      name: '陆沉舟｜低调投资顾问装', url: 'https://x/y.png', material_type: 1, is_used: true, status: 'Active' }] })
  })

  it('rejects a payload without rows', () => {
    expect(() => readMaterialList({ total: 0 })).toThrow()
  })
})

describe('readGeneratedImage', () => {
  it('reads the generated image URL for one asset', () => {
    expect(readGeneratedImage({ url: 'https://x/gen.png', materialId: 900 }))
      .toEqual({ url: 'https://x/gen.png', material_id: 900 })
  })

  it('rejects a payload with no usable URL', () => {
    expect(() => readGeneratedImage({ materialId: 900 })).toThrow()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian-api/tests/asset.spec.ts`
Expected: FAIL — 无法解析 `../src/asset.ts`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian-api/src/asset.ts`:

```ts
/**
 * Asset and material reads: the remote source of truth a shot match selects from.
 *
 * `is_local` mirrors the provider's `isLocal` flag and `status` mirrors
 * `hsAssetStatus`; both are carried through so a caller can apply its own
 * admission rules without re-reading the raw payload.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(message: string): never { throw new JubianError('CONTRACT_CHANGED') }
function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${what} is not an object`)
  return value as Record<string, unknown>
}
function page(value: unknown, what: string): Record<string, unknown>[] {
  const record = object(value, `${what} page`)
  if (!Array.isArray(record.rows)) invalid(`${what} page has no rows array`)
  return record.rows.map(row => object(row, `${what} row`))
}
function total(value: unknown, fallback: number): number {
  const record = object(value, 'page')
  return typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : fallback
}
function id(value: unknown, field: string): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid(`Invalid ${field}`)
  return candidate
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`Invalid ${field}`)
  return value
}
function nullableText(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }

/** One asset row as this plugin exposes it. */
export interface AssetRow { asset_id: number; name: string | null; asset_type: number | null }

/** One asset with its local-upload flag and remote status. */
export interface AssetDetail extends AssetRow { is_local: boolean; status: string | null }

/** One material row from the project's subject setting. */
export interface MaterialRow {
  material_id: number
  asset_id: number | null
  name: string | null
  url: string | null
  material_type: number | null
  is_used: boolean
  status: string | null
}

/**
 * Read one page of the project's assets.
 * @param data - Envelope `data` from `/aigc/asset/list`.
 */
export function readAssetList(data: unknown): { total: number; rows: AssetRow[] } {
  const rows = page(data, 'Asset')
  return { total: total(data, rows.length), rows: rows.map(row => ({ asset_id: id(row.id ?? row.assetId, 'asset id'),
    name: nullableText(row.name), asset_type: typeof row.assetType === 'number' ? row.assetType : null })) }
}

/**
 * Read one asset, keeping the flags an admission rule needs.
 * @param data - Envelope `data` from `/aigc/asset/{assetId}`.
 */
export function readAssetPage(data: unknown): AssetDetail {
  const row = object(data, 'Asset')
  return { asset_id: id(row.id ?? row.assetId, 'asset id'), name: nullableText(row.name),
    asset_type: typeof row.assetType === 'number' ? row.assetType : null,
    is_local: row.isLocal === 1 || row.isLocal === true, status: nullableText(row.hsAssetStatus) }
}

/**
 * Read the project's subject-setting materials.
 * @param data - Envelope `data` from `/aigc/material/list`.
 */
export function readMaterialList(data: unknown): { total: number; rows: MaterialRow[] } {
  const rows = page(data, 'Material')
  return { total: total(data, rows.length), rows: rows.map(row => ({ material_id: id(row.id ?? row.materialId, 'material id'),
    asset_id: row.assetId === undefined || row.assetId === null ? null : id(row.assetId, 'parent asset id'),
    name: nullableText(row.materialName ?? row.name), url: nullableText(row.materialUrl ?? row.url),
    material_type: typeof row.materialType === 'number' ? row.materialType : null,
    is_used: row.isUsed === 1 || row.isUsed === true, status: nullableText(row.hsAssetStatus) })) }
}

/**
 * Read the generated image reference for one asset.
 * @param data - Envelope `data` from `/aigc/material/getGeneratedImageByAssetId`.
 */
export function readGeneratedImage(data: unknown): { url: string; material_id: number | null } {
  const row = object(data, 'Generated image')
  return { url: text(row.url ?? row.materialUrl, 'generated image url'),
    material_id: row.materialId === undefined || row.materialId === null ? null : id(row.materialId, 'material id') }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian-api/tests/asset.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/jubian-api/src/asset.ts packages/jubian/jubian-api/tests/asset.spec.ts
git commit -m "feat(jubian-api): add asset and material readers"
```

---

### Task 8: 视频任务读取器

**Files:**
- Create: `packages/jubian/jubian-api/src/video.ts`
- Create: `packages/jubian/jubian-api/tests/video.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian-api/tests/video.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readSubtaskPage, readTaskPage, readTaskList } from '../src/video.ts'

const PARENT = { id: 335343, taskType: 10, taskStatus: 'success', firstResultId: 1, parentResultId: 2,
  realCost: '3.50', estimatedCost: '4.00' }

describe('readTaskPage', () => {
  it('reads task identity, status and the cost observation when present', () => {
    expect(readTaskPage(PARENT)).toEqual({ task_id: 335343, task_type: 10, status: 'success',
      first_result_id: 1, parent_result_id: 2, real_cost: '3.50', estimated_cost: '4.00', discount_cost: null })
  })

  it('leaves an absent cost observation null instead of inventing zero', () => {
    expect(readTaskPage({ id: 1, taskType: 1, taskStatus: 'running' }).real_cost).toBeNull()
  })

  it('rejects a payload with no identity', () => {
    expect(() => readTaskPage({ taskStatus: 'running' })).toThrow()
  })
})

describe('readTaskList', () => {
  it('reads a page of generation tasks', () => {
    expect(readTaskList({ total: 1, rows: [PARENT] }).rows[0]!.task_id).toBe(335343)
  })
})

describe('readSubtaskPage', () => {
  it('reads child identity, duration and the single video material URL', () => {
    const child = { id: 990, aigcVideoTaskId: 335343, taskType: 10, taskStatus: 'success', genNum: 1, duration: 13,
      zimuLeft: 0, zimuTop: 900, zimuWidth: 720, zimuHeight: 300,
      videoMaterials: [{ videoUrl: 'https://x/v.mp4', aigcVideoTaskId: 335343, aigcVideoSubTaskId: 990 }] }
    expect(readSubtaskPage({ total: 1, rows: [child] })).toEqual({ total: 1, rows: [{ subtask_id: 990,
      parent_task_id: 335343, status: 'success', duration_seconds: 13, gen_num: 1,
      subtitle_box: { zimuLeft: 0, zimuTop: 900, zimuWidth: 720, zimuHeight: 300 },
      video_url: 'https://x/v.mp4' }] })
  })

  it('reports a null subtitle box when the provider omits geometry', () => {
    const child = { id: 1, aigcVideoTaskId: 2, taskStatus: 'running', videoMaterials: [] }
    expect(readSubtaskPage({ total: 1, rows: [child] }).rows[0]!.subtitle_box).toBeNull()
    expect(readSubtaskPage({ total: 1, rows: [child] }).rows[0]!.video_url).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian-api/tests/video.spec.ts`
Expected: FAIL — 无法解析 `../src/video.ts`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian-api/src/video.ts`:

```ts
/**
 * Video task reads: the remote generation identity a caller polls.
 *
 * Cost fields are carried through as observed strings. They are never a
 * settled charge: only a definitive provider receipt can settle billing, so
 * these fields are evidence for a human, not authorization for a program.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(message: string): never { throw new JubianError('CONTRACT_CHANGED') }
function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${what} is not an object`)
  return value as Record<string, unknown>
}
function rowsOf(value: unknown, what: string): Record<string, unknown>[] {
  const record = object(value, `${what} page`)
  if (!Array.isArray(record.rows)) invalid(`${what} page has no rows array`)
  return record.rows.map(row => object(row, `${what} row`))
}
function totalOf(value: unknown, fallback: number): number {
  const record = object(value, 'page')
  return typeof record.total === 'number' && Number.isSafeInteger(record.total) ? record.total : fallback
}
function id(value: unknown, field: string): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid(`Invalid ${field}`)
  return candidate
}
function nullableId(value: unknown): number | null {
  if (value === undefined || value === null) return null
  try { return id(value, 'identity') } catch { return null }
}
function cost(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]+)?$/.test(value)) return null
  return value
}
function nullableText(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }

/** One video generation task as this plugin exposes it. */
export interface VideoTask {
  task_id: number
  task_type: number | null
  status: string | null
  first_result_id: number | null
  parent_result_id: number | null
  real_cost: string | null
  estimated_cost: string | null
  discount_cost: string | null
}

/** The subtitle pixel geometry a regional erasure needs. */
export interface SubtitleBox { zimuLeft: number; zimuTop: number; zimuWidth: number; zimuHeight: number }

/** One child generation result. */
export interface VideoSubtask {
  subtask_id: number
  parent_task_id: number | null
  status: string | null
  duration_seconds: number | null
  gen_num: number | null
  subtitle_box: SubtitleBox | null
  video_url: string | null
}

function task(row: Record<string, unknown>): VideoTask {
  return { task_id: id(row.id ?? row.taskId, 'video task id'),
    task_type: typeof row.taskType === 'number' ? row.taskType : null,
    status: nullableText(row.taskStatus), first_result_id: nullableId(row.firstResultId),
    parent_result_id: nullableId(row.parentResultId), real_cost: cost(row.realCost),
    estimated_cost: cost(row.estimatedCost), discount_cost: cost(row.discountCost) }
}

function box(row: Record<string, unknown>): SubtitleBox | null {
  const fields = ['zimuLeft', 'zimuTop', 'zimuWidth', 'zimuHeight'] as const
  if (fields.some(field => typeof row[field] !== 'number' || !Number.isSafeInteger(row[field]))) return null
  return { zimuLeft: row.zimuLeft as number, zimuTop: row.zimuTop as number,
    zimuWidth: row.zimuWidth as number, zimuHeight: row.zimuHeight as number }
}

/**
 * Read one video generation task.
 * @param data - Envelope `data` from `/admin/aigc/video/task/{taskId}`.
 */
export function readTaskPage(data: unknown): VideoTask {
  return task(object(data, 'Video task'))
}

/**
 * Read one page of generation tasks for a project.
 * @param data - Envelope `data` from `/admin/aigc/video/task/list`.
 */
export function readTaskList(data: unknown): { total: number; rows: VideoTask[] } {
  const rows = rowsOf(data, 'Video task')
  return { total: totalOf(data, rows.length), rows: rows.map(task) }
}

/**
 * Read one page of child results, keeping the geometry an erasure needs.
 * @param data - Envelope `data` from `/admin/aigc/video/task/sub/list`.
 */
export function readSubtaskPage(data: unknown): { total: number; rows: VideoSubtask[] } {
  const rows = rowsOf(data, 'Video subtask')
  return { total: totalOf(data, rows.length), rows: rows.map((row) => {
    const materials = Array.isArray(row.videoMaterials) ? row.videoMaterials : []
    const first = materials.length ? object(materials[0], 'Video material') : undefined
    return { subtask_id: id(row.id ?? row.subTaskId, 'subtask id'),
      parent_task_id: nullableId(row.aigcVideoTaskId), status: nullableText(row.taskStatus),
      duration_seconds: typeof row.duration === 'number' && Number.isFinite(row.duration) ? row.duration : null,
      gen_num: typeof row.genNum === 'number' ? row.genNum : null, subtitle_box: box(row),
      video_url: first === undefined ? null : nullableText(first.videoUrl) }
  }) }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian-api/tests/video.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/jubian-api/src/video.ts packages/jubian/jubian-api/tests/video.spec.ts
git commit -m "feat(jubian-api): add video task readers"
```

---

### Task 9: 分镜读取器 + save/generate 载荷变换

**Files:**
- Create: `packages/jubian/jubian-api/src/storyboard.ts`
- Create: `packages/jubian/jubian-api/tests/storyboard.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian-api/tests/storyboard.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readStoryboard, withGenerationDisabled, withGenerationEnabled } from '../src/storyboard.ts'

function snapshot(overrides: Record<string, unknown> = {}) {
  return { id: 916953, scriptId: 2708, isGenerate: 0, storyboardName: '第1集-分镜1',
    prompt: '@[陆沉舟](83749) 走进办公室',
    modelConfig: JSON.stringify({ platformId: 'YU_DIAN', modelId: 'doubao-seedance-2-0-1', standardId: 11,
      genType: 3, modelGenerationTypeId: 7, videoStandardId: 91, duration: 8, ratio: '9:16', resolution: '720p',
      genNum: 1, prompt: '@[陆沉舟](83749) 走进办公室', materialList: [{ materialKey: '83749', sortOrder: 1 }],
      backupModelList: [] }),
    storyboardMaterialList: [{ materialKey: '83749', sortOrder: 1 }], ...overrides }
}

describe('readStoryboard', () => {
  it('parses the modelConfig string and keeps the provider snapshot intact', () => {
    const result = readStoryboard(snapshot())
    expect(result.storyboard_id).toBe(916953)
    expect(result.script_id).toBe(2708)
    expect(result.is_generate).toBe(0)
    expect(result.model_config.duration).toBe(8)
    expect(result.material_keys).toEqual(['83749'])
  })

  it('rejects a snapshot whose identity does not match the requested storyboard', () => {
    expect(() => readStoryboard(snapshot(), 111)).toThrow()
  })
})

describe('withGenerationEnabled (收费路径)', () => {
  it('flips only isGenerate and hands back the provider snapshot untouched', () => {
    const next = withGenerationEnabled(snapshot(), 8000)
    expect(next.isGenerate).toBe(1)
    expect(next.storyboardName).toBe('第1集-分镜1')
    expect(next.storyboardMaterialList).toEqual([{ materialKey: '83749', sortOrder: 1 }])
  })

  it('refuses to generate from a snapshot whose saved duration differs from the requested package', () => {
    expect(() => withGenerationEnabled(snapshot(), 12000)).toThrow(/duration|时长|differ/i)
  })

  it('refuses a snapshot that is already generating', () => {
    expect(() => withGenerationEnabled(snapshot({ isGenerate: 1 }), 8000)).toThrow()
  })
})

describe('withGenerationDisabled (免费路径)', () => {
  it('forces isGenerate to 0 and preserves the rest', () => {
    const next = withGenerationDisabled(snapshot({ isGenerate: 1 }))
    expect(next.isGenerate).toBe(0)
    expect(next.id).toBe(916953)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian-api/tests/storyboard.spec.ts`
Expected: FAIL — 无法解析 `../src/storyboard.ts`

- [ ] **Step 3: 写最小实现**

Create `packages/jubian/jubian-api/src/storyboard.ts`:

```ts
/**
 * Storyboard reads and the two exact snapshot transformations.
 *
 * Both transformations work on a snapshot the provider itself returned, so
 * every field the provider owns survives the round trip. That is why the
 * plugin never asks a caller to compose a full storyboard body: reading the
 * current one and changing exactly one field is both safer and smaller.
 *
 * `withGenerationEnabled` is the paid path. It refuses to run unless the
 * saved configuration already matches the requested package duration, because
 * the provider derives its own duration from `modelConfig.duration` and a
 * mismatch would silently generate a video of the wrong length.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(message: string): never { throw new JubianError('CONTRACT_CHANGED') }

/** One storyboard snapshot as this plugin exposes it. */
export interface StoryboardView {
  storyboard_id: number
  script_id: number
  name: string | null
  is_generate: 0 | 1
  content_duration_ms: number | null
  material_keys: string[]
  model_config: Record<string, unknown>
  snapshot: Record<string, unknown>
}

function id(value: unknown, field: string): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid(`Invalid ${field}`)
  return candidate
}

function configOf(source: Record<string, unknown>): Record<string, unknown> {
  const raw = source.modelConfig
  const parsed: unknown = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown } catch { return invalid('modelConfig is not JSON') } })() : raw
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('Storyboard modelConfig is not an object')
  const config = parsed as Record<string, unknown>
  if (config.ratio !== '9:16' || config.resolution !== '720p' || config.genNum !== 1
    || !Number.isSafeInteger(config.duration)) invalid('Storyboard is not on the supported video route')
  return config
}

/**
 * Read one storyboard snapshot.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`.
 * @param expectedStoryboardId - When given, the snapshot must be that storyboard.
 */
export function readStoryboard(data: unknown, expectedStoryboardId?: number): StoryboardView {
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('Storyboard payload is not an object')
  const snapshot = structuredClone(data) as Record<string, unknown>
  const storyboard_id = id(snapshot.id, 'storyboard id'), script_id = id(snapshot.scriptId, 'script id')
  if (expectedStoryboardId !== undefined && storyboard_id !== expectedStoryboardId) invalid('Storyboard identity differs')
  const is_generate = snapshot.isGenerate
  if (is_generate !== 0 && is_generate !== 1) invalid('Storyboard generation flag is absent')
  const config = configOf(snapshot)
  const materials = Array.isArray(snapshot.storyboardMaterialList) ? snapshot.storyboardMaterialList : []
  return { storyboard_id, script_id, name: typeof snapshot.storyboardName === 'string' ? snapshot.storyboardName : null,
    is_generate, content_duration_ms: (config.duration as number) * 1000 - 1000,
    material_keys: materials.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('Storyboard material row is not an object')
      const key = (row as Record<string, unknown>).materialKey
      if (typeof key !== 'string' || !key) invalid('Storyboard material row has no key')
      return key
    }), model_config: config, snapshot }
}

/**
 * The paid transformation: hand the provider its own snapshot with generation enabled.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`, read in the same call.
 * @param contentDurationMs - The package duration the caller intends to generate, in whole seconds within 4000..14000.
 * @returns A PUT body that differs from the snapshot only in `isGenerate`.
 */
export function withGenerationEnabled(data: unknown, contentDurationMs: number): Record<string, unknown> {
  if (!Number.isSafeInteger(contentDurationMs) || contentDurationMs < 4000 || contentDurationMs > 14000
    || contentDurationMs % 1000 !== 0) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  const view = readStoryboard(data)
  if (view.is_generate !== 0) invalid('Storyboard is already generating')
  if (view.model_config.duration !== contentDurationMs / 1000 + 1) {
    invalid('Saved storyboard duration differs from the requested package duration')
  }
  return { ...view.snapshot, isGenerate: 1 }
}

/**
 * The free transformation: hand the provider its own snapshot with generation disabled.
 * @param data - Envelope `data` from `/aigc/storyboard/{storyboardId}`.
 * @returns A PUT body that differs from the snapshot only in `isGenerate`.
 */
export function withGenerationDisabled(data: unknown): Record<string, unknown> {
  return { ...readStoryboard(data).snapshot, isGenerate: 0 }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian-api/tests/storyboard.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/jubian-api/src/storyboard.ts packages/jubian/jubian-api/tests/storyboard.spec.ts
git commit -m "feat(jubian-api): add storyboard reader and snapshot transformations"
```

---

### Task 10: 收费写路径的载荷编译（图片 + 去字幕）

**Files:**
- Create: `packages/jubian/jubian-api/src/image.ts`
- Create: `packages/jubian/jubian-api/src/subtitle.ts`
- Create: `packages/jubian/jubian-api/src/index.ts`
- Create: `packages/jubian/jubian-api/tests/image.spec.ts`
- Create: `packages/jubian/jubian-api/tests/subtitle.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/jubian-api/tests/image.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildImageRequest, resolveImageModel, readImageDisplayPrice } from '../src/image.ts'

const CATALOGUE = [{ id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }],
  videoStandards: [
    { id: 90, ratio: '16:9', resolution: '2K', width: 2048, height: 1152, genNum: 1 },
    { id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720, genNum: 1 },
  ] }]

describe('resolveImageModel', () => {
  it('selects the lowest supported resolution with valid 16:9 dimensions', () => {
    expect(resolveImageModel(CATALOGUE)).toEqual({ standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN',
      modelGenerationTypeId: 7, genType: 3, videoStandardId: 91, resolution: '1K' })
  })

  it('rejects a standard whose dimensions are not exactly 16:9', () => {
    const broken = [{ ...CATALOGUE[0], videoStandards: [{ id: 1, ratio: '16:9', resolution: '1K', width: 1280, height: 721 }] }]
    expect(() => resolveImageModel(broken)).toThrow()
  })

  it('rejects a catalogue without exactly one gpt-image-2 row', () => {
    expect(() => resolveImageModel([])).toThrow()
    expect(() => resolveImageModel([CATALOGUE[0], CATALOGUE[0]])).toThrow()
  })
})

describe('buildImageRequest', () => {
  it('builds the exact create body with a deterministic modelConfig string', () => {
    const body = buildImageRequest({ scriptId: 2708, assetName: '陆沉舟', assetType: 1,
      prompt: '一位中年男性', references: [] }, CATALOGUE)
    expect(body).toMatchObject({ scriptId: 2708, assetName: '陆沉舟', assetType: 1, isLocal: 0, isGenerate: 1 })
    const config = JSON.parse(body.modelConfig as string) as Record<string, unknown>
    expect(config).toMatchObject({ modelId: 'gpt-image-2', genType: 3, duration: 1, resolution: '1K', ratio: '16:9',
      genNum: 1, backupModelList: [], style: 0, quality: '', prompt: '一位中年男性', materialList: [] })
    expect(config.standardId).toBe(42)
    expect(config.videoStandardId).toBe(91)
  })

  it('numbers ordered references from one and rejects a non-HTTPS url', () => {
    const body = buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p',
      references: ['https://x/a.png', 'https://x/b.png'] }, CATALOGUE)
    const config = JSON.parse(body.modelConfig as string) as { materialList: { sortOrder: number }[] }
    expect(config.materialList.map(row => row.sortOrder)).toEqual([1, 2])
    expect(() => buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p',
      references: ['http://x/a.png'] }, CATALOGUE)).toThrow()
  })

  it('adds the parent id only for the update route', () => {
    expect(buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [],
      parentAssetId: 83749 }, CATALOGUE).id).toBe(83749)
    expect('id' in buildImageRequest({ scriptId: 1, assetName: 'x', assetType: 1, prompt: 'p', references: [] }, CATALOGUE))
      .toBe(false)
  })
})

describe('readImageDisplayPrice', () => {
  it('reports the display price without claiming it is a verified quote', () => {
    expect(readImageDisplayPrice(CATALOGUE)).toEqual({ status: 'available', unit_price: 0.5, unit: '张', quote_verified: false })
    expect(readImageDisplayPrice([{ ...CATALOGUE[0], unitPrice: 'free' }]))
      .toEqual({ status: 'unavailable', quote_verified: false })
  })
})
```

Create `packages/jubian/jubian-api/tests/subtitle.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildSubtitleEraseRequest, readSubtitleTaskId } from '../src/subtitle.ts'

const CATALOGUE = [{ id: 55, standardId: 55, modelId: 'quzimuToB', platformId: 'YU_DIAN' }]
const SOURCE = { taskName: '第1集-擦除', firstResultId: 1, parentResultId: 2, videoUrl: 'https://x/v.mp4',
  duration: 13, videoWidth: 720, videoHeight: 1280,
  subtitleBox: { zimuLeft: 0, zimuTop: 900, zimuWidth: 720, zimuHeight: 300 } }

describe('buildSubtitleEraseRequest', () => {
  it('builds the regional erasure body from a verified source', () => {
    expect(buildSubtitleEraseRequest(CATALOGUE, 'quzimuToB', SOURCE)).toEqual({ firstResultId: 1, parentResultId: 2,
      taskName: '第1集-擦除', taskType: 10, videoUrl: 'https://x/v.mp4', standardId: 55, platformId: 'YU_DIAN',
      modelId: 'quzimuToB', videoStandardId: null, duration: 13,
      zimuLeft: 0, zimuTop: 900, zimuWidth: 720, zimuHeight: 300, videoWidth: 720, videoHeight: 1280 })
  })

  it('refuses the automatic model when a pixel box is supplied', () => {
    expect(() => buildSubtitleEraseRequest([{ ...CATALOGUE[0], modelId: 'ark-erase-video-subtitle-pro',
      platformId: 'AI_MEDIA_KIT' }], 'ark-erase-video-subtitle-pro', SOURCE)).toThrow()
  })

  it('refuses a box that leaves the frame', () => {
    expect(() => buildSubtitleEraseRequest(CATALOGUE, 'quzimuToB',
      { ...SOURCE, subtitleBox: { zimuLeft: 0, zimuTop: 900, zimuWidth: 720, zimuHeight: 400 } })).toThrow()
  })

  it('refuses an unknown model instead of falling back to another route', () => {
    expect(() => buildSubtitleEraseRequest(CATALOGUE, 'something-else', SOURCE)).toThrow()
  })
})

describe('readSubtitleTaskId', () => {
  it('reads the single task identity a submitted erasure returns', () => {
    expect(readSubtitleTaskId({ code: 200, data: { taskId: 123, jobId: '123' } })).toBe('123')
    expect(readSubtitleTaskId({ code: 200, data: { taskId: 1, jobId: 2 } })).toBeNull()
    expect(readSubtitleTaskId({ code: 500, data: { taskId: 1 } })).toBeNull()
    expect(readSubtitleTaskId({ code: 200, data: {} })).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/jubian-api/tests/image.spec.ts packages/jubian/jubian-api/tests/subtitle.spec.ts`
Expected: FAIL — 无法解析 `../src/image.ts` 与 `../src/subtitle.ts`

- [ ] **Step 3: 写实现**

Create `packages/jubian/jubian-api/src/image.ts`:

```ts
/**
 * Image generation payloads, ported from the product's pure builders.
 *
 * The catalogue selectors are resolved from the live account catalogue rather
 * than accepted from a caller: `standardId`, `platformId` and
 * `videoStandardId` are account state, and a stale pair would create a
 * generation request the provider rejects after the caller believes it was
 * accepted.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(message: string): never { throw new JubianError('CONTRACT_CHANGED') }
function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${what} is not an object`)
  return value as Record<string, unknown>
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) invalid('Catalogue rows are absent')
  return value.map(row => object(row, 'Catalogue row'))
}
function positive(value: unknown, field: string): number {
  const candidate = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 1) invalid(`Invalid ${field}`)
  return candidate
}
function text(value: unknown, field: string, multiline = false): string {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) {
    invalid(`Invalid ${field}`)
  }
  return value
}

/** The selectors one GPT Image 2 request needs. */
export interface ImageModelSelectors {
  standardId: number
  modelId: string
  platformId: string
  modelGenerationTypeId: number | null
  genType: 3
  videoStandardId: number
  resolution: string
}

function imageModelRow(catalogue: unknown): Record<string, unknown> {
  const matches = rows(catalogue).filter(row => row.modelId === 'gpt-image-2')
  if (matches.length !== 1) invalid('Expected exactly one gpt-image-2 catalogue row')
  return matches[0]!
}

/**
 * Resolve the supported image selectors from a live `taskType=2` catalogue.
 * @param catalogue - Envelope `data` already read from `/model/charge/getSelectList?taskType=2`.
 * @returns The lowest supported resolution with dimension-valid 16:9 standards.
 */
export function resolveImageModel(catalogue: unknown): ImageModelSelectors {
  const model = imageModelRow(catalogue)
  const standards = rows(model.videoStandards).filter(row => row.ratio === '16:9'
    && typeof row.resolution === 'string' && ['1K', '2K', '4K'].includes(row.resolution.toUpperCase())
    && typeof row.width === 'number' && Number.isSafeInteger(row.width) && row.width > 0 && row.width <= 8192
    && row.width % 16 === 0
    && typeof row.height === 'number' && Number.isSafeInteger(row.height) && row.height > 0 && row.height <= 8192
    && row.height % 16 === 0 && row.width * 9 === row.height * 16)
  const resolution = ['1K', '2K', '4K'].find(value => standards.some(row => (row.resolution as string).toUpperCase() === value))
  const atResolution = standards.filter(row => (row.resolution as string).toUpperCase() === resolution)
  if (atResolution.length !== 1) invalid('Expected one dimension-valid 16:9 standard at the lowest supported resolution')
  const generations = (model.genTypes === undefined || model.genTypes === null ? [] : rows(model.genTypes)).filter(row => row.type === 3)
  if (generations.length > 1) invalid('Ambiguous image generation type')
  const generation = generations[0]
  return { standardId: positive(model.id ?? model.standardId, 'standard id'), modelId: 'gpt-image-2',
    platformId: text(model.platformId, 'platform id'), genType: 3,
    modelGenerationTypeId: generation === undefined || generation.id === null || generation.id === undefined
      ? null : positive(generation.id, 'generation type id'),
    videoStandardId: positive(atResolution[0]!.id, 'video standard id'),
    resolution: (atResolution[0]!.resolution as string).toUpperCase() }
}

/** One image generation request as a caller states it. */
export interface ImageRequestInput {
  scriptId: number
  assetName: string
  assetType: number
  prompt: string
  references: string[]
  /** Present only for the update route; the provider then takes PUT instead of POST. */
  parentAssetId?: number
}

/**
 * Build the exact `/aigc/asset` body.
 * @param input - Caller-supplied identity, prompt and ordered reference URLs.
 * @param catalogue - Live `taskType=2` catalogue.
 * @returns The wire body, with `id` present only on the update route.
 */
export function buildImageRequest(input: ImageRequestInput, catalogue: unknown): Record<string, unknown> {
  const { resolution, ...selectors } = resolveImageModel(catalogue)
  const references = input.references.map((materialUrl, index) => {
    let url: URL
    try { url = new URL(materialUrl) } catch { return invalid('Invalid reference URL') }
    if (!materialUrl.startsWith('https://') || /[\s\\]/.test(materialUrl) || materialUrl.includes('#')
      || url.protocol !== 'https:' || !url.hostname || url.username || url.password) invalid('Invalid reference URL')
    return { materialUrl, materialType: 'image', sortOrder: index + 1 }
  })
  const config = { ...selectors, duration: 1, resolution, ratio: '16:9', genNum: 1, backupModelList: [],
    prompt: text(input.prompt, 'prompt', true), style: 0, materialList: references, quality: '' }
  return { scriptId: positive(input.scriptId, 'script id'), assetName: text(input.assetName, 'asset name'),
    assetType: positive(input.assetType, 'asset type'), modelConfig: JSON.stringify(config), isLocal: 0, isGenerate: 1,
    ...(input.parentAssetId === undefined ? {} : { id: positive(input.parentAssetId, 'parent asset id') }) }
}

/**
 * Read the catalogue's display price for the image route.
 * @param catalogue - Live `taskType=2` catalogue.
 * @returns Display fields only; never a verified quote or spending authorization.
 */
export function readImageDisplayPrice(catalogue: unknown): Record<string, unknown> {
  const model = imageModelRow(catalogue)
  const { unitPrice, unit } = model
  if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice < 0
    || typeof unit !== 'string' || !unit.trim() || unit.length > 128 || !unit.isWellFormed()
    || /[\u0000-\u001f\u007f]/.test(unit)) return { status: 'unavailable', quote_verified: false }
  return { status: 'available', unit_price: unitPrice, unit, quote_verified: false }
}
```

Create `packages/jubian/jubian-api/src/subtitle.ts`:

```ts
/**
 * Subtitle erasure: the paid regional or automatic removal request.
 *
 * The regional route needs the pixel box the provider itself reports on the
 * child task, which is why the plugin reads the source snapshot in the same
 * call rather than trusting a caller-supplied rectangle.
 */
import { JubianError } from '@deepseek-ai/dsh-jubian'

function invalid(message: string): never { throw new JubianError('CONTRACT_CHANGED') }
function object(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${what} is not an object`)
  return value as Record<string, unknown>
}
function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(`Invalid ${field}`)
  return value
}

/** The two erasure models the provider exposes. */
export const SUBTITLE_ERASE_MODELS = ['quzimuToB', 'ark-erase-video-subtitle-pro'] as const
/** The model id that selects the automatic route. */
export const AUTOMATIC_ERASE_MODEL = 'ark-erase-video-subtitle-pro'

/** One erasure source as the caller states it. */
export interface SubtitleEraseInput {
  taskName: string
  firstResultId: number
  parentResultId: number
  videoUrl: string
  duration: number
  videoWidth: number
  videoHeight: number
  /** Required for the regional model; rejected for the automatic one. */
  subtitleBox?: { zimuLeft: number; zimuTop: number; zimuWidth: number; zimuHeight: number }
}

/**
 * Build the exact `/aigc/storyboard/subtitleEraser` body.
 * @param catalogue - Live `taskType=10` catalogue.
 * @param modelId - Explicit model selection; there is no fallback route.
 * @param input - Verified source identities, decoded geometry and optional pixel box.
 * @returns The wire body for one erasure task.
 */
export function buildSubtitleEraseRequest(catalogue: unknown, modelId: string, input: SubtitleEraseInput): Record<string, unknown> {
  if (modelId !== 'quzimuToB' && modelId !== AUTOMATIC_ERASE_MODEL) invalid('Unsupported erasure model')
  const automatic = modelId === AUTOMATIC_ERASE_MODEL
  if (!Array.isArray(catalogue)) invalid('Catalogue rows are absent')
  const matches = catalogue.map(row => object(row, 'Catalogue row')).filter(row => row.modelId === modelId)
  if (matches.length !== 1) invalid('Expected exactly one erasure model row')
  const model = matches[0]!
  const standardId = positive(model.id ?? model.standardId, 'standard id')
  if (model.platformId !== (automatic ? 'AI_MEDIA_KIT' : 'YU_DIAN')) invalid('Erasure platform differs from the model route')
  const width = positive(input.videoWidth, 'video width'), height = positive(input.videoHeight, 'video height')
  if (!Number.isFinite(input.duration) || input.duration <= 0) invalid('Invalid duration')
  if (typeof input.taskName !== 'string' || !input.taskName.trim() || !input.taskName.isWellFormed()
    || /[\u0000-\u001f\u007f]/.test(input.taskName)) invalid('Invalid task name')
  let url: URL
  try { url = new URL(input.videoUrl) } catch { return invalid('Invalid video URL') }
  if (!input.videoUrl.startsWith('https://') || /[\s\\]/.test(input.videoUrl) || input.videoUrl.includes('#')
    || url.protocol !== 'https:' || url.username || url.password) invalid('Invalid video URL')
  const payload: Record<string, unknown> = { firstResultId: positive(input.firstResultId, 'first result id'),
    parentResultId: positive(input.parentResultId, 'parent result id'), taskName: input.taskName, taskType: 10,
    videoUrl: input.videoUrl, standardId, platformId: model.platformId, modelId, videoStandardId: null,
    duration: input.duration }
  const box = input.subtitleBox
  if (automatic) {
    if (box !== undefined) invalid('The automatic route accepts no pixel box')
    return payload
  }
  if (!box || !Number.isSafeInteger(box.zimuLeft) || box.zimuLeft < 0
    || !Number.isSafeInteger(box.zimuTop) || box.zimuTop < 0
    || !Number.isSafeInteger(box.zimuWidth) || box.zimuWidth < 1
    || !Number.isSafeInteger(box.zimuHeight) || box.zimuHeight < 1
    || box.zimuWidth > width - box.zimuLeft || box.zimuHeight > height - box.zimuTop) invalid('Invalid pixel box')
  return { ...payload, zimuLeft: box.zimuLeft, zimuTop: box.zimuTop, zimuWidth: box.zimuWidth,
    zimuHeight: box.zimuHeight, videoWidth: width, videoHeight: height }
}

/**
 * Read the erasure task identity out of a submitted response.
 * @param value - The parsed response envelope.
 * @returns The task id as a string, or null when the two identity fields disagree or are absent.
 */
export function readSubtitleTaskId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  if (envelope.code !== 0 && envelope.code !== 200) return null
  if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return null
  const data = envelope.data as Record<string, unknown>
  const raw = [data.taskId, data.jobId].filter(id => id !== undefined && id !== null)
  if (!raw.length) return null
  const normalized = raw.map((id) => {
    const number = typeof id === 'string' && /^[1-9][0-9]*$/.test(id) ? Number(id) : id
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? String(number) : null
  })
  const first = normalized[0]
  return first && normalized.every(other => other === first) ? first : null
}
```

Create `packages/jubian/jubian-api/src/index.ts`:

```ts
/** Typed Jubian endpoint readers over the shared transport. */
export { MODEL_TASK_TYPES, readEpisodes, readModels, readScript } from './catalog.ts'
export { readAssetList, readAssetPage, readGeneratedImage, readMaterialList } from './asset.ts'
export type { AssetDetail, AssetRow, MaterialRow } from './asset.ts'
export { readSubtaskPage, readTaskList, readTaskPage } from './video.ts'
export type { SubtitleBox, VideoSubtask, VideoTask } from './video.ts'
export { readStoryboard, withGenerationDisabled, withGenerationEnabled } from './storyboard.ts'
export type { StoryboardView } from './storyboard.ts'
export { buildImageRequest, readImageDisplayPrice, resolveImageModel } from './image.ts'
export type { ImageModelSelectors, ImageRequestInput } from './image.ts'
export { AUTOMATIC_ERASE_MODEL, SUBTITLE_ERASE_MODELS, buildSubtitleEraseRequest, readSubtitleTaskId } from './subtitle.ts'
export type { SubtitleEraseInput } from './subtitle.ts'
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/jubian-api/tests/`
Expected: PASS，全部 5 个 spec 文件。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/jubian-api/src packages/jubian/jubian-api/tests
git commit -m "feat(jubian-api): add image and subtitle payload builders"
```

---

## Phase 3 — `@deepseek-ai/dsh-tool-jubian` 工具面

### Task 11: 方法实现层（纯函数）

**Files:**
- Create: `packages/jubian/tool-jubian/package.json`
- Create: `packages/jubian/tool-jubian/tsconfig.json`
- Create: `packages/jubian/tool-jubian/src/methods.ts`
- Create: `packages/jubian/tool-jubian/tests/methods.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/tool-jubian/tests/methods.spec.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { catalogMethod, imageGenerateMethod } from '../src/methods.ts'

const CATALOGUE = [{ id: 42, standardId: 42, modelId: 'gpt-image-2', platformId: 'YU_DIAN', unitPrice: 0.5, unit: '张',
  genTypes: [{ id: 7, type: 3 }], videoStandards: [{ id: 91, ratio: '16:9', resolution: '1K', width: 1280, height: 720 }] }]

function stubClient(handler: (request: { method: string; path: string; body?: Record<string, unknown> }) => unknown) {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = []
  return { calls, client: {
    request: async (request: { method: string; path: string; body?: Record<string, unknown> }) => {
      calls.push(request)
      return { transport: { http_status: 200, application_code: 200 }, response_sha256: 'sha256:' + 'a'.repeat(64),
        data: handler(request) }
    } } }
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-methods-')) })

describe('catalogMethod', () => {
  it('reads the model catalogue for the requested task type', async () => {
    const { client, calls } = stubClient(() => CATALOGUE)
    const result = await catalogMethod(client as never, { method: 'models', task_type: 2 })
    expect(calls[0]!.path).toBe('/model/charge/getSelectList?taskType=2')
    expect(result.models).toEqual(CATALOGUE)
  })

  it('rejects an unknown task type instead of guessing one', async () => {
    const { client } = stubClient(() => CATALOGUE)
    await expect(catalogMethod(client as never, { method: 'models', task_type: 9 })).rejects.toThrow()
  })
})

describe('imageGenerateMethod (收费写路径)', () => {
  it('records the intent before sending and settles it after', async () => {
    const ledger = new JubianLedger({ root })
    const { client, calls } = stubClient(request => request.path.includes('getSelectList')
      ? CATALOGUE : 83749)
    const result = await imageGenerateMethod(client as never, ledger, { method: 'image_generate',
      idempotency_key: 'k-1', script_id: 2708, asset_name: '陆沉舟', asset_type: 1, prompt: '一位中年男性' })
    expect(calls[0]!.path).toBe('/model/charge/getSelectList?taskType=2')
    expect(calls[1]!.method).toBe('POST')
    expect(calls[1]!.path).toBe('/aigc/asset')
    expect(result.outcome).toBe('accepted')
    expect(result.parent_asset_id).toBe(83749)
    const record = await ledger.find('k-1')
    expect(record?.outcome).toBe('accepted')
    expect(record?.http_status).toBe(200)
  })

  it('does not send a second request for a key that is already recorded', async () => {
    const ledger = new JubianLedger({ root })
    const first = stubClient(() => CATALOGUE)
    await imageGenerateMethod(first.client as never, ledger, { method: 'image_generate', idempotency_key: 'k-2',
      script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' })
    const second = stubClient(() => CATALOGUE)
    const replayed = await imageGenerateMethod(second.client as never, ledger, { method: 'image_generate',
      idempotency_key: 'k-2', script_id: 2708, asset_name: 'x', asset_type: 1, prompt: 'p' })
    expect(second.calls.length).toBe(0)
    expect(replayed.replayed).toBe(true)
  })

  it('requires an idempotency key', async () => {
    const ledger = new JubianLedger({ root })
    const { client } = stubClient(() => CATALOGUE)
    await expect(imageGenerateMethod(client as never, ledger, { method: 'image_generate', script_id: 1,
      asset_name: 'x', asset_type: 1, prompt: 'p' } as never)).rejects.toThrow(/idempotency/i)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/tool-jubian/tests/methods.spec.ts`
Expected: FAIL — 无法解析 `../src/methods.ts`

- [ ] **Step 3: 写实现**

Create `packages/jubian/tool-jubian/src/methods.ts`。导入与方法名以本节为准，**后续 Task 12 只追加、不改签名**：

本任务实现 `need`、`bodyHash`、`writeUnderLedger`、`catalogMethod`、`imageGenerateMethod` 五个导出；`readMethod`（21 个方法的总入口）在 Task 12 补齐。

```ts
/**
 * The 21 tool methods, as plain async functions over an injected client.
 *
 * Every write method takes the caller's `idempotency_key` and consults the
 * ledger before it sends anything: a key that already has a record returns
 * that record instead of a second paid request.
 */
import { createHash } from 'node:crypto'
import type { JubianClient, JubianLedger, JubianLedgerMethod } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { MODEL_TASK_TYPES, buildImageRequest, readImageDisplayPrice, readModels, resolveImageModel } from '@deepseek-ai/dsh-jubian-api'

/** Arguments as the tool layer receives them, already schema-validated. */
export interface MethodArgs {
  method: string
  idempotency_key?: string
  task_type?: number
  standard_id?: number
  script_id?: number
  page_num?: number
  page_size?: number
  asset_id?: number
  material_id?: number
  storyboard_id?: number
  task_id?: number
  asset_name?: string
  asset_type?: number
  prompt?: string
  references?: string[]
  parent_asset_id?: number
  content_duration_ms?: number
  model_id?: string
  task_name?: string
  first_result_id?: number
  parent_result_id?: number
  video_url?: string
  duration?: number
  video_width?: number
  video_height?: number
  subtitle_box?: { zimuLeft: number; zimuTop: number; zimuWidth: number; zimuHeight: number }
}

function need<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new JubianError('CONTRACT_CHANGED')
  return value
}

/** Hash a request body canonically so the ledger can tell two attempts apart. */
function bodyHash(body: Record<string, unknown> | undefined): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex')}`
}

/**
 * Run one write method under the ledger.
 * @param ledger - The two-phase ledger.
 * @param method - Tool method name.
 * @param body - The exact body about to be sent.
 * @param send - Performs the single request.
 * @param quoted - Optional quote snapshot taken before sending.
 */
export async function writeUnderLedger(
  ledger: JubianLedger,
  idempotencyKey: string | undefined,
  method: JubianLedgerMethod,
  body: Record<string, unknown> | undefined,
  send: () => Promise<{ transport: { http_status: number | null; application_code: number | null }
    response_sha256: string | null, data: unknown }>,
  quoted?: { amount?: string; standardId?: number; observedAt?: string },
): Promise<{ replayed: boolean; outcome: 'accepted' | 'unknown'; response_sha256: string | null; data: unknown }> {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  const existing = await ledger.find(idempotencyKey)
  if (existing !== undefined) {
    return { replayed: true, outcome: existing.outcome ?? 'unknown', response_sha256: existing.response_sha256, data: null }
  }
  await ledger.begin({ idempotencyKey, method, requestSha256: bodyHash(body),
    ...(quoted?.amount === undefined ? {} : { quotedAmount: quoted.amount }),
    ...(quoted?.standardId === undefined ? {} : { quoteStandardId: quoted.standardId }),
    ...(quoted?.observedAt === undefined ? {} : { quoteObservedAt: quoted.observedAt }) })
  try {
    const response = await send()
    const code = response.transport.application_code
    const http = response.transport.http_status
    const outcome = http !== null && http >= 200 && http < 300 && (code === 0 || code === 200) ? 'accepted' : 'unknown'
    await ledger.settle(idempotencyKey, { httpStatus: http, applicationCode: code,
      responseSha256: response.response_sha256, outcome })
    return { replayed: false, outcome, response_sha256: response.response_sha256, data: response.data }
  } catch (error) {
    await ledger.settle(idempotencyKey, { httpStatus: null, applicationCode: null, responseSha256: null, outcome: 'unknown' })
    throw error
  }
}

/**
 * `jubian_catalog.models` — read the account's model catalogue.
 * @param client - Jubian transport.
 * @param args - `task_type` must be 1 (video), 2 (image) or 10 (subtitle erasure).
 */
export async function catalogMethod(client: JubianClient, args: MethodArgs): Promise<Record<string, unknown>> {
  switch (args.method) {
    case 'models': {
      const taskType = need(args.task_type, 'task_type')
      if (![MODEL_TASK_TYPES.video, MODEL_TASK_TYPES.image, MODEL_TASK_TYPES.subtitleErasure].includes(taskType as 1 | 2 | 10)) {
        throw new JubianError('CONTRACT_CHANGED')
      }
      const result = await client.request({ method: 'GET', path: `/model/charge/getSelectList?taskType=${taskType}` })
      return { models: readModels(result.data) }
    }
    default:
      throw new JubianError('CONTRACT_CHANGED')
  }
}

/**
 * `jubian_video.image_generate` — **paid**: create or regenerate one asset image.
 * @param client - Jubian transport.
 * @param ledger - Two-phase ledger.
 * @param args - Requires `idempotency_key`, `script_id`, `asset_name`, `asset_type`, `prompt`.
 */
export async function imageGenerateMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs): Promise<Record<string, unknown>> {
  const catalogue = await client.request({ method: 'GET', path: `/model/charge/getSelectList?taskType=${MODEL_TASK_TYPES.image}` })
  const selectors = resolveImageModel(catalogue.data)
  const body = buildImageRequest({ scriptId: need(args.script_id, 'script_id'), assetName: need(args.asset_name, 'asset_name'),
    assetType: need(args.asset_type, 'asset_type'), prompt: need(args.prompt, 'prompt'),
    references: args.references ?? [], ...(args.parent_asset_id === undefined ? {} : { parentAssetId: args.parent_asset_id }) },
  catalogue.data)
  const price = readImageDisplayPrice(catalogue.data)
  const result = await writeUnderLedger(ledger, args.idempotency_key, 'image_generate', body,
    () => client.request({ method: args.parent_asset_id === undefined ? 'POST' : 'PUT', path: '/aigc/asset', body }),
    { ...(price.status === 'available' ? { amount: String(price.unit_price) } : {}),
      standardId: selectors.standardId, observedAt: new Date().toISOString() })
  return { replayed: result.replayed, outcome: result.outcome, response_sha256: result.response_sha256,
    parent_asset_id: result.data === null ? null : Number(result.data), resolution: selectors.resolution }
}
```

Create `packages/jubian/tool-jubian/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-tool-jubian",
  "description": "Jubian tools for the DeepSeek Harness",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^"
  },
  "dependencies": {
    "@deepseek-ai/dsh-jubian": "workspace:^",
    "@deepseek-ai/dsh-jubian-api": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-credentials": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^"
  }
}
```

Create `packages/jubian/tool-jubian/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": [
    "src"
  ],
  "references": [
    {
      "path": "../../../vendor/cordis"
    },
    {
      "path": "../../core/tools"
    },
    {
      "path": "../../credentials/credentials"
    },
    {
      "path": "../jubian"
    },
    {
      "path": "../jubian-api"
    }
  ]
}
```

- [ ] **Step 4: 安装并运行测试**

Run: `pnpm install --filter @deepseek-ai/dsh-tool-jubian`
Then: `npx vitest run packages/jubian/tool-jubian/tests/methods.spec.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/tool-jubian pnpm-lock.yaml
git commit -m "feat(tool-jubian): add ledger-guarded method layer"
```

---

### Task 12: 补齐其余 19 个方法

按 Task 11 已建立的三个形状各补一个函数，**不改动任何已有签名**：

**读方法**（形状同 `catalogMethod`，只调 `client.request` 再交给对应 reader）：

| 函数 | 端点 | reader |
|---|---|---|
| `rateMethod` | `/model/charge/{standard_id}` | 原样返回 `data` |
| `scriptMethod` | `/aigc/script/{script_id}` | `readScript` |
| `episodesMethod` | `/aigc/episode/list?scriptId=&pageNum=&pageSize=` | `readEpisodes` |
| `assetGetMethod` | `/aigc/asset/{asset_id}` | `readAssetPage` |
| `assetListMethod` | `/aigc/asset/list?scriptId=&pageNum=&pageSize=` | `readAssetList` |
| `materialsMethod` | `/aigc/material/list?scriptId=&isUsed=1&pageNum=1&pageSize=1000` | `readMaterialList` |
| `generatedImageMethod` | `/aigc/material/getGeneratedImageByAssetId?assetId=` | `readGeneratedImage` |
| `storyboardGetMethod` | `/aigc/storyboard/{storyboard_id}` | `readStoryboard` |
| `videoTaskMethod` | `/admin/aigc/video/task/{task_id}` | `readTaskPage` |
| `videoTasksMethod` | `/admin/aigc/video/task/list?scriptId=&taskType=1&pageNum=` | `readTaskList` |
| `videoSubtasksMethod` | `POST /admin/aigc/video/task/sub/list` body `{aigcVideoTaskId}` | `readSubtaskPage` |

**写方法**（形状同 `imageGenerateMethod`，一律经 `writeUnderLedger`）：

| 函数 | 端点 | ledger method | 备注 |
|---|---|---|---|
| `storyboardSaveMethod` | 先 GET 后 `PUT /aigc/storyboard` | `storyboard_save` | 体由 `withGenerationDisabled(snapshot)` 产出；**免费** |
| `storyboardGenerateMethod` | 先 GET 后 `PUT /aigc/storyboard` | `storyboard_generate` | 体由 `withGenerationEnabled(snapshot, content_duration_ms)` 产出；**收费** |
| `storyboardPostMethod` | `POST /aigc/storyboard` | `storyboard_create` | 体由调用方原样给出；本版不做体编译 |
| `eraseSubtitleMethod` | 先 GET subtask 再 `POST /aigc/storyboard/subtitleEraser` | `erase_subtitle` | 体由 `buildSubtitleEraseRequest` 编译；**收费** |
| `confirmCastingMethod` | `GET /aigc/material/confirm/{material_id}` | `confirm_casting` | **GET 有副作用**；体为 undefined |

- [ ] **Step 1: 为每个方法补一个最小测试**

在 `packages/jubian/tool-jubian/tests/methods.spec.ts` 追加（沿用同一个 `stubClient`）：

```ts
describe('read methods', () => {
  it('addresses each endpoint exactly once', async () => {
    const cases: [string, MethodArgs, string][] = [
      ['rate', { method: 'rate', standard_id: 42 }, '/model/charge/42'],
      ['script', { method: 'script', script_id: 2708 }, '/aigc/script/2708'],
      ['episodes', { method: 'episodes', script_id: 2708, page_num: 1, page_size: 20 },
        '/aigc/episode/list?scriptId=2708&pageNum=1&pageSize=20'],
      ['asset_get', { method: 'asset_get', asset_id: 83749 }, '/aigc/asset/83749'],
      ['asset_list', { method: 'asset_list', script_id: 2708, page_num: 1, page_size: 200 },
        '/aigc/asset/list?scriptId=2708&pageNum=1&pageSize=200'],
      ['materials', { method: 'materials', script_id: 2708 },
        '/aigc/material/list?scriptId=2708&isUsed=1&pageNum=1&pageSize=1000'],
      ['generated_image', { method: 'generated_image', asset_id: 83749 },
        '/aigc/material/getGeneratedImageByAssetId?assetId=83749'],
      ['storyboard_get', { method: 'storyboard_get', storyboard_id: 916953 }, '/aigc/storyboard/916953'],
      ['video_task', { method: 'video_task', task_id: 335343 }, '/admin/aigc/video/task/335343'],
      ['video_tasks', { method: 'video_tasks', script_id: 2708, page_num: 1 },
        '/admin/aigc/video/task/list?scriptId=2708&taskType=1&pageNum=1'],
      ['video_subtasks', { method: 'video_subtasks', task_id: 335343 }, '/admin/aigc/video/task/sub/list'],
    ]
    for (const [method, args, path] of cases) {
      const { client, calls } = stubClient(() => method === 'video_subtasks' ? { total: 0, rows: [] } : {})
      await readMethod(client as never, args)
      expect(calls.length).toBe(1)
      expect(calls[0]!.path).toBe(path)
      expect(calls[0]!.method).toBe(method === 'video_subtasks' ? 'POST' : 'GET')
    }
  })
})

describe('confirmCastingMethod (GET 有副作用)', () => {
  it('records the side effect under the ledger even though the verb is GET', async () => {
    const ledger = new JubianLedger({ root })
    const { client, calls } = stubClient(() => null)
    const result = await confirmCastingMethod(client as never, ledger,
      { method: 'confirm_casting', idempotency_key: 'k-9', material_id: 900 })
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.path).toBe('/aigc/material/confirm/900')
    expect(result.outcome).toBe('accepted')
    expect((await ledger.find('k-9'))?.method).toBe('confirm_casting')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/tool-jubian/tests/methods.spec.ts`
Expected: FAIL — `readMethod` / `confirmCastingMethod` 未导出

- [ ] **Step 3: 实现全部 19 个方法**

在 `packages/jubian/tool-jubian/src/methods.ts` 追加一个 `readMethod` 汇总入口与剩余函数，全部按上表实现。`confirmCastingMethod` 的实现要点：

```ts
/**
 * `jubian_asset.confirm_casting` — **state-changing GET**.
 *
 * The provider implements casting confirmation as a GET. It is not idempotent
 * in intent and must never be retried blindly, so it runs under the same
 * ledger as the paid writes.
 */
export async function confirmCastingMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs): Promise<Record<string, unknown>> {
  const materialId = need(args.material_id, 'material_id')
  const result = await writeUnderLedger(ledger, args.idempotency_key, 'confirm_casting', undefined,
    () => client.request({ method: 'GET', path: `/aigc/material/confirm/${materialId}` }))
  return { replayed: result.replayed, outcome: result.outcome, response_sha256: result.response_sha256 }
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/tool-jubian/tests/`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/jubian/tool-jubian/src/methods.ts packages/jubian/tool-jubian/tests/methods.spec.ts
git commit -m "feat(tool-jubian): implement all 21 endpoint methods"
```

---

### Task 13: Cordis 插件与 4 个工具注册

**Files:**
- Create: `packages/jubian/tool-jubian/src/index.ts`
- Create: `packages/jubian/tool-jubian/tests/tools.spec.ts`

- [ ] **Step 1: 写失败的测试**

Create `packages/jubian/tool-jubian/tests/tools.spec.ts`:

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/index.ts'

async function mount() {
  const ctx = new Context()
  const registered: { name: string; description: string }[] = []
  ctx.provide('tools', { register: (definition: { name: string; description: string }) => {
    registered.push({ name: definition.name, description: definition.description })
    return () => {}
  } })
  ctx.provide('credentials', { resolve: async () => ({ value: 'eyJhbGci.payload.sig' }) })
  await ctx.plugin({ apply, inject, name: 'tool-jubian' }, { ledgerRoot: await mkdtemp(join(tmpdir(), 'jubian-tools-')) })
  return registered
}

describe('tool registration', () => {
  it('registers exactly the four domain tools', async () => {
    const registered = await mount()
    expect(registered.map(entry => entry.name).sort()).toEqual(['jubian_asset', 'jubian_catalog', 'jubian_storyboard', 'jubian_video'])
  })

  it('states the paid and side-effecting nature in the description itself', async () => {
    const registered = await mount()
    const video = registered.find(entry => entry.name === 'jubian_video')!
    const storyboard = registered.find(entry => entry.name === 'jubian_storyboard')!
    expect(video.description).toContain('计费')
    expect(storyboard.description).toContain('计费')
    expect(registered.find(entry => entry.name === 'jubian_asset')!.description).toContain('副作用')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run packages/jubian/tool-jubian/tests/tools.spec.ts`
Expected: FAIL — 无法解析 `../src/index.ts`

- [ ] **Step 3: 写实现**

Create `packages/jubian/tool-jubian/src/index.ts`。

**这一层有三个不能商量的形状**（照 `packages/fs/tool-fs/src/read.ts:77-130` 的现有写法）：

1. 用 `defineTool`（来自 `@deepseek-ai/dsh-tools`），不是裸对象；
2. `output.schema` 是必填的原始 JSON Schema，`output.render(args, value)` 是必填的纯投影函数；
3. write 方法必须收到非空 `idempotency_key`，否则在出网前就失败。

**描述文案是这一层最关键的产物**：模型读的是 description，不是源码，所以收费与副作用必须在描述里写死。

```ts
/**
 * Jubian tools: one plugin row any DSH preset can mount.
 *
 * The tool descriptions carry the facts a model cannot infer from the schema:
 * which methods really cost money, which one changes provider state through a
 * GET verb, and that a timeout never means "safe to retry".
 *
 * The write methods require the caller's `idempotency_key`, so a retry after an
 * ambiguous outcome reuses the recorded attempt instead of paying twice.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JUBIAN_TOKEN_REF, JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import * as methods from './methods.ts'

export const name = 'tool-jubian'
export const inject = ['tools', 'credentials']

export interface Config {
  /** Directory holding the write ledger; defaults to `<DSH_HOME>/jubian/ledger`. */
  ledgerRoot?: string
  baseUrl?: string
  timeoutMs?: number
}

const WRITE_NOTE = '写方法必须提供 idempotency_key；同一 key 不会重复发送。'
  + '超时或结果未知时不要换 key 重试——先用同一个 key 再调一次，返回里的 replayed=true 表示这次没有发出新请求。'

/** Every argument across all 21 methods; each tool narrows `method` to its own set. */
const ARGS = {
  idempotency_key: { type: 'string', description: `写方法必填。同一次逻辑操作复用同一个值；读方法忽略。${WRITE_NOTE}` },
  task_type: { type: 'number', description: 'jubian_catalog.models 必填：1=视频，2=图片，10=去字幕。' },
  standard_id: { type: 'number', description: 'jubian_catalog.rate 必填：计价标准 ID。' },
  script_id: { type: 'number', description: '剧变项目 ID（scriptId）。' },
  page_num: { type: 'number', description: '分页页码，默认 1。' },
  page_size: { type: 'number', description: '分页大小，默认 20。' },
  asset_id: { type: 'number', description: 'jubian_asset.get / generated_image 必填：主体资产 ID。' },
  material_id: { type: 'number', description: 'jubian_asset.confirm_casting 必填：生成材质 ID（不是父资产、不是任务 ID）。' },
  storyboard_id: { type: 'number', description: 'jubian_storyboard.* 必填：分镜 ID。' },
  task_id: { type: 'number', description: 'jubian_video.task / subtasks 必填：视频任务 ID。' },
  asset_name: { type: 'string', description: 'jubian_video.image_generate 必填：资产名。' },
  asset_type: { type: 'number', description: 'jubian_video.image_generate 必填：平台资产类型数字，当前只有 1（角色）有证据。' },
} as const

export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const ledger = new JubianLedger({ root: config.ledgerRoot ?? join(home, 'jubian', 'ledger') })
  const client = new JubianClient({
    credential: async () => (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? '',
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  })
  /** One shared output contract: the canonical value is a JSON object, rendered as pretty text. */
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text',
      text: JSON.stringify(value, null, 2) }],
  } as const

  ctx.tools.register(defineTool({
    name: 'jubian_catalog',
    description: '剧变（Jubian）目录与项目只读查询：账户模型目录与报价、剧本、分集。全部只读，不产生任何费用。',
    parameters: {
      method: { type: 'string', required: true, enum: ['models', 'rate', 'script', 'episodes'],
        description: 'models=账户模型目录（task_type 选 1/2/10）；rate=单个计价标准；script=剧本身份；episodes=分集列表。' },
      task_type: ARGS.task_type, standard_id: ARGS.standard_id, script_id: ARGS.script_id,
      page_num: ARGS.page_num, page_size: ARGS.page_size,
    },
    output,
    execute: async (args: methods.MethodArgs) => methods.readMethod(client, args),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_asset',
    description: '剧变（Jubian）资产与材质查询，以及确认出演。get/list/materials/generated_image 只读。'
      + '**confirm_casting 有副作用**：它用 GET 动词改变了远端状态，会使该材质被本次制作采用，不要重试。'
      + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true, enum: ['get', 'list', 'materials', 'generated_image', 'confirm_casting'],
        description: 'get=单个资产（含 is_local/status）；list=项目资产分页；materials=主体设定材质；'
          + 'generated_image=该资产的生成图；confirm_casting=确认出演（有副作用）。' },
      script_id: ARGS.script_id, asset_id: ARGS.asset_id, material_id: ARGS.material_id,
      page_num: ARGS.page_num, page_size: ARGS.page_size, idempotency_key: ARGS.idempotency_key,
    },
    output,
    execute: async (args: methods.MethodArgs) => methods.readMethod(client, args),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_storyboard',
    description: '剧变（Jubian）分镜查询与提交。get/create/save 免费（save 强制 isGenerate=0）。'
      + '**generate 与 erase_subtitle 会真实计费且不可撤销**。'
      + 'generate 先读当前分镜快照再把 isGenerate 置 1 提交，因此必须同时给出 content_duration_ms，'
      + '且它必须与该分镜已保存的时长一致，否则会在发请求前失败。' + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true, enum: ['get', 'create', 'save', 'generate', 'erase_subtitle'],
        description: 'get=读分镜；create=用调用方给定的请求体新建（不做体编译）；save=存为不生成；'
          + 'generate=提交生成（计费）；erase_subtitle=去字幕（计费）。' },
      storyboard_id: ARGS.storyboard_id,
      content_duration_ms: { type: 'number', description: 'generate 必填：本包内容时长，4000–14000 的整千毫秒。' },
      model_id: { type: 'string', description: 'erase_subtitle 必填：quzimuToB（区域性，需 subtitle_box）或 ark-erase-video-subtitle-pro（自动）。' },
      task_name: ARGS.task_name, first_result_id: ARGS.first_result_id, parent_result_id: ARGS.parent_result_id,
      video_url: ARGS.video_url, duration: ARGS.duration, video_width: ARGS.video_width,
      video_height: ARGS.video_height, subtitle_box: ARGS.subtitle_box,
      body: { type: 'object', additionalProperties: true, description: 'create 必填：完整的远端请求体。' },
      idempotency_key: ARGS.idempotency_key,
    },
    output,
    execute: async (args: methods.MethodArgs) => methods.readMethod(client, args),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_video',
    description: '剧变（Jubian）视频任务查询与图片生成。task/tasks/subtasks 只读'
      + '（subtasks 用 POST 承载查询体，仍然只读）。'
      + '**image_generate 会真实计费且不可撤销**：它生成或重生成一张主体资产图；'
      + '给了 parent_asset_id 就走更新（PUT），否则新建（POST）。' + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true, enum: ['task', 'tasks', 'subtasks', 'image_generate'],
        description: 'task=单个任务；tasks=项目任务分页；subtasks=任务的子结果（含字幕框几何）；'
          + 'image_generate=生成图片（计费）。' },
      task_id: ARGS.task_id, script_id: ARGS.script_id, page_num: ARGS.page_num,
      asset_name: ARGS.asset_name, asset_type: ARGS.asset_type, prompt: ARGS.prompt,
      references: ARGS.references, parent_asset_id: ARGS.parent_asset_id,
      idempotency_key: ARGS.idempotency_key,
    },
    output,
    execute: async (args: methods.MethodArgs) => methods.readMethod(client, args),
  }))
}
```

**`ARGS` 必须写全 25 个字段**，上例只展开了前十个，其余按同一格式补齐（`asset_name` 是 `string`，别照抄上面的占位行）：

| 字段 | type | 说明 |
|---|---|---|
| `asset_name` | string | `image_generate` 必填：资产名 |
| `asset_type` | number | `image_generate` 必填：平台资产类型数字，当前只有 `1`（角色）有证据 |
| `prompt` | string | `image_generate` 必填：图片提示词 |
| `references` | array of string | `image_generate` 可选：有序参考图 HTTPS URL |
| `parent_asset_id` | number | `image_generate` 可选：给了就走更新 |
| `content_duration_ms` | number | `generate` 必填 |
| `model_id` | string | `erase_subtitle` 必填 |
| `task_name` | string | `erase_subtitle` 必填 |
| `first_result_id` | number | `erase_subtitle` 必填 |
| `parent_result_id` | number | `erase_subtitle` 必填 |
| `video_url` | string | `erase_subtitle` 必填 |
| `duration` | number | `erase_subtitle` 必填：源视频秒数 |
| `video_width` | number | `erase_subtitle` 必填 |
| `video_height` | number | `erase_subtitle` 必填 |
| `subtitle_box` | object | `erase_subtitle` 区域性擦除必填：`{zimuLeft,zimuTop,zimuWidth,zimuHeight}` |
| `body` | object | `create` 必填：完整远端请求体 |

`readMethod` 内部先按 `method` 分派；遇到写方法且 `idempotency_key` 缺失时抛错，**不要静默生成一个**。

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run packages/jubian/tool-jubian/tests/`
Expected: PASS。

- [ ] **Step 5: 全量类型检查与提交**

Run: `npx tsc -b tsconfig.host.json`
Expected: 无错误。**若报 `Referenced project must have setting "composite": true` 或找不到项目，检查 `tsconfig.host.json` 的 references 三条是否齐全。**

```bash
git add packages/jubian/tool-jubian/src/index.ts packages/jubian/tool-jubian/tests/tools.spec.ts
git commit -m "feat(tool-jubian): register the four Jubian tools"
```

---

## Phase 4 — 收尾

### Task 14: 文档

**Files:**
- Create: `packages/jubian/tool-jubian/README.md`

- [ ] **Step 1: 写 README**

必须覆盖（内容取自 spec §3–§7，不要另行推导）：

1. 挂载方式（preset 里的一行 `insert`）。
2. 凭证：键名 `JUBIANAI_ADMIN_TOKEN`；写入方式（环境变量或直接编辑 `$DSH_HOME/.credentials.yaml`）；**凭证层级**（进程环境 > `.credentials.yaml` > `<cwd>/.env` > `$DSH_HOME/.env`），以及"环境变量会盖过设置值并使其只读"这一条。
3. 21 个端点表，标注读/写、收费与否。
4. 4 个工具与各自的方法枚举。
5. 账本：位置 `$DSH_HOME/jubian/ledger/`、两阶段记录、`replayed` 语义。
6. 五个错误码及触发条件。
7. 明确声明：本包不含任何密钥，且不应把 `.credentials.yaml` 复制进仓库。

- [ ] **Step 2: 提交**

```bash
git add packages/jubian/tool-jubian/README.md
git commit -m "docs(tool-jubian): document endpoints, credentials and ledger"
```

### Task 15: 端到端验证

- [ ] **Step 1: 只读全链路**

Run: `$env:DSH_JUBIAN_LIVE='1'; npx vitest run packages/jubian/jubian/tests/live-read.spec.ts`
Expected: PASS。

- [ ] **Step 2: 全包测试**

Run: `npx vitest run packages/jubian/`
Expected: PASS，无 skip 之外的空洞。

- [ ] **Step 3: 类型检查**

Run: `npx tsc -b tsconfig.host.json`
Expected: 无错误。

- [ ] **Step 4: 确认 MUSE 未被触碰**

Run: `git status --porcelain packages/bundle/muse-product`
Expected: 空输出。

- [ ] **Step 5: 提交（如有残留改动）**

```bash
git add -A packages/jubian
git commit -m "chore(jubian): finalize packages"
```

---

## 风险与已知未完成项

1. **`create` 不做体编译。** `storyboardPostMethod` 原样转发调用方给出的体。理由：`buildStoryboardCreatePayload` 需要材料键与 prompt 内 `@[name](key)` 引用严格同序，移植它约 60 行且当前无调用方。需要时单独开任务。
2. **真实写路径未在自动化测试中验证。** `image_generate` / `generate` / `erase_subtitle` / `confirm_casting` 均为真实收费或改状态，默认测试套件不发起这些调用。首次真实使用应由人陪着跑一次，并读账本确认 `outcome`。
3. **端点形状来自静态代码提取。** Task 5 只验证了 `/model/charge/getSelectList` 一个端点。其余 20 个在首次真实调用时可能暴露字段名差异，届时修对应 reader 与它的 fixture，不要改 transport。
4. **`duration` 的语义。** 视频模型把 `duration` 设为 `contentMs/1000 + 1`（含一秒自然收束）。`withGenerationEnabled` 强制校验这一点，因此调用方传错时长会在出网前失败，而不是生成一段错长度的视频。
