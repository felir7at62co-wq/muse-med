# Jingliu backend

English | [中文](README.zh.md)

Jingliu is Muse's production engine. Its FastAPI service runs the generation providers for video, images, voice, speech recognition, upscaling and subtitle erasure. A job queue deduplicates submissions and settles each job's cost against the credit ledger. Its database holds projects, episodes, shots, assets, blocking pictures, subtitles and audio. One-step batch workflows apply a production step to a whole episode.

## How Muse reaches it

Muse calls the studio's `/fwp/v2` API through the signed-in [Jingliu connection](../../packages/drama/jingliu-connection/README.md). The [Jingliu tools](../../packages/drama/tool-jingliu/README.md), including `jingliu_run`, read the workflow catalog from `GET /desktop-agent/tools`, price an operation with `POST /desktop-agent/quote` and run it with `POST /desktop-agent/tool`. Muse's production panels use the same connection.

## Source

This tree is the backend of cloud release `20261121-jingliu-blocking-01`: the November 17, 2026 workbench backup plus four deployed changes. Muse writes and locks shot scripts in place of Jingliu's prompt writer. Secrets are redacted from stored errors, job results and logs. `FW_ARK_TRUSTED_ASSETS` leaves portrait-reference registration to the model gateway, and first-frame generation is removed. Blocking pictures are stored and bound to shots. `backend/app` matches the release byte for byte apart from the Muse login overlay and the following: comments and docstrings in `app/at_refs.py`, `app/auth.py`, `app/budget.py`, `app/jobs.py`, `app/notify.py`, `app/routers/library.py`, `app/routers/shots.py` and `app/user_directory.py` use placeholders instead of the names of users and administrators, a nickname and IP addresses, and `app/config.py` defaults `feishu_notify_contact` to 管理员 instead of an administrator's name.

The overlay is not part of this tree. [`../muse-workbenches/install.py`](../muse-workbenches/install.py) applies it to a release copy at install time. The cloud release carries the overlay's login and shared-library changes but not the installer's Jianying exporter adaptation.

## Layout

| Path | Contents |
|---|---|
| `backend/app/` | FastAPI application, served as `app.main:app` |
| `backend/tests/` | pytest suite; `tests/data` holds text fixtures |
| `backend/scripts/` | Static code checks and the music and sound-effect library loaders |
| `backend/requirements.txt` | Pinned dependencies |

## Tests and static checks

The cloud runtime uses Python 3.12. Besides `requirements.txt` it needs python-multipart, `pyJianYingDraft==0.3.1`, Pillow and numpy, which that file does not list. Create the virtual environment outside the repository and run from `backend/`:

```sh
uv venv --python 3.12 ~/.venvs/jingliu
uv pip install --python ~/.venvs/jingliu/bin/python -r requirements.txt python-multipart pyJianYingDraft==0.3.1 pillow numpy pytest pyflakes
~/.venvs/jingliu/bin/python -m pytest tests
~/.venvs/jingliu/bin/python scripts/check_undefined_names.py
```

The tests use a temporary SQLite database and data directory and make no network calls. `check_lazy_imports.py`, `check_module_attrs.py` and `check_self_misuse.py` parse `app/` without importing it. `check_undefined_names.py` runs pyflakes.

## Repository attributes

The root `.gitattributes` covers eight imported files. The three `jianying_pack/*.bat` files are `-text`, so Git does not convert the CRLF line endings that Windows users receive. Five application files are exempt from `git diff --check` because they keep the trailing whitespace or final blank lines of the deployed release.

## Not in this repository

The old studio web frontend exists only on the cloud server and in the November 17 backup. Jingliu's own documents, `backend/tools/`, one-off verification and audit scripts, top-level test scripts and A/B result files, the Dockerfile and Jingliu's original README remain in that backup and the maintainers' local source copy.

## Known limitations and deferred work

Muse will remove or replace Jingliu's own model-driven steps, its LangGraph agent and Feishu bot, code that no Muse path uses, and the separate login and charging bridge between Muse and Jingliu accounts. The old website stays until the Muse web console exists.

Two static checks fail on the deployed code. `check_module_attrs.py` reports `agent_run.ResumeIn`, which `app/feishu_bot.py` calls but `app/routers/agent_run.py` does not define. `check_undefined_names.py` reports the string annotation `"asyncio.Lock"` at `app/routers/shotflow.py:448`, whose allowlist entry names line 395.
