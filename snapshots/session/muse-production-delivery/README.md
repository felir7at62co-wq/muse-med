---
description: "Keyless verification of production source publication and pending-review preparation."
kind: "reference"
---

# Production source-manifest delivery

English | [中文](README.zh.md)

The shipped Headless profile uses the ordinary Loader and real `drama_shot`, `muse_production` and `drama_render` tools. Only the external Jubian transport and its credential lookup are replaced with controlled fixture data; no model or paid generation endpoint is contacted.

The four recorded calls initialize the configured video selection, apply an authored saved plan, repeat the same apply, and prepare the selected media. The first apply saves one native card using one free POST and one free PUT, reads back its selected image identities, then publishes `episode_packages/01/package.json`. The repeated apply returns `unchanged`, retaining identical manifest bytes without repeating either remote write.

`workspace.expected/` is an independently authored complete filesystem oracle. It checks the source manifest, native receipt, selected picture and audio, copied subtitles, prepared timeline, pending review and provider write counts. A case-local expected copy expands only the two source paths and independently synthesizes the declared silent PCM; no large WAV is committed. The manifest declares `mode: advisory` and `media_acceptance: false`.

Preparation permits a pending review. The assertion binds the real prepared sources to the published package hash, checks the selected picture and subtitle bytes and the three-second 48 kHz mono PCM samples, retains the pending review, and requires no final export. The existing renderer boundary tests cover strict refusal at delivery. The source is a three-second, 144×256, 24 fps H.264 color card with silent AAC audio made from FFmpeg `color` and `anullsrc`; it contains no user media, dialogue or text. Both FFmpeg and FFprobe must be on the test process PATH. The independent expected PCM uses the same executable version for its container header, not the product's master-building function or the actual output bytes.

`session.v4.jsonl` remains replay input; refresh writes actual results to `writer.expected.jsonl` and the prompt/schema sidecars. It never rewrites the independent workspace oracle. The case normalizes only the returned manifest path's operating-system separators. The fixture restores the original credential resolver and fetch transport on disposal.

Refresh this case with `pnpm run test:snapshot:refresh snapshots/session/headless.snapshot.ts -t muse-production-delivery`, review every resulting diff, then replay with `pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t muse-production-delivery`. On PowerShell, set `$env:DSH_SNAPSHOT='refresh'` and run the `test:snapshot` command instead; use `Remove-Item Env:DSH_SNAPSHOT` before replay. Controlled provider data proves publication and preparation, not media quality, source approval or completed delivery.
