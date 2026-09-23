"""Shipped instructions must not transfer the original operator's spending permission to a new user."""
from pathlib import Path
import unittest

SKILLS = Path(__file__).resolve().parents[1] / 'skills'


class PaidAuthorizationTests(unittest.TestCase):
    def test_token_and_old_authorization_do_not_authorize_a_new_user(self):
        for name in ('tweet-drama-key-manager', 'tweet-drama-pipeline'):
            with self.subTest(skill=name):
                text = (SKILLS / name / 'SKILL.md').read_text(encoding='utf-8')
                self.assertNotIn('用户已给出持续授权', text)
                self.assertNotIn('用户已授权项目范围内自主执行', text)
                self.assertIn('当前用户', text)
                self.assertIn('未授权', text)
                self.assertIn('先询问', text)
                self.assertIn('token 存在不等于花费授权', text)
                self.assertIn('不逐笔', text)
                self.assertIn('预算', text)
                self.assertIn('realCost', text)

    def test_pipeline_retains_unknown_result_idempotency_and_cost_checks(self):
        text = (SKILLS / 'tweet-drama-pipeline' / 'SKILL.md').read_text(encoding='utf-8')
        for requirement in ('idempotency_key', 'preview fingerprint', '保持原 key', '禁止换 key', '已有费用', '剩余授权'):
            self.assertIn(requirement, text)


if __name__ == '__main__':
    unittest.main()
