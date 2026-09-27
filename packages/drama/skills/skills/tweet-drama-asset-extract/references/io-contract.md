# Asset extract I/O contract

Input:

- Project root.
- Episode files or episode range.
- Optional existing assets.

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

`episodes` and `state_or_costume` are read at binding time by `drama_shot`: a character asset whose registration states no stage, or an episode list that does not cover the episode being compiled, is refused by name before any shot is submitted. Each pregnancy week, age band or costume version is its own row with its own stage; an asset name that mentions 孕期 does not stand in for the stage it renders.

Important character reference fields:

- `role_class`: `lead` or `important_support` when Xiaohongshu research is required.
- `style_reference_ids`: IDs adopted from `<project>/asset_style_references.json`.
- `style_reference_status`: `pending_review`, `approved`, or `rejected`.
- Important characters cannot enter paid Jubian image generation unless status is `approved`.

`asset_style_references.json` stores role tags, queries, fixed filters, input hash, MCP version, public note ID/source URL/title/author name/publish time/interaction counts, downloaded local paths, review status/reason, and extracted visual elements. It must never store cookies, `xsec_token`, MCP session IDs, request headers, or authorization values.
