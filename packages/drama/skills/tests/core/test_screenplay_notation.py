"""Screenplay notation preserves speech identity and every original source row."""
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills/tweet-drama-core/scripts'
sys.path.insert(0, str(SCRIPTS))
from episode_coverage import classify_source_lines


class ScreenplayNotation(unittest.TestCase):
    def row(self, line, following=''):
        source = f'人物：甲、乙\n{line}' + ('\n' + following if following else '')
        return classify_source_lines(source)[1]

    def test_physical_expression_delivery_and_emotion_annotations_keep_identity(self):
        cues = ('怒视对方', '拼命挣扎往后缩', '满脸嫌恶', '语气冷淡硬邦邦', '递过去一沓现金',
                '掂了掂钱', '厉声喝斥', '踢了一脚地上的土', '手朝门外一指', '眼睛瞪得溜圆',
                '气得跳脚', '停下手里的活', '逼近一步', '倚在门框旁', '快要呕吐', '硬撑着扭头',
                '抓狂', '端着碗冲出来抗议', '把碗往桌上一砸', '冷哼别过头', '收拾碗筷',
                '咬牙切齿', '拽被子翻身', '扔下一把钥匙', '冷冷瞥他一眼', '可怜兮兮地央求',
                '扶着腰喘粗气', '急得直跺脚', '脚步不停', '气急败坏', '小声骂骂咧咧',
                '满脸不乐意', '瘫倒在门前', '声音发颤', '抓紧行李箱拉杆', '心有余悸',
                '又惊又气', '语气波澜不惊', '从厨房探出身', '数了数', '嘴硬道', '两眼发直',
                '摸着脚下的黑泥', '蹲在炉边添引火草', '满不在乎地仰起脸', '接过工具赌气',
                '憋红了脸', '把一盆米端过来', '扣回锅盖', '倔强地咬咬牙', '淘米切菜',
                '又惊又喜', '缩了缩手', '眼眶通红', '神情严肃', '叹了口气', '依依不舍地站起身',
                '嘴角微动', '嘴唇发白', '语气不容置疑', '深吸一口气', '咂了咂嘴', '夹起鱼头',
                '筷子一颤', '倒退两步', '闭紧双眼', '摆摆手喘着粗气', '又急又气', '焦急推摇',
                '气若游丝', '咬牙爬起', '收起手机拔腿飞奔', '费力吐字', '敲了敲木栏',
                '掩饰性地揉揉眼角', '抓抓后脑勺，有些不好意思', '眼睛一亮', '脚步微微一顿',
                '眼角泛泪', '往对方碗里夹菜', '轻声呼唤', '难以置信')
        for cue in cues:
            with self.subTest(cue=cue):
                row = self.row(f'甲（{cue}）：原文不变。')
                self.assertEqual((row.get('kind'), row.get('speaker'), row.get('speech_text')),
                                 ('dialogue', '甲', '原文不变。'))

    def test_explicit_voice_and_performance_can_appear_in_either_order(self):
        for prefix in ('甲 VO（声音哽咽焦急）', '甲（难以置信）VO', '甲（难以置信）（VO）',
                       '甲（VO）（难以置信）', '甲VO(声音发颤)', 'VO：甲（难以置信）'):
            with self.subTest(prefix=prefix):
                row = self.row(prefix + '：保留原声。')
                self.assertEqual((row.get('kind'), row.get('speaker'), row.get('speech_text')),
                                 ('vo', '甲', '保留原声。'))
        self.assertEqual(self.row('甲 OS（深吸一口气）：原来的心声。')['kind'], 'os')

    def test_structure_markers_are_retained_as_headings(self):
        for marker in ('【下集钩子】', '【全剧终】'):
            self.assertEqual(self.row(marker), {'source_line': 2, 'source_text': marker, 'kind': 'heading'})
        for marker in ('【甲：别走】', '【下集钩子：甲说别走】', '【未知备注】'):
            self.assertIsNone(self.row(marker)['kind'])

    def test_paired_object_sounds_use_physical_or_explicit_sound_context(self):
        for text in ('▲铁棍砸碎木板！“砰！砰！”碎屑四溅。',
                     '▲“啪！”伴随着一声闷响，木头分成两段。',
                     '▲院门“吱呀”一声推开。',
                     '▲密林里传来“沙沙”的枝叶断裂声。',
                     '▲甲二话不说，转身端走饭菜。',
                     '▲甲不由分说地架起乙，快步进门。'):
            with self.subTest(text=text):
                row = self.row(text)
                self.assertEqual(row['kind'], 'action')
                self.assertEqual(row['source_text'], text)

    def test_terminal_delivery_cue_belongs_to_the_next_same_speaker(self):
        for direction in ('▲甲端起饭菜，朝客厅大喊。',
                          '▲清晨阳光照进院子。甲站在井旁，对着乙喊道。',
                          '▲几天后。甲背着书包，欢快地推开院门大喊。'):
            with self.subTest(direction=direction):
                self.assertEqual(self.row(direction, '甲：我回来啦！')['kind'], 'action')

    def test_delivery_attribution_mismatch_stays_pending_with_a_specific_reason(self):
        row = self.row('▲甲掂着玉米，惊喜地喊。', '乙：比我的还沉。')
        self.assertIsNone(row['kind'])
        self.assertIn('甲', row['reason'])
        self.assertIn('乙', row['reason'])
        self.assertIn('说话人不一致', row['reason'])

    def test_recognition_does_not_erase_identity_voice_or_embedded_words(self):
        for line in ('甲（眼眶通红，假扮乙）：别走。', '甲（少年时期，站起身）：别走。',
                     '甲 VO（OS，声音发颤）：别走。', '甲 VO（声音发颤）OS：别走。',
                     '甲 VO OS：别走。',
                     '甲（未知备注）：别走。', '甲（难以置信，念着“别走”）：等等。',
                     '丙（眼眶通红）：别走。', '▲甲二话不说，又低语“别走”。',
                     '▲木头砸下去，“砰！别走！”碎屑飞散。', '▲甲喊出“砰！”',
                     '▲甲张口“啊！”', '▲未知物件发出“神秘音”的声音。',
                     '▲甲砸断木板，张口“砰！”', '▲甲敲击木板，配音“啪！”',
                     '▲甲做口技，“铛”的一声。'):
            with self.subTest(line=line):
                self.assertIsNone(self.row(line)['kind'])
        for following in ('乙：我回来啦！', '甲 VO：我回来啦！',
                          '12-2 房间 日 内\n甲：我回来啦！', '▲甲进屋。\n甲：我回来啦！'):
            with self.subTest(following=following):
                self.assertIsNone(self.row('▲甲推门大喊。', following)['kind'])

    def test_action_speech_does_not_turn_description_into_a_new_identity(self):
        for line in ('▲甲走近后说：别走。', '▲甲的替身说：别走。', '▲甲（少年时期）说：别走。'):
            with self.subTest(line=line):
                self.assertIsNone(self.row(line)['kind'])
        row = self.row('▲甲（声音发颤）说：别走。')
        self.assertEqual((row.get('kind'), row.get('speaker')), ('dialogue', '甲'))

    def test_annotation_structure_applies_across_genres_without_a_performance_dictionary(self):
        examples = (('出场人物：云昭、陆宁', '云昭（攥紧绢帕）：此事交予我。'),
                    ('角色：林澈、陈律', '陈律（神色肃穆）：证据已经备齐。'),
                    ('登场人物：舰长、导航员', '导航员（蜷拢触须，尾鳍泛出银辉）：航道正常。'),
                    ('人物：阿岚、守卫', '阿岚（敛去锋芒（并未拔剑））：请开城门。'),
                    ('人物：Mira、Noah', 'Mira(with a weary smile): We have arrived.'),
                    ('人物：甲、乙', '甲【敛息屏神】：可以开始。'),
                    ('甲：原文。\n乙：原文。', '甲（敛息屏神）：原文。'))
        for roster, line in examples:
            with self.subTest(line=line):
                rows = classify_source_lines(roster + '\n' + line)
                self.assertFalse(any('reason' in row for row in rows), rows)
                self.assertEqual(rows[-1]['kind'], 'dialogue')

    def test_meta_identity_and_voice_notes_cannot_become_performance_by_syntax(self):
        for note in ('备注待补', 'TBD', '由乙代说', '附身后低语', 'using a different voice',
                     'flashback, younger self', 'OS/VO', '甲的幻影', '???'):
            with self.subTest(note=note):
                self.assertIsNone(self.row(f'甲（{note}）：原文。')['kind'])


if __name__ == '__main__':
    unittest.main()
