---
description: "Store one work's source material and scripts — a 红果 drama's videos and transcription materials, or a 番茄/七猫 novel and its screenplay — in platform and date folders on Volcengine TOS without overwriting or deleting remote objects."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-drama-tos-upload

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-tool-drama-tos-upload` registers the model-facing `drama_tos_upload` tool. One call stores one work's files under `<rootFolder>/<platform>/<YYYYMMDD>/<work_id>/<kind>/<name>`: a 红果 drama's videos and transcription materials, or a 番茄/七猫 novel and its screenplay in a Volcengine TOS bucket, checks every stored object against the local size and SHA-256, writes a manifest, and returns public URLs. It never replaces an existing object with different bytes and never deletes a remote object; it deletes the local copies only when asked and only after every object is verified.

## Table of Contents

- [Use this package](#use-this-package)
- [Write safety](#write-safety)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose the plugin in a deployment that has TOS credentials, such as the cloud transcription host. It is classified as optional and is not in the Desktop default composition.

```yaml
- name: '@deepseek-ai/dsh-tool-drama-tos-upload'
  config:
    accessKeyIdRef: VOLCENGINE_ACCESS_KEY_ID
    secretAccessKeyRef: VOLCENGINE_SECRET_ACCESS_KEY
```

Both credential references are required and resolve through the Host `credentials` service when a call starts; a missing service or value fails the call with `TOS_UPLOAD_UNCONFIGURED`. The location defaults are the owner's 2026-11-15 choice: bucket `muse` in `cn-beijing`, endpoint `tos-cn-beijing.volces.com`, public origin `https://muse.tos-cn-beijing.volces.com`, root folder `download-video-date`, and `Asia/Shanghai` for the default folder date. `endpoint` must be `tos-<region>.volces.com` or the in-region `tos-<region>.ivolces.com`. Invalid location fields fail at plugin load.

| Field | Default | Bound |
| --- | --- | --- |
| `maxFiles` | 400 | 1–2000 files per call |
| `maxFileBytes` | 1 GiB | up to 5 GiB per file |
| `maxTotalBytes` | 20 GiB | up to 200 GiB per call |
| `partSizeBytes` | 20 MiB | 5 MiB–1 GiB |
| `taskNum` | 2 | 1–16 parallel parts per file |
| `maxRetryCount` | 2 | 0–10 SDK retries per request |
| `requestTimeoutMs` | 300000 | 1000–1800000 |
| `connectionTimeoutMs` | 10000 | 100–60000 |

The tool takes `platform` (`hongguo`, `fanqie` or `qimao`), `work_id` (the work's numeric id on that platform), optional `title` and `date` (`YYYYMMDD`), `files` (absolute `path`, `kind` of `video`, `novel`, `asr`, `ocr`, `observations` or `scripts`, optional object `name`) and optional `remove_local`.

<a id="write-safety"></a>
## Write safety

- Every key is built from validated parts below `<rootFolder>/<platform>/<date>/<work_id>/`. Object names cannot be empty, start with `.`, contain `/`, `\` or control characters, or exceed 200 UTF-8 bytes.
- Local inputs must be regular files; directories and symbolic links are rejected before any remote request.
- Uploads and the manifest put set TOS `forbidOverwrite`. An existing key with the same size and recorded SHA-256 is reported as `already_present`; any other existing key fails with `TOS_UPLOAD_CONFLICT`.
- After each upload a `HeadObject` must report the local size and SHA-256, otherwise the call fails with `TOS_UPLOAD_UNVERIFIED`. The SDK also checks CRC64 during transfer.
- The binding has no delete operation. Local deletion runs only when `remove_local` is true, after the manifest is stored; a failed deletion is reported in `kept_local`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/upload.ts` resolves the request into a plan (validation, keys, local SHA-256) without remote access, then executes it against the `TosUploadClient` interface. `src/tos-client.ts` binds that interface to `@volcengine/tos-sdk@2.9.1` and maps SDK failures to coded `HarnessError`s without echoing request details. `src/index.ts` validates configuration at load, resolves credentials per call and registers the tool. The manifest key is `manifest-<UTC timestamp>.json` so repeated calls never replace an earlier manifest. The manifest records the platform, work id, title, bucket, date, directory, creation time and each object's kind, key, size, SHA-256 and upload status, so a consumer such as the data station's job API can register a work's files from the manifest URL alone.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Credentials](../../credentials/credentials/README.md) — Host-owned credential references and secret resolution.
- [Character library TOS reads](../character-library-tos/README.md) — the read-only TOS provider for reviewed character references.

-----

<a id="model-experience"></a>
## Model Experience

### Drama media upload

#### What the model sees

When composed, the model sees the `drama_tos_upload` definition, whose description names the configured key layout. A successful call returns one JSON object with the bucket, date, folder key and URL, one row per object (kind, local path, key, URL, bytes, SHA-256, status), the manifest key and URL, and the local cleanup outcome; failures carry a `TOS_UPLOAD_*` code and a Chinese message naming the file or key. The description with the default `rootFolder` is:

##### Tool description

```markdown
把一部作品的原始素材和剧本存到 TOS：红果剧的原片和转写材料，或番茄、七猫小说的原文和改成的剧本。位置是 download-video-date/{platform}/{日期}/{work_id}/{kind}/{文件名}，文件公开可读，返回每个文件的公开地址和本次清单。远端已有同名同内容的文件记为已存在，同名不同内容的不会覆盖；不会删除远端文件。remove_local 为 true 时，全部文件核对成功后才删除这些本地文件。
```

#### Token effect

The definition adds a fixed schema to each request where the tool is offered. Each result grows by one row per file, so a 65-episode upload with transcripts returns a few hundred rows.

#### KV Cache effect

The definition text depends only on configuration, so it stays stable across turns. Results are ordinary tool results appended after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not composed yet** — no shipped profile selects the plugin; the cloud transcription composition will add it with its credential references.
- **Public objects** — the owner chose public storage on 2026-11-15. The `muse` bucket allows anonymous reads of any key, and keys are built from public 红果 ids, so anyone who learns a key can download the object.
- **Unscoped deployment key** — the owner chose the existing bucket key, which can write the whole bucket. The tool only writes below its prefix and never deletes, but the key itself is not limited to that prefix.
- **No resume across calls** — an interrupted multipart upload is not resumed; calling again uploads the file from the start.
- **Three platforms** — `hongguo`, `fanqie` and `qimao` only. Douyin downloads are stored by the data station itself, not through this tool.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The design and the owner's storage decisions are recorded in the daily hit-transcription loop design (`.artifacts/daily-hit-transcription-loop-design-20261115.md` in the maintainer checkout). Remote cleanup is expected from bucket lifecycle rules, never from this tool.

</details>
