# Shot asset match I/O contract

Input:

- Episode number.
- Shot script.
- Asset inventory.

Output:

- Matched JSON manifest per episode.

Acceptance:

- Every on-screen human, animal, scene and prop resolves to a concrete official asset; a missing core subject blocks submission and produces a registration or restock request.
- A recurring animal has `type: "动物"` / `"animal"`, or a role row with `subject_kind: "animal"`; its visual alias resolves even when `出镜人物` lists only humans. Each package includes that animal's material name and key. Dialogue-only mentions do not add a binding.
- When the user supplies a prompt to preserve, change only the authorized asset placeholders to verified `@[name](key)` references. Keep every other character, including formatting, tense, costume, dialogue and timing text. Preserve the user's numbered-reference mapping; do not append purposes or rewrite the prompt to fit an asset. Otherwise the Agent may author the complete package prompt with explicit material purposes. Save the complete prompt in `modelConfig.prompt` and verify its actual readback.
- An explicit on-screen cast controls image selection. Offscreen speakers and people mentioned in dialogue, memories or future events do not add image bindings unless this shot actually shows them. Audio references follow the real speakers separately. Select actual parent assets once in first-reference order through `select_assets`; plain names do not create selections or authorize image generation.
- Inspect the free `prepare_video` result within the latest user request. A preview-only request ends with the preview, even after earlier production authorization; a budget or prepared file is not permission to submit. Existing authorization still covers production that the current request actually includes. No fixed director-text format, compiler call or new approval mechanism is required.
- No cross-type match, such as a character matched to a scene.

同名登记按集数和角色状态确定唯一的实际远端版本，保留所选 asset/material ID；不能因名称相同改取清单末行。场景或道具多条版本覆盖同一集时先核对，不能静默挑一条。
