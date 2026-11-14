# Asset vision check I/O contract

Input:

- Asset records with image paths.
- Project root.
- The complete art direction and character requirements for this request, plus the designated layout reference for character boards.

Output:

- Observed image descriptions remain separate from the requested art direction; never rewrite the target to make a failed candidate pass.
- `vision_checked=true` when the exact candidate was inspected; this flag does not mean approved.
- Character-board review compares the original candidate with the layout reference and each applicable requirement in [the delivery review](character-delivery-layout.md#交付前逐项实图审查). Record concise visible evidence and pass, fail or not-checked outcomes in the existing asset record.
- Warnings for mismatched image/name/type.

A failed or uninspected requirement prevents approval, casting confirmation, formal binding and delivery as a compliant asset. Layout success cannot compensate for a style mismatch. A replacement or repaired image needs its own inspection; regenerate its observed description without replacing the requested art direction or inheriting the previous review.
