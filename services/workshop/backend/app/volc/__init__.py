"""火山官方模型接入 + 计费模块。

- models: VolcUsageRecord / VolcRateCard
- billing: record_usage(...) 统一落库 + 高精度成本计算
- client: 火山官方 Seedance 视频生成 provider + 视频理解封装(带 usage)
- routes: 管理员计费 API
"""