import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildCompositeTimeline, buildTimelineFromFrames, expandAlsLayers } from '../commander/previewAni/buildTimeline';
import { loadAlbumForImage } from '../commander/previewAni/npkResolver';
import { parseAniText } from '../commander/previewAni/parseAni';
import { parseAlsText } from '../commander/previewAni/parseAls';
import type { FrameSeqEntry, TimelineFrame } from '../commander/previewAni/types';
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
  | 'ani'
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
  fsPath?: string;
  resourceKind?: 'nut' | 'act' | 'ani' | 'als' | 'atk' | 'obj' | 'img' | 'other';
  resourceRole?: 'script' | 'action' | 'avatar' | 'skillEffect' | 'attack' | 'object' | 'other';
  resourceOrder?: number;
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
  rowTargets?: Array<{ line: number; character?: number } | undefined>;
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

export interface UnpackPreviewAniData {
  timeline: TimelineFrame[];
  layers: Array<{ id: string; relLayer: number; order: number; kind?: string; seq?: number }>;
  uses: Array<{ id: string; path: string }>;
  state: { axes: boolean; atk: boolean; dmg: boolean; als: boolean; sync: boolean; bg: string; speed: number; zoom: number };
  frameCount: number;
  imageCount: number;
  missingImageCount: number;
}

export interface UnpackPreviewSkillAnimation {
  timeline: TimelineFrame[];
  source?: UnpackPreviewEntry;
  candidates: UnpackPreviewEntry[];
  layers?: Array<{ id: string; relLayer: number; order: number; kind?: string; seq?: number }>;
  uses?: Array<{ id: string; path: string }>;
  missingImageCount?: number;
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
  ani?: UnpackPreviewAniData;
  skillAnimation?: UnpackPreviewSkillAnimation;
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
  renderRich?: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  iconSettled: boolean;
  renderSettled: boolean;
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
    img?: string[];
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
const PASSIVEOBJECT_LST = 'passiveobject/passiveobject.lst';
const TRANSPARENT_1X1 = 'AAAAAA==';
const LINKED_RESOURCE_TRACE_MAX_DEPTH = 2;
const LINKED_RESOURCE_TRACE_MAX_ENTRIES = 48;

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
    const shouldResolveRichRender = options.renderRich === true;
    const kind = this.previewKind(input.key, '');
    if (!kind && !shouldProbePreviewText(input.key)) return undefined;
    try {
      const stat = await fs.stat(input.fsPath);
      if (!stat.isFile()) return undefined;
      const cacheKey = `${path.resolve(input.root)}\0${normalizeUnpackKey(input.key)}\0${input.version}`;
      const cached = this.cache.get(cacheKey);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && (!shouldResolveIcon || cached.iconSettled) && (!shouldResolveRichRender || cached.renderSettled)) {
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
      this.cache.set(cacheKey, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        iconSettled: previewIconSettled(latestMetadata, shouldResolveIcon),
        renderSettled: previewRenderSettled(preview, shouldResolveRichRender),
        preview,
      });
      return preview;
    } catch (err: any) {
      return this.errorPreview(input, String(err && err.message || err));
    }
  }

  private previewKind(key: string, text: string): UnpackPreviewKind | undefined {
    const normalized = normalizeUnpackKey(key);
    if (normalized.endsWith('.ani')) return 'ani';
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
      case 'skill': return this.buildSkillPreview(input, text, tags, metadata, options);
      case 'skillTree': return this.buildSkillTreePreview(input, text, tags, metadata, options);
      case 'ani': return this.buildAniPreview(input, text, options);
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
    options: UnpackPreviewOptions = {},
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
    const preview = this.basePreview(input, metadata, 'skill', displayTitle(input, tags, metadata), '技能', sections);
    const related = await this.resolveSkillRelatedResources(input, options, {
      includeAnimation: isActiveSkill(tags),
      parameters: dataParameters,
      tags,
    });
    for (const section of skillResourceSections(related.entries)) sections.push(section);
    if (related.animation) preview.skillAnimation = related.animation;
    return preview;
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

  private async buildAniPreview(input: UnpackPreviewInput, text: string, options: UnpackPreviewOptions = {}): Promise<UnpackHoverPreview> {
    const parsed = parseAniText(text, { silent: true });
    const framesSeq = parsed.framesSeq;
    const uniqueImages = Array.from(new Set(framesSeq.map(frame => (frame.img || '').trim()).filter(Boolean)));
    const root = await this.resolveNpkRoot();
    let timeline: TimelineFrame[] = [];
    let loadedImageCount = 0;
    if (framesSeq.length && root && options.renderRich === true) {
      try {
        const emptyImageResolver = await this.emptyAniImageResolver(root, input.key, framesSeq);
        const built = await buildTimelineFromFrames(this.context, root, framesSeq, this.output as vscode.OutputChannel | undefined, { resolveEmptyImage: emptyImageResolver });
        timeline = built.timeline;
        loadedImageCount = built.albumMap.size;
      } catch (err: any) {
        this.output?.appendLine(`[PVF] failed to build ANI timeline ${input.key}: ${String(err && err.message || err)}`);
        timeline = fallbackTimeline(framesSeq);
      }
    }
    if (!timeline.length && framesSeq.length) timeline = fallbackTimeline(framesSeq);
    const missingImageCount = Math.max(0, uniqueImages.length - loadedImageCount);
    const sections: UnpackPreviewSection[] = [{
      title: '动画信息',
      fields: compactFields([
        field('帧数', numText(framesSeq.length)),
        field('图片引用', numText(uniqueImages.length)),
        field('已加载图片', numText(loadedImageCount)),
        missingImageCount ? field('未解析图片', numText(missingImageCount), 'warning') : undefined,
        root ? field('NPK 根目录', root) : field('NPK 根目录', '未配置，当前仅显示透明帧/坐标盒', 'warning'),
      ]),
      ...(uniqueImages.length ? { lines: uniqueImages.slice(0, 10) } : {}),
    }];
    return {
      kind: 'ani',
      title: input.name || path.basename(input.fsPath),
      subtitle: 'ANI 动画',
      key: input.key,
      fsPath: input.fsPath,
      sections,
      badges: ['Canvas 预览'],
      ani: {
        timeline,
        layers: [],
        uses: [],
        state: { axes: true, atk: true, dmg: true, als: true, sync: false, bg: 'dark', speed: 1, zoom: 1 },
        frameCount: framesSeq.length,
        imageCount: uniqueImages.length,
        missingImageCount,
      },
      ...(!framesSeq.length ? { message: '未解析到任何 [FRAME###] 帧。' } : {}),
    };
  }

  private async resolveNpkRoot(): Promise<string> {
    const configured = (vscode.workspace.getConfiguration().get<string>('pvf.npkRoot') || '').trim();
    if (configured) return configured;
    try {
      const { readConfiguredNpkRoots } = await import('./unpackEnv.js');
      const roots = await readConfiguredNpkRoots(this.context);
      return roots[0] || '';
    } catch {
      return '';
    }
  }

  private async emptyAniImageResolver(root: string, aniKey: string, framesSeq: FrameSeqEntry[], options: { skipImageScan?: boolean } = {}): Promise<((frame: FrameSeqEntry) => string | undefined) | undefined> {
    if (!root || !framesSeq.some(frame => !(frame.img || '').trim())) return undefined;
    const candidates = emptyImageCandidatesForAni(aniKey);
    if (!candidates.length) return undefined;
    for (const candidate of candidates) {
      try {
        const album = await loadAlbumForImage(this.context, root, candidate, this.output as vscode.OutputChannel | undefined, { skipScan: options.skipImageScan });
        if (album?.sprites?.length) {
          return () => candidate;
        }
      } catch {
      }
    }
    return undefined;
  }

  private async resolveSkillRelatedResources(
    input: UnpackPreviewInput,
    options: UnpackPreviewOptions = {},
    resourceOptions: { includeAnimation?: boolean; parameters?: SkillDataParameterSkill; tags?: ParsedTags } = {},
  ): Promise<{ entries: UnpackPreviewEntry[]; animation?: UnpackPreviewSkillAnimation }> {
    const skill = skillPathInfo(input.key);
    if (!skill) return { entries: [] };
    const entries: UnpackPreviewEntry[] = [];
    const seen = new Set<string>();
    const push = (entry: UnpackPreviewEntry | undefined) => {
      if (!entry) return;
      const key = previewEntryIdentity(entry);
      if (seen.has(key)) return;
      seen.add(key);
      entries.push(entry);
    };
    for (const file of await this.findSkillParameterReferenceFiles(input, resourceOptions.parameters, 'nut')) push(file);
    for (const file of await this.findSkillParameterReferenceFiles(input, resourceOptions.parameters, 'ani')) push(file);
    for (const file of await this.findSkillParameterReferenceFiles(input, resourceOptions.parameters, 'img')) push(file);
    for (const file of await this.findSkillNutFiles(input, skill)) push(file);
    for (const file of await this.findSkillActFiles(input, skill)) push(file);
    for (const file of await this.findSkillObjFiles(input, skill)) push(file);
    for (const file of await this.findSkillAtkFiles(input, skill)) push(file);
    for (const file of this.skillPreloadingImageEntries(skill, resourceOptions.tags)) push(file);
    const linkedEntries = await this.resolveLinkedResourceEntries(input, entries, resourceOptions.includeAnimation === true);
    for (const file of linkedEntries) push(file);
    const declaredAniEntries = entries.filter(entry => entry.resourceKind === 'ani' && typeof entry.resourceOrder === 'number');
    const aniEntries = resourceOptions.includeAnimation === true
      ? sortAnimationPreviewEntries(dedupePreviewEntries(declaredAniEntries.length
        ? declaredAniEntries
        : [
          ...entries.filter(entry => entry.resourceKind === 'ani'),
          ...await this.findSkillAniFiles(input, skill),
        ]))
      : [];
    for (const file of aniEntries) push(file);

    const animation = await this.buildSkillAnimationPreview(input, aniEntries, options);
    return { entries, ...(animation ? { animation } : {}) };
  }

  private async resolveLinkedResourceEntries(
    input: UnpackPreviewInput,
    sources: UnpackPreviewEntry[],
    includeAnimation: boolean,
  ): Promise<UnpackPreviewEntry[]> {
    const out: UnpackPreviewEntry[] = [];
    const outSeen = new Set<string>();
    const scanned = new Set<string>();
    const queue: Array<{ entry: UnpackPreviewEntry; depth: number }> = [];
    for (const source of sources) {
      if (source.fsPath) outSeen.add(canonicalFsPathKey(source.fsPath));
      if (canTraceLinkedResources(source)) queue.push({ entry: source, depth: 0 });
    }

    for (let cursor = 0; cursor < queue.length && out.length < LINKED_RESOURCE_TRACE_MAX_ENTRIES; cursor++) {
      const { entry: source, depth } = queue[cursor];
      if (!source.fsPath || !canTraceLinkedResources(source)) continue;
      const sourceKey = canonicalFsPathKey(source.fsPath);
      if (scanned.has(sourceKey)) continue;
      scanned.add(sourceKey);
      let text = '';
      try {
        text = await readUtf8Text(source.fsPath);
      } catch {
        continue;
      }
      const baseDir = path.dirname(source.fsPath);
      let refOrder = 0;
      for (const ref of extractArchiveResourceRefs(text)) {
        const kind = resourceKindFromKey(ref);
        if (!kind || (kind === 'ani' && !includeAnimation)) continue;
        const resolved = await resolveReferencedArchiveFile(input.root, baseDir, ref);
        if (!resolved) continue;
        const resolvedKey = canonicalFsPathKey(resolved);
        const key = normalizeTreeRelative(input.root, resolved);
        const role = resourceRoleFromKey(key, kind);
        const resourceOrder = source.resourceKind === 'obj' && typeof source.resourceOrder === 'number'
          ? (source.resourceOrder || 0) * 100 + refOrder
          : undefined;
        refOrder++;
        const entry: UnpackPreviewEntry = {
          name: path.basename(resolved),
          key,
          fsPath: resolved,
          resourceKind: kind,
          resourceRole: role,
          ...(typeof resourceOrder === 'number' ? { resourceOrder } : {}),
          detail: `${resourceLabel(kind, role)} / ${source.name || path.basename(source.fsPath)}`,
        };
        if (!outSeen.has(resolvedKey)) {
          outSeen.add(resolvedKey);
          out.push(entry);
          if (out.length >= LINKED_RESOURCE_TRACE_MAX_ENTRIES) break;
        }
        if (depth + 1 < LINKED_RESOURCE_TRACE_MAX_DEPTH && canTraceLinkedResources(entry) && !scanned.has(resolvedKey)) {
          queue.push({ entry, depth: depth + 1 });
        }
        if (kind === 'ani' && includeAnimation) {
          const alsEntry = await sidecarAlsEntry(input.root, resolved, entry, typeof resourceOrder === 'number' ? resourceOrder + 0.1 : undefined);
          if (alsEntry?.fsPath) {
            const alsKey = canonicalFsPathKey(alsEntry.fsPath);
            if (!outSeen.has(alsKey)) {
              outSeen.add(alsKey);
              out.push(alsEntry);
              if (depth + 1 < LINKED_RESOURCE_TRACE_MAX_DEPTH && canTraceLinkedResources(alsEntry) && !scanned.has(alsKey)) {
                queue.push({ entry: alsEntry, depth: depth + 1 });
              }
              if (out.length >= LINKED_RESOURCE_TRACE_MAX_ENTRIES) break;
            }
          }
        }
      }
    }
    return out;
  }

  private async buildSkillAnimationPreview(
    input: UnpackPreviewInput,
    aniEntries: UnpackPreviewEntry[],
    options: UnpackPreviewOptions,
  ): Promise<UnpackPreviewSkillAnimation | undefined> {
    if (!aniEntries.length || options.renderRich !== true) return undefined;
    const sortedAniEntries = await this.sortAnimationPreviewEntriesForRender(aniEntries);
    let source: UnpackPreviewEntry | undefined;
    let text = '';
    let parsed: ReturnType<typeof parseAniText> | undefined;
    for (const candidate of sortedAniEntries) {
      if (!candidate.fsPath) continue;
      try {
        text = await readUtf8Text(candidate.fsPath);
      } catch {
        continue;
      }
      const parsedCandidate = parseAniText(text, { silent: true });
      if (!parsedCandidate.framesSeq.length) continue;
      source = candidate;
      parsed = parsedCandidate;
      break;
    }
    if (!source?.fsPath || !parsed) return undefined;
    const root = await this.resolveNpkRoot();
    let timeline: TimelineFrame[] = [];
    let layers: NonNullable<UnpackPreviewSkillAnimation['layers']> = [];
    let uses: NonNullable<UnpackPreviewSkillAnimation['uses']> = [];
    let missingImageCount = 0;
    if (root) {
      try {
        const emptyImageResolver = await this.emptyAniImageResolver(root, source.key || '', parsed.framesSeq, { skipImageScan: true });
        const framesForTimeline = framesWithResolvedEmptyImages(parsed.framesSeq, emptyImageResolver);
        const als = await loadSidecarAls(source.fsPath);
        const parsedAls = als ? parseAlsText(als.text, this.output as vscode.OutputChannel | undefined) : undefined;
        let built: { timeline: TimelineFrame[]; albumMap: Map<string, any> } | undefined;
        if (parsedAls?.adds.length) {
          try {
            const layerMap = await expandAlsLayers(false, this.context, undefined, root, path.dirname(source.fsPath), parsedAls, this.output as vscode.OutputChannel | undefined);
            if (layerMap.size) {
              for (const layer of layerMap.values()) {
                const layerKey = animationSourceKeyForEmptyResolver(input.root, path.dirname(source.fsPath), layer.source);
                const layerResolver = await this.emptyAniImageResolver(root, layerKey, layer.frames, { skipImageScan: true });
                layer.frames = framesWithResolvedEmptyImages(layer.frames, layerResolver);
              }
              built = await buildCompositeTimeline(this.context, root, framesForTimeline, parsedAls, layerMap, this.output as vscode.OutputChannel | undefined, { skipImageScan: true });
              layers = parsedAls.adds.map((add, seq) => ({ id: add.id, relLayer: add.relLayer, order: add.order, ...(add.kind ? { kind: add.kind } : {}), seq }));
              uses = Array.from(parsedAls.uses.values()).map(use => ({ id: use.id, path: use.path }));
            }
          } catch (err: any) {
            this.output?.appendLine(`[PVF] failed to build skill ALS timeline ${input.key} -> ${source.key}: ${String(err && err.message || err)}`);
          }
        }
        if (!built) {
          built = await buildTimelineFromFrames(this.context, root, parsed.framesSeq, this.output as vscode.OutputChannel | undefined, { resolveEmptyImage: emptyImageResolver, skipImageScan: true });
        }
        timeline = built.timeline;
        const uniqueImages = new Set(parsed.framesSeq.map(frame => (frame.img || '').trim()).filter(Boolean));
        missingImageCount = Math.max(0, uniqueImages.size - built.albumMap.size);
      } catch (err: any) {
        this.output?.appendLine(`[PVF] failed to build skill ANI timeline ${input.key} -> ${source.key}: ${String(err && err.message || err)}`);
        timeline = fallbackTimeline(parsed.framesSeq);
      }
    }
    if (!timeline.length) timeline = fallbackTimeline(parsed.framesSeq);
    return {
      timeline,
      source,
      candidates: sortedAniEntries.slice(0, 24),
      layers,
      uses,
      missingImageCount,
    };
  }

  private async sortAnimationPreviewEntriesForRender(entries: UnpackPreviewEntry[]): Promise<UnpackPreviewEntry[]> {
    const scored: Array<{ entry: UnpackPreviewEntry; score: number }> = [];
    for (const entry of sortAnimationPreviewEntries(entries)) {
      let score = animationPreviewEntryScore(entry);
      if (entry.fsPath) {
        try {
          const text = await readUtf8Text(entry.fsPath);
          score -= aniTextImagePathRatio(text) * 30;
        } catch {
        }
      }
      scored.push({ entry, score });
    }
    return scored.sort((a, b) => orderedResourceCompare(a.entry, b.entry)
      || a.score - b.score
      || String(a.entry.key || a.entry.name || '').localeCompare(String(b.entry.key || b.entry.name || ''), 'en', { sensitivity: 'base' }))
      .map(item => item.entry);
  }

  private async findSkillNutFiles(input: UnpackPreviewInput, skill: SkillPathInfo): Promise<UnpackPreviewEntry[]> {
    const dirs = [
      ...skill.jobResource.sqrJobs.map(job => safeJoinArchivePath(input.root, `sqr/character/${job}`)),
      safeJoinArchivePath(input.root, `sqr/skill/${skill.job}`),
    ].filter(isString);
    const suffixes = ['.nut'];
    return this.findRelatedFilesInDirs(input, skill, dirs, suffixes, 'nut', 16);
  }

  private async findSkillParameterReferenceFiles(
    input: UnpackPreviewInput,
    parameters: SkillDataParameterSkill | undefined,
    kind: 'nut' | 'ani' | 'img',
  ): Promise<UnpackPreviewEntry[]> {
    const refs = parameters?.references?.[kind] || [];
    if (!refs.length) return [];
    const out: UnpackPreviewEntry[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const resolved = await resolveWorkspaceOrArchiveReference(input.root, ref);
      if (!resolved) continue;
      const key = canonicalFsPathKey(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      const treeKey = isPathInsideRoot(input.root, resolved) ? normalizeTreeRelative(input.root, resolved) : normalizeUnpackKey(path.relative(process.cwd(), resolved));
      const resourceKind = kind as UnpackPreviewEntry['resourceKind'];
      const role = resourceRoleFromKey(treeKey, resourceKind);
      out.push({
        name: path.basename(resolved),
        key: treeKey,
        fsPath: resolved,
        resourceKind,
        resourceRole: role,
        detail: `${resourceLabel(resourceKind, role)} / 参数注释`,
      });
      if (out.length >= 12) break;
    }
    return out;
  }

  private async findSkillActFiles(input: UnpackPreviewInput, skill: SkillPathInfo): Promise<UnpackPreviewEntry[]> {
    const passiveJobs = skillPassiveObjectJobs(skill);
    const dirs = [
      safeJoinArchivePath(input.root, `character/${skill.jobResource.character}/action`),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/${job}`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/character/${job}`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/actionobject/${job}`)),
    ].filter(isString);
    return this.findRelatedFilesInDirs(input, skill, dirs, ['.act'], 'act', 16);
  }

  private async findSkillObjFiles(input: UnpackPreviewInput, skill: SkillPathInfo): Promise<UnpackPreviewEntry[]> {
    const passiveJobs = skillPassiveObjectJobs(skill);
    const listed = await this.findPassiveObjectListEntries(input, skill);
    if (listed.length) return listed.slice(0, 16);
    const dirs = [
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/${job}`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/character/${job}`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/actionobject/${job}`)),
    ].filter(isString);
    return sortRelatedEntries(dedupePreviewEntries([
      ...await this.findRelatedFilesInDirs(input, skill, dirs, ['.obj'], 'obj', 16),
    ]), skill).slice(0, 16);
  }

  private async findPassiveObjectListEntries(input: UnpackPreviewInput, skill: SkillPathInfo): Promise<UnpackPreviewEntry[]> {
    const lstPath = safeJoinArchivePath(input.root, PASSIVEOBJECT_LST);
    if (!lstPath) return [];
    const lst = await this.loadLst(lstPath);
    if (!lst?.fileToCode.size) return [];
    const passiveJobs = new Set(skillPassiveObjectJobs(skill).map(job => job.toLowerCase()));
    const out: UnpackPreviewEntry[] = [];
    for (const [key, code] of lst.fileToCode) {
      if (!key.endsWith('.obj')) continue;
      const match = /^passiveobject\/(?:character|actionobject)\/([^/]+)\/(.+\.obj)$/i.exec(key)
        || /^passiveobject\/([^/]+)\/(.+\.obj)$/i.exec(key);
      if (!match || !passiveJobs.has(match[1].toLowerCase())) continue;
      const stem = path.basename(match[2], '.obj').toLowerCase().replace(/\.\[pvp\]$/i, '');
      if (!isExactSkillResourceStem(stem, skill.resourceNames)) continue;
      const fsPath = safeJoinArchivePath(input.root, key);
      if (!fsPath) continue;
      const role = resourceRoleFromKey(key, 'obj');
      out.push({
        code,
        name: path.basename(fsPath),
        key,
        fsPath,
        resourceKind: 'obj',
        resourceRole: role,
        resourceOrder: relatedEntryScore({ name: path.basename(fsPath), key, resourceKind: 'obj', resourceRole: role }, skill),
        detail: `${resourceLabel('obj', role)} / ${PASSIVEOBJECT_LST}`,
      });
    }
    return sortRelatedEntries(out, skill).slice(0, 16).map((entry, index) => ({ ...entry, resourceOrder: index }));
  }

  private async findSkillAtkFiles(input: UnpackPreviewInput, skill: SkillPathInfo): Promise<UnpackPreviewEntry[]> {
    const c = skill.jobResource.character;
    const passiveJobs = skillPassiveObjectJobs(skill);
    const dirs = [
      safeJoinArchivePath(input.root, `character/${c}/attackinfo`),
      safeJoinArchivePath(input.root, `character/${c}/dsattackinfo`),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/${job}/attackinfo`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/character/${job}/attackinfo`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/actionobject/${job}/attackinfo`)),
    ].filter(isString);
    return this.findRelatedFilesInDirs(input, skill, dirs, ['.atk'], 'atk', 16);
  }

  private async findSkillAniFiles(input: UnpackPreviewInput, skill: SkillPathInfo): Promise<UnpackPreviewEntry[]> {
    const c = skill.jobResource.character;
    const passiveJobs = skillPassiveObjectJobs(skill);
    const dirs = [
      ...skill.jobResource.animationDirs.map(dir => safeJoinArchivePath(input.root, `character/${c}/${dir}`)),
      safeJoinArchivePath(input.root, `character/${c}/effect/animation`),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/${job}`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/character/${job}`)),
      ...passiveJobs.map(job => safeJoinArchivePath(input.root, `passiveobject/actionobject/${job}`)),
      safeJoinArchivePath(input.root, 'etc/ultimateskillani'),
    ].filter(isString);
    return this.findRelatedFilesInDirs(input, skill, dirs, ['.ani'], 'ani', 24);
  }

  private skillPreloadingImageEntries(skill: SkillPathInfo, tags: ParsedTags | undefined): UnpackPreviewEntry[] {
    if (!tags) return [];
    const refs = tagLines(tags, 'skill preloading image')
      .map(cleanValue)
      .filter(isString)
      .filter(value => /\.img$/i.test(value));
    const out: UnpackPreviewEntry[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = normalizeUnpackKey(ref);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const role = resourceRoleFromKey(key, 'img');
      out.push({
        name: path.basename(key),
        key,
        resourceKind: 'img',
        resourceRole: role,
        detail: `${resourceLabel('img', role)} / 预加载`,
      });
      if (out.length >= 16) break;
    }
    return sortRelatedEntries(out, skill);
  }

  private async findRelatedFilesInDirs(
    input: UnpackPreviewInput,
    skill: SkillPathInfo,
    dirs: string[],
    suffixes: string[],
    resourceKind: UnpackPreviewEntry['resourceKind'],
    limit: number,
  ): Promise<UnpackPreviewEntry[]> {
    const out: UnpackPreviewEntry[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      const files = await findFilesBySkillName(dir, skill.resourceNames, suffixes, Math.max(limit * 2, 24));
      for (const fsPath of files) {
        const resolved = path.resolve(fsPath);
        const seenKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        const key = normalizeTreeRelative(input.root, resolved);
        const role = resourceRoleFromKey(key, resourceKind);
        out.push({
          name: path.basename(resolved),
          key,
          fsPath: resolved,
          resourceKind,
          resourceRole: role,
          detail: resourceLabel(resourceKind, role),
        });
        if (out.length >= limit) return sortRelatedEntries(out, skill);
      }
    }
    return sortRelatedEntries(out, skill);
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

async function loadSidecarAls(aniFsPath: string): Promise<{ fsPath: string; text: string } | undefined> {
  const fsPath = `${aniFsPath}.als`;
  try {
    const stat = await fs.stat(fsPath);
    if (!stat.isFile()) return undefined;
    return { fsPath, text: await readUtf8Text(fsPath) };
  } catch {
    return undefined;
  }
}

async function sidecarAlsEntry(root: string, aniFsPath: string, aniEntry: UnpackPreviewEntry, resourceOrder?: number): Promise<UnpackPreviewEntry | undefined> {
  const loaded = await loadSidecarAls(aniFsPath);
  if (!loaded) return undefined;
  const key = normalizeTreeRelative(root, loaded.fsPath);
  const role = resourceRoleFromKey(key, 'als');
  return {
    name: path.basename(loaded.fsPath),
    key,
    fsPath: loaded.fsPath,
    resourceKind: 'als',
    resourceRole: role,
    ...(typeof resourceOrder === 'number' ? { resourceOrder } : {}),
    detail: `${resourceLabel('als', role)} / ${aniEntry.name || path.basename(aniFsPath)}`,
  };
}

function fallbackTimeline(framesSeq: FrameSeqEntry[]): TimelineFrame[] {
  return framesSeq.map(frame => ({
    rgba: TRANSPARENT_1X1,
    w: 1,
    h: 1,
    delay: frame.delay,
    dx: frame.pos?.x || 0,
    dy: frame.pos?.y || 0,
    ox: 0,
    oy: 0,
    fid: frame.idx,
    ...(frame.gfx ? { gfx: frame.gfx } : {}),
    ...(typeof frame.scale?.x === 'number' ? { sx: frame.scale.x } : {}),
    ...(typeof frame.scale?.y === 'number' ? { sy: frame.scale.y } : {}),
    ...(typeof frame.rotate === 'number' ? { rot: frame.rotate } : {}),
    ...(frame.tint ? { tint: frame.tint } : {}),
    atk: frame.atk || [],
    dmg: frame.dmg || [],
  }));
}

function framesWithResolvedEmptyImages(framesSeq: FrameSeqEntry[], resolveEmptyImage: ((frame: FrameSeqEntry) => string | undefined) | undefined): FrameSeqEntry[] {
  if (!resolveEmptyImage || !framesSeq.some(frame => !(frame.img || '').trim())) return framesSeq;
  return framesSeq.map(frame => {
    if ((frame.img || '').trim()) return frame;
    const img = resolveEmptyImage(frame);
    return img ? { ...frame, img } : frame;
  });
}

function animationSourceKeyForEmptyResolver(root: string, baseDir: string, source: string): string {
  const cleaned = cleanValue(source) || source;
  if (!cleaned) return '';
  if (path.isAbsolute(cleaned) && isPathInsideRoot(root, cleaned)) return normalizeTreeRelative(root, cleaned);
  const normalized = normalizeUnpackKey(cleaned);
  if (isArchiveRootReference(normalized)) return normalized;
  const fsPath = path.resolve(baseDir, ...normalized.split('/'));
  return isPathInsideRoot(root, fsPath) ? normalizeTreeRelative(root, fsPath) : normalized;
}

function isArchiveRootReference(key: string): boolean {
  return /^(?:character|passiveobject|sqr|skill|monster|creature|etc|map|ui|item|equipment|stackable)\//i.test(normalizeUnpackKey(key));
}

interface SkillPathInfo {
  job: string;
  baseName: string;
  resourceNames: string[];
  jobResource: SkillJobResource;
}

interface SkillJobResource {
  character: string;
  animationDirs: string[];
  sqrJobs: string[];
}

const SKILL_JOB_RESOURCES: Record<string, SkillJobResource> = {
  swordman: { character: 'swordman', animationDirs: ['animation', 'dsanimation'], sqrJobs: ['swordman'] },
  demonicswordman: { character: 'swordman', animationDirs: ['dsanimation', 'animation'], sqrJobs: ['demonicswordman', 'swordman'] },
  fighter: { character: 'fighter', animationDirs: ['animation'], sqrJobs: ['fighter'] },
  atfighter: { character: 'fighter', animationDirs: ['atanimation', 'animation'], sqrJobs: ['atfighter', 'fighter'] },
  gunner: { character: 'gunner', animationDirs: ['animation'], sqrJobs: ['gunner'] },
  atgunner: { character: 'gunner', animationDirs: ['atanimation', 'animation'], sqrJobs: ['atgunner', 'gunner'] },
  mage: { character: 'mage', animationDirs: ['animation'], sqrJobs: ['mage'] },
  atmage: { character: 'mage', animationDirs: ['atanimation', 'animation'], sqrJobs: ['atmage', 'mage'] },
  creatormage: { character: 'mage', animationDirs: ['creatoranimation', 'animation'], sqrJobs: ['creatormage', 'mage'] },
  priest: { character: 'priest', animationDirs: ['animation'], sqrJobs: ['priest', 'new_priest'] },
  thief: { character: 'thief', animationDirs: ['animation'], sqrJobs: ['thief'] },
};

function skillPathInfo(key: string): SkillPathInfo | undefined {
  const normalized = normalizeUnpackKey(key);
  const match = /^skill\/([^/]+)\/(.+)\.skl$/i.exec(normalized);
  if (!match) return undefined;
  const job = match[1].toLowerCase();
  const baseName = path.basename(match[2]).toLowerCase();
  const fallback: SkillJobResource = { character: job, animationDirs: ['animation'], sqrJobs: [job] };
  return { job, baseName, resourceNames: skillResourceNames(job, baseName), jobResource: SKILL_JOB_RESOURCES[job] || fallback };
}

function skillResourceNames(job: string, baseName: string): string[] {
  const names: string[] = [];
  const add = (value: string | undefined) => {
    const normalized = (value || '').toLowerCase().trim();
    if (normalized && !names.includes(normalized)) names.push(normalized);
  };
  add(baseName);
  const bloodBlast = /^bloodblast(.*)$/i.exec(baseName);
  if ((job === 'swordman' || job === 'demonicswordman') && bloodBlast) {
    add(`blastblood${bloodBlast[1] || ''}`);
  }
  return names;
}

function isExactSkillResourceStem(stem: string, baseNames: string[]): boolean {
  const normalizedStem = stem.replace(/\.\[pvp\]$/i, '');
  return baseNames.some(baseName => normalizedStem === baseName);
}

function skillPassiveObjectJobs(skill: SkillPathInfo): string[] {
  const jobs = [skill.job, skill.jobResource.character];
  return jobs.filter((job, idx) => !!job && jobs.indexOf(job) === idx);
}

async function findFilesBySkillName(dir: string, baseNames: string[], suffixes: string[], limit: number): Promise<string[]> {
  const out: string[] = [];
  const relatedNames = baseNames.map(name => name.toLowerCase()).filter(isString);
  const suffixSet = new Set(suffixes.map(item => item.toLowerCase()));
  const queue: string[] = [dir];
  const seenDirs = new Set<string>();
  while (queue.length && out.length < limit) {
    const current = queue.shift()!;
    const resolvedDir = path.resolve(current);
    const dirKey = process.platform === 'win32' ? resolvedDir.toLowerCase() : resolvedDir;
    if (seenDirs.has(dirKey)) continue;
    seenDirs.add(dirKey);
    let dirents: import('fs').Dirent[];
    try {
      dirents = await fs.readdir(resolvedDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        queue.push(path.join(resolvedDir, dirent.name));
        continue;
      }
      if (!dirent.isFile()) continue;
      const lower = dirent.name.toLowerCase();
      if (lower.endsWith('.ani.als')) continue;
      if (!suffixSet.has(path.extname(lower))) continue;
      const stem = lower.slice(0, lower.length - path.extname(lower).length);
      if (!isSkillRelatedStem(stem, relatedNames)) continue;
      out.push(path.join(resolvedDir, dirent.name));
      if (out.length >= limit) break;
    }
  }
  return out;
}

function isSkillRelatedStem(stem: string, baseNames: string[]): boolean {
  const normalizedStem = stem.replace(/\.\[pvp\]$/i, '');
  for (const baseName of baseNames) {
    if (normalizedStem === baseName) return true;
    if (normalizedStem.startsWith(baseName)) return true;
    if (isPrefixedSkillStem(normalizedStem, baseName)) return true;
    if (baseName.startsWith(normalizedStem) && normalizedStem.length >= Math.max(5, Math.floor(baseName.length * 0.65))) return true;
  }
  return false;
}

function isPrefixedSkillStem(stem: string, baseName: string): boolean {
  const suffix = stem.slice(stem.indexOf('_') + 1);
  if (!stem.includes('_') || !suffix) return false;
  return suffix === baseName || suffix.startsWith(baseName);
}

function sortRelatedEntries(entries: UnpackPreviewEntry[], skill: SkillPathInfo): UnpackPreviewEntry[] {
  return entries.slice().sort((a, b) => relatedEntryScore(a, skill) - relatedEntryScore(b, skill)
    || String(a.key || a.name || '').localeCompare(String(b.key || b.name || ''), 'en', { sensitivity: 'base' }));
}

function previewEntryIdentity(entry: UnpackPreviewEntry): string {
  if (entry.fsPath) return canonicalFsPathKey(entry.fsPath);
  const key = normalizeUnpackKey(entry.key || entry.name || '');
  return `${entry.resourceKind || ''}:${key}`;
}

function canonicalFsPathKey(fsPath: string): string {
  const resolved = path.resolve(fsPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canTraceLinkedResources(entry: UnpackPreviewEntry): boolean {
  return !!entry.fsPath && (entry.resourceKind === 'nut' || entry.resourceKind === 'obj' || entry.resourceKind === 'act');
}

function dedupePreviewEntries(entries: UnpackPreviewEntry[]): UnpackPreviewEntry[] {
  const out: UnpackPreviewEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.fsPath
      ? canonicalFsPathKey(entry.fsPath)
      : normalizeUnpackKey(entry.key || entry.name || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function relatedEntryScore(entry: UnpackPreviewEntry, skill: SkillPathInfo): number {
  if (typeof entry.resourceOrder === 'number') return entry.resourceOrder;
  const name = (entry.name || path.basename(entry.fsPath || '')).toLowerCase();
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length).replace(/\.\[pvp\]$/i, '');
  const scores = skill.resourceNames.map((baseName, idx) => {
    const aliasPenalty = idx * 2;
    if (stem === baseName) return aliasPenalty;
    if (stem.startsWith(baseName)) return 10 + aliasPenalty;
    if (isPrefixedSkillStem(stem, baseName)) return 12 + aliasPenalty;
    return 20 + aliasPenalty;
  });
  let score = Math.min(...scores);
  const key = normalizeUnpackKey(entry.key || '');
  if (entry.resourceKind === 'nut') score -= 4;
  if (entry.resourceKind === 'obj') score -= 2;
  if (entry.resourceKind === 'atk') score -= 1;
  if (entry.resourceRole === 'skillEffect') score += 1;
  if (entry.resourceRole === 'avatar') score += 8;
  if (key.includes('/effect/')) score += 3;
  if (key.includes('/passiveobject/')) score += 6;
  if (key.includes('/dsanimation/')) score += 2;
  if (name.includes('[pvp]')) score += 5;
  return score;
}

function sortAnimationPreviewEntries(entries: UnpackPreviewEntry[]): UnpackPreviewEntry[] {
  return entries.slice().sort((a, b) => orderedResourceCompare(a, b) || animationPreviewEntryScore(a) - animationPreviewEntryScore(b)
    || String(a.key || a.name || '').localeCompare(String(b.key || b.name || ''), 'en', { sensitivity: 'base' }));
}

function orderedResourceCompare(a: UnpackPreviewEntry, b: UnpackPreviewEntry): number {
  const ao = typeof a.resourceOrder === 'number' ? a.resourceOrder : undefined;
  const bo = typeof b.resourceOrder === 'number' ? b.resourceOrder : undefined;
  if (typeof ao === 'number' && typeof bo === 'number' && ao !== bo) return ao - bo;
  if (typeof ao === 'number' && typeof bo !== 'number') return -1;
  if (typeof ao !== 'number' && typeof bo === 'number') return 1;
  return 0;
}

function animationPreviewEntryScore(entry: UnpackPreviewEntry): number {
  if (typeof entry.resourceOrder === 'number') return entry.resourceOrder - 1000;
  const name = (entry.name || path.basename(entry.fsPath || '')).toLowerCase();
  const key = normalizeUnpackKey(entry.key || '');
  let score = 0;
  if (entry.resourceRole === 'skillEffect') score -= 18;
  if (entry.resourceRole === 'action') score += 10;
  if (entry.resourceRole === 'avatar') score += 30;
  if (/^[a-z]+1(?:_ds)?(?:\.\[pvp\])?\.ani$/i.test(name)) score -= 20;
  else if (/\d(?:_ds)?(?:\.\[pvp\])?\.ani$/i.test(name)) score -= 10;
  if (key.includes('/effect/')) score -= 8;
  if (key.includes('/particle/')) score += 8;
  if (key.includes('_ds/')) score += 6;
  if (name.includes('effect') || name.includes('particle') || name.includes('floor') || name.includes('light') || name.includes('magic')) score -= 4;
  if (name.includes('[pvp]')) score += 5;
  return score;
}

function aniTextImagePathRatio(text: string): number {
  let frameCount = 0;
  let imagePathCount = 0;
  const blockRegex = /\[FRAME\d{3}\]([\s\S]*?)(?=\n\[FRAME|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(text))) {
    frameCount++;
    const block = match[1] || '';
    const image = /\[IMAGE\]\s*\r?\n\s*([^\r\n]*)/i.exec(block)?.[1] || '';
    const cleaned = cleanValue(image);
    if (cleaned) imagePathCount++;
  }
  return frameCount > 0 ? imagePathCount / frameCount : 0;
}

function emptyImageCandidatesForAni(aniKey: string): string[] {
  const normalized = normalizeUnpackKey(aniKey);
  if (!normalized.endsWith('.ani')) return [];
  const withoutExt = normalized.slice(0, -'.ani'.length);
  const parts = withoutExt.split('/').filter(Boolean);
  const name = parts[parts.length - 1] || '';
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const cleaned = normalizeUnpackKey(value || '');
    if (cleaned && !candidates.includes(cleaned)) candidates.push(cleaned);
  };

  add(`${withoutExt}.img`);

  const passiveMatch = /^passiveobject\/character\/([^/]+)\/animation\/(.+)$/i.exec(withoutExt);
  if (passiveMatch) {
    const job = passiveMatch[1];
    const rel = passiveMatch[2];
    const relParts = rel.split('/').filter(Boolean);
    const folder = relParts.length > 1 ? relParts[0] : name.replace(/(?:_ds)?$/i, '').replace(/\d+$/g, '');
    const baseFolder = folder.replace(/_ds$/i, '');
    const baseName = name.replace(/_ds$/i, '').replace(/\d+$/g, '');
    add(`character/${job}/effect/${rel}.img`);
    add(`character/${job}/effect/${baseFolder}/${name}.img`);
    add(`character/${job}/effect/${baseFolder}/${baseName}.img`);
    if (/blastblood/i.test(baseFolder)) {
      add(`character/${job}/effect/${baseFolder}/bloodred.img`);
      add(`character/${job}/effect/${baseFolder}/blood.img`);
      add(`character/${job}/effect/${baseFolder}/blood_floor.img`);
      add(`character/${job}/effect/${baseFolder}/blastbloodhit.img`);
    }
  }

  const characterAnimationMatch = /^character\/([^/]+)\/(?:[^/]+\/)*animation\/(.+)$/i.exec(withoutExt);
  if (characterAnimationMatch) {
    const job = characterAnimationMatch[1];
    add(`character/${job}/effect/${name}.img`);
  }

  return candidates;
}

function normalizeTreeRelative(root: string, fsPath: string): string {
  return normalizeUnpackKey(path.relative(root, fsPath));
}

function skillResourceSections(entries: UnpackPreviewEntry[]): UnpackPreviewSection[] {
  const groups: Array<{ title: string; role: UnpackPreviewEntry['resourceRole']; limit: number }> = [
    { title: '对应 NUT', role: 'script', limit: 12 },
    { title: '动作', role: 'action', limit: 12 },
    { title: '时装/角色图集', role: 'avatar', limit: 10 },
    { title: '技能特效', role: 'skillEffect', limit: 18 },
    { title: '攻击/对象资源', role: 'attack', limit: 10 },
    { title: '其他资源', role: 'other', limit: 8 },
  ];
  const used = new Set<string>();
  const sections: UnpackPreviewSection[] = [];
  for (const group of groups) {
    const matched = entries
      .filter(entry => {
        const role = entry.resourceRole || resourceRoleFromKey(entry.key || entry.name || '', entry.resourceKind);
        if (group.role === 'attack') return role === 'attack' || role === 'object';
        return role === group.role;
      })
      .filter(entry => {
        const key = previewEntryIdentity(entry);
        if (used.has(key)) return false;
        used.add(key);
        return true;
      })
      .slice(0, group.limit);
    if (matched.length) sections.push({ title: group.title, entries: matched, tone: 'skill' });
  }
  return sections;
}

function resourceLabel(kind: UnpackPreviewEntry['resourceKind'], role?: UnpackPreviewEntry['resourceRole']): string {
  if (role === 'script') return 'NUT脚本';
  if (role === 'action') return '动作';
  if (role === 'avatar') return '时装/角色图集';
  if (role === 'skillEffect') return '技能特效';
  if (role === 'attack') return '攻击信息';
  if (role === 'object') return '对象';
  if (kind === 'nut') return 'NUT脚本';
  if (kind === 'act') return '动作';
  if (kind === 'als') return '动画图层脚本';
  if (kind === 'ani') return '动画';
  if (kind === 'atk') return '攻击信息';
  if (kind === 'obj') return '对象';
  if (kind === 'img') return '图集';
  return '资源';
}

function extractArchiveResourceRefs(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    const cleaned = cleanValue(value);
    if (!cleaned || !/\.(ani\.als|ani|atk|obj|act|img)$/i.test(cleaned)) return;
    const key = normalizeUnpackKey(cleaned);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(cleaned);
  };
  const quoted = /[`'"]([^`'"]+\.(?:ani\.als|ani|atk|obj|act|img))[`'"]/gi;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(text))) add(match[1]);
  const bare = /(^|[\s\t])([A-Za-z0-9_./\\-]+\.(?:ani\.als|ani|atk|obj|act|img))(?=$|[\s\t),;])/gim;
  while ((match = bare.exec(text))) add(match[2]);
  return refs;
}

function resourceKindFromKey(key: string): UnpackPreviewEntry['resourceKind'] | undefined {
  const normalized = normalizeUnpackKey(key);
  if (normalized.endsWith('.ani.als')) return 'als';
  if (normalized.endsWith('.ani')) return 'ani';
  if (normalized.endsWith('.act')) return 'act';
  if (normalized.endsWith('.atk')) return 'atk';
  if (normalized.endsWith('.obj')) return 'obj';
  if (normalized.endsWith('.img')) return 'img';
  return undefined;
}

function resourceRoleFromKey(key: string, kind?: UnpackPreviewEntry['resourceKind']): UnpackPreviewEntry['resourceRole'] {
  const normalized = normalizeUnpackKey(key);
  if (kind === 'nut') return 'script';
  if (kind === 'act') return 'action';
  if (kind === 'als') return 'skillEffect';
  if (kind === 'atk') return 'attack';
  if (kind === 'obj') return 'object';
  if (normalized.includes('/equipment/avatar/') || normalized.includes('/avatar/')) return 'avatar';
  if (normalized.includes('/effect/') || normalized.includes('/particle/') || normalized.includes('/ultimateskill')) return 'skillEffect';
  if (normalized.includes('/passiveobject/') && normalized.includes('/animation/')) return 'skillEffect';
  if (normalized.includes('/animation/') || /\/(?:animation|atanimation|dsanimation|creatoranimation)\//i.test(normalized)) return 'action';
  if (kind === 'ani') return 'skillEffect';
  if (kind === 'img') return 'other';
  return 'other';
}

async function resolveReferencedArchiveFile(root: string, baseDir: string, ref: string): Promise<string | undefined> {
  const cleaned = cleanValue(ref);
  if (!cleaned) return undefined;
  const normalized = normalizeUnpackKey(cleaned);
  const candidates: string[] = [];
  if (/^([a-z]+\/)/i.test(normalized)) {
    const archivePath = safeJoinArchivePath(root, normalized);
    if (archivePath) candidates.push(archivePath);
  }
  candidates.push(path.resolve(baseDir, ...normalized.split('/')));
  for (const candidate of candidates) {
    if (!isPathInsideRoot(root, candidate)) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
    }
  }
  return undefined;
}

async function resolveWorkspaceOrArchiveReference(root: string, ref: string): Promise<string | undefined> {
  const cleaned = cleanValue(ref);
  if (!cleaned) return undefined;
  const normalized = normalizeUnpackKey(cleaned);
  const candidates: string[] = [];
  if (path.isAbsolute(cleaned)) candidates.push(cleaned);
  const archivePath = safeJoinArchivePath(root, normalized);
  if (archivePath) candidates.push(archivePath);
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(path.resolve(folder.uri.fsPath, ...normalized.split('/')));
  }
  candidates.push(path.resolve(process.cwd(), ...normalized.split('/')));
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
    }
  }
  return undefined;
}

function isPathInsideRoot(root: string, fsPath: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(fsPath));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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

function isActiveSkill(tags: ParsedTags): boolean {
  const skillType = labelToken(firstValue(tags, 'type'))?.toLowerCase();
  return skillType === 'active';
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
  levelInfo: SkillDataValue[][];
  staticData: SkillDataValue[];
  levelProperty: string[];
}

interface SkillDataValue {
  value: string;
  line: number;
  character?: number;
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
        rows: scene.levelInfo.map((row, idx) => [`Lv.${idx + 1}`, ...row.map((cell, cellIdx) => formatLevelInfoCell(cell, scene.levelInfo[idx - 1]?.[cellIdx]))]),
        rowTargets: scene.levelInfo.map(row => skillDataTargetFromValue(row[0])),
      });
    }

    if (scene.staticData.length) {
      out.push({
        caption: `${scene.label} - [static data]`,
        tagName: 'static data',
        headers: ['索引', '含义', '值'],
        rows: scene.staticData.map((value, idx) => [String(idx), skillDataLabel(staticLabels, idx, '静态'), value.value]),
        rowTargets: scene.staticData.map(value => skillDataTargetFromValue(value)),
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

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
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
        if (inline) appendSkillDataLine(getScene(sceneStack[sceneStack.length - 1]), currentBlock, inline, lineNo);
        continue;
      }
      if (currentBlock) {
        appendSkillDataLine(getScene(sceneStack[sceneStack.length - 1]), currentBlock, trimmed, lineNo);
      }
      continue;
    }
    if (currentBlock) appendSkillDataLine(getScene(sceneStack[sceneStack.length - 1]), currentBlock, trimmed, lineNo);
  }

  for (const scene of scenes.values()) {
    scene.levelInfo = normalizeLevelInfoRows(scene.levelInfo);
  }

  for (const [key, scene] of Array.from(scenes.entries())) {
    if (!scene.levelInfo.length && !scene.staticData.length) scenes.delete(key);
  }
  return scenes;
}

function appendSkillDataLine(scene: SkillDataScene, block: SkillDataSceneBlock, line: string, lineNo: number): void {
  if (block === 'level info') {
    const values = tokenValuesWithPositions(stripLineComment(line), lineNo);
    if (values.length) scene.levelInfo.push(values);
  } else if (block === 'static data') {
    const values = tokenValuesWithPositions(stripLineComment(line), lineNo);
    if (values.length) scene.staticData.push(...values);
  } else if (block === 'level property') {
    scene.levelProperty.push(stripLineComment(line).trim());
  }
}

type SkillDataSceneBlock = 'level info' | 'static data' | 'level property';

function normalizeLevelInfoRows(rawRows: SkillDataValue[][]): SkillDataValue[][] {
  if (!rawRows.length) return [];
  const first = rawRows[0];
  const colCount = Number(first[0]?.value);
  if (!Number.isInteger(colCount) || colCount <= 0) return rawRows;
  const packedValues = [...first.slice(1), ...rawRows.slice(1).flat()];
  const rows: SkillDataValue[][] = [];
  for (let i = 0; i < packedValues.length; i += colCount) {
    rows.push(packedValues.slice(i, i + colCount));
  }
  return rows;
}

function skillDataTargetFromValue(value: SkillDataValue | undefined): { line: number; character?: number } | undefined {
  if (!value || !Number.isInteger(value.line) || value.line < 0) return undefined;
  return {
    line: value.line,
    ...(typeof value.character === 'number' && value.character >= 0 ? { character: value.character } : {}),
  };
}

function formatLevelInfoCell(value: SkillDataValue, previous: SkillDataValue | undefined): string {
  if (!previous) return value.value;
  const currentValue = Number(value.value);
  const previousValue = Number(previous.value);
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue)) return value.value;
  const absolute = currentValue - previousValue;
  const absoluteText = signedNumberText(absolute);
  if (previousValue === 0) return `${value.value}（${absoluteText}）`;
  const percent = (absolute / previousValue) * 100;
  if (!Number.isFinite(percent)) return `${value.value}（${absoluteText}）`;
  return `${value.value}（${absoluteText}，${signedNumberText(percent)}%）`;
}

function signedNumberText(value: number): string {
  const text = trimNumber(value);
  return value >= 0 ? `+${text}` : text;
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

function tokenValuesWithPositions(line: string, lineNo: number): SkillDataValue[] {
  const values: SkillDataValue[] = [];
  const regex = /[-+]?(?:\d+(?:\.\d+)?|\.\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line))) {
    values.push({ value: match[0], line: lineNo, character: match.index });
  }
  return values;
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

function previewRenderSettled(preview: UnpackHoverPreview | undefined, requested: boolean): boolean {
  if (!requested) return false;
  if (preview?.kind !== 'ani') return true;
  return !!preview.ani?.timeline?.length || !!preview.message;
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
