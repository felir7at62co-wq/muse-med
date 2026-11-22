"""短视频流水线 (Clip Studio)。

一页五格: 输入 → 创作/改编(1次AI, 合成出创意+视频提示词+首帧图提示词+亮点)
         → 生成首帧图(复用 image_studio) → 生成视频(RunningHub SparkVideo 2.0)。

针对 5-15s 短视频, 不走草稿/改编/评审那套重流程。数据永久可看(clip_jobs 表)。
"""