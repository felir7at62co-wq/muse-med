"""Shipped instructions must not transfer the original operator's spending permission to a new user."""
from pathlib import Path
import unittest

SKILLS = Path(__file__).resolve().parents[1] / 'skills'


class PaidAuthorizationTests(unittest.TestCase):
    def test_token_and_old_authorization_do_not_authorize_a_new_user(self):
        text = (SKILLS / 'tweet-drama-key-manager/SKILL.md').read_text(encoding='utf-8')
        self.assertNotIn('用户已给出持续授权', text)
        self.assertNotIn('用户已授权项目范围内自主执行', text)
        self.assertIn('当前用户', text)
        self.assertIn('未授权', text)
        self.assertIn('先询问', text)
        self.assertIn('token 存在不等于花费授权', text)
        self.assertIn('不逐笔', text)
        self.assertIn('预算', text)
        self.assertIn('realCost', text)

    def test_character_reference_qa_exception_is_host_managed_and_nonproduction(self):
        text = (SKILLS / 'character-reference-library/SKILL.md').read_text(encoding='utf-8')
        for required in (
            '隔离 QA 专用的一次性授权',
            '`character_id`',
            '`role_class`',
            '`catalog_asset_id`',
            '原图 SHA-256',
            '审核版本',
            '`jubian_asset method=upload_character_reference`',
            '`managed_reference_id`',
            '`jubian_video method=image_generate`',
            'Agent 判断不能创建、批准、撤销或扩大这项授权',
            '不得提交本机路径、TOS key、对象 key、URL',
            '不要传 `references` 或 `parent_asset_id`',
            '不要跨项目或跨角色复用',
            '不要自动重试或更换幂等键',
            '不得调用 `confirm_casting`',
            '不得正式绑定或发布',
            '只产生隔离 QA 证据',
            '素材仍为 `pending_review`',
            '生产发布、复用与绑定资格保持关闭',
        ):
            self.assertIn(required, text)
        for forbidden in (
            'Agent 可以创建一次性授权',
            'pending_review 可以作为生产参考',
            '跨项目复用该授权',
        ):
            self.assertNotIn(forbidden, text)

    def test_character_reference_fallback_uses_current_user_budget_without_library_image(self):
        text = (SKILLS / 'character-reference-library/SKILL.md').read_text(encoding='utf-8')
        for required in (
            '先用 `drama_character_reference_project` 确认当前项目和角色',
            '不要把一次读取当作嵌套项目选择',
            '不要因此阻断独立的无库图生图流程',
            '不把 `pending_review` 候选或它的 URL 混入提示词和 `references`',
            '当前用户的付费授权、预算和已有任务',
            '未授权时先询问',
            '固定幂等键',
            '结果未知时只对账原请求，不换键重投',
            '视觉验收前不执行 `confirm_casting`',
            '托管生图可省略 `asset_name`，Host 以已核验的角色名称为准',
            '前文无库图回退的自定义候选名规则不适用于这里',
            '主肖像缺脸、错脸、多余肢体或未要求的拼版等明显瑕疵直接判为不合格候选',
            '正反面身形或服装视图中的空白脸只是占位，不单独判为失败',
            '主肖像必须有清晰面容',
            '若交付物是单画面全身人物图，则使用面容可见的单画面',
            '没有请求体或供应商实现证据，不断言是 Host 注入固定模板还是模型忽略提示词',
            '不把这类判断转交用户',
            '不为补救画质而自动重用授权、重投原键或换键',
            '参考图生图已明确失败或回读画面不合格',
            '当前用户对一笔独立的无库图生成也有明确费用授权',
            '不要沿用已消费的图片使用授权、托管上传、参考图 URL 或幂等键',
            '原任务结果未知、费用授权未覆盖新请求或项目身份不明时停止付费',
        ):
            self.assertIn(required, text)


if __name__ == '__main__':
    unittest.main()
