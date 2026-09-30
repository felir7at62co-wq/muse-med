---
name: tweet-drama-voice-continuity
description: 角色跨镜头音色变化、串台词、没有声线样本，或剧变分镜添加音频参考后准备失败时使用。
---

# 角色声线参考与复用

按项目圣经的 character_id 保存角色声线；同角色的服装版本共用声线，角色与动物不得互换。参考音频用于音色引导，原剧本的说话人、台词、顺序和旁白仍分别核对。固定提示词和参考音频不能保证 SD 原生跨镜音色完全一致，生成后由能实际听音的 Agent 或用户/组员检查，纯文本转写不能证明音色一致。

## 建立第一个样本

先复用该角色已有认可的声音参考。缺少时，从第一版已生成视频里挑该角色清晰、无其他人抢话、无 BGM 干扰的真实独白，默认保存 **2 秒**，不是保存时间只留两秒钟。没有已生成版本时，把建立首个声线作为独立初始生产范围：用项目选定 SD 模型制作真实镜头包，核查该范围的内容、全部 preview 和费用后提交，再从成片提取；不额外开独立 TTS 服务，不为了试音新建重复分镜。所有参考最长 **15 秒**，不能把全包视频时长当作音频参考时长。

运行随技能脚本，start 必须来自已听过的单角色发声区间：

```sh
python -B <本技能目录>/scripts/extract_voice_reference.py --source <首次清晰发声的原视频或音频> --output <项目>/audio/voice-references/<character_id>-v1.wav --start-seconds <实测开始秒>
```

非 WAV 输入使用 Muse 随包 FFmpeg；WAV 输入直接提取 PCM。脚本默认裁 2 秒、拒绝超出真实音轨或超过 15 秒，不补静音，不覆盖既有声线。返回 source_sha256、sha256、实测 duration_seconds；speaker_verified=false 表示说话人仍需实际听音核对，不能仅凭文件名认定角色。运行环境不能听音时，用 ask_user 让用户/组员确认这个样本。试听不合格时选其他真实区间、保存新版本，保留旧版本和来源。

## 上传与绑定原卡

用 `jubian_asset method=upload_audio audio_path=<已核对的短 WAV>`。上传免费，返回 materialUrl、SHA-256 和实测 audioDuration；复用已有 URL 时不重复上传。将角色、来源镜头/任务 ID、截取区间、文件哈希及远端 URL 记入项目声线清单，`drama_project` 的 characters[].voice_profile.reference_audio 保存该角色当前选定 URL，description 保持同一年龄、音色、口音与语气。

读原 storyboard_id 的最新完整 body，在原卡素材列表保留全部已有图像，添加或更新同角色 `materialType="audio"` 的行：materialUrl 是上传 URL，materialKey 是稳定声线 key，fileName/materialName 是角色声线名，sortOrder 为音频组内顺序，audioDuration 来自实测。音频上传行没有图片父资产，不编造 materialAssetId、hsAssetId 或确认出演步骤。提示词明确写“周海生声音参照 @[周海生声线](voice-zhouhaisheng)”等角色与音频一一对应关系；一个 key 首次标记一次，后文复用名称。

在同一原卡 `save`，回读核对完整图像与音频清单、声音标记、模型和时长，再 `select_assets` 校正图像选源，最后 `prepare_video`。图片在前、音频在后，两组各自按 sortOrder 排列；SD2.0 最多 3 条音频参考，SD2.5 最多 10 条。工具保留已存音频，并在 fingerprint 中冻结 URL、key、名称和顺序。没有 audioDuration 的旧上传素材只能说时长未核实，先实际下载/试听/探测后决定，不能从远端文件名猜时长。

冻结失败先查具体字段和真实回读：不得默认摘掉声音、重建同名卡或提前付费生成部分包。修复原卡后重新 prepare；旧 fingerprint 不用于新内容。提交后必须回读 audioMaterials 的真实 audioUrl 与顺序；缺失或不符只能进入对账，不重投，不宣称已使用参考或音色已统一。参考齐备后，其余镜头包按原整批检查与并行提交流程继续。
