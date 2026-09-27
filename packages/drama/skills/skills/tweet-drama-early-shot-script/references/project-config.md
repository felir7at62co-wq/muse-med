# project_config.json 字段表

`project_config.json` 是**项目根标记**：`video_bans.py` 用它认定项目边界，`drama_shot` 与剧变工具用它读取本项目的交付要求。它只放**产品实际读取**的键；其余键被忽略，不报错也不生效。文件必须是 JSON（允许 UTF-8 BOM），位置就在项目根，例如 `short-drama/山海自有相逢处/project_config.json`。

## 字段

| 键 | 类型 | 必需 | 读取方 | 作用 |
|---|---|---|---|---|
| `jubian_script_id` | 正整数 | **是**（走剧变视频通道时） | `jubian_storyboard` `prepare_video`/`submit_video`、`drama-gate` | 本项目在剧变的远端项目 ID。`prepare_video` 用实时 `scriptId` 与它比对：缺失、非法或不等都直接判 `CONTRACT_CHANGED`，不会用别的项目顶替。`drama-gate` 也用它把一次调用绑定到具体项目。 |
| `delivery` | 对象 | 否 | `drama_shot` `validate`/`preview`/`compile` | 本项目的交付要求容器。不是对象时按「本项目没有声明要求」处理。 |
| `delivery.max_effective_chars_per_shot` | 正整数 | 否 | `drama_shot` | 每镜**有效字**上限（汉字/字母/数字计数）。声明后它高于工具内建的 36 字建议：超限判**失败**（`speech_exceeds_project_limit`），不是警告。缺这个键或整个配置解析不了时，内建数值只作建议。键存在但不是正整数 → 本次调用直接失败。 |

## 最小示例

```json
{
  "jubian_script_id": 2708,
  "delivery": {
    "max_effective_chars_per_shot": 18
  }
}
```

只要让 `drama_shot` 找到项目根，`jubian_script_id` 就可以先不写；一旦要走 `jubian_storyboard` 的 `prepare_video` 或 `submit_video`，它必须存在并等于当前分镜的 `scriptId`。

## 工具怎么找到它

- `drama_shot`：调用给了 `project` 就用该目录下的 `project_config.json`；否则从镜头脚本所在目录**向上最多四层**找最近的一个。找不到就等于本项目没有声明要求。
- `jubian_storyboard`：只认调用传入的 `project_dir`，不向上搜索。
- `video_bans.py`：显式项目目录，或从草稿路径向上找最近的 `project_config.json`。

## 改这个文件之前

- 不要为了绕过 `drama_shot` 的检查而删掉 `delivery.max_effective_chars_per_shot`。超限的两条正当出路是：按原文语义拆镜，或经用户确认后改掉本项目这条要求。
- `jubian_script_id` 是远端身份，不能猜、不能借别的项目。写错会让付费调用落到错误项目上。
