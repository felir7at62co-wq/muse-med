# Muse Hongguo download tools

English | [中文](README.zh.md)

`hongguo_download_info` inspects source availability and declared episode counts. `hongguo_download` accepts several `seriesIds`; omitting `episodes` requests every episode. The default `legacy` mode uses the supplied complete `Hongguo Downloader/app` directory and its original API. Real multi-series acceptance requires successful downloads and media validation; having the source files alone does not establish it.

The downloader requires a declared count and consecutive episode numbers from 1 to N, requests media URLs in batches of five, and retains every batch. It checks response lengths and source-declared sizes, decrypts encrypted tracks through the original offline modules, inspects playable streams with ffprobe, fully decodes every video with ffmpeg, and computes final SHA256 digests. It publishes the batch directory and `download-manifest.json` only when every requested file has passed. Failure or cancellation waits for owned work to stop and removes files created by that call. Muse uses the initiating session's workspace, defaults to `downloads`, and refuses paths outside that workspace or through child symlinks. Results contain final paths and digests; signed URLs, device fields, cookies, signing responses, keys and tokens remain private.

`complete: true` means the downloaded episode numbers cover the source's declared 1–N list. Successful downloads report `fullDecodeChecked: true` and `validationLevel: 'ffprobe-full-decode-sha256'`. Every source mode requires configured ffmpeg and ffprobe; encrypted originals also require the compatible Python runtime and offline modules. Missing runtimes, HLS, unsupported encryption, HTML responses and truncated files fail explicitly. The plugin does not merge or transcode episodes. Desktop keeps the decryption bridge outside ASAR for the external interpreter.

## Configuration

Muse Desktop includes the local Java 17, CPython 3.11, PyCryptodome, signer assets and offline modules. The first source request creates one private device using the original generator and starts the authenticated loopback signer automatically. Standalone profiles can install the tarball using `dsh plugin --profile headless add /absolute/path/muse-hongguo-download-0.1.2.tgz`.

| Field | Default | Purpose |
| --- | --- | --- |
| `sourceMode` | `legacy` | Original API; `manifest` uses the repair source's authorized catalog; `public` explicitly selects the official public player |
| `legacyAppDir` | Empty | Absolute original `app` directory containing `config.json`, `devices.json`, signer assets and offline modules |
| `signServer` | Empty | Original local signer at `http://127.0.0.1:port`, accessed through `/sign`; an explicit value selects an externally managed signer |
| `signTokenEnv` | `MUSE_HONGGUO_SIGN_TOKEN` | Environment variable name; the token is read only at runtime |
| `pythonExecutable` | Empty | Absolute CPython 3.11 executable with PyCryptodome for the original encrypted-media modules |
| `javaExecutable` | Empty | Absolute Java 17 executable used when `signServer` is omitted |
| `bootstrapDevices` / `deviceBootstrapTimeoutMs` | false / 30000 | Initialize one private device from the pinned original generator / initialization deadline; Desktop enables initialization |
| `signerStartupTimeoutMs` / `signerHeapMb` | 120000 / 1024 | Lazy startup deadline / Java maximum heap in MiB |
| `signerPollIntervalMs` / `signerPortAttempts` | 25 / 4 | Readiness polling interval / attempts after an occupied local port |
| `ffmpegExecutable` / `ffprobeExecutable` | Empty / Empty | Absolute media executables for complete decoding and stream inspection |
| `catalogPath` | Empty | Absolute local JSON catalog using the repair source's `HG_SOURCE_CATALOG` format |
| `outputRoot` | Empty | Explicit standalone-client workspace; Muse uses the initiating session's workspace |
| `mediaUserAgent` | `Mozilla/5.0 (Linux; Android 12)` | Video request identity; original-source media requests omit the website Referer and session credentials |
| `retryDelayMs` | 1500 | Delay before another download attempt; legacy retries fetch a fresh video model for that episode |
| `mediaHosts` | `*.qznovelvod.com`, `*.douyinvod.com`, `*.idouyinvod.com`, `*.pkoplink.com`, `*.bdcgslb.com`, `*.vegslb.com`, `*.jspcdn.cn`, `*.qrstuvwxyzab.com` | Allowed source media and observed CDN redirect domains, revalidated on every redirect |
| `mediaPorts` | 443, 9305 | Allowed HTTPS media ports; pages and source APIs always use 443 |
| `maxSeries` | 10 | Series per call; episode counts come from the complete source catalog, without a separate episode-count cap |
| `concurrency` / `retries` | 3 / 2 | Downloads per batch / transient network retries |
| `requestTimeoutMs` / `downloadTimeoutMs` / `callTimeoutMs` | 20000 / 600000 / 7200000 | Source request / episode download / whole call timeout |
| `maxResponseBytes` / `maxEpisodeBytes` | 8388608 / 1073741824 | Metadata response / episode size limits |
| `mediaProcessGraceMs` | 1000 | Grace period before forcing an owned media process to stop |

The original source must return a declared episode count matching its full list. A missing or mismatched count fails explicitly. Manifest completion covers only the supplied authorized catalog and does not establish Hongguo platform coverage. Public mode must be selected explicitly; its returned video IDs must be valid, unique and match the declared episode count. Download planning uses that actual list without an episode cap. Unavailable episodes fail a full-series request rather than silently substituting previews. Missing original source files likewise never trigger another source mode.

The original runtime uses a generic `config.json`, a private `devices.json`, `devicepool.pyc`, the original signing assets and five offline modules. Muse installs immutable, checksum-checked source resources into its private product data and retains the device across launches. Device initialization failures return a fixed safe error after owned processes stop. It starts `com.hongguo.sign.FqTrace serve` only on first use, with Java 17, UTF-8 process output, a private signing directory, `BIND_HOST=127.0.0.1` and a random per-instance token. Disposal waits for the process and its descendants to stop. An explicit `signServer` retains external local setup, whose `HG_SIGN_TOKEN` must match `signTokenEnv`.

Encrypted tracks use the supplied offline modules through [python/decrypt.py](python/decrypt.py). They require actual CPython 3.11 and PyCryptodome; newer Python versions cannot import these bytecode files. This operation uses the media model's key material and the downloaded file locally, without Android or ADB. The bridge passes private fields only through stdin and suppresses original module diagnostics. Unsupported encryption versions or failed media validation abort the batch.

The bundled patch reads the source, Java and Python paths from `MUSE_HONGGUO_LEGACY_APP_DIR`, `MUSE_HONGGUO_JAVA_PATH` and `MUSE_HONGGUO_PYTHON_PATH`; `MUSE_HONGGUO_BOOTSTRAP_DEVICES=1` enables the original generator for a generic source installation. Desktop supplies these entries. Media paths use `DSH_FFMPEG_PATH` / `DSH_FFPROBE_PATH`, with `FFMPEG_PATH` / `FFPROBE_PATH` as alternatives. The standalone tarball includes both Python bridges but excludes Java, original bytecode, saved device configuration and tokens. Desktop distributes its independently locked runtime; [SOURCE.json](SOURCE.json) records the source fingerprints and owning lock.

## Validation

Run `npm test` and `npm run check` in the plugin directory. Run `python3.11 -I -B -m unittest discover -s tests -p 'test_*.py'` for the bridge; these tests create isolated bytecode fixtures and never load the user's original modules or make platform requests. `node scripts/pack.mjs --out /absolute/output/directory` produces a tarball. Original-source acceptance must download at least two complete declared lists and fully decode every requested episode. Run `npm run test:live` from this workspace with `MUSE_HONGGUO_LIVE_IDS` containing at least two comma-separated real series IDs and the documented source/runtime environment settings; it uses the real managed subprocess provider and writes `live-evidence.json`. Public previews and authorized catalogs must be recorded separately from original-source multi-series acceptance.
