---
description: "Let a transcription worker claim a 红果 hit from the data station's job queue, report progress, register stored videos and publish the finished screenplay."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-hit-queue

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-hit-queue` registers the model-facing `drama_hit_queue` tool for the daily hit-transcription loop. A worker Session claims one 红果 drama from the data station's job queue, sends progress and heartbeats, registers the videos it stored with `drama_tos_upload` by their manifest URL, and publishes the checked screenplay or reports failure. The data station owns selection, leases, retries and the member-facing stock board; this package only calls its service API.

## Table of Contents

- [Use this package](#use-this-package)
- [Request safety](#request-safety)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose the plugin in the cloud transcription deployment, next to `drama_tos_upload`. It is classified as optional and is not in the Desktop default composition.

```yaml
- name: '@deepseek-ai/dsh-tool-hit-queue'
  config:
    tokenRef: MUSE_DATA_SERVICE_TOKEN
```

`tokenRef` is required and resolves the station service token through the Host `credentials` service when a call starts; a missing service or value fails the call with `HIT_QUEUE_UNCONFIGURED`. `baseUrl` defaults to `http://127.0.0.1:19617/api/service/hits`, the station on the same host. `manifestOrigin` defaults to `https://muse.tos-cn-beijing.volces.com`. `requestTimeoutMs` defaults to 60000 (1000–300000), `maxResponseBytes` to 4 MiB (1 KiB–32 MiB), and `maxScriptBytes` to 20 MiB, the station's own limit. An invalid `baseUrl` or `manifestOrigin` fails at plugin load.

| Action | Station request | Required fields |
| --- | --- | --- |
| `claim` | `POST /claim` as `muse-worker-<session id>` | none; `work_id` claims a named work |
| `status` | `GET /jobs/:workId` | `work_id` |
| `progress` | `POST /jobs/:workId/progress`; only `lease` is a heartbeat | `work_id`, `lease` |
| `videos` | `PUT /jobs/:workId/videos` with the manifest as `upload` | `work_id`, `lease`, `manifest_url` |
| `publish` | `POST /jobs/:workId/script` as multipart | `work_id`, `lease`, `script_path`, `checks_passed` |
| `fail` | `POST /jobs/:workId/fail` | `work_id`, `lease`, `reason` |

<a id="request-safety"></a>
## Request safety

- The token travels only in the `X-Muse-Data-Service-Token` header, which also passes the public `/data/` proxy. Redirects are refused.
- `work_id` must be a 红果 `series_id`, optionally prefixed with `hongguo:`, and is URL-encoded in the path.
- `manifest_url` must lie directly under `manifestOrigin` without a query or fragment. The manifest must be a version 1 `hongguo` manifest whose `work_id` equals the call's `work_id`; its bucket, date, directory and objects are validated before the station sees them.
- `script_path` must be an absolute regular `.docx`, `.md`, `.txt` or `.pdf` file within `maxScriptBytes`; the check runs before any request.
- Station errors keep the HTTP status as the code (`HIT_QUEUE_UNAUTHORIZED`, `_NOT_FOUND`, `_CONFLICT`, `_REJECTED`, `_FAILED`) and quote at most 300 characters of the station's message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/station.ts` sends bounded JSON or multipart requests and maps responses. `src/manifest.ts` reads a `drama_tos_upload` manifest and builds the station's `upload` payload; the object key comes from the manifest URL, not from the manifest body. `src/index.ts` validates configuration at load, resolves the token per call, derives the worker id from the calling Session and registers the tool. The station contract is `docs/hit-transcription.md` in the data station repository.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Drama TOS upload](../tool-drama-tos-upload/README.md) — stores the videos and writes the manifest this tool registers.
- [Credentials](../../credentials/credentials/README.md) — Host-owned credential references and secret resolution.

-----

<a id="model-experience"></a>
## Model Experience

### Hit queue tool

#### What the model sees

When composed, the model sees the `drama_hit_queue` definition with one `action` and the fields above. Each successful call returns `{ action, result }`, where `result` is the station's JSON answer: a `{ job, lease }` pair for `claim`, the `Job` record for the other actions, and `{ job, script }` for `publish`. Failures carry a `HIT_QUEUE_*` code and a Chinese message. The description is:

##### Tool description

```markdown
数据站爆款转写任务队列。claim 领取一部待转写的红果剧（不填 work_id 取队首），返回任务和租约 lease；之后每一步都带上 work_id 和 lease。progress 上报阶段和第几集，也作心跳，至少每 30 分钟一次；videos 用 drama_tos_upload 返回的 manifest.url 登记原片；publish 上传通过程序检查的剧本并发布；fail 报告失败，检查重写后仍不过时设 needs_attention。status 查询任务。
```

#### Token effect

The definition adds a fixed schema to each request where the tool is offered. Each result is one station `Job` record, a few hundred tokens.

#### KV Cache effect

The definition text is fixed, so it stays stable across turns. Results are ordinary tool results appended after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not composed yet** — no shipped profile selects the plugin; the cloud transcription composition will add it with its token reference.
- **红果 only** — the station queue holds 红果 dramas; novel and Douyin work does not go through this tool.
- **The model carries the lease** — the lease from `claim` must be passed back on every later call; the tool keeps no per-Session lease state.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The loop design is `.artifacts/daily-hit-transcription-loop-design-20261115.md` in the maintainer checkout. The Main Session router does not call this tool; each dispatched worker claims its own work, so the router stays dispatch-only.

</details>
