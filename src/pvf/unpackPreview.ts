import * as fs from 'fs/promises';
import * as path from 'path';
import type * as vscode from 'vscode';
import {
  UnpackMetadataService,
  UnpackResolvedMetadata,
  normalizeUnpackKey,
  rarityLabel,
  readLstFileToCodeMap,
  shouldResolveUnpackMetadataKey,
} from './unpackMetadata';

export type UnpackPreviewKind =
  | 'equipment'
  | 'equipmentSet'
  | 'stackable'
  | 'shop'
  | 'quest'
  | 'skill'
  | 'skillTree'
  | 'error';

export interface UnpackPreviewIcon {
  src: string;
  width?: number;
  height?: number;
  isQuestTag?: boolean;
}

export interface UnpackPreviewField {
  label: string;
  value: string;
  tagName?: string;
  tone?: 'normal' | 'muted' | 'good' | 'magic' | 'warning' | 'danger';
}

export interface UnpackPreviewEntry {
  code?: number;
  name?: string;
  key?: string;
  quantity?: number;
  detail?: string;
  x?: number;
  y?: number;
  branch?: string;
  common?: boolean;
  unresolved?: boolean;
  icon?: UnpackPreviewIcon;
}

export interface UnpackPreviewTable {
  caption?: string;
  headers: string[];
  rows: string[][];
  tagName?: string;
}

export interface UnpackPreviewSection {
  title: string;
  fields?: UnpackPreviewField[];
  lines?: string[];
  entries?: UnpackPreviewEntry[];
  tables?: UnpackPreviewTable[];
  tone?: 'normal' | 'blue' | 'flavor' | 'set' | 'shop' | 'quest' | 'skill';
}

export interface UnpackPreviewMiniMapPoint {
  x: number;
  y: number;
  resolved: boolean;
  common?: boolean;
  label?: string;
}

export interface UnpackPreviewMiniMap {
  points: UnpackPreviewMiniMapPoint[];
}

export interface UnpackPreviewSkillTreeNode {
  code: number;
  name?: string;
  key?: string;
  fsPath?: string;
  icon?: UnpackPreviewIcon;
  x?: number;
  y?: number;
  common?: boolean;
  unresolved?: boolean;
  nextSkills?: number[];
}

export interface UnpackPreviewSkillTreeGroup {
  title: string;
  job?: string;
  jobLabel?: string;
  branch?: string;
  branchLabel?: string;
  nodes: UnpackPreviewSkillTreeNode[];
}

export interface UnpackHoverPreview {
  kind: UnpackPreviewKind;
  title: string;
  subtitle?: string;
  key: string;
  fsPath: string;
  itemCode?: number;
  rarity?: number;
  rarityLabel?: string;
  icon?: UnpackPreviewIcon;
  badges?: string[];
  sections: UnpackPreviewSection[];
  miniMap?: UnpackPreviewMiniMap;
  skillTrees?: UnpackPreviewSkillTreeGroup[];
  message?: string;
  text?: string;
}

export interface UnpackPreviewInput {
  fsPath: string;
  key: string;
  name: string;
  root: string;
  version: string;
  isDirectory?: boolean;
}

export interface UnpackPreviewOptions {
  resolveIcon?: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  iconSettled: boolean;
  preview: UnpackHoverPreview | undefined;
}

interface LstCacheEntry {
  mtimeMs: number;
  size: number;
  fileToCode: Map<string, number>;
  codeToFile: Map<number, string>;
}

interface ParsedTags {
  values: Map<string, string[]>;
}

interface ScriptTagTitleFile {
  tags?: Array<{ name?: unknown; title?: unknown }>;
}

interface PreviewTagTitle {
  name: string;
  title: string;
}

type PreviewTagTitles = ReadonlyMap<string, PreviewTagTitle>;

interface SkillDataParameterFile {
  skills?: Record<string, SkillDataParameterSkill | undefined>;
  byCode?: Record<string, string | string[] | undefined>;
}

interface SkillDataParameterSkill {
  name?: string;
  codes?: number[];
  scenes?: Record<string, SkillDataParameterScene | undefined>;
  references?: {
    nut?: string[];
    ani?: string[];
  };
}

interface SkillDataParameterScene {
  levelInfo?: Record<string, string | string[] | undefined>;
  staticData?: Record<string, string | string[] | undefined>;
}

interface SkillDataParameterConfig {
  byPath: Map<string, SkillDataParameterSkill>;
  byCode: Map<number, Array<{ key: string; skill: SkillDataParameterSkill }>>;
}

interface CodeReference {
  code: number;
  key?: string;
  fsPath?: string;
  name?: string;
  metadata?: UnpackResolvedMetadata;
  unresolved?: boolean;
}

interface SkillTreeNode {
  code: number;
  x?: number;
  y?: number;
  common?: boolean;
  nextSkills: number[];
}

interface ParsedSkillTreeGroup {
  job?: string;
  branch?: string;
  nodes: SkillTreeNode[];
}

const EQUIPMENT_LST = ['equipment/equipment.lst'];
const STACKABLE_LST = ['stackable/stackable.lst'];
const ITEM_LSTS = [...EQUIPMENT_LST, ...STACKABLE_LST];
const SKILL_LISTS_BY_JOB: Record<string, string[]> = {
  swordman: ['skill/swordmanskill.lst'],
  'at swordman': ['skill/atswordmanskill.lst'],
  atswordman: ['skill/atswordmanskill.lst'],
  fighter: ['skill/fighterskill.lst'],
  'at fighter': ['skill/atfighterskill.lst'],
  atfighter: ['skill/atfighterskill.lst'],
  gunner: ['skill/gunnerskill.lst'],
  'at gunner': ['skill/atgunnerskill.lst'],
  atgunner: ['skill/atgunnerskill.lst'],
  mage: ['skill/mageskill.lst'],
  'at mage': ['skill/atmageskill.lst'],
  atmage: ['skill/atmageskill.lst'],
  priest: ['skill/priestskill.lst'],
  thief: ['skill/thiefskill.lst'],
  'demonic swordman': ['skill/demonicswordman.lst'],
  demonicswordman: ['skill/demonicswordman.lst'],
  creator: ['skill/creatormageskill.lst', 'skill/creatormage.lst'],
  'creator mage': ['skill/creatormageskill.lst', 'skill/creatormage.lst'],
  creatormage: ['skill/creatormageskill.lst', 'skill/creatormage.lst'],
  common: ['skill/skilllist.lst', 'skill/skill.lst'],
};
const COMMON_SKILL_LSTS = ['skill/skilllist.lst', 'skill/skill.lst'];

const BLOCK_VALUE_TAGS = new Set([
  'a condition item',
  'b condition item',
  'booster random',
  'command',
  'common skill',
  'consume item',
  'dungeon info',
  'enemy reward item',
  'etc',
  'executable states',
  'int data',
  'level info',
  'level property',
  'material',
  'monster reward item',
  'need material',
  'output',
  'package data',
  'piece set ability',
  'pre required skill',
  'purchase cost',
  'random list',
  'result item',
  'reward int data',
  'reward selection int data',
  'sell item',
  'set ability',
  'set item',
  'skill fitness growtype',
  'skill fitness second growtype',
  'skill info',
  'skill levelup',
  'skill under cooltime effect',
  'skill under cooltime effect each',
  'special level up',
  'special purchase cost',
  'spending item',
  'static data',
  'string data',
  'usable job',
]);

const EQUIPMENT_STAT_LABELS: Record<string, string> = {
  'equipment physical attack': '物理攻击力',
  'equipment magical attack': '魔法攻击力',
  'equipment physical defense': '物理防御力',
  'equipment magical defense': '魔法防御力',
  'separate attack': '独立攻击力',
  'physical attack': '力量',
  'magical attack': '智力',
  'physical defense': '体力',
  'magical defense': '精神',
};

const EQUIPMENT_MAGIC_LABELS: Record<string, string> = {
  'physical critical hit': '物理暴击率',
  'magical critical hit': '魔法暴击率',
  'attack speed': '攻击速度',
  'cast speed': '施放速度',
  'move speed': '移动速度',
  'jump power': '跳跃力',
  'hit recovery': '硬直',
  'room list move speed rate': '城镇移动速度',
  stuck: '命中率',
  'stuck resistance': '回避率',
  'hp max': 'HP 最大值',
  'mp max': 'MP 最大值',
  'hp regen speed': 'HP 回复速度',
  'mp regen speed': 'MP 回复速度',
  'all elemental resistance': '所有属性抗性',
  'all elemental attack': '所有属性强化',
  'fire attack': '火属性强化',
  'water attack': '冰属性强化',
  'ice attack': '冰属性强化',
  'light attack': '光属性强化',
  'dark attack': '暗属性强化',
  'inventory limit': '负重上限',
  'slow resistance': '减速抗性',
  'freeze resistance': '冰冻抗性',
  'poison resistance': '中毒抗性',
  'stun resistance': '眩晕抗性',
  'curse resistance': '诅咒抗性',
  'blind resistance': '失明抗性',
  'lightning resistance': '感电抗性',
  'stone resistance': '石化抗性',
  'sleep resistance': '睡眠抗性',
  'bleeding resistance': '出血抗性',
  'confuse resistance': '混乱抗性',
  'hold resistance': '束缚抗性',
  'burn resistance': '灼伤抗性',
  'weapon break resistance': '武器破坏抗性',
  'armor break resistance': '防具破坏抗性',
  'piercing resistance': '贯通抗性',
};

const JOB_LABELS: Record<string, string> = {
  all: '所有职业',
  swordman: '鬼剑士(男)',
  'at swordman': '鬼剑士(女)',
  atswordman: '鬼剑士(女)',
  fighter: '格斗家(女)',
  'at fighter': '格斗家(男)',
  atfighter: '格斗家(男)',
  gunner: '神枪手(男)',
  'at gunner': '神枪手(女)',
  atgunner: '神枪手(女)',
  mage: '魔法师(女)',
  'at mage': '魔法师(男)',
  atmage: '魔法师(男)',
  priest: '圣职者',
  thief: '暗夜使者',
  'demonic swordman': '黑暗武士',
  demonicswordman: '黑暗武士',
  'creator mage': '缔造者',
  creatormage: '缔造者',
  none: '未转职',
  weaponmaster: '剑魂',
  soulbringer: '鬼泣',
  berserker: '狂战士',
  asura: '阿修罗',
  ranger: '漫游枪手',
  launcher: '枪炮师',
  mechanic: '机械师',
  spitfire: '弹药专家',
  elementalmaster: '元素师',
  summoner: '召唤师',
  battlemage: '战斗法师',
  witch: '魔道学者',
  nenmaster: '气功师',
  striker: '散打',
  streetfighter: '街霸',
  grappler: '柔道家',
  crusader: '圣骑士',
  infighter: '蓝拳圣使',
  exorcist: '驱魔师',
  avenger: '复仇者',
  rogue: '刺客',
  necromancer: '死灵术士',
};

const TRADE_LABELS: Record<string, string> = {
  '[trade]': '无法交易',
  '[free]': '自由交易',
  '[sealing]': '封装',
  '[trade delete]': '无法交易/删除',
  '[account]': '账号绑定',
  '[sealing trade]': '封装且不可交易',
};

const KNOWN_PREVIEW_TAGS = new Set([
  ...BLOCK_VALUE_TAGS,
  'attach type',
  'basic explain',
  'basic explain ex',
  'cash',
  'casting time',
  'command key explain',
  'complete npc index',
  'consume mp',
  'cool time',
  'detail explain',
  'equipment magical attack',
  'equipment magical defense',
  'equipment physical attack',
  'equipment physical defense',
  'equipment type',
  'explain',
  'explain ex',
  'flavor text',
  'fullset basic explain',
  'fullset detail explain',
  'grade',
  'growtype maximum level',
  'icon',
  'icon pos',
  'index',
  'item group name',
  'job',
  'job message',
  'maximum level',
  'message',
  'minimum level',
  'name',
  'name2',
  'next skill',
  'npc',
  'npc index',
  'parameter basic explain',
  'parameter detail explain',
  'price',
  'rarity',
  'relation quest',
  'required level',
  'required level range',
  'reward type',
  'set name',
  'skill class',
  'skill command advantage',
  'stack limit',
  'stackable type',
  'start cool time',
  'tab name',
  'type',
  'use effect explain',
  'value',
  'weapon effect type',
  'weight',
  ...Object.keys(EQUIPMENT_STAT_LABELS),
  ...Object.keys(EQUIPMENT_MAGIC_LABELS),
]);

export class UnpackPreviewService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lstCache = new Map<string, LstCacheEntry | undefined>();
  private readonly lstPromises = new Map<string, Promise<LstCacheEntry | undefined>>();
  private readonly tagTitlePromises = new Map<string, Promise<Map<string, PreviewTagTitle>>>();
  private skillDataParametersPromise: Promise<SkillDataParameterConfig> | undefined;

  constructor(
    private readonly metadata: UnpackMetadataService,
    private readonly context: vscode.ExtensionContext,
    private readonly output?: { appendLine(value: string): void },
  ) {}

  clear(): void {
    this.cache.clear();
    this.lstCache.clear();
    this.lstPromises.clear();
    this.tagTitlePromises.clear();
    this.skillDataParametersPromise = undefined;
  }

  invalidate(input: UnpackPreviewInput): void {
    const cacheKey = `${path.resolve(input.root)}\0${normalizeUnpackKey(input.key)}\0${input.version}`;
    this.cache.delete(cacheKey);
  }

  async resolvePreview(input: UnpackPreviewInput, options: UnpackPreviewOptions = {}): Promise<UnpackHoverPreview | undefined> {
    if (input.isDirectory || !input.key) return undefined;
    const shouldResolveIcon = options.resolveIcon === true;
    const kind = this.previewKind(input.key, '');
    if (!kind && !shouldProbePreviewText(input.key)) return undefined;
    try {
      const stat = await fs.stat(input.fsPath);
      if (!stat.isFile()) return undefined;
      const cacheKey = `${path.resolve(input.root)}\0${normalizeUnpackKey(input.key)}\0${input.version}`;
      const cached = this.cache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && (!shouldResolveIcon || cached.iconSettled)) {
        return cached.preview;
      }

      const text = await readUtf8Text(input.fsPath);
      const resolvedKind = this.previewKind(input.key, text);
      if (!resolvedKind) return undefined;
      const metadata = shouldResolveUnpackMetadataKey(input.key)
        ? await this.metadata.resolveMetadata(input).catch(() => undefined)
        : undefined;
      let latestMetadata = this.metadata.getCached(input) || metadata;
      if (shouldResolveIcon && latestMetadata?.icon && !latestMetadata.iconDataUri) {
        await this.metadata.resolveIcon(input).catch((err: any) => {
          this.output?.appendLine(`[PVF] failed to resolve preview icon ${input.key}: ${String(err && err.message || err)}`);
          return undefined;
        });
        latestMetadata = this.metadata.getCached(input) || latestMetadata;
      }
      const preview = await this.buildPreview(input, text, resolvedKind, latestMetadata, options);
      latestMetadata = this.metadata.getCached(input) || latestMetadata;
      this.cache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, iconSettled: previewIconSettled(latestMetadata, shouldResolveIcon), preview });
      return preview;
    } catch (err: any) {
      return this.errorPreview(input, String(err && err.message || err));
    }
  }

  private previewKind(key: string, text: string): UnpackPreviewKind | undefined {
    const normalized = normalizeUnpackKey(key);
    if (normalized.endsWith('.equ')) {
      return hasSetTags(text) ? 'equipmentSet' : 'equipment';
    }
    if (normalized.endsWith('.stk')) return 'stackable';
    if (normalized.endsWith('.shp')) return 'shop';
    if (normalized.endsWith('.qst')) return 'quest';
    if (normalized.endsWith('.skl')) return 'skill';
    if (isSkillTreeKey(normalized) || isSkillTreeText(text)) return 'skillTree';
    return undefined;
  }

  private async buildPreview(
    input: UnpackPreviewInput,
    text: string,
    kind: UnpackPreviewKind,
    metadata: UnpackResolvedMetadata | undefined,
    options: UnpackPreviewOptions = {},
  ): Promise<UnpackHoverPreview> {
    const tags = parseTags(text);
    switch (kind) {
      case 'equipmentSet': return this.buildEquipmentSetPreview(input, tags, metadata);
      case 'equipment': return this.buildEquipmentPreview(input, tags, metadata);
      case 'stackable': return this.buildStackablePreview(input, tags, metadata);
      case 'shop': return this.buildShopPreview(input, tags, metadata);
      case 'quest': return this.buildQuestPreview(input, tags, metadata);
      case 'skill': return this.buildSkillPreview(input, text, tags, metadata);
      case 'skillTree': return this.buildSkillTreePreview(input, text, tags, metadata, options);
      default: return this.errorPreview(input, '不支持的预览类型');
    }
  }

  private async buildEquipmentPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('equ');
    const fields = compactFields([
      field('道具ID', numText(metadata?.itemCode)),
      tagField(titles, 'equipment type', '类型', labelToken(firstValue(tags, 'equipment type'))),
      tagField(titles, 'item group name', '物品组', cleanValue(firstValue(tags, 'item group name'))),
      tagField(titles, 'minimum level', '等级限制', levelText(firstNumber(tags, 'minimum level'))),
      tagField(titles, 'durability', '耐久度', numText(firstNumber(tags, 'durability'))),
      tagField(titles, 'weight', '重量', weightText(firstNumber(tags, 'weight'))),
      tagField(titles, 'attach type', '交易', tradeText(firstValue(tags, 'attach type'))),
      tagField(titles, 'value', '出售价格', priceText(firstNumber(tags, 'value'), 5)),
      tagField(titles, 'price', '价格', priceText(firstNumber(tags, 'price'))),
    ]);
    if (fields.length) sections.push({ title: '装备信息', fields });

    const jobs = tagLines(tags, 'usable job').map(line => labelToken(line)).filter(isString);
    if (jobs.length) sections.push({ title: '可使用职业', lines: [jobs.map(job => JOB_LABELS[job.toLowerCase()] || job).join('、')] });

    const baseStats = statFields(tags, EQUIPMENT_STAT_LABELS, false, titles);
    if (baseStats.length) sections.push({ title: '基础属性', fields: baseStats });

    const magicStats = statFields(tags, EQUIPMENT_MAGIC_LABELS, true, titles);
    if (magicStats.length) sections.push({ title: '特殊属性', fields: magicStats, tone: 'blue' });

    const materialCodes = parseLooseItemEntries(tagLines(tags, 'need material', 'material', 'condition item', 'a condition item', 'b condition item'));
    if (materialCodes.length) sections.push({ title: '材料/条件', entries: await this.resolveEntries(materialCodes.slice(0, 24), input, ITEM_LSTS) });

    addTextSection(sections, '装备说明', explainLines(tags, 'basic explain', 'detail explain', 'explain'), 'blue');
    addTextSection(sections, '风味文本', explainLines(tags, 'flavor text'), 'flavor');

    return this.basePreview(input, metadata, 'equipment', displayTitle(input, tags, metadata), '装备', sections);
  }

  private async buildEquipmentSetPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const setItems = numbersFromLines(tagLines(tags, 'set item')).filter(code => code >= 0);
    if (setItems.length) {
      const refs = await this.resolveEntries(setItems.map(code => ({ code })), input, ITEM_LSTS);
      sections.push({ title: '套装部件', entries: refs, tone: 'set' });
    }
    addTextSection(sections, '套装属性', tagLines(tags, 'set ability'), 'set');
    addTextSection(sections, '件数属性', tagLines(tags, 'piece set ability'), 'set');
    addTextSection(sections, '全套说明', explainLines(tags, 'fullset basic explain', 'fullset detail explain'), 'blue');
    addTextSection(sections, '参数说明', explainLines(tags, 'parameter basic explain', 'parameter detail explain'), 'blue');
    return this.basePreview(input, metadata, 'equipmentSet', cleanValue(firstValue(tags, 'set name')) || displayTitle(input, tags, metadata), '套装', sections);
  }

  private async buildStackablePreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('stk');
    const fields = compactFields([
      field('ID', numText(metadata?.itemCode)),
      tagField(titles, 'stackable type', '类型', labelToken(firstValue(tags, 'stackable type'))),
      tagField(titles, 'stack limit', '堆叠上限', numText(firstNumber(tags, 'stack limit'))),
      tagField(titles, 'minimum level', '等级限制', levelText(firstNumber(tags, 'minimum level'))),
      tagField(titles, 'attach type', '交易', tradeText(firstValue(tags, 'attach type'))),
      tagField(titles, 'value', '出售价格', priceText(firstNumber(tags, 'value'), 5)),
      tagField(titles, 'price', '价格', priceText(firstNumber(tags, 'price'))),
    ]);
    if (fields.length) sections.push({ title: '道具信息', fields });
    addTextSection(sections, '道具说明', explainLines(tags, 'explain', 'basic explain', 'detail explain', 'use effect explain'), 'blue');

    const packageCodes = parsePairedItemCodes(tagLines(tags, 'package data'));
    if (packageCodes.length) sections.push({ title: '礼包内容', entries: await this.resolveEntries(packageCodes, input, ITEM_LSTS), tone: 'shop' });

    const randomCodes = parseLooseItemEntries(tagLines(tags, 'random list', 'booster random', 'etc', 'output', 'result item'));
    if (randomCodes.length) sections.push({ title: '随机/产出内容', entries: await this.resolveEntries(randomCodes.slice(0, 32), input, ITEM_LSTS), tone: 'shop' });

    const materialCodes = parseLooseItemEntries(tagLines(tags, 'need material', 'material', 'condition item', 'a condition item', 'b condition item'));
    if (materialCodes.length) sections.push({ title: '材料/条件', entries: await this.resolveEntries(materialCodes.slice(0, 24), input, ITEM_LSTS) });

    addTextSection(sections, '附魔/特殊数据', tagLines(tags, 'enchant', 'monster card id', 'string data', 'stat change', 'stat change duration'), 'blue');
    addTextSection(sections, '风味文本', explainLines(tags, 'flavor text'), 'flavor');
    return this.basePreview(input, metadata, 'stackable', displayTitle(input, tags, metadata), '道具', sections);
  }

  private async buildShopPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('shp');
    const fields = compactFields([
      field('代码', numText(metadata?.itemCode)),
      tagField(titles, 'message', '消息', cleanValue(firstValue(tags, 'message'))),
      tagField(titles, 'weapon shop', '商店类型', hasTag(tags, 'weapon shop') ? '武器商店' : undefined),
      tagField(titles, 'npc', 'NPC', cleanValue(firstValue(tags, 'npc'))),
    ]);
    if (fields.length) sections.push({ title: '商店信息', fields, tone: 'shop' });
    const tabs = tagLines(tags, 'tab name').map(cleanValue).filter(isString);
    if (tabs.length) sections.push({ title: '标签页', lines: tabs });

    const sellEntries = parseShopEntries(tagLines(tags, 'sell item'));
    if (sellEntries.length) {
      sections.push({ title: '出售商品', entries: await this.resolveEntries(sellEntries.slice(0, 80), input, ITEM_LSTS), tone: 'shop' });
    }
    const spendingEntries = parseLooseItemEntries(tagLines(tags, 'spending item', 'need material'));
    if (spendingEntries.length) {
      sections.push({ title: '兑换/消耗材料', entries: await this.resolveEntries(spendingEntries.slice(0, 40), input, ITEM_LSTS), tone: 'shop' });
    }
    return this.basePreview(input, metadata, 'shop', displayTitle(input, tags, metadata), 'NPC 商店', sections);
  }

  private async buildQuestPreview(
    input: UnpackPreviewInput,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('qst');
    const fields = compactFields([
      field('代码', numText(metadata?.itemCode)),
      tagField(titles, 'type', '类型', labelToken(firstValue(tags, 'type'))),
      tagField(titles, 'reward type', '奖励类型', labelToken(firstValue(tags, 'reward type'))),
      tagField(titles, 'grade', '任务品级', metadata?.grade || labelToken(firstValue(tags, 'grade'))),
      tagField(titles, 'job', '职业', labelToken(firstValue(tags, 'job'))),
      tagField(titles, 'npc index', '接取 NPC', numText(firstNumber(tags, 'npc index'))),
      tagField(titles, 'complete npc index', '完成 NPC', numText(firstNumber(tags, 'complete npc index'))),
      tagField(titles, 'pre required quest', '前置任务', numText(firstNumber(tags, 'pre required quest'))),
      tagField(titles, 'relation quest', '关联任务', numText(firstNumber(tags, 'relation quest'))),
    ]);
    if (fields.length) sections.push({ title: '任务信息', fields, tone: 'quest' });
    addTextSection(sections, '任务说明', explainLines(tags, 'explain', 'basic explain', 'detail explain', 'depend message', 'job message'), 'quest');
    addTextSection(sections, '完成条件', tagLines(tags, 'int data', 'dungeon info', 'monster reward item', 'enemy reward item', 'clear reward item'), 'quest');

    const rewardEntries = [
      ...parsePairedItemCodes(tagLines(tags, 'reward int data')),
      ...parseQuestSelectionRewards(tagLines(tags, 'reward selection int data')),
    ];
    if (rewardEntries.length) {
      sections.push({ title: '任务奖励', entries: await this.resolveEntries(rewardEntries.slice(0, 60), input, ITEM_LSTS), tone: 'quest' });
    }
    return this.basePreview(input, metadata, 'quest', displayTitle(input, tags, metadata), '任务', sections);
  }

  private async buildSkillPreview(
    input: UnpackPreviewInput,
    text: string,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
  ): Promise<UnpackHoverPreview> {
    const sections: UnpackPreviewSection[] = [];
    const titles = await this.loadTagTitles('skl');
    const fields = compactFields([
      field('代码', numText(metadata?.itemCode)),
      tagField(titles, 'type', '类型', labelToken(firstValue(tags, 'type'))),
      tagField(titles, 'skill class', '技能类', cleanValue(firstValue(tags, 'skill class'))),
      tagField(titles, 'required level', '学习等级', levelText(firstNumber(tags, 'required level'))),
      tagField(titles, 'required level range', '等级间隔', numText(firstNumber(tags, 'required level range'))),
      tagField(titles, 'maximum level', '最高等级', numText(firstNumber(tags, 'maximum level'))),
      tagField(titles, 'cool time', '冷却时间', timeMsText(firstNumber(tags, 'cool time'))),
      tagField(titles, 'start cool time', '开始冷却', timeMsText(firstNumber(tags, 'start cool time'))),
      tagField(titles, 'consume mp', 'MP 消耗', rangeText(numbersFromLines(tagLines(tags, 'consume mp')))),
      tagField(titles, 'casting time', '施法时间', timeMsText(firstNumber(tags, 'casting time'), 100)),
      tagField(titles, 'weapon effect type', '伤害类型', labelToken(firstValue(tags, 'weapon effect type'))),
    ]);
    if (fields.length) sections.push({ title: '技能信息', fields, tone: 'skill' });
    addTextSection(sections, '技能说明', explainLines(tags, 'basic explain', 'explain', 'basic explain ex', 'explain ex'), 'skill');
    addTextSection(sections, '技能属性', tagLines(tags, 'level property', 'special level up'), 'blue');
    addTextSection(sections, '前置/消耗', tagLines(tags, 'pre required skill', 'consume item', 'purchase cost', 'special purchase cost'), 'skill');
    addTextSection(sections, '指令', tagLines(tags, 'command', 'command key explain', 'skill command advantage'), 'skill');
    const dataParameterConfig = await this.loadSkillDataParameters();
    const dataParameters = findSkillDataParameters(dataParameterConfig, input, metadata);
    const dataTables = buildSkillDataTables(text, dataParameters);
    if (dataTables.length) sections.push({ title: '动态/静态数据', tables: dataTables, tone: 'blue' });
    addTextSection(sections, '特殊效果', tagLines(tags, 'skill under cooltime effect', 'skill under cooltime effect each'), 'blue');
    return this.basePreview(input, metadata, 'skill', displayTitle(input, tags, metadata), '技能', sections);
  }

  private async buildSkillTreePreview(
    input: UnpackPreviewInput,
    text: string,
    tags: ParsedTags,
    metadata: UnpackResolvedMetadata | undefined,
    options: UnpackPreviewOptions = {},
  ): Promise<UnpackHoverPreview> {
    const groups = parseSkillTreeGroups(text);
    const nodes = groups.flatMap(group => group.nodes);
    const treeType = skillTreeType(input.key);
    const firstJob = groups.find(group => group.job)?.job || firstSkillTreeJob(text) || labelToken(firstValue(tags, 'character job'));
    let resolvedCount = 0;
    const skillTrees: UnpackPreviewSkillTreeGroup[] = [];
    for (const group of groups) {
      const lsts = skillLstsForJob(group.job);
      const treeNodes: UnpackPreviewSkillTreeNode[] = [];
      for (const node of group.nodes) {
        const ref = await this.resolveCode(input, node.code, node.common ? COMMON_SKILL_LSTS : lsts, options.resolveIcon === true);
        if (ref.key) resolvedCount++;
        treeNodes.push({
          code: node.code,
          name: ref.name,
          key: ref.key,
          fsPath: ref.fsPath,
          x: node.x,
          y: node.y,
          common: node.common,
          unresolved: !ref.key,
          icon: iconFromMetadata(ref.metadata),
          ...(node.nextSkills.length ? { nextSkills: node.nextSkills } : {}),
        });
      }
      const jobLabel = group.job ? labelJob(group.job) : undefined;
      const branchLabel = group.branch ? labelJob(group.branch) : undefined;
      skillTrees.push({
        title: [jobLabel, branchLabel].filter(Boolean).join(' / ') || '技能树',
        ...(group.job ? { job: group.job, jobLabel } : {}),
        ...(group.branch ? { branch: group.branch, branchLabel } : {}),
        nodes: treeNodes,
      });
    }
    return {
      kind: 'skillTree',
      title: skillTreeTitle(input, firstJob),
      subtitle: '技能树',
      key: input.key,
      fsPath: input.fsPath,
      ...(typeof metadata?.itemCode === 'number' ? { itemCode: metadata.itemCode } : {}),
      ...(typeof metadata?.rarity === 'number' ? { rarity: metadata.rarity, rarityLabel: rarityLabel(metadata.rarity) } : {}),
      ...(iconFromMetadata(metadata) ? { icon: iconFromMetadata(metadata) } : {}),
      sections: [],
      badges: [treeType],
      skillTrees,
      ...(nodes.length ? {} : { message: '没有解析到可绘制的技能树节点。' }),
    };
  }

  private basePreview(
    input: UnpackPreviewInput,
    metadata: UnpackResolvedMetadata | undefined,
    kind: UnpackPreviewKind,
    title: string,
    subtitle: string,
    sections: UnpackPreviewSection[],
  ): UnpackHoverPreview {
    return {
      kind,
      title: title || input.name,
      subtitle,
      key: input.key,
      fsPath: input.fsPath,
      ...(typeof metadata?.itemCode === 'number' ? { itemCode: metadata.itemCode } : {}),
      ...(typeof metadata?.rarity === 'number' ? { rarity: metadata.rarity, rarityLabel: rarityLabel(metadata.rarity) } : {}),
      ...(iconFromMetadata(metadata) ? { icon: iconFromMetadata(metadata) } : {}),
      sections: sections.length ? sections : [{ title: '文件信息', fields: compactFields([field('路径', input.key)]) }],
    };
  }

  private errorPreview(input: UnpackPreviewInput, message: string): UnpackHoverPreview {
    return {
      kind: 'error',
      title: input.name,
      subtitle: '预览失败',
      key: input.key,
      fsPath: input.fsPath,
      message,
      sections: [{ title: '错误', lines: [message] }],
    };
  }

  private async loadTagTitles(short: string): Promise<PreviewTagTitles> {
    const normalized = short.toLowerCase();
    let promise = this.tagTitlePromises.get(normalized);
    if (!promise) {
      promise = this.readTagTitles(normalized);
      this.tagTitlePromises.set(normalized, promise);
    }
    return promise;
  }

  private async readTagTitles(short: string): Promise<Map<string, PreviewTagTitle>> {
    const candidates = [
      path.join(this.context.extensionUri.fsPath, 'dist', 'config', 'scriptLang', 'scriptTags', `${short}.json`),
      path.join(this.context.extensionUri.fsPath, 'src', 'config', 'scriptLang', 'scriptTags', `${short}.json`),
    ];
    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        const data = JSON.parse(raw) as ScriptTagTitleFile;
        const titles = new Map<string, PreviewTagTitle>();
        for (const tag of data.tags || []) {
          if (typeof tag.name !== 'string' || typeof tag.title !== 'string') continue;
          const title = tag.title.trim();
          const name = tag.name.trim();
          if (name && title) titles.set(name.toLowerCase(), { name, title });
        }
        return titles;
      } catch {
      }
    }
    return new Map<string, PreviewTagTitle>();
  }

  private async loadSkillDataParameters(): Promise<SkillDataParameterConfig> {
    if (!this.skillDataParametersPromise) {
      this.skillDataParametersPromise = this.readSkillDataParameters();
    }
    return this.skillDataParametersPromise;
  }

  private async readSkillDataParameters(): Promise<SkillDataParameterConfig> {
    const empty: SkillDataParameterConfig = { byPath: new Map(), byCode: new Map() };
    const candidates = [
      path.join(this.context.extensionUri.fsPath, 'dist', 'config', 'pvf', 'skillDataParameters.json'),
      path.join(this.context.extensionUri.fsPath, 'src', 'config', 'pvf', 'skillDataParameters.json'),
    ];
    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(candidate, 'utf8');
        return normalizeSkillDataParameterFile(JSON.parse(raw) as SkillDataParameterFile);
      } catch {
      }
    }
    return empty;
  }

  private async resolveEntries(
    values: Array<{ code: number; quantity?: number; detail?: string }>,
    input: UnpackPreviewInput,
    lstKeys: string[],
  ): Promise<UnpackPreviewEntry[]> {
    const entries: UnpackPreviewEntry[] = [];
    for (const value of values) {
      if (!Number.isSafeInteger(value.code)) continue;
      if (value.code === 0) {
        entries.push({ code: value.code, name: '金币', quantity: value.quantity, detail: value.detail });
        continue;
      }
      const ref = await this.resolveCode(input, value.code, lstKeys);
      entries.push({
        code: value.code,
        name: ref.name,
        key: ref.key,
        quantity: value.quantity,
        detail: value.detail,
        unresolved: !ref.key,
        icon: iconFromMetadata(ref.metadata),
      });
    }
    return entries;
  }

  private async resolveCode(input: UnpackPreviewInput, code: number, lstKeys: string[], resolveIcon = false): Promise<CodeReference> {
    for (const lstKey of lstKeys) {
      const lstPath = safeJoinArchivePath(input.root, lstKey);
      if (!lstPath) continue;
      const entry = await this.loadLst(lstPath);
      const key = entry?.codeToFile.get(code);
      if (!key) continue;
      const fsPath = safeJoinArchivePath(input.root, key);
      if (!fsPath) return { code, key };
      const refInput: UnpackPreviewInput = {
        fsPath,
        key,
        name: path.basename(fsPath),
        root: input.root,
        version: input.version,
      };
      let refMeta: UnpackResolvedMetadata | undefined;
      try {
        refMeta = await this.metadata.resolveMetadata(refInput);
        if (resolveIcon && refMeta?.icon) {
          refMeta = await this.metadata.resolveIcon(refInput) || refMeta;
        }
      } catch (err: any) {
        this.output?.appendLine(`[PVF] failed to resolve preview reference ${code} -> ${key}: ${String(err && err.message || err)}`);
      }
      return {
        code,
        key,
        fsPath,
        name: refMeta?.itemName || path.basename(key),
        metadata: refMeta,
      };
    }
    return { code, unresolved: true };
  }

  private async loadLst(lstDiskPath: string): Promise<LstCacheEntry | undefined> {
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(lstDiskPath);
      if (!stat.isFile()) return undefined;
    } catch {
      return undefined;
    }
    const cached = this.lstCache.get(lstDiskPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    const existing = this.lstPromises.get(lstDiskPath);
    if (existing) return existing;
    const promise = readLstFileToCodeMap(lstDiskPath)
      .then(fileToCode => {
        const codeToFile = new Map<number, string>();
        for (const [file, code] of fileToCode) {
          if (!codeToFile.has(code)) codeToFile.set(code, file);
        }
        const entry = { mtimeMs: stat.mtimeMs, size: stat.size, fileToCode, codeToFile };
        this.lstCache.set(lstDiskPath, entry);
        return entry;
      })
      .catch((err: any) => {
        this.output?.appendLine(`[PVF] failed to read preview lst ${lstDiskPath}: ${String(err && err.message || err)}`);
        this.lstCache.set(lstDiskPath, undefined);
        return undefined;
      })
      .finally(() => this.lstPromises.delete(lstDiskPath));
    this.lstPromises.set(lstDiskPath, promise);
    return promise;
  }
}

async function readUtf8Text(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  let text = Buffer.from(buf).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function safeJoinArchivePath(root: string, key: string): string | undefined {
  const parts = normalizeUnpackKey(key).split('/').filter(Boolean);
  if (parts.length === 0 || parts.some(part => part === '..' || part.includes('\0'))) return undefined;
  const fullPath = path.resolve(root, ...parts);
  const relative = path.relative(path.resolve(root), fullPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? fullPath : undefined;
}

function parseTags(text: string): ParsedTags {
  const values = new Map<string, string[]>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let current = '';
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const tag = trimmed.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (tag) {
      const name = tag[1].trim().toLowerCase();
      const isTopLevel = rawLine.length === rawLine.trimStart().length;
      if (name.startsWith('/')) {
        current = '';
        continue;
      }
      if (current && shouldKeepTagLineInCurrent(current, name, isTopLevel)) {
        values.get(current)!.push(trimmed);
        continue;
      }
      current = name;
      if (!values.has(current)) values.set(current, []);
      if (tag[2]?.trim()) values.get(current)!.push(tag[2].trim());
      continue;
    }
    if (current && trimmed && !trimmed.startsWith('//')) values.get(current)!.push(trimmed);
  }
  return { values };
}

function shouldKeepTagLineInCurrent(current: string, nextName: string, isTopLevel: boolean): boolean {
  if (isTopLevel) return false;
  if (BLOCK_VALUE_TAGS.has(current)) {
    return true;
  }
  return !KNOWN_PREVIEW_TAGS.has(nextName);
}

function hasTag(tags: ParsedTags, name: string): boolean {
  return tags.values.has(name.toLowerCase());
}

function tagLines(tags: ParsedTags, ...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const values = tags.values.get(name.toLowerCase());
    if (values) out.push(...values.map(cleanValue).filter(isString));
  }
  return out;
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function firstValue(tags: ParsedTags, name: string): string | undefined {
  return tagLines(tags, name)[0];
}

function firstNumber(tags: ParsedTags, name: string): number | undefined {
  return numbersFromLines(tagLines(tags, name))[0];
}

function cleanValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let text = value.trim();
  const linkText = text.match(/`([^`]*)`/);
  if (linkText) text = linkText[1];
  text = text.replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '').trim();
  return text || undefined;
}

function labelToken(value: string | undefined): string | undefined {
  const cleaned = cleanValue(value);
  if (!cleaned) return undefined;
  return cleaned.replace(/^\[|\]$/g, '').trim();
}

function labelJob(value: string): string {
  const normalized = labelToken(value)?.toLowerCase() || value.toLowerCase();
  return JOB_LABELS[normalized] || value;
}

function numbersFromLines(lines: string[]): number[] {
  const out: number[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/-?\d+/g)) {
      const n = Number(match[0]);
      if (Number.isSafeInteger(n)) out.push(n);
    }
  }
  return out;
}

function statFields(tags: ParsedTags, labels: Record<string, string>, signed: boolean, titles?: PreviewTagTitles): UnpackPreviewField[] {
  const fields: UnpackPreviewField[] = [];
  for (const [tag, label] of Object.entries(labels)) {
    const value = firstNumber(tags, tag);
    if (typeof value !== 'number') continue;
    fields.push({ ...tagLabel(titles, tag, label), value: signedNumber(value, signed), tone: signed ? 'magic' : 'normal' });
  }
  return fields;
}

function signedNumber(value: number, signed: boolean): string {
  if (!signed) return `+${value}`;
  return value > 0 ? `+${value}` : String(value);
}

function field(label: string, value: string | undefined, tone?: UnpackPreviewField['tone']): UnpackPreviewField | undefined {
  return value ? { label, value, ...(tone ? { tone } : {}) } : undefined;
}

function tagField(titles: PreviewTagTitles | undefined, tag: string, fallbackLabel: string, value: string | undefined, tone?: UnpackPreviewField['tone']): UnpackPreviewField | undefined {
  if (!value) return undefined;
  return { ...tagLabel(titles, tag, fallbackLabel), value, ...(tone ? { tone } : {}) };
}

function tagTitle(titles: PreviewTagTitles | undefined, tag: string, fallbackLabel: string): string {
  return tagLabel(titles, tag, fallbackLabel).label;
}

function tagLabel(titles: PreviewTagTitles | undefined, tag: string, fallbackLabel: string): Pick<UnpackPreviewField, 'label' | 'tagName'> {
  const entry = titles?.get(tag.toLowerCase());
  return {
    label: entry?.title || fallbackLabel,
    tagName: entry?.name || tag,
  };
}

function compactFields(fields: Array<UnpackPreviewField | undefined>): UnpackPreviewField[] {
  return fields.filter((item): item is UnpackPreviewField => !!item);
}

function numText(value: number | undefined): string | undefined {
  return typeof value === 'number' ? String(value) : undefined;
}

function levelText(value: number | undefined): string | undefined {
  return typeof value === 'number' ? `Lv.${value}` : undefined;
}

function weightText(value: number | undefined): string | undefined {
  return typeof value === 'number' ? `${trimNumber(value / 1000)}kg` : undefined;
}

function priceText(value: number | undefined, divisor = 1): string | undefined {
  return typeof value === 'number' ? `${Math.floor(value / divisor)} 金币` : undefined;
}

function timeMsText(value: number | undefined, divisor = 1000): string | undefined {
  return typeof value === 'number' ? `${trimNumber(value / divisor)} 秒` : undefined;
}

function rangeText(values: number[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1) return String(values[0]);
  return `${values[0]} - ${values[values.length - 1]}`;
}

function trimNumber(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function tradeText(value: string | undefined): string | undefined {
  const token = cleanValue(value);
  if (!token) return undefined;
  const normalized = token.startsWith('[') ? token.toLowerCase() : `[${token.toLowerCase()}]`;
  return TRADE_LABELS[normalized] || token;
}

type SkillDataKind = 'level' | 'static';

interface SkillDataScene {
  key: string;
  label: string;
  levelInfo: string[][];
  staticData: string[];
  levelProperty: string[];
}

interface SkillDataLabelRef {
  kind: SkillDataKind;
  index: number;
  label: string;
}

const SKILL_SCENE_LABELS: Record<string, string> = {
  default: '默认/通用',
  dungeon: '地下城',
  pvp: '决斗场',
  'death tower': '死亡之塔',
  warroom: '战争房间',
};

const SKILL_SCENE_TAGS = new Set(Object.keys(SKILL_SCENE_LABELS).filter(key => key !== 'default'));

const SKILL_DAMAGE_SOURCE_LABELS: Record<number, string> = {
  [-1]: '百分比伤害',
  [-2]: '独立攻击力',
  [-3]: '中毒伤害',
  [-4]: '出血伤害',
  [-5]: '灼伤伤害',
  [-6]: '感电伤害',
  [-7]: '石化伤害',
};

function buildSkillDataTables(text: string, parameters?: SkillDataParameterSkill): UnpackPreviewTable[] {
  const scenes = parseSkillDataScenes(text);
  const defaultRefs = parseSkillPropertyRefs(scenes.get('default')?.levelProperty || []);
  const out: UnpackPreviewTable[] = [];

  for (const scene of scenes.values()) {
    const configRefs = refsFromSkillDataParameters(parameters, scene.key);
    const refs = mergeSkillDataLabelRefs(configRefs, mergeSkillDataLabelRefs(defaultRefs, parseSkillPropertyRefs(scene.levelProperty)));
    const levelLabels = labelsFromRefs(refs, 'level');
    const staticLabels = labelsFromRefs(refs, 'static');

    if (scene.levelInfo.length) {
      out.push({
        caption: `${scene.label} - [level info]`,
        tagName: 'level info',
        headers: ['等级', ...scene.levelInfo[0].map((_value, idx) => skillDataLabel(levelLabels, idx, '动态'))],
        rows: scene.levelInfo.map((row, idx) => [`Lv.${idx + 1}`, ...row]),
      });
    }

    if (scene.staticData.length) {
      out.push({
        caption: `${scene.label} - [static data]`,
        tagName: 'static data',
        headers: ['索引', '含义', '值'],
        rows: scene.staticData.map((value, idx) => [String(idx), skillDataLabel(staticLabels, idx, '静态'), value]),
      });
    }
  }

  return out;
}

function parseSkillDataScenes(text: string): Map<string, SkillDataScene> {
  const scenes = new Map<string, SkillDataScene>();
  const getScene = (key: string): SkillDataScene => {
    const normalized = key || 'default';
    let scene = scenes.get(normalized);
    if (!scene) {
      scene = {
        key: normalized,
        label: SKILL_SCENE_LABELS[normalized] || normalized,
        levelInfo: [],
        staticData: [],
        levelProperty: [],
      };
      scenes.set(normalized, scene);
    }
    return scene;
  };

  getScene('default');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sceneStack: string[] = ['default'];
  let currentBlock: 'level info' | 'static data' | 'level property' | '' = '';
  let inBlockComment = false;

  for (const rawLine of lines) {
    let lineText = rawLine;
    if (inBlockComment) {
      const end = lineText.indexOf('*/');
      if (end < 0) continue;
      lineText = lineText.slice(end + 2);
      inBlockComment = false;
    }
    const blockStart = lineText.indexOf('/*');
    if (blockStart >= 0) {
      const blockEnd = lineText.indexOf('*/', blockStart + 2);
      if (blockEnd >= 0) {
        lineText = lineText.slice(0, blockStart) + lineText.slice(blockEnd + 2);
      } else {
        lineText = lineText.slice(0, blockStart);
        inBlockComment = true;
      }
    }
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const tag = trimmed.match(/^\[([^\]]+)\]/);
    if (tag) {
      const name = tag[1].trim().toLowerCase();
      if (name.startsWith('/')) {
        const closeName = name.slice(1).trim();
        if (currentBlock === closeName) currentBlock = '';
        if (SKILL_SCENE_TAGS.has(closeName) && sceneStack.length > 1) sceneStack.pop();
        continue;
      }
      if (SKILL_SCENE_TAGS.has(name)) {
        sceneStack.push(name);
        getScene(name);
        currentBlock = '';
        continue;
      }
      if (name === 'level info' || name === 'static data' || name === 'level property') {
        currentBlock = name;
        getScene(sceneStack[sceneStack.length - 1]);
        const inline = stripLineComment(trimmed.slice(tag[0].length)).trim();
        if (inline) appendSkillDataLine(getScene(sceneStack[sceneStack.length - 1]), currentBlock, inline);
        continue;
      }
      if (currentBlock) {
        appendSkillDataLine(getScene(sceneStack[sceneStack.length - 1]), currentBlock, trimmed);
      }
      continue;
    }
    if (currentBlock) appendSkillDataLine(getScene(sceneStack[sceneStack.length - 1]), currentBlock, trimmed);
  }

  for (const scene of scenes.values()) {
    scene.levelInfo = normalizeLevelInfoRows(scene.levelInfo);
  }

  for (const [key, scene] of Array.from(scenes.entries())) {
    if (!scene.levelInfo.length && !scene.staticData.length) scenes.delete(key);
  }
  return scenes;
}

function appendSkillDataLine(scene: SkillDataScene, block: SkillDataSceneBlock, line: string): void {
  if (block === 'level info') {
    const values = tokenValues(stripLineComment(line));
    if (values.length) scene.levelInfo.push(values);
  } else if (block === 'static data') {
    const values = tokenValues(stripLineComment(line));
    if (values.length) scene.staticData.push(...values);
  } else if (block === 'level property') {
    scene.levelProperty.push(stripLineComment(line).trim());
  }
}

type SkillDataSceneBlock = 'level info' | 'static data' | 'level property';

function normalizeLevelInfoRows(rawRows: string[][]): string[][] {
  if (!rawRows.length) return [];
  const first = rawRows[0];
  const colCount = Number(first[0]);
  if (!Number.isInteger(colCount) || colCount <= 0) return rawRows;
  const packedValues = [...first.slice(1), ...rawRows.slice(1).flat()];
  const rows: string[][] = [];
  for (let i = 0; i < packedValues.length; i += colCount) {
    rows.push(packedValues.slice(i, i + colCount));
  }
  return rows;
}

function parseSkillPropertyRefs(lines: string[]): SkillDataLabelRef[] {
  const refs: SkillDataLabelRef[] = [];
  const fallbackLabels: string[] = [];
  let pendingText = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const text = extractSkillPropertyText(line);
    if (text) {
      pendingText = text;
      fallbackLabels.splice(0, fallbackLabels.length, ...splitSkillPropertyLabels(text));
    }

    const numbers = numericTokens(line);
    if (numbers.length < 3) continue;
    const slot = refsForSkillPropertyLine(numbers, pendingText, fallbackLabels, refs);
    refs.push(...slot);
  }

  return refs;
}

function refsForSkillPropertyLine(
  numbers: number[],
  propertyText: string,
  fallbackLabels: string[],
  existing: SkillDataLabelRef[],
): SkillDataLabelRef[] {
  const out: SkillDataLabelRef[] = [];
  const groups = Math.floor(numbers.length / 3);
  for (let group = 0; group < groups; group++) {
    const source = numbers[group * 3];
    const index = numbers[group * 3 + 1];
    const scale = numbers[group * 3 + 2];
    if (!Number.isInteger(index) || index < 0) continue;
    const labelBase = fallbackLabels[existing.length + out.length] || propertyText || sourceLabel(source) || '';
    const label = formatSkillDataMeaning(labelBase, source, scale);
    if (source < 0) {
      out.push({ kind: 'level', index, label });
    } else {
      const staticIndex = Number.isInteger(source) ? source : index;
      out.push({ kind: 'static', index: staticIndex, label });
      if (index !== staticIndex) out.push({ kind: 'static', index, label });
    }
  }
  return out;
}

function mergeSkillDataLabelRefs(base: SkillDataLabelRef[], override: SkillDataLabelRef[]): SkillDataLabelRef[] {
  const byKey = new Map<string, SkillDataLabelRef>();
  for (const ref of base) byKey.set(`${ref.kind}:${ref.index}:${ref.label}`, ref);
  for (const ref of override) byKey.set(`${ref.kind}:${ref.index}:${ref.label}`, ref);
  return Array.from(byKey.values());
}

function labelsFromRefs(refs: SkillDataLabelRef[], kind: SkillDataKind): Map<number, string[]> {
  const labels = new Map<number, string[]>();
  for (const ref of refs) {
    if (ref.kind !== kind || !ref.label) continue;
    const arr = labels.get(ref.index) || [];
    if (!arr.includes(ref.label)) arr.push(ref.label);
    labels.set(ref.index, arr);
  }
  return labels;
}

function skillDataLabel(labels: Map<number, string[]>, index: number, fallbackPrefix: string): string {
  const known = labels.get(index);
  if (known?.length) return known.join(' / ');
  return `${fallbackPrefix}#${index}`;
}

function normalizeSkillDataParameterFile(data: SkillDataParameterFile): SkillDataParameterConfig {
  const byPath = new Map<string, SkillDataParameterSkill>();
  const byCode = new Map<number, Array<{ key: string; skill: SkillDataParameterSkill }>>();
  for (const [rawKey, rawSkill] of Object.entries(data.skills || {})) {
    if (!rawSkill || typeof rawSkill !== 'object') continue;
    const key = normalizeSkillParameterKey(rawKey);
    if (!key) continue;
    byPath.set(key, rawSkill);
    byPath.set(`skill/${key}`, rawSkill);
    for (const code of rawSkill.codes || []) {
      if (!Number.isSafeInteger(code)) continue;
      const arr = byCode.get(code) || [];
      arr.push({ key, skill: rawSkill });
      byCode.set(code, arr);
    }
  }
  for (const [rawCode, rawKeys] of Object.entries(data.byCode || {})) {
    const code = Number(rawCode);
    if (!Number.isSafeInteger(code)) continue;
    const keys = Array.isArray(rawKeys) ? rawKeys : [rawKeys];
    for (const rawKey of keys) {
      if (typeof rawKey !== 'string') continue;
      const key = normalizeSkillParameterKey(rawKey);
      const skill = byPath.get(key) || byPath.get(`skill/${key}`);
      if (!key || !skill) continue;
      const arr = byCode.get(code) || [];
      if (!arr.some(item => item.key === key)) arr.push({ key, skill });
      byCode.set(code, arr);
    }
  }
  return { byPath, byCode };
}

function normalizeSkillParameterKey(value: string): string {
  const normalized = normalizeUnpackKey(value);
  return normalized.startsWith('skill/') ? normalized.slice('skill/'.length) : normalized;
}

function findSkillDataParameters(
  config: SkillDataParameterConfig,
  input: UnpackPreviewInput,
  metadata: UnpackResolvedMetadata | undefined,
): SkillDataParameterSkill | undefined {
  const normalized = normalizeUnpackKey(input.key);
  const pathCandidates = [
    normalized,
    normalizeSkillParameterKey(normalized),
  ];
  for (const key of pathCandidates) {
    const skill = config.byPath.get(key);
    if (skill) return skill;
  }
  if (typeof metadata?.itemCode !== 'number') return undefined;
  const matches = config.byCode.get(metadata.itemCode) || [];
  if (!matches.length) return undefined;
  const basename = path.posix.basename(normalized, path.posix.extname(normalized));
  return matches.find(match => path.posix.basename(match.key, path.posix.extname(match.key)) === basename)?.skill
    || (matches.length === 1 ? matches[0].skill : undefined);
}

function refsFromSkillDataParameters(parameters: SkillDataParameterSkill | undefined, sceneKey: string): SkillDataLabelRef[] {
  if (!parameters?.scenes) return [];
  const scene = mergeSkillDataParameterScenes(parameters.scenes.default, parameters.scenes[sceneKey]);
  if (!scene) return [];
  return [
    ...refsFromSkillDataParameterMap(scene.levelInfo, 'level'),
    ...refsFromSkillDataParameterMap(scene.staticData, 'static'),
  ];
}

function mergeSkillDataParameterScenes(
  base: SkillDataParameterScene | undefined,
  override: SkillDataParameterScene | undefined,
): SkillDataParameterScene | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    levelInfo: { ...(base.levelInfo || {}), ...(override.levelInfo || {}) },
    staticData: { ...(base.staticData || {}), ...(override.staticData || {}) },
  };
}

function refsFromSkillDataParameterMap(
  labels: Record<string, string | string[] | undefined> | undefined,
  kind: SkillDataKind,
): SkillDataLabelRef[] {
  const refs: SkillDataLabelRef[] = [];
  for (const [rawIndex, rawLabels] of Object.entries(labels || {})) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) continue;
    const values = Array.isArray(rawLabels) ? rawLabels : [rawLabels];
    for (const rawLabel of values) {
      if (typeof rawLabel !== 'string') continue;
      const label = rawLabel.trim();
      if (label) refs.push({ kind, index, label });
    }
  }
  return refs;
}

function extractSkillPropertyText(line: string): string | undefined {
  const backtick = line.match(/`([^`]*)`/);
  if (backtick?.[1]) return backtick[1].trim();
  const linked = line.match(/<\d+::([^>`]+)(?:`[^`]*)?>/);
  if (linked?.[1]) return linked[1].trim();
  return undefined;
}

function splitSkillPropertyLabels(text: string): string[] {
  const normalized = text
    .replace(/<[^>]+>/g, '\u0000')
    .replace(/%%/g, '%')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized.includes('\u0000')) return [cleanSkillPropertyLabel(normalized)].filter(isString);
  return normalized
    .split('\u0000')
    .map(cleanSkillPropertyLabel)
    .filter(isString);
}

function cleanSkillPropertyLabel(value: string): string {
  return value
    .replace(/[：:，,、/+\-~()（）\[\]【】<>]+/g, ' ')
    .replace(/\b(int|float1|float2)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSkillDataMeaning(labelBase: string, source: number, scale: number): string {
  const parts = [labelBase || sourceLabel(source) || ''];
  const scaleText = scaleMeaning(scale);
  if (scaleText) parts.push(scaleText);
  return parts.filter(Boolean).join(' ');
}

function sourceLabel(source: number): string | undefined {
  return SKILL_DAMAGE_SOURCE_LABELS[source];
}

function scaleMeaning(scale: number): string | undefined {
  if (!Number.isFinite(scale)) return undefined;
  if (Math.abs(scale - 1) < 0.000001) return undefined;
  if (Math.abs(scale - 0.1) < 0.000001) return 'x0.1';
  if (Math.abs(scale - 0.01) < 0.000001) return 'x0.01';
  if (Math.abs(scale - 0.001) < 0.000001) return 'x0.001';
  return `x${trimNumber(scale)}`;
}

function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

function tokenValues(line: string): string[] {
  return line
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(part));
}

function numericTokens(line: string): number[] {
  return tokenValues(line).map(Number).filter(Number.isFinite);
}

function addTextSection(sections: UnpackPreviewSection[], title: string, lines: string[], tone?: UnpackPreviewSection['tone']): void {
  const cleaned = lines.map(line => line.replace(/\\n/g, '\n').trim()).filter(Boolean);
  if (cleaned.length) sections.push({ title, lines: cleaned.slice(0, 80), ...(tone ? { tone } : {}) });
}

function explainLines(tags: ParsedTags, ...names: string[]): string[] {
  return tagLines(tags, ...names).flatMap(line => line.split(/\n/)).map(line => line.trim()).filter(Boolean);
}

function displayTitle(input: UnpackPreviewInput, tags: ParsedTags, metadata: UnpackResolvedMetadata | undefined): string {
  return metadata?.itemName
    || cleanValue(firstValue(tags, 'name'))
    || cleanValue(firstValue(tags, 'name2'))
    || cleanValue(firstValue(tags, 'set name'))
    || path.basename(input.name, path.extname(input.name));
}

function iconFromMetadata(metadata: UnpackResolvedMetadata | undefined): UnpackPreviewIcon | undefined {
  if (!metadata?.iconDataUri) return undefined;
  return {
    src: metadata.iconDataUri,
    ...(metadata.iconWidth ? { width: metadata.iconWidth } : {}),
    ...(metadata.iconHeight ? { height: metadata.iconHeight } : {}),
    ...(metadata.icon?.imagePath.endsWith('interface/quest/quest_tag.img') ? { isQuestTag: true } : {}),
  };
}

function previewIconSettled(metadata: UnpackResolvedMetadata | undefined, requested: boolean): boolean {
  if (!requested) return false;
  if (!metadata?.icon) return true;
  return !!metadata.iconDataUri || metadata.iconState === 'missing' || metadata.iconState === 'error' || metadata.iconState === 'ready';
}

function hasSetTags(text: string): boolean {
  return /\[(set name|set item|set ability|piece set ability|fullset basic explain|fullset detail explain|part set index)\]/i.test(text);
}

function isSkillTreeKey(key: string): boolean {
  return /^clientonly\/skilltree\/.+_(sp|tp)\.co$/i.test(key)
    || /^clientonly\/skillshoptree(sp|tp)index\.co$/i.test(key)
    || /^etc\/pvpskilltree\/.+\.etc$/i.test(key);
}

function shouldProbePreviewText(key: string): boolean {
  return /\.(co|etc)$/i.test(normalizeUnpackKey(key));
}

function isSkillTreeText(text: string): boolean {
  return /\[character job\]/i.test(text) && /\[skill info\]/i.test(text) && /\[icon pos\]/i.test(text);
}

function skillTreeTagShort(key: string): string {
  return normalizeUnpackKey(key).endsWith('.etc') ? 'etc' : 'co';
}

function parsePairedItemCodes(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const out: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]);
    for (let i = 0; i < nums.length; i += 2) {
      const code = nums[i];
      if (!Number.isSafeInteger(code) || code < 0) continue;
      out.push({ code, quantity: Number.isSafeInteger(nums[i + 1]) ? nums[i + 1] : undefined });
    }
  }
  return out;
}

function parseLooseItemEntries(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const out: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]);
    if (!nums.length) continue;
    const code = nums.find(n => n >= 0);
    if (typeof code !== 'number') continue;
    const quantity = nums.length > 1 ? nums[1] : undefined;
    out.push({ code, quantity, detail: cleanValue(line) });
  }
  return dedupeEntries(out);
}

function parseShopEntries(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const entries: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]).filter(n => n !== -1 && n !== -2);
    if (!nums.length) continue;
    const code = nums[0];
    if (code >= 0) entries.push({ code, quantity: nums[1], detail: cleanValue(line) });
  }
  return dedupeEntries(entries);
}

function parseQuestSelectionRewards(lines: string[]): Array<{ code: number; quantity?: number; detail?: string }> {
  const entries: Array<{ code: number; quantity?: number; detail?: string }> = [];
  for (const line of lines) {
    const nums = numbersFromLines([line]);
    if (nums.length >= 5 && /\[job\]/i.test(line)) {
      entries.push({ code: nums[0], quantity: nums[4], detail: cleanValue(line) });
      continue;
    }
    for (let i = 0; i < nums.length; i += 2) {
      if (nums[i] >= 0) entries.push({ code: nums[i], quantity: nums[i + 1], detail: cleanValue(line) });
    }
  }
  return dedupeEntries(entries);
}

function dedupeEntries<T extends { code: number; quantity?: number; detail?: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    const key = `${entry.code}\0${entry.quantity ?? ''}\0${entry.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function parseSkillTreeGroups(text: string): ParsedSkillTreeGroup[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const groups: ParsedSkillTreeGroup[] = [];
  let group: ParsedSkillTreeGroup | undefined;
  let inCharacterJob = false;
  let inSkillInfo = false;
  let currentTag = '';
  let node: SkillTreeNode | undefined;

  const flushNode = () => {
    if (group && node && Number.isSafeInteger(node.code) && node.code >= 0) group.nodes.push(node);
    node = undefined;
  };
  const flushGroup = () => {
    flushNode();
    if (group && group.nodes.length) groups.push(group);
    group = undefined;
  };
  const consumeValue = (value: string) => {
    if (!group) return;
    const stripped = stripLineComment(value).trim();
    if (!stripped) return;
    const cleaned = labelToken(stripped) || cleanValue(stripped) || stripped;
    if (!inSkillInfo) {
      if (!group.job && looksLikeSkillTreeToken(cleaned)) {
        group.job = cleaned;
        return;
      }
      if (!group.branch && group.job && looksLikeSkillTreeToken(cleaned)) {
        group.branch = cleaned;
      }
      return;
    }
    if (!node) return;
    const nums = numbersFromLines([stripped]);
    if (currentTag === 'index' && nums.length) node.code = nums[0];
    else if (currentTag === 'icon pos' && nums.length >= 2) {
      node.x = nums[0];
      node.y = nums[1];
    } else if (currentTag === 'next skill' && nums.length) {
      node.nextSkills.push(...nums.filter(n => n >= 0));
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    const tag = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (tag) {
      const name = tag[1].trim().toLowerCase();
      const inline = tag[2]?.trim() || '';
      if (name === 'character job') {
        flushGroup();
        inCharacterJob = true;
        group = { nodes: [] };
        inSkillInfo = false;
        currentTag = '';
        if (inline) consumeValue(inline);
        continue;
      }
      if (name === '/character job') {
        flushGroup();
        inCharacterJob = false;
        inSkillInfo = false;
        currentTag = '';
        continue;
      }
      if (!inCharacterJob) continue;
      if (name === 'skill info' || name === 'common skill') {
        flushNode();
        inSkillInfo = true;
        node = { code: -1, common: name === 'common skill', nextSkills: [] };
        currentTag = '';
        if (inline) consumeValue(inline);
        continue;
      }
      if (name === '/skill info' || name === '/common skill') {
        flushNode();
        inSkillInfo = false;
        currentTag = '';
        continue;
      }
      currentTag = name;
      if (inline) consumeValue(inline);
      continue;
    }
    if (!inCharacterJob) continue;
    consumeValue(line);
  }
  flushGroup();
  return groups;
}

function looksLikeSkillTreeToken(value: string): boolean {
  return /^[a-z][a-z0-9 _-]*$/i.test(value.trim());
}

function firstSkillTreeJob(text: string): string | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let inCharacterJob = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[character job\]$/i.test(line)) {
      inCharacterJob = true;
      continue;
    }
    if (inCharacterJob && line && !line.startsWith('[')) return labelToken(line) || cleanValue(line);
  }
  return undefined;
}

function skillLstsForJob(job: string | undefined): string[] {
  const normalized = (labelToken(job) || job || '').toLowerCase();
  return [...(SKILL_LISTS_BY_JOB[normalized] || []), ...COMMON_SKILL_LSTS];
}

function skillTreeType(key: string): string {
  const normalized = normalizeUnpackKey(key);
  if (normalized.includes('/pvpskilltree/')) return 'PVP';
  if (normalized.endsWith('_tp.co') || normalized.includes('treetp')) return 'TP';
  if (normalized.endsWith('_sp.co') || normalized.includes('treesp')) return 'SP';
  return '未知';
}

function skillTreeTitle(input: UnpackPreviewInput, job: string | undefined): string {
  const type = skillTreeType(input.key);
  const jobText = job ? labelJob(job) : path.basename(input.name, path.extname(input.name));
  return `${jobText} ${type} 技能树`;
}
