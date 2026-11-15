# Import an exact safe manifest filename

English | [中文](README.zh.md)

This keyless Headless scenario returns `video (1).mp4` in an owned cloud-job manifest. A sanitized alias is not a manifest member and receives `not-found` without fetching file bytes. Importing the exact name uses the production account client and managed helper, checks byte count, SHA-256, actual FFprobe metadata and full FFmpeg decoding, then publishes the file and source receipt before the model presents it.

The fixture checks the exact encoded request URL, one authenticated file read, unchanged published bytes, full-decode evidence and a directory containing only the media file and receipt. The complete workspace oracle preserves the spaced and parenthesized path; its adapter expands only that explicitly selected path. Existing scenario inputs, outputs and normalization remain unchanged.

The model provider replays authored responses, and an owned loopback service replaces the central account gateway. The video is an existing synthetic fixture. No real platform download, generation, ASR or cloud mutation is performed. A fixture-only built-library override supports an isolated original-gate negative control without modifying the shipping library. These checks establish local import behavior, not production deployment or creative quality.
