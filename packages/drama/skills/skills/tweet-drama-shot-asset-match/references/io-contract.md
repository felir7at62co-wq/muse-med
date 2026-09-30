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
- `drama_shot preview/compile` returns each complete package `prompt` and appends references for confirmed bound assets missing from the authored script. Existing asset keys are reused; new keys are `asset_<jubian_asset_id>`. Save that prompt unchanged and submit `select_assets` selections in its deduplicated `material_keys` order. A preliminary `validate` call is optional.
- No cross-type match, such as a character matched to a scene.

同名登记按集数和角色状态确定唯一的实际远端版本，保留所选 asset/material ID；不能因名称相同改取清单末行。场景或道具多条版本覆盖同一集时先核对，不能静默挑一条。
