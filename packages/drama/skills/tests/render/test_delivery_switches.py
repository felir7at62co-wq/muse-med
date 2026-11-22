"""Draft requests can turn off the ending and the AI-content mark; they never add what the medium omits."""
import importlib.util
import unittest
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[2] / 'skills'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


POLICY = load('delivery_switches_policy', SKILLS / 'tweet-drama-background-render' / 'scripts' / 'delivery_policy.py')
REQUEST = load('delivery_switches_request', SKILLS / 'tweet-drama-draft-build' / 'scripts' / 'generate_draft_request.py')


class DeliverySwitchTests(unittest.TestCase):
    def test_false_switches_remove_the_ending_and_mark(self):
        policy = {'ending_duration_us': 2_000_000, 'add_watermark': True, 'width': 1080}
        self.assertEqual(POLICY.apply_switches(policy, {'ending': False, 'watermark': False}),
                         {'ending_duration_us': 0, 'add_watermark': False, 'width': 1080})
        self.assertEqual(policy['ending_duration_us'], 2_000_000)

    def test_true_or_missing_switches_keep_the_medium_policy(self):
        animation = {'ending_duration_us': 0, 'add_watermark': False}
        self.assertEqual(POLICY.apply_switches(animation, {'ending': True, 'watermark': True}), animation)
        self.assertIs(POLICY.apply_switches(animation, {}), animation)
        self.assertIs(POLICY.apply_switches(animation, None), animation)

    def test_request_switches_must_be_booleans(self):
        self.assertEqual(REQUEST.delivery_switches({'ending': False, 'other': 1}), {'ending': False})
        with self.assertRaisesRegex(ValueError, 'ending and watermark'):
            REQUEST.delivery_switches({'watermark': 'no'})


if __name__ == '__main__':
    unittest.main()
