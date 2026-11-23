import type { Topic, TopicFacets, Work } from '../shared/types.ts';
import { buildTopicFacets as countTopics, TOPIC_GROUPS } from '../shared/topic-facets.ts';
import { sliceText } from '../shared/text.ts';

export { TOPIC_GROUPS };

interface Rule { id: string; label: string; group: string; pattern: RegExp; }
const rules: Rule[] = [
  { id: 'eighties', label: '八零年代', group: 'era', pattern: /八零|八十年代|198\d年|80年代|(?:重生|重回|重返|穿越|回到|年代)198\d/ },
  { id: 'seventies', label: '七零年代', group: 'era', pattern: /七零|七十年代|197\d年|70年代|(?:重生|重回|重返|穿越|回到|年代)197\d/ },
  { id: 'nineties', label: '九零年代', group: 'era', pattern: /九零|九十年代|199\d年|90年代|(?:重生|重回|重返|穿越|回到|年代)199\d/ },
  { id: 'republic', label: '民国', group: 'era', pattern: /民国|民國/ },
  { id: 'ancient', label: '古代古风', group: 'era', pattern: /古代|古风|古言|古装|大唐|大明|大宋|大秦/ },
  { id: 'urban', label: '现代都市', group: 'era', pattern: /都市|现代|现言/ },
  { id: 'apocalypse', label: '末世', group: 'era', pattern: /末世|末日|丧尸/ },
  { id: 'interstellar', label: '星际', group: 'era', pattern: /星际|星海|太空文明/ },
  { id: 'isekai', label: '异世界', group: 'era', pattern: /异世界|異世界|异界|異界/ },
  { id: 'time-travel', label: '穿越', group: 'setting', pattern: /穿越|穿书|穿成|快穿|魂穿|身穿|穿到/ },
  { id: 'rebirth', label: '重生', group: 'setting', pattern: /重生|重活一世|再活一世|(?:重回|重返)(?:[一二三四五六七八九零\d]{2,6}|[七八九]零|过去|少年|校园时代)/ },
  { id: 'system', label: '系统', group: 'setting', pattern: /系统|系統/ },
  { id: 'space', label: '随身空间', group: 'setting', pattern: /随身空间|空间灵泉|空间异能|空间种田|带着空间|空間靈泉/ },
  { id: 'mind-reading', label: '读心术', group: 'setting', pattern: /读心术|读心|心声被|听见.*心声|听到.*心声/ },
  { id: 'check-in', label: '签到', group: 'setting', pattern: /签到|簽到/ },
  { id: 'infinite', label: '无限流', group: 'setting', pattern: /无限流|无限副本|無限流/ },
  { id: 'rules-horror', label: '规则怪谈', group: 'setting', pattern: /规则怪谈|规则副本|規則怪談/ },
  { id: 'double-world', label: '两界穿梭', group: 'setting', pattern: /两界|两界穿梭|通古今|连接古今|古今互通/ },
  { id: 'powers', label: '异能', group: 'setting', pattern: /异能|異能|超能力/ },
  { id: 'revenge-rise', label: '打脸逆袭', group: 'plot', pattern: /打脸|逆袭|逆襲|屌丝逆袭|草根崛起/ },
  { id: 'revenge', label: '复仇', group: 'plot', pattern: /复仇|復仇|报仇|報仇|血海深仇/ },
  { id: 'hidden-identity', label: '马甲掉落', group: 'plot', pattern: /马甲|掉马|掉馬|隱藏身份|隐藏身份/ },
  { id: 'farming', label: '种田', group: 'plot', pattern: /种田|種田|种地|农场|農場|开荒/ },
  { id: 'business', label: '经商致富', group: 'plot', pattern: /经商|致富|发家|发财|首富|创业|倒货/ },
  { id: 'palace', label: '宫斗宅斗', group: 'plot', pattern: /宫斗|宅斗|宮鬥|宅鬥|后宫争斗/ },
  { id: 'power', label: '权谋争霸', group: 'plot', pattern: /权谋|权臣|夺嫡|争霸|權謀|奪嫡/ },
  { id: 'survival', label: '求生', group: 'plot', pattern: /求生|荒野生存|绝境生存/ },
  { id: 'mystery', label: '悬疑探案', group: 'plot', pattern: /悬疑|探案|破案|刑侦|刑偵|侦探|推理/ },
  { id: 'family', label: '家庭伦理', group: 'plot', pattern: /家庭|伦理|婆媳|家长里短|家長里短/ },
  { id: 'school', label: '校园', group: 'plot', pattern: /校园|校園|校花|高考|学霸|學霸/ },
  { id: 'entertainment', label: '娱乐圈', group: 'plot', pattern: /娱乐圈|娛樂圈|影帝|影后|顶流|頂流/ },
  { id: 'marriage-first', label: '先婚后爱', group: 'relationship', pattern: /先婚后爱|先婚後愛/ },
  { id: 'flash-marriage', label: '闪婚', group: 'relationship', pattern: /闪婚|閃婚/ },
  { id: 'contract-marriage', label: '契约婚姻', group: 'relationship', pattern: /契约婚|契約婚|协议结婚|协议婚姻/ },
  { id: 'reunion', label: '破镜重圆', group: 'relationship', pattern: /破镜重圆|破鏡重圓|旧爱重逢/ },
  { id: 'wife-chasing', label: '追妻火葬场', group: 'relationship', pattern: /追妻|追夫火葬场|追妻火葬场/ },
  { id: 'sweet', label: '甜宠', group: 'relationship', pattern: /甜宠|甜寵|甜恋|甜蜜恋爱|甜文/ },
  { id: 'angst', label: '虐恋', group: 'relationship', pattern: /虐恋|虐戀|虐心|虐文/ },
  { id: 'baby', label: '萌宝', group: 'relationship', pattern: /萌宝|萌寶|奶团|奶團|奶娃|奶包/ },
  { id: 'group-pet', label: '团宠', group: 'relationship', pattern: /团宠|團寵/ },
  { id: 'divorce', label: '离婚后', group: 'relationship', pattern: /离婚后|离婚後|離婚後|离异|離異/ },
  { id: 'fake-heiress', label: '真假千金', group: 'identity', pattern: /真假千金|真千金|假千金|被抱错的千金/ },
  { id: 'real-heir', label: '真假少爷', group: 'identity', pattern: /真假少爷|真少爷|假少爷|真假少爺/ },
  { id: 'ceo', label: '霸总豪门', group: 'identity', pattern: /总裁|總裁|霸总|霸總|豪门|豪門/ },
  { id: 'doctor', label: '神医', group: 'identity', pattern: /神医|神醫|医仙|医圣|醫聖|医武/ },
  { id: 'soldier', label: '兵王战神', group: 'identity', pattern: /兵王|战神|戰神|特种兵|特種兵/ },
  { id: 'son-in-law', label: '赘婿', group: 'identity', pattern: /赘婿|贅婿|上门女婿/ },
  { id: 'tycoon', label: '神豪', group: 'identity', pattern: /神豪|亿万富翁|百亿富豪/ },
  { id: 'chef', label: '厨娘美食', group: 'identity', pattern: /厨娘|厨神|厨艺|美食|神厨|廚娘/ },
  { id: 'female-lead', label: '女性成长', group: 'identity', pattern: /女性成长|大女主|独立女性|女性力量/ },
  { id: 'cultivation', label: '修仙玄幻', group: 'style', pattern: /修仙|修真|仙侠|玄幻|仙俠|仙界/ },
  { id: 'martial', label: '武侠', group: 'style', pattern: /武侠|武俠|江湖|武林/ },
  { id: 'comedy', label: '轻松搞笑', group: 'style', pattern: /搞笑|轻松|輕鬆|爆笑|喜剧|喜劇|沙雕/ },
  { id: 'horror', label: '惊悚灵异', group: 'style', pattern: /惊悚|灵异|灵異|恐怖|驚悚|诡异|詭異/ },
  { id: 'beast', label: '兽世', group: 'style', pattern: /兽世|獸世|兽人世界/ },
  { id: 'sci-fi', label: '科幻', group: 'style', pattern: /科幻|赛博|賽博|机甲|機甲/ },
  { id: 'competition', label: '电竞竞技', group: 'style', pattern: /电竞|電競|竞技|競技|电子竞技/ },
];

/** Extracts only explicit metadata terms and keeps the exact source evidence for each topic. */
export function classifyTopics(work: Pick<Work, 'title' | 'description' | 'tags'>): Topic[] {
  const text = `${work.title ?? ''}\n${work.description}`;
  return rules.flatMap<Topic>(rule => {
    const platform = work.tags.find(tag => explicitMatch(rule, tag));
    if (platform) return [{ id: rule.id, label: rule.label, group: rule.group, source: 'platform' as const, evidence: platform }];
    const match = explicitMatch(rule, text);
    if (!match) return [];
    const index = match.index ?? 0;
    return [{ id: rule.id, label: rule.label, group: rule.group, source: 'text' as const, evidence: sliceText(text, index - 12, index + match[0].length + 24).replaceAll('\n', ' ') }];
  });
}

function explicitMatch(rule: Rule, text: string): RegExpMatchArray | null {
  for (const match of text.matchAll(new RegExp(rule.pattern.source, 'g'))) {
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 8), index);
    if (/(?:没有|并非|不是|无需|不带|不含|不存在|无|非)$/.test(before)) continue;
    if (rule.id === 'seventies' && text.slice(index, index + 4) === '七零八落') continue;
    const after = text.slice(index + match[0].length);
    if (['eighties', 'seventies', 'nineties', 'rebirth'].includes(rule.id) && /\d$/.test(match[0])
      && /^(?:\d|万元|亿元|元|块|美元|人民币|次|个|套|件|集|章|人|台|公里|米|吨|斤|积分|%)/.test(after)) continue;
    return match;
  }
  return null;
}

/** Counts topics once per work within the current platform, board and keyword scope, classifying works stored without topics. */
export function buildTopicFacets(works: Work[]): TopicFacets {
  return countTopics(works, work => work.topics ?? classifyTopics(work));
}
