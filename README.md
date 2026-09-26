# muse-med

English | [中文](README.zh.md)

muse-med is a short-drama AIGC desktop agent built on a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), the open-source agent harness developed by [DeepSeek AI](https://deepseek.com). It retains upstream package names and credits; it is not an official DeepSeek release.

The underlying harness uses an **everything-is-a-plugin** architecture powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Upstream dsh documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

muse-med and its underlying harness are in _developer preview_. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.** The Windows installer and complete portable media runtime are not yet released; do not present a source checkout as an installer.

Review the [safety notice](SAFETY.md) before running the project. Desktop development builds the current source with `pnpm run dev:desktop` and still requires Node.js and pnpm on the developer's machine. See the [desktop guide](apps/desktop/README.md) and the [community plugin source snapshots](third_party/plugins/README.md).

## Short-drama workflow

The desktop preview combines script preparation, user-provided visual references, asset review, shot planning, BGM selection, and episode delivery in one short-drama preset. Reference images come from the user; Xiaohongshu access is not required or bundled. Reference review and user confirmation are skill-level workflow requirements, not an authorization check enforced by every paid tool.

The Windows media payload is prepared for local rendering and Whisper transcription, with pinned OFL-licensed Noto fonts; it does not make online model providers, Jubian accounts, or public BGM downloads offline. Optional MERT analysis requires separately prepared model resources and is restricted to non-commercial use. The latest installer still requires fresh-profile and clean-machine qualification; unsigned test artifacts are not a signed public release. See the [desktop guide](apps/desktop/README.md) for runtime and credential limitations.

## Run

### Upstream `dsh` CLI from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/felir7at62co-wq/muse-med.git
cd muse-med
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### muse-med entry points

From a repository checkout, the product entry points are `pnpm muse:web` for the Web GUI and `pnpm muse:desktop` for the desktop shell:

```sh
pnpm muse:web
pnpm muse:web -- --port 3399
pnpm muse:desktop
pnpm muse:desktop:start
```

`muse:web` serves the Web GUI against the muse product home (`$MUSE_HOME`, otherwise `~/.muse`) on port 327 by default, so it never collides with a plain `dsh web` on 3080; `--port` selects another port and `--dry-run` prepares the home and exits. `muse:desktop` builds the current source and launches the desktop shell, which uses the same home with a legacy `~/.muse-med` fallback; `muse:desktop:start` skips the build. `MUSE_MED_HOME` overrides the desktop home, while an inherited `DSH_HOME` or `MUSE_HOME` does not select it.

## Community and support

- Report muse-med issues in the [muse-med repository](https://github.com/felir7at62co-wq/muse-med/issues).
- For upstream dsh questions, use [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) or its [Discord community](https://discord.gg/Ycq5dCaS4).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to interoperable plugin repositories.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## Upstream citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
