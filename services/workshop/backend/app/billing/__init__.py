"""图像生成计费模块。

计费规则 (估算价, 人民币):
- gpt-image-2:                 0.5 元/张 (不分辨率)
- gemini-3-pro-image-preview:  Nano Banana Pro, 1K/2K = 0.4 元/张, 4K = 0.8 元/张
- gemini-3.1-flash-image:      Nano Banana 2,   1K/2K = 0.4 元/张, 4K = 0.8 元/张 (与 Pro 同价)
- RunningHub 高清放大:          4 元/小时 (按任务运行时长折算)

每条 image_jobs 成功后落一条 image_billing 记录。用户看自己的, 管理员看所有人的。
"""
from .models import ImageBilling  # noqa: F401