# Ordinary revision wording and delivery basis

English | [中文](README.zh.md)

This keyless Headless scenario uses “修改下剧本” to exercise the real manuscript delivery policy. A consistent internal review of only the final file must reject reviewed delivery with `MANUSCRIPT_DELIVERY_BASELINE_REQUIRED`. A second native review compares the selected original as `current` with the distinct final `candidate`, then declares and presents the actual saved file.

The scenario reuses the existing revision-basis fixture through a read-only wrapper. The fixture replays authored model responses and checks the complete human requirement, checked materials, delivery label, receipt and complete workspace. The request starts with a planning turn followed by an explicit continuation. Saved candidates are Markdown; this case checks revision safeguards rather than Word export or creative quality.

The shipped Headless profile runs production tools and manuscript services with a recorded model provider that has no real-API fallback. Existing Session inputs, expected outputs and normalization remain unchanged. New writer oracles belong only to this scenario.
