# Asset extract I/O contract

Input:

- Project root.
- Episode files or episode range.
- Optional existing assets.
- The current user's explicit project style, when provided, and the saved `project_bible.style` read through `drama_project action=read`.

Style resolution precedes prompt creation. A current explicit style is confirmed into `project_bible.style` before use; otherwise the saved specific value is used verbatim. A missing, broad or conflicting value remains pending confirmation: neutral character, outfit, scene and prop facts may be retained in working notes, but no generation-ready prompt or paid request is created. Preset names, skill names, reference-image media and model names never supply a default style.

Output asset record fields:

- `name`
- `aliases`
- `episodes`: the episodes this version serves — episode numbers, or `["all"]` for a series-wide master
- `type`
- `state_or_costume`: the stage or body state plus the costume and hair, such as `孕早期（孕八周）、孕期职场装、长发`; a version with no body change states `非孕期`
- `visual_prompt` or image-generation prompt
- `image_path`
- `vision_checked`

Rule: records must preserve outfit/appearance variants as separate usable assets when the script requires them.

Every generation-ready prompt starts with the exact confirmed project style and preserves identity, appearance, outfit, hair, accessories and state. Confirmed live-action projects retain the existing live-action character-board and scene rules. Confirmed anime, Chinese-animation, 2D-animation, 3D-animation and CG-animation projects use animation boards and rendering language without live-action-only constraints such as `禁止动漫脸`, `真人角色设定板` or `真实空间`. Reference images contribute only reviewed elements and do not select or override the style branch.

`episodes` and `state_or_costume` are read at binding time by `drama_shot`: a character asset whose registration states no stage, or an episode list that does not cover the episode being compiled, is refused by name before any shot is submitted. Each pregnancy week, age band or costume version is its own row with its own stage; an asset name that mentions 孕期 does not stand in for the stage it renders.

Important character reference fields:

- `role_class`: `lead` or `important_support` when Xiaohongshu research is required.
- `style_reference_ids`: IDs adopted from `<project>/asset_style_references.json`.
- `style_reference_status`: `pending_review`, `approved`, or `rejected`.
- Important characters cannot enter paid Jubian image generation unless status is `approved`.

`asset_style_references.json` stores role tags, queries, fixed filters, input hash, MCP version, public note ID/source URL/title/author name/publish time/interaction counts, downloaded local paths, review status/reason, and extracted visual elements. It must never store cookies, `xsec_token`, MCP session IDs, request headers, or authorization values.
