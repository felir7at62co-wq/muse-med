# Agent Note: Jubian image generation pins its catalogue row and reads the asset back

Status: implemented

English | [中文](2026-09-19-jubian-image-row-pin-and-active-readback.zh.md)

## Problem

Three defects met in one call, `jubian_video image_generate`, and together they made the paid image route unusable against the live account.

`resolveImageModel()` filtered the `taskType=2` catalogue for `modelId === 'gpt-image-2'` and required `matches.length === 1`, throwing `CONTRACT_CHANGED` otherwise. The account lists that model id twice: row `66` on platform `KU_AI` at 0.12 CNY per image, and row `76` on `DUO_YUAN_TAN_SUO` at 1.05 CNY per item. No request body could be built at all, so the failure happened before the paid write — the safe half of the defect, and the reason it surfaced as a contract error rather than a wrong charge.

`readGeneratedImage()` required a non-array object and read `url`/`materialUrl` plus `materialId`. The endpoint `GET /aigc/material/getGeneratedImageByAssetId?assetId=N` answers with a list whose rows carry the material as `id` and the file as `assetUrl`, so the reader threw on the first step and, even had it passed, would have found no URL. That endpoint is the only free read that returns both the material id and the image URL.

`POST /aigc/asset` is asynchronous. Its response carries the new asset id; the image appears only once the asset reaches `hsAssetStatus === "Active"`, measured at one to two minutes later. `image_generate` returned neither the material id nor a URL and did not wait, so a caller that saved the result saved an empty asset while the result looked successful.

## Decision

**The catalogue row is a deployment choice, and an ambiguous catalogue fails.** `resolveImageModel()`, `buildImageRequest()` and `readImageDisplayPrice()` take an `ImageModelSelection` — `platformId`, `standardId`, or both — and accept the catalogue only when that selection leaves exactly one `gpt-image-2` row. Otherwise they throw `CONTRACT_CHANGED` with a message naming every candidate's `platformId`, `standardId`, unit price and unit. `dsh-tool-jubian` supplies the selection from its `imagePlatformId` and `imageStandardId` config fields; neither has a default. The tool result echoes the row actually bought from as `model_selection: { standard_id, platform_id }`, and the ledger's quote is that row's own unit price.

**The generated-image reader accepts both payload forms.** A list is read from its first row; a single object still reads. The URL is `assetUrl ?? url ?? materialUrl` and the material id is `id ?? materialId`. An empty list fails, because the caller asked for an image the asset does not have yet.

**`image_generate` reads its asset back to `Active` before it returns anything.** After an accepted write it polls the free `GET /aigc/asset/{id}` until `hsAssetStatus` is `Active`, then reads the generated image, and returns `parent_asset_id`, `model_selection`, `asset_status`, `material_id`, `image_url`, `observed_asset_status`, `waited_ms`, `readback_error` and a `next` line. `asset_status` is one of `active`, `timeout`, `failed`, `replayed` or `unverified`; only `active` means the image exists and is safe to save or review. The budget is the `imageActiveTimeoutMs` config field, defaulting to 180000 ms, polled every `imageActivePollMs` (default 3000 ms), and both are injectable in tests so the timeout path costs no wall clock.

## Why a timed-out readback is a state and not an exception

A readback that runs out of budget leaves the paid write accepted: the envelope code was a success code, the ledger holds an `accepted` settle line, and the asset exists. Throwing there would report a completed charge as a failed call, and the caller's next move — a new `idempotency_key` — is exactly the mistake the ledger exists to prevent. The timeout is therefore returned as `asset_status: timeout` with `readback_error` naming what was and was not established, `material_id` and `image_url` left `null`, and a `next` line that forbids a new key. `replayed` and `unverified` are separated from it because they are different facts: the first sent and read nothing, the second could not even name the asset to read.

## Alternatives considered

**Default to the lowest unit price.** It would let the route work with no configuration on this account, and 0.12 is cheaper than 1.05. It lost because the two rows are different platforms selling different products, and an operator who never named one would be spending real money on it; a default also has to survive the next account whose rows are priced the other way round. The same reasoning rejects "take the first row" and "take the row the provider lists last": catalogue order is not a contract.

**Accept every row and let the provider decide.** This was the pre-fix state in spirit — the selectors exist precisely because a stale or arbitrary pair produces a request the provider rejects after the caller believes it succeeded.

**Return at acceptance and document "poll it yourself".** Fewer moving parts inside the tool, and it is what `upscale` and `erase_subtitle` do. It lost because `image_generate`'s result is unusable without the readback: the caller has no material id to pass to `confirm_casting` and no URL, which is the third defect restated.

**Wait without a deadline.** A tool call has to terminate; the budget is configuration because provider latency is the deployment's own observation.

**Throw a dedicated error on timeout.** Rejected for the reason above; a distinct `JubianError` code would also have had to describe a state in which the money was already spent and the ledger already agreed.

**Read the generated image after a fixed status poll instead of a loop.** The image row can lag the status it belongs to, and a single read would turn that lag into a hard failure; the loop retries the image read while the budget lasts.

**Require a material id argument instead of taking the first list row.** No current consumer needs to choose among an asset's generated images, and inventing the argument would be a public surface without a caller.

## Consequences

The paid image route completes against the live account: one `POST` (or `PUT`) followed by free reads, returning the material id `confirm_casting` takes and the URL a vision check can fetch. A price can no longer be attributed to the wrong platform, because the quote and the result both name the row.

The cost is a configuration obligation. An account whose catalogue lists a second `gpt-image-2` row turns `image_generate` into a loud configuration error until `imagePlatformId` or `imageStandardId` is set — deliberate, since the alternative spends money on an unnamed platform, and recorded in both package READMEs as a known limitation. A tool call can also now stay open for up to `imageActiveTimeoutMs`, which is the one place this package blocks on an asynchronous provider stage; a timeout still leaves the caller with a read to do.

`packages/jubian/jubian-api/tests/image.spec.ts` pins the multi-row refusal, the candidate list and the per-row quote, `packages/jubian/jubian-api/tests/asset.spec.ts` pins both payload forms of the generated-image read and the empty list, and `packages/jubian/tool-jubian/tests/methods.spec.ts` pins the poll to `Active`, the timeout state with no second paid write, the refusal to send without a pinned row, and the echoed `model_selection`.

## Related

- [Jubian storyboard isGenerate is not a gate](2026-09-19-jubian-storyboard-isgenerate-not-a-gate.md) — the other measured difference between this provider version and the captured contract.
