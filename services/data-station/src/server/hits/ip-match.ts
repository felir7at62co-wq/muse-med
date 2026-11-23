/**
 * Finds whether a Hongguo drama adapts a Fanqie novel already in the station's own catalog,
 * using titles, 《》 citations in the description, shared character names and description similarity.
 * Matching is evidence-based and conservative: only strong evidence confirms an adaptation; weaker evidence is 疑似.
 */
import type { IpMatch } from '../../shared/hits.ts';
import type { Work } from '../../shared/types.ts';
import type { HitRules } from './rules.ts';

type IpRules = HitRules['ip'];

const SEASON = /第[一二三四五六七八九十百零〇两\d]+[季部]/gu;
const NOT_WORD = /[^\p{L}\p{N}]/gu;
const SEPARATOR = /[：:，,、|｜—–\-（(【\[!！?？·~～]/u;

/** NFKC, lower case, without season markers, spaces or punctuation. */
export function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(SEASON, '').replace(NOT_WORD, '');
}

/** The part of a title before its first separator, without a trailing sequel number (「反向拿捏2：…」→「反向拿捏」). */
export function mainTitle(value: string): string {
  const head = value.normalize('NFKC').split(SEPARATOR)[0] ?? '';
  return normalizeTitle(head).replace(/[0-9一二三四五六七八九十]{1,2}$/u, '');
}

function titleKeys(title: string, minLength: number): { full: string | null; main: string | null } {
  const full = normalizeTitle(title);
  const main = mainTitle(title);
  return { full: full.length >= minLength ? full : null, main: main.length >= minLength && main !== full ? main : null };
}

const COMPOUND = new Set(['欧阳', '上官', '司马', '慕容', '南宫', '东方', '皇甫', '诸葛', '司徒', '夏侯', '令狐', '独孤', '公孙', '宇文', '长孙', '端木', '尉迟', '轩辕', '百里', '北堂', '西门', '赫连', '钟离', '澹台', '东郭', '南门']);
const SURNAMES = new Set([...'王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付傅方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤温霍乔裴纪司楚季阮柳萧殷洪易常凌卓穆祁商宁滕庞盛简席封墨厉薄靳晏闻池容祝云左游郁蓝岳尚倪邢安齐康伍余魏庄解颜'
]);
/** Characters that do not occur in given names; a candidate containing one is a phrase, not a name. */
const NOT_GIVEN = new Set([...'的了是在和与被把将对也都就又而之其这那他她它我你们个些不没为以及从到给让却但并再才已会能要想说看来去得地着过吗呢吧啊每各该此所等一二三四五六七八九十百千万亿年月日后前里中上下']);
/** Second characters that make a two-character candidate a form of address or a family word (林家, 王爷, 顾总). */
const NOT_SECOND = new Set([...'家氏某总爷姐哥妹弟叔婶母父妈爸夫妻老大小少太先生女男子儿']);
/** Frequent words that start with a surname character. */
const STOP_WORDS = new Set(['王爷', '王妃', '王府', '王朝', '高手', '高中', '高考', '高冷', '金钱', '金主', '黄金', '白月光', '江湖', '时间', '时候', '方面', '文化',
  '成功', '成为', '安全', '明白', '常年', '于是', '何时', '何必', '许多', '许久', '方式', '方法', '程序', '田地', '夏天', '秦朝', '宋朝', '唐朝', '明朝', '周围', '司机',
  '司令', '温柔', '温暖', '苏醒', '江山', '龙王', '龙族', '神医', '战神', '萧条', '万般', '钱财', '向往', '易容', '简单', '席卷', '封印', '安排', '安静', '齐心',
  '康复', '庄园', '云端', '左右', '游戏', '蓝天', '尚未', '容貌', '盛宴', '盛世', '池塘', '常常', '宁愿', '史上', '陆续', '江城', '叶家', '沈家', '顾家', '林家']);

function isHan(char: string): boolean { return /\p{Script=Han}/u.test(char); }
function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + needle.length)) count++;
  return count;
}

/**
 * Likely character names in a description: a common surname followed by one or two given-name characters,
 * repeated at least twice. The longest repeated form wins (「傅承彦」 over 「傅承」).
 */
export function extractNames(text: string): string[] {
  const normalized = text.normalize('NFKC');
  const candidates = new Set<string>();
  const chars = [...normalized];
  for (let index = 0; index < chars.length; index++) {
    const surnameLength = COMPOUND.has(chars[index]! + (chars[index + 1] ?? '')) ? 2 : SURNAMES.has(chars[index]!) ? 1 : 0;
    if (!surnameLength) continue;
    for (const givenLength of [1, 2]) {
      const given = chars.slice(index + surnameLength, index + surnameLength + givenLength);
      if (given.length !== givenLength || !given.every(isHan) || given.some(char => NOT_GIVEN.has(char))) continue;
      if (givenLength === 1 && surnameLength === 1 && NOT_SECOND.has(given[0]!)) continue;
      candidates.add(chars.slice(index, index + surnameLength).join('') + given.join(''));
    }
  }
  const counted = [...candidates].map(name => ({ name, count: occurrences(normalized, name) })).filter(item => item.count >= 2 && !STOP_WORDS.has(item.name));
  return counted.filter(item => !counted.some(other => other.name !== item.name && other.name.startsWith(item.name) && other.count >= item.count))
    .map(item => item.name);
}

/** Character-bigram Dice similarity of two descriptions, ignoring spaces and punctuation. */
export function descriptionSimilarity(left: string, right: string): number {
  const grams = (text: string) => {
    const clean = [...text.normalize('NFKC').toLowerCase().replace(NOT_WORD, '')];
    const result = new Set<string>();
    for (let index = 0; index + 1 < clean.length; index++) result.add(clean[index]! + clean[index + 1]!);
    return result;
  };
  const a = grams(left), b = grams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** The drama fields used for matching; `roles` are character names from the detail page cast (「饰 柳如意」). */
export interface DramaText { title: string | null; description: string; roles: string[]; }

interface Entry { id: string; title: string; description: string; }
interface Evidence { titleExact: boolean; titlePartial: boolean; cited: boolean; names: Set<string>; }

/** An index of the station's live Fanqie works, built once per selection run. */
export class FanqieIpIndex {
  private readonly entries: Entry[];
  private readonly fullTitles = new Map<string, number[]>();
  private readonly mainTitles = new Map<string, number[]>();
  /** Every title and description in one string, so a name is located with one scan; `starts` maps offsets back to entries. */
  private readonly corpus: string;
  private readonly starts: number[] = [];
  private readonly nameDocuments = new Map<string, number[] | null>();
  /** Changes whenever the catalog gains, loses or updates a Fanqie work. */
  readonly version: string;

  constructor(works: readonly Work[], private readonly rules: IpRules) {
    this.entries = works.filter(work => work.platform === 'fanqie' && work.origin === 'live' && work.title)
      .map(work => ({ id: work.id, title: work.title!, description: work.description }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const parts: string[] = [];
    let offset = 0;
    this.entries.forEach((entry, index) => {
      const keys = titleKeys(entry.title, rules.minTitleLength);
      if (keys.full) this.fullTitles.set(keys.full, [...this.fullTitles.get(keys.full) ?? [], index]);
      if (keys.main) this.mainTitles.set(keys.main, [...this.mainTitles.get(keys.main) ?? [], index]);
      const text = `${entry.title.normalize('NFKC')}\u0001${entry.description.normalize('NFKC')}\u0002`;
      this.starts.push(offset);
      parts.push(text);
      offset += text.length;
    });
    this.corpus = parts.join('');
    const latest = works.filter(work => work.platform === 'fanqie').reduce((max, work) => work.observedAt > max ? work.observedAt : max, '');
    this.version = `${this.entries.length}:${latest}`;
  }

  get size(): number { return this.entries.length; }

  private entryAt(offset: number): number {
    let low = 0, high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle]! <= offset) low = middle; else high = middle - 1;
    }
    return low;
  }

  /** Entries whose title or description contains the name, or null when it is in too many to be evidence. */
  private documentsWith(name: string): number[] | null {
    if (this.nameDocuments.has(name)) return this.nameDocuments.get(name)!;
    const found = new Set<number>();
    for (let index = this.corpus.indexOf(name); index >= 0; index = this.corpus.indexOf(name, index + 1)) {
      const entry = this.entryAt(index);
      found.add(entry);
      if (found.size > this.rules.maxNameDocuments) { this.nameDocuments.set(name, null); return null; }
      index = this.starts[entry + 1] !== undefined ? this.starts[entry + 1]! - 1 : this.corpus.length;
    }
    const result = [...found];
    this.nameDocuments.set(name, result);
    return result;
  }

  /**
   * Matches one drama against the catalog.
   * Confirmed: the description cites a catalog title in 《》, at least `confirmNames` distinct shared names,
   * or the same title with a shared name or a description similarity of at least `confirmSimilarity`.
   * Suspected: the same title alone, a shared main title, or one shared name with a similar description.
   */
  match(drama: DramaText): IpMatch {
    const evidence = new Map<number, Evidence>();
    const note = (index: number) => {
      let item = evidence.get(index);
      if (!item) { item = { titleExact: false, titlePartial: false, cited: false, names: new Set() }; evidence.set(index, item); }
      return item;
    };
    if (drama.title) {
      const keys = titleKeys(drama.title, this.rules.minTitleLength);
      for (const index of keys.full ? this.fullTitles.get(keys.full) ?? [] : []) note(index).titleExact = true;
      const partial = [keys.main && this.fullTitles.get(keys.main), keys.main && this.mainTitles.get(keys.main), keys.full && this.mainTitles.get(keys.full)];
      for (const list of partial) for (const index of list || []) { const item = note(index); if (!item.titleExact) item.titlePartial = true; }
    }
    for (const citation of drama.description.matchAll(/《([^》]{1,80})》/gu)) {
      const key = normalizeTitle(citation[1]!);
      if (key.length >= this.rules.minTitleLength) for (const index of this.fullTitles.get(key) ?? []) note(index).cited = true;
    }
    const names = [...new Set([...drama.roles.map(role => role.normalize('NFKC').trim()).filter(role => role.length >= 2 && [...role].every(isHan)), ...extractNames(drama.description)])];
    for (const name of names) {
      for (const index of this.documentsWith(name) ?? []) note(index).names.add(name);
    }
    let best: { level: IpMatch['level']; index: number; reasons: string[]; weight: number } | null = null;
    for (const [index, item] of evidence) {
      const entry = this.entries[index]!;
      const similarity = descriptionSimilarity(drama.description, entry.description);
      const shared = [...item.names];
      const reasons: string[] = [];
      if (item.cited) reasons.push(`简介引用《${entry.title}》`);
      if (item.titleExact) reasons.push('同名作品');
      if (item.titlePartial) reasons.push('主标题相同');
      if (shared.length) reasons.push(`共同人物：${shared.join('、')}`);
      if (similarity >= this.rules.suspectSimilarity) reasons.push(`简介相似度 ${similarity.toFixed(2)}`);
      const confirmed = item.cited || shared.length >= this.rules.confirmNames
        || (item.titleExact && (shared.length >= 1 || similarity >= this.rules.confirmSimilarity));
      const suspected = item.titleExact || item.titlePartial || (shared.length >= 1 && similarity >= this.rules.suspectSimilarity);
      if (!confirmed && !suspected) continue;
      const level = confirmed ? 'confirmed' : 'suspected';
      const weight = (confirmed ? 1_000 : 0) + (item.cited ? 100 : 0) + (item.titleExact ? 50 : 0) + shared.length * 10 + similarity;
      if (!best || weight > best.weight) best = { level, index, reasons, weight };
    }
    if (!best) return { level: 'none', fanqieWorkId: null, fanqieTitle: null, reasons: [] };
    const entry = this.entries[best.index]!;
    return { level: best.level, fanqieWorkId: entry.id, fanqieTitle: entry.title, reasons: best.reasons };
  }
}
