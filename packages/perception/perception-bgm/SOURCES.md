# BGM sources and third-party licenses

## Maintained adapter

The TypeScript plugin, Python worker and inference adapter come from the DSH perception worktree package `packages/perception/perception-bgm`; its latest package commit at migration was `55047cae8e3bc9dc3c23d007b6f1dcacdcff7c20`. This copy contains maintained source, not an installed `node_modules` tree or prebuilt cache. The package's MIT declaration does not relicense third-party models or audio.

## Music2Emotion

Upstream: <https://github.com/AMAAI-Lab/Music2Emotion>. The original import record dates the copy to 2026-09-18 but records no upstream commit; the available upstream directory has no Git metadata. No upstream revision is claimed. The hashes below identify the imported bytes until a reviewed, commit-pinned upstream refresh is performed.

The source and static data retain the upstream MIT notice, Copyright (c) 2025 The Audio, Music, and AI (AMAAI) Lab, in [python/LICENSE-Music2Emo](python/LICENSE-Music2Emo). This notice must accompany redistribution. Preserve any additional notices in vendored files.

Local adaptations: `model/*.py` is flattened to `model_*.py`; whitespace is normalized; `btc_model.py` imports `transformer_modules` and `hparams` without `utils`, and `pytorch_utils.py` imports `logger` without `utils`. `vendored/mert.py` additionally freezes both Hugging Face loaders to the MERT revision below. `emo_pipeline.py` reproduces the inference chain, drops trailing audio shorter than 0.5 seconds, preserves the upstream constant key-mode input, and places chord/key intermediates in a private temporary directory cleaned on normal return or exception. Forced process termination can leave OS temporary files.

### Import hashes

SHA-256 hashes of the original normalized import; `vendored/mert.py` now differs by the documented revision pin. No checkpoint listed below is included in the npm package.

| File | SHA-256 |
|---|---|
| vendored/mert.py (before pin) | 5c6e4ad7ac404aefb63a43b9f9b0056b35fa270a9d83a1d7f8690f234d789aa5 |
| vendored/btc_model.py | 2a8cf9cc8a02abd275bed437d119c16f4f44f6b38c77b9fd8e8cd4a85a04bc0e |
| vendored/chords.py | 93367e56f64b14a41aec4bd44d30754a98d8ea85b42eb6cab147191aeb230ec9 |
| vendored/constants.py | 8f98b33f889a344e9e4c3a5c9dfc6f9f861c273a6636a693c95991a60560cbe0 |
| vendored/custom_early_stopping.py | 39d275d7fd64be86afd6dd1485781c640c1d2187250b3f57a4ec86a15f88753f |
| vendored/hparams.py | c5c25f3f886a137eccc6761df845cc87a1f02023734d0c2d88698f3a9af3c47c |
| vendored/logger.py | 91bff1839745c321a3f63225a41921f228b07e66d792263a2c9938f2455057f9 |
| vendored/mir_eval_modules.py | 7fef796a2899e72cea726582c3418cda4e562df6cd5fb62b44f431cdaeb888cb |
| vendored/model___init__.py | ebd7d8a97773b967fee7f514c12493d040a725ff810c478ec2255967eb586082 |
| vendored/model_linear.py | 5baf87940225cb5ba37a56e4d655978c3b3c4f432cca43f7a17014bdffc54251 |
| vendored/model_linear_attn_ck.py | 334abc5cee03fed01e09f7cb8bce937c607989b6b10fae724561444c74f9d381 |
| vendored/model_linear_mt_attn_ck.py | d5c82954ff54f648315942701c8d30389d36ebfc102dca3f3578235e63753b7a |
| vendored/pytorch_utils.py | 794f4c06314f92028e07c51835491a4e529106b33414e1c74992c699773e8394 |
| vendored/transformer_modules.py | 628d6f3a82cd6b464b13807d2eb18d1085b654a94b6918b3b158f10c2f62cd35 |
| data/chord.json | 28b463c5897e680d2132b66aa9a265d1bffb5d51d7c4da251d9effef638fcfca |
| data/chord_attr.json | 770602c0709d78823d0573ec998cca2dcbde33548ab47f3134f1a933110ad922 |
| data/chord_attr_inv.json | 147af866dba2f6fc7cee125492db177408e396e6cd954e97e943e69b43a9efbf |
| data/chord_inv.json | f80a32246abd4986cbe145d37fc46316f3d7b4ee2ae20ba497fc252e9c67eedc |
| data/chord_root.json | d921dfdd22aa44cdf6f3c102cef132418668c11d9ccc8fd7a7af28ade5268fe1 |
| data/chord_root_inv.json | 570360aadf65726faa39a790f75a604519a319a2addad9ad9309e561c0344d6f |
| data/run_config.yaml | f1d924d79c781ffdae800dce7818fcac49d9d4887d09541424b93c80d49be2df |
| data/tag_list.npy | 9510e22fca2ac817c8af9287f1fa40dbbbc10c489ead8d7bfc99191c0569d60d |

## External weights and trusted code

Obtain the emotion head `saved_models/J_all.ckpt` and BTC checkpoint `btc_model_large_voca.pt` through the Music2Emotion repository's download instructions, subject to their applicable rights. Verify the available copies against these SHA-256 values before deployment: `J_all.ckpt` = `deaceb291f7974deb688167d3639b7f6eb66eb0715824668618393777d1e07a5` (12,958,092 bytes); BTC = `1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51`. These are measured local artifact hashes, not a claim of an immutable upstream download URL. PyTorch loads these trusted checkpoints with `weights_only=False`; never accept untrusted replacements.

The [m-a-p/MERT-v1-95M model](https://huggingface.co/m-a-p/MERT-v1-95M/tree/12af15fef9d0ac838c3f475bfbbf26d2060dd4f5) is **CC-BY-NC-4.0, non-commercial only**, not MIT. Preserve its attribution, model card and [license terms](https://creativecommons.org/licenses/by-nc/4.0/) with a prepared model payload. Both model and feature extractor use revision `12af15fef9d0ac838c3f475bfbbf26d2060dd4f5`, matching the recorded local Hugging Face cache. `trust_remote_code=True` executes that snapshot's Python; review the snapshot before preparing a release. Revision freezing is tested without downloading or running the model.

A release preparer must separately obtain that exact Hugging Face snapshot, retain its cache layout and remote-code files, and test offline loading on a clean target. The npm package contains no Hugging Face cache, MERT weights, BTC checkpoint, emotion head, Python interpreter, audio library, credentials, or user index. Package inclusion is not permission for commercial inference; commercial distribution/use requires a separate rights review or a suitable replacement model.
