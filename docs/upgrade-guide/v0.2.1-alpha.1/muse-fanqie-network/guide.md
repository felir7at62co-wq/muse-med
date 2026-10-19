---
kind: upgrade-guide
description: "Muse Fanqie tools default to direct connections instead of discovered environment or operating-system proxies."
---

# Muse Fanqie connection mode

English | [中文](guide.zh.md)

## Change

Muse Fanqie tools use `networkMode: direct` by default. Earlier versions inherited Python urllib proxy discovery, including macOS system proxies. Users whose network requires a proxy must select `networkMode: system` explicitly. This configuration affects only the Fanqie engine; it does not change the computer's proxy settings. Neither mode disables TLS verification or retries through the other mode.

Muse receives the failing request stage, destination host, selected mode and safe error details. See the [Fanqie package reference](../../../../third_party/plugins/muse-fanqie-download/README.md) for diagnostic fields and download receipts.

## Migration

1. Keep the default for direct access. To preserve proxy discovery, add the following row to a Cordis patch applied after the Fanqie bundle row. Set `MUSE_FANQIE_PYTHON_PATH` or `MUSE_HONGGUO_PYTHON_PATH` to the existing Python executable first.

   ```yaml
   - id: muse-fanqie-download
     config:
       pythonExecutable: !!js process.env.MUSE_FANQIE_PYTHON_PATH || process.env.MUSE_HONGGUO_PYTHON_PATH || ''
       networkMode: system
   ```

2. Retain any custom runtime path and limits in the mapping: a row patch replaces its complete `config`. Restart the profile with the patch applied. Invalid network modes fail configuration validation.
3. Run `fanqie_search`, match the intended title and author, then use `fanqie_download_info` to check its directory. A failure identifies its stage and mode. To verify downloading, run `fanqie_download` and confirm declared and downloaded chapter counts, per-chapter receipts, the TXT file and its SHA-256. A successful directory check alone does not verify a downloaded book.
