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

    def test_character_reference_lookup_does_not_grant_production_use(self):
        text = (SKILLS / 'character-reference-library/SKILL.md').read_text(encoding='utf-8')
        for required in (
            '不要把镜流项目编号填入本地人物库的项目字段',
            '从同一结果取得 `catalog_asset_id` 与 `image_sha256`',
            '`pending_review` 只能作为只读比较，不能上传、发送给供应商、正式绑定、发布或跨项目复用',
            '即使是用户本人上传的图，当前工作流也不提供图库到镜流的授权、传输或采用',
            '这些记录不改变原图审核状态，也不是生成输入',
        ):
            self.assertIn(required, text)
        for removed in ('jubian_character_reference_authorize', 'upload_character_reference',
                        'managed_reference_id', 'confirm_casting'):
            self.assertNotIn(removed, text)

    def test_character_reference_fallback_checks_required_inputs_and_current_quote(self):
        text = (SKILLS / 'character-reference-library/SKILL.md').read_text(encoding='utf-8')
        for required in (
            '先用 `drama_character_reference_project` 确认当前本地项目和角色',
            '不要把一次读取当作嵌套项目选择',
            '按当前剧本与项目自有的合格素材准备独立候选',
            '必需图库原图无法合法传入时，说明限制并停在提示词',
            '当前用户的授权、报价、目标资产与已有任务',
            '生成结果未知时只查原任务，不换键、改名或换目标重投',
            '主肖像缺脸、错脸、多余肢体或未要求的拼版属于不合格候选',
            '实际查看结果后分别报告画质、项目现行版本和镜头引用状态',
        ):
            self.assertIn(required, text)


if __name__ == '__main__':
    unittest.main()
