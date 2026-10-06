# Muse Hongguo download tools

English | [中文](README.zh.md)

`hongguo_download_info` inspects source availability and declared episode counts. `hongguo_download` accepts several `seriesIds`; omitting `episodes` requests every episode. The default `legacy` mode uses the supplied complete `Hongguo Downloader/app` directory and its original API. Real multi-series acceptance requires successful downloads and media validation; having the source files alone does not establish it.

The downloader requires a declared count and consecutive episode numbers from 1 to N, requests media URLs in batches of five, and retains every batch. It checks response lengths and source-declared sizes, decrypts encrypted tracks through the original offline modules, inspects playable streams with ffprobe, fully decodes every video with ffmpeg, and computes final SHA256 digests. It publishes the batch directory and `download-manifest.json` only when every requested file has passed. Failure or cancellation waits for owned work to stop and removes files created by that call. Muse uses the initiating session's workspace, defaults to `downloads`, and refuses paths outside that workspace or through child symlinks. Results contain final paths and digests; signed URLs, device fields, cookies, signing responses, keys and tokens remain private.

`complete: true` means the downloaded episode numbers cover the source's declared 1–N list. Successful downloads report `fullDecodeChecked: true` and `validationLevel: 'ffprobe-full-decode-sha256'`. Every source mode requires configured ffmpeg and ffprobe; encrypted originals also require the compatible Python runtime and offline modules. Missing runtimes, HLS, unsupported encryption, HTML responses and truncated files fail explicitly. The plugin does not merge or transcode episodes. Desktop keeps the decryption bridge outside ASAR for the external interpreter.

## Configuration

Muse presets include the tools. Standalone profiles can install the tarball using `dsh plugin --profile headless add /absolute/path/muse-hongguo-download-0.1.1.tgz`.

| Field | Default | Purpose |
| --- | --- | --- |
| `sourceMode` | `legacy` | Original API; `manifest` uses the repair source's authorized catalog; `public` explicitly selects the official public player |
| `legacyAppDir` | Empty | Absolute original `app` directory containing `config.json`, `devices.json`, signer assets and offline modules |
| `signServer` | Empty | Original local signer at `http://127.0.0.1:port`, accessed through `/sign`; signer software is not bundled |
| `signTokenEnv` | `MUSE_HONGGUO_SIGN_TOKEN` | Environment variable name; the token is read only at runtime |
| `pythonExecutable` | Empty | Absolute CPython 3.11 executable with PyCryptodome for the original encrypted-media modules |
| `ffmpegExecutable` / `ffprobeExecutable` | Empty / Empty | Absolute media executables for complete decoding and stream inspection |
| `catalogPath` | Empty | Absolute local JSON catalog using the repair source's `HG_SOURCE_CATALOG` format |
| `outputRoot` | Empty | Explicit standalone-client workspace; Muse uses the initiating session's workspace |
| `mediaUserAgent` | `Mozilla/5.0 (Linux; Android 12)` | Video request identity; original-source media requests omit the website Referer and session credentials |
| `retryDelayMs` | 1500 | Delay before another download attempt; legacy retries fetch a fresh video model for that episode |
| `mediaHosts` | `*.qznovelvod.com`, `*.douyinvod.com`, `*.pkoplink.com`, `*.bdcgslb.com` | Allowed source media and observed CDN redirect domains, revalidated on every redirect |
| `mediaPorts` | 443, 9305 | Allowed HTTPS media ports; pages and source APIs always use 443 |
| `maxSeries` / `maxEpisodes` | 10 / 200 | Series per call / episodes per series |
| `concurrency` / `retries` | 3 / 2 | Downloads per batch / transient network retries |
| `requestTimeoutMs` / `downloadTimeoutMs` / `callTimeoutMs` | 20000 / 600000 / 7200000 | Source request / episode download / whole call timeout |
| `maxResponseBytes` / `maxEpisodeBytes` | 8388608 / 1073741824 | Metadata response / episode size limits |
| `mediaProcessGraceMs` | 1000 | Grace period before forcing an owned media process to stop |

The original source must return a declared episode count matching its full list. A missing or mismatched count fails explicitly. Manifest completion covers only the supplied authorized catalog and does not establish Hongguo platform coverage. Public mode must be selected explicitly; unavailable episodes fail a full-series request rather than silently substituting previews. Missing original source files likewise never trigger another source mode.

The original runtime includes `config.json`, `devices.json`, `sign/unidbg-sign.jar`, the two `capture/fq_oversea` signer assets, and five offline `.pyc` modules under `frida`. The signer needs Java 17 and the original `com.hongguo.sign.FqTrace serve` entry with its working directory set to `app/sign`. Set its `BIND_HOST` to `127.0.0.1`; the plugin accepts only an explicit `http://127.0.0.1:port` address. Its `HG_SIGN_TOKEN` must match the value available through `signTokenEnv`. The plugin does not start or expose the signer.

Encrypted tracks use the supplied offline modules through [python/decrypt.py](python/decrypt.py). They require actual CPython 3.11 and PyCryptodome; newer Python versions cannot import these bytecode files. This operation uses the media model's key material and the downloaded file locally, without Android or ADB. The bridge passes private fields only through stdin and suppresses original module diagnostics. Unsupported encryption versions or failed media validation abort the batch.

The bundled patch reads `MUSE_HONGGUO_LEGACY_APP_DIR`, `MUSE_HONGGUO_SIGN_SERVER` and `MUSE_HONGGUO_PYTHON_PATH`; it takes media paths from `DSH_FFMPEG_PATH` / `DSH_FFPROBE_PATH`, with `FFMPEG_PATH` / `FFPROBE_PATH` as alternatives. Original source configuration, Java/JAR programs, bytecode modules, session data and tokens are excluded from the tarball. [SOURCE.json](SOURCE.json) records source fingerprints and the compatible Muse host version.

## Validation

Run `npm test` and `npm run check` in the plugin directory. Run `python3.11 -B -m unittest discover -s tests -p test_decrypt_bridge.py` for the bridge; these tests create isolated bytecode fixtures and never load the user's original modules or make platform requests. `node scripts/pack.mjs --out /absolute/output/directory` produces a tarball. Original-source acceptance must download at least two complete declared lists and fully decode every requested episode. Run `npm run test:live` from this workspace with `MUSE_HONGGUO_LIVE_IDS` containing at least two comma-separated real series IDs and the documented source/runtime environment settings; it uses the real managed subprocess provider and writes `live-evidence.json`. Public previews and authorized catalogs must be recorded separately from original-source multi-series acceptance.
