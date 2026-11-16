---
kind: upgrade-guide
description: "Desktop no longer includes the retired Hongguo Java and Python payload; Fanqie uses the primary Python runtime."
---

# Desktop shares its primary Python runtime

English | [中文](guide.zh.md)

## Change

Desktop packages exclude `runtime/hongguo`, which held the retired original downloader, Java, its source archive and a second Python. The current Hongguo engine uses Node.js, FFmpeg and the separate ByteVC2 helper. Fanqie uses PyCryptodome from the primary Python through `MUSE_FANQIE_PYTHON_PATH`.

Existing user media, receipts and device files remain untouched. Standalone legacy payload preparation remains available, but current Desktop startup requires the updated primary runtime. It does not silently fall back to the retired payload.

## Migration

1. Installed users upgrade the complete application; no account or media migration is required.
2. Source builders rerun Desktop runtime preparation before starting the new application. A custom `DSH_DESKTOP_PRIMARY_RUNTIME_DIR` must also be rebuilt with the current shared lock so its distribution map includes `pycryptodome`.
3. Standalone Fanqie profiles set `MUSE_FANQIE_PYTHON_PATH` or `pythonExecutable` to a Python containing PyCryptodome. Their existing explicit Python settings remain supported.
4. Verify the prepared payload's Python/AES checks and the installed Hongguo engine smoke before packaging. A primary runtime missing PyCryptodome fails startup rather than selecting an unrelated interpreter.
