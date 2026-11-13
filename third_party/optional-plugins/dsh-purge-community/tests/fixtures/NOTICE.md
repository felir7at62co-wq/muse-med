# Test fixture sources

These fixtures retain excerpts from the Muse 1.2.8 bundled DeepSeek Harness 0.2.1-alpha.1 code. They are test inputs rather than runtime dependencies and must not be used to replace the current application's files.

- `muse-1.2.8-system-prompt.mjs`: `@deepseek-ai/dsh-system-prompt/lib/index.js`.
- `muse-1.2.8-desktop-host.js`: the `DesktopHostProcess` class from `muse-med/lib/main.js`.
- `dsh-hooks-claude-code.mjs`: `@deepseek-ai/dsh-hooks-claude-code/lib/index.js`.
- `dsh-hooks-codex.mjs`: `@deepseek-ai/dsh-hooks-codex/lib/index.js`.

Source application: [Muse](https://github.com/felir7at62co-wq/muse-med). Upstream framework: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Original package headers are preserved. The bundled `app.asar` used for these fixtures has SHA-256 `2ffa5712b42b9b8bc08239329a9745e4e1f16a8d1abec40c2c96ecbf7816106e`.

The fixture code is covered by the accompanying MIT license, copyright 2026 DeepSeek, and the repository's applicable Muse notices.
