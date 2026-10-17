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
- The Agent writes each complete package prompt with explicit `@[name](key)` material purposes. Save it in `modelConfig.prompt`, select the actual parent assets in first-reference order through `select_assets`, and inspect the free `prepare_video` result before individual or batch submission. No fixed director-text format or compiler call is required.
- No cross-type match, such as a character matched to a scene.

同名登记按集数和角色状态确定唯一的实际远端版本，保留所选 asset/material ID；不能因名称相同改取清单末行。场景或道具多条版本覆盖同一集时先核对，不能静默挑一条。
